// Step definitions for features/pbi-260-retry-after-base-goes-green.feature.
//
// Every scenario runs on PBI 4's test database with PBI 12's poller harness: a fake board, a fake repo host holding the
// repo "octo/repo", and the real pollOnce. Its "the poller runs once", PBI 142's "the poller runs twice", PBI 12's "the
// item's run resumes from" and PBI 168's "the factory holds item ... in state" read the same context. "The scheduler
// runs once" is one real scheduler tick on the same database, with a launcher that only records the cells it starts.
//
// The contract these steps set up, which the poller reads:
// - An item waiting on a base failure is a NeedsInput item whose open needs_input question carries, beside its body,
//   `base_failure = { sha, tests, base }`: the base commit the cell failed on, the tests that failed there, and the
//   name of the base branch, as PBI 215's cell asks it with the run's base added.
// - The commits of a base branch are the fake repo host's `branches` entry for `octo/repo@<base>`, oldest first, so
//   "b4se002 comes after b4se001" means it stands later in that list. What CI says of a commit is its `checks` entry
//   for `octo/repo@<sha>`: success, failure or pending.
// - The factory's answer leaves `answered_by` null, since no person gave it. Its text names the commit CI passed on and
//   says CI passed on it. The re-queue is logged as one event of kind REQUEUED, by the system, on the item, with
//   `payload.sha` the commit CI passed on. The activity log lists it as a row naming the item and that kind.
// - An operator's Hold and release are the dashboard's hold and unhold overrides, which the next scheduler tick
//   applies. Each step ticks once after it, as the scheduler would within 15 seconds.
//
// Each item is put in NeedsInput directly, then polled once, as the factory has been polling all along, so a scenario
// that asks for the item's state without a poll of its own still reads one that ran.
//
// The @ac-3 scenarios also put a cell behind the item, PBI 18's engine harness through PBI 215's `prepare`: a real git
// repo whose `main` starts at the commit the cell failed on, b4se001, and then gains b4se002. When the scheduler's
// claim starts a cell for the item, the harness runs the engine from the stage the claim resumes at.
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { tick } from "../../src/scheduler/scheduler.ts";
import { nextUp } from "../../src/store/items.ts";
import { setOverride } from "../../src/store/overrides.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";
import { ctx as pollCtx, poll, polled, REPO, setup, type Ctx as PollCtx } from "./pbi-12.steps.ts";
import { runTheCell, type Ctx as CellCtx } from "./pbi-18.steps.ts";
import { ctx as dashCtx, get, text } from "./pbi-175.steps.ts";
import { db as baseFailDb, prepare } from "./pbi-215.steps.ts";

/** The kind of the event that logs a re-queue after CI passed on the base. */
const REQUEUED = "requeued_after_base_passed";
const BRANCH = "factory/pbi-482-r1";
/** The commits of main, oldest first, as the feature's background gives them. */
const MAIN = ["b4se000", "b4se001", "b4se002"];

type Ctx = {
  /** Each item's id and the id of the question it waits on, by item number. */
  items: Map<number, { id: string; question: string }>;
  /** The item the last "item N's question" step named, which "the answer" means. */
  lastAsked?: number;
  operator?: string;
  /** The cells each scheduler tick started, by the env the launcher got. */
  started: Record<string, string>[];
  /** Whether "the scheduler claims the item and its cell runs" got a cell to run. */
  cellRan?: boolean;
  /** The cell harness's real commits, by the feature's names for them. */
  shas: Map<string, string>;
  npmLog?: string;
};

function ctx(world: object): Ctx {
  const w = world as { pbi260?: Ctx };
  w.pbi260 ??= { items: new Map(), started: [], shas: new Map() };
  return w.pbi260;
}

