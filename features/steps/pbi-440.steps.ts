// Step definitions for features/pbi-440-requeue-merged-failed-item-to-accepted.feature.
//
// The scenarios reuse PBI 12's poller harness (its fake board and repo host), PBI 369's steps and context for the repo,
// the clock, re-checks, "main gains commit", "item <n>'s PR <pr> merged" and the history's chain of moves, PBI 255's for
// a commit's first parent, CI's checks and "item <n> waits on", PBI 168's "the factory holds item <n> in state" and
// PBI 89's "the scheduler ticks once" and "an operator is signed in". Each item is held in PBI 369's context and PBI
// 255's, and on PBI 12's list of external ids, so their steps find it. PBI 168's step holds its item in PBI 369's repo.
//
// Item 482 is on the board and in the factory's item table, in "acme/widgets". Its run 1 is on "factory/pbi-482-r1"
// with PR 57, unless "item 482 has no PR", and the run's locked_files are the feature files it added or changed:
// "features/pbi-482-orders.feature" and "features/pbi-301-carts.feature", which its merge commit holds. Item 212's run
// is PBI 369's run 1, and "item 212's run added the feature file" sets its locked_files.
//
// A stage that "used up its retries" has every attempt the SOP gives it, its retries and one more, failed in one claim,
// so none carries a retry over (stage_run.retry_carry is null). A stage the SOP doesn't list gets no retries. The item
// went to Failed through retries_exhausted from InProgress, with the attempts on the move's payload as the cell API
// writes them, or through dod_failed from Accepted, with the comment the factory leaves then. A merge "the factory
// recorded" is run.merge_sha and the poller's InReview to Accepted move. One the factory hasn't recorded is only on the
// fake repo host: the PR merged, and its merge commit on main.
//
// A re-queue is the operator's requeue override, which the next scheduler tick applies. "The scheduler ticks once" is
// PBI 89's step, run here with no WIP slot so it starts no cell; "ticks 3 times" keeps whatever WIP the scenario left,
// and records every cell the launcher started. A cell started for an item is one the launcher started for any of its
// runs, or a move of the item to InProgress since the Givens. A move "made by the re-queue" is one whose event is the
// re-queue's: "requeued", or another event whose name starts with "requeue".
//
// "The poller runs" is PBI 12's poll, then the scheduler's CI check on merged items and its re-check of Failed items, as
// PBI 369's steps run them, at the time now; "every 10 minutes for 2 hours" runs it from now on, every 10 minutes. A
// commit on main is on the fake host's `branches` entry for "<repo>@main", oldest first, each one's first parent the one
// before it. A file on main at a commit is the fake host's file at "<repo>@<sha>:<path>". A commit that deletes a file,
// or brings one back, has its parent's feature files but for that one, or with it again. A main commit's CI is its check
// runs for test, bdd, lint and build, as PBI 255's "every check".
//
// The item page is the control plane's /items/<id>, PBI 89's, opened by the operator PBI 89's step signed in. It says
// the item's feature files are no longer on main when its text says, in one sentence, "feature file(s)" and that they
// are "no longer on", "not on", "aren't on", "are missing from" or "gone from" main.
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import YAML from "yaml";
import type { CheckRun } from "../../src/adapters/types.ts";
import { fakeLauncher } from "../../src/scheduler/launcher.ts";
import { pollMergedCi, recheckFailed, tick } from "../../src/scheduler/scheduler.ts";
import { setOverride } from "../../src/store/overrides.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";
import { ctx as pollCtx, poll, polled, setup, type Ctx as PollCtx } from "./pbi-12.steps.ts";
import { escapeRe, text } from "./pbi-175.steps.ts";
import { ctx as ctx255 } from "./pbi-255.steps.ts";
import { ctx as ctx369, type Held } from "./pbi-369.steps.ts";
import { CELL_SECRET, ctx as p89, headers, startControlPlane } from "./pbi-89.steps.ts";

