// Step definitions for features/pbi-157-worker-lock.feature. The workers run in this process from src/worker/main.ts,
// on PBI 4's shared test database, beside PBI 17's items and PBI 156's board.
//
// Each worker has a pool of its own. The pool's connections reach Postgres through a TCP proxy this file runs, and
// each one carries an application_name that names its worker. That lets a step find the worker's sessions in
// pg_stat_activity, and its lock session as the one of them holding a granted advisory lock in pg_locks. The worker
// opens its lock connection with its pool's settings, so that session carries the same name. A step can then end a
// session as an administrator would, with pg_terminate_backend, or cut the worker's connections at the proxy, as a lost
// network would.
//
// Each worker gets its own launcher, judge and recording view of the board, so a step can tell which worker did the
// work. They all record into PBI 17's context too, so its item and cell steps still hold. The one worker of the @ac-2
// scenarios is PBI 156's, started by its steps, with this file's pool, log and poll interval put in its deps.
//
// startWorker returns while a worker stands by. Worker.done settles when the worker stops, and rejects when it loses
// the worker lock.
//
// PBI 158's steps run these hooks and workers too, so the hooks run for @pbi-158, and its steps reach this file's context.
//
// Tick intervals differ by worker, and a step that starts a worker returns just after the worker already running has
// ticked. So until the lock keeps a second worker idle, the newest worker is the one that claims the next queued item,
// and a scenario that says it claims nothing fails on its Then.
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import net from "node:net";
import { format } from "node:util";
import type pg from "pg";
import type { BacklogAdapter, FactoryItem } from "../../src/adapters/types.ts";
import type { Policy } from "../../src/policy/policy.ts";
import { createPool } from "../../src/store/db.ts";
import { load, long, need, testDb } from "./pbi-8.steps.ts";
import { ctx as p17 } from "./pbi-17.steps.ts";
import { board, ctx as w156, fakes, learnItems, rehome, type Running, startWorker as startWorker156 } from "./pbi-156.steps.ts";

const REPO = "ricksu978/software-factory";
/** Each worker's tick interval, by the order it started in: each one ticks faster than the one before it. */
const TICK_MS = [3_000, 1_500, 300];
const SLOWEST_TICK_MS = Math.max(...TICK_MS);
const POLL_MS = 1_000;
/** How long a step waits for a worker that loses its lock connection to exit. */
const EXIT_WITHIN_MS = 15_000;

type Proxy = { port: number; cut(): void; refuse(): void; close(): Promise<void> };
type Log = { lines: string[]; sink: Pick<Console, "log" | "warn" | "error"> };
type Exit = { error?: unknown };

export type Worker = {
  name: string;
  app: string;
  pool: pg.Pool;
  proxy: Proxy;
  log: Log;
  /** The ids of the items whose cells this worker's launcher started. */
  launched: string[];
  /** How many times this worker listed the board's eligible items, which is a poll. */
  polls: number;
  judged: string[];
  tickMs: number;
  running?: Running;
  startError?: unknown;
  exit?: Exit;
  /** What the "has launched no cell" and "has never polled the board" steps saw. */
  launchedBefore?: string[];
  polledBefore?: number;
  /** Stopped or dead, so no step waits for its ticks. */
  stopped?: boolean;
};

type Ctx = {
  workers: Worker[];
  /** The one worker of the @ac-2 scenarios, which PBI 156's steps start. */
  single?: { app: string; pool: pg.Pool; proxy: Proxy; log: Log; exit?: Exit };
  /** When the first worker stopped or died, or when its lock connection ended. */
  stoppedAt?: number;
  /** The single worker's board polls when its lock connection ended. */
  pollsAtLoss?: number;
  /** A lock-ending step found no session holding the worker lock. */
  noLock?: string;
  proc?: { child: ChildProcess; output: string[]; code?: number | null; signal?: NodeJS.Signals | null; exited: Promise<void> };
  missing?: string;
  /** How many workers have been started, counting those still starting. */
  reserved?: number;
  /** Deps another feature's steps add to each worker's, by the worker's name, as PBI 158's steps add a clock. */
  deps?: (name: string) => Record<string, unknown>;
};

