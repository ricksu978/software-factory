// Step definitions for features/pbi-134-slow-work-warnings.feature, on PBI 4's shared test database.
//
// Work gets stuck the way the item describes: another transaction takes a lock and never commits, so the real tick,
// the real poll or the real cell API request waits on it inside Postgres. A step "finishes" when that transaction
// commits and "fails" when the waiting statement is cancelled. Each stall is confirmed with pg_blocking_pids before
// the scenario moves on, so a When never runs ahead of the work it times.
//
//   expiring leases          an InProgress item whose lease ran out, and `event` locked: its lease_expired can't land
//   chasing questions        a SignOff question past its 5-day timeout, and `event` locked: its timed_out can't land
//   polling merged CI        an Accepted item whose merge commit passed CI, and `event` locked: dod_verified can't land
//   starting the next item   `wip_policy` locked, so startNext can't read the WIP limit
//   listing new and changed  a listed item's row locked, so the poll can't upsert it
//   reading the PRs          an InReview item whose PR merged, its row locked, so the poll can't move it
//   a cell API request       the run's item row locked, so the route can't take its lock
//
// Time is a fake Clock passed in as `slow.clock`, and warnings are what reaches `slow.log`. The line formats are the
// ones src/control/slow-work.ts documents.
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type pg from "pg";
import { fakeBacklog, fakeRepoHost } from "../../src/adapters/fake.ts";
import { cellApi, runToken } from "../../src/control/cell-api.ts";
import type { Clock, Slow } from "../../src/control/slow-work.ts";
import { startServer } from "../../src/http/server.ts";
import { tick } from "../../src/scheduler/scheduler.ts";
import { withTx } from "../../src/store/db.ts";
import { claimNext } from "../../src/store/items.ts";
import { pollOnce } from "../../src/watcher/poller.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";

const NOW = new Date("2026-11-06T10:00:00Z");
const REPO = "ricksu978/software-factory";
const REPO_URL = `https://github.com/${REPO}`;
const SECRET = "pbi-134-secret";
const DAY_MS = 86_400_000;

/** A fake clock. `advance` fires each timer that falls due, in order, letting the event loop run after each. */
class FakeClock implements Clock {
  private t = 0;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      await settle();
      const due = [...this.timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.t = due[1].at;
      due[1].fn();
    }
    this.t = end;
    await settle();
  }
  /** How many timers are still waiting that were due by now. `advance` should leave none. */
  overdue(): number {
    return [...this.timers.values()].filter((v) => v.at <= this.t).length;
  }
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A transaction that holds a lock until the scenario commits it, or After rolls it back. */
type Holder = { client: pg.PoolClient; pid: number; done: boolean };

type Work = { done: boolean; error?: unknown; promise: Promise<void> };
type Board = { name: string; sourceId: string; backlog: ReturnType<typeof fakeBacklog> };
type Ctx = {
  clock: FakeClock;
  lines: string[];
  holders: Holder[];
  repoHost: ReturnType<typeof fakeRepoHost>;
  backlog: ReturnType<typeof fakeBacklog>;
  sourceId?: string;
  ticks: Work[];
  polls: Work[];
  boards: Map<string, Board>;
  server?: Server;
  runs: Map<string, { runId: string; token: string; itemId: string }>;
  requests: Work[];
  seq: number;
};

function ctx(world: object): Ctx {
  const w = world as { pbi134?: Ctx };
  w.pbi134 ??= {
    clock: new FakeClock(), lines: [], holders: [], repoHost: fakeRepoHost(), backlog: fakeBacklog(),
    ticks: [], polls: [], boards: new Map(), runs: new Map(), requests: [], seq: 0,
  };
  return w.pbi134;
}

const pool = () => need().pool;
const slow = (c: Ctx): Slow => ({ clock: c.clock, log: (line) => c.lines.push(line) });

