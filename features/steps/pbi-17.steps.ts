import { Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type pg from "pg";
import { load, long, need, testDb } from "./pbi-8.steps.ts";

// Shares PBI 4's database. Rows are set up with plain SQL, and only the behaviour under test goes through
// src/scheduler and src/store/overrides. The launcher is a recorder here, so a test never starts a container.
// A module that doesn't exist yet leaves the tick unrun, and every Then fails on that before checking anything else.

const NOW = new Date("2026-11-06T10:00:00Z");
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

const REPO = "ricksu978/software-factory";

type Launcher = { start(env: Record<string, string>): Promise<string>; stop(executionName: string): Promise<void> };
type Tick = (deps: {
  pool: pg.Pool; launcher: Launcher; now: Date; killFlag: boolean; repoHost: unknown;
  backlogFor: (sourceId: string) => unknown; secret: string; controlUrl: string; sopVersion: string;
}) => Promise<unknown>;
type Fakes = {
  fakeBacklog: () => { adapter: unknown; seed(item: { externalId: string; repo: string }): Promise<string> };
  fakeRepoHost: () => { heads: Map<string, string> };
};
type OverrideKind = "pause" | "resume" | "drain" | "hold" | "unhold" | "stop_run" | "requeue" | "kill";
type SetOverride = (c: pg.PoolClient, o: { scope: "factory" | "item"; targetId: string | null; kind: OverrideKind; reason: string; createdBy: string; expiresAt: Date | null }) => Promise<void>;

type Ctx = {
  items: Record<string, string>; operator?: string; started: Record<string, string>[]; stopped: string[]; ticked: boolean; ranks: number;
  backlog?: ReturnType<Fakes["fakeBacklog"]>; repoHost?: ReturnType<Fakes["fakeRepoHost"]>;
};

function ctx(world: object): Ctx {
  const w = world as { pbi17?: Ctx };
  w.pbi17 ??= { items: {}, started: [], stopped: [], ticked: false, ranks: 0 };
  return w.pbi17;
}

function recorder(c: Ctx): Launcher {
  return {
    async start(env) {
      c.started.push(env);
      return `exec-${c.started.length}`;
    },
    async stop(name) {
      c.stopped.push(name);
    },
  };
}

async function tick(c: Ctx, killFlag = false) {
  const scheduler = await load<{ tick: Tick }>("src/scheduler/scheduler.ts");
  if (!scheduler || !c.backlog || !c.repoHost) return;
  c.started = [];
  c.stopped = [];
  const backlog = c.backlog.adapter;
  await scheduler.tick({
    pool: need().pool, launcher: recorder(c), now: NOW, killFlag, repoHost: c.repoHost, backlogFor: () => backlog,
    secret: "scenario-secret", controlUrl: "http://control.test:7400", sopVersion: "default@1",
  });
  c.ticked = true;
}

async function override(c: Ctx, kind: OverrideKind, item: string | null) {
  const mod = await load<{ setOverride: SetOverride }>("src/store/overrides.ts");
  if (!mod) return;
  const client = await need().pool.connect();
  try {
    await mod.setOverride(client, { scope: item ? "item" : "factory", targetId: item ? c.items[item] : null, kind, reason: `scenario: ${kind}`, createdBy: c.operator!, expiresAt: null });
  } finally {
    client.release();
  }
}

// Each item gets its own backlog source and an external id named after its letter.
async function newItem(c: Ctx, name: string, state: string, extra: { rank?: number; owner?: string; expires?: Date } = {}): Promise<string> {
  const pool = need().pool;
  const source = await pool.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'test:' || gen_random_uuid()) returning id");
  const r = await pool.query<{ id: string }>(
    `insert into item (source_id, external_id, title, state, backlog_rank, lease_generation, lease_owner, lease_expires)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [source.rows[0].id, name, `item ${name}`, state, extra.rank ?? 100 + ++c.ranks, extra.owner ? 1 : 0, extra.owner ?? null, extra.expires ?? null],
  );
  c.items[name] = r.rows[0].id;
  await c.backlog?.seed({ externalId: name, repo: REPO });
  return r.rows[0].id;
}

async function openRun(itemId: string, nextStage: string, executionName: string | null = null): Promise<string> {
  const r = await need().pool.query<{ id: string }>("insert into run (item_id, next_stage, execution_name, branch) values ($1, $2, $3, 'factory/pbi-x-r1') returning id", [itemId, nextStage, executionName]);
  return r.rows[0].id;
}

async function question(itemId: string, kind: "sign_off" | "needs_input", answered: boolean, askedAt = minutes(-60)) {
  await need().pool.query(
    "insert into question (item_id, kind, body, asked_at, answer, answered_at) values ($1, $2, 'q', $3, $4, $5)",
    [itemId, kind, askedAt, answered ? "approve" : null, answered ? minutes(-1) : null],
  );
}

async function state(itemId: string): Promise<{ state: string; held: boolean }> {
  return (await need().pool.query("select state, held from item where id = $1", [itemId])).rows[0];
}

function ran(c: Ctx) {
  assert.ok(c.ticked, "src/scheduler/scheduler.ts or src/store/overrides.ts doesn't exist, so the scheduler never ticked");
}

Given("a fresh factory database with WIP 1 and a review capacity of 3", long, async function () {
  const d = await testDb();
  assert.ok(d, "src/store/test-db.ts doesn't exist");
  await d.pool.query("truncate item, override, \"user\", repo cascade");
  await d.pool.query("update wip_policy set mode = 'fixed', current_wip = 1, review_capacity = 3, usage_paused_until = null");
  await d.pool.query("insert into repo (host_adapter, url) values ('github', $1)", [`https://github.com/${REPO}`]);
  const u = await d.pool.query<{ id: string }>("insert into \"user\" (provider, subject, role) values ('dev', 'operator', 'operator') returning id");
  const c = ctx(this);
  c.operator = u.rows[0].id;
  // The backlog and repo host the scheduler reads, as Task 6's in-memory fakes. Absent fakes leave the tick unrun.
  const fakes = await load<Fakes>("src/adapters/fake.ts");
  if (fakes) {
    c.backlog = fakes.fakeBacklog();
    c.repoHost = fakes.fakeRepoHost();
    c.repoHost.heads.set(REPO, "c0ffee0");
  }
});

