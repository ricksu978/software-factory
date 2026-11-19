// Step definitions for features/pbi-331-base-moves-during-merge-pass.feature.
//
// The cell scenarios run PBI 18's engine harness: a real bare origin, a working clone the engine runs in, its scripted
// agent and recording cell API. These steps build the conflict the background describes on top of it:
// - The item's branch adds "src/app.ts" (and "src/other.ts", which main doesn't hold yet) and is pushed to origin.
// - "main" then adds its own "src/app.ts"; that commit is b4se001, the base the claim fetches.
// - The merge agent is the scripted agent while the engine reports the `merge` stage started. First it does what lands
//   on "main" while it works, pushing b4se002 to origin from a clone of its own, then it resolves, leaves the markers
//   or aborts. Every other stage gets PBI 18's default agent, which passes green, refactor, open-pr and address.
// - The repo host opens and reports PR 57.
//
// The contract these steps read:
// - A fetch is one run of the origin's upload-pack from the engine's checkout, counted through the checkout's
//   `remote.origin.uploadpack`, which wraps git-upload-pack with a line in a log. Pushes don't run it.
// - "The branch" is the item's branch as the cell pushed it to origin, the branch the next claim clones. A run that
//   blocks pushes nothing (PBI 215 pushes only a base failure), so its branch is the one the claim started from.
// - A blocked item is the cell's `blocked` transition, whose question body is the reason.
//
// The @db scenario runs that cell for the first claim, then holds the item in PBI 12's poller harness in the state the
// claim's last transition leads to, with PR 57 open in the fake repo host. PBI 12's "the poller runs once", "the
// factory holds the item in state" and "the item's run resumes from", and PBI 305's "GitHub reports PR ... as
// conflicting with its base", read that harness. The second claim is a fresh clone of the pushed branch, run from the
// stage the poller left the run at.
import { Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { next, type ItemEvent, type ItemState } from "../../src/core/states.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";
import { ctx as pollCtx, setup } from "./pbi-12.steps.ts";
import { runTheCell, setUp, type Ctx as CellCtx } from "./pbi-18.steps.ts";

const BRANCH = "factory/pbi-482-r1";
const PR = 57;
const REPO = "acme/widgets";

// The poller harness's setup inserts its repo row afresh, so each @db scenario starts from empty tables, as PBI 142's do.
Before({ tags: "@pbi-331 and @db", ...long }, async function () {
  const d = await testDb();
  if (d) await d.pool.query('truncate item, backlog_source, repo, "user" cascade');
});

type Moves = "none" | "conflicting" | "docs" | "both";
type Agent = "resolves" | "markers" | "aborts";

type Ctx = {
  cell: CellCtx;
  /** A clone of origin on main, which pushes what lands on main. */
  pusher: string;
  fetchLog: string;
  labels: Map<string, string>;
  moves: Moves;
  agent: Agent;
  /** The item's id in the poller harness, for the @db scenario. */
  itemId?: string;
};

function ctx(world: object): Ctx {
  const w = world as { pbi331?: Ctx };
  assert.ok(w.pbi331, "no claim was set up");
  return w.pbi331;
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const isAncestor = (cwd: string, a: string, b: string) => {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", a, b], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

function write(dir: string, path: string, text: string): void {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), text);
}

function commit(dir: string, files: Record<string, string>, msg: string): string {
  for (const [p, t] of Object.entries(files)) write(dir, p, t);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", msg);
  return git(dir, "rev-parse", "HEAD");
}

/** Counts every fetch from `dir`'s origin in `log`. */
function countFetches(dir: string, log: string): void {
  git(dir, "config", "remote.origin.uploadpack", `sh -c 'echo fetch >> "${log}"; exec git-upload-pack "$@"' upload-pack`);
}

/** A claim at `stage` of an item whose branch conflicts with b4se001 on main in src/app.ts. */
function claimed(world: object, stage: string): Ctx {
  const cell = setUp(world, stage, true);
  // The branch's own work, pushed before the claim.
  commit(cell.dir, { "src/app.ts": "export const side = 'branch';\n", "src/other.ts": "export const other = 'branch';\n" }, "the branch's work");
  git(cell.dir, "push", "-q", "origin", `HEAD:refs/heads/${BRANCH}`);
  cell.startHead = git(cell.dir, "rev-parse", "HEAD");
  // main moves to b4se001, which conflicts with the branch in src/app.ts.
  const pusher = join(cell.root, "pusher");
  git(cell.root, "clone", "-q", "-b", "main", cell.origin, pusher);
  git(pusher, "config", "user.email", "someone@example.com");
  git(pusher, "config", "user.name", "someone");
  const b1 = commit(pusher, { "src/app.ts": "export const side = 'base';\n" }, "b4se001");
  git(pusher, "push", "-q", "origin", "main");
  assertConflicts(cell.root, cell.origin, b1);
  const fetchLog = join(cell.root, "fetches.log");
  countFetches(cell.dir, fetchLog);
  cell.prNumber = stage === "address" ? PR : null;
  cell.repoHost = {
    async openOrUpdatePr(p: { body: string }) { cell.prBodies.push(p.body); return { number: PR, url: `https://github.com/acme/app/pull/${PR}` }; },
    async requestReviewers() { return []; },
    async openReviewComments() { return []; },
    async prState() { return { open: true, merged: false, mergeSha: null, mergeable: true, lastChangesRequestedAt: null }; },
  };
  const m: Ctx = { cell, pusher, fetchLog, labels: new Map([["b4se001", b1]]), moves: "none", agent: "resolves" };
  (world as { pbi331?: Ctx }).pbi331 = m;
  cell.agent = async (a, base) => {
    if (cell.stage === "merge") {
      land(m);
      act(m, a.cwd);
    }
    return base(a);
  };
  return m;
}

/**
 * The background's premise: the pushed branch doesn't hold b4se001 and conflicts with it in src/app.ts, and only
 * there, so the claim's merge needs the `merge` agent pass.
 */
function assertConflicts(root: string, origin: string, b1: string): void {
  assert.ok(!isAncestor(origin, b1, BRANCH), "the branch already holds b4se001");
  const r = spawnSync("git", ["--git-dir", origin, "merge-tree", "--write-tree", "--name-only", "--no-messages", BRANCH, b1], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 1, `the branch doesn't conflict with b4se001 (merge-tree exited ${r.status}: ${r.stderr})`);
  // The first line is the merged tree; the rest are the conflicted paths.
  const paths = r.stdout.split("\n").slice(1).filter(Boolean);
  assert.deepEqual(paths, ["src/app.ts"], `the branch conflicts with b4se001 in ${JSON.stringify(paths)}`);
}

/** What lands on main while the merge agent works. */
function land(m: Ctx): void {
  const files: Record<string, string> = {
    none: {},
    conflicting: { "src/app.ts": "export const side = 'base, moved on';\n" },
    docs: { "docs/notes.md": "Notes.\n" },
    both: { "src/app.ts": "export const side = 'base, moved on';\n", "src/other.ts": "export const other = 'base';\n" },
  }[m.moves];
  if (!Object.keys(files).length || m.labels.has("b4se002")) return;
  m.labels.set("b4se002", commit(m.pusher, files, "b4se002"));
  git(m.pusher, "push", "-q", "origin", "main");
}

function act(m: Ctx, dir: string): void {
  if (m.agent === "resolves") {
    write(dir, "src/app.ts", "export const side = 'branch and base';\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "--no-edit");
  } else if (m.agent === "aborts") {
    git(dir, "merge", "--abort");
    commit(dir, { "NOTES.md": "Left main unmerged.\n" }, "skip the merge");
  }
  // "markers": the agent leaves the conflicted files as git wrote them.
}

function sha(m: Ctx, label: string): string {
  const s = m.labels.get(label);
  assert.ok(s, `no commit "${label}" landed on main`);
  return s;
}

function settled(c: CellCtx): void {
  assert.equal(c.error, null, `the cell failed: ${c.error instanceof Error ? c.error.stack : String(c.error)}`);
}

function pushed(m: Ctx): string {
  return git(m.cell.root, "--git-dir", m.cell.origin, "rev-parse", BRANCH);
}

function transitions(c: CellCtx): Record<string, any>[] {
  settled(c);
  return c.calls.filter((x) => x.route === "/transition").map((x) => x.body);
}

function fetches(m: Ctx): number {
  return existsSync(m.fetchLog) ? readFileSync(m.fetchLog, "utf8").split("\n").filter(Boolean).length : 0;
}

// ---- the claim ----

Given("an item is claimed at the green stage", function () {
  claimed(this, "green");
});

Given("an item is claimed at the address stage with PR {int} open", function (n: number) {
  assert.equal(n, PR);
  claimed(this, "address");
});

Given("while the merge agent works, commit {string} lands on {string} and changes {string} so it conflicts with the agent's resolution", function (label: string, base: string, path: string) {
  assert.deepEqual([label, base, path], ["b4se002", "main", "src/app.ts"]);
  ctx(this).moves = "conflicting";
});

Given("while the merge agent works, commit {string} lands on {string} and changes only {string}", function (label: string, base: string, path: string) {
  assert.deepEqual([label, base, path], ["b4se002", "main", "docs/notes.md"]);
  ctx(this).moves = "docs";
});

Given("while the merge agent works, commit {string} lands on {string} and changes {string} and {string} so both conflict with the branch", function (label: string, base: string, a: string, b: string) {
  assert.deepEqual([label, base, a, b], ["b4se002", "main", "src/app.ts", "src/other.ts"]);
  ctx(this).moves = "both";
});

Given("nothing lands on {string} while the merge agent works", function (base: string) {
  assert.equal(base, "main");
  ctx(this).moves = "none";
});

Given("the merge agent resolves the conflict in {string} and commits the merge", function (path: string) {
  assert.equal(path, "src/app.ts");
  ctx(this).agent = "resolves";
});

Given("the merge agent leaves conflict markers in {string}", function (path: string) {
  assert.equal(path, "src/app.ts");
  ctx(this).agent = "markers";
});

Given("the merge agent aborts the merge and commits without merging {string}", function (base: string) {
  assert.equal(base, "main");
  ctx(this).agent = "aborts";
});

Given("the green, refactor and open-pr stages pass", function () {
  // PBI 18's default agent passes each of them, and its fake CI passes every head.
  assert.equal(ctx(this).cell.checks, undefined);
});

When("the cell runs the claim", { timeout: 120_000 }, async function () {
  const m = ctx(this);
  writeFileSync(m.fetchLog, "");
  await runTheCell(this);
});

// ---- what the claim did ----

Then("the item is not blocked", function () {
  const blocked = transitions(ctx(this).cell).filter((t) => t.event === "blocked");
  assert.deepEqual(blocked.map((t) => t.question?.body), [], "the item was blocked");
});

Then("the {string} attempt ends as passed", function (stage: string) {
  const c = ctx(this).cell;
  settled(c);
  const ends = c.calls.filter((x) => x.route === "/stage" && x.body.stageId === stage && x.body.status !== "started").map((x) => x.body.status);
  assert.ok(ends.length > 0, `no "${stage}" attempt ended`);
  assert.equal(ends.at(-1), "passed", `the "${stage}" attempt ended ${ends.at(-1)}`);
});

Then("the run goes on to the green stage", function () {
  const c = ctx(this).cell;
  settled(c);
  const starts = c.calls.filter((x) => x.route === "/stage" && x.body.status === "started").map((x) => x.body.stageId as string);
  const merge = starts.indexOf("merge");
  assert.ok(merge >= 0, `no merge attempt ran; the stages were ${JSON.stringify(starts)}`);
  assert.ok(starts.indexOf("green", merge) > merge, `the green stage didn't start after the merge; the stages were ${JSON.stringify(starts)}`);
});

Then("the branch holds commit {string} of {string}", function (label: string, base: string) {
  assert.equal(base, "main");
  const m = ctx(this);
  settled(m.cell);
  const s = sha(m, label);
  assert.ok(isAncestor(m.cell.root, s, pushed(m)) || isAncestor(m.cell.dir, s, pushed(m)), `the pushed branch doesn't hold ${label} (${s.slice(0, 7)})`);
});

function doesntHold(world: object, label: string, base: string): void {
  assert.equal(base, "main");
  const m = ctx(world);
  settled(m.cell);
  const s = sha(m, label);
  const head = pushed(m);
  assert.ok(!isAncestor(m.cell.dir, s, head), `the pushed branch holds ${label} (${s.slice(0, 7)})`);
  assert.ok(!isAncestor(m.cell.dir, s, git(m.cell.dir, "rev-parse", "HEAD")), `the cell's checkout holds ${label} (${s.slice(0, 7)})`);
}

Then("the branch doesn't hold commit {string} of {string}", function (label: string, base: string) {
  doesntHold(this, label, base);
});

Then("the PR's branch doesn't hold commit {string} of {string}", function (label: string, base: string) {
  const c = ctx(this).cell;
  assert.ok(c.prBodies.length > 0, "no PR was opened");
  doesntHold(this, label, base);
});

Then("the cell fetched {string} only once during the claim", function (base: string) {
  assert.equal(base, "main");
  const m = ctx(this);
  settled(m.cell);
  assert.equal(fetches(m), 1, `the cell fetched ${fetches(m)} times`);
});

Then("the item is blocked with the reason {string}", function (reason: string) {
  const ts = transitions(ctx(this).cell);
  const last = ts.at(-1);
  assert.ok(last, "the cell sent no transition");
  assert.equal(last.event, "blocked", `the last transition was ${last.event}`);
  assert.equal(last.question?.body, reason);
});

Then("the conflict markers are not committed to the branch", function () {
  const m = ctx(this);
  settled(m.cell);
  const marked = /^(<{7}|={7}|>{7})( |$)/m;
  for (const ref of [pushed(m), git(m.cell.dir, "rev-parse", "HEAD")]) {
    const files = git(m.cell.dir, "ls-tree", "-r", "--name-only", ref).split("\n").filter(Boolean);
    for (const f of files) assert.doesNotMatch(git(m.cell.dir, "show", `${ref}:${f}`), marked, `${f} at ${ref.slice(0, 7)} holds conflict markers`);
  }
});

Then("the item moves to {string} with its PR open", function (state: string) {
  const c = ctx(this).cell;
  const last = transitions(c).at(-1);
  assert.ok(last, "the cell sent no transition");
  assert.equal(next("InProgress", last.event as ItemEvent), state, `the last transition was ${last.event}`);
  assert.equal(last.event, "pr_opened");
  assert.ok(c.prBodies.length > 0, "no PR was opened");
});

// ---- the @db scenario: the poller and the next claim ----

Given("an item's claim fetched {string} at {string}, and commit {string} landed on {string} while its merge agent worked", { timeout: 120_000 }, async function (base: string, b1: string, b2: string, base2: string) {
  assert.deepEqual([base, b1, b2, base2], ["main", "b4se001", "b4se002", "main"]);
  const m = claimed(this, "green");
  m.moves = "conflicting";
  m.agent = "resolves";
  writeFileSync(m.fetchLog, "");
  await runTheCell(this);
});

Given("that claim's run opened PR {int} and the item moved to {string}", long, async function (n: number, _state: string) {
  assert.equal(n, PR);
  const m = ctx(this);
  const c = pollCtx(this);
  assert.ok(await setup(c), "the poller's fakes or database aren't available");
  const pool = need().pool;
  await pool.query("insert into repo (host_adapter, url) values ('fake', $1) on conflict do nothing", [`https://github.com/${REPO}`]);
  const ext = await c.fake!.seed({ labels: ["factory"], repo: REPO });
  c.host!.prs.push({
    number: n, repo: REPO, branch: BRANCH, base: "main", title: `Item ${ext}`, body: "", headSha: pushed(m), open: true, merged: false,
    mergeSha: null, mergeable: true, reviewers: [], comments: [], reviews: [], mergeState: "unknown", refusals: [],
  });
  // The item stands where the claim's last transition left it.
  const last = m.cell.calls.filter((x) => x.route === "/transition").at(-1)?.body;
  const state: ItemState = last ? next("InProgress", last.event as ItemEvent) ?? "InProgress" : "InProgress";
  const item = await pool.query<{ id: string }>(
    "insert into item (source_id, external_id, title, state, repo) values ($1, $2, 'test item', $3, $4) returning id",
    [c.sourceId, ext, state, REPO],
  );
  const repoId = (await pool.query<{ id: string }>("select id from repo where url = $1", [`https://github.com/${REPO}`])).rows[0]?.id ?? null;
  await pool.query(
    `insert into run (item_id, run_number, next_stage, branch, pr_number, pr_url, reviews_seen_at, repo_id)
     values ($1, 1, 'pr-review', $2, $3, $4, now() - interval '1 hour', $5)`,
    [item.rows[0].id, BRANCH, n, `https://github.com/${REPO}/pull/${n}`, repoId],
  );
  if (last?.question) {
    await pool.query("insert into question (item_id, kind, body, asked_at) values ($1, $2, $3, now())", [item.rows[0].id, last.question.kind, last.question.body]);
  }
  c.extIds = [ext];
  c.pr = n;
  m.itemId = item.rows[0].id;
});

When("the item is claimed again and its merge agent resolves the conflict in {string}", { timeout: 120_000 }, async function (path: string) {
  assert.equal(path, "src/app.ts");
  const m = ctx(this);
  const cell = m.cell;
  const stage = (await need().pool.query<{ next_stage: string }>("select next_stage from run where item_id = $1 and ended_at is null", [m.itemId])).rows[0]?.next_stage;
  assert.ok(stage, "the item has no open run");
  // A new claim clones the branch as the last claim pushed it.
  const dir = join(cell.root, "work-2");
  git(cell.root, "clone", "-q", "-b", BRANCH, cell.origin, dir);
  git(dir, "config", "user.email", "cell@example.com");
  git(dir, "config", "user.name", "cell");
  countFetches(dir, m.fetchLog);
  Object.assign(cell, { dir, nextStage: stage, prNumber: PR, calls: [], agentCalls: [], prBodies: [], result: null, error: null, startHead: git(dir, "rev-parse", "HEAD") });
  m.moves = "none";
  m.agent = "resolves";
  writeFileSync(m.fetchLog, "");
  await runTheCell(this);
});