Before({ tags: "@pbi-134 and @db", ...long }, async function () {
  const d = await testDb();
  if (!d) return;
  await d.pool.query('truncate item, event, backlog_source, repo, "user", override cascade');
  await d.pool.query("update wip_policy set mode = 'fixed', current_wip = 1, review_capacity = 3, usage_paused_until = null");
  await d.pool.query("insert into repo (host_adapter, url, trusted_bot) values ('github', $1, 'factory[bot]')", [REPO_URL]);
  ctx(this).repoHost.heads.set(REPO, "c0ffee0");
});

After({ tags: "@pbi-134", ...long }, async function () {
  const c = ctx(this);
  for (const h of c.holders) await finish(h, "rollback").catch(() => undefined);
  await Promise.race([
    Promise.allSettled([...c.ticks, ...c.polls, ...c.requests].map((w) => w.promise)),
    new Promise((resolve) => setTimeout(resolve, 10_000)),
  ]);
  if (c.server) {
    c.server.closeAllConnections();
    await new Promise<void>((resolve) => c.server!.close(() => resolve()));
  }
});

// --- locks ---------------------------------------------------------------------------------------------------------

async function hold(c: Ctx, sql: string, params: unknown[] = []): Promise<Holder> {
  const client = await pool().connect();
  const pid = (await client.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid;
  await client.query("begin");
  await client.query(sql, params);
  const h = { client, pid, done: false };
  c.holders.push(h);
  return h;
}

async function finish(h: Holder, how: "commit" | "rollback"): Promise<void> {
  if (h.done) return;
  h.done = true;
  try {
    await h.client.query(how);
  } finally {
    h.client.release();
  }
}

/** The backends `h` is blocking right now. */
async function blockedBy(h: Holder): Promise<number[]> {
  const r = await pool().query<{ pid: number }>("select pid from pg_stat_activity where $1 = any(pg_blocking_pids(pid))", [h.pid]);
  return r.rows.map((row) => row.pid);
}

/** Waits until `n` backends wait on `h`'s lock. A step that never stalls fails here, in a Given or When. */
async function stalledOn(h: Holder, n = 1, what = "the work"): Promise<void> {
  const until = Date.now() + 15_000;
  while ((await blockedBy(h)).length < n) {
    assert.ok(Date.now() < until, `${what} never got stuck on the held lock`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function current(c: Ctx): Holder {
  const h = c.holders.filter((x) => !x.done).at(-1);
  assert.ok(h, "nothing is stuck");
  return h;
}

function track(p: Promise<unknown>, onError?: (e: unknown) => void): Work {
  const w: Work = { done: false, promise: Promise.resolve() };
  w.promise = p.then(
    () => void (w.done = true),
    (e) => {
      w.done = true;
      w.error = e;
      onError?.(e);
    },
  );
  return w;
}

async function ended(w: Work | undefined, what: string): Promise<void> {
  assert.ok(w, `no ${what} ran`);
  await Promise.race([w.promise, new Promise((resolve) => setTimeout(resolve, 15_000))]);
  assert.ok(w.done, `the ${what} never ended`);
}

// --- the scheduler -------------------------------------------------------------------------------------------------

async function source(c: Ctx): Promise<string> {
  c.sourceId ??= (await pool().query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'fake:pbi-134') returning id")).rows[0].id;
  return c.sourceId;
}

async function newItem(c: Ctx, state: string, extra: { lease?: Date } = {}): Promise<{ id: string; ext: string }> {
  const ext = `t${++c.seq}`;
  const id = (await pool().query<{ id: string }>(
    `insert into item (source_id, external_id, title, state, lease_generation, lease_owner, lease_expires)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [await source(c), ext, `item ${ext}`, state, extra.lease ? 1 : 0, extra.lease ? "cell-old" : null, extra.lease ?? null],
  )).rows[0].id;
  await c.backlog.seed({ externalId: ext, repo: REPO });
  return { id, ext };
}

/** Sets up what makes `step` stall, takes the lock and returns it. */
async function stall(c: Ctx, step: string): Promise<Holder> {
  if (step === "expiring leases") {
    const { id } = await newItem(c, "InProgress", { lease: new Date(NOW.getTime() - 60_000) });
    await pool().query("update item set held = true where id = $1", [id]);
    await pool().query("insert into run (item_id, run_number, next_stage) values ($1, 1, 'green')", [id]);
    return hold(c, "lock table event in exclusive mode");
  }
  if (step === "chasing questions") {
    const { id } = await newItem(c, "SignOff");
    await pool().query("insert into question (item_id, kind, body, asked_at) values ($1, 'sign_off', 'q', $2)", [id, new Date(NOW.getTime() - 6 * DAY_MS)]);
    return hold(c, "lock table event in exclusive mode");
  }
  if (step === "polling merged CI") {
    const { id } = await newItem(c, "Accepted");
    await pool().query("insert into run (item_id, run_number, next_stage, merge_sha, repo_id) values ($1, 1, 'done', 'feed123', (select id from repo where url = $2))", [id, REPO_URL]);
    c.repoHost.checks.set(`${REPO}@feed123`, "success");
    return hold(c, "lock table event in exclusive mode");
  }
  if (step === "starting the next item") return hold(c, "lock table wip_policy in access exclusive mode");
  throw new Error(`no way to get a tick stuck while ${step}`);
}

function startTick(c: Ctx): void {
  const backlog = c.backlog.adapter;
  // The control plane's loop logs a tick that throws, as `every` in src/main.ts does.
  const log = slow(c).log!;
  c.ticks.push(track(tick({
    pool: pool(), now: NOW, killFlag: false, repoHost: c.repoHost, backlogFor: () => backlog, secret: SECRET,
    controlUrl: "http://control.test:7400", sopVersion: "default@1", slow: slow(c),
    launcher: { start: async () => `exec-${++c.seq}`, stop: async () => undefined },
  }), (e) => log(`scheduler tick failed: ${e instanceof Error ? e.message : String(e)}`)));
}

async function tickStuck(c: Ctx, step: string): Promise<void> {
  const h = await stall(c, step);
  startTick(c);
  await stalledOn(h, 1, `the scheduler tick (while ${step})`);
}

Given("the scheduler tick gets stuck while {}", long, async function (step: string) {
  await tickStuck(ctx(this), step);
});

When("a second scheduler tick gets stuck while {}", long, async function (step: string) {
  await tickStuck(ctx(this), step);
});

When("the tick moves on and gets stuck while {}", long, async function (step: string) {
  const c = ctx(this);
  const before = current(c);
  const next = await stall(c, step);
  await finish(before, "commit");
  await stalledOn(next, 1, `the scheduler tick (while ${step})`);
});

When("the stuck step finishes and the tick ends", long, async function () {
  const c = ctx(this);
  await finish(current(c), "commit");
  await ended(c.ticks.at(-1), "scheduler tick");
});

When("the stuck step fails and the tick ends with an error", long, async function () {
  const c = ctx(this);
  const h = current(c);
  for (const pid of await blockedBy(h)) await pool().query("select pg_cancel_backend($1)", [pid]);
  await ended(c.ticks.at(-1), "scheduler tick");
  assert.ok(c.ticks.at(-1)!.error, "the tick ended without an error");
  await finish(h, "rollback");
});

// --- the poller ----------------------------------------------------------------------------------------------------

async function board(c: Ctx, name: string): Promise<Board> {
  let b = c.boards.get(name);
  if (!b) {
    const sourceId = (await pool().query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', $1) returning id", [`fake:${name}`])).rows[0].id;
    b = { name, sourceId, backlog: fakeBacklog() };
    c.boards.set(name, b);
  }
  return b;
}

async function pollStall(c: Ctx, b: Board, step: string): Promise<Holder> {
  const ext = `${b.name}-${++c.seq}`;
  if (step === "listing new and changed items") {
    await b.backlog.seed({ externalId: ext, repo: REPO });
    const id = (await pool().query<{ id: string }>("insert into item (source_id, external_id, title, state) values ($1, $2, $3, 'Eligible') returning id", [b.sourceId, ext, `item ${ext}`])).rows[0].id;
    return hold(c, "select 1 from item where id = $1 for update", [id]);
  }
  if (step === "reading the PRs of items in review") {
    // Not on the board, so listing never touches it. The PR step reads its repo from the run.
    const id = (await pool().query<{ id: string }>("insert into item (source_id, external_id, title, state) values ($1, $2, $3, 'InReview') returning id", [b.sourceId, ext, `item ${ext}`])).rows[0].id;
    const number = c.repoHost.prs.length + 1;
    c.repoHost.prs.push({
      number, repo: REPO, branch: `factory/${ext}-r1`, base: "main", title: ext, body: "", headSha: "abc1234", open: false, merged: true,
      mergeSha: "beef456", mergeable: true, reviewers: [], comments: [], reviews: [],
    });
    await pool().query(
      "insert into run (item_id, run_number, next_stage, pr_number, branch, repo_id) values ($1, 1, 'review', $2, $3, (select id from repo where url = $4))",
      [id, number, `factory/${ext}-r1`, REPO_URL],
    );
    return hold(c, "select 1 from item where id = $1 for update", [id]);
  }
  throw new Error(`no way to get a poll stuck while ${step}`);
}

function startPoll(c: Ctx, b: Board): Work {
  const w = track(pollOnce({
    pool: pool(), adapter: b.backlog.adapter, repoHost: c.repoHost, judge: async () => "passed", sourceId: b.sourceId, slow: slow(c),
  }));
  c.polls.push(w);
  return w;
}

async function pollStuck(c: Ctx, name: string, step: string): Promise<void> {
  const b = await board(c, name);
  const h = await pollStall(c, b, step);
  startPoll(c, b);
  await stalledOn(h, 1, `the poll of board "${name}" (while ${step})`);
}

Given("the poll of board {string} gets stuck while {}", long, async function (name: string, step: string) {
  await pollStuck(ctx(this), name, step);
});

When("a second poll of board {string} gets stuck while {}", long, async function (name: string, step: string) {
  await pollStuck(ctx(this), name, step);
});

When("the poll moves on and gets stuck while {}", long, async function (step: string) {
  const c = ctx(this);
  const before = current(c);
  const b = [...c.boards.values()].at(-1)!;
  const next = await pollStall(c, b, step);
  await finish(before, "commit");
  await stalledOn(next, 1, `the poll (while ${step})`);
});

When("the stuck step finishes and the poll ends", long, async function () {
  const c = ctx(this);
  await finish(current(c), "commit");
  await ended(c.polls.at(-1), "poll");
});

Given("two boards, {string} and {string}", long, async function (a: string, b: string) {
  const c = ctx(this);
  await board(c, a);
  await board(c, b);
  const { rows } = await pool().query<{ url: string }>(
    "select url from backlog_source where adapter = 'fake' and url = any($1) order by url", [[`fake:${a}`, `fake:${b}`]],
  );
  assert.deepEqual(rows.map((r) => r.url), [`fake:${a}`, `fake:${b}`].sort(), `boards "${a}" and "${b}" weren't both created`);
});

Given("the poll of board {string} ends quickly", long, async function (name: string) {
  const c = ctx(this);
  const w = startPoll(c, await board(c, name));
  await ended(w, `poll of board "${name}"`);
  assert.equal(w.error, undefined, `the poll of board "${name}" failed: ${String(w.error)}`);
});

// --- the cell API --------------------------------------------------------------------------------------------------

async function cellServer(c: Ctx): Promise<string> {
  if (!c.server) {
    const backlog = c.backlog.adapter;
    const api = cellApi({
      pool: pool(), secret: SECRET, repoHost: c.repoHost, backlogFor: () => backlog,
      stageAfter: () => null, uploadUrl: async (path: string) => `http://blob.test/${path}`,
      gateway: { upstream: "http://127.0.0.1:9", ownerToken: () => "owner" }, webToolsOf: () => [],
      killSwitch: () => false, now: () => NOW, slow: slow(c),
    });
    c.server = await startServer([api], { port: 0 });
  }
  return `http://127.0.0.1:${(c.server.address() as AddressInfo).port}`;
}

async function runInProgress(c: Ctx, ext: string): Promise<void> {
  await cellServer(c);
  await c.backlog.seed({ externalId: ext, repo: REPO });
  const itemId = (await pool().query<{ id: string }>(
    "insert into item (source_id, external_id, title, state) values ($1, $2, $3, 'Queued') returning id", [await source(c), ext, `item ${ext}`],
  )).rows[0].id;
  // Claimed on its own, so it's the only claimable item and the claim can't pick another.
  const claim = await withTx(pool(), (client) => claimNext(client, "cell-pbi-134", NOW));
  assert.ok(claim && claim.itemId === itemId, `item ${ext} wasn't claimed`);
  await pool().query(
    "update run set repo_id = (select id from repo where url = $2), sop_version = 'default@1', config_sha = 'cfg1234' where id = $1",
    [claim.runId, REPO_URL],
  );
  await pool().query("insert into stage_run (run_id, stage_id, attempt, status) values ($1, 'understand', 1, 'started')", [claim.runId]);
  c.runs.set(ext, { runId: claim.runId, itemId, token: runToken(SECRET, claim.runId, claim.generation) });
}

const ROUTES: Record<string, { method: string; path: string; body?: unknown }> = {
  "report a stage": { method: "POST", path: "/stage", body: { stageId: "understand", attempt: 1, status: "passed", model: "claude-opus-5-5" } },
  "fetch its context": { method: "GET", path: "/context" },
};

/** Locks the run's item row, sends the request and waits until it is stuck on the lock. */
async function stuckRequest(c: Ctx, ext: string, what: string): Promise<{ holder: Holder; work: Work }> {
  const run = c.runs.get(ext);
  assert.ok(run, `item ${ext} has no run in progress`);
  const route = ROUTES[what];
  assert.ok(route, `no cell API request "${what}"`);
  const holder = await hold(c, "select 1 from item where id = $1 for update", [run.itemId]);
  const url = `${await cellServer(c)}/internal/cells/${run.runId}${route.path}`;
  const work = track(fetch(url, {
    method: route.method,
    headers: { authorization: `Bearer ${run.token}`, "content-type": "application/json" },
    body: route.body === undefined ? undefined : JSON.stringify(route.body),
  }).then((r) => r.text()));
  c.requests.push(work);
  await stalledOn(holder, 1, `item ${ext}'s request to ${what}`);
  return { holder, work };
}

Given("item {string} has a run in progress", long, async function (ext: string) {
  await runInProgress(ctx(this), ext);
});

Given("items {string} and {string} each have a run in progress", long, async function (a: string, b: string) {
  const c = ctx(this);
  await runInProgress(c, a);
  // The first item's run is InProgress, so it isn't claimable again and the second claim takes the second item.
  await runInProgress(c, b);
});

Given("the database stalls the cell's request to {}", long, async function (what: string) {
  const c = ctx(this);
  await stuckRequest(c, [...c.runs.keys()].at(-1)!, what);
});

Given("the database stalls item {string}'s request to {}", long, async function (ext: string, what: string) {
  await stuckRequest(ctx(this), ext, what);
});

Given("the cell's request to {} is answered after {int} seconds", long, async function (what: string, s: number) {
  const c = ctx(this);
  const { holder, work } = await stuckRequest(c, [...c.runs.keys()].at(-1)!, what);
  await c.clock.advance(s * 1000);
  await finish(holder, "commit");
  await ended(work, `request to ${what}`);
  assert.equal(work.error, undefined, `the request to ${what} failed: ${String(work.error)}`);
});

// --- time ----------------------------------------------------------------------------------------------------------

When(/^(\d+) (?:more )?(minutes?|seconds?) pass$/, long, async function (n: string, unit: string) {
  const clock = ctx(this).clock;
  const ms = Number(n) * (unit.startsWith("minute") ? 60_000 : 1000);
  const before = clock.now();
  await clock.advance(ms);
  assert.equal(clock.now() - before, ms, `the clock moved ${clock.now() - before} ms, not ${ms}`);
  assert.equal(clock.overdue(), 0, "a timer due by now is still pending");
});

// --- the log -------------------------------------------------------------------------------------------------------

type Warning = { line: string; minutes: number; step: string | null };
const TICK = /^slow: the scheduler tick has run for (\d+) minutes?, in step "([^"]*)"/;
const POLL = /^slow: the poll of board (\S+) has run for (\d+) minutes?, in step "([^"]*)"/;
const REQUEST = /^slow: the cell API request (\S+ \S+) for run (\S+) has been open for (\d+) seconds?/;

function tickWarnings(c: Ctx): Warning[] {
  return c.lines.flatMap((line) => {
    const m = TICK.exec(line);
    return m ? [{ line, minutes: Number(m[1]), step: m[2] }] : [];
  });
}

function pollWarnings(c: Ctx): (Warning & { board: string })[] {
  return c.lines.flatMap((line) => {
    const m = POLL.exec(line);
    return m ? [{ line, board: m[1], minutes: Number(m[2]), step: m[3] }] : [];
  });
}

function requestWarnings(c: Ctx): { line: string; route: string; runId: string; seconds: number }[] {
  return c.lines.flatMap((line) => {
    const m = REQUEST.exec(line);
    return m ? [{ line, route: m[1], runId: m[2], seconds: Number(m[3]) }] : [];
  });
}

const shown = (c: Ctx) => (c.lines.length ? c.lines.map((l) => `  ${l}`).join("\n") : "  (nothing)");
const boardName = (url: string) => url.replace(/^fake:/, "");

function only<T>(c: Ctx, list: T[], what: string): T {
  assert.equal(list.length, 1, `expected exactly 1 ${what}, the log has ${list.length}:\n${shown(c)}`);
  return list[0];
}

Then("the log says the scheduler tick has run for {int} minutes", function (n: number) {
  const c = ctx(this);
  assert.ok(tickWarnings(c).some((w) => w.minutes === n), `no slow-tick warning says ${n} minutes. The log:\n${shown(c)}`);
});

Then("that log line names the step {string}", function (step: string) {
  const c = ctx(this);
  const last = [...tickWarnings(c), ...pollWarnings(c)].at(-1);
  assert.ok(last, `the log has no slow-tick or slow-poll warning:\n${shown(c)}`);
  assert.equal(last.step, step, `the warning names the step "${last.step}": ${last.line}`);
});

Then(/^the log has (exactly )?(\d+) slow-(tick|poll|request) warnings?$/, function (_exactly: string | undefined, n: string, kind: string) {
  const c = ctx(this);
  const list = kind === "tick" ? tickWarnings(c) : kind === "poll" ? pollWarnings(c) : requestWarnings(c);
  assert.equal(list.length, Number(n), `expected ${n} slow-${kind} warnings, the log has ${list.length}:\n${shown(c)}`);
});

Then("that warning names the step {string}", function (step: string) {
  const c = ctx(this);
  const w = only(c, [...tickWarnings(c), ...pollWarnings(c)], "slow-tick or slow-poll warning");
  assert.equal(w.step, step, `the warning names the step "${w.step}": ${w.line}`);
});

Then("they say the tick has run for {int}, {int} and {int} minutes", function (a: number, b: number, d: number) {
  const c = ctx(this);
  assert.deepEqual(tickWarnings(c).map((w) => w.minutes), [a, b, d], `the log:\n${shown(c)}`);
});

Then("they say the poll has run for {int}, {int} and {int} minutes", function (a: number, b: number, d: number) {
  const c = ctx(this);
  assert.deepEqual(pollWarnings(c).map((w) => w.minutes), [a, b, d], `the log:\n${shown(c)}`);
});

Then("each names the step {string}", function (step: string) {
  const c = ctx(this);
  const list = tickWarnings(c);
  assert.ok(list.length > 0, `the log has no slow-tick warning:\n${shown(c)}`);
  for (const w of list) assert.equal(w.step, step, `a warning names the step "${w.step}": ${w.line}`);
});

Then("the first slow-tick warning names the step {string}", function (step: string) {
  const c = ctx(this);
  const w = tickWarnings(c)[0];
  assert.ok(w, `the log has no slow-tick warning:\n${shown(c)}`);
  assert.equal(w.step, step, `the first warning names the step "${w.step}": ${w.line}`);
});

Then("the second slow-tick warning, at {int} minutes, names the step {string}", function (n: number, step: string) {
  const c = ctx(this);
  const w = tickWarnings(c)[1];
  assert.ok(w, `the log has no second slow-tick warning:\n${shown(c)}`);
  assert.equal(w.minutes, n, `the second warning says ${w.minutes} minutes: ${w.line}`);
  assert.equal(w.step, step, `the second warning names the step "${w.step}": ${w.line}`);
});

Then("the tick's failure is logged", function () {
  const c = ctx(this);
  assert.ok(c.ticks.at(-1)?.error, "the tick didn't fail");
  assert.ok(c.lines.some((l) => l.startsWith("scheduler tick failed")), `the tick's failure isn't in the log:\n${shown(c)}`);
});

Then("the log says the poll of board {string} has run for {int} minutes", function (name: string, n: number) {
  const c = ctx(this);
  assert.ok(pollWarnings(c).some((w) => boardName(w.board) === name && w.minutes === n), `no slow-poll warning says board "${name}" ran ${n} minutes. The log:\n${shown(c)}`);
});

Then("the first names the step {string}", function (step: string) {
  const c = ctx(this);
  const w = pollWarnings(c)[0];
  assert.ok(w, `the log has no slow-poll warning:\n${shown(c)}`);
  assert.equal(w.step, step, `the first warning names the step "${w.step}": ${w.line}`);
});

Then("the second and third name the step {string}", function (step: string) {
  const c = ctx(this);
  const list = pollWarnings(c).slice(1, 3);
  assert.equal(list.length, 2, `the log has no second and third slow-poll warnings:\n${shown(c)}`);
  for (const w of list) assert.equal(w.step, step, `a warning names the step "${w.step}": ${w.line}`);
});

Then("that warning names board {string}", function (name: string) {
  const c = ctx(this);
  const w = only(c, pollWarnings(c), "slow-poll warning");
  assert.equal(boardName(w.board), name, `the warning names board ${w.board}: ${w.line}`);
});

Then("the log says a cell API request has been open for {int} seconds", function (s: number) {
  const c = ctx(this);
  assert.ok(requestWarnings(c).some((w) => w.seconds === s), `no slow-request warning says ${s} seconds. The log:\n${shown(c)}`);
});

function lastRequestWarning(c: Ctx) {
  const w = requestWarnings(c).at(-1);
  assert.ok(w, `the log has no slow-request warning:\n${shown(c)}`);
  return w;
}

Then("that log line names the route {string}", function (route: string) {
  const w = lastRequestWarning(ctx(this));
  assert.equal(w.route, route, `the warning names the route ${w.route}: ${w.line}`);
});

Then("that warning names the route {string}", function (route: string) {
  const c = ctx(this);
  const w = only(c, requestWarnings(c), "slow-request warning");
  assert.equal(w.route, route, `the warning names the route ${w.route}: ${w.line}`);
});

Then("that log line names item {string}'s run id", function (ext: string) {
  const c = ctx(this);
  const w = lastRequestWarning(c);
  assert.equal(w.runId, c.runs.get(ext)?.runId, `the warning names run ${w.runId}: ${w.line}`);
});

Then("the log has a slow-request warning naming the route {string} and item {string}'s run id", function (route: string, ext: string) {
  const c = ctx(this);
  const runId = c.runs.get(ext)?.runId;
  assert.ok(requestWarnings(c).some((w) => w.route === route && w.runId === runId), `no slow-request warning names ${route} and run ${runId}. The log:\n${shown(c)}`);
});