const MAIN = "main";
const LABEL = "factory";
const CONFIG = ".factory/config.yml";
const BASE_CONFIG = "bdd:\n  parse: npm run bdd -- --dry-run\n  run: npm run bdd\n  report: reports/bdd.ndjson\ncommands:\n  test: npm test\n  lint: npm run lint\n";
const FEATURES = ["features/pbi-482-orders.feature", "features/pbi-301-carts.feature"];
const EVERY_CHECK = ["test", "bdd", "lint", "build"];
const SOP = YAML.parse(readFileSync(new URL("../../sop/default.yml", import.meta.url), "utf8")) as { stages: { id: string; retries?: number }[] };

type Ctx = {
  /** Each cell the launcher started on the ticks this file ran, by the env it gave the cell. */
  started: Record<string, string>[];
  /** Each item's run, by the item's number. */
  runs: Map<number, string>;
  /** Item 482 has no PR. */
  noPr: boolean;
  /** The item page as the operator last opened it. */
  page?: { status: number; html: string };
};

function ctx(world: object): Ctx {
  const w = world as { pbi440?: Ctx };
  w.pbi440 ??= { started: [], runs: new Map(), noPr: false };
  return w.pbi440;
}

const pool = () => need().pool;

Before({ tags: "@pbi-440", ...long }, async function () {
  const d = await testDb();
  if (!d) return;
  await d.pool.query('truncate item, event, backlog_source, repo, "user", override cascade');
  await d.pool.query(
    `update wip_policy set mode = 'fixed', wip_min = 1, wip_max = 1, current_wip = 1, review_capacity = 3, usage_reserve_at = 0.7,
       usage_paused_until = null, daily_budget = null`,
  );
  const c = pollCtx(this);
  const shared = ctx369(this);
  ctx255(this).repo = shared.repo;
  c.holdRepo = () => shared.repo;
  c.onHold = async (ext, id) => {
    const n = Number(ext);
    await repoId(this);
    shared.items.set(n, { id, ext, repo: shared.repo, failedAt: new Date(), seenComments: (await c.fake!.comments(ext)).length });
    ctx255(this).items.set(n, id);
  };
  c.beforePoll = async () => writeConfig(c, this);
  c.afterPoll = async () => {
    const deps = { pool: pool(), repoHost: c.host!, backlogFor: () => c.fake!.adapter, now: shared.clock ?? new Date() };
    await pollMergedCi(deps);
    await recheckFailed(deps);
  };
  // PBI 89's "the scheduler ticks once": no WIP slot, so it starts no cell, and the tick counts as what the Thens follow.
  p89(this).runTick = async (once) => {
    await harness(this);
    await pool().query("update wip_policy set current_wip = 0");
    try {
      await once();
    } finally {
      await pool().query("update wip_policy set current_wip = 1");
    }
    c.ranOther ??= "the scheduler's tick";
  };
});

After({ tags: "@pbi-440", ...long }, async function () {
  const c = p89(this);
  await c.close?.();
  if (c.server) {
    c.server.closeAllConnections();
    await new Promise<void>((resolve) => c.server!.close(() => resolve()));
  }
});

// ---- the repo, its main branch and its config ----

async function repoId(world: object): Promise<string> {
  const shared = ctx369(world);
  let id = shared.repoIds.get(shared.repo);
  if (!id) {
    id = (await pool().query<{ id: string }>(
      "insert into repo (host_adapter, url) values ('fake', $1) on conflict (url) do update set url = excluded.url returning id", [`https://github.com/${shared.repo}`],
    )).rows[0].id;
    shared.repoIds.set(shared.repo, id);
  }
  return id;
}

/** PBI 12's harness, with PBI 89's tick reading the same fake board and repo host. */
async function harness(world: object): Promise<PollCtx> {
  const c = pollCtx(world);
  assert.ok(await setup(c), "the poller's fakes or database aren't available");
  const d = p89(world);
  if (!d.server) {
    d.host = c.host as never;
    d.fake = c.fake as never;
  }
  await repoId(world);
  return c;
}

