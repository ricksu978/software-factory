// Step definitions for features/pbi-423-cancelled-ci-neither-failed-nor-passed.feature.
//
// Every scenario reuses another item's harness, and a commit holding a cancelled run is read through the real GitHub
// repo host, as ci-reading.ts says, so what a cancelled run comes to is always the control plane's own reading:
//
// - The cell API scenarios are PBI 232's: the real cell API on the real GitHub repo host over a stub GitHub. "The cell
//   asks the cell API about CI on that commit" is its `GET /checks`, and "for the checks on that commit by name" is
//   `GET /ci-checks`, which answers `{ checks: [{ name, conclusion, url }] }`. An answer "neither failed nor passed" is
//   one whose status is none of failure, success, pending and none, so it is a verdict of its own that ends the wait;
//   a check "neither failed nor passed" is one whose conclusion is none of failure, success and pending.
// - The cell scenarios run the engine through PBI 18's harness, with PBI 128's fakes, PBI 130's person's thread and
//   PBI 292's CI by commit and by check, with PBI 233's re-runs on top, all put on the run just before it runs. Their
//   `/checks` and `/ci-checks` for a commit holding a cancelled run answer as the real cell API would (ci-reading.ts).
//   The cell API's `release` is recorded as a "/release" call.
//   - "While the factory waits on CI for <a>, a person pushes the commit <b> to the item's branch": on the factory's
//     first read of CI on <a>, a person's commit lands on origin's item branch, and <b> names it.
//   - The item "moves to Queued" when the claim ends on a release or an attempt reported `stopped` after its last
//     transition, as the cell API ends such a claim (PBI 18's steps), and "the item's run resumes from" the stage the
//     claim started at, moved on past each stage it reported passed, as the cell API moves it.
//   - An attempt "counts against the stage's retries" when it ended `failed` or handed the next claim a retry carry.
//   - "The next claim's cell runs from <stage>" only once the first claim sent the item back to Queued with its run
//     resuming from that stage, as PBI 315's next claim does: a fresh clone of the item's branch, the PR, the attempts
//     and the CI failures the first claim reported. The commit the next claim "started on" is the head at its first
//     agent call. PBI 315's Thens read it.
// - The Definition of Done scenarios run the cell's own checkDefinitionOfDone, as PBI 229's do, over the lines the
//   scenario gives, with `/ci-checks` answering PBI 292's checks on the commit. A line no check gives a verdict goes to
//   a judge that passes it, naming no check. A line "is failed (passed) by the check <c> at <url>" when its verdict
//   failed (passed) and its reason names the check as a word and holds the URL.
// - The InReview scenarios are PBI 235's: the real poller and webhook handler on the test database and PBI 12's fake
//   repo host, whose CI is PBI 292's rules. "Webhooks are on" when the real webhook handler and parser load and the factory has its webhook secret.
//   "The factory re-ran no check on <sha>" when the fake repo host recorded no re-run on the commit.
// - The base scenario is PBI 260's poller on its fake repo host, whose `checksOnSha` for a base commit holding a
//   cancelled run is the real reading. "The answer" is the factory's answer to the item's question.
import { Before, BeforeStep, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CiCheck } from "../../src/adapters/types.ts";
import { checkDefinitionOfDone } from "../../src/cell/engine.ts";
import type { CiFailure } from "../../src/cell/ci-failure.ts";
import { parseCriteria, type Policy, type Verdict } from "../../src/policy/policy.ts";
import { hasCancelled, realReading, type Reported } from "./ci-reading.ts";
import { ctx as pollCtx, polled, REPO as POLL_REPO } from "./pbi-12.steps.ts";
import { ctx as pr128 } from "./pbi-128.steps.ts";
import { endState, resumesFrom, runTheCell, type Ctx as CellCtx } from "./pbi-18.steps.ts";
import { checksNow, install as install233 } from "./pbi-233.steps.ts";
import { deliver, webhooksOn } from "./pbi-235.steps.ts";
import { ctx as ctx260 } from "./pbi-260.steps.ts";
import { ctx as ci292, install as install292, keyOf, namesWord, settled, shaOf } from "./pbi-292.steps.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";

const BRANCH = "factory/pbi-482-r1";
const LONG = { timeout: 180_000 };
const SHA232 = "c1a0f00d5eed";

