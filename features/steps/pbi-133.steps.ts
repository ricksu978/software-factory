// Step definitions for features/pbi-133-dropped-db-connection.feature.
//
// A pool emits `error` when Postgres ends one of its idle connections. With no listener, EventEmitter throws that
// error out of the socket's callback and the process exits. Each pool these steps watch has its `emit` wrapped, so a
// throw out of an `error` emit is recorded as the crash it would have been instead of ending the test run, and
// "the process is still running" asserts that none was recorded. For the control plane's pool, a recorded crash also
// closes its HTTP server, as the exit would have.
//
// The control-plane scenarios run PBI 89's "control plane is running with a fake board" on a Postgres of their own,
// which they end connections on, stop and start. Its pool is made with createPool, as the control plane's start
// makes it. The scheduler's tick and the board poll run through main.ts's `attempt`, as `every` runs them.
import { After, AfterAll, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify, format } from "node:util";
import pg from "pg";
import { attempt } from "../../src/main.ts";
import { createPool, migrate, withTx } from "../../src/store/db.ts";
import { appendEvent } from "../../src/store/events.ts";
import { fakeLauncher } from "../../src/scheduler/launcher.ts";
import { tick } from "../../src/scheduler/scheduler.ts";
import { pollOnce } from "../../src/watcher/poller.ts";
import type { fakeBacklog, fakeRepoHost } from "../../src/adapters/fake.ts";
import type { Server } from "node:http";
import { long } from "./pbi-8.steps.ts";
import { usePool } from "./pbi-89.steps.ts";

const run = promisify(execFile);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const REASON = "terminating connection due to administrator command (pbi-133)";
const REPO = "octo/repo";
const LOST = /lost/i;

// ---- a Postgres these scenarios can stop and start ----

type OwnPg = { url: string; stop(): Promise<void>; start(): Promise<void>; shutdown(): Promise<void> };

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

/** From FACTORY_PG_BIN, as in a cell, or a Testcontainers Postgres on a fixed host port, so its URL survives a restart. */
async function ownPostgres(): Promise<OwnPg> {
  const bin = process.env.FACTORY_PG_BIN;
  if (bin) {
    const dir = await mkdtemp(join(tmpdir(), "pg133-"));
    const data = join(dir, "data");
    const user = userInfo().username;
    await run(join(bin, "initdb"), ["-D", data, "--auth=trust", "-U", user, "--no-sync"]);
    const start = async () => {
      await run(join(bin, "pg_ctl"), ["-D", data, "-l", join(dir, "log"), "-w", "-o", `-c listen_addresses='' -c unix_socket_directories='${dir}' -c fsync=off`, "start"]);
    };
    // Fast shutdown ends every session with an admin-shutdown error, as a server restart does.
    const stop = async () => {
      await run(join(bin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"]);
    };
    await start();
    return {
      url: `postgresql://${encodeURIComponent(user)}@/postgres?host=${encodeURIComponent(dir)}`,
      start, stop,
      async shutdown() {
        await stop().catch(() => undefined);
        await rm(dir, { recursive: true, force: true });
      },
    };
  }
  const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
  const port = await freePort();
  const container = await new PostgreSqlContainer("postgres:17").withExposedPorts({ container: 5432, host: port }).start();
  const id = container.getId();
  return {
    url: container.getConnectionUri(),
    // The image stops Postgres with SIGINT, a fast shutdown.
    stop: async () => void (await run("docker", ["stop", id])),
    start: async () => void (await run("docker", ["start", id])),
    shutdown: async () => void (await container.stop()),
  };
}

let server: OwnPg | null = null;
let up = false;

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: server!.url });
  c.on("error", () => undefined);
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => undefined);
  }
}

