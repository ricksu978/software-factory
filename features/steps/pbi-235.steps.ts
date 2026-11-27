// Step definitions for features/pbi-235-ci-failure-in-review-back-to-address.feature.
//
// The scenarios run the real poller and the real webhook handler over PBI 4's shared database, on PBI 12's harness:
// its fake board and fake repo host, its "the poller runs once", and PBI 168's "the factory holds item <n> in state",
// which, once the scenario holds item <n>, checks its state. Item 482 is a board item in "acme/widgets" that the
// factory holds in InReview, with an open run whose PR 57 is in the fake repo host, with no review and mergeable.
// The repo "acme/widgets" is a known repo the run points at, so the webhook finds the run by the PR's repo.
//
// CI is PBI 292's: its "CI reports the check ... failed on <commit> at <url>, failing the test ..." and "these checks
// report on <commit>:" steps write each commit's checks into PBI 292's rules, under `sha:<commit>`. The steps here
// name each commit, the PR's head and its earlier commits, for PBI 292 as a plain sha, and add their own checks to
// the same rules: a check that passed, one still running and a re-run. Just before each poll and each delivery, the
// rules go into the fake repo host: each commit's checks, the last one of each name winning, as `ciChecksOnSha`
// answers them, its overall status as `checksOnSha` does, and its failed checks as `failedChecksOnSha` does. The PR's
// head is the fake PR's `headSha`, and the PR's commits are its branch's line in the fake's `branches`.
//
// A delivery is GitHub's `check_suite` `completed` webhook for the commit, signed with the factory's webhook secret,
// with its own delivery id, handed to the real handleWebhook with PBI 11's parser and the fake repo host as its
// `repoHost`. It counts as a poll for the Thens.
//
// What the Thens read: the item's `changes_requested` transition events, since the Background held the item in
// InReview. That event's payload names its cause as
//   { kind: "ci_failed", sha, checks: [{ name, url, failingTests }] }
// and holds `findings`, the findings address gets, as a list of strings. The findings "say CI failed on" a commit when
// one finding says "CI failed" and names the commit. They name a check when one finding names the check as a word of
// its own and its URL, and a test when they hold its name.
import { Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import type { CiCheck } from "../../src/adapters/types.ts";
import { ctx as pbi12, polled, setup, type Ctx as PollCtx } from "./pbi-12.steps.ts";
import { ctx as pbi292, namesWord } from "./pbi-292.steps.ts";
import { load, long, need, testDb } from "./pbi-8.steps.ts";
import { hasCancelled, realReading } from "./ci-reading.ts";

const REPO = "acme/widgets";
// Made up for each run, so no fixed signing value sits in the source.
const WEBHOOK_SECRET = randomBytes(20).toString("hex");
const PASSED_URL = "https://github.com/acme/widgets/actions/runs/7000";

type Mine = {
  /** When each held item came to the state the scenario put it in, by external id. */
  since: Map<string, Date>;
  /** Each held item's PR number, by external id. */
  prs: Map<string, number>;
};
function mine(world: object): Mine {
  const w = world as { pbi235?: Mine };
  w.pbi235 ??= { since: new Map(), prs: new Map() };
  return w.pbi235;
}

const pool = () => need().pool;
const branchOf = (ext: string) => `factory/pbi-${ext}-r1`;

Before({ tags: "@pbi-235 and @db", ...long }, async function () {
  const d = await testDb();
  if (d) await d.pool.query('truncate item, event, backlog_source, repo, webhook_delivery, "user" cascade');
});

// ---- CI on commits, through PBI 292's rules ----

type Rule = { name: string; conclusion: CiCheck["conclusion"]; url: string; failingTests: string[] };

/** Names `sha` for PBI 292's CI steps, as a plain commit. */
function nameCommit(world: object, sha: string): void {
  const c = pbi292(world);
  if (!c.roles.has(sha)) c.roles.set(sha, { kind: "sha", sha });
}

function addCheck(world: object, sha: string, check: Rule): void {
  nameCommit(world, sha);
  const rules = pbi292(world).rules as unknown as Map<string, Rule[]>;
  const key = `sha:${sha}`;
  rules.set(key, [...(rules.get(key) ?? []), check]);
}

/** Asserts that `sha:<sha>` now holds `check` as its latest check of that name, and that the commit is named for PBI 292. */
function assertHolds(world: object, sha: string, check: Rule): void {
  const c = pbi292(world);
  assert.deepEqual(c.roles.get(sha), { kind: "sha", sha }, `"${sha}" isn't named as a commit`);
  const rules = (c.rules as unknown as Map<string, Rule[]>).get(`sha:${sha}`) ?? [];
  const latest = rules.filter((r) => r.name === check.name).at(-1);
  assert.deepEqual(latest, check, `"${sha}" doesn't hold the ${check.conclusion} check "${check.name}"`);
}

/**
 * Puts every commit's checks into the fake repo host, the last check of each name winning. PBI 423: a commit holding a
 * cancelled run is read as the control plane reads GitHub's check runs (ci-reading.ts), with every run of a name kept.
 */
async function installCi(world: object): Promise<void> {
  const host = pbi12(world).host;
  if (!host) return;
  const rules = pbi292(world).rules as unknown as Map<string, Rule[]>;
  for (const [key, list] of rules) {
    if (!key.startsWith("sha:")) continue;
    const sha = key.slice(4);
    const at = `${REPO}@${sha}`;
    if (hasCancelled(list)) {
      const read = await realReading(list);
      host.ciChecks.set(at, read.ciChecks);
      host.checks.set(at, read.status as never);
      host.failedChecks.set(at, read.failedChecks.map((f) => ({ ...f, log: null })));
      host.pendingChecks.set(at, read.ciChecks.filter((x) => x.conclusion === "pending").map((x) => x.name));
      continue;
    }
    const byName = new Map<string, Rule>();
    for (const r of list) byName.set(r.name, r);
    const checks: CiCheck[] = [...byName.values()].map((r) => ({ name: r.name, conclusion: r.conclusion, url: r.url, failingTests: [...r.failingTests] }));
    host.ciChecks.set(at, checks);
    host.checks.set(at, checks.some((x) => x.conclusion === "failure") ? "failure" : checks.some((x) => x.conclusion === "pending") ? "pending" : "success");
    host.failedChecks.set(at, checks.filter((x) => x.conclusion === "failure").map((x) => ({ name: x.name, url: x.url, log: null })));
    host.pendingChecks.set(at, checks.filter((x) => x.conclusion === "pending").map((x) => x.name));
  }
}

// ---- the item, its PR and its head ----

function fakePr(world: object, n: number) {
  const p = pbi12(world).host?.prs.find((x) => x.repo === REPO && x.number === n);
  assert.ok(p, `no PR ${n} in "${REPO}"`);
  return p;
}

/** Moves the PR's head to `sha`, a new commit on the PR's branch. */
function moveHead(world: object, n: number, sha: string): void {
  const p = fakePr(world, n);
  p.headSha = sha;
  const host = pbi12(world).host!;
  const key = `${REPO}@${p.branch}`;
  host.branches.set(key, [...(host.branches.get(key) ?? []).filter((s) => s !== sha), sha]);
  nameCommit(world, sha);
}

async function holdWithPr(world: object, ext: string, state: string, n: number, repo: string): Promise<PollCtx> {
  assert.equal(repo, REPO, `the scenarios' PRs are in "${REPO}"`);
  const c = pbi12(world);
  assert.ok(await setup(c), "the poller's fakes or database aren't available");
  c.beforePoll = async () => { await installCi(world); };
  const repoId = (await pool().query<{ id: string }>(
    `insert into repo (host_adapter, url) values ('fake', $1) on conflict do nothing returning id`, [`https://github.com/${REPO}`],
  )).rows[0]?.id ?? (await pool().query<{ id: string }>("select id from repo where url = $1", [`https://github.com/${REPO}`])).rows[0].id;
  await c.fake!.seed({ externalId: ext, labels: ["factory"], repo: REPO });
  const branch = branchOf(ext);
  c.host!.prs.push({
    number: n, repo: REPO, branch, base: "main", title: `Item ${ext}`, body: "", headSha: null, open: true, merged: false,
    mergeSha: null, mergeable: true, reviewers: [], comments: [], reviews: [],
  });
  const inProgress = state === "InProgress";
  const item = (await pool().query<{ id: string }>(
    `insert into item (source_id, external_id, title, state, repo, lease_generation, lease_owner, lease_expires)
     values ($1, $2, $3, $4, $5, 1, $6, $7) returning id`,
    [c.sourceId, ext, `Item ${ext}`, state, REPO, inProgress ? "cell-a" : null, inProgress ? new Date(Date.now() + 5 * 60_000) : null],
  )).rows[0].id;
  await pool().query(
    `insert into run (item_id, run_number, next_stage, branch, pr_number, pr_url, repo_id, reviews_seen_at)
     values ($1, 1, $2, $3, $4, $5, $6, now() - interval '1 hour')`,
    [item, inProgress ? "pr-review" : "open-pr", branch, n, `https://github.com/${REPO}/pull/${n}`, repoId],
  );
  if (!c.extIds.includes(ext)) c.extIds.push(ext);
  if (c.extIds[0] === ext) c.pr = n;
  const m = mine(world);
  m.prs.set(ext, n);
  m.since.set(ext, (await pool().query<{ now: Date }>("select now()")).rows[0].now);
  return c;
}

Given("the factory holds item {int} in state {string} with PR {int} in {string}", long, async function (ext: number, state: string, n: number, repo: string) {
  await holdWithPr(this, String(ext), state, n, repo);
});

Given("the factory holds item {int} in state {string} with PR {int} in {string}, whose head is {string}", long,
  async function (ext: number, state: string, n: number, repo: string, sha: string) {
    await holdWithPr(this, String(ext), state, n, repo);
    moveHead(this, n, sha);
  });

Given("the head of PR {int} is {string}", function (n: number, sha: string) {
  moveHead(this, n, sha);
});

When("the head of PR {int} becomes {string}", function (n: number, sha: string) {
  moveHead(this, n, sha);
});

Given("the head of PR {int} has since become {string}, whose CI is still running", function (n: number, sha: string) {
  moveHead(this, n, sha);
  addCheck(this, sha, { name: "ci", conclusion: "pending", url: "https://github.com/acme/widgets/actions/runs/7310", failingTests: [] });
});

Given("PR {int} merges cleanly with its base", function (n: number) {
  const p = fakePr(this, n);
  p.mergeable = true;
});

Given("nobody has asked for changes on PR {int}", function (n: number) {
  const p = fakePr(this, n);
  p.reviews = [];
  pbi12(this).host!.reviewComments.set(`${REPO}#${n}`, []);
});

// ---- CI ----

Given("CI is still running on {string}", function (sha: string) {
  const check: Rule = { name: "ci", conclusion: "pending", url: "https://github.com/acme/widgets/actions/runs/7299", failingTests: [] };
  addCheck(this, sha, check);
  assertHolds(this, sha, check);
});

Given("CI passed on {string}", function (sha: string) {
  const check: Rule = { name: "ci", conclusion: "success", url: PASSED_URL, failingTests: [] };
  addCheck(this, sha, check);
  assertHolds(this, sha, check);
});

When("CI on {string} is re-run and reports the check {string} failed at {string}, failing the test {string}", function (sha: string, check: string, url: string, test: string) {
  const before = (pbi292(this).rules as unknown as Map<string, Rule[]>).get(`sha:${sha}`) ?? [];
  assert.ok(before.length > 0, `CI never reported on "${sha}", so there's nothing to re-run`);
  const rule: Rule = { name: check, conclusion: "failure", url, failingTests: [test] };
  addCheck(this, sha, rule);
  assertHolds(this, sha, rule);
});

Given("the PR's earlier commit {string} had the check {string} fail at {string}, failing the test {string}", function (sha: string, check: string, url: string, test: string) {
  const c = pbi12(this);
  const n = c.pr!;
  const p = fakePr(this, n);
  const key = `${REPO}@${p.branch}`;
  // The earlier commit comes before every commit the PR has had since.
  c.host!.branches.set(key, [sha, ...(c.host!.branches.get(key) ?? []).filter((s) => s !== sha)]);
  addCheck(this, sha, { name: check, conclusion: "failure", url, failingTests: [test] });
});

Given("CI reports the check {string} failed on {string}, a commit on {string} that isn't on PR {int}, at {string}", function (check: string, sha: string, branch: string, n: number, url: string) {
  const host = pbi12(this).host!;
  const p = fakePr(this, n);
  assert.ok(!(host.branches.get(`${REPO}@${p.branch}`) ?? []).includes(sha), `"${sha}" is on PR ${n}`);
  const key = `${REPO}@${branch}`;
  host.branches.set(key, [...(host.branches.get(key) ?? []), sha]);
  addCheck(this, sha, { name: check, conclusion: "failure", url, failingTests: [] });
});

// ---- GitHub's delivery ----

type Webhook = {
  handleWebhook: (
    deps: { pool: pg.Pool; secret: string; parse: (h: Record<string, string>, b: unknown) => unknown; repoHost?: unknown },
    req: { headers: Record<string, string>; rawBody: Buffer },
  ) => Promise<{ status: number }>;
};
type Parser = { parseGitHubWebhook: (h: Record<string, string>, b: unknown) => unknown };

When("GitHub delivers that a check suite completed on {string} in {string}", long, async function (sha: string, repo: string) {
  await deliver(this, sha, repo);
});

/** PBI 423: webhooks are on when the real webhook handler and GitHub's parser load and the factory has a webhook secret. */
export async function webhooksOn(): Promise<void> {
  const [hook, gh] = await Promise.all([load<Webhook>("src/watcher/webhook.ts"), load<Parser>("src/adapters/github/backlog.ts")]);
  assert.ok(hook && typeof hook.handleWebhook === "function", "the real webhook handler isn't available");
  assert.ok(gh && typeof gh.parseGitHubWebhook === "function", "GitHub's webhook parser isn't available");
  assert.ok(WEBHOOK_SECRET.length >= 40, "the factory has no webhook secret");
}

/** GitHub's `check_suite` `completed` delivery for `sha` in `repo`, handed to the real webhook handler. PBI 423's steps deliver it too. */
export async function deliver(world: object, sha: string, repo: string = REPO): Promise<void> {
  const c = pbi12(world);
  const [hook, gh] = await Promise.all([load<Webhook>("src/watcher/webhook.ts"), load<Parser>("src/adapters/github/backlog.ts")]);
  assert.ok(hook && gh && c.host, "the webhook handler or the fakes aren't available");
  await installCi(world);
  const raw = Buffer.from(JSON.stringify({
    action: "completed",
    check_suite: { id: 9235, head_sha: sha, status: "completed", conclusion: c.host.checks.get(`${repo}@${sha}`) ?? null },
    repository: { full_name: repo },
    sender: { login: "github-actions[bot]", type: "Bot" },
  }));
  const r = await hook.handleWebhook({ pool: pool(), secret: WEBHOOK_SECRET, parse: gh.parseGitHubWebhook, repoHost: c.host }, {
    rawBody: raw,
    headers: {
      "content-type": "application/json", "x-github-event": "check_suite", "x-github-delivery": randomUUID(),
      "x-hub-signature-256": `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex")}`,
    },
  });
  assert.equal(r.status, 204, "the webhook didn't take the delivery");
  c.deliveries = (c.deliveries ?? 0) + 1;
}

// ---- the Thens ----

type Payload = { cause?: { kind?: string; sha?: string; checks?: unknown }; findings?: unknown };

async function changeEvents(world: object, ext: string, sinceHeld: boolean, event = "changes_requested"): Promise<Payload[]> {
  const c = pbi12(world);
  polled(c);
  const since = sinceHeld ? mine(world).since.get(ext) : undefined;
  if (sinceHeld) assert.ok(since, `the scenario doesn't hold item ${ext}`);
  const r = await pool().query<{ payload: Payload }>(
    `select e.payload from event e join item i on i.id = e.item_id
     where i.source_id = $1 and i.external_id = $2 and e.kind = 'transition' and e.payload->>'event' = $3 and e.at >= $4
     order by e.at, e.id`,
    [c.sourceId, ext, event, since ?? new Date(0)],
  );
  return r.rows.map((x) => x.payload);
}

/** The findings of item 482's newest `changes_requested` event. */
async function findings(world: object): Promise<string[]> {
  const ext = pbi12(world).extIds[0];
  const all = await changeEvents(world, ext, true);
  assert.ok(all.length > 0, `item ${ext} has no "changes_requested" event`);
  const f = all.at(-1)!.findings;
  assert.ok(Array.isArray(f) && f.length > 0 && f.every((x) => typeof x === "string"),
    `item ${ext}'s "changes_requested" event holds no findings: ${JSON.stringify(all.at(-1))}`);
  return f as string[];
}

Then("the item's findings say CI failed on {string}", long, async function (sha: string) {
  const f = await findings(this);
  assert.ok(f.some((x) => x.includes("CI failed") && x.includes(sha)), `no finding says CI failed on "${sha}": ${JSON.stringify(f)}`);
});

Then("the item's findings name the check {string} and {string}", long, async function (check: string, url: string) {
  const f = await findings(this);
  assert.ok(f.some((x) => namesWord(x, check) && x.includes(url)), `no finding names the check "${check}" and ${url}: ${JSON.stringify(f)}`);
});

Then("the item's findings name the test {string}", long, async function (test: string) {
  const f = await findings(this);
  assert.ok(f.some((x) => x.includes(test)), `no finding names the test "${test}": ${JSON.stringify(f)}`);
});

Then("the item's findings name the tests {string} and {string}", long, async function (a: string, b: string) {
  const f = await findings(this);
  for (const t of [a, b]) assert.ok(f.some((x) => x.includes(t)), `no finding names the test "${t}": ${JSON.stringify(f)}`);
});

Then("the item's findings don't name the check {string}", long, async function (check: string) {
  const f = await findings(this);
  assert.ok(!f.some((x) => namesWord(x, check)), `a finding names the check "${check}": ${JSON.stringify(f)}`);
  assert.ok(!f.some((x) => x.includes(PASSED_URL) || x.includes("actions/runs/7300")), `a finding names a passed check's URL: ${JSON.stringify(f)}`);
});

Then("the item's findings don't name {string}", long, async function (text: string) {
  const f = await findings(this);
  assert.ok(!f.some((x) => x.includes(text)), `a finding names "${text}": ${JSON.stringify(f)}`);
});

Then("the item's {string} event names CI failing on {string} as its cause", long, async function (event: string, sha: string) {
  const ext = pbi12(this).extIds[0];
  const all = await changeEvents(this, ext, true, event);
  assert.ok(all.length > 0, `item ${ext} has no "${event}" event`);
  const cause = all.at(-1)!.cause;
  assert.equal(cause?.kind, "ci_failed", `the cause is ${JSON.stringify(cause)}`);
  assert.equal(cause?.sha, sha);
});

Then("item {int} has no {string} event since it came to InReview", long, async function (ext: number, event: string) {
  const all = await changeEvents(this, String(ext), true, event);
  assert.deepEqual(all, [], `item ${ext} has a "${event}" event`);
});

Then("item {int} has exactly {int} {string} event since it came to InReview", long, async function (ext: number, n: number, event: string) {
  const all = await changeEvents(this, String(ext), true, event);
  assert.equal(all.length, n, `item ${ext}'s "${event}" events: ${JSON.stringify(all)}`);
});

Then("item {int} has no {string} event", long, async function (ext: number, event: string) {
  const all = await changeEvents(this, String(ext), false, event);
  assert.deepEqual(all, [], `item ${ext} has a "${event}" event`);
});