const pool = () => need().pool;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const isAncestor = (cwd: string, a: string, b: string) => {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", a, b], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

Before({ tags: "@pbi-260 and @db", ...long }, async function () {
  const d = await testDb();
  if (!d) return;
  await d.pool.query('truncate item, event, backlog_source, repo, "user", override cascade');
  await d.pool.query("update wip_policy set mode = 'fixed', current_wip = 2, review_capacity = 3, usage_paused_until = null");
});

After({ tags: "@pbi-260", ...long }, async function () {
  // PBI 175's dashboard and PBI 105's activity log close their servers only in their own scenarios.
  for (const key of ["pbi175", "pbi105"] as const) {
    const s = (this as Record<string, { server?: Server; close?: () => Promise<void> } | undefined>)[key];
    if (!s) continue;
    await s.close?.();
    if (s.server) {
      s.server.closeAllConnections();
      await new Promise<void>((resolve) => s.server!.close(() => resolve()));
    }
  }
});

// ---- the poller's world ----

async function harness(world: object): Promise<PollCtx> {
  const c = pollCtx(world);
  assert.ok(await setup(c), "the poller's fakes or database aren't available");
  if (!c.host!.branches.has(`${REPO}@main`)) c.host!.branches.set(`${REPO}@main`, [...MAIN]);
  return c;
}

/** Puts a commit on the base branch, after every commit already there, unless it's there already. */
function onBase(c: PollCtx, base: string, sha: string): void {
  const key = `${REPO}@${base}`;
  const list = c.host!.branches.get(key) ?? [];
  if (!list.includes(sha)) list.push(sha);
  c.host!.branches.set(key, list);
}

async function waits(world: object, n: number, base: string, body: string, baseFailure: { sha: string; tests: string[]; base: string } | null): Promise<void> {
  const c = await harness(world);
  const m = ctx(world);
  const ext = String(n);
  await c.fake!.seed({ externalId: ext, title: `Item ${n}`, labels: ["factory"], repo: REPO });
  const id = (await pool().query<{ id: string }>(
    "insert into item (source_id, external_id, title, state, repo) values ($1, $2, $3, 'NeedsInput', $4) returning id",
    [c.sourceId, ext, `Item ${n}`, REPO],
  )).rows[0].id;
  await pool().query("insert into run (item_id, run_number, next_stage, branch) values ($1, 1, 'green', $2)", [id, `factory/pbi-${n}-r1`]);
  const question = (await pool().query<{ id: string }>(
    "insert into question (item_id, kind, body, asked_at, base_failure) values ($1, 'needs_input', $2, now() - interval '30 minutes', $3) returning id",
    [id, body, baseFailure ? JSON.stringify(baseFailure) : null],
  )).rows[0].id;
  if (baseFailure) onBase(c, base, baseFailure.sha);
  c.extIds.push(ext);
  m.items.set(n, { id, question });
  // PBI 215's "the owner answers item N's question" finds the item here, and its Floor reads this source.
  baseFailDb(world).items.set(n, id);
  dashCtx(world).sourceId ??= c.sourceId;
  // The factory has been polling all along, so the item has seen a poll before the scenario's own.
  await poll(c);
  polled(c);
}

Given(
  "item {int} on base {string} waits in NeedsInput on a question saying the base fails in the cell at commit {string}",
  long,
  async function (n: number, base: string, sha: string) {
    const body = `The base fails in the cell. The Definition of Done line "Unit tests pass." fails on the base commit ${sha}, origin/${base}, `
      + `as it does on this item's branch, so the item isn't at fault. Failing tests:\n- parses the config`;
    await waits(this, n, base, body, { sha, tests: ["parses the config"], base });
  },
);

Given("item {int} on base {string} waits in NeedsInput on a question {string}", long, async function (n: number, base: string, body: string) {
  await waits(this, n, base, body, null);
});

/** The item the scenario set up last, which "the item" means. */
function theItem(world: object): { n: number; id: string } {
  const all = [...ctx(world).items.entries()];
  assert.ok(all.length > 0, "no item was set up");
  const [n, { id }] = all.at(-1)!;
  return { n, id };
}

Given(/^the item stopped at the (green|address) stage$/, long, async function (stage: string) {
  const c = pollCtx(this);
  const { n, id } = theItem(this);
  let pr: number | null = null;
  if (stage === "address") {
    // An item stopped at address has its PR open.
    pr = c.host!.prs.length + 1;
    c.host!.prs.push({
      number: pr, repo: REPO, branch: `factory/pbi-${n}-r1`, base: "main", title: "t", body: "b", headSha: null, open: true, merged: false,
      mergeSha: null, mergeable: true, reviewers: [], comments: [], reviews: [],
    });
  }
  await pool().query(
    "update run set next_stage = $2, pr_number = $3, pr_url = $4 where item_id = $1 and ended_at is null",
    [id, stage, pr, pr ? `https://github.com/${REPO}/pull/${pr}` : null],
  );
  // The cell behind the item. Its main starts at the commit the cell failed on, then gains b4se002.
  prepare(this, stage, "main");
  const cell = cellOf(this);
  const m = ctx(this);
  m.shas.set("b4se001", git(cell.dir, "rev-parse", "origin/main"));
  const seed = join(cell.root, "seed");
  git(seed, "checkout", "-q", "main");
  writeFileSync(join(seed, "app.txt"), "base\n");
  git(seed, "commit", "-q", "-am", "b4se002: fix main");
  git(seed, "push", "-q", "origin", "main");
  m.shas.set("b4se002", git(seed, "rev-parse", "HEAD"));
  git(cell.dir, "fetch", "-q", "origin");
});

function cellOf(world: object): CellCtx {
  const w = world as { pbi18?: CellCtx };
  assert.ok(w.pbi18, "no cell was set up behind the item");
  return w.pbi18;
}

function realSha(world: object, label: string): string {
  const s = ctx(world).shas.get(label);
  assert.ok(s, `the cell's repo has no commit "${label}"`);
  return s;
}

Given("the item's branch conflicts with commit {string}", function (label: string) {
  const cell = cellOf(this);
  realSha(this, label);
  writeFileSync(join(cell.dir, "app.txt"), "branch\n");
  git(cell.dir, "commit", "-q", "-am", "the item's own change to app.txt");
  git(cell.dir, "push", "-q", "origin", `HEAD:refs/heads/${BRANCH}`);
  // The merge agent resolves the conflict by keeping both sides.
  const before = cell.agent;
  cell.agent = async (a, base) => {
    if (cell.stage === "merge") writeFileSync(join(a.cwd, "app.txt"), "base and branch\n");
    return before ? before(a, base) : base(a);
  };
});

// A fake npm in place of PBI 215's: it fails each test the plan names unless the checkout's fixes.txt lists it, and
// logs each run with the commit it ran on.
function fixingNpm(planFile: string, logFile: string): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const cmd = ["npm", ...process.argv.slice(2)].join(" ");
let head = "";
try { head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch {}
const plan = JSON.parse(fs.readFileSync(${JSON.stringify(planFile)}, "utf8"));
const fixed = fs.existsSync("fixes.txt") ? fs.readFileSync("fixes.txt", "utf8").split("\\n").filter(Boolean) : [];
const fails = cmd === "npm test" ? plan.fails.filter((t) => !fixed.includes(t)) : [];
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ cmd, head, fails }) + "\\n");
console.log("TAP version 13");
fails.forEach((t, i) => console.log("not ok " + (i + 1) + " - " + t));
console.log("ok " + (fails.length + 1) + " - every other test");
console.log("1.." + (fails.length + 1));
process.exit(fails.length ? 1 : 0);
`;
}

Given("commit {string} of {string} fixes the test {string}", function (label: string, base: string, test: string) {
  assert.equal(base, "main", "the cell's repo has only main");
  const cell = cellOf(this);
  const m = ctx(this);
  realSha(this, label);
  // The commit that fixes main now also carries the fix.
  const seed = join(cell.root, "seed");
  writeFileSync(join(seed, "fixes.txt"), `${test}\n`);
  git(seed, "add", "fixes.txt");
  git(seed, "commit", "-q", "--amend", "--no-edit");
  git(seed, "push", "-q", "-f", "origin", "main");
  m.shas.set(label, git(seed, "rev-parse", "HEAD"));
  git(cell.dir, "fetch", "-q", "origin");
  const plan = join(cell.root, "pbi260-npm-plan.json");
  m.npmLog = join(cell.root, "pbi260-npm-log.jsonl");
  writeFileSync(plan, JSON.stringify({ fails: [test] }));
  const npm = join(cell.root, "bin", "npm");
  writeFileSync(npm, fixingNpm(plan, m.npmLog));
  chmodSync(npm, 0o755);
});

// ---- CI on the base ----

function ci(world: object, sha: string, base: string, status: "success" | "failure" | "pending"): void {
  const c = pollCtx(world);
  assert.ok(c.host, "the poller's fakes aren't set up");
  onBase(c, base, sha);
  c.host.checks.set(`${REPO}@${sha}`, status);
}

Given("CI passes on commit {string} of {string}", function (sha: string, base: string) {
  ci(this, sha, base, "success");
});

Given("CI is still running on commit {string} of {string}", function (sha: string, base: string) {
  ci(this, sha, base, "pending");
});

Given("CI fails on commit {string} of {string}", function (sha: string, base: string) {
  ci(this, sha, base, "failure");
});

When("CI passes on commit {string} of {string}, which comes after {string}", function (sha: string, base: string, after: string) {
  const list = pollCtx(this).host!.branches.get(`${REPO}@${base}`) ?? [];
  assert.ok(list.includes(after), `"${after}" isn't on ${base}`);
  assert.ok(!list.includes(sha), `"${sha}" is already on ${base}`);
  ci(this, sha, base, "success");
});

