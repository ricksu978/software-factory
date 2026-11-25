// Step definitions for features/pbi-396-worker-fake-clock.feature. The @db scenarios run workers from
// src/worker/main.ts in this process, on PBI 4's shared test database, with PBI 156's fakes and board, PBI 17's items
// and launcher record, and PBI 157's first worker. A worker on a fake clock is handed one from src/clock.ts as
// its `clock`. "With its default intervals" and "given no intervals" leave tickMs, outboxMs, pollMs and lockRetryMs
// unset, so the worker uses its own.
//
// This file starts each of its workers itself, on a pool of its own that reaches Postgres through PBI 157's proxy, and
// every connection's bytes pass a tap here. The tap reads the Postgres protocol's messages: the queries each connection
// sends, and the replies it is still waiting for. The worker's lock connection is the one that tried for the worker
// lock with pg_try_advisory_lock. Each such query is a try for the lock, and any other query on that connection is a
// lock check. The scheduler tick, the outbox loop and the board poll are counted from the worker's runs map.
//
// The second worker sits in PBI 157's list of workers, and the single worker is PBI 157's single worker and PBI 156's
// worker, so their steps for launched cells, stopping the first worker and ending a lock connection hold here too.
//
// Each worker starts under features/support/real-timers.ts's trackTimers, so the timers it sets on the process's real
// clock are kept under its name. "The worker settles" waits, with no timed wait, until the worker's pool has no client
// out, none of its connections waits on a reply, and its counts stay the same across many turns of the event loop.
// "The fake clock moves N on" moves the clock with advance() and then lets the worker settle.
//
// Each heartbeat write runs a trigger that logs the tick's time, and the real time the write began and ended, to
// pbi396_heartbeat_log. Every tick writes the heartbeat as it ends (PBI 158), so the log holds each tick's time in
// order. The "half a real second" Given has the trigger sleep half a second in each write.
//
// The @ac-5 scenarios run PBI 157's, PBI 158's and PBI 376's scenarios in cucumber-js, as `npm run bdd` does, and read
// its message report. The runs of PBI 157 and PBI 158 record every real timer the factory's code sets in their
// processes, through PBI396_REAL_TIMERS, so a worker of theirs that wasn't started on a fake clock shows up there.
import { After, Before, Given, Then, When, type DataTable } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cucumberArgs, DEFAULT_WORKERS } from "../../src/bdd/run.ts";
import { createPool } from "../../src/store/db.ts";
import type { FakeClock } from "../../src/clock.ts";
import { realTimers, trackTimers } from "../support/real-timers.ts";
import { moved } from "../support/worker-clocks.ts";
import { load, long, need, testDb } from "./pbi-8.steps.ts";
import { ctx as p17 } from "./pbi-17.steps.ts";
import { board, ctx as w156, fakes, learnItems, rehome, type Running } from "./pbi-156.steps.ts";
import {
  ctx as w157, dbUrl, lockSessions, logger, proxied, startProxy, terminate, watch, type Tap, type Worker as Worker157,
} from "./pbi-157.steps.ts";

/** Where a fake clock reads when the scenario names no time. */
const DEFAULT_START = "2026-01-01T00:00:00Z";
const SINGLE = "the worker";
const TRY = /pg_try_advisory_lock/i;
const TOOK = /took the (worker )?lock/i;
/** The suite's own runs, in @ac-5, can take many minutes. */
const SUITE = { timeout: 60 * 60_000 };

type Conn = { queries: string[]; requests: number; ready: number; closed: boolean };
type W = Worker157 & { tag: string; conns: Conn[]; clock?: FakeClock; boardId?: string; firstTickAt?: number };

export type Case = { name: string; uri: string; statuses: string[]; stepMs: number; pickleId: string; steps: string[] };
export type Suite = { code: number | null; out: string; cases: Case[]; pickles: number; timers?: string[] };

type Ctx = {
  workers: W[];
  /** The fake clock "the fake clock" names: the one a Given made, or the single worker's. */
  clock?: FakeClock;
  missing?: string;
  suite?: Suite;
};

function ctx(world: object): Ctx {
  const w = world as { pbi396?: Ctx };
  w.pbi396 ??= { workers: [] };
  return w.pbi396;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const turn = () => new Promise((resolve) => setImmediate(resolve));

async function within(ms: number, ok: () => boolean | Promise<boolean>): Promise<boolean> {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() >= end) return false;
    await sleep(25);
  }
  return true;
}

async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> {
  assert.ok(await within(ms, ok), `timed out waiting until ${what}`);
}

