// Step definitions for features/pbi-292-ci-failure-back-to-green.feature.
//
// The cell scenarios run the engine through PBI 18's harness (its run, "the cell runs" and runTheCell), with PBI 128's
// fake repo host, scripted PR reviewer and PR addresser, PBI 130's person's thread, PBI 234's fake clock and PBI 215's
// base commit. On top of them, these steps put in, just before the cell runs:
//
// - Fake CI, by commit and by check. A commit the scenario names is one of these:
//   - "the PR's first head": the first commit CI is asked about outside the address stage. A label in quotes after it,
//     as in `the PR's first head "c0ffee1"`, names that commit for later steps.
//   - the commit address pushes, named by "address pushes the commit <label>": the first commit CI is asked about in
//     the address stage. The step moves origin/main on by one commit, so the claim's base merge makes a commit for
//     address to push even though the PR addresser makes none.
//   - Green's fix, named by "Green's fix makes the commit <label>": the next commit CI is asked about after the PR's
//     first head.
//   - the base commit, a label PBI 215's `"origin/main" is at commit <label>` gave. Origin's main never takes one of
//     the roles above, labelled or not, since the cell reads CI there to tell a failure the base shares (#215).
//   Each check the scenario names on a commit fails or passes, with its URL and the tests it names as failing. Any
//   other commit has one check, "ci", which passes. The cell API's `checks` answers failure when any check failed, and
//   success otherwise. Its `ciChecks` answers the checks, each a CiCheck with `failingTests`. The factory reads CI on
//   a commit with `checks`; `ciChecks` gives that read's detail and isn't counted as a read of its own.
//   A safety stop fails the cell when CI has been read 40 times, so an engine that never stops reading ends.
// - The PR addresser in the address stage, which "answers the person's thread with a reply and no new commit": it
//   writes a reply to the person's thread to its reply file and leaves the branch as it was.
// - Green that makes no commit: from the Green attempt the scenario says on, each Green attempt leaves the checkout as
//   it found it, so the commit CI failed on stays the head.
//
// What the Thens read:
// - A brief is a Green agent call's prompt, the judge's calls aside, in order. A brief "says CI failed on" a commit when
//   one of its lines says "CI failed" and holds the commit's first 7 characters. It names a check when it holds the
//   check's name as a word of its own and its URL, and a test when it holds the test's name. A brief that "doesn't name
//   the check" is read without the text of Green's prompt file, which names the repo's lint command. A brief "says CI
//   named no failing test for the check" when a line names the check and says "no failing test".
// - An attempt "says" what its report's message says, the message of the /stage report that ends it.
// - Green's attempt is "reported as fixing CI" when a /stage report for it carries `ciFailure`: the commit CI failed on,
//   as `sha`, and each failed check as `{ name, url, failingTests }`.
// - The question is the last transition's question body. It names a commit by its first 7 characters. It "says Green
//   tried to fix the CI failure n times" when a sentence says "tried" and "n times" (or "twice"), and it "says Green's
//   last attempt left <commit> unchanged" when a sentence holds the commit and says "unchanged".
//
// The @db scenarios serve the real dashboard on PBI 4's test database, as PBI 215's do. An item fixing CI is one in
// progress whose cell holds its lease, with a run at green, whose Green attempt the real cell API's POST /stage
// reported started with `ciFailure`. On the Floor, an item's row is the Production Line table's <tr> that links to
// /items/<id>, and its stage is that row's cell under the "Stage" heading. The item "says it is fixing CI" when the
// text says "fixing CI". The item's page is GET /items/<id>; it names a check when its text holds the check's name as a
// word and its markup holds the check's URL.
import { After, Before, BeforeStep, Given, Then, When } from "@cucumber/cucumber";
import type { DataTable } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type pg from "pg";
import { fakeBacklog, fakeRepoHost } from "../../src/adapters/fake.ts";
import type { CiCheck } from "../../src/adapters/types.ts";
import { cellApi, runToken } from "../../src/control/cell-api.ts";
import { startServer } from "../../src/http/server.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";
import { isPbi365, openPage as pbi365Page } from "./pbi-365.steps.ts";
import type { Ctx as CellCtx } from "./pbi-18.steps.ts";
import { ctx as pr128 } from "./pbi-128.steps.ts";
import { ctx as dashCtx, dashboard, escapeRe, get, text } from "./pbi-175.steps.ts";
import { db as db215 } from "./pbi-215.steps.ts";

