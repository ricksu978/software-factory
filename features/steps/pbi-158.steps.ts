// Step definitions for features/pbi-158-worker-heartbeat.feature. The @db scenarios run the worker from
// src/worker/main.ts in this process, on PBI 4's shared test database, through PBI 156's steps (one worker) and PBI 157's
// (two workers, each on a pool of its own). Both files' hooks run for @pbi-158, so their contexts, fakes and log
// capture hold here too, and PBI 17's steps own the items and the launcher's record.
//
// Each worker gets a clock in its deps, which records every time it hands out. The worker reads it once as each
// scheduler tick starts, so a worker's n-th time is its n-th tick's time, and that time is what the heartbeat records.
// A worker's runs map counts the ticks that have ended. So the heartbeat shows the time of a worker's latest tick when
// it is the time of the last tick to end before it was read, or of a tick that started after that.
//
// A heartbeat that can't be written is a trigger on worker_heartbeat that refuses every write, dropped again by the
// step that lets it be written, and by this file's After hook.
//
// The @local scenarios run `aspire run` with the owner's secrets and Docker, so the owner runs them and the PR records
// the run. Their steps record what they see and assert only in Then.
import { After, Before, BeforeStep, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { long, need, testDb } from "./pbi-8.steps.ts";
import { ctx as p17 } from "./pbi-17.steps.ts";
import { ctx as w156, rehome, type Running } from "./pbi-156.steps.ts";
import { ctx as w157, type Worker as Worker157 } from "./pbi-157.steps.ts";

/** The single worker's name, beside PBI 157's "first" and "second". */
const SINGLE = "the worker";
/** How long a Then waits for a standby to take the worker lock: PBI 157's workers retry every 15 seconds. */
const TAKEOVER_MS = 30_000;

type Ctx = {
  /** The times each worker's clock handed out, in ms since the epoch, by the worker's name. */
  clocks: Map<string, number[]>;
  /** The time of the single worker's latest tick when a Given looked. */
  firstTick?: number;
  /** Whether the step running now is a Given, so a step shared with a Then records instead of asserting. */
  context?: boolean;
  refusing?: boolean;
  local?: Local;
};

type Local = { started: boolean; ticked?: boolean; dbUri?: string; queuedAt?: number; itemId?: string };

function ctx(world: object): Ctx {
  const w = world as { pbi158?: Ctx };
  w.pbi158 ??= { clocks: new Map() };
  return w.pbi158;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** A clock for the named worker that records each time it hands out. */
function clock(world: object, name: string): () => Date {
  const times: number[] = [];
  ctx(world).clocks.set(name, times);
  return () => {
    const d = new Date();
    times.push(d.getTime());
    return d;
  };
}

const times = (world: object, name: string) => ctx(world).clocks.get(name) ?? [];

// ---- The workers ----

type Who = { name: string; running?: Running; label: string };

function single(world: object): Who {
  return { name: SINGLE, running: w156(world).worker, label: "the worker" };
}

function named(world: object, name: string): Who {
  const w: Worker157 | undefined = w157(world).workers.find((x) => x.name === name);
  assert.ok(w, `no ${name} worker was started`);
  return { name, running: w.running, label: `the ${name} worker` };
}

/** The ticks that have ended. */
const ended = (who: Who) => who.running?.runs.get("scheduler tick") ?? 0;

/** Fails when the worker module is missing or a worker never started, so the heartbeat isn't blamed for it. */
function started(world: object, who: Who): void {
  const c156 = w156(world);
  if (c156.missing) assert.fail(c156.missing);
  if (w157(world).missing) assert.fail(w157(world).missing);
  assert.ok(who.running, `${who.label} never started: ${String(c156.workerError ?? "")}`);
}

/** Every heartbeat row's time, in ms since the epoch. */
async function heartbeats(): Promise<number[]> {
  return (await need().pool.query<{ ticked_at: Date }>("select ticked_at from worker_heartbeat")).rows.map((r) => r.ticked_at.getTime());
}

/** The one heartbeat's time. */
async function heartbeat(): Promise<number> {
  const rows = await heartbeats();
  assert.equal(rows.length, 1, `the factory has ${rows.length} worker heartbeats, not one`);
  return rows[0];
}

/** Whether `h` is the time of `who`'s latest tick, given the ticks that had ended before the heartbeat was read. */
function isLatest(world: object, who: Who, h: number, endedBefore: number): boolean {
  return endedBefore > 0 && times(world, who.name).slice(endedBefore - 1).includes(h);
}

async function showsLatest(world: object, who: Who): Promise<void> {
  started(world, who);
  const n = ended(who);
  assert.ok(n > 0, `${who.label} never finished a tick`);
  const h = await heartbeat();
  const t = times(world, who.name);
  assert.ok(isLatest(world, who, h, n), `the heartbeat shows ${iso(h)}, not the time of ${who.label}'s latest tick, ${iso(t[n - 1])}`);
}

/** The time of the single worker's latest ended tick. */
function latestTick(world: object): number | undefined {
  const who = single(world);
  const n = ended(who);
  return n ? times(world, who.name)[n - 1] : undefined;
}

// ---- Hooks ----

Before({ tags: "@pbi-158 and @db", ...long }, async function () {
  // PBI 157's hook adds its pool and log to these deps, whichever runs first.
  w156(this).deps = { ...w156(this).deps, now: clock(this, SINGLE) };
  w157(this).deps = (name: string) => ({ now: clock(this, name) });
  const d = await testDb();
  if (!d) return;
  await refuse(false);
  await d.pool.query("delete from worker_heartbeat");
});

BeforeStep({ tags: "@pbi-158" }, function ({ pickleStep }) {
  ctx(this).context = pickleStep.type === "Context";
});

After({ tags: "@pbi-158 and @db", ...long }, async function () {
  if (await testDb()) await refuse(false);
});

/** Makes every write to worker_heartbeat fail, or lets them through again. */
async function refuse(on: boolean): Promise<void> {
  const p = need().pool;
  if (!on) {
    await p.query("drop trigger if exists pbi158_refuse on worker_heartbeat");
    await p.query("drop trigger if exists pbi158_refuse_truncate on worker_heartbeat");
    return;
  }
  await p.query(`create or replace function pbi158_refuse() returns trigger language plpgsql as $$
    begin raise exception 'pbi-158: the scenario refuses every write to worker_heartbeat'; end $$`);
  await p.query("create trigger pbi158_refuse before insert or update or delete on worker_heartbeat for each row execute function pbi158_refuse()");
  await p.query("create trigger pbi158_refuse_truncate before truncate on worker_heartbeat for each statement execute function pbi158_refuse()");
}

// ---- Given ----

Given("the factory has no worker heartbeat yet", long, async function () {
  await need().pool.query("delete from worker_heartbeat");
});

Given("the factory holds no item", long, async function () {
  await need().pool.query("truncate item cascade");
});

Given("the factory's worker heartbeat was last recorded an hour ago", long, async function () {
  await need().pool.query("delete from worker_heartbeat");
  await need().pool.query("insert into worker_heartbeat (ticked_at) values (now() - interval '1 hour')");
});

// Recorded for the Then that compares with it, which fails if the heartbeat never moved past it.
Given("the heartbeat shows the time of that first tick", function () {
  ctx(this).firstTick = latestTick(this);
});

// The launcher PBI 156's steps hand the worker throws while this count is above zero.
Given("the cell launcher fails every time", function () {
  w156(this).launcherFailures = Number.POSITIVE_INFINITY;
});

Given("the worker's heartbeat can't be written", long, async function () {
  await refuse(true);
  ctx(this).refusing = true;
});

// ---- When ----

When("the worker ticks twice more", long, async function () {
  const who = single(this);
  if (!who.running) return;
  await rehome(this);
  const n = ended(who);
  await until("the worker ticks twice more", () => ended(who) >= n + 2);
});

When("the heartbeat can be written again", long, async function () {
  await refuse(false);
  ctx(this).refusing = false;
});

// ---- Then ----

// Also a Given, before the worker's lock connection ends. There it records, and the Then after the loss checks.
Then("the heartbeat shows the time of the worker's latest tick", long, async function () {
  if (ctx(this).context) {
    ctx(this).firstTick = latestTick(this);
    return;
  }
  await showsLatest(this, single(this));
});

Then("the factory has exactly one worker heartbeat", long, async function () {
  started(this, single(this));
  const rows = await heartbeats();
  assert.equal(rows.length, 1, `the factory has ${rows.length} worker heartbeats`);
});

Then("the heartbeat is later than the first tick", long, async function () {
  const c = ctx(this);
  started(this, single(this));
  assert.ok(c.firstTick !== undefined, "the worker had no first tick");
  const h = await heartbeat();
  assert.ok(h > c.firstTick, `the heartbeat shows ${iso(h)}, no later than the first tick, ${iso(c.firstTick)}`);
});

Then("the worker's log records that the heartbeat couldn't be written", function () {
  started(this, single(this));
  const logs = w156(this).logs;
  assert.ok(logs.some((l) => /heartbeat/i.test(l) && /(couldn't|could not|can't|cannot) be (written|recorded)|failed/i.test(l)),
    `no line in the worker's log says the heartbeat couldn't be written`);
});

Then("the heartbeat shows the time of the first worker's latest tick", long, async function () {
  await showsLatest(this, named(this, "first"));
});

Then("the second worker never recorded the heartbeat", long, async function () {
  const who = named(this, "second");
  started(this, who);
  const h = await heartbeat();
  assert.ok(!times(this, "second").includes(h), `the heartbeat shows ${iso(h)}, the time of a tick of the second worker`);
  assert.equal(ended(who), 0, "the second worker ticked while the first one held the worker lock");
});

Then("the heartbeat still shows the time of the first worker's last tick until the second worker takes the lock", long, async function () {
  const first = named(this, "first");
  const second = named(this, "second");
  started(this, first);
  started(this, second);
  const last = times(this, "first").at(-1);
  assert.ok(last !== undefined, "the first worker never ticked");
  const end = (w157(this).stoppedAt ?? Date.now()) + TAKEOVER_MS;
  let checks = 0;
  // Read until the second worker's first tick starts. A read that a tick of it overlapped proves nothing, so isn't counted.
  while (Date.now() < end) {
    const before = times(this, "second").length;
    if (before) break;
    const h = await heartbeat();
    if (times(this, "second").length) break;
    assert.equal(iso(h), iso(last), "the heartbeat moved off the first worker's last tick before the second worker took the lock");
    checks++;
    await sleep(250);
  }
  assert.ok(checks > 0, "the second worker took the lock before the heartbeat could be read");
});

Then("within {int} seconds of the first worker stopping, the heartbeat shows the time of the second worker's latest tick", long, async function (s: number) {
  const second = named(this, "second");
  started(this, second);
  const deadline = (w157(this).stoppedAt ?? Date.now()) + s * 1_000;
  let seen: number[] = [];
  const ok = await within(Math.max(deadline - Date.now(), 0), async () => {
    const n = ended(second);
    seen = await heartbeats();
    return seen.length === 1 && isLatest(this, second, seen[0], n);
  });
  assert.ok(ok, `the heartbeat shows ${seen.map(iso).join(", ") || "nothing"}, not the second worker's latest tick, ${iso(times(this, "second").at(-1))}`);
});

Then("the heartbeat still shows the time of the worker's last tick before it lost the lock", long, async function () {
  const who = single(this);
  started(this, who);
  const t = times(this, who.name);
  assert.ok(t.length, "the worker never ticked");
  assert.equal(ended(who), t.length, "the worker started a tick after it lost the worker lock");
  const h = await heartbeat();
  assert.equal(iso(h), iso(t.at(-1)), "the heartbeat doesn't show the time of the worker's last tick");
});

// ---- @local: the owner runs these, and the PR records the run ----

const APPHOST = "--apphost . --non-interactive --nologo";
const local = { timeout: 600_000 };

function sh(command: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(command, { shell: true, encoding: "utf8", env: { ...process.env, FACTORY_FLOAT_PORTS: "1" } });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** One resource from `aspire describe`. Its stdout shows environment values such as FACTORY_DB_URI, so it's never printed. */
function describe(resource: string): Record<string, any> | undefined {
  const r = sh(`aspire describe ${resource} --format Json ${APPHOST}`);
  try {
    return (JSON.parse(r.stdout.slice(r.stdout.indexOf("{"))) as { resources: Record<string, any>[] }).resources[0];
  } catch {
    return undefined;
  }
}

function findKey(value: unknown, pattern: RegExp): unknown {
  if (!value || typeof value !== "object") return undefined;
  for (const [k, v] of Object.entries(value)) {
    if (pattern.test(k)) return v;
    const nested = findKey(v, pattern);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function lc(world: object): Local {
  const c = ctx(world);
  c.local ??= { started: false };
  return c.local;
}

async function startAspire(world: object): Promise<void> {
  const l = lc(world);
  l.started = true;
  sh(`aspire start --isolated ${APPHOST}`);
  l.ticked = await within(300_000, async () => {
    await sleep(2_000);
    return /first scheduler tick/.test(sh(`aspire logs worker --search "first scheduler tick" ${APPHOST}`).stdout);
  });
  const uri = findKey(describe("worker"), /^FACTORY_DB_URI$/);
  if (typeof uri === "string") l.dbUri = uri;
}

After({ tags: "@pbi-158 and @local" }, function () {
  if (ctx(this).local?.started) sh(`aspire stop ${APPHOST}`);
});

async function withDb<T>(world: object, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const l = lc(world);
  assert.ok(l.ticked, "the worker resource's console never showed its first scheduler tick");
  assert.ok(l.dbUri, "Aspire gave the worker resource no FACTORY_DB_URI");
  const client = new pg.Client({ connectionString: l.dbUri });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function heartbeatAge(world: object): Promise<number | null> {
  return withDb(world, async (client) => {
    const r = await client.query<{ age: string }>("select extract(epoch from now() - ticked_at) as age from worker_heartbeat");
    return r.rows.length ? Number(r.rows[0].age) : null;
  });
}

When("I start {string} and wait until the worker resource's console shows its first scheduler tick", local, async function (_cmd: string) {
  await startAspire(this);
});

Given("{string} is running and the worker resource's console shows its first scheduler tick", local, async function (_cmd: string) {
  await startAspire(this);
});

Then("Aspire shows the worker resource started only after the migrate resource finished successfully", function () {
  assert.ok(lc(this).ticked, "the worker resource's console never showed its first scheduler tick");
  const migrate = describe("migrate");
  const worker = describe("worker");
  assert.ok(migrate && worker, "aspire describe gave no migrate or worker resource");
  assert.equal(findKey(migrate, /^exit_?code$/i), 0, `migrate's exit code, in state ${String(migrate.state)}`);
  const finished = Date.parse(String(findKey(migrate, /^(stop|finish)(ed)?_?time_?stamp$|^(stop|finish)(ed)?_?(at|time)$/i)));
  const begun = Date.parse(String(findKey(worker, /^start(ed)?_?time_?stamp$|^start(ed)?_?(at|time)$/i)));
  assert.ok(Number.isFinite(finished), "Aspire shows no time migrate finished");
  assert.ok(Number.isFinite(begun), "Aspire shows no time the worker started");
  assert.ok(begun >= finished, `the worker started at ${iso(begun)}, before migrate finished at ${iso(finished)}`);
});

Then("Aspire shows no endpoint for the worker resource", function () {
  assert.ok(lc(this).ticked, "the worker resource's console never showed its first scheduler tick");
  const worker = describe("worker");
  assert.ok(worker, "aspire describe gave no worker resource");
  for (const key of [/^urls$/i, /^endpoints$/i]) {
    const v = findKey(worker, key);
    assert.ok(v === undefined || (Array.isArray(v) && v.length === 0), `the worker resource shows ${JSON.stringify(v)}`);
  }
});

Then("the worker's process listens on no port", function () {
  assert.ok(lc(this).ticked, "the worker resource's console never showed its first scheduler tick");
  const pid = Number(findKey(describe("worker"), /^(executable\.)?pid$/i));
  assert.ok(Number.isInteger(pid) && pid > 0, "Aspire shows no process id for the worker resource");
  let listening: string[];
  if (process.platform === "win32") {
    listening = sh("netstat -ano").stdout.split(/\r?\n/)
      .filter((l) => /LISTENING|^\s*UDP/.test(l) && l.trim().split(/\s+/).at(-1) === String(pid));
  } else if (process.platform === "darwin") {
    listening = sh(`lsof -Pan -p ${pid} -iTCP -sTCP:LISTEN -iUDP`).stdout.split("\n").slice(1).filter(Boolean);
  } else {
    listening = sh("ss -ltunpH").stdout.split("\n").filter((l) => l.includes(`pid=${pid},`));
  }
  assert.deepEqual(listening, [], `the worker's process ${pid} listens`);
});

Then("the factory database's worker heartbeat is less than {int} seconds old", local, async function (s: number) {
  const age = await heartbeatAge(this);
  assert.ok(age !== null, "the factory database has no worker heartbeat");
  assert.ok(age < s, `the worker heartbeat is ${age} seconds old`);
});

Then("a minute later the worker heartbeat is still less than {int} seconds old", local, async function (s: number) {
  await sleep(60_000);
  const age = await heartbeatAge(this);
  assert.ok(age !== null, "the factory database has no worker heartbeat");
  assert.ok(age < s, `the worker heartbeat is ${age} seconds old`);
});

// Queued on the first board the factory polls, in the first repo it knows, so the worker's tick claims it.
When("a factory item is queued", local, async function () {
  const l = lc(this);
  if (!l.ticked || !l.dbUri) return;
  await withDb(this, async (client) => {
    const source = (await client.query<{ id: string }>("select id from backlog_source order by id limit 1")).rows[0];
    const repo = (await client.query<{ url: string }>("select url from repo order by id limit 1")).rows[0];
    if (!source) return;
    const ext = `pbi-158-${crypto.randomUUID().slice(0, 8)}`;
    const r = await client.query<{ id: string; at: Date }>(
      `insert into item (source_id, external_id, title, state, backlog_rank, repo)
       values ($1, $2, 'PBI 158: a queued item under aspire run', 'Queued', 0, $3) returning id, now() as at`,
      [source.id, ext, repo ? repo.url.replace(/^https:\/\/github\.com\//, "") : null]);
    l.itemId = r.rows[0].id;
    l.queuedAt = r.rows[0].at.getTime();
  });
});

Then("within one scheduler tick a cell starts for the item", local, async function () {
  const l = lc(this);
  assert.ok(l.itemId, "no factory item was queued: the factory has no backlog source");
  // The worker ticks every 15 seconds (src/scheduler/scheduler.ts), with a little more for the launch itself.
  const ok = await within(25_000, () => withDb(this, async (client) =>
    ((await client.query("select 1 from run where item_id = $1 and execution_name is not null", [l.itemId])).rowCount ?? 0) > 0));
  assert.ok(ok, "no cell started for the item within one scheduler tick");
});

Then("the item is {string}", local, async function (state: string) {
  const l = lc(this);
  assert.ok(l.itemId, "no factory item was queued");
  const row = await withDb(this, async (client) => (await client.query<{ state: string }>("select state from item where id = $1", [l.itemId])).rows[0]);
  assert.equal(row?.state, state);
});

Then("the worker heartbeat is later than the time the item was queued", local, async function () {
  const l = lc(this);
  assert.ok(l.queuedAt !== undefined, "no factory item was queued");
  const h = await withDb(this, async (client) => (await client.query<{ ticked_at: Date }>("select ticked_at from worker_heartbeat")).rows[0]?.ticked_at);
  assert.ok(h, "the factory database has no worker heartbeat");
  assert.ok(h.getTime() > l.queuedAt, `the heartbeat shows ${h.toISOString()}, no later than the item was queued, ${iso(l.queuedAt)}`);
});
