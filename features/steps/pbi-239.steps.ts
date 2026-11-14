// Step definitions for features/pbi-239-lease-expiry-closes-attempt.feature. The @db scenarios share PBI 4's test
// database, except the migration ones, which each get a database of their own at today's schema, as PBI 117's do, and
// run PBI 117's "the factory migrates that database" on it.
//
// Every attempt is closed the way the factory closes it: by expireLeases, by a scheduler tick or by a cell's report
// through the real cell API, never by writing the row here. A scenario's own clock, taken when it starts, drives the
// scheduler, the cell API and PBI 140's "an operator prepared a restart" alike, so "N minutes ago" means the same to each.
//
// The retries scenarios run the cell engine in a real temporary git repo (PBI 18's setUp) with a scripted agent. The
// context it starts from is the one the control plane's cell API gives the cell the scheduler started, and its stage
// reports go to that cell API, so what the database holds is what the factory wrote.
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import pg from "pg";
import { runCell } from "../../src/cell/engine.ts";
import { shellGit } from "../../src/cell/git.ts";
import { loadSop, stageAfter } from "../../src/config/sop.ts";
import { cellApi, runToken } from "../../src/control/cell-api.ts";
import { startServer } from "../../src/http/server.ts";
import { parseCriteria, type Policy, type PolicyName } from "../../src/policy/policy.ts";
import { withTx } from "../../src/store/db.ts";
import { expireLeases } from "../../src/store/items.ts";
import { ctx as p8, long, need, testDb } from "./pbi-8.steps.ts";
import { ctx as p17, newItem, tick } from "./pbi-17.steps.ts";
import { setUp, type Ctx as Pbi18 } from "./pbi-18.steps.ts";
import { CELL_SECRET, ctx as p89 } from "./pbi-89.steps.ts";

const REPO = "ricksu978/software-factory";
const WAIT = "FACTORY_RESTART_WAIT_MINUTES";
const SOP_TEXT = readFileSync(join(process.cwd(), "sop/default.yml"), "utf8");
const migrationsDir = join(process.cwd(), "db", "migrations");
/** Today's schema: the migrations that exist before this item's. This item's migration is the one the scenarios run. */
const TODAY = [
  "001_init.sql", "002_item_blocked_by.sql", "003_cell_api.sql", "003_item_readiness_item_hash.sql", "004_user_github_login_ci.sql",
  "005_stage_run_message.sql", "006_event_at.sql", "007_additive_schema.sql", "008_item_repo.sql", "008_readiness_check.sql",
  "009_item_split.sql", "010_scenario_notes.sql", "011_item_issue_created_at.sql", "011_stage_run_restates.sql",
];

/** A message that says the cell's lease ran out. */
const LEASE_RAN_OUT = /\blease\b.*\b(ran out|run out|expired)\b/i;

type Engine = {
  c: Pbi18;
  mode: "fail" | "pass";
  /** The started cell's run and generation, whose token its reports carry. */
  runId: string;
  generation: number;
  calls: { route: string; body: Record<string, any> }[];
  stage: string;
  result?: string | null;
  error?: unknown;
  ran: boolean;
};

type Ctx = {
  clock: Date;
  restore: (() => void)[];
  /** The run "the item's run" and "<stage>'s attempt <n>" mean. */
  runId?: string;
  otherRunId?: string;
  /** Each attempt a Given ended, by "stage:attempt", with the end time it was given. */
  ended: Map<string, Date>;
  /** When the last Given finished setting a database up, so a migration after it ran no earlier. */
  seededAt?: Date;
  /** When a cell's report reached the cell API. */
  reportAt?: Date;
  cellServer?: Server;
  engine?: Engine;
  /** PBI 117's database of its own, for the migration scenarios. */
  dbName?: string;
};

function ctx(world: object): Ctx {
  const w = world as { pbi239?: Ctx };
  w.pbi239 ??= { clock: new Date(), restore: [], ended: new Map() };
  return w.pbi239;
}

const minutesFrom = (at: Date, n: number) => new Date(at.getTime() + n * 60_000);

/** The scenario's database: its own one in the migration scenarios, otherwise PBI 4's shared one. */
function db(world: object): pg.Pool {
  return (world as { pbi117?: { pool?: pg.Pool } }).pbi117?.pool ?? need().pool;
}

Before({ tags: "@pbi-239" }, function () {
  const c = ctx(this);
  // PBI 140's steps read its context's clock, and PBI 17's scheduler its `now`. Both are this scenario's clock.
  (this as { pbi140?: unknown }).pbi140 = { clock: c.clock, logs: [], restore: [], renewals: [], origins: new Map(), steps: [] };
  p17(this).now = c.clock;
  const wait = process.env[WAIT];
  delete process.env[WAIT];
  c.restore.push(() => (wait === undefined ? delete process.env[WAIT] : (process.env[WAIT] = wait)));
});