function mainCommits(c: PollCtx, repo: string): string[] {
  const key = `${repo}@${MAIN}`;
  const list = c.host!.branches.get(key) ?? [];
  c.host!.branches.set(key, list);
  return list;
}

function writeConfig(c: PollCtx, world: object): void {
  if (!c.host) return;
  const shared = ctx369(world);
  const config = BASE_CONFIG + (shared.hours === undefined ? "" : `failed_recheck_hours: ${shared.hours}\n`);
  for (const repo of new Set([...shared.repoIds.keys(), ...[...shared.items.values()].map((i) => i.repo)])) {
    for (const ref of [...mainCommits(c, repo), MAIN]) c.host.files.set(`${repo}@${ref}:${CONFIG}`, config);
  }
}

Given("the repo's {string} has no `failed_recheck_hours` key", function (path: string) {
  assert.equal(path, CONFIG);
  assert.equal(ctx369(this).hours, undefined, "the scenario set `failed_recheck_hours`");
});

const fileKey = (repo: string, sha: string, path: string) => `${repo}@${sha}:${path}`;

/** The feature files on `sha` of the scenario's repo. */
function featureFiles(c: PollCtx, repo: string, sha: string): Map<string, string> {
  const prefix = `${repo}@${sha}:`;
  const out = new Map<string, string>();
  for (const [key, body] of c.host!.files) if (key.startsWith(prefix) && key.slice(prefix.length).startsWith("features/")) out.set(key.slice(prefix.length), body);
  return out;
}

/** Puts `sha` on main as its newest commit, its first parent main's head, with the head's feature files changed by `edit`. */
function gains(world: object, sha: string, contains: string, edit: (files: Map<string, string>) => void = () => {}): void {
  const c = pollCtx(world);
  const repo = ctx369(world).repo;
  const list = mainCommits(c, repo);
  assert.ok(list.includes(contains), `commit "${contains}" isn't on ${MAIN}`);
  const parent = list.at(-1)!;
  const files = featureFiles(c, repo, parent);
  edit(files);
  for (const [path, body] of files) c.host!.files.set(fileKey(repo, sha, path), body);
  c.host!.parents.set(`${repo}@${sha}`, parent);
  list.push(sha);
  c.host!.heads.set(repo, sha);
}

const featureText = (path: string) => `@${path.match(/pbi-\d+/)?.[0] ?? "pbi-0"}\nFeature: ${path}\n`;

Given("{string} gains commit {string}, which contains {string} and deletes {string}", function (branch: string, sha: string, merged: string, path: string) {
  assert.equal(branch, MAIN);
  gains(this, sha, merged, (files) => files.delete(path));
});

Given("{string} gains commit {string}, which contains {string} and reverts it, deleting {string}", function (branch: string, sha: string, merged: string, path: string) {
  assert.equal(branch, MAIN);
  gains(this, sha, merged, (files) => files.delete(path));
});

Given("{string} gains commit {string}, which contains {string} and brings back {string}", function (branch: string, sha: string, before: string, path: string) {
  assert.equal(branch, MAIN);
  gains(this, sha, before, (files) => files.set(path, featureText(path)));
});

Given("{string} is at commit {string}, which contains {string}", function (branch: string, sha: string, merged: string) {
  assert.equal(branch, MAIN);
  gains(this, sha, merged);
});

Given("commit {string} changes {string} for another item", function (sha: string, path: string) {
  const c = pollCtx(this);
  const repo = ctx369(this).repo;
  assert.ok(mainCommits(c, repo).includes(sha), `commit "${sha}" isn't on ${MAIN}`);
  c.host!.files.set(fileKey(repo, sha, path), `${featureText(path)}  # changed by item 999\n`);
});