/** Waits until Postgres takes connections again. */
async function ready(): Promise<void> {
  for (let i = 0; i < 120; i++) {
    try {
      await admin((c) => c.query("select 1"));
      up = true;
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error("Postgres didn't come back");
}

async function stopPg(): Promise<void> {
  await server!.stop();
  up = false;
  // Let every pool client read its socket's end before anything else runs.
  await sleep(500);
}

async function startPg(): Promise<void> {
  await server!.start();
  await ready();
}

// ---- watching a pool for the crash ----

type Watched = { pool: pg.Pool; crashes: unknown[] };

/** `onCrash` runs on each recorded crash, to end what the process's exit would have ended. */
function watch(pool: pg.Pool, onCrash: () => void = () => undefined): Watched {
  const w: Watched = { pool, crashes: [] };
  const emit = pool.emit.bind(pool);
  pool.emit = ((event: string | symbol, ...args: unknown[]) => {
    try {
      return emit(event, ...args);
    } catch (e) {
      if (event !== "error") throw e;
      w.crashes.push(e);
      onCrash();
      return false;
    }
  }) as typeof pool.emit;
  return w;
}

// ---- the world ----

type P89 = {
  server?: Server;
  close?: () => Promise<void>;
  origin?: string;
  fake?: ReturnType<typeof fakeBacklog>;
  host?: ReturnType<typeof fakeRepoHost>;
  sourceId?: string;
  runTick?: (once: () => Promise<unknown>) => Promise<void>;
};

type Stream = { status: number; text: string; done: boolean; abort: AbortController };

type Ctx = {
  logs: string[];
  restoreConsole?: () => void;
  pools: Watched[];
  target?: Watched;
  control?: Watched;
  ended: number[];
  endedAt?: Date;
  itemId?: string;
  newExt?: string;
  tickOk?: boolean;
  pollOk?: boolean;
  streams: Stream[];
  reconnects: Stream[];
  eventId?: string;
};

function ctx(world: object): Ctx {
  const w = world as { pbi133?: Ctx };
  w.pbi133 ??= { logs: [], pools: [], ended: [], streams: [], reconnects: [] };
  return w.pbi133;
}

const p89 = (world: object): P89 => {
  const w = world as { pbi89?: P89 };
  w.pbi89 ??= {};
  return w.pbi89;
};

const control = (c: Ctx): Watched => {
  assert.ok(c.control, "the control plane's pool isn't set up");
  return c.control;
};

Before({ tags: "@pbi-133" }, function () {
  const c = ctx(this);
  const originals = { log: console.log, warn: console.warn, error: console.error };
  for (const k of ["log", "warn", "error"] as const) {
    console[k] = (...args: unknown[]) => {
      c.logs.push(format(...args));
      originals[k](...args);
    };
  }
  c.restoreConsole = () => Object.assign(console, originals);
});

Before({ tags: "@pbi-133 and @db", ...long }, async function () {
  server ??= await ownPostgres();
  if (!up) await ready();
  const c = ctx(this);
  const pool = createPool(server.url);
  await migrate(pool);
  await pool.query(`truncate item, event, "user", backlog_source, repo, webhook_delivery, override cascade`);
  await pool.query("update wip_policy set usage_paused_until = null, current_wip = 1");
  // The process would have exited, so the control plane's server stops answering too.
  c.control = watch(pool, () => {
    const s = p89(this).server;
    s?.closeAllConnections();
    s?.close();
  });
  usePool(pool);
});

After({ tags: "@pbi-133", ...long }, async function () {
  const c = ctx(this);
  for (const s of [...c.streams, ...c.reconnects]) s.abort.abort();
  const d = p89(this);
  await d.close?.().catch(() => undefined);
  if (d.server) {
    d.server.closeAllConnections();
    await new Promise<void>((resolve) => d.server!.close(() => resolve()));
  }
  usePool(null);
  if (c.control) {
    if (!up && server) await startPg().catch(() => undefined);
    await c.control.pool.end().catch(() => undefined);
  }
  for (const w of c.pools) await w.pool.end().catch(() => undefined);
  c.restoreConsole?.();
});

AfterAll(long, async function () {
  await server?.shutdown();
  server = null;
});

// ---- @ac-1: every pool createPool returns ----

function madeFor(where: string): pg.Pool {
  if (where === "a local database URL") return createPool("postgresql://factory@127.0.0.1:1/factory");
  if (where === "Azure, signing in as the managed identity") {
    process.env.PGHOST ??= "factory.postgres.database.azure.com";
    process.env.PGUSER ??= "factory-identity";
    process.env.PGDATABASE ??= "factory";
    return createPool();
  }
  throw new Error(`no pool for ${where}`);
}

/** What a pool emits when Postgres ends one of its idle clients: the error and the client it removed. */
function lose(w: Watched): void {
  const err = Object.assign(new Error(REASON), { code: "57P01", severity: "FATAL" });
  w.pool.emit("error", err, {} as pg.PoolClient);
}

Given("a database pool the factory made for {}", function (where: string) {
  const c = ctx(this);
  c.target = watch(madeFor(where));
  c.pools.push(c.target);
});

Given("two database pools the factory made for a local database URL", function () {
  const c = ctx(this);
  c.pools.push(watch(madeFor("a local database URL")), watch(madeFor("a local database URL")));
  c.target = c.pools[1];
});

When("the pool reports that one of its idle connections was lost", function () {
  lose(ctx(this).target!);
});

When("the second pool reports that one of its idle connections was lost", function () {
  lose(ctx(this).target!);
});

When("the pool reports three lost idle connections in a row", function () {
  const c = ctx(this);
  for (let i = 0; i < 3; i++) lose(c.target!);
});

const lostLines = (c: Ctx) => c.logs.filter((l) => LOST.test(l) && /connection/i.test(l));

Then("the log says a database connection was lost, with the reason", function () {
  const lines = lostLines(ctx(this));
  assert.ok(lines.length > 0, "nothing in the log says a database connection was lost");
  assert.ok(lines.some((l) => l.includes(REASON)), `the log doesn't give the reason: ${lines.join("\n")}`);
});

Then("the log says a database connection was lost three times", function () {
  const lines = lostLines(ctx(this));
  assert.equal(lines.length, 3, `the log says a connection was lost ${lines.length} times:\n${lines.join("\n")}`);
});

Then("the process is still running", function () {
  const c = ctx(this);
  const crashes = c.pools.flatMap((w) => w.crashes);
  assert.deepEqual(crashes.map(String), [], "a pool's error had no listener, so the process would have exited");
});

// ---- @ac-2: Postgres ends idle connections ----

async function pids(pool: pg.Pool, n: number): Promise<number[]> {
  const clients = await Promise.all(Array.from({ length: n }, () => pool.connect()));
  try {
    return await Promise.all(clients.map(async (cl) => (await cl.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid));
  } finally {
    for (const cl of clients) cl.release();
  }
}

Given("the control plane holds an idle connection to Postgres", async function () {
  const c = ctx(this);
  c.ended = await pids(control(c).pool, 1);
  assert.ok(control(c).pool.idleCount >= 1, "the pool holds no idle connection");
});

Given("the control plane holds several idle connections to Postgres", async function () {
  const c = ctx(this);
  c.ended = await pids(control(c).pool, 3);
  assert.ok(control(c).pool.idleCount >= 3, "the pool holds fewer than three idle connections");
});

async function terminate(c: Ctx): Promise<void> {
  const before = control(c).pool.totalCount;
  c.endedAt = new Date();
  await admin((a) => a.query("select pg_terminate_backend(pid) from unnest($1::int[]) as pid", [c.ended]));
  // Wait until the pool has seen the ends, or would have crashed on them.
  for (let i = 0; i < 50 && control(c).pool.totalCount > before - c.ended.length && control(c).crashes.length < c.ended.length; i++) await sleep(100);
}

When("Postgres ends that idle connection", long, async function () {
  await terminate(ctx(this));
});

When("Postgres ends all of those idle connections at once", long, async function () {
  await terminate(ctx(this));
});

function stillRunning(world: object): void {
  const c = ctx(world);
  assert.deepEqual(control(c).crashes.map(String), [], "the pool's error had no listener, so the control plane would have exited");
  assert.ok(p89(world).server?.listening, "the control plane's server isn't listening");
}

Then("the control plane is still running", function () {
  stillRunning(this);
});

Then("the control plane is still running, with no restart", function () {
  stillRunning(this);
});

Then("the log says a database connection was lost", function () {
  assert.ok(lostLines(ctx(this)).length > 0, "nothing in the log says a database connection was lost");
});

const headers = (login: string) => ({ "x-ms-client-principal-idp": "aad", "x-ms-client-principal-id": login, "x-ms-client-principal-name": login });

Then("the dashboard's Floor still answers 200 with the factory's items", long, async function () {
  const d = p89(this);
  // Seeded beside the control plane's pool, so the Floor's own queries are the first it runs after the ends.
  await admin(async (a) => {
    await a.query(`insert into "user" (provider, subject, github_login, role) values ('microsoft', 'viewer133', 'viewer133', 'viewer') on conflict do nothing`);
    await a.query("insert into item (source_id, external_id, title, state) values ($1, '133-floor', 'an item on the Floor', 'Queued') on conflict do nothing", [d.sourceId]);
  });
  const r = await fetch(`${d.origin}/`, { headers: headers("viewer133") });
  const html = await r.text();
  assert.equal(r.status, 200, html.slice(0, 300));
  assert.ok(html.includes("an item on the Floor"), "the Floor doesn't list the factory's item");
});

Then("the query ran on a connection Postgres opened after it ended the others", async function () {
  const c = ctx(this);
  const rows = await admin(async (a) => (await a.query<{ pid: number; backend_start: Date }>(
    "select pid, backend_start from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and backend_type = 'client backend'",
  )).rows);
  assert.deepEqual(rows.filter((r) => c.ended.includes(r.pid)).map((r) => r.pid), [], "an ended connection is still open");
  assert.ok(rows.some((r) => r.backend_start > c.endedAt!), "no connection opened after the others ended");
});

// ---- @ac-3: the scheduler and the board poller after a restart ----

Given("an item ready for the factory to take", async function () {
  const c = ctx(this);
  const d = p89(this);
  const pool = control(c).pool;
  const ext = await d.fake!.seed({ title: "a ready item", repo: REPO, acceptanceCriteria: ["it works"] });
  d.host!.heads.set(REPO, "sha133");
  await pool.query("insert into repo (host_adapter, url, trusted_bot) values ('github', $1, 'factory[bot]') on conflict do nothing", [`https://github.com/${REPO}`]);
  c.itemId = (await pool.query<{ id: string }>("insert into item (source_id, external_id, title, state) values ($1, $2, 'a ready item', 'Queued') returning id", [d.sourceId, ext])).rows[0].id;
});

const tickDeps = (world: object) => {
  const d = p89(world);
  return { pool: control(ctx(world)).pool, launcher: fakeLauncher(), now: new Date(), killFlag: false, repoHost: d.host!,
    backlogFor: () => d.fake!.adapter, secret: "cell-secret", controlUrl: "http://control.test", sopVersion: "0.1.0" };
};

/** A tick that takes nothing: the WIP limit is 0 while it runs, so the ready item waits for the tick under test. */
async function idleTick(world: object): Promise<void> {
  const pool = control(ctx(world)).pool;
  await pool.query("update wip_policy set current_wip = 0");
  try {
    await tick(tickDeps(world));
  } finally {
    await pool.query("update wip_policy set current_wip = 1");
  }
  // PBI 89's "the scheduler ticks once" runs through here from now on, keeping the WIP limit and logging as `every` does.
  const c = ctx(world);
  p89(world).runTick = async (once) => {
    c.tickOk = await attempt("scheduler tick", once);
  };
}

const judge = async (_item: unknown, dor: { criteria: { index: number }[] }) =>
  [...dor.criteria.map((cr) => JSON.stringify({ index: cr.index, status: "passed", reason: "ok" })), JSON.stringify({ flags: [] })].join("\n");

async function poll(world: object): Promise<boolean> {
  const d = p89(world);
  return attempt(`polling source ${d.sourceId}`, () => pollOnce({ pool: control(ctx(world)).pool, adapter: d.fake!.adapter, repoHost: d.host!, judge, sourceId: d.sourceId! }));
}

Given("the scheduler has ticked at least once", long, async function () {
  await idleTick(this);
});

Given("the board poller has polled at least once", long, async function () {
  assert.ok(await poll(this), "the first poll failed");
});

Given("the scheduler and the board poller have each run at least once", long, async function () {
  // On their own timers, as the control plane runs them, so each holds a connection of its own.
  const [, polled] = await Promise.all([idleTick(this), poll(this)]);
  assert.ok(polled, "the first poll failed");
});

When("Postgres restarts", long, async function () {
  await stopPg();
  await startPg();
});

When("Postgres stops", long, async function () {
  await stopPg();
});

When("Postgres starts again", long, async function () {
  await startPg();
});

When("the fake board gains a new item", async function () {
  ctx(this).newExt = await p89(this).fake!.seed({ title: "a new item", acceptanceCriteria: ["it works"] });
});

When("the board poller polls once", long, async function () {
  ctx(this).pollOk = await poll(this);
});

Then("the tick succeeded", function () {
  assert.equal(ctx(this).tickOk, true, "the scheduler tick failed");
});

Then("the item is taken by the factory", async function () {
  const c = ctx(this);
  const state = (await control(c).pool.query<{ state: string }>("select state from item where id = $1", [c.itemId])).rows[0]?.state;
  assert.equal(state, "InProgress");
});

Then("the poll succeeded", function () {
  assert.equal(ctx(this).pollOk, true, "the board poll failed");
});

Then("the new item is in the factory's backlog", async function () {
  const c = ctx(this);
  const n = (await control(c).pool.query("select 1 from item where external_id = $1", [c.newExt])).rowCount;
  assert.equal(n, 1, "the new item isn't in the factory's backlog");
});

Then("the log says the scheduler tick failed", function () {
  assert.ok(ctx(this).logs.some((l) => /scheduler tick failed/.test(l)), "nothing in the log says the scheduler tick failed");
});

Then("the log says polling the board failed", function () {
  assert.ok(ctx(this).logs.some((l) => /polling source \S+ failed/.test(l)), "nothing in the log says polling the board failed");
});

// ---- @ac-4: the dashboard's live event stream ----

async function viewer(world: object, login: string): Promise<void> {
  await control(ctx(world)).pool.query(`insert into "user" (provider, subject, github_login, role) values ('microsoft', $1, $1, 'viewer') on conflict do nothing`, [login]);
}

/** Opens /events and keeps reading it into `text` until it ends. */
async function openStream(world: object, login: string): Promise<Stream> {
  const abort = new AbortController();
  const s: Stream = { status: 0, text: "", done: false, abort };
  try {
    const r = await fetch(`${p89(world).origin}/events`, { headers: headers(login), signal: abort.signal });
    s.status = r.status;
    if (!r.body) {
      s.done = true;
      return s;
    }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          s.text += decoder.decode(value, { stream: true });
        }
      } catch {}
      s.done = true;
    })();
  } catch {
    s.done = true;
  }
  return s;
}