Given("item {string} is running in cell {string} with a live lease", long, async function (name: string, cell: string) {
  const id = await newItem(ctx(this), name, "InProgress", { owner: cell, expires: minutes(4) });
  const run = await openRun(id, "green", cell);
  await need().pool.query("insert into stage_run (run_id, stage_id, attempt, status) values ($1, 'understand', 1, 'passed')", [run]);
});

Given("item {string} is running in cell {string} with a lease that ran out", long, async function (name: string, cell: string) {
  const id = await newItem(ctx(this), name, "InProgress", { owner: cell, expires: minutes(-1) });
  await openRun(id, "green", cell);
});

Given("item {string} is queued", long, async function (name: string) {
  await newItem(ctx(this), name, "Queued");
});

Given("item {string} is queued and ranked first", long, async function (name: string) {
  await newItem(ctx(this), name, "Queued", { rank: 1 });
});

// Back from changes_requested: its run has stages behind it and resumes at address, so the brake doesn't gate it (Run contract 3).
Given("item {string} is queued to address requested changes", long, async function (name: string) {
  const id = await newItem(ctx(this), name, "Queued");
  const run = await openRun(id, "address");
  await need().pool.query("insert into stage_run (run_id, stage_id, attempt, status) values ($1, 'open-pr', 1, 'passed')", [run]);
});

Given("item {string} waits for an unanswered sign-off", long, async function (name: string) {
  const id = await newItem(ctx(this), name, "SignOff");
  await openRun(id, "sign-off");
  await question(id, "sign_off", false);
});