function onMain(world: object, sha: string, paths: string[]): void {
  const c = pollCtx(world);
  const repo = ctx369(world).repo;
  assert.ok(mainCommits(c, repo).includes(sha), `commit "${sha}" isn't on ${MAIN}`);
  for (const path of paths) {
    const key = fileKey(repo, sha, path);
    if (!c.host!.files.has(key)) c.host!.files.set(key, featureText(path));
  }
}

Given("{string} and {string} are on {string} at commit {string}", function (a: string, b: string, branch: string, sha: string) {
  assert.equal(branch, MAIN);
  onMain(this, sha, [a, b]);
});

Given("{string} is on {string} at commit {string}", function (path: string, branch: string, sha: string) {
  assert.equal(branch, MAIN);
  onMain(this, sha, [path]);
});

Given("CI is still running on commit {string}", function (sha: string) {
  const c = pollCtx(this);
  const key = `${ctx369(this).repo}@${sha}`;
  c.host!.runs.set(key, EVERY_CHECK.map((name): CheckRun => ({ name, status: "pending", url: `https://github.com/${ctx369(this).repo}/runs/${sha}-${name}` })));
  c.host!.checks.set(key, "pending");
});

// ---- item 482 and its run ----

async function seedEvent(world: object, itemId: string, actorId: string, payload: object, at: Date): Promise<void> {
  const id = (await pool().query<{ id: string }>(
    "insert into event (actor, actor_id, item_id, kind, payload, at) values ('system', $1, $2, 'transition', $3, $4) returning id",
    [actorId, itemId, JSON.stringify(payload), at],
  )).rows[0].id;
  ctx369(world).seeded.add(id);
}

/** Item 482, in `state` when the scenario first names it, with its run 1 on "factory/pbi-482-r1". */
async function item482(world: object, state = "InProgress"): Promise<{ c: PollCtx; held: Held; runId: string }> {
  const c = await harness(world);
  const shared = ctx369(world);
  const mine = ctx(world);
  const n = 482;
  let held = shared.items.get(n);
  if (!held) {
    const ext = String(n);
    const title = `Item ${n}`;
    await c.fake!.seed({ externalId: ext, title, labels: [LABEL], repo: shared.repo, rank: n });
    const id = (await pool().query<{ id: string }>(
      "insert into item (source_id, external_id, title, state, repo) values ($1, $2, $3, $4, $5) returning id",
      [c.sourceId, ext, title, state, shared.repo],
    )).rows[0].id;
    held = { id, ext, repo: shared.repo, failedAt: new Date(), seenComments: 0 };
    shared.items.set(n, held);
    ctx255(world).items.set(n, id);
    if (!c.extIds.includes(ext)) c.extIds.push(ext);
    const branch = `factory/pbi-${n}-r1`;
    const pr = mine.noPr ? null : 57;
    const runId = (await pool().query<{ id: string }>(
      `insert into run (item_id, repo_id, run_number, next_stage, branch, pr_number, pr_url, locked_files, config_sha)
       values ($1, $2, 1, $3, $4, $5, $6, $7, 'c1') returning id`,
      [id, await repoId(world), pr === null ? "green" : "address", branch, pr, pr === null ? null : `https://github.com/${shared.repo}/pull/${pr}`, FEATURES],
    )).rows[0].id;
    mine.runs.set(n, runId);
  }
  return { c, held, runId: mine.runs.get(n)! };
}

function hostPr(c: PollCtx, repo: string, n: number) {
  let pr = c.host!.prs.find((p) => p.repo === repo && p.number === 57);
  if (!pr) {
    pr = {
      number: 57, repo, branch: `factory/pbi-${n}-r1`, base: MAIN, title: `Item ${n}`, body: "b", headSha: `head-${n}`, open: true, merged: false,
      mergeSha: null, mergeable: true, reviewers: [], comments: [], reviews: [],
    };
    c.host!.prs.push(pr);
  }
  return pr;
}