Given("the poller has run once", long, async function () {
  const c = pollCtx(this);
  await poll(c);
  polled(c);
});

// ---- the scheduler and the operator ----

async function schedulerTick(world: object): Promise<void> {
  const c = pollCtx(world);
  const m = ctx(world);
  m.started = [];
  const adapter = c.fake!.adapter;
  await tick({
    pool: pool(), now: new Date(), killFlag: false, repoHost: c.host!, backlogFor: () => adapter,
    secret: "pbi-260-secret", controlUrl: "http://control.test:7400", sopVersion: "default@1",
    launcher: { start: async (env) => (m.started.push(env), `exec-${m.started.length}`), stop: async () => {} },
  });
}

When("the scheduler runs once", long, async function () {
  await schedulerTick(this);
});

async function operator(world: object): Promise<string> {
  const m = ctx(world);
  m.operator ??= (await pool().query<{ id: string }>(
    `insert into "user" (provider, subject, github_login, role) values ('microsoft', 'pbi-260-operator', 'pbi-260-operator', 'operator') returning id`,
  )).rows[0].id;
  return m.operator;
}

async function override(world: object, n: number, kind: "hold" | "unhold"): Promise<void> {
  const item = ctx(world).items.get(n);
  assert.ok(item, `no item ${n} was set up`);
  await setOverride(pool(), { scope: "item", targetId: item.id, kind, reason: `scenario: ${kind}`, createdBy: await operator(world), expiresAt: null });
  // The next tick applies it, as it would within 15 seconds.
  await schedulerTick(world);
  const held = (await pool().query<{ held: boolean }>("select held from item where id = $1", [item.id])).rows[0].held;
  assert.equal(held, kind === "hold", `the ${kind} didn't take effect`);
}