const iso = (ms: number | undefined) => (ms === undefined ? "none" : new Date(ms).toISOString());

/** "4 minutes 59 seconds", "999 milliseconds", "1 second", in milliseconds. */
function duration(text: string): number {
  const unit: Record<string, number> = { minute: 60_000, second: 1_000, millisecond: 1 };
  let ms = 0;
  let matched = "";
  for (const m of text.matchAll(/(\d+) (minute|second|millisecond)s?/g)) {
    ms += Number(m[1]) * unit[m[2]];
    matched += m[0];
  }
  assert.ok(matched.length > 0, `"${text}" names no time`);
  return ms;
}

// ---- The tap: each connection's queries and the replies it waits for ----

const cstr = (b: Buffer, from: number) => {
  const end = b.indexOf(0, from);
  return b.subarray(from, end < 0 ? b.length : end).toString("utf8");
};

function tap(conns: Conn[]): Tap {
  return () => {
    const conn: Conn = { queries: [], requests: 0, ready: 0, closed: false };
    conns.push(conn);
    let fromClient = Buffer.alloc(0);
    let fromServer = Buffer.alloc(0);
    let startup = true;
    let sslAnswer = false;
    return {
      client(b) {
        fromClient = Buffer.concat([fromClient, b]);
        for (;;) {
          if (startup) {
            if (fromClient.length < 8) return;
            const len = fromClient.readInt32BE(0);
            if (fromClient.length < len) return;
            const code = fromClient.readInt32BE(4);
            fromClient = fromClient.subarray(len);
            // An SSL request is answered with one byte, not a ReadyForQuery, and the startup message follows it.
            if (code === 80877103) sslAnswer = true;
            else {
              startup = false;
              conn.requests++;
            }
            continue;
          }
          if (fromClient.length < 5) return;
          const len = fromClient.readInt32BE(1);
          if (fromClient.length < len + 1) return;
          const type = String.fromCharCode(fromClient[0]);
          const body = fromClient.subarray(5, len + 1);
          fromClient = fromClient.subarray(len + 1);
          if (type === "Q") {
            conn.queries.push(cstr(body, 0));
            conn.requests++;
          } else if (type === "P") {
            conn.queries.push(cstr(body, body.indexOf(0) + 1));
          } else if (type === "S") {
            conn.requests++;
          }
        }
      },
      server(b) {
        fromServer = Buffer.concat([fromServer, b]);
        if (sslAnswer && fromServer.length) {
          sslAnswer = false;
          fromServer = fromServer.subarray(1);
        }
        for (;;) {
          if (fromServer.length < 5) return;
          const len = fromServer.readInt32BE(1);
          if (fromServer.length < len + 1) return;
          if (fromServer[0] === "Z".charCodeAt(0)) conn.ready++;
          fromServer = fromServer.subarray(len + 1);
        }
      },
      close() {
        conn.closed = true;
      },
    };
  };
}

/** The worker's lock connection: the one that tried for the worker lock. */
const lockConn = (w: W) => w.conns.find((c) => c.queries.some((q) => TRY.test(q)));
const tries = (w: W) => lockConn(w)?.queries.filter((q) => TRY.test(q)).length ?? 0;
const checks = (w: W) => {
  const c = lockConn(w);
  return c ? c.queries.length - tries(w) : 0;
};
const waiting = (w: W) => w.conns.filter((c) => !c.closed).reduce((n, c) => n + Math.max(c.requests - c.ready, 0), 0);
const queries = (w: W) => w.conns.reduce((n, c) => n + c.queries.length, 0);

// ---- Workers ----

type Job = "scheduler tick" | "outbox loop" | "board poll" | "lock check";

function count(w: W, job: Job): number {
  const runs = w.running?.runs;
  switch (job) {
    case "scheduler tick":
      return runs?.get("scheduler tick") ?? 0;
    case "outbox loop":
      return runs?.get("working through the outbox") ?? 0;
    case "board poll":
      return runs?.get(`polling source ${w.boardId}`) ?? 0;
    case "lock check":
      return checks(w);
  }
}

const UNSET = { tickMs: undefined, outboxMs: undefined, pollMs: undefined, lockRetryMs: undefined };

type Start = { name: typeof SINGLE | "second"; clock?: FakeClock; intervals?: { tickMs?: number } };