Given("item {string} waits for an unanswered sign-off asked {int} days ago", long, async function (name: string, days: number) {
  const id = await newItem(ctx(this), name, "SignOff");
  await openRun(id, "sign-off");
  await question(id, "sign_off", false, minutes(-days * 24 * 60));
});

Given("item {string} waits for a sign-off that has been answered", long, async function (name: string) {
  const id = await newItem(ctx(this), name, "SignOff");
  await openRun(id, "red");
  await question(id, "sign_off", true);
});

Given("item {string} waits for an unanswered question", long, async function (name: string) {
  const id = await newItem(ctx(this), name, "NeedsInput");
  await openRun(id, "green");
  await question(id, "needs_input", false);
});

Given("item {string} is in review", long, async function (name: string) {
  const id = await newItem(ctx(this), name, "InReview");
  await need().pool.query("insert into run (item_id, next_stage, pr_number, branch) values ($1, 'address', 7, 'factory/pbi-r-r1')", [id]);
});

Given("an operator holds item {string}", long, async function (name: string) {
  await override(ctx(this), "hold", name);
});

When("the scheduler ticks", long, async function () {
  await tick(ctx(this));
});

// Review Focus 5: a fresh process has no memory of what it started, so only the lease in the database stops it.
When("a newly started scheduler process ticks", long, async function () {
  await tick(ctx(this));
});

When("an operator turns on the kill switch and the scheduler ticks", long, async function () {
  const c = ctx(this);
  await override(c, "kill", null);
  await tick(c);
});

When("the control plane starts with its kill flag set and the scheduler ticks", long, async function () {
  await tick(ctx(this), true);
});

When("an operator stops item {string}'s run and the scheduler ticks", long, async function (name: string) {
  const c = ctx(this);
  await override(c, "stop_run", name);
  await tick(c);
});

When("an operator re-queues item {string} and the scheduler ticks", long, async function (name: string) {
  const c = ctx(this);
  await override(c, "requeue", name);
  await tick(c);
});

Then("no cell starts", function () {
  const c = ctx(this);
  ran(c);
  assert.deepEqual(c.started, []);
});

Then("exactly one cell starts", function () {
  const c = ctx(this);
  ran(c);
  assert.equal(c.started.length, 1);
});

Then("a cell starts for item {string}", function (name: string) {
  const c = ctx(this);
  ran(c);
  assert.deepEqual(c.started.map((env) => env.ITEM_ID), [c.items[name]]);
});

Then("item {string} is {string}", long, async function (name: string, expected: string) {
  const c = ctx(this);
  ran(c);
  assert.equal((await state(c.items[name])).state, expected);
});

// The tick may claim the same item again straight after, so its current state proves nothing. The event log shows
// whether it left: a transition out of that state on this tick.
Then("item {string} has left {string}", long, async function (name: string, left: string) {
  const c = ctx(this);
  ran(c);
  const moves = await need().pool.query("select 1 from event where item_id = $1 and kind = 'transition' and payload->>'from' = $2", [c.items[name], left]);
  assert.ok(moves.rowCount, `item ${name} never left ${left}`);
});

Then("cells {string} and {string} are stopped", function (a: string, b: string) {
  const c = ctx(this);
  ran(c);
  assert.deepEqual([...c.stopped].sort(), [a, b].sort());
});

Then("cell {string} is stopped", function (cell: string) {
  const c = ctx(this);
  ran(c);
  assert.deepEqual(c.stopped, [cell]);
});

Then("item {string} is {string} and held", long, async function (name: string, expected: string) {
  const c = ctx(this);
  ran(c);
  assert.deepEqual(await state(c.items[name]), { state: expected, held: true });
});

Then("item {string} is no longer held", long, async function (name: string) {
  const c = ctx(this);
  ran(c);
  assert.equal((await state(c.items[name])).held, false);
});