Before({ tags: "@pbi-239 and @db", ...long }, async function () {
  const d = await testDb();
  if (!d) return;
  await d.pool.query(`truncate item, "user", backlog_source, repo, webhook_delivery, override cascade`);
  await d.pool.query("update wip_policy set mode = 'fixed', current_wip = 1, review_capacity = 3, usage_paused_until = null");
});

After({ tags: "@pbi-239", ...long }, async function () {
  const c = ctx(this);
  for (const r of c.restore.reverse()) r();
  const control = p89(this);
  await control.close?.();
  for (const s of [control.server, c.cellServer]) {
    if (!s) continue;
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  const own = (this as { pbi117?: { pool?: pg.Pool } }).pbi117;
  await own?.pool?.end().catch(() => undefined);
  if (c.dbName) await (await testDb())?.pool.query(`drop database if exists ${c.dbName} with (force)`);
});

// ---- reading attempts ----

type Attempt = { status: string; ended_at: Date | null; message: string | null; transcript_ref: string | null };

async function attemptOf(p: pg.Pool, runId: string | undefined, stage: string, attempt: number): Promise<Attempt> {
  assert.ok(runId, "no run was set up");
  const r = await p.query<Attempt>(
    "select status, ended_at, message, transcript_ref from stage_run where run_id = $1 and stage_id = $2 and attempt = $3", [runId, stage, attempt]);
  assert.equal(r.rowCount, 1, `the run has no ${stage} attempt ${attempt}`);
  return r.rows[0];
}

const attempt = (world: object, stage: string, n: number) => attemptOf(db(world), ctx(world).runId, stage, n);

async function itemRun(world: object, name: string): Promise<string> {
  const id = p17(world).items[name];
  assert.ok(id, `no item "${name}" was created`);
  const r = await need().pool.query<{ id: string }>("select id from run where item_id = $1 order by run_number desc limit 1", [id]);
  assert.ok(r.rowCount, `item ${name} has no run`);
  return r.rows[0].id;
}

const itemAttempt = async (world: object, name: string, stage: string, n: number) => attemptOf(need().pool, await itemRun(world, name), stage, n);

function stopped(a: Attempt, what: string) {
  assert.equal(a.status, "stopped", `${what} is recorded as ${a.status}`);
}

function leaseMessage(a: Attempt, what: string) {
  assert.ok(a.message, `${what} has no message`);
  assert.match(a.message, LEASE_RAN_OUT, `${what}'s message doesn't say the cell's lease ran out: "${a.message}"`);
}

function endedAt(a: Attempt, at: Date, what: string) {
  assert.ok(a.ended_at, `${what} has no end time`);
  assert.equal(a.ended_at.toISOString(), at.toISOString(), `${what}'s end time`);
}

/** The end time of a migration that ran after the database was set up, before this step. */
function endedByMigration(world: object, a: Attempt, what: string) {
  const seeded = ctx(world).seededAt;
  assert.ok(seeded, "no database was set up");
  assert.ok(a.ended_at, `${what} has no end time`);
  const slack = 2_000;
  assert.ok(a.ended_at.getTime() >= seeded.getTime() - slack && a.ended_at.getTime() <= Date.now() + slack,
    `${what} ended at ${a.ended_at.toISOString()}, not when the migration ran, after ${seeded.toISOString()}`);
}

// ---- AC-1: an item whose lease ran out ----

async function leasedItem(state: string, owner: string, until: string): Promise<{ itemId: string; runId: string }> {
  const pool = need().pool;
  const source = await pool.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'test:' || gen_random_uuid()) returning id");
  const item = await pool.query<{ id: string }>(
    `insert into item (source_id, external_id, title, state, lease_generation, lease_owner, lease_expires)
     values ($1, gen_random_uuid()::text, 'test item', $2, 1, $3, $4) returning id`,
    [source.rows[0].id, state, owner, until],
  );
  const run = await pool.query<{ id: string }>("insert into run (item_id, next_stage, execution_name) values ($1, 'green', $2) returning id", [item.rows[0].id, owner]);
  return { itemId: item.rows[0].id, runId: run.rows[0].id };
}

async function startedAttempt(p: pg.Pool, runId: string, stage: string, n: number, startedAt: Date) {
  await p.query("insert into stage_run (run_id, stage_id, attempt, status, started_at) values ($1, $2, $3, 'started', $4)", [runId, stage, n, startedAt]);
}

async function endedAttempt(world: object, p: pg.Pool, runId: string, stage: string, n: number, status: string, endedAt: Date, message: string) {
  await p.query(
    "insert into stage_run (run_id, stage_id, attempt, status, started_at, ended_at, message) values ($1, $2, $3, $4, $5, $6, $7)",
    [runId, stage, n, status, minutesFrom(endedAt, -5), endedAt, message]);
  ctx(world).ended.set(`${stage}:${n}`, endedAt);
}