/** PR 57 merged on GitHub as `sha`, the commit on main holding the run's feature files. */
function mergeOnHost(c: PollCtx, held: Held, sha: string): void {
  Object.assign(hostPr(c, held.repo, 482), { open: false, merged: true, mergeSha: sha });
  const list = mainCommits(c, held.repo);
  if (!list.includes(sha)) {
    if (list.length) c.host!.parents.set(`${held.repo}@${sha}`, list.at(-1)!);
    list.push(sha);
  }
  c.host!.heads.set(held.repo, list.at(-1)!);
  for (const path of FEATURES) c.host!.files.set(fileKey(held.repo, sha, path), featureText(path));
}

Given("item {int} has no PR", long, async function (n: number) {
  assert.equal(n, 482);
  ctx(this).noPr = true;
  await item482(this);
});

Given("item {int}'s PR {int} is open and not merged", long, async function (n: number, pr: number) {
  assert.equal(n, 482);
  assert.equal(pr, 57);
  const { c, held } = await item482(this);
  Object.assign(hostPr(c, held.repo, n), { open: true, merged: false, mergeSha: null });
});

Given("item {int}'s PR {int} merged into {string} as commit {string}, and the factory recorded the merge", long, async function (n: number, pr: number, branch: string, sha: string) {
  assert.equal(n, 482);
  assert.equal(pr, 57);
  assert.equal(branch, MAIN);
  const { c, held, runId } = await item482(this, "Accepted");
  mergeOnHost(c, held, sha);
  await pool().query("update run set merge_sha = $2, next_stage = 'open-pr' where id = $1", [runId, sha]);
  await seedEvent(this, held.id, "poller", { from: "InReview", to: "Accepted", event: "merged" }, new Date(Date.now() - 2 * 60 * 60_000));
});

Given("then a person merged PR {int} into {string} as commit {string}, and the factory hasn't recorded the merge", long, async function (pr: number, branch: string, sha: string) {
  assert.equal(pr, 57);
  assert.equal(branch, MAIN);
  const { c, held, runId } = await item482(this);
  mergeOnHost(c, held, sha);
  const r = await pool().query<{ merge_sha: string | null }>("select merge_sha from run where id = $1", [runId]);
  assert.equal(r.rows[0].merge_sha, null, "the factory recorded the merge");
});

/** Item 482 goes to Failed through `ev` at `at`, as the cell API or the scheduler moves it. */
async function fail(world: object, ev: string, at: Date, stage?: string): Promise<void> {
  const { c, held, runId } = await item482(world, ev === "dod_failed" ? "Accepted" : "InProgress");
  let payload: Record<string, unknown>;
  if (ev === "retries_exhausted") {
    const s = stage ?? (await pool().query<{ next_stage: string }>("select next_stage from run where id = $1", [runId])).rows[0].next_stage;
    const tries = (SOP.stages.find((x) => x.id === s)?.retries ?? 0) + 1;
    for (let a = 1; a <= tries; a++) {
      const started = new Date(at.getTime() - (tries - a + 1) * 10 * 60_000);
      await pool().query(
        `insert into stage_run (run_id, stage_id, attempt, status, started_at, ended_at, message) values ($1, $2, $3, 'failed', $4, $5, $6)`,
        [runId, s, a, started, new Date(started.getTime() + 5 * 60_000), `attempt ${a} failed`],
      );
    }
    await pool().query("update run set next_stage = $2 where id = $1", [runId, s]);
    const attempts = (await pool().query("select stage_id, attempt, status from stage_run where run_id = $1 order by started_at, attempt", [runId])).rows;
    payload = { from: "InProgress", to: "Failed", event: ev, attempts };
    await seedEvent(world, held.id, runId, payload, at);
  } else {
    assert.equal(ev, "dod_failed", `no move to Failed with the event "${ev}"`);
    payload = { from: "Accepted", to: "Failed", event: ev };
    await seedEvent(world, held.id, "scheduler", payload, at);
    await c.fake!.adapter.comment(held.ext, `CI failed on ${MAIN} for the item's merge commit, so the item failed its Definition of Done.`, `dod-failed:482`);
  }
  await pool().query("update item set state = 'Failed' where id = $1", [held.id]);
  held.failedAt = at;
  held.seenComments = (await c.fake!.comments(held.ext)).length;
}