/** Starts one of this file's workers. It returns once startWorker does, which a standby's does at once. */
async function start(world: object, o: Start): Promise<W> {
  const c = ctx(world);
  const c157 = w157(world);
  const url = await dbUrl();
  const app = `pbi396-${o.name.replaceAll(" ", "-")}-${crypto.randomUUID().slice(0, 8)}`;
  const conns: Conn[] = [];
  const proxy = await startProxy(url, tap(conns));
  const pool = createPool(proxied(url, proxy.port, app));
  const w: W = {
    name: o.name, app, pool, proxy, log: logger(`${o.name === SINGLE ? SINGLE : `${o.name} worker`}`),
    launched: [], polls: 0, judged: [], tickMs: o.intervals?.tickMs ?? 15_000, tag: app, conns, clock: o.clock,
  };
  c.workers.push(w);
  if (o.name === "second") {
    c157.reserved = (c157.reserved ?? 0) + 1;
    c157.workers.push(w);
  } else {
    c157.single = w;
    if (o.clock) c.clock = o.clock;
  }
  await rehome(world);
  const mod = await load<{ startWorker(d: object): Promise<Running> }>("src/worker/main.ts");
  if (!mod) {
    c.missing = "src/worker/main.ts doesn't exist";
    return w;
  }
  p17(world).ticked = true;
  const base = await fakes(world);
  const theBoard = await board(world);
  w.boardId = theBoard.id;
  const s = p17(world);
  const adapter = new Proxy(theBoard.adapter, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        if (prop === "listEligible") w.polls++;
        return v.apply(target, args);
      };
    },
  });
  try {
    w.running = await trackTimers(w.tag, () => mod.startWorker({
      ...base,
      pool,
      sources: [{ id: theBoard.id, adapter }],
      launcher: {
        async start(env: Record<string, string>) {
          s.started.push(env);
          w.launched.push(env.ITEM_ID);
          return `${app}-cell-${w.launched.length}`;
        },
        async stop(cell: string) {
          s.stopped.push(cell);
        },
      },
      log: w.log.sink,
      ...UNSET,
      ...o.intervals,
      ...(o.clock ? { clock: o.clock } : {}),
    }));
    watch(w.running, w);
    if (o.name === SINGLE) w156(world).worker = w.running;
  } catch (e) {
    w.startError = e;
  }
  return w;
}

function single(world: object): W {
  const w = ctx(world).workers.find((x) => x.name === SINGLE);
  assert.ok(w, "no worker was started");
  return w;
}

function second(world: object): W {
  const w = ctx(world).workers.find((x) => x.name === "second");
  assert.ok(w, "no second worker was started");
  return w;
}