Given("an operator has put item {int} on Hold", long, async function (n: number) {
  await override(this, n, "hold");
});

When("an operator releases item {int}", long, async function (n: number) {
  await override(this, n, "unhold");
});

When("the scheduler claims the item and its cell runs", { timeout: 300_000 }, async function () {
  const m = ctx(this);
  const { id } = theItem(this);
  await schedulerTick(this);
  const env = m.started.find((e) => e.ITEM_ID === id);
  m.cellRan = env !== undefined;
  if (!env) return;
  const cell = cellOf(this);
  cell.nextStage = env.RESUME_FROM;
  await runTheCell(this);
});

// ---- the questions ----

type QuestionRow = { answer: string | null; answered_by: string | null; closed_at: Date | null };

async function questionOf(world: object, n: number): Promise<QuestionRow> {
  polled(pollCtx(world));
  const item = ctx(world).items.get(n);
  assert.ok(item, `no item ${n} was set up`);
  ctx(world).lastAsked = n;
  return (await pool().query<QuestionRow>("select answer, answered_by, closed_at from question where id = $1", [item.question])).rows[0];
}

Then("item {int}'s question is answered", long, async function (n: number) {
  const q = await questionOf(this, n);
  assert.notEqual(q.answer, null, `item ${n}'s question has no answer`);
});

Then("item {int}'s question is still open", long, async function (n: number) {
  const q = await questionOf(this, n);
  assert.equal(q.answer, null, `item ${n}'s question was answered: ${q.answer}`);
  assert.equal(q.closed_at, null, `item ${n}'s question was closed`);
});

Then("item {int}'s question is answered by the factory", long, async function (n: number) {
  const q = await questionOf(this, n);
  assert.notEqual(q.answer, null, `item ${n}'s question has no answer`);
  assert.equal(q.answered_by, null, `item ${n}'s question was answered by user ${q.answered_by}`);
});

Then("item {int}'s question is answered exactly once", long, async function (n: number) {
  const q = await questionOf(this, n);
  assert.notEqual(q.answer, null, `item ${n}'s question has no answer`);
  const item = ctx(this).items.get(n)!;
  const r = await pool().query<{ answered: number; open: number }>(
    `select count(*) filter (where answer is not null)::int as answered, count(*) filter (where answer is null and closed_at is null)::int as open
     from question where item_id = $1`,
    [item.id],
  );
  assert.deepEqual(r.rows[0], { answered: 1, open: 0 }, `item ${n}'s questions: ${JSON.stringify(r.rows[0])}`);
});

