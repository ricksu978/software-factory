// Step definitions for features/pbi-300-prepare-restart-stops-nothing.feature. They build on PBI 17's scheduler steps,
// PBI 140's restart steps and PBI 177's live WIP steps, on PBI 4's test database. One clock, PBI 140's, drives the
// scheduler, the leases and the cell API, so "N minutes ago" means the same to each. A cell renews its lease through
// the real cell API. "The control plane starts" runs src/main.ts's serveControl and "the worker starts" runs
// src/worker/main.ts's startWorker, in process, each with PBI 156's fakes, and stops it again once it has started. The
// worker stands by, because the step holds the worker lock, so it runs no tick of its own: the scenario's scheduler
// tick is the one that starts the cells, on PBI 140's clock.
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { WORKER_LOCK_KEY } from "../../src/worker/main.ts";
import { ctx as p140, prepare, renew } from "./pbi-140.steps.ts";
import { ctx as p17, freshDb, newItem, tick } from "./pbi-17.steps.ts";
import { fakes } from "./pbi-156.steps.ts";
import { ctx as p175 } from "./pbi-175.steps.ts";
import { load, long, need } from "./pbi-8.steps.ts";

const WAIT = "FACTORY_RESTART_WAIT_MINUTES";

type Ctx = {
  restore: (() => void)[];
  /** Every cell the launcher was asked to stop, over every tick of the scenario. */
  everStopped: string[];
};

function ctx(world: object): Ctx {
  const w = world as { pbi300?: Ctx };
  w.pbi300 ??= { restore: [], everStopped: [] };
  return w.pbi300;
}

Before({ tags: "@pbi-300" }, function () {
  const c = ctx(this);
  const wait = process.env[WAIT];
  c.restore.push(() => (wait === undefined ? delete process.env[WAIT] : (process.env[WAIT] = wait)));
  // The scheduler's clock and the leases' are PBI 140's, the one a prepared restart is dated from.
  p17(this).now = p140(this).clock;
  Object.assign(this, { controlStart: () => startControl(this), workerStart: () => startWorker(this) });
});

type Started = { stop(): Promise<void> };
const quiet = { log() {}, error() {} };

/** Starts the control plane through serveControl, the start src/main.ts runs once its settings are read, then stops it. */
async function startControl(world: object): Promise<void> {
  const mod = await load<{ serveControl(d: object, port: number): Promise<Started> }>("src/main.ts");
  assert.ok(mod, "src/main.ts doesn't load");
  const control = await mod.serveControl({ ...(await fakes(world)), pool: need().pool }, 0);
  await control.stop();
}

/**
 * Starts the worker through startWorker, the start src/worker/main.ts's main runs, then stops it. The step holds the
 * worker lock meanwhile, so the worker stands by and ticks nothing of its own.
 */
async function startWorker(world: object): Promise<void> {
  const mod = await load<{ startWorker(d: object): Promise<Started> }>("src/worker/main.ts");
  assert.ok(mod, "src/worker/main.ts doesn't load");
  const holder = await need().pool.connect();
  try {
    const got = await holder.query<{ locked: boolean }>("select pg_try_advisory_lock($1) as locked", [WORKER_LOCK_KEY]);
    assert.ok(got.rows[0].locked, "another worker still holds the worker lock");
    const worker = await mod.startWorker({ ...(await fakes(world)), pool: need().pool, log: quiet });
    await worker.stop();
    await holder.query("select pg_advisory_unlock($1)", [WORKER_LOCK_KEY]);
  } finally {
    holder.release();
  }
}