const repo = process.cwd();
const ADDRESSER = "factory-pr-addresser";
const MAX_READS = 40;

type Check = { name: string; conclusion: "success" | "failure"; url: string; failingTests: string[] };
type Role = { kind: "head" } | { kind: "address" } | { kind: "fix"; n: number } | { kind: "sha"; sha: string };
type Ctx = {
  /** Each label's role, as the steps that named the commit gave it. */
  roles: Map<string, Role>;
  /** The checks each commit reports, by its role's key. */
  rules: Map<string, Check[]>;
  /** The real commit each role's key was given when CI was first asked about it. */
  shas: Map<string, string>;
  fixes: number;
  replyToPerson: boolean;
  /** The first Green attempt that makes no commit, or null when every attempt makes its own. */
  noCommitFrom: number | null;
  reads: number;
  installedOn: CellCtx | null;
};

function cell(world: object): CellCtx {
  const w = world as { pbi18?: CellCtx };
  assert.ok(w.pbi18, "no run was set up");
  return w.pbi18;
}

/** PBI 317's steps name the PR's head and install this CI on the cell its claim runs. */
export function ctx(world: object): Ctx {
  const w = world as { pbi292?: Ctx };
  w.pbi292 ??= { roles: new Map(), rules: new Map(), shas: new Map(), fixes: 0, replyToPerson: false, noCommitFrom: null, reads: 0, installedOn: null };
  return w.pbi292;
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const quoted = (s: string) => [...s.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
export const keyOf = (r: Role) => (r.kind === "fix" ? `fix${r.n}` : r.kind === "sha" ? `sha:${r.sha}` : r.kind);

/** Whether the text names the word as one of its own, so "ci" isn't found inside "decision". */
export function namesWord(t: string, word: string): boolean {
  return new RegExp(`(^|[^\\w-])${escapeRe(word)}([^\\w-]|$)`, "i").test(t);
}

function greenStarts(run: CellCtx): number {
  return run.calls.filter((x) => x.route === "/stage" && x.body.stageId === "green" && x.body.status === "started").length;
}

// ---- naming commits ----

/** The role a commit's words give: the PR's first head, with or without a label, or a label an earlier step named. */
function roleOf(world: object, head: string | undefined, label: string | undefined): Role {
  const c = ctx(world);
  if (head) {
    const role: Role = { kind: "head" };
    if (label) c.roles.set(label, role);
    return role;
  }
  assert.ok(label, "no commit was named");
  const known = c.roles.get(label);
  if (known) return known;
  const base = (world as { pbi215?: { labels: Map<string, string> } }).pbi215?.labels.get(label);
  if (base) {
    const role: Role = { kind: "sha", sha: base };
    c.roles.set(label, role);
    return role;
  }
  assert.fail(`no commit is labelled "${label}"`);
}

/** The real commit a label names, once CI was asked about it. */
export function shaOf(world: object, label: string): string {
  const c = ctx(world);
  const role = c.roles.get(label);
  assert.ok(role, `no commit is labelled "${label}"`);
  if (role.kind === "sha") return role.sha;
  const sha = c.shas.get(keyOf(role));
  assert.ok(sha, `CI was never asked about the commit labelled "${label}"`);
  return sha;
}

function headSha(world: object): string {
  const sha = ctx(world).shas.get("head");
  assert.ok(sha, "CI was never asked about the PR's first head");
  return sha;
}

function addRule(world: object, role: Role, check: Check) {
  const c = ctx(world);
  const list = c.rules.get(keyOf(role)) ?? [];
  list.push(check);
  c.rules.set(keyOf(role), list);
}

// ---- installing CI and the agents on the run, just before it runs ----

/** Gives the commit CI is asked about its role, the first time CI is asked about it. */
function classify(c: Ctx, run: CellCtx, sha: string): string {
  for (const [k, s] of c.shas) if (s === sha) return k;
  for (const role of c.roles.values()) if (role.kind === "sha" && role.sha === sha) { c.shas.set(keyOf(role), sha); return keyOf(role); }
  // The base commit is never one of the run's own pushes, so it takes no role. Unlabelled, its CI passes.
  if (sha === git(run.origin, "rev-parse", "main")) return `sha:${sha}`;
  const key = run.stage === "address" && !c.shas.has("address") ? "address" : !c.shas.has("head") ? "head" : `fix${++c.fixes}`;
  c.shas.set(key, sha);
  return key;
}

function checksOn(c: Ctx, run: CellCtx, sha: string): Check[] {
  return c.rules.get(classify(c, run, sha)) ?? [{ name: "ci", conclusion: "success", url: "https://github.com/acme/widgets/actions/runs/1", failingTests: [] }];
}

/** PBI 233's steps lay re-runs over the checks this CI reports on a commit. */
export function checksAt(world: object, sha: string): Check[] {
  return checksOn(ctx(world), cell(world), sha);
}

export function install(world: object) {
  const c = (world as { pbi292?: Ctx }).pbi292;
  const run = (world as { pbi18?: CellCtx }).pbi18;
  if (!c || !run || c.installedOn === run) return;
  c.installedOn = run;
  run.checks = async (sha: string) => {
    if (++c.reads > MAX_READS) throw new Error(`CI was read ${c.reads} times: the cell never stopped reading it`);
    return checksOn(c, run, sha).some((x) => x.conclusion === "failure") ? "failure" : "success";
  };
  run.apiExtra = {
    ...run.apiExtra,
    async ciChecks(sha: string): Promise<CiCheck[]> {
      run.calls.push({ route: "/ci-checks", body: { sha } });
      return checksOn(c, run, sha).map((x) => ({ ...x, failingTests: [...x.failingTests] }));
    },
  };
  if (!c.replyToPerson && c.noCommitFrom === null) return;
  const prev = run.agent;
  run.agent = async (a, base) => {
    const r = prev ? await prev(a, base) : await base(a);
    if (c.replyToPerson && a.agent === ADDRESSER && run.stage === "address") {
      const file = /reply file is `([^`]+)`/.exec(a.prompt)?.[1];
      const person = pr128(world).personThreads[0];
      if (file && person) appendFileSync(file, JSON.stringify({ threadId: person.threadId, body: "The tax table doesn't cover exports, so this keeps the rate." }) + "\n");
    }
    const judge = a.mode === "judge" || String(a.prompt).startsWith("# Definition of Done");
    if (c.noCommitFrom !== null && run.stage === "green" && !judge && greenStarts(run) >= c.noCommitFrom) {
      git(a.cwd, "checkout", "-q", "--", ".");
      git(a.cwd, "clean", "-fdq");
    }
    return r;
  };
}

BeforeStep({ tags: "@pbi-292" }, function ({ pickleStep }) {
  if (pickleStep.text !== "the cell runs") return;
  // PBI 128's "CI passes on every commit unless a scenario says otherwise", said before the run was set up.
  const w = this as { pbi128Later?: boolean; pbi128?: unknown; pbi18?: unknown };
  if (w.pbi128Later && !w.pbi128 && w.pbi18) pr128(this);
  install(this);
});

// ---- the cell's Givens ----

Given("the PR addresser answers the person's thread with a reply and no new commit", function () {
  const run = cell(this);
  // A scenario that sets up a new run after the Background's left PBI 128's fakes on the old one: put them on this one,
  // keeping the person's thread.
  if (!run.wrapAgent) {
    const old = (this as { pbi128?: ReturnType<typeof pr128> }).pbi128;
    delete (this as { pbi128?: unknown }).pbi128;
    const fresh = pr128(this);
    if (old) {
      fresh.personThreads.push(...old.personThreads);
      for (const [k, v] of old.host.reviewComments) fresh.host.reviewComments.set(k, [...v]);
    }
  }
  const c = pr128(this);
  assert.ok(c.personThreads.length > 0, "no person's thread was set up");
  ctx(this).replyToPerson = true;
});

Given("address pushes the commit {string}", function (label: string) {
  const run = cell(this);
  ctx(this).roles.set(label, { kind: "address" });
  // origin/main moves on, so the claim's base merge leaves a commit for address to push.
  const tmp = mkdtempSync(join(run.root, "main-"));
  git(run.root, "clone", "-q", "-b", "main", run.origin, tmp);
  git(tmp, "config", "user.email", "seed@example.com");
  git(tmp, "config", "user.name", "seed");
  writeFileSync(join(tmp, "base.txt"), "moved on\n");
  git(tmp, "add", "-A");
  git(tmp, "commit", "-q", "-m", "main moves on");
  git(tmp, "push", "-q", "origin", "main");
});

Given("Green's fix makes the commit {string}", function (label: string) {
  const c = ctx(this);
  const n = [...c.roles.values()].filter((r) => r.kind === "fix").length + 1;
  c.roles.set(label, { kind: "fix", n });
});

Given("CI passes after Green's next fix", function () {
  // A commit the scenario names no check on passes, so Green's next fix needs no rule.
  ctx(this);
});

Given("Green's fix for the CI failure makes no commit", function () {
  ctx(this).noCommitFrom = 2;
});

Given("Green's next fix for the CI failure makes no commit", function () {
  const c = ctx(this);
  const fixes = [...c.roles.values()].filter((r) => r.kind === "fix").length;
  c.noCommitFrom = fixes + 2;
});

const ON = `(?:(the PR's first head)(?: "([^"]+)")?|"([^"]+)")`;

Given(new RegExp(`^CI reports the check "([^"]+)" failed on ${ON} at "([^"]+)", (?:failing the tests? (.+)|naming no failing test)$`),
  function (check: string, head: string | undefined, headLabel: string | undefined, label: string | undefined, url: string, tests: string | undefined) {
    addRule(this, roleOf(this, head, headLabel ?? label), { name: check, conclusion: "failure", url, failingTests: tests ? quoted(tests) : [] });
  });

Given(new RegExp(`^these checks report on ${ON}:$`), function (head: string | undefined, headLabel: string | undefined, label: string | undefined, table: DataTable) {
  const role = roleOf(this, head, headLabel ?? label);
  for (const r of table.hashes()) {
    assert.ok(["passed", "failed"].includes(r.status), `not a check status: ${r.status}`);
    const tests = (r["failing tests"] ?? "").split(",").map((t) => t.trim()).filter(Boolean);
    addRule(this, role, { name: r.check, conclusion: r.status === "failed" ? "failure" : "success", url: r.url, failingTests: tests });
  }
});

// ---- the cell's Thens ----

export function settled(run: CellCtx): void {
  assert.equal(run.error, null, `the cell failed: ${run.error instanceof Error ? run.error.stack : String(run.error)}`);
}

function greenBriefs(world: object): string[] {
  const run = cell(world);
  settled(run);
  return run.agentCalls.filter((a) => a.stage === "green" && a.mode !== "judge" && !a.prompt.startsWith("# Definition of Done")).map((a) => a.prompt);
}

const ORDINALS: Record<string, number> = { "": 1, "first ": 1, "second ": 2, "third ": 3 };

export function brief(world: object, which: string): string {
  const n = ORDINALS[which];
  const all = greenBriefs(world);
  assert.ok(all[n - 1], `Green ran ${all.length} time(s), so it has no brief ${n}`);
  return all[n - 1];
}

export const tddPrompt = () => readFileSync(join(repo, "sop/prompts/tdd.md"), "utf8");

export function saysFailedOn(t: string, sha: string): boolean {
  return t.split("\n").some((l) => /CI failed/i.test(l) && l.includes(sha.slice(0, 7)));
}

function assertNamesCheck(t: string, check: string, url: string, what: string) {
  assert.ok(namesWord(t, check), `${what} doesn't name the check "${check}":\n${t}`);
  assert.ok(t.includes(url), `${what} doesn't name the URL ${url}:\n${t}`);
}

const BRIEF = "Green's (|first |second |third )brief";

Then(new RegExp(`^${BRIEF} says CI failed on "([^"]+)"$`), function (which: string, label: string) {
  const b = brief(this, which);
  const sha = shaOf(this, label);
  assert.ok(saysFailedOn(b, sha), `Green's brief doesn't say CI failed on ${sha.slice(0, 7)}:\n${b}`);
});

Then(new RegExp(`^${BRIEF} says CI failed on the PR's first head$`), function (which: string) {
  const b = brief(this, which);
  const sha = headSha(this);
  assert.ok(saysFailedOn(b, sha), `Green's brief doesn't say CI failed on ${sha.slice(0, 7)}:\n${b}`);
});

Then(new RegExp(`^${BRIEF} names the check "([^"]+)" and "([^"]+)"$`), function (which: string, check: string, url: string) {
  assertNamesCheck(brief(this, which), check, url, "Green's brief");
});

Then(new RegExp(`^${BRIEF} names the tests? (".+")$`), function (which: string, names: string) {
  const b = brief(this, which);
  for (const n of quoted(names)) assert.ok(b.includes(n), `Green's brief doesn't name the test "${n}":\n${b}`);
});

Then("Green's brief doesn't name the check {string}", function (check: string) {
  const b = brief(this, "").replace(tddPrompt(), "");
  assert.ok(!namesWord(b, check), `Green's brief names the check "${check}":\n${b}`);
});

Then("Green's brief says CI named no failing test for the check {string}", function (check: string) {
  const b = brief(this, "");
  assert.ok(b.split("\n").some((l) => namesWord(l, check) && /no failing test/i.test(l)), `Green's brief doesn't say CI named no failing test for "${check}":\n${b}`);
});

/** The messages of the attempts the run ended, with each attempt's stage: an earlier claim's (PBI 315), then this cell's. */
export function ended(world: object): { stageId: string; attempt: number; message: string }[] {
  const run = cell(world);
  settled(run);
  return [...(run.earlierCalls ?? []), ...run.calls].filter((x) => x.route === "/stage" && x.body.status !== "started")
    .map((x) => ({ stageId: String(x.body.stageId), attempt: Number(x.body.attempt), message: String(x.body.message ?? "") }));
}

function addressMessage(world: object): string {
  const a = ended(world).find((x) => x.stageId === "address");
  assert.ok(a, "no address attempt ended");
  return a.message;
}

Then("the address attempt's message names the check {string} and {string}", function (check: string, url: string) {
  assertNamesCheck(addressMessage(this), check, url, "The address attempt's message");
});

Then("the address attempt's message names the test {string}", function (test: string) {
  const m = addressMessage(this);
  assert.ok(m.includes(test), `the address attempt's message doesn't name the test "${test}": ${m}`);
});

Then("exactly {int} attempt in the run says CI failed on {string}", function (n: number, label: string) {
  const sha = shaOf(this, label);
  const saying = ended(this).filter((a) => saysFailedOn(a.message, sha));
  assert.equal(saying.length, n, `${saying.length} attempts say CI failed on ${sha.slice(0, 7)}: ${JSON.stringify(saying)}`);
});

Then("the factory read CI on {string} no more than {int} time after it failed", function (label: string, n: number) {
  const sha = shaOf(this, label);
  const run = cell(this);
  settled(run);
  const reads = run.calls.filter((x) => x.route === "/checks" && x.body.sha === sha);
  assert.ok(reads.length > 0, `the factory never read CI on ${sha.slice(0, 7)}`);
  const after = reads.length - 1;
  assert.ok(after <= n, `the factory read CI on ${sha.slice(0, 7)} ${after} times after it failed`);
});

function fixingReports(world: object): Record<string, any>[] {
  const run = cell(world);
  settled(run);
  return run.calls.filter((x) => x.route === "/stage" && x.body.ciFailure).map((x) => x.body);
}

const sameCommit = (sha: string, said: unknown) => typeof said === "string" && said.length >= 7 && sha.startsWith(said);

Then("Green's second attempt was reported as fixing CI on {string}", function (label: string) {
  const sha = shaOf(this, label);
  const r = fixingReports(this).filter((b) => b.stageId === "green" && b.attempt === 2);
  assert.ok(r.length > 0, "Green's second attempt wasn't reported as fixing CI");
  assert.ok(r.some((b) => sameCommit(sha, b.ciFailure.sha)), `Green's second attempt was reported as fixing CI on ${JSON.stringify(r.map((b) => b.ciFailure.sha))}, not ${sha}`);
  (this as { pbi292report?: Record<string, any> }).pbi292report = r.find((b) => sameCommit(sha, b.ciFailure.sha));
});

Then("that report names the check {string} and {string}", function (check: string, url: string) {
  const r = (this as { pbi292report?: Record<string, any> }).pbi292report;
  assert.ok(r, "no report was found before this step");
  const checks = (r.ciFailure.checks ?? []) as { name: string; url: string }[];
  assert.ok(checks.some((x) => x.name === check && x.url === url), `the report doesn't name the check "${check}" at ${url}: ${JSON.stringify(checks)}`);
});

Then("Green's first attempt wasn't reported as fixing CI", function () {
  const r = fixingReports(this).filter((b) => b.stageId === "green" && b.attempt === 1);
  assert.deepEqual(r, [], "Green's first attempt was reported as fixing CI");
});

Then("no attempt was reported as fixing CI", function () {
  const r = fixingReports(this);
  assert.deepEqual(r, [], `attempts were reported as fixing CI: ${JSON.stringify(r)}`);
});

function theQuestion(world: object): string {
  const run = cell(world);
  settled(run);
  const t = run.calls.filter((x) => x.route === "/transition").at(-1);
  assert.ok(t, "the cell sent no transition");
  assert.ok(t.body.question, `the last transition, ${t.body.event}, asks no question`);
  return String(t.body.question.body ?? "");
}

const sentences = (t: string) => t.split(/\n|(?<=[.!?])\s+/);

Then("the question names the check {string} and {string}", function (check: string, url: string) {
  assertNamesCheck(theQuestion(this), check, url, "The question");
});

Then("the question names the commit {string}", function (label: string) {
  const sha = shaOf(this, label);
  const q = theQuestion(this);
  assert.ok(q.includes(sha.slice(0, 7)), `the question doesn't name the commit ${sha.slice(0, 7)}: ${q}`);
});

Then("the question names the commits {string} and {string} that CI failed on", function (a: string, b: string) {
  const q = theQuestion(this);
  for (const label of [a, b]) {
    const sha = shaOf(this, label);
    assert.ok(q.includes(sha.slice(0, 7)), `the question doesn't name the commit ${sha.slice(0, 7)}: ${q}`);
  }
});

Then("the question says Green tried to fix the CI failure {int} times", function (n: number) {
  const q = theQuestion(this);
  const times = n === 2 ? `(?:${n} times|twice)` : `${n} times`;
  assert.ok(sentences(q).some((s) => /tried/i.test(s) && new RegExp(`\\b${times}\\b`, "i").test(s)), `the question doesn't say Green tried ${n} times: ${q}`);
});

Then("the question says Green's last attempt left {string} unchanged", function (label: string) {
  const sha = shaOf(this, label);
  const q = theQuestion(this);
  assert.ok(sentences(q).some((s) => s.includes(sha.slice(0, 7)) && /unchanged/i.test(s)), `the question doesn't say ${sha.slice(0, 7)} was left unchanged: ${q}`);
});

// ---- the Floor and the item's page ----

type Db = { server?: Server; origin?: string; secret: string; items: Map<number, string> };

function mineDb(world: object): Db {
  const w = world as { pbi292db?: Db };
  w.pbi292db ??= { secret: "pbi-292-secret", items: new Map() };
  return w.pbi292db;
}

const pool = (): pg.Pool => need().pool;

Before({ tags: "@pbi-292 and @db", ...long }, async function () {
  const d = await testDb();
  if (d) await d.pool.query('truncate item, event, backlog_source, repo, "user" cascade');
});

After({ tags: "@pbi-292 and @db", ...long }, async function () {
  const w = this as { pbi292db?: Db; pbi215db?: { server?: Server }; pbi175?: { server?: Server; close?: () => Promise<void> } };
  for (const s of [w.pbi292db?.server, w.pbi215db?.server, w.pbi175?.server]) {
    if (!s) continue;
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  await w.pbi175?.close?.();
});

async function cellApiServer(d: Db): Promise<string> {
  if (d.origin) return d.origin;
  const handler = cellApi({
    pool: pool(), secret: d.secret, repoHost: fakeRepoHost(), backlogFor: () => fakeBacklog().adapter, stageAfter: () => null,
    uploadUrl: async (p) => `http://blob.invalid/${p}`, gateway: { upstream: "http://model.invalid", ownerToken: () => "none" }, webToolsOf: () => [],
  });
  d.server = await startServer([handler], { port: 0 });
  d.origin = `http://127.0.0.1:${(d.server.address() as AddressInfo).port}`;
  return d.origin;
}

/** An item in progress at Green, whose cell holds its lease and reports its Green attempt started through POST /stage. */
async function atGreen(world: object, n: number, ciFailure: Record<string, unknown> | null): Promise<void> {
  const d = mineDb(world);
  const dc = dashCtx(world);
  await dashboard(dc);
  const item = (await pool().query<{ id: string }>(
    `insert into item (source_id, external_id, title, state, lease_generation, lease_owner, lease_expires)
     values ($1, $2, $3, 'InProgress', 1, 'cell-a', now() + interval '5 minutes') returning id`,
    [dc.sourceId, String(n), `Item ${n}`],
  )).rows[0].id;
  const run = (await pool().query<{ id: string }>(
    "insert into run (item_id, run_number, next_stage, branch) values ($1, 1, 'green', $2) returning id", [item, `factory/pbi-${n}-r1`],
  )).rows[0].id;
  d.items.set(n, item);
  const r = await fetch(`${await cellApiServer(d)}/internal/cells/${run}/stage`, {
    method: "POST",
    headers: { authorization: `Bearer ${runToken(d.secret, run, 1)}`, "content-type": "application/json" },
    body: JSON.stringify({
      stageId: "green", attempt: ciFailure ? 2 : 1, status: "started", model: "claude-opus-5-5", effort: "medium", tokensIn: 0, tokensOut: 0, costUsd: 0,
      ...(ciFailure ? { ciFailure } : {}),
    }),
  });
  assert.equal(r.status, 200, `the cell API answered ${r.status}: ${await r.text()}`);
}

Given(/^item (\d+) is in progress at Green, fixing the CI failure of the checks? (.+) on commit "([^"]+)"$/, long, async function (n: string, checks: string, sha: string) {
  const list = [...checks.matchAll(/"([^"]+)" at "([^"]+)"/g)].map((m) => ({ name: m[1], url: m[2], failingTests: [] as string[] }));
  assert.ok(list.length > 0, `can't read the checks in: ${checks}`);
  await atGreen(this, Number(n), { sha, checks: list });
});

Given("item {int} is in progress at Green, with no CI failure to fix", long, async function (n: number) {
  await atGreen(this, n, null);
});

When("{string} opens item {int}'s page", long, async function (login: string, n: number) {
  if (isPbi365(this)) return pbi365Page(this, login);
  await get(this, `/items/${itemId(this, n)}`, login);
});

function itemId(world: object, n: number): string {
  const id = mineDb(world).items.get(n) ?? db215(world).items.get(n);
  assert.ok(id, `no item ${n} was set up`);
  return id;
}

function page(world: object): string {
  const c = dashCtx(world);
  assert.equal(c.status, 200, `the dashboard answered ${c.status}: ${String(c.page).slice(0, 300)}`);
  return c.page!;
}

const cells = (row: string) => [...row.matchAll(/<t([dh])\b[^>]*>([\s\S]*?)<\/t\1>/gi)].map((m) => m[2]);

/** Item n's row on the Floor, and its stage cell. */
function floorRow(world: object, n: number): { row: string; stage: string } {
  const html = page(world);
  const id = itemId(world, n);
  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]);
  const heads = rows.map(cells).find((r) => r.some((x) => text(x) === "Stage"));
  assert.ok(heads, `the Floor has no table with a Stage column: ${text(html).slice(0, 500)}`);
  const col = heads.findIndex((x) => text(x) === "Stage");
  const row = rows.find((r) => r.includes(`href="/items/${id}"`));
  assert.ok(row, `the Floor has no row for item ${n}: ${text(html).slice(0, 500)}`);
  return { row, stage: text(cells(row)[col] ?? "") };
}

const FIXING = /fixing CI/i;

Then("item {int}'s stage on the Floor says it is fixing CI", function (n: number) {
  const { stage } = floorRow(this, n);
  assert.match(stage, FIXING, `item ${n}'s stage on the Floor is "${stage}"`);
});

Then("item {int}'s stage on the Floor doesn't say it is fixing CI", function (n: number) {
  // PBI 430: an item waiting on a question is listed under "Waiting on you", which has no Stage column, so its whole
  // row there mustn't say it either.
  const html = page(this);
  const id = itemId(this, n);
  const from = html.indexOf("<h2>Waiting on you</h2>");
  const to = html.indexOf("<h2>Production Line</h2>");
  const waiting = from < 0 ? "" : html.slice(from, to < 0 ? undefined : to);
  const listed = [...waiting.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => m[1]).find((r) => r.includes(`href="/items/${id}"`));
  const stage = listed === undefined ? floorRow(this, n).stage : text(listed);
  assert.doesNotMatch(stage, FIXING, `item ${n}'s stage on the Floor is "${stage}"`);
});

Then("item {int}'s row on the Floor names the check {string}", function (n: number, check: string) {
  const t = text(floorRow(this, n).row);
  assert.ok(namesWord(t, check), `item ${n}'s row doesn't name the check "${check}": ${t}`);
});

Then("item {int}'s row on the Floor names the checks {string} and {string}", function (n: number, a: string, b: string) {
  const t = text(floorRow(this, n).row);
  for (const check of [a, b]) assert.ok(namesWord(t, check), `item ${n}'s row doesn't name the check "${check}": ${t}`);
});

Then("item {int}'s row on the Floor names the commit {string}", function (n: number, sha: string) {
  const t = text(floorRow(this, n).row);
  assert.ok(t.includes(sha), `item ${n}'s row doesn't name the commit ${sha}: ${t}`);
});

Then("item {int}'s stage on the Floor isn't the plain stage name {string}", function (n: number, name: string) {
  const { stage } = floorRow(this, n);
  assert.notEqual(stage.trim(), name, `item ${n}'s stage on the Floor is the plain stage name "${name}"`);
});

Then("the item's page says it is fixing CI", function () {
  const t = text(page(this));
  assert.match(t, FIXING, `the item's page doesn't say it is fixing CI: ${t.slice(0, 800)}`);
});

Then("the item's page names the check {string} and {string}", function (check: string, url: string) {
  const html = page(this);
  const t = text(html);
  assert.ok(namesWord(t, check), `the item's page doesn't name the check "${check}": ${t.slice(0, 800)}`);
  assert.ok(html.includes(url), `the item's page doesn't name the URL ${url}`);
});

Then("the item's page names the commit {string}", function (sha: string) {
  const t = text(page(this));
  assert.ok(t.includes(sha), `the item's page doesn't name the commit ${sha}: ${t.slice(0, 800)}`);
});