Then("nobody answered item {int}'s question in person", long, async function (n: number) {
  const q = await questionOf(this, n);
  assert.notEqual(q.answer, null, `item ${n}'s question has no answer`);
  assert.equal(q.answered_by, null, `user ${q.answered_by} answered item ${n}'s question`);
  const human = await pool().query("select 1 from event where item_id = $1 and kind = 'decision' and actor = 'human'", [ctx(this).items.get(n)!.id]);
  assert.equal(human.rowCount, 0, "a person's decision was logged on the item");
});

async function theAnswer(world: object): Promise<string> {
  const m = ctx(world);
  const n = m.lastAsked ?? [...m.items.keys()][0];
  const q = await questionOf(world, n);
  assert.ok(q.answer, `item ${n}'s question has no answer`);
  return q.answer;
}

Then("the answer names the base commit {string}", long, async function (sha: string) {
  const a = await theAnswer(this);
  assert.ok(a.includes(sha), `the answer doesn't name ${sha}: ${a}`);
});

Then("the answer says CI passed on it", long, async function () {
  const a = await theAnswer(this);
  assert.match(a, /\bCI passed\b/i, `the answer doesn't say CI passed: ${a}`);
});

Then("the scheduler can claim item {int} and item {int} again", long, async function (a: number, b: number) {
  const ids = (await nextUp(pool(), 10)).map((r) => r.id);
  for (const n of [a, b]) assert.ok(ids.includes(ctx(this).items.get(n)!.id), `the scheduler can't claim item ${n}`);
});

// ---- the events ----

type EventRow = { actor: string; actor_id: string; payload: { sha?: string } };

async function requeues(world: object, n: number): Promise<EventRow[]> {
  polled(pollCtx(world));
  const item = ctx(world).items.get(n);
  assert.ok(item, `no item ${n} was set up`);
  return (await pool().query<EventRow>("select actor, actor_id, payload from event where item_id = $1 and kind = $2 order by at, id", [item.id, REQUEUED])).rows;
}

Then("item {int} has a system event recording its re-queue after CI passed on base commit {string}", long, async function (n: number, sha: string) {
  const found = (await requeues(this, n)).filter((e) => e.payload?.sha === sha);
  assert.equal(found.length, 1, `item ${n} has ${found.length} ${REQUEUED} events naming ${sha}`);
  assert.equal(found[0].actor, "system");
});

Then("the event's actor is the system, not a person", long, async function () {
  const m = ctx(this);
  const all = await requeues(this, [...m.items.keys()][0]);
  assert.ok(all.length > 0, `no ${REQUEUED} event was logged`);
  for (const e of all) assert.equal(e.actor, "system", `the event's actor is ${e.actor} ${e.actor_id}`);
});

Then("item {int} has exactly one system event recording a re-queue after the base passed", long, async function (n: number) {
  const all = await requeues(this, n);
  assert.equal(all.length, 1, `item ${n} has ${all.length} ${REQUEUED} events`);
  assert.equal(all[0].actor, "system");
});

Then("item {int} has no system event recording a re-queue after the base passed", long, async function (n: number) {
  const all = await requeues(this, n);
  assert.equal(all.length, 0, `item ${n} has ${all.length} ${REQUEUED} events`);
});

// ---- the dashboard ----

When("{string} opens the dashboard", long, async function (login: string) {
  await get(this, "/", login);
});

const namesItem = (t: string, n: number) => new RegExp(`(?<![\\w.])#?${n}(?!\\d)`).test(t);

Then("{string} on the dashboard doesn't list item {int}", function (section: string, n: number) {
  const c = dashCtx(this);
  assert.equal(c.status, 200, `the dashboard answered ${c.status}: ${String(c.page).slice(0, 300)}`);
  const page = c.page!;
  const start = page.indexOf(`<h2>${section}</h2>`);
  assert.ok(start >= 0, `the dashboard has no "${section}" section`);
  const end = page.indexOf("<h2>", start + 1);
  const part = text(page.slice(start, end < 0 ? undefined : end));
  assert.ok(!namesItem(part, n), `"${section}" lists item ${n}: ${part}`);
});