After({ tags: "@pbi-300", ...long }, async function () {
  for (const r of ctx(this).restore.reverse()) r();
  // PBI 140's cell API and PBI 175's dashboard, which their own After hooks close only for their own tags.
  for (const s of [p140(this).cellServer, p175(this).server]) {
    if (!s) continue;
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

function ticked(world: object) {
  const s = p17(world);
  assert.ok(s.ticked, "the scheduler never ticked");
  return s;
}

// ---- Given ----

Given("a fresh factory database with WIP 3 and a review capacity of 3", long, async function () {
  await freshDb(this, 3);
});

Given("item {string} is at green in cell {string} with a live lease", long, async function (name: string, cell: string) {
  const s = p17(this);
  const now = s.now!;
  const id = await newItem(s, name, "InProgress", { owner: cell, expires: new Date(now.getTime() + 4 * 60_000) });
  const pool = need().pool;
  const run = await pool.query<{ id: string }>(
    "insert into run (item_id, next_stage, execution_name, branch) values ($1, 'green', $2, 'factory/pbi-x-r1') returning id", [id, cell]);
  await pool.query(
    `insert into stage_run (run_id, stage_id, attempt, status) values ($1, 'understand', 1, 'passed'), ($1, 'red', 1, 'passed'),
       ($1, 'green', 1, 'started')`, [run.rows[0].id]);
  const r = await pool.query<{ state: string; lease_owner: string | null; lease_expires: Date | null; status: string | null }>(
    `select i.state, i.lease_owner, i.lease_expires, sr.status from item i
     left join run r on r.item_id = i.id left join stage_run sr on sr.run_id = r.id and sr.stage_id = 'green' and sr.attempt = 1
     where i.id = $1`, [id]);
  assert.equal(r.rowCount, 1, `item ${name} has more than one run or green attempt`);
  const row = r.rows[0];
  assert.equal(row.state, "InProgress", `item ${name} is ${row.state}, not InProgress`);
  assert.equal(row.lease_owner, cell, `item ${name}'s lease is held by ${row.lease_owner}, not ${cell}`);
  assert.ok(row.lease_expires && row.lease_expires > now, `item ${name}'s lease isn't live`);
  assert.equal(row.status, "started", `item ${name}'s green attempt is ${row.status}, not started`);
});

Given("an operator prepared a restart {int} hours ago", long, async function (n: number) {
  await prepare(this, "scenario: restart", n * 60);
  const r = await need().pool.query<{ created_at: Date }>(
    "select created_at from override where scope = 'factory' and kind = 'restart' and cleared_at is null");
  assert.equal(r.rowCount, 1, `${r.rowCount} active factory restart overrides, not 1`);
  const expected = p140(this).clock.getTime() - n * 3_600_000;
  assert.equal(r.rows[0].created_at.getTime(), expected, `the restart is dated ${r.rows[0].created_at.toISOString()}, not ${n} hours before the clock`);
});

Given("item {string} is queued behind it", long, async function (name: string) {
  const id = await newItem(p17(this), name, "Queued", { rank: 10_000 });
  const r = await need().pool.query<{ state: string }>("select state from item where id = $1", [id]);
  assert.equal(r.rows[0]?.state, "Queued", `item ${name} is ${r.rows[0]?.state}, not Queued`);
});

// ---- When ----

When(
  "the scheduler ticks every minute until {int} minutes have passed since the restart was prepared, while cell {string} keeps renewing its lease",
  long,
  async function (until: number, cell: string) {
    const c = ctx(this);
    const preparedAt = p140(this).preparedAt;
    assert.ok(preparedAt, "no restart was prepared");
    const s = p17(this);
    const first = Math.floor((s.now!.getTime() - preparedAt.getTime()) / 60_000) + 1;
    for (let m = first; m <= until; m++) {
      s.now = new Date(preparedAt.getTime() + m * 60_000);
      // The cell renews before each tick, so its lease is live whenever the scheduler looks. Its answer isn't judged here.
      await renew(this, cell);
      await tick(s);
      c.everStopped.push(...s.stopped);
    }
  },
);

// ---- Then ----

Then("the launcher was never asked to stop a cell", function () {
  ticked(this);
  assert.deepEqual(ctx(this).everStopped, [], "the launcher was asked to stop these cells");
});

Then("item {string}'s green attempt is still open, not recorded as stopped", long, async function (name: string) {
  const s = ticked(this);
  const r = await need().pool.query<{ status: string; ended_at: Date | null }>(
    `select sr.status, r.ended_at from stage_run sr join run r on r.id = sr.run_id
     where r.item_id = $1 and sr.stage_id = 'green' and sr.attempt = 1`, [s.items[name]]);
  assert.equal(r.rowCount, 1, `item ${name} has no green attempt`);
  assert.equal(r.rows[0].status, "started", `item ${name}'s green attempt is recorded as ${r.rows[0].status}`);
  assert.equal(r.rows[0].ended_at, null, `item ${name}'s run has ended`);
});

Then("cells start for items {string} and {string}", function (a: string, b: string) {
  const s = ticked(this);
  const started = s.started.map((env) => env.ITEM_ID).sort();
  assert.deepEqual(started, [s.items[a], s.items[b]].sort(), `${started.length} cell(s) started, for ${JSON.stringify(started)}`);
});

Then("exactly one cell starts, for item {string}", function (name: string) {
  const s = ticked(this);
  assert.deepEqual(s.started.map((env) => env.ITEM_ID), [s.items[name]], `cells started for ${JSON.stringify(s.started.map((env) => env.ITEM_ID))}`);
});