/** Fails when the worker module is missing or the worker failed to start, so the clock isn't blamed for it. */
function started(world: object, w: W): void {
  const c = ctx(world);
  if (c.missing) assert.fail(c.missing);
  if (w157(world).missing) assert.fail(w157(world).missing);
  if (w.startError !== undefined) {
    const e = w.startError;
    assert.fail(`${w.name === SINGLE ? SINGLE : `the ${w.name} worker`} failed to start: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  }
  assert.ok(w.running, `${w.name} never started`);
}

/**
 * Waits, with no timed wait, until the worker's work has finished: no client of its pool is out or awaited, no
 * connection of its waits on a reply, and nothing it counts has moved for many turns of the event loop. Fails with what
 * was still busy when the worker hasn't settled within 10 real seconds.
 */
async function settle(w: W): Promise<void> {
  const end = Date.now() + 10_000;
  let calm = 0;
  let last = "";
  let still: string[] = [];
  while (calm < 50) {
    if (Date.now() >= end) {
      assert.fail(`${w.name} never settled; still busy: ${still.join("; ") || "nothing it counts stood still"}`);
    }
    await turn();
    const snap = JSON.stringify([[...(w.running?.runs ?? [])], w.polls, w.launched.length, w.log.lines.length, queries(w), w.exit !== undefined]);
    still = [];
    const out = w.pool.totalCount - w.pool.idleCount;
    if (out) still.push(`${out} client(s) of its pool out`);
    if (w.pool.waitingCount) still.push(`${w.pool.waitingCount} client(s) of its pool awaited`);
    if (waiting(w)) still.push(`${waiting(w)} connection(s) waiting on a reply`);
    if (snap !== last) still.push(`its counts still moving: ${snap}`);
    calm = !still.length ? calm + 1 : 0;
    last = snap;
  }
}

/** Moves the worker's fake clock `ms` on, then lets the worker settle. Items queued since are moved onto its board first. */
async function move(world: object, w: W, ms: number): Promise<void> {
  await rehome(world);
  await w.clock?.advance(ms);
  await settle(w);
  await rehome(world);
  await learnItems(world);
}

const standingBy = (w: W) => w.log.lines.some((l) => /another worker holds the (worker )?lock/i.test(l) && /stand(s|ing)? by/i.test(l));

async function fakeClock(at: string): Promise<FakeClock | undefined> {
  const mod = await load<{ fakeClock(start: Date): FakeClock }>("src/clock.ts");
  return mod?.fakeClock(new Date(at));
}

/** Waits for the first run of `job`, moving the worker's fake clock on a second at a time while it hasn't run. */
async function firstRun(w: W, job: Job): Promise<void> {
  if (!w.running) return;
  if (await within(2_000, () => count(w, job) >= 1)) return;
  for (let i = 0; i < 60 && count(w, job) < 1; i++) {
    await w.clock?.advance(1_000);
    await settle(w);
  }
  await until(`${SINGLE} runs its ${job}`, () => count(w, job) >= 1, 15_000);
}

/** Starts the single worker on `clock` and waits for its first tick. */
async function startTicked(world: object, clock: FakeClock | undefined, intervals: Start["intervals"] = {}): Promise<W> {
  const w = await start(world, { name: SINGLE, clock, intervals });
  if (w.running) {
    await until(`${SINGLE} ticks`, () => count(w, "scheduler tick") >= 1);
    w.firstTickAt ??= Date.now();
  }
  return w;
}

// ---- The heartbeat log ----

async function heartbeatTrigger(sleepS: number): Promise<void> {
  const p = need().pool;
  await p.query(`create or replace function pbi396_log() returns trigger language plpgsql security definer as $$
    declare began timestamptz := clock_timestamp();
    begin
      if tg_argv[0]::float > 0 then perform pg_sleep(tg_argv[0]::float); end if;
      insert into pbi396_heartbeat_log (ticked_at, began, finished) values (new.ticked_at, began, clock_timestamp());
      return new;
    end $$`);
  await p.query("drop trigger if exists pbi396_log on worker_heartbeat");
  await p.query(`create trigger pbi396_log before insert on worker_heartbeat for each row execute function pbi396_log('${sleepS}')`);
}

type Logged = { ticked_at: Date; began: Date; finished: Date };
const logged = async () =>
  (await need().pool.query<Logged>("select ticked_at, began, finished from pbi396_heartbeat_log order by n")).rows;

async function heartbeats(): Promise<number[]> {
  return (await need().pool.query<{ ticked_at: Date }>("select ticked_at from worker_heartbeat")).rows.map((r) => r.ticked_at.getTime());
}

// ---- Hooks ----

Before({ tags: "@pbi-396 and @db", ...long }, async function () {
  const d = await testDb();
  if (!d) return;
  await d.pool.query("delete from worker_heartbeat");
  await d.pool.query("create table if not exists pbi396_heartbeat_log (n bigserial primary key, ticked_at timestamptz, began timestamptz, finished timestamptz)");
  await d.pool.query("truncate pbi396_heartbeat_log");
  await heartbeatTrigger(0);
});

const bounded = (p: Promise<unknown> | undefined) => Promise.race([Promise.resolve(p).catch(() => undefined), sleep(10_000)]);

After({ tags: "@pbi-396 and @db", ...long }, async function () {
  const c = ctx(this);
  const c157 = w157(this);
  const all = [...new Set<Worker157>([...c157.workers, ...c.workers])];
  for (const w of all) await bounded(w.running?.stop());
  w156(this).worker = undefined;
  for (const w of all) {
    await w.proxy.close();
    await bounded(w.pool.end());
  }
  if (await testDb()) await need().pool.query("drop trigger if exists pbi396_log on worker_heartbeat");
});

// ---- Given ----

Given("a fake clock that reads {string}", long, async function (at: string) {
  const c = ctx(this);
  c.clock = await fakeClock(at);
  if (!c.clock) c.missing = "src/clock.ts doesn't exist";
});

Given(/^a worker on a fake clock, with its default intervals, has run its (scheduler tick|outbox loop|board poll|lock check) once$/, long, async function (job: Job) {
  const w = await startTicked(this, await fakeClock(DEFAULT_START));
  await firstRun(w, job);
});

Given(/^a worker on (a fake clock|that clock), with its default intervals, has started and ticked once$/, long, async function (which: string) {
  await startTicked(this, which === "that clock" ? ctx(this).clock : await fakeClock(DEFAULT_START));
});

When("a worker on that clock, with its default intervals, starts and ticks once", long, async function () {
  await startTicked(this, ctx(this).clock);
});

Given(/^a worker on (a fake clock|that clock), with a (\d+)-second tick whose ticks await the database, has started and ticked once$/, long, async function (which: string, s: string) {
  await startTicked(this, which === "that clock" ? ctx(this).clock : await fakeClock(DEFAULT_START), { tickMs: Number(s) * 1_000 });
});

Given("a worker on a fake clock, with a {int}-second tick whose ticks each wait half a real second on the database, has started and ticked once", long, async function (s: number) {
  await heartbeatTrigger(0.5);
  await startTicked(this, await fakeClock(DEFAULT_START), { tickMs: s * 1_000 });
});

Given("a worker on a fake clock, with a {int}-second tick and its default outbox and poll intervals, has started and run each job once", long, async function (s: number) {
  const w = await startTicked(this, await fakeClock(DEFAULT_START), { tickMs: s * 1_000 });
  for (const job of ["scheduler tick", "outbox loop", "board poll"] as const) await firstRun(w, job);
});

Given("a second worker on a fake clock, with its default intervals, has started beside it and is standing by", long, async function () {
  const w = await start(this, { name: "second", clock: await fakeClock(DEFAULT_START) });
  if (w.running) await until("the second worker says it is standing by", () => standingBy(w), 10_000);
});

// ---- When ----

When("a worker given no clock and no intervals starts and ticks once", long, async function () {
  const w = await startTicked(this, undefined);
  for (const job of ["outbox loop", "board poll"] as const) await firstRun(w, job);
});

When("a second worker given no clock and no intervals starts beside it", long, async function () {
  const w = await start(this, { name: "second" });
  if (w.running) await within(10_000, () => standingBy(w));
});

When("the worker settles with the fake clock standing still", long, async function () {
  await settle(single(this));
});

When("the second worker settles with its fake clock standing still", long, async function () {
  await settle(second(this));
});

When(/^the fake clock moves (.+) on$/, long, async function (text: string) {
  const w = single(this);
  await move(this, w, duration(text));
});

When(/^the second worker's fake clock moves (.+) on$/, long, async function (text: string) {
  await move(this, second(this), duration(text));
});

When("the second worker's lock connection is ended by Postgres", long, async function () {
  const w = second(this);
  // A standby holds no advisory lock, so its lock session is the one of its sessions whose last query tried for it.
  const pids = (await need().pool.query<{ pid: number }>(
    "select pid from pg_stat_activity where application_name = $1 and query ilike '%pg_try_advisory_lock%'", [w.app])).rows.map((r) => r.pid);
  if (!pids.length) {
    w157(this).noLock = "the second worker had no session that tried for the worker lock";
    return;
  }
  w157(this).stoppedAt = Date.now();
  w157(this).stoppedMoved = moved(this);
  await terminate(pids);
});

// ---- Then ----

function noRealTimer(world: object, w: W, label: string): void {
  started(world, w);
  const set = realTimers(w.tag);
  assert.deepEqual(set.map((t) => `${t.kind}(${t.ms} ms) from ${t.caller}`), [], `${label} set timers on the real clock`);
}

Then("the worker has set no timer on the real clock", function () {
  noRealTimer(this, single(this), SINGLE);
});

Then("the second worker has set no timer on the real clock", function () {
  noRealTimer(this, second(this), "the second worker");
});

Then(/^the worker has run its (scheduler tick|outbox loop|board poll|lock check) (\d+) times?$/, function (job: Job, n: string) {
  const w = single(this);
  started(this, w);
  assert.equal(count(w, job), Number(n), `the worker has run its ${job} ${count(w, job)} time(s)`);
});

Then(/^the second worker has tried for the worker lock (\d+) times?$/, function (n: string) {
  const w = second(this);
  started(this, w);
  assert.equal(tries(w), Number(n), `the second worker tried for the worker lock ${tries(w)} time(s)`);
});

Then("the second worker is still standing by", long, async function () {
  const w = second(this);
  started(this, w);
  assert.equal(w.exit, undefined, `the second worker exited: ${String(w.exit?.error)}`);
  assert.ok(!w.log.lines.some((l) => TOOK.test(l)), "the second worker's log says it took the lock");
  assert.deepEqual(await lockSessions(w.app), [], "the second worker holds the worker lock");
  assert.equal(count(w, "scheduler tick"), 0, "the second worker ticked");
});

Then("the second worker launched a cell for item {string}", function (name: string) {
  const w = second(this);
  started(this, w);
  const id = p17(this).items[name];
  assert.ok(id, `item ${name} was never queued`);
  assert.ok(w.launched.includes(id), `the second worker didn't launch item ${name}'s cell`);
});

async function tookLock(world: object, deadline: number): Promise<void> {
  const w = second(world);
  started(world, w);
  const ok = await within(Math.max(deadline - Date.now(), 0), () => w.log.lines.some((l) => TOOK.test(l)));
  assert.ok(ok, `the second worker's log doesn't say it took the lock: ${JSON.stringify(w.log.lines)}`);
}

Then("within {int} real seconds of the first worker stopping, the second worker's log records that it took the lock", long, async function (s: number) {
  const at = w157(this).stoppedAt;
  assert.ok(at !== undefined, "the first worker never stopped");
  await tookLock(this, at + s * 1_000);
});

Then("within {int} real seconds the second worker's log records that it took the lock", long, async function (s: number) {
  await tookLock(this, Date.now() + s * 1_000);
});

Then("within {int} real seconds the worker exits with an error saying it lost the worker lock", long, async function (s: number) {
  const w = single(this);
  started(this, w);
  const c157 = w157(this);
  if (c157.noLock) assert.fail(c157.noLock);
  const deadline = (c157.stoppedAt ?? Date.now()) + s * 1_000;
  assert.ok(await within(Math.max(deadline - Date.now(), 0), () => w.exit !== undefined), "the worker kept running after its lock connection closed");
  assert.match(String((w.exit!.error as Error | undefined)?.message), /lost the worker lock/);
});

Then("within {int} real seconds the second worker exits with an error saying its lock connection closed while it stood by", long, async function (s: number) {
  const w = second(this);
  started(this, w);
  const c157 = w157(this);
  if (c157.noLock) assert.fail(c157.noLock);
  const deadline = (c157.stoppedAt ?? Date.now()) + s * 1_000;
  assert.ok(await within(Math.max(deadline - Date.now(), 0), () => w.exit !== undefined), "the second worker kept running after its lock connection closed");
  assert.match(String((w.exit!.error as Error | undefined)?.message), /lock connection closed while it stood by/);
});

Then("the heartbeat shows {string}", long, async function (at: string) {
  started(this, single(this));
  const rows = await heartbeats();
  assert.equal(rows.length, 1, `the factory has ${rows.length} worker heartbeats, not one`);
  assert.equal(iso(rows[0]), new Date(at).toISOString());
});

Then("the heartbeat shows a time within {int} seconds of the real time of the worker's tick", long, async function (s: number) {
  const w = single(this);
  started(this, w);
  const rows = await heartbeats();
  assert.equal(rows.length, 1, `the factory has ${rows.length} worker heartbeats, not one`);
  assert.ok(w.firstTickAt !== undefined, "the worker never ticked");
  assert.ok(Math.abs(rows[0] - w.firstTickAt) <= s * 1_000, `the heartbeat shows ${iso(rows[0])}, and the worker ticked at ${iso(w.firstTickAt)}`);
});

Then("the ticks after the first started at {int}-second steps from {string} to {string}", long, async function (s: number, from: string, to: string) {
  started(this, single(this));
  const want: string[] = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += s * 1_000) want.push(iso(t));
  const got = (await logged()).map((r) => iso(r.ticked_at.getTime()));
  assert.deepEqual(got.slice(1), want);
});

Then("no tick started before the tick ahead of it had finished", long, async function () {
  started(this, single(this));
  const rows = await logged();
  assert.ok(rows.length > 1, `the worker logged ${rows.length} tick(s)`);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].began.getTime() >= rows[i - 1].finished.getTime(),
      `tick ${i + 1} (${iso(rows[i].ticked_at.getTime())}) wrote its heartbeat at ${rows[i].began.toISOString()}, before tick ${i} finished at ${rows[i - 1].finished.toISOString()}`);
  }
});

/** The timers the worker set on the real clock for its jobs. A slow-work warning's timer (PBI 134) isn't one. */
const jobTimers = (w: W) => realTimers(w.tag).filter((t) => !/slow-work\.ts/.test(t.stack));

Then("the worker has asked the real clock for these timers:", function (table: DataTable) {
  const w = single(this);
  started(this, w);
  const asked = jobTimers(w).map((t) => t.ms);
  for (const row of table.hashes()) {
    const ms = Number(/^(\d+) ms$/.exec(row.every)?.[1]);
    assert.ok(asked.includes(ms), `the worker asked the real clock for no ${row.every} timer for its ${row.job}: it asked for ${JSON.stringify(asked)}`);
  }
});

Then("the second worker has asked the real clock for a lock retry timer of {int} ms", function (ms: number) {
  const w = second(this);
  started(this, w);
  const asked = jobTimers(w).map((t) => t.ms);
  assert.ok(asked.includes(ms), `the second worker asked the real clock for ${JSON.stringify(asked)}`);
});

Then("the second worker's log records that another worker holds the lock and it tries again every {int} seconds", long, async function (s: number) {
  const w = second(this);
  started(this, w);
  const ok = await within(5_000, () => w.log.lines.some((l) => /another worker holds the (worker )?lock/i.test(l) && new RegExp(`tries again every ${s} seconds`, "i").test(l)));
  assert.ok(ok, `the second worker's log says nothing of trying again every ${s} seconds: ${JSON.stringify(w.log.lines)}`);
});

// ---- @ac-5: PBI 157's, PBI 158's and PBI 376's own scenarios ----

/** The SHA-256 of each feature file as it was on main before this item, at c753db6, with LF line ends. */
export const ON_MAIN: Record<number, { file: string; sha256: string }> = {
  157: { file: "features/pbi-157-worker-lock.feature", sha256: "9c1996012e238cdb3c0c65851678689abdc2b7c05989617f2ef8fe4ddf72cd48" },
  158: { file: "features/pbi-158-worker-heartbeat.feature", sha256: "e293b437d35182eb9dab71e8ebd1e6b89a94aa85957c996eb5b1178895c8c158" },
};

export function featureFiles(pbi: number): string[] {
  const files = readdirSync("features").filter((f) => f.startsWith(`pbi-${pbi}-`) && f.endsWith(".feature")).map((f) => join("features", f));
  assert.ok(files.length, `PBI ${pbi} has no feature file`);
  return files;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Runs cucumber-js as `npm run bdd` does, but with its message report in a temp file, and reads that report. */
export async function runSuite(world: object, files: string[], extra: string[], recordTimers: boolean): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "pbi396-suite-"));
  const report = join(dir, "report.ndjson");
  const timers = join(dir, "timers.ndjson");
  const args = cucumberArgs(DEFAULT_WORKERS, [...files, ...extra]).map((a) => (a === "message:reports/bdd.ndjson" ? `message:${report}` : a));
  const bin = join(process.cwd(), "node_modules", "@cucumber", "cucumber", "bin", "cucumber.js");
  const env = { ...process.env, ...(recordTimers ? { PBI396_REAL_TIMERS: timers } : {}) };
  const child = spawn(process.execPath, [bin, ...args], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  for (const s of [child.stdout, child.stderr]) s.on("data", (b: Buffer) => void (out += b.toString()));
  const code = await new Promise<number | null>((resolve) => child.on("close", (c) => resolve(c)));
  const suite: Suite = { code, out, cases: [], pickles: 0 };
  if (existsSync(report)) {
    const pickles = new Map<string, { name: string; uri: string; steps: Set<string>; texts: string[] }>();
    const cases = new Map<string, { pickleId: string; stepIds: Set<string> }>();
    const started = new Map<string, Case & { stepIds: Set<string> }>();
    for (const line of readFileSync(report, "utf8").split("\n").filter(Boolean)) {
      const m = JSON.parse(line);
      if (m.pickle) pickles.set(m.pickle.id, { name: m.pickle.name, uri: m.pickle.uri, steps: new Set(m.pickle.steps.map((s: { id: string }) => s.id)), texts: m.pickle.steps.map((s: { text: string }) => s.text) });
      if (m.testCase) {
        cases.set(m.testCase.id, {
          pickleId: m.testCase.pickleId,
          stepIds: new Set(m.testCase.testSteps.filter((s: { pickleStepId?: string }) => s.pickleStepId).map((s: { id: string }) => s.id)),
        });
      }
      if (m.testCaseStarted) {
        const tc = cases.get(m.testCaseStarted.testCaseId)!;
        const p = pickles.get(tc.pickleId)!;
        started.set(m.testCaseStarted.id, { name: p.name, uri: p.uri, statuses: [], stepMs: 0, stepIds: tc.stepIds, pickleId: tc.pickleId, steps: p.texts });
      }
      if (m.testStepFinished) {
        const k = started.get(m.testStepFinished.testCaseStartedId);
        if (!k) continue;
        const r = m.testStepFinished.testStepResult;
        k.statuses.push(r.status);
        if (k.stepIds.has(m.testStepFinished.testStepId)) {
          k.stepMs += (Number(r.duration?.seconds ?? 0) * 1_000) + Number(r.duration?.nanos ?? 0) / 1e6;
        }
      }
      if (m.testCaseFinished?.willBeRetried === false) {
        const k = started.get(m.testCaseFinished.testCaseStartedId);
        if (k) suite.cases.push({ name: k.name, uri: k.uri, statuses: k.statuses, stepMs: k.stepMs, pickleId: k.pickleId, steps: k.steps });
      }
    }
    // cucumber-js reports a pickle for every scenario in the files it reads, and a test case only for each one its
    // --tags and --name select, so the test cases are the scenarios selected.
    suite.pickles = cases.size;
  }
  if (recordTimers) suite.timers = existsSync(timers) ? readFileSync(timers, "utf8").split("\n").filter(Boolean) : [];
  rmSync(dir, { recursive: true, force: true });
  ctx(world).suite = suite;
}