const utc = (t: string) => {
  assert.match(t, /^\d{4}-\d\d-\d\d \d\d:\d\d$/, `"${t}" isn't a time as "YYYY-MM-DD HH:MM"`);
  return new Date(`${t.replace(" ", "T")}:00Z`);
};

Given("item {int} went to Failed with the event {string}", long, async function (n: number, ev: string) {
  assert.equal(n, 482);
  await fail(this, ev, new Date(Date.now() - 60 * 60_000));
});

Given("item {int} went to Failed with the event {string} at {string} UTC", long, async function (n: number, ev: string, t: string) {
  assert.equal(n, 482);
  await fail(this, ev, utc(t));
});

Given("item {int} went to Failed with the event {string} after its stage {string} used up its retries", long, async function (n: number, ev: string, stage: string) {
  assert.equal(n, 482);
  assert.equal(ev, "retries_exhausted");
  await fail(this, ev, new Date(Date.now() - 60 * 60_000), stage);
});

Given("item {int} went to Failed with the event {string} while its PR {int} was open", long, async function (n: number, ev: string, pr: number) {
  assert.equal(n, 482);
  assert.equal(pr, 57);
  const { c, held } = await item482(this);
  Object.assign(hostPr(c, held.repo, n), { open: true, merged: false, mergeSha: null });
  await fail(this, ev, new Date(Date.now() - 60 * 60_000));
});

Given("item {int}'s run added the feature file {string}", long, async function (n: number, path: string) {
  const held = ctx369(this).items.get(n);
  assert.ok(held, `item ${n} isn't held`);
  const r = await pool().query("update run set locked_files = array_append(coalesce(locked_files, '{}'), $2) where item_id = $1 and run_number = 1", [held.id, path]);
  assert.equal(r.rowCount, 1, `item ${n} has no run 1`);
  // The run's merge commit holds the file it added.
  const sha = (await pool().query<{ merge_sha: string | null }>("select merge_sha from run where item_id = $1 and run_number = 1", [held.id])).rows[0].merge_sha;
  if (sha) pollCtx(this).host!.files.set(fileKey(held.repo, sha, path), featureText(path));
});

// ---- re-queues and ticks ----

async function operator(): Promise<string> {
  return (await pool().query<{ id: string }>(
    `insert into "user" (provider, subject, github_login, role) values ('microsoft', 'requeuer', 'requeuer', 'operator')
     on conflict (provider, subject) do update set role = excluded.role returning id`,
  )).rows[0].id;
}

async function requeue(world: object, n: number, reason: string): Promise<void> {
  await harness(world);
  const held = ctx369(world).items.get(n);
  assert.ok(held, `item ${n} isn't held`);
  await setOverride(pool(), { scope: "item", targetId: held.id, kind: "requeue", reason, createdBy: await operator(), expiresAt: null });
}

When("an operator re-queues item {int} with the reason {string}", long, async function (n: number, reason: string) {
  await requeue(this, n, reason);
});

Given("an operator re-queued item {int} and the scheduler ticked once", long, async function (n: number) {
  await requeue(this, n, "carry on with it");
  await p89(this).runTick!(() => tickOnce(this));
});

async function tickOnce(world: object): Promise<void> {
  const c = await harness(world);
  const launcher = fakeLauncher();
  try {
    await tick({ pool: pool(), launcher, now: new Date(), killFlag: false, repoHost: c.host!, backlogFor: () => c.fake!.adapter,
      secret: CELL_SECRET, controlUrl: "http://control.test", sopVersion: "0.1.0" });
  } finally {
    ctx(world).started.push(...launcher.started);
  }
}

Given("a WIP slot is free", long, async function () {
  await harness(this);
  await pool().query("update wip_policy set current_wip = 1");
  const r = await pool().query<{ n: number }>("select count(*)::int as n from item where state = 'InProgress'");
  assert.equal(r.rows[0].n, 0, "an item is already in progress");
});