Given("a fresh factory database with an item in state {string}, leased by {string} until {string}", long, async function (state: string, owner: string, until: string) {
  const { itemId, runId } = await leasedItem(state, owner, until);
  p8(this).itemId = itemId;
  ctx(this).runId = runId;
});

Given("the item's run has {word} attempt {int} started at {string} and never reported", long, async function (stage: string, n: number, at: string) {
  const runId = ctx(this).runId;
  assert.ok(runId, "no item was created");
  await startedAttempt(need().pool, runId, stage, n, new Date(at));
});

Given("the item's run has {word} attempt {int} that {word} at {string} with the message {string}", long, async function (stage: string, n: number, status: string, at: string, message: string) {
  const runId = ctx(this).runId;
  assert.ok(runId, "no item was created");
  await endedAttempt(this, need().pool, runId, stage, n, status, new Date(at), message);
});

Given("another item in state {string}, leased by {string} until {string}, whose run has {word} attempt {int} started and never reported", long,
  async function (state: string, owner: string, until: string, stage: string, n: number) {
    const { runId } = await leasedItem(state, owner, until);
    ctx(this).otherRunId = runId;
    await startedAttempt(need().pool, runId, stage, n, minutesFrom(new Date(until), -5));
  });

Then("{word}'s attempt {int} is recorded as stopped", long, async function (stage: string, n: number) {
  stopped(await attempt(this, stage, n), `${stage}'s attempt ${n}`);
});

Then("{word}'s attempt {int} ended at {string}", long, async function (stage: string, n: number, at: string) {
  endedAt(await attempt(this, stage, n), new Date(at), `${stage}'s attempt ${n}`);
});

Then("{word}'s attempt {int} has a message saying the cell's lease ran out", long, async function (stage: string, n: number) {
  leaseMessage(await attempt(this, stage, n), `${stage}'s attempt ${n}`);
});

Then("{word}'s attempt {int} is recorded as stopped, ended at {string}, with a message saying the cell's lease ran out", long, async function (stage: string, n: number, at: string) {
  const a = await attempt(this, stage, n);
  const what = `${stage}'s attempt ${n}`;
  stopped(a, what);
  endedAt(a, new Date(at), what);
  leaseMessage(a, what);
});

Then("{word}'s attempt {int} is still recorded as {word}, ended at {string}, with the message {string}", long, async function (stage: string, n: number, status: string, at: string, message: string) {
  const a = await attempt(this, stage, n);
  assert.equal(a.status, status);
  endedAt(a, new Date(at), `${stage}'s attempt ${n}`);
  assert.equal(a.message, message);
});

Then("the other item's {word} attempt {int} is recorded as stopped, with a message saying the cell's lease ran out", long, async function (stage: string, n: number) {
  const a = await attemptOf(need().pool, ctx(this).otherRunId, stage, n);
  const what = `the other item's ${stage} attempt ${n}`;
  stopped(a, what);
  leaseMessage(a, what);
});

Then("{word}'s attempt {int} is still recorded as started, with no end time and no message", long, async function (stage: string, n: number) {
  const a = await attempt(this, stage, n);
  assert.equal(a.status, "started");
  assert.equal(a.ended_at, null);
  assert.equal(a.message, null);
});

// ---- AC-2: a restart sends a cell's item back to Queued ----

const STAGES = ["understand", "specify", "red", "green"];

/** Item `name` with `cell` running it at green, its earlier stages passed, and the lease ending at `expires`. */
async function itemAtGreen(world: object, name: string, cell: string, expires: Date): Promise<string> {
  const s = p17(world);
  const pool = need().pool;
  const id = await newItem(s, name, "InProgress", { owner: cell, expires });
  const run = (await pool.query<{ id: string }>(
    `insert into run (item_id, next_stage, execution_name, branch, repo_id, config_sha, sop_version)
     values ($1, 'green', $2, $3, (select id from repo where url = $4), 'c0ffee0', '0.1.0') returning id`,
    [id, cell, `factory/pbi-${name}-r1`, `https://github.com/${REPO}`])).rows[0].id;
  const start = minutesFrom(ctx(world).clock, -60);
  for (const [i, earlier] of STAGES.slice(0, STAGES.indexOf("green")).entries()) {
    await pool.query("insert into stage_run (run_id, stage_id, attempt, status, started_at, ended_at) values ($1, $2, 1, 'passed', $3, $4)",
      [run, earlier, minutesFrom(start, i * 5), minutesFrom(start, i * 5 + 4)]);
  }
  // PBI 16's "item {string} is in state {string}" reads its own context's items and wants a cell API up.
  const w = world as { pbi16?: { items: Map<string, string>; server?: Server } };
  w.pbi16 ??= { seen: [], items: new Map(), statuses: [], at: new Date() } as never;
  w.pbi16!.items.set(name, id);
  w.pbi16!.server = await cellServer(world);
  return run;
}