const failed = (k: Case) => k.statuses.some((s) => s !== "PASSED");
const tail = (s: Suite) => s.out.slice(-4_000);

export function suiteOf(world: object): Suite {
  const s = ctx(world).suite;
  assert.ok(s, "no scenario was run");
  return s;
}

When("the owner runs PBI {int}'s scenario {string}", SUITE, async function (pbi: number, name: string) {
  await runSuite(this, featureFiles(pbi), ["--name", `^${escape(name)}$`], false);
});

When("the owner runs every scenario of PBI {int} and PBI {int} not tagged @local", SUITE, async function (a: number, b: number) {
  await runSuite(this, [...featureFiles(a), ...featureFiles(b)], ["--tags", "not @local"], true);
});

When("the owner runs every scenario of PBI {int} not tagged @local", SUITE, async function (pbi: number) {
  await runSuite(this, featureFiles(pbi), ["--tags", "not @local"], false);
});

When("the owner runs every scenario of PBI {int}", SUITE, async function (pbi: number) {
  await runSuite(this, featureFiles(pbi), [], false);
});

Then("the scenario passes", function () {
  const s = suiteOf(this);
  // A Scenario Outline runs once for each of its examples, all under the scenario's one name (PBI 283).
  assert.ok(s.cases.length > 0, `no scenario ran: ${tail(s)}`);
  const named = new Set(s.cases.map((k) => k.name));
  assert.equal(named.size, 1, `${named.size} scenarios ran, not one: ${JSON.stringify([...named])}`);
  const bad = s.cases.filter(failed).map((k) => JSON.stringify(k.statuses));
  assert.deepEqual(bad, [], `the scenario didn't pass: ${tail(s)}`);
});