export function ctx(world: object): Ctx {
  const w = world as { pbi157?: Ctx };
  w.pbi157 ??= { workers: [] };
  return w.pbi157;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await ok())) {
    assert.ok(Date.now() < end, `timed out waiting until ${what}`);
    await sleep(25);
  }
}

/** Whether `ok` holds within `ms`, without failing. */
async function within(ms: number, ok: () => boolean | Promise<boolean>): Promise<boolean> {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() >= end) return false;
    await sleep(25);
  }
  return true;
}

// ---- The database: each worker's own pool, through a proxy ----

async function dbUrl(): Promise<string> {
  const d = await testDb();
  assert.ok(d, "src/store/test-db.ts doesn't exist");
  return (d as unknown as { url: string }).url;
}

type Parts = { user: string; password: string; host: string; port: string; database: string; params: URLSearchParams };

/**
 * The parts of the test database's URL: postgresql://user@/db?host=<socket dir> from a local server, or
 * postgres://user:password@host:port/db from Testcontainers. WHATWG's URL rejects the first, so it's read here.
 */
function parts(url: string): Parts {
  const m = /^postgres(?:ql)?:\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^/?:]*)(?::(\d+))?\/([^?]*)(?:\?(.*))?$/.exec(url);
  assert.ok(m, "the test database's URL has a shape this file doesn't read");
  const [, user = "", password = "", host, port = "", database, query = ""] = m;
  return { user, password, host, port, database, params: new URLSearchParams(query) };
}

/** Where the test database listens: a Unix socket in a cell, a TCP port under Testcontainers. */
function upstream(url: string): net.NetConnectOpts {
  const u = parts(url);
  const socketDir = u.params.get("host");
  if (socketDir) return { path: `${socketDir}/.s.PGSQL.${u.port || 5432}` };
  return { host: u.host, port: Number(u.port || 5432) };
}