When("the scheduler ticks {int} times", long, async function (times: number) {
  for (let i = 0; i < times; i++) await tickOnce(this);
  pollCtx(this).ranOther ??= "the scheduler's tick";
});

// ---- the poller ----

async function pollNow(world: object, at: Date): Promise<void> {
  const c = await harness(world);
  ctx369(world).clock = at;
  const before = c.polls;
  await poll(c);
  polled(c);
  assert.equal(c.polls, before + 1, "the poller didn't run");
}

When("the poller runs", long, async function () {
  await pollNow(this, new Date());
});

Given("the poller ran", long, async function () {
  await pollNow(this, new Date());
});

When("the poller runs every {int} minutes for {int} hours", long, async function (minutes: number, hours: number) {
  const start = Date.now();
  for (let at = start; at <= start + hours * 60 * 60_000; at += minutes * 60_000) await pollNow(this, new Date(at));
});

// ---- the item's runs and history ----

function itemId(world: object, n: number): string {
  const held = ctx369(world).items.get(n);
  assert.ok(held, `item ${n} isn't held`);
  return held.id;
}

type RunRow = { id: string; run_number: number; next_stage: string | null; branch: string | null; ended_at: Date | null; pr_number: number | null };

async function runsOf(world: object, n: number): Promise<RunRow[]> {
  polled(pollCtx(world));
  return (await pool().query<RunRow>(
    "select id, run_number, next_stage, branch, ended_at, pr_number from run where item_id = $1 order by run_number", [itemId(world, n)],
  )).rows;
}

const describeRuns = (runs: RunRow[]) => JSON.stringify(runs.map((r) => ({ run: r.run_number, next: r.next_stage, branch: r.branch, ended: r.ended_at !== null })));

Then("item {int} has no run {int}", long, async function (n: number, k: number) {
  const runs = await runsOf(this, n);
  assert.ok(!runs.some((r) => r.run_number === k), `item ${n}'s runs are ${describeRuns(runs)}`);
});

Then("item {int}'s run is still run {int}", long, async function (n: number, k: number) {
  const runs = await runsOf(this, n);
  const open = runs.filter((r) => r.ended_at === null);
  assert.deepEqual(open.map((r) => r.run_number), [k], `item ${n}'s runs are ${describeRuns(runs)}`);
});

Then("item {int}'s run {int} resumes at the stage {string}", long, async function (n: number, k: number, stage: string) {
  const runs = await runsOf(this, n);
  const run = runs.find((r) => r.run_number === k);
  assert.ok(run, `item ${n} has no run ${k}: ${describeRuns(runs)}`);
  assert.equal(run.ended_at, null, `item ${n}'s run ${k} has ended`);
  assert.equal(run.next_stage, stage, `item ${n}'s run ${k} resumes at ${run.next_stage}`);
});

Then("item {int}'s run {int} is still on the branch {string}", long, async function (n: number, k: number, branch: string) {
  const runs = await runsOf(this, n);
  const run = runs.find((r) => r.run_number === k);
  assert.ok(run, `item ${n} has no run ${k}: ${describeRuns(runs)}`);
  assert.equal(run.ended_at, null, `item ${n}'s run ${k} has ended`);
  assert.equal(run.branch, branch);
});

Then("item {int} has no run newer than the one whose PR {int} merged", long, async function (n: number, pr: number) {
  const runs = await runsOf(this, n);
  const merged = runs.find((r) => r.pr_number === pr);
  assert.ok(merged, `no run of item ${n} has PR ${pr}: ${describeRuns(runs)}`);
  assert.deepEqual(runs.filter((r) => r.run_number > merged.run_number).map((r) => r.run_number), [], `item ${n}'s runs are ${describeRuns(runs)}`);
});