type Claim = { calls: CellCtx["calls"]; error: unknown; startedOn: string | null };
type Mine = {
  /** The person's push while the factory waits on CI: the commit waited on, the push's label, and whether it landed. */
  push: { waitOn: string; label: string; done: boolean } | null;
  installedOn: CellCtx | null;
  /** 1 while the first claim runs, 2 while the next one does. */
  claim: number;
  startedOn: string | null;
  /** Why the next claim didn't run, when it didn't. */
  noNextClaim: string | null;
  /** The Definition of Done's lines, as dod.md holds them. */
  dod: string[];
  dodResult: { verdicts: Verdict[] } | null;
  dodError: unknown;
  /** The cell API's answer to `GET /ci-checks`. */
  byName: { code: number; raw: string; json: { checks?: CiCheck[] | null } | null } | null;
};

function mine(world: object): Mine {
  const w = world as { pbi423?: Mine };
  w.pbi423 ??= { push: null, installedOn: null, claim: 1, startedOn: null, noNextClaim: null, dod: [], dodResult: null, dodError: null, byName: null };
  return w.pbi423;
}

function cell(world: object): CellCtx {
  const w = world as { pbi18?: CellCtx };
  assert.ok(w.pbi18, "no run was set up");
  return w.pbi18;
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const short = (sha: string) => sha.slice(0, 7);

Before({ tags: "@pbi-423 and @db", ...long }, async function () {
  const d = await testDb();
  if (!d) return;
  await d.pool.query('truncate item, event, backlog_source, repo, webhook_delivery, "user", override cascade');
  await d.pool.query("update wip_policy set mode = 'fixed', current_wip = 2, review_capacity = 3, usage_paused_until = null");
});

// ---- the cell's CI, put on the run just before it runs ----

/** The real commit a label names now, or null while CI hasn't been asked about it. */
function shaNow(world: object, label: string): string | null {
  const c = ci292(world);
  const role = c.roles.get(label);
  if (!role) return null;
  return role.kind === "sha" ? role.sha : c.shas.get(keyOf(role)) ?? null;
}

/** On the first read of CI on the commit waited on, a person's commit lands on origin's item branch. */
function personPushes(world: object, sha: string) {
  const m = mine(world);
  if (!m.push || m.push.done || shaNow(world, m.push.waitOn) !== sha) return;
  m.push.done = true;
  const run = cell(world);
  const tmp = mkdtempSync(join(run.root, "person-"));
  git(run.root, "clone", "-q", "-b", BRANCH, run.origin, tmp);
  git(tmp, "config", "user.email", "person@example.com");
  git(tmp, "config", "user.name", "person");
  writeFileSync(join(tmp, "person.txt"), "pushed while CI ran\n");
  git(tmp, "add", "-A");
  git(tmp, "commit", "-q", "-m", "a person's push");
  git(tmp, "push", "-q", "origin", BRANCH);
  const c = ci292(world);
  const role = c.roles.get(m.push.label)!;
  assert.equal(role.kind, "sha");
  const rules = c.rules.get(keyOf(role));
  c.rules.delete(keyOf(role));
  (role as { sha: string }).sha = git(tmp, "rev-parse", "HEAD");
  if (rules) c.rules.set(keyOf(role), rules);
}

/**
 * The checks on `sha` as PBI 233's re-runs leave them, each finished one with when it finished: a check re-run on the
 * commit after the ones that weren't, so a re-run that fails again at the same URL still shows as a new run.
 */
function stamped(world: object, sha: string, list: CiCheck[]): CiCheck[] {
  const rerun = (world as { pbi233?: { rerun: Map<string, Set<string>> } }).pbi233?.rerun.get(sha) ?? new Set<string>();
  return list.map((x) => (x.conclusion === "pending" ? x : { ...x, completedAt: rerun.has(x.name) ? "2026-11-26T10:30:00.000Z" : "2026-11-26T10:00:00.000Z" }));
}

function install(world: object) {
  const m = mine(world);
  const run = cell(world);
  if (m.installedOn === run) return;
  m.installedOn = run;
  const prevChecks = run.checks!;
  const prevCi = run.apiExtra!.ciChecks as (sha: string) => Promise<CiCheck[]>;
  run.checks = (async (sha: string) => {
    const answer = await prevChecks(sha);
    personPushes(world, sha);
    const list = stamped(world, sha, checksNow(world, sha, false)) as Reported[];
    if (!hasCancelled(list)) return answer;
    const read = await realReading(list);
    return { status: read.status, failedChecks: read.failedChecks };
  }) as unknown as CellCtx["checks"];
  run.apiExtra = {
    ...run.apiExtra,
    async ciChecks(sha: string): Promise<CiCheck[]> {
      const got = stamped(world, sha, await prevCi(sha));
      const list = stamped(world, sha, checksNow(world, sha, false)) as Reported[];
      return hasCancelled(list) ? (await realReading(list)).ciChecks : got;
    },
    async release() { run.calls.push({ route: "/release", body: {} }); },
  };
  const prev = run.agent;
  run.agent = async (a, base) => {
    if (m.claim === 2 && m.startedOn === null) m.startedOn = git(a.cwd, "rev-parse", "HEAD");
    return prev ? prev(a, base) : base(a);
  };
}

BeforeStep({ tags: "@pbi-423" }, function ({ pickleStep }) {
  if (pickleStep.text !== "the cell runs") return;
  const w = this as { pbi128Later?: boolean; pbi128?: unknown; pbi18?: unknown };
  if (!w.pbi18) return;
  if (w.pbi128Later && !w.pbi128) pr128(this);
  ci292(this);
  install292(this);
  install233(this);
  install(this);
});

// ---- the cell API ----

type Api232 = { server?: import("node:http").Server; runId?: string; token?: string; checks: { name: string; url: string }[]; code?: number; raw?: string; answer?: { status?: string; failedChecks?: { name: string; url: string }[] } };

function api232(world: object): Api232 {
  const a = (world as { pbi232api?: Api232 }).pbi232api;
  assert.ok(a, "no cell was set up waiting on CI");
  return a;
}

function checksAnswer(world: object) {
  const a = api232(world);
  assert.equal(a.code, 200, `the cell API answered ${a.code}: ${a.raw}`);
  assert.ok(a.answer, `the cell API's answer isn't JSON: ${a.raw}`);
  return a.answer;
}

Then("the cell API doesn't answer that CI failed", function () {
  const a = checksAnswer(this);
  assert.notEqual(a.status, "failure", `the cell API answered that CI failed: ${api232(this).raw}`);
});

Then("the cell API answers that CI neither failed nor passed", function () {
  const a = checksAnswer(this);
  assert.ok(typeof a.status === "string" && !["failure", "success", "pending", "none"].includes(a.status),
    `the cell API answered "${a.status}", not that CI neither failed nor passed: ${api232(this).raw}`);
});

Then("the cell API answers that CI passed", function () {
  assert.equal(checksAnswer(this).status, "success", `the cell API's answer: ${api232(this).raw}`);
});

Then("the answer doesn't name the check {string}", function (name: string) {
  const a = checksAnswer(this);
  const failed = a.failedChecks ?? [];
  assert.ok(!failed.some((x) => x.name === name), `the answer names the check "${name}": ${api232(this).raw}`);
  const url = api232(this).checks.find((x) => x.name === name)?.url;
  if (url) assert.ok(!api232(this).raw!.includes(url), `the answer gives the URL of "${name}": ${api232(this).raw}`);
});

When("the cell asks the cell API for the checks on that commit by name", long, async function () {
  const a = api232(this);
  assert.ok(a.server, "the cell API didn't start");
  const port = (a.server.address() as AddressInfo).port;
  const r = await fetch(`http://127.0.0.1:${port}/internal/cells/${a.runId}/ci-checks?sha=${SHA232}`, { headers: { authorization: `Bearer ${a.token}` } });
  const raw = await r.text();
  let json: { checks?: CiCheck[] | null } | null = null;
  try { json = JSON.parse(raw); } catch { json = null; }
  mine(this).byName = { code: r.status, raw, json };
});

function namedCheck(world: object, name: string): CiCheck {
  const b = mine(world).byName;
  assert.ok(b, "the cell never asked for the checks by name");
  assert.equal(b.code, 200, `the cell API answered ${b.code}: ${b.raw}`);
  const checks = b.json?.checks;
  assert.ok(Array.isArray(checks), `the cell API gave no checks: ${b.raw}`);
  const found = checks.filter((x) => x.name === name);
  assert.equal(found.length, 1, `the checks name "${name}" ${found.length} times: ${b.raw}`);
  return found[0];
}

Then("the checks name {string} as neither failed nor passed", function (name: string) {
  const c = namedCheck(this, name);
  assert.ok(!["failure", "success", "pending"].includes(c.conclusion), `the checks name "${name}" as ${c.conclusion}: ${mine(this).byName!.raw}`);
});

Then("the checks name {string} as passed", function (name: string) {
  const c = namedCheck(this, name);
  assert.equal(c.conclusion, "success", `the checks name "${name}" as ${c.conclusion}`);
});

// ---- the cell's Givens ----

Given("open-pr pushes the PR's first head {string}", function (label: string) {
  ci292(this).roles.set(label, { kind: "head" });
});

Given("while the factory waits on CI for {string}, a person pushes the commit {string} to the item's branch", function (waitOn: string, label: string) {
  const c = ci292(this);
  assert.ok(c.roles.has(waitOn), `no commit is labelled "${waitOn}"`);
  // The commit lands while the cell runs. Until then its role holds a placeholder, which the push replaces.
  c.roles.set(label, { kind: "sha", sha: `pending:${label}` });
  mine(this).push = { waitOn, label, done: false };
});

Given("CI reports the check {string} was cancelled on {string} at {string}", function (check: string, label: string, url: string) {
  const c = ci292(this);
  const role = c.roles.get(label);
  assert.ok(role, `no commit is labelled "${label}"`);
  const list = c.rules.get(keyOf(role)) ?? [];
  list.push({ name: check, conclusion: "cancelled", url, failingTests: [] });
  c.rules.set(keyOf(role), list);
});

Given("the check {string} fails again when it is re-run on {string}", function (check: string, label: string) {
  // A re-run check the scenario says nothing more about fails again just as it did (PBI 233's re-runs).
  const c = ci292(this);
  const role = c.roles.get(label);
  assert.ok(role, `no commit is labelled "${label}"`);
  assert.ok((c.rules.get(keyOf(role)) ?? []).some((x) => x.name === check && x.conclusion === "failure"), `the check "${check}" doesn't fail on "${label}"`);
});

// ---- the next claim ----

async function runNextClaim(world: object, stage: string): Promise<void> {
  const m = mine(world);
  const run = cell(world);
  const first: Claim = { calls: run.calls, error: run.error, startedOn: null };
  // PBI 315's Thens about the next claim read its context.
  (world as { pbi315?: unknown }).pbi315 = {
    noCommit: { first: new Set(), next: new Set() }, nextFixes: 0, claim: 2, first, next: null, startedOn: null,
    answer: null, personPush: null, baseMoves: false,
  };
  let queued: string | null = null;
  try {
    const state = endState(run);
    const at = resumesFrom(world);
    if (state !== "Queued" || at !== stage) queued = `the first claim left the item ${state}, its run resuming from ${at}`;
  } catch (e) {
    queued = `the first claim failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (queued) {
    m.noNextClaim = `no next claim ran from ${stage}: ${queued}`;
    return;
  }
  const attempts: Record<string, number> = {};
  for (const x of first.calls) {
    if (x.route === "/stage" && x.body.status === "started") attempts[x.body.stageId] = Math.max(attempts[x.body.stageId] ?? 0, Number(x.body.attempt ?? 0));
  }
  const failedCiHeads: CiFailure[] = [];
  for (const x of first.calls) {
    const f = x.route === "/stage" ? (x.body.ciFailure as CiFailure | undefined) : undefined;
    if (f && !failedCiHeads.some((g) => g.sha === f.sha)) failedCiHeads.push(f);
  }
  const pr = first.calls.filter((x) => x.route === "/pr").at(-1);
  const dir = join(run.root, "work-next");
  git(run.root, "clone", "-q", "-b", BRANCH, run.origin, dir);
  git(dir, "config", "user.email", "cell@example.com");
  git(dir, "config", "user.name", "cell");
  Object.assign(run, {
    dir, nextStage: stage, decision: null, prNumber: pr ? Number(pr.body.prNumber) : run.prNumber,
    calls: [], agentCalls: [], stage: "", prBodies: [], result: null, error: null, earlierCalls: first.calls,
    startHead: git(dir, "rev-parse", "HEAD"),
  });
  run.context = { ...run.context, stageAttempts: attempts, failedCiHeads };
  m.claim = 2;
  m.startedOn = null;
  await runTheCell(world);
  (world as { pbi315: { next: Claim } }).pbi315.next = { calls: run.calls, error: run.error, startedOn: m.startedOn };
}

When("the next claim's cell runs from open-pr", LONG, async function () {
  await runNextClaim(this, "open-pr");
});

When("the next claim's cell runs from address", LONG, async function () {
  await runNextClaim(this, "address");
});

function nextClaim(world: object): Claim {
  const m = mine(world);
  assert.equal(m.noNextClaim, null, m.noNextClaim ?? "");
  const next = (world as { pbi315?: { next: Claim | null } }).pbi315?.next;
  assert.ok(next, "the next claim's cell never ran");
  settled(cell(world));
  return next;
}

Then("in the next claim the factory read CI on {string}", function (label: string) {
  const calls = nextClaim(this).calls;
  const sha = shaOf(this, label);
  const reads = calls.filter((x) => x.route === "/checks" && x.body.sha === sha).length;
  assert.ok(reads > 0, `in the next claim the factory never read CI on ${short(sha)}: ${calls.filter((x) => x.route === "/checks").map((x) => short(String(x.body.sha))).join(", ")}`);
});

// ---- the cell's Thens ----

function lastEnded(world: object, stage: string): Record<string, any> {
  const run = cell(world);
  settled(run);
  const ended = run.calls.filter((x) => x.route === "/stage" && x.body.stageId === stage && x.body.status !== "started");
  assert.ok(ended.length > 0, `no ${stage} attempt ended`);
  return ended.at(-1)!.body;
}

Then(/^the (open-pr|address) attempt doesn't count against the stage's retries$/, function (stage: string) {
  const b = lastEnded(this, stage);
  assert.notEqual(b.status, "failed", `the ${stage} attempt ${b.attempt} ended failed, which counts against the stage's retries: ${b.message ?? ""}`);
  assert.equal(b.retryCarry, undefined, `the ${stage} attempt ${b.attempt} handed the next claim a retry: ${JSON.stringify(b.retryCarry)}`);
});

Then("the open-pr attempt doesn't end as failed", function () {
  const b = lastEnded(this, "open-pr");
  assert.notEqual(b.status, "failed", `the open-pr attempt ${b.attempt} ended failed: ${b.message ?? ""}`);
});

// ---- the Definition of Done ----

Given("the Definition of Done has the line {string}, naming the CI check {string}", function (line: string, check: string) {
  mine(this).dod.push(`- [ ] ${line} \`ci: ${check}\``);
});

When("the Definition of Done is verified on {string}", long, async function (label: string) {
  const m = mine(this);
  const c = ci292(this);
  const role = c.roles.get(label);
  assert.ok(role, `no commit is labelled "${label}"`);
  const list = (c.rules.get(keyOf(role)) ?? []) as Reported[];
  const text = `# Definition of Done\n\n${m.dod.join("\n")}\n`;
  const dod: Policy = { name: "dod", source: "repo", sha: "dod-sha", text, criteria: parseCriteria(text) };
  const dir = mkdtempSync(join(tmpdir(), "pbi423-"));
  const head = `${label}0000000000000000000000000000000`;
  try {
    m.dodResult = await checkDefinitionOfDone({
      dir, head, dod,
      ciChecks: async () => (hasCancelled(list) ? (await realReading(list)).ciChecks
        : list.map((x) => ({ name: x.name, conclusion: x.conclusion, url: x.url, failingTests: [...(x.failingTests ?? [])] }))),
      judge: async (judged) => judged.map((j) => ({ index: j.index, criterion: j.text, status: "passed" as const, reason: "the judge passed it" })),
      store: async () => {},
    });
  } catch (e) {
    m.dodError = e;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function verdictOf(world: object, line: string): Verdict | undefined {
  const m = mine(world);
  assert.equal(m.dodError, null, `the Definition of Done check threw: ${m.dodError instanceof Error ? m.dodError.stack : String(m.dodError)}`);
  assert.ok(m.dodResult, "the Definition of Done was never verified");
  return m.dodResult.verdicts.find((v) => v.criterion.includes(line));
}

Then("the line {string} is failed by the check {string} at {string}", function (line: string, check: string, url: string) {
  const v = verdictOf(this, line);
  assert.ok(v, `the line "${line}" got no verdict`);
  assert.equal(v.status, "failed", `the line "${line}" ${v.status}: ${v.reason}`);
  assert.ok(namesWord(v.reason, check) && v.reason.includes(url), `the line "${line}" isn't failed by the check "${check}" at ${url}: ${v.reason}`);
});

Then("the line {string} is passed by the check {string} at {string}", function (line: string, check: string, url: string) {
  const v = verdictOf(this, line);
  assert.ok(v, `the line "${line}" got no verdict`);
  assert.equal(v.status, "passed", `the line "${line}" ${v.status}: ${v.reason}`);
  assert.ok(namesWord(v.reason, check) && v.reason.includes(url), `the line "${line}" isn't passed by the check "${check}" at ${url}: ${v.reason}`);
});

Then("the line {string} isn't failed by the check {string}", function (line: string, check: string) {
  const v = verdictOf(this, line);
  assert.ok(!(v && v.status === "failed" && namesWord(v.reason, check)), `the line "${line}" is failed by the check "${check}": ${v?.reason}`);
});

Then("the line {string} isn't passed by the check {string}", function (line: string, check: string) {
  const v = verdictOf(this, line);
  assert.ok(!(v && v.status === "passed" && namesWord(v.reason, check)), `the line "${line}" is passed by the check "${check}": ${v?.reason}`);
});

// ---- InReview ----

Given("webhooks are on", async function () {
  // The delivery goes to the real webhook handler, which takes it on the factory's webhook secret (PBI 235's steps).
  await webhooksOn();
});

When("GitHub delivers that a check suite completed on {string}", long, async function (sha: string) {
  await deliver(this, sha);
});

Then("the factory re-ran no check on {string}", function (sha: string) {
  const c = pollCtx(this);
  polled(c);
  const reruns = c.host!.reruns.filter((r) => r.key.endsWith(`@${sha}`));
  assert.deepEqual(reruns, [], `the factory re-ran checks on "${sha}": ${JSON.stringify(reruns)}`);
});

// ---- the base ----

/** Makes `sha` the newest commit of `base`, with what CI said there. */
function newestOnBase(world: object, sha: string, base: string, newest: string, newestOf: string) {
  assert.equal(newest, sha, "the scenario names two commits");
  assert.equal(newestOf, base, "the scenario names two bases");
  const c = pollCtx(world);
  assert.ok(c.host, "the poller's fakes aren't set up");
  const key = `${POLL_REPO}@${base}`;
  c.host.branches.set(key, [...(c.host.branches.get(key) ?? []).filter((s) => s !== sha), sha]);
  return c.host;
}

Given("CI's only unpassed check on commit {string} of {string} was cancelled, and {string} is the newest commit of {string}", async function (sha: string, base: string, newest: string, newestOf: string) {
  const host = newestOnBase(this, sha, base, newest, newestOf);
  const read = await realReading([
    { name: "lint", conclusion: "success", url: "https://github.com/octo/repo/actions/runs/7400" },
    { name: "ci", conclusion: "cancelled", url: "https://github.com/octo/repo/actions/runs/7401" },
  ]);
  const at = `${POLL_REPO}@${sha}`;
  host.checks.set(at, read.status as never);
  host.ciChecks.set(at, read.ciChecks);
  host.failedChecks.set(at, read.failedChecks.map((f) => ({ ...f, log: null })));
});

Given("CI failed the check {string} on commit {string} of {string}, and {string} is the newest commit of {string}", function (check: string, sha: string, base: string, newest: string, newestOf: string) {
  const host = newestOnBase(this, sha, base, newest, newestOf);
  const at = `${POLL_REPO}@${sha}`;
  const url = "https://github.com/octo/repo/actions/runs/7402";
  host.checks.set(at, "failure");
  host.ciChecks.set(at, [{ name: check, conclusion: "failure", url, failingTests: [] }]);
  host.failedChecks.set(at, [{ name: check, url, log: null }]);
});

async function theAnswer(world: object): Promise<string> {
  polled(pollCtx(world));
  const m = ctx260(world);
  const n = m.lastAsked ?? [...m.items.keys()][0];
  const item = m.items.get(n);
  assert.ok(item, `no item ${n} was set up`);
  const q = (await need().pool.query<{ answer: string | null }>("select answer from question where id = $1", [item.question])).rows[0];
  assert.ok(q?.answer, `item ${n}'s question has no answer`);
  return q.answer;
}

Then("the answer names the commit {string}", long, async function (sha: string) {
  const a = await theAnswer(this);
  assert.ok(a.includes(sha), `the answer doesn't name ${sha}: ${a}`);
});

Then("the answer doesn't name the commit {string}", long, async function (sha: string) {
  const a = await theAnswer(this);
  assert.ok(!a.includes(sha), `the answer names ${sha}: ${a}`);
});