/** A TCP proxy to the test database whose connections a step can cut, as a lost network would. */
async function startProxy(url: string): Promise<Proxy> {
  const pairs = new Set<[net.Socket, net.Socket]>();
  let refusing = false;
  const server = net.createServer((client) => {
    if (refusing) return void client.resetAndDestroy();
    const up = net.connect(upstream(url));
    const pair: [net.Socket, net.Socket] = [client, up];
    pairs.add(pair);
    const close = () => {
      pairs.delete(pair);
      client.destroy();
      up.destroy();
    };
    for (const s of pair) {
      s.on("error", close);
      s.on("close", close);
    }
    client.pipe(up);
    up.pipe(client);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  const cut = () => {
    for (const [client, up] of [...pairs]) {
      client.resetAndDestroy();
      up.destroy();
    }
  };
  return {
    port,
    cut,
    refuse() {
      refusing = true;
    },
    async close() {
      refusing = true;
      cut();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The test database's URL through `port`, with `app` as each connection's application_name. */
function proxied(url: string, port: number, app: string): string {
  const u = parts(url);
  const auth = u.user ? `${u.user}${u.password ? `:${u.password}` : ""}@` : "";
  return `postgresql://${auth}127.0.0.1:${port}/${u.database}?application_name=${encodeURIComponent(app)}`;
}

/** The test database's URL, unchanged but for `app` as each connection's application_name. */
function named(url: string, app: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}application_name=${encodeURIComponent(app)}`;
}

function logger(name: string): Log {
  const lines: string[] = [];
  const line = (k: "log" | "warn" | "error") => (...args: unknown[]) => {
    const l = format(...args);
    lines.push(l);
    console[k](`[${name}]`, l);
  };
  return { lines, sink: { log: line("log"), warn: line("warn"), error: line("error") } };
}

async function ownPool(name: string): Promise<{ app: string; pool: pg.Pool; proxy: Proxy }> {
  const url = await dbUrl();
  const app = `pbi157-${name.replaceAll(" ", "-")}-${crypto.randomUUID().slice(0, 8)}`;
  // Read before the proxy listens, so a URL this file can't read leaves no proxy behind.
  parts(url);
  const proxy = await startProxy(url);
  return { app, pool: createPool(proxied(url, proxy.port, app)), proxy };
}

const pool = () => need().pool;

/** The pids of `app`'s sessions that hold a granted advisory lock: its lock session, once it holds the worker lock. */
async function lockSessions(app: string): Promise<number[]> {
  return (await pool().query<{ pid: number }>(
    `select distinct l.pid from pg_locks l join pg_stat_activity a on a.pid = l.pid
     where l.locktype = 'advisory' and l.granted and a.application_name = $1`, [app])).rows.map((r) => r.pid);
}

async function terminate(pids: number[]): Promise<void> {
  if (pids.length) await pool().query("select pg_terminate_backend(pid) from unnest($1::int[]) as pid", [pids]);
}

// ---- Workers ----

/** Records how the worker settles: an error once it lost the lock. Attached as early as a step can. */
const watched = new WeakSet<Running>();
function watch(running: Running | undefined, into: { exit?: Exit }): void {
  if (!running?.done || watched.has(running)) return;
  watched.add(running);
  running.done.then(() => void (into.exit = {}), (error: unknown) => void (into.exit = { error }));
}

/** A recording view of the scenario's one board, so each worker's polls are its own. */
function view(adapter: BacklogAdapter, w: Worker): BacklogAdapter {
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        if (prop === "listEligible") w.polls++;
        return v.apply(target, args);
      };
    },
  });
}

function judge(world: object, w: Worker) {
  return async (item: FactoryItem, dor: Policy): Promise<string> => {
    w.judged.push(item.externalId);
    const ready = w156(world).verdicts.get(item.externalId) ?? true;
    const lines = dor.criteria.map((cr, i) => JSON.stringify({ index: cr.index, status: ready || i > 0 ? "passed" : "failed", reason: ready ? "ok" : "not ready" }));
    return [...lines, '{"flags":[]}'].join("\n");
  };
}

const ordinal = ["first", "second", "third"];
const ticks = (w: Worker) => w.running?.runs.get("scheduler tick") ?? 0;
const worker = (world: object, name: string) => {
  const w = ctx(world).workers.find((x) => x.name === name);
  assert.ok(w, `no ${name} worker was started`);
  return w;
};

/** Starts the next worker with fakes of its own. It returns once startWorker does, which a standby's does at once. */
async function startOne(world: object): Promise<Worker> {
  const c = ctx(world);
  // Its place is taken before the first await, so workers started together each get their own.
  const i = c.reserved = (c.reserved ?? 0) + 1;
  const name = ordinal[i - 1];
  const own = await ownPool(name);
  const w: Worker = { name, ...own, log: logger(`${name} worker`), launched: [], polls: 0, judged: [], tickMs: TICK_MS[i - 1] };
  c.workers.push(w);
  c.workers.sort((a, b) => ordinal.indexOf(a.name) - ordinal.indexOf(b.name));
  const mod = await load<{ startWorker(d: object): Promise<Running> }>("src/worker/main.ts");
  if (!mod) {
    c.missing = "src/worker/main.ts doesn't exist";
    return w;
  }
  p17(world).ticked = true;
  const base = await fakes(world);
  const theBoard = await board(world);
  const s = p17(world);
  try {
    w.running = await mod.startWorker({
      ...base,
      pool: w.pool,
      sources: [{ id: theBoard.id, adapter: view(theBoard.fake.adapter, w) }],
      launcher: {
        async start(env: Record<string, string>) {
          s.started.push(env);
          w.launched.push(env.ITEM_ID);
          return `${name}-cell-${w.launched.length}`;
        },
        async stop(cell: string) {
          s.stopped.push(cell);
        },
      },
      judge: judge(world, w),
      tickMs: w.tickMs,
      pollMs: POLL_MS,
      log: w.log.sink,
      ...c.deps?.(name),
    });
    watch(w.running, w);
  } catch (e) {
    w.startError = e;
  }
  return w;
}

/** Waits for the worker to tick and poll the board. */
async function busy(w: Worker): Promise<void> {
  if (!w.running) return;
  await until(`the ${w.name} worker ticks and polls the board`, () => ticks(w) >= 1 && w.polls >= 1);
}

/**
 * Waits for the next tick of the earliest-started worker that is working to end, so an item queued straight after
 * waits a whole tick interval for it. A worker that has never ticked isn't waited for.
 */
async function afterWorkingTick(world: object): Promise<void> {
  const w = ctx(world).workers.find((x) => x.running && !x.exit && ticks(x) > 0 && !x.stopped);
  if (!w) return;
  const n = ticks(w);
  await until(`the ${w.name} worker ticks again`, () => ticks(w) > n, w.tickMs * 3 + 5_000);
}

async function runFor(world: object, ms: number): Promise<void> {
  await rehome(world);
  await sleep(ms);
  await rehome(world);
  await learnItems(world);
}

/** Fails when the worker module is missing, or when any worker threw at start, so a crashed worker never passes for an idle standby. */
function started(c: Ctx): void {
  if (c.missing) assert.fail(c.missing);
  const crashed = c.workers.find((w) => w.startError !== undefined);
  if (crashed) {
    const e = crashed.startError;
    assert.fail(`the ${crashed.name} worker failed to start: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  }
}

// ---- Hooks ----

Before({ tags: "@pbi-157 or @pbi-158", ...long }, async function () {
  const c = ctx(this);
  const own = await ownPool("the worker");
  c.single = { ...own, log: logger("the worker") };
  // PBI 156's steps start the @ac-2 scenarios' worker with these in its deps.
  // PBI 158's steps put a clock of their own in these deps too, so they're added to, not replaced.
  w156(this).deps = { ...w156(this).deps, pool: own.pool, pollMs: POLL_MS, log: c.single.log.sink };
});

const bounded = (p: Promise<unknown> | undefined) => Promise.race([Promise.resolve(p).catch(() => undefined), sleep(10_000)]);

After({ tags: "@pbi-157 or @pbi-158", ...long }, async function () {
  const c = ctx(this);
  const single = w156(this).worker;
  if (single && c.single) watch(single, c.single);
  for (const w of c.workers) await bounded(w.running?.stop());
  await bounded(single?.stop());
  w156(this).worker = undefined;
  if (c.proc && c.proc.code === undefined) {
    c.proc.child.kill("SIGKILL");
    await bounded(c.proc.exited);
  }
  for (const p of [...c.workers, ...(c.single ? [c.single] : [])]) {
    await p.proxy.close();
    await bounded(p.pool.end());
  }
});

// ---- Given ----

Given("the first worker is running and has ticked once", long, async function () {
  await busy(await startOne(this));
});

Given("the first worker is running and has polled the board once", long, async function () {
  await busy(await startOne(this));
});

Given("the first worker is running", long, async function () {
  await busy(await startOne(this));
});

Given("a second worker has started beside it", long, async function () {
  await startOne(this);
  await afterWorkingTick(this);
});

// What the worker has done by now. The Then that follows checks it, so a worker that already worked fails there.
Given("the second worker has launched no cell", function () {
  const w = worker(this, "second");
  w.launchedBefore = [...w.launched];
});

Given("the second worker has never polled the board", function () {
  const w = worker(this, "second");
  w.polledBefore = w.polls;
});

Given("the first worker has stopped and the second worker has taken over", long, async function () {
  const c = ctx(this);
  const first = worker(this, "first");
  const second = worker(this, "second");
  if (!first.running || !second.running) return;
  await first.running.stop();
  first.stopped = true;
  c.stoppedAt = Date.now();
  // A standby counts no tick until it takes the lock, so a tick after the stop means it has taken over.
  const n = ticks(second);
  await until("the second worker ticks after the first one stopped", () => ticks(second) > n);
});

Given("the worker is running and has polled the board once", long, async function () {
  await startWorker156(this, 1);
  const c = ctx(this);
  watch(w156(this).worker, c.single!);
});

Given("the worker is running as its own process", long, async function () {
  const c = ctx(this);
  const app = `pbi157-process-${crypto.randomUUID().slice(0, 8)}`;
  const theBoard = await board(this);
  const child = spawn(process.execPath, ["features/fixtures/pbi-157-worker-process.ts"], {
    env: { ...process.env, FACTORY_DB_URI: named(await dbUrl(), app), SOURCE_ID: theBoard.id },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output: string[] = [];
  const proc: NonNullable<Ctx["proc"]> = {
    child, output,
    exited: new Promise<void>((resolve) => child.on("exit", (code, signal) => {
      proc.code = code;
      proc.signal = signal;
      resolve();
    })),
  };
  c.proc = proc;
  // The lock-ending steps find the worker's sessions by this name.
  c.single!.app = app;
  for (const s of [child.stdout, child.stderr]) s.on("data", (b: Buffer) => output.push(b.toString()));
  await until("the worker's process runs its first scheduler tick", () => {
    assert.equal(proc.code, undefined, `the worker's process exited with code ${proc.code}: ${output.join("")}`);
    return /first scheduler tick/.test(output.join(""));
  });
});

// ---- When ----

When("a second worker starts", long, async function () {
  await startOne(this);
  await afterWorkingTick(this);
});

When("a third worker starts", long, async function () {
  await startOne(this);
  await afterWorkingTick(this);
});

When("three workers start at the same time", long, async function () {
  await rehome(this);
  // Each has its pool and proxy first, so the three startWorker calls go out together.
  const c = ctx(this);
  const mod = await load<object>("src/worker/main.ts");
  if (!mod) {
    c.missing = "src/worker/main.ts doesn't exist";
    return;
  }
  await Promise.all([startOne(this), startOne(this), startOne(this)]);
});

When("both workers have run for longer than one scheduler tick", long, async function () {
  await runFor(this, SLOWEST_TICK_MS + 1_000);
});

When("all three have run for longer than one scheduler tick", long, async function () {
  await runFor(this, SLOWEST_TICK_MS + 1_000);
});

When("the workers have run for longer than one scheduler tick", long, async function () {
  await runFor(this, SLOWEST_TICK_MS + 1_000);
});

When("both workers have run for longer than one board poll", long, async function () {
  await runFor(this, POLL_MS + 1_000);
});

When("both workers have run for {int} seconds", long, async function (s: number) {
  await runFor(this, s * 1_000);
});

When("the first worker stops", long, async function () {
  const c = ctx(this);
  const first = worker(this, "first");
  await first.running?.stop();
  first.stopped = true;
  c.stoppedAt = Date.now();
});

When("the first worker dies without stopping cleanly, so Postgres ends its sessions", long, async function () {
  const c = ctx(this);
  const first = worker(this, "first");
  // A dead process opens no connection, so the proxy refuses its pool from here on.
  first.proxy.refuse();
  first.stopped = true;
  const pids = (await pool().query<{ pid: number }>("select pid from pg_stat_activity where application_name = $1", [first.app])).rows.map((r) => r.pid);
  await terminate(pids);
  c.stoppedAt = Date.now();
});

/** Ends the worker's lock session as an administrator would. A worker that holds no lock is noted for the Then. */
async function endLock(world: object, app: string, who: string): Promise<void> {
  const c = ctx(world);
  const pids = await lockSessions(app);
  if (!pids.length) {
    c.noLock = `the ${who} held no advisory lock on a connection of its own`;
    return;
  }
  await terminate(pids);
}

async function singleLost(world: object): Promise<void> {
  const c = ctx(world);
  watch(w156(world).worker, c.single!);
  c.pollsAtLoss = (await board(world)).calls.filter((call) => call.method === "listEligible").length;
  c.stoppedAt = Date.now();
}

When("the worker's lock connection is ended by Postgres on an administrator's order", long, async function () {
  await singleLost(this);
  await endLock(this, ctx(this).single!.app, "worker");
});

When("the worker's lock connection is ended by Postgres", long, async function () {
  await singleLost(this);
  await endLock(this, ctx(this).single!.app, "worker");
});

When("the worker's lock connection is closed by a lost network connection", long, async function () {
  const c = ctx(this);
  await singleLost(this);
  // Every connection of the worker goes down at once, its lock connection with them.
  if (!(await lockSessions(c.single!.app)).length) c.noLock = "the worker held no advisory lock on a connection of its own";
  c.single!.proxy.cut();
});

When("the first worker's lock connection is ended by Postgres", long, async function () {
  const c = ctx(this);
  c.stoppedAt = Date.now();
  await endLock(this, worker(this, "first").app, "first worker");
});

When("Postgres ends one of the worker's other idle connections", long, async function () {
  const c = ctx(this);
  watch(w156(this).worker, c.single!);
  let pid: number | undefined;
  await until("the worker has an idle connection besides its lock connection", async () => {
    pid = (await pool().query<{ pid: number }>(
      `select pid from pg_stat_activity where application_name = $1 and state = 'idle'
         and pid not in (select pid from pg_locks where locktype = 'advisory') limit 1`, [c.single!.app])).rows[0]?.pid;
    return pid !== undefined;
  }, 10_000);
  await terminate([pid!]);
});

When("longer than one scheduler tick passes", long, async function () {
  // The single worker ticks every 100ms (PBI 156's steps).
  await runFor(this, 1_000);
});

When("longer than one board poll passes", long, async function () {
  await sleep(POLL_MS + 1_000);
});

When("the board gains a new item {string} with acceptance criteria", long, async function (ext: string) {
  await (await board(this)).fake.seed({ externalId: ext, title: `item ${ext}`, repo: REPO, acceptanceCriteria: ["Exports one month", "Totals add up"] });
});

// ---- Then ----

Then("the second worker launched no cell", function () {
  started(ctx(this));
  assert.deepEqual(worker(this, "second").launched, [], "the second worker launched a cell");
});

Then("the third worker launched no cell", function () {
  started(ctx(this));
  assert.deepEqual(worker(this, "third").launched, [], "the third worker launched a cell");
});

Then("the first worker launched it", function () {
  started(ctx(this));
  const ids = [...new Set(p17(this).started.map((env) => env.ITEM_ID))];
  assert.deepEqual(worker(this, "first").launched, ids);
});

Then("the second worker launched the cell for item {string}", function (name: string) {
  started(ctx(this));
  assert.ok(worker(this, "second").launched.includes(p17(this).items[name]), `the second worker didn't launch item ${name}'s cell`);
});

Then("the second worker never polled the board", function () {
  started(ctx(this));
  assert.equal(worker(this, "second").polls, 0, "the second worker polled the board");
});

Then("the second worker's readiness judge was never asked about item {string}", function (ext: string) {
  started(ctx(this));
  assert.ok(!worker(this, "second").judged.includes(ext), `the second worker's judge was asked about item ${ext}`);
});

Then("the second worker's log records that another worker holds the lock and it is standing by", long, async function () {
  started(ctx(this));
  const w = worker(this, "second");
  const ok = await within(5_000, () => w.log.lines.some((l) => /another worker holds the (worker )?lock/i.test(l) && /stand(s|ing)? by/i.test(l)));
  assert.ok(ok, `the second worker's log says nothing of standing by: ${JSON.stringify(w.log.lines)}`);
});

Then("the second worker's log records that it took the lock", function () {
  started(ctx(this));
  const w = worker(this, "second");
  assert.ok(w.log.lines.some((l) => /took the (worker )?lock/i.test(l)), `the second worker's log doesn't say it took the lock: ${JSON.stringify(w.log.lines)}`);
});

Then("the first worker is still running", long, async function () {
  started(ctx(this));
  const w = worker(this, "first");
  assert.equal(w.exit, undefined, `the first worker exited: ${String(w.exit?.error)}`);
  const n = ticks(w);
  await until("the first worker ticks again", () => ticks(w) > n, w.tickMs * 2 + 5_000);
});

Then("the worker is still running", long, async function () {
  const c = ctx(this);
  const w = w156(this).worker;
  assert.ok(w, "the worker never started");
  assert.equal(c.single!.exit, undefined, `the worker exited: ${String(c.single!.exit?.error)}`);
  const n = w.runs.get("scheduler tick") ?? 0;
  await until("the worker ticks again", () => (w.runs.get("scheduler tick") ?? 0) > n, 5_000);
});

Then("exactly one of the three workers launched a cell or polled the board", function () {
  const c = ctx(this);
  started(c);
  const working = c.workers.filter((w) => w.launched.length || w.polls).map((w) => w.name);
  assert.equal(working.length, 1, `workers that worked: ${JSON.stringify(working)}`);
});

/** That the second worker launched item `name`'s cell within `s` seconds of the first stopping, holding the worker lock. */
async function takesOver(world: object, s: number, name: string): Promise<void> {
  const c = ctx(world);
  started(c);
  const w = worker(world, "second");
  assert.deepEqual(w.launchedBefore ?? [], [], "the second worker launched a cell before the first one stopped");
  const deadline = c.stoppedAt! + s * 1_000;
  await until(`the second worker launches item ${name}'s cell`, async () => {
    await rehome(world);
    return w.launched.includes(p17(world).items[name]);
  }, Math.max(deadline - Date.now(), 0));
  await learnItems(world);
  assert.ok((await lockSessions(w.app)).length, "the second worker launched a cell without holding the worker lock");
}

Then("within {int} seconds of the first worker stopping, the second worker launches a cell for item {string}", long, async function (s: number, name: string) {
  await takesOver(this, s, name);
});

Then("within {int} seconds the second worker launches a cell for item {string}", long, async function (s: number, name: string) {
  await takesOver(this, s, name);
});

Then("within {int} seconds of the first worker stopping, the second worker has polled the board", long, async function (s: number) {
  const c = ctx(this);
  started(c);
  const w = worker(this, "second");
  assert.equal(w.polledBefore ?? 0, 0, "the second worker polled the board before the first one stopped");
  await until("the second worker polls the board", () => w.polls > 0, Math.max(c.stoppedAt! + s * 1_000 - Date.now(), 0));
});

Then("the worker exits with an error saying it lost the worker lock", long, async function () {
  const c = ctx(this);
  assert.ok(w156(this).worker, "the worker never started");
  if (c.noLock) assert.fail(c.noLock);
  const s = c.single!;
  assert.ok(await within(EXIT_WITHIN_MS, () => s.exit !== undefined), "the worker kept running after its lock connection closed");
  assert.match(String((s.exit!.error as Error | undefined)?.message), /lost the worker lock/);
});

Then("the first worker exits with an error saying it lost the worker lock", long, async function () {
  const c = ctx(this);
  started(c);
  if (c.noLock) assert.fail(c.noLock);
  const w = worker(this, "first");
  assert.ok(await within(EXIT_WITHIN_MS, () => w.exit !== undefined), "the first worker kept running after its lock connection closed");
  assert.match(String((w.exit!.error as Error | undefined)?.message), /lost the worker lock/);
});

Then("no cell starts for item {string}", function (name: string) {
  const id = p17(this).items[name];
  assert.ok(id, `item ${name} was never queued`);
  assert.deepEqual(p17(this).started.filter((env) => env.ITEM_ID === id), [], `a cell started for item ${name}`);
});

Then("the board was polled no more times after the lock connection ended", async function () {
  const c = ctx(this);
  const polls = (await board(this)).calls.filter((call) => call.method === "listEligible").length;
  assert.equal(polls, c.pollsAtLoss, `the board was polled ${polls - c.pollsAtLoss!} more time(s)`);
});

Then("the worker's process exits with a non-zero code", long, async function () {
  const c = ctx(this);
  if (c.noLock) assert.fail(c.noLock);
  const proc = c.proc!;
  assert.ok(await within(EXIT_WITHIN_MS, () => proc.code !== undefined), "the worker's process kept running after its lock connection closed");
  assert.ok(proc.code !== null && proc.code !== 0, `the worker's process exited with code ${proc.code}, signal ${proc.signal}`);
});

Then("the worker's log records that it lost the worker lock", function () {
  const out = ctx(this).proc!.output.join("");
  assert.match(out, /lost the worker lock/);
});