Then("the stage {string} has all of its retries available again", long, async function (stage: string) {
  const n = 482;
  const runs = await runsOf(this, n);
  const run = runs.find((r) => r.ended_at === null);
  assert.ok(run, `item ${n} has no open run`);
  assert.equal(run.next_stage, stage, `item ${n}'s run resumes at ${run.next_stage}`);
  const state = (await pool().query<{ state: string }>("select state from item where id = $1", [itemId(this, n)])).rows[0].state;
  assert.equal(state, "Queued", `item ${n} is ${state}, so no new claim gives the stage its retries`);
  // The next claim starts the stage afresh with every retry, unless the stage's last attempt carries tries over.
  const last = (await pool().query<{ status: string; retry_carry: unknown }>(
    "select status, retry_carry from stage_run where run_id = $1 and stage_id = $2 order by attempt desc limit 1", [run.id, stage],
  )).rows[0];
  assert.ok(last, `the stage "${stage}" has no attempt on run ${run.run_number}`);
  assert.equal(last.retry_carry, null, `the stage "${stage}"'s last attempt carries ${JSON.stringify(last.retry_carry)} over to the next claim`);
});

async function newMoves(world: object, n: number): Promise<{ from: string; to: string; event: string | null }[]> {
  polled(pollCtx(world));
  const seeded = ctx369(world).seeded;
  const r = await pool().query<{ id: string; payload: { from: string; to: string; event?: string } }>(
    "select id, payload from event where item_id = $1 and kind in ('transition', 'override') order by at, id", [itemId(world, n)],
  );
  return r.rows.filter((row) => !seeded.has(row.id)).map((row) => ({ from: row.payload.from, to: row.payload.to, event: row.payload.event ?? null }));
}

Then("item {int}'s history shows a move from {string} to {string} made by the re-queue", long, async function (n: number, from: string, to: string) {
  const moves = await newMoves(this, n);
  assert.ok(moves.some((m) => m.from === from && m.to === to && /^requeue/.test(m.event ?? "")),
    `item ${n}'s new moves are ${JSON.stringify(moves)}`);
});

Then("no cell was started for item {int}", long, async function (n: number) {
  const id = itemId(this, n);
  const runIds = (await pool().query<{ id: string }>("select id from run where item_id = $1", [id])).rows.map((r) => r.id);
  const started = ctx(this).started.filter((env) => Object.values(env).some((v) => runIds.includes(v) || v === id));
  assert.deepEqual(started.map((e) => e.RUN_ID ?? JSON.stringify(e)), [], `the launcher started a cell for item ${n}`);
  const moves = await newMoves(this, n);
  assert.ok(!moves.some((m) => m.to === "InProgress"), `item ${n}'s new moves are ${JSON.stringify(moves)}`);
  const named = (await pool().query<{ n: number }>("select count(*)::int as n from run where item_id = $1 and execution_name is not null", [id])).rows[0].n;
  assert.equal(named, 0, `a run of item ${n} has a cell`);
});

// ---- the item page ----

When("the operator opens item {int}'s page", long, async function (n: number) {
  const c = p89(this);
  assert.ok(c.login, "no operator is signed in");
  if (!c.server) await startControlPlane(this);
  const r = await fetch(`${c.origin}/items/${itemId(this, n)}`, { headers: headers(c.login) });
  ctx(this).page = { status: r.status, html: await r.text() };
});

Then("the page says item {int}'s feature files are no longer on {string}", function (n: number, branch: string) {
  const page = ctx(this).page;
  assert.ok(page, `item ${n}'s page wasn't opened`);
  assert.equal(page.status, 200, `item ${n}'s page answered ${page.status}: ${page.html.slice(0, 300)}`);
  const said = text(page.html);
  const gone = new RegExp(`feature files?\\b[^.]*\\b(no longer on|not on|aren't on|are missing from|gone from)\\s+${escapeRe(branch)}\\b`, "i");
  assert.match(said, gone, `item ${n}'s page doesn't say its feature files are no longer on "${branch}"`);
});