async function until(test: () => boolean, ms = 10_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (test()) return true;
  return test();
}

Given("a viewer has the dashboard open on its live event stream", long, async function () {
  const c = ctx(this);
  await viewer(this, "viewer133");
  const s = await openStream(this, "viewer133");
  assert.equal(s.status, 200, "the live event stream didn't open");
  c.streams.push(s);
});

Given("two viewers have the dashboard open on its live event stream", long, async function () {
  const c = ctx(this);
  for (const login of ["viewer133a", "viewer133b"]) {
    await viewer(this, login);
    const s = await openStream(this, login);
    assert.equal(s.status, 200, "the live event stream didn't open");
    c.streams.push(s);
  }
});

Then("the viewer's live event stream is closed, so the browser reconnects", long, async function () {
  const s = ctx(this).streams[0];
  assert.ok(await until(() => s.done), "the live event stream is still open");
});

When("the viewer's browser reconnects to the live event stream", long, async function () {
  const c = ctx(this);
  c.reconnects = [await openStream(this, "viewer133")];
});

When("both viewers' browsers reconnect to the live event stream", long, async function () {
  const c = ctx(this);
  c.reconnects = [await openStream(this, "viewer133a"), await openStream(this, "viewer133b")];
});

Then("the reconnect is refused", function () {
  const s = ctx(this).reconnects[0];
  assert.ok(s.status !== 200, "the live event stream opened while Postgres was down");
});