Then("its steps took less than {int} real seconds in all", function (n: number) {
  const s = suiteOf(this);
  assert.equal(s.cases.length, 1, `${s.cases.length} scenarios ran, not one`);
  assert.ok(s.cases[0].stepMs < n * 1_000, `its steps took ${(s.cases[0].stepMs / 1_000).toFixed(1)} real seconds`);
});

Then("every scenario passes", function () {
  const s = suiteOf(this);
  assert.ok(s.cases.length > 0, `no scenario ran: ${tail(s)}`);
  const bad = s.cases.filter(failed).map((k) => `${k.name}: ${JSON.stringify(k.statuses)}`);
  assert.deepEqual(bad, [], `scenarios that didn't pass: ${tail(s)}`);
  assert.equal(s.code, 0, `cucumber-js exited with code ${s.code}: ${tail(s)}`);
});

Then("no scenario was skipped or left undefined", function () {
  const s = suiteOf(this);
  assert.equal(s.cases.length, s.pickles, `${s.pickles} scenarios were selected and ${s.cases.length} ran`);
  const bad = s.cases.filter((k) => k.statuses.some((st) => ["SKIPPED", "UNDEFINED", "PENDING", "AMBIGUOUS", "UNKNOWN"].includes(st)));
  assert.deepEqual(bad.map((k) => `${k.name}: ${JSON.stringify(k.statuses)}`), []);
});

Then("every worker their steps started in the test's own process was started on a fake clock", function () {
  const s = suiteOf(this);
  const lines = (s.timers ?? []).map((l) => JSON.parse(l) as { installed?: number; kind?: string; ms?: number; caller?: string });
  assert.ok(lines.some((l) => l.installed), "the run's processes never installed the real timer spy");
  const real = lines.filter((l) => l.kind).map((l) => `${l.kind}(${l.ms} ms) from ${l.caller}`);
  assert.deepEqual([...new Set(real)], [], "the factory's code set timers on the real clock in the test's own process");
});

Then("the feature file of PBI {int} is the same as on main before this item", function (pbi: number) {
  const want = ON_MAIN[pbi];
  assert.ok(want, `this file holds no copy of PBI ${pbi}'s feature file from main`);
  assert.ok(existsSync(want.file), `${want.file} is gone`);
  const text = readFileSync(want.file, "utf8").replaceAll("\r\n", "\n");
  assert.equal(createHash("sha256").update(text).digest("hex"), want.sha256, `${want.file} has changed since main`);
});