Then("the activity log lists item {int}'s re-queue after the base passed", function (n: number) {
  const c = (this as { pbi105?: { status?: number; page?: string } }).pbi105;
  assert.ok(c?.page !== undefined, "the activity log wasn't opened");
  assert.equal(c.status, 200, `the activity log answered ${c.status}`);
  const rows = [...c.page.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) => text(r[1])).filter((r) => namesItem(r, n));
  assert.ok(rows.some((r) => r.includes(REQUEUED)), `no row lists item ${n}'s re-queue (${REQUEUED}):\n${rows.join("\n")}`);
});

// ---- the cell that the claim started ----

function ranCell(world: object): CellCtx {
  assert.equal(ctx(world).cellRan, true, "the scheduler started no cell for the item");
  const cell = cellOf(world);
  assert.equal(cell.error, null, `the cell failed: ${cell.error instanceof Error ? cell.error.stack : String(cell.error)}`);
  return cell;
}

/** What each agent call saw, as PBI 215's prepare records it. */
function agentSeen(world: object): { stage: string; head: string; branch: string; judge: boolean }[] {
  return (world as { pbi215?: { agentSeen: { stage: string; head: string; branch: string; judge: boolean }[] } }).pbi215?.agentSeen ?? [];
}

function firstGreen(world: object) {
  const g = agentSeen(world).find((a) => a.stage === "green" && !a.judge);
  assert.ok(g, "the green stage never ran");
  return g;
}

Then("the cell merged commit {string} into the item's branch", function (label: string) {
  const cell = ranCell(this);
  const sha = realSha(this, label);
  assert.ok(isAncestor(cell.dir, sha, BRANCH), `the item's branch doesn't hold ${label} (${sha.slice(0, 7)})`);
});

Then("it merged before the green stage began", function () {
  const cell = ranCell(this);
  const g = firstGreen(this);
  assert.ok(isAncestor(cell.dir, realSha(this, "b4se002"), g.head), "the green stage began before the base was merged");
});

Then("the cell resolved the conflict before the green stage began", function () {
  const cell = ranCell(this);
  const starts = cell.calls.filter((x) => x.route === "/stage" && x.body.status === "started").map((x) => x.body.stageId as string);
  const merge = starts.indexOf("merge");
  const green = starts.indexOf("green");
  assert.ok(merge >= 0, `no merge attempt ran; the stages were ${JSON.stringify(starts)}`);
  assert.ok(green > merge, `the green stage didn't begin after the merge; the stages were ${JSON.stringify(starts)}`);
  const g = firstGreen(this);
  assert.ok(isAncestor(cell.dir, realSha(this, "b4se002"), g.head), "the green stage began on a branch without the base");
  assert.doesNotMatch(git(cell.dir, "show", `${g.head}:app.txt`), /^(<{7}|>{7}|={7})/m, "the green stage began with conflict markers in app.txt");
});

Then("the item's branch holds commit {string}", function (label: string) {
  const cell = ranCell(this);
  const sha = realSha(this, label);
  const pushed = git(cell.root, "--git-dir", cell.origin, "rev-parse", BRANCH);
  assert.ok(isAncestor(cell.dir, sha, pushed), `the pushed branch doesn't hold ${label} (${sha.slice(0, 7)})`);
});

Then("the green stage runs on the merged branch", function () {
  const cell = ranCell(this);
  const g = firstGreen(this);
  assert.equal(g.branch, BRANCH, `the green stage ran on ${g.branch}`);
  assert.ok(isAncestor(cell.dir, realSha(this, "b4se002"), g.head), "the green stage ran on a branch without the base");
});

Then("the owner is asked no question about the conflict", function () {
  const cell = ranCell(this);
  const asked = cell.calls.filter((x) => x.route === "/transition" && x.body.question).map((x) => String(x.body.question.body ?? ""));
  assert.ok(!asked.some((q) => /conflict/i.test(q)), `the owner was asked about the conflict: ${JSON.stringify(asked)}`);
});

Then("{string} passes on the item's branch", function (cmd: string) {
  const cell = ranCell(this);
  const log = ctx(this).npmLog;
  assert.ok(log, "no command was faked");
  const runs = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { cmd: string; head: string; fails: string[] }) : [];
  const onBranch = runs.filter((r) => r.cmd === cmd && r.head !== realSha(this, "b4se002") && isAncestor(cell.dir, r.head, BRANCH));
  assert.ok(onBranch.length > 0, `"${cmd}" never ran on the item's branch`);
  assert.deepEqual(onBranch.at(-1)!.fails, [], `"${cmd}" failed on the item's branch`);
});