When("the factory records an event after the restart", long, async function () {
  const c = ctx(this);
  const id = await withTx(control(c).pool, async (cl) => {
    await appendEvent(cl, { actor: "system", actorId: "pbi-133", itemId: null, kind: "pbi-133-probe", payload: {} });
    return (await cl.query<{ id: string }>("select id from event where kind = 'pbi-133-probe' order by at desc limit 1")).rows[0].id;
  }).catch(() => undefined);
  c.eventId = id;
});

function delivers(c: Ctx, s: Stream | undefined): Promise<boolean> {
  return until(() => s !== undefined && s.status === 200 && c.eventId !== undefined && s.text.includes(c.eventId));
}

Then("the viewer's live event stream delivers that event", long, async function () {
  const c = ctx(this);
  assert.ok(c.eventId, "the factory recorded no event");
  assert.ok(await delivers(c, c.reconnects.at(-1)), "the live event stream didn't deliver the event");
});

Then("both viewers' live event streams deliver that event", long, async function () {
  const c = ctx(this);
  assert.ok(c.eventId, "the factory recorded no event");
  assert.equal(c.reconnects.length, 2);
  for (const s of c.reconnects) assert.ok(await delivers(c, s), "a viewer's live event stream didn't deliver the event");
});

Then("the control plane holds exactly one connection listening for dashboard events", async function () {
  const n = await admin(async (a) => (await a.query<{ n: number }>("select count(*)::int as n from pg_stat_activity where query = 'listen factory_events'")).rows[0].n);
  assert.equal(n, 1);
});