Given("item {string} is running in cell {string} with a live lease, at green attempt {int}, started and never reported", long, async function (name: string, cell: string, n: number) {
  const c = ctx(this);
  const run = await itemAtGreen(this, name, cell, minutesFrom(c.clock, 4));
  await startedAttempt(need().pool, run, "green", n, minutesFrom(c.clock, -20));
});

Given("item {string} is running in cell {string} with a live lease, at green attempt {int}", long, async function (name: string, cell: string, n: number) {
  const c = ctx(this);
  const run = await itemAtGreen(this, name, cell, minutesFrom(c.clock, 4));
  await startedAttempt(need().pool, run, "green", n, minutesFrom(c.clock, -10));
});

Given("item {string}'s run still holds green attempt {int}, started by a cell that died and never reported", long, async function (name: string, n: number) {
  await startedAttempt(need().pool, await itemRun(this, name), "green", n, minutesFrom(ctx(this).clock, -30));
});

/** The control plane's cell API on the shared database, reading the scenario's clock. */
async function cellServer(world: object): Promise<Server> {
  const c = ctx(world);
  if (!c.cellServer) {
    const s = p17(world);
    const sop = loadSop(SOP_TEXT);
    c.cellServer = await startServer([cellApi({
      pool: need().pool, secret: CELL_SECRET, repoHost: s.repoHost as never, backlogFor: () => s.backlog!.adapter as never,
      stageAfter: (_version, stageId) => stageAfter(sop, stageId), uploadUrl: async (path) => `http://blob.test/${path}`,
      gateway: { upstream: "http://model.test", ownerToken: () => "unused" }, webToolsOf: () => [],
      now: () => s.now ?? new Date(),
    })], { port: 0 });
  }
  return c.cellServer;
}

async function call(world: object, run: { runId: string; generation: number }, method: "GET" | "POST", route: string, body?: unknown) {
  const port = ((await cellServer(world)).address() as AddressInfo).port;
  const res = await fetch(`http://127.0.0.1:${port}/internal/cells/${run.runId}/${route}`, {
    method,
    headers: { authorization: `Bearer ${runToken(CELL_SECRET, run.runId, run.generation)}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Record<string, any> = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { text };
  }
  return { status: res.status, body: parsed };
}

When("cell {string} reports {word}'s attempt {int} as stopped", long, async function (cell: string, stage: string, n: number) {
  const pool = need().pool;
  const r = await pool.query<{ run_id: string; generation: number }>(
    "select r.id as run_id, i.lease_generation as generation from run r join item i on i.id = r.item_id where r.execution_name = $1", [cell]);
  assert.ok(r.rowCount, `no run has the cell ${cell}`);
  const c = ctx(this);
  c.reportAt = p17(this).now ?? c.clock;
  const a = await call(this, { runId: r.rows[0].run_id, generation: r.rows[0].generation }, "POST", "stage",
    { stageId: stage, attempt: n, status: "stopped", model: "claude-opus-5-5", tokensIn: 0, tokensOut: 0, costUsd: 0 });
  assert.equal(a.status, 200, `the cell API answered ${JSON.stringify(a)}`);
});

Then("item {string}'s {word} attempt {int} is recorded as stopped", long, async function (name: string, stage: string, n: number) {
  stopped(await itemAttempt(this, name, stage, n), `item ${name}'s ${stage} attempt ${n}`);
});

Then("item {string}'s {word} attempt {int} is recorded as stopped, ended at the moment of that tick", long, async function (name: string, stage: string, n: number) {
  const s = p17(this);
  assert.ok(s.ticked, "the scheduler never ticked");
  const a = await itemAttempt(this, name, stage, n);
  const what = `item ${name}'s ${stage} attempt ${n}`;
  stopped(a, what);
  endedAt(a, s.now!, what);
});

Then("item {string}'s {word} attempt {int} has a message saying the cell's lease ran out", long, async function (name: string, stage: string, n: number) {
  leaseMessage(await itemAttempt(this, name, stage, n), `item ${name}'s ${stage} attempt ${n}`);
});

Then("item {string}'s {word} attempt {int} is recorded as stopped, ended at the moment of that report, with a message saying the cell's lease ran out", long,
  async function (name: string, stage: string, n: number) {
    const at = ctx(this).reportAt;
    assert.ok(at, "no cell reported");
    const a = await itemAttempt(this, name, stage, n);
    const what = `item ${name}'s ${stage} attempt ${n}`;
    stopped(a, what);
    endedAt(a, at, what);
    leaseMessage(a, what);
  });

// ---- AC-3: retries after an expired lease ----

Given("green allows {int} retries", function (n: number) {
  // The same setting PBI 140's "green allows {int} retry" makes.
  (this as unknown as { pbi140: { greenRetries?: number } }).pbi140.greenRetries = n;
});

Given("item {string}'s cell died at green attempt {int}, started and never reported, and its lease ran out", long, async function (name: string, n: number) {
  const c = ctx(this);
  const run = await itemAtGreen(this, name, `cell-${name.toLowerCase()}`, minutesFrom(c.clock, -1));
  await startedAttempt(need().pool, run, "green", n, minutesFrom(c.clock, -10));
});

function policy(name: PolicyName, text: string): Policy {
  return { name, source: "repo", sha: name, text, criteria: name === "scenarios" || name === "risk" ? [] : parseCriteria(text) };
}

const fwd = (p: string) => p.replace(/\\/g, "/");

/** The scheduler ticks, and the cell it starts for the item runs from the context the cell API gives it. */
async function tickAndRun(world: object, name: string, mode: Engine["mode"]): Promise<void> {
  const s = p17(world);
  await tick(s);
  const env = s.started.find((e) => e.ITEM_ID === s.items[name]);
  assert.ok(env, `no cell started for item ${name}`);
  const run = { runId: env.RUN_ID, generation: Number(env.GENERATION) };
  const context = await call(world, run, "GET", "context");
  assert.equal(context.status, 200, `the new cell's context: ${JSON.stringify(context)}`);

  const c = setUp(world, "green", true);
  const e: Engine = { c, mode, ...run, calls: [], stage: "", ran: false };
  ctx(world).engine = e;
  const greenPassed = () => e.calls.some((x) => x.route === "/stage" && x.body.stageId === "green" && x.body.status === "passed");
  const api = {
    async lease() {
      e.calls.push({ route: "/lease", body: {} });
      // Once green has passed the run has moved on, and the cell is stopped there, so nothing past green runs.
      return { stop: greenPassed() };
    },
    async stage(b: Record<string, any>) {
      e.calls.push({ route: "/stage", body: b });
      if (b.status === "started") e.stage = b.stageId;
      const a = await call(world, run, "POST", "stage", b);
      if (a.status !== 200) throw new Error(`the cell API answered the ${b.stageId} report with ${JSON.stringify(a)}`);
    },
    async transition(b: Record<string, any>) { e.calls.push({ route: "/transition", body: b }); },
    async policyResults(b: Record<string, any>) { e.calls.push({ route: "/policy-results", body: b }); },
    async pr(b: Record<string, any>) { e.calls.push({ route: "/pr", body: b }); },
    async checks() { return "success"; },
    async upload() {},
  };
  // Green's agent changes the app and leaves a report: every scenario red when its attempts fail, green when one passes.
  let edits = 0;
  const agent = async (a: { prompt: string; cwd: string; model: string; agent?: string }) => {
    let text = "done";
    if (e.stage === "green") {
      writeFileSync(join(a.cwd, "app.txt"), `green's change ${++edits}\n`);
      const red = readFileSync(join(c.fixtures, "parse.ndjson"), "utf8");
      if (mode === "fail") copyFileSync(join(c.fixtures, "parse.ndjson"), join(c.fixtures, "run.ndjson"));
      else writeFileSync(join(c.fixtures, "run.ndjson"), red.replace(/\{"status":"FAILED","message":"AssertionError"\}/g, '{"status":"PASSED"}'));
    }
    if (a.agent === "factory-self-reviewer") text = "APPROVED";
    return { ok: true, text, costUsd: 0.5, tokensIn: 10, tokensOut: 5, model: a.model, limit: null, usage: null, transcript: "{}\n" };
  };
  const sop = loadSop(SOP_TEXT);
  const greenRetries = (world as { pbi140?: { greenRetries?: number } }).pbi140?.greenRetries;
  if (greenRetries !== undefined) for (const st of sop.stages) if (st.id === "green") (st as { retries?: unknown }).retries = greenRetries;
  const dryOrRun = (file: string) => `sh -c 'mkdir -p reports && if [ "$0" = --dry-run ]; then sed -E "s/\\"status\\":\\"[A-Z]+\\"/\\"status\\":\\"SKIPPED\\"/g" "${fwd(join(c.fixtures, file))}" > reports/bdd.ndjson; else cp "${fwd(join(c.fixtures, file))}" reports/bdd.ndjson; fi'`;
  const ctxBody = context.body;
  try {
    e.result = await runCell({
      api: api as never,
      ctx: {
        externalId: "482", title: "Item 482", acceptanceCriteria: ["Criterion 1 holds", "Criterion 2 holds", "Criterion 3 holds"],
        nextStage: ctxBody.nextStage, decision: null, lockSha: c.lockSha, lockedFiles: c.lockedFiles, prNumber: null,
        repo: "acme/app", base: "main", branch: "factory/pbi-482-r1", configSha: "c0ffee", sopVersion: "0.1.0",
        dodVerdicts: [], dodCheckedSha: null, trustedComments: [], stageAttempts: ctxBody.stageAttempts, resume: ctxBody.resume ?? null,
      },
      agent: agent as never,
      git: shellGit(c.dir, "factory/pbi-482-r1"),
      dir: c.dir,
      repoHost: {} as never,
      sop,
      config: { sensitivePaths: [], reviewers: ["owner"], webTools: [],
        bdd: { parse: `mkdir -p reports && cp "${fwd(join(c.fixtures, "parse.ndjson"))}" reports/bdd.ndjson`, run: dryOrRun("run.ndjson"), report: "reports/bdd.ndjson" },
        commands: { test: "true", lint: "true" } } as never,
      policies: { scenarios: policy("scenarios", "Write in business language.\n"), prReview: policy("pr-review", "- [ ] Code is readable.\n"),
        risk: policy("risk", "Low by default.\n"), dod: policy("dod", "- [ ] Typecheck passes. `run: true`\n") },
      now: () => new Date(),
      sleep: async () => {},
    });
    e.error = null;
  } catch (err) {
    e.error = err;
  }
  e.ran = true;
}

When("the scheduler ticks and a cell starts for item {string}, and every green attempt fails", long, async function (name: string) {
  await tickAndRun(this, name, "fail");
});

When("the scheduler ticks and a cell starts for item {string}, and its green attempt passes", long, async function (name: string) {
  await tickAndRun(this, name, "pass");
});

function finished(world: object): Engine {
  const e = ctx(world).engine;
  assert.ok(e?.ran, "the cell never ran");
  return e;
}

const greenReports = (e: Engine, status: string) => e.calls.filter((x) => x.route === "/stage" && x.body.stageId === "green" && x.body.status === status);

Then("the cell makes {int} green attempts after attempt {int} before it reports green's retries used up", function (n: number, after: number) {
  const e = finished(this);
  assert.equal(e.error, null, `the cell failed: ${String(e.error)}`);
  assert.deepEqual(greenReports(e, "started").map((x) => x.body.attempt), Array.from({ length: n }, (_, i) => after + 1 + i));
  assert.equal(e.calls.filter((x) => x.route === "/transition").at(-1)?.body.event, "retries_exhausted");
});

Then("item {string}'s {word} attempt {int} is still recorded as stopped, with a message saying the cell's lease ran out", long, async function (name: string, stage: string, n: number) {
  const a = await itemAttempt(this, name, stage, n);
  const what = `item ${name}'s ${stage} attempt ${n}`;
  stopped(a, what);
  leaseMessage(a, what);
});

Then("item {string}'s run moves on past green", long, async function (name: string) {
  const e = finished(this);
  assert.equal(e.error, null, `the cell failed: ${String(e.error)}`);
  assert.equal(greenReports(e, "passed").length, 1, "green never passed");
  const r = await need().pool.query<{ next_stage: string }>("select next_stage from run where id = $1", [await itemRun(this, name)]);
  assert.notEqual(r.rows[0].next_stage, "green", "the run still resumes at green");
});

Then("item {string}'s green attempt {int} is recorded as stopped and its green attempt {int} as passed", long, async function (name: string, first: number, second: number) {
  stopped(await itemAttempt(this, name, "green", first), `item ${name}'s green attempt ${first}`);
  assert.equal((await itemAttempt(this, name, "green", second)).status, "passed", `item ${name}'s green attempt ${second}`);
});

Then("item {string} wasn't failed for using up green's retries", long, async function (name: string) {
  const e = finished(this);
  assert.deepEqual(e.calls.filter((x) => x.route === "/transition" && x.body.event === "retries_exhausted").map((x) => x.body), []);
  const r = await need().pool.query<{ state: string }>("select state from item where id = $1", [p17(this).items[name]]);
  assert.notEqual(r.rows[0].state, "Failed");
});

// ---- AC-4: Run detail ----

/** Item `name` at green attempt 1, whose cell died and whose lease the factory then found had run out. */
async function closedByLease(world: object, name: string, transcript: boolean): Promise<string> {
  const c = ctx(world);
  const s = p17(world);
  const pool = need().pool;
  const id = await newItem(s, name, "InProgress", { owner: `cell-${name.toLowerCase()}`, expires: minutesFrom(c.clock, -1) });
  const run = (await pool.query<{ id: string }>("insert into run (item_id, next_stage, execution_name) values ($1, 'green', $2) returning id",
    [id, `cell-${name.toLowerCase()}`])).rows[0].id;
  const ref = transcript ? `transcripts/${run}/green-1.jsonl` : null;
  await pool.query("insert into stage_run (run_id, stage_id, attempt, status, started_at, transcript_ref) values ($1, 'green', 1, 'started', $2, $3)",
    [run, minutesFrom(c.clock, -10), ref]);
  if (ref) p89(world).blobs?.set(ref, '{"type":"assistant"}\n');
  await withTx(pool, (cl) => expireLeases(cl, c.clock));
  return run;
}

Given("item {string}'s green attempt 1, which has no transcript, was closed as stopped when its cell's lease ran out", long, async function (name: string) {
  await closedByLease(this, name, false);
});

Given("item {string}'s green attempt 1, which has a stored transcript, was closed as stopped when its cell's lease ran out", long, async function (name: string) {
  await closedByLease(this, name, true);
});

Given("item {string}'s green attempt 1 was closed as stopped when its cell's lease ran out", long, async function (name: string) {
  await closedByLease(this, name, false);
});

Given("item {string}'s green attempt {int} failed with the message {string}", long, async function (name: string, n: number, message: string) {
  const c = ctx(this);
  await need().pool.query(
    "insert into stage_run (run_id, stage_id, attempt, status, started_at, ended_at, message) values ($1, 'green', $2, 'failed', $3, $4, $5)",
    [await itemRun(this, name), n, minutesFrom(c.clock, -5), minutesFrom(c.clock, -2), message]);
});

/** The Stages table's row for the attempt, as its HTML. */
function stageRow(world: object, stage: string, n: number): string {
  const control = p89(world);
  assert.equal(control.status, 200, "Run detail didn't open");
  const row = control.html!.split("<tr>").find((r) => r.startsWith(`<td>${stage}</td><td>${n}</td>`));
  assert.ok(row, `Run detail has no ${stage} attempt ${n}`);
  return row.slice(0, row.indexOf("</tr>"));
}

const cells = (row: string) => [...row.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) => m[1]);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function showsStatus(world: object, stage: string, n: number, status: string) {
  assert.equal(cells(stageRow(world, stage, n))[2], status, `${stage}'s attempt ${n} shows as ${cells(stageRow(world, stage, n))[2]}`);
}

function showsLeaseMessage(world: object, stage: string, n: number) {
  const row = text(stageRow(world, stage, n));
  assert.match(row, LEASE_RAN_OUT, `${stage}'s attempt ${n} shows no message saying the cell's lease ran out: ${row}`);
}

Then("green's attempt {int} shows the message saying the cell's lease ran out", function (n: number) {
  showsLeaseMessage(this, "green", n);
});

Then("green's attempt {int} shows no transcript link", function (n: number) {
  assert.doesNotMatch(stageRow(this, "green", n), /<a href="\/blobs\//, `green's attempt ${n} links a transcript`);
});

Then("green's attempt {int} doesn't show {string}", function (n: number, shown: string) {
  assert.ok(!text(stageRow(this, "green", n)).includes(shown), `green's attempt ${n} shows "${shown}"`);
});

Then("green's attempt {int} links its transcript", function (n: number) {
  assert.match(stageRow(this, "green", n), new RegExp(`<a href="/blobs/transcripts/[0-9a-f-]{36}/green-${n}\\.jsonl">`), `green's attempt ${n} doesn't link its transcript`);
});

Then("green's attempt {int} shows as stopped, with the message saying the cell's lease ran out", function (n: number) {
  showsStatus(this, "green", n, "stopped");
  showsLeaseMessage(this, "green", n);
});

Then("green's attempt {int} shows as failed, with the message {string}", function (n: number, message: string) {
  showsStatus(this, "green", n, "failed");
  assert.ok(text(stageRow(this, "green", n)).includes(message), `green's attempt ${n} doesn't show the message "${message}"`);
});

// ---- AC-5: the migration ----

/** A database of the scenario's own at today's schema, which PBI 117's "the factory migrates that database" migrates. */
async function todaysSchema(world: object): Promise<pg.Pool> {
  const d = await testDb();
  assert.ok(d, "src/store/test-db.ts doesn't exist");
  const base = (d as unknown as { url?: string }).url;
  assert.ok(base, "the test database has no url");
  const c = ctx(world);
  c.dbName = `pbi239_${Math.random().toString(36).slice(2, 10)}`;
  await d.pool.query(`create database ${c.dbName}`);
  const [path, query] = base.split("?");
  const url = `${path.slice(0, path.lastIndexOf("/"))}/${c.dbName}${query ? `?${query}` : ""}`;
  const p = new pg.Pool({ connectionString: url });
  p.on("error", (e: Error & { code?: string }) => {
    if (e.code !== "57P01") throw e;
  });
  (world as { pbi117?: unknown }).pbi117 = { name: c.dbName, url, pool: p, adds: [], steps: {}, attempts: [] };
  await p.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
  for (const name of TODAY) {
    await p.query(readFileSync(join(migrationsDir, name), "utf8"));
    await p.query("insert into schema_migrations (name) values ($1)", [name]);
  }
  return p;
}

/** A run in the scenario's own database: open, or ended an hour ago with its item Failed. */
async function aRun(world: object, ended: boolean): Promise<pg.Pool> {
  const p = await todaysSchema(world);
  const s = await p.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'test:' || gen_random_uuid()) returning id");
  const i = await p.query<{ id: string }>("insert into item (source_id, external_id, title, state) values ($1, gen_random_uuid()::text, 'an item', $2) returning id",
    [s.rows[0].id, ended ? "Failed" : "InProgress"]);
  const r = await p.query<{ id: string }>("insert into run (item_id, ended_at) values ($1, $2) returning id", [i.rows[0].id, ended ? minutesFrom(ctx(world).clock, -60) : null]);
  ctx(world).runId = r.rows[0].id;
  return p;
}

/** Attempts start three hours ago, ten minutes apart in the order the Givens name them. */
const nth = (world: object, k: number) => minutesFrom(ctx(world).clock, -180 + k * 10);

function seeded(world: object) {
  ctx(world).seededAt = new Date();
}

Given("a database at today's schema holding an open run whose {word} attempt {int} is started and never reported", long, async function (stage: string, n: number) {
  const p = await aRun(this, false);
  await startedAttempt(p, ctx(this).runId!, stage, n, nth(this, 0));
  seeded(this);
});

Given("that run's {word} attempt {int} started after it and passed", long, async function (stage: string, n: number) {
  const p = db(this);
  const at = minutesFrom(nth(this, 1), 5);
  await p.query("insert into stage_run (run_id, stage_id, attempt, status, started_at, ended_at) values ($1, $2, $3, 'passed', $4, $5)",
    [ctx(this).runId, stage, n, nth(this, 1), at]);
  ctx(this).ended.set(`${stage}:${n}`, at);
  seeded(this);
});

Given("that run's {word} attempt {int} started after it and is still started", long, async function (stage: string, n: number) {
  await startedAttempt(db(this), ctx(this).runId!, stage, n, nth(this, 1));
  seeded(this);
});

Given("a database at today's schema holding a run that ended, whose last attempt, {word} attempt {int}, is started and never reported", long, async function (stage: string, n: number) {
  const p = await aRun(this, true);
  await p.query("insert into stage_run (run_id, stage_id, attempt, status, started_at, ended_at) values ($1, 'understand', 1, 'passed', $2, $3)",
    [ctx(this).runId, nth(this, 0), minutesFrom(nth(this, 0), 5)]);
  await startedAttempt(p, ctx(this).runId!, stage, n, nth(this, 1));
  seeded(this);
});

Given("a database at today's schema holding an open run whose newest attempt, {word} attempt {int}, is started", long, async function (stage: string, n: number) {
  const p = await aRun(this, false);
  await startedAttempt(p, ctx(this).runId!, stage, n, nth(this, 2));
  seeded(this);
});

Given("that run's {word} attempt {int}, before it, is started and never reported", long, async function (stage: string, n: number) {
  await startedAttempt(db(this), ctx(this).runId!, stage, n, nth(this, 1));
  seeded(this);
});

Given("a database at today's schema holding a run that ended, whose {word} attempt {int} passed with the message {string} and whose {word} attempt {int} failed with the message {string}", long,
  async function (passedStage: string, passedN: number, passedMessage: string, failedStage: string, failedN: number, failedMessage: string) {
    const p = await aRun(this, true);
    const runId = ctx(this).runId!;
    await endedAttempt(this, p, runId, passedStage, passedN, "passed", minutesFrom(nth(this, 0), 5), passedMessage);
    await endedAttempt(this, p, runId, failedStage, failedN, "failed", minutesFrom(nth(this, 1), 5), failedMessage);
    seeded(this);
  });

Given("that run's {word} attempt {int} is started and never reported", long, async function (stage: string, n: number) {
  await startedAttempt(db(this), ctx(this).runId!, stage, n, nth(this, 2));
  seeded(this);
});

Then("{word}'s attempt {int} is recorded as stopped, with an end time of when the migration ran", long, async function (stage: string, n: number) {
  const a = await attempt(this, stage, n);
  const what = `${stage}'s attempt ${n}`;
  stopped(a, what);
  endedByMigration(this, a, what);
});

Then("{word}'s attempt {int} is recorded as stopped, with a message saying the cell's lease ran out", long, async function (stage: string, n: number) {
  const a = await attempt(this, stage, n);
  const what = `${stage}'s attempt ${n}`;
  stopped(a, what);
  leaseMessage(a, what);
});

Then("{word}'s attempt {int} is still recorded as passed", long, async function (stage: string, n: number) {
  const a = await attempt(this, stage, n);
  assert.equal(a.status, "passed");
  const at = ctx(this).ended.get(`${stage}:${n}`);
  if (at) endedAt(a, at, `${stage}'s attempt ${n}`);
});

Then("{word}'s attempt {int} is still recorded as started, with no end time", long, async function (stage: string, n: number) {
  const a = await attempt(this, stage, n);
  assert.equal(a.status, "started");
  assert.equal(a.ended_at, null);
});

Then("{word}'s attempt {int} is still recorded as {word}, with its end time and the message {string}", long, async function (stage: string, n: number, status: string, message: string) {
  const a = await attempt(this, stage, n);
  assert.equal(a.status, status);
  const at = ctx(this).ended.get(`${stage}:${n}`);
  assert.ok(at, `no ${stage} attempt ${n} was ended`);
  endedAt(a, at, `${stage}'s attempt ${n}`);
  assert.equal(a.message, message);
});

