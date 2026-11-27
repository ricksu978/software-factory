// Step definitions for features/pbi-319-effort-setting.feature. PBI 319 builds on PBI 175's Configuration page and PBI
// 176's reasons and setting events, so its scenarios share their hooks and steps (pbi-175.steps.ts runs its hooks for
// @pbi-319 too), and on PBI 17's scheduler steps for the one scenario that ticks it.
//
// The contract these steps read:
// - The effort is the one wip_policy row's `effort` column, which db/migrations/021_effort.sql adds, "medium" until an
//   operator changes it. "The effort is set to" writes it with plain SQL. On the Configuration page it's the runtime
//   setting named "effort", and a change carries the key `effort` (PBI 175's change form). A value other than low,
//   medium, high, xhigh or max, an empty one included, answers 4xx with "Effort must be one of low, medium, high, xhigh
//   or max." A taken change logs PBI 176's `setting` event, its payload's `setting` "effort" and `from` and `to` the
//   values as written.
// - Every agent call is an AgentArgs (src/agent/run.ts) that names its `model` and its `effort`. runAgent(args, send)
//   sends it through `send`, the SDK's query by default: a call missing either one, or naming it blank, fails, by
//   throwing or with a result that isn't ok, whose error names what's missing, and `send` is never called.
// - A cell reads the effort once, as it starts: the cell API's GET /internal/cells/:runId/context carries `effort`,
//   the setting as it is when the cell asks, and src/cell/main.ts asks once. The engine passes ctx.effort on every
//   agent call it makes, for every stage, the merge pass, the Definition of Done check and the risk classifier
//   included. With no effort in its context, a stage's call never reaches the model and its attempt fails, with a
//   message, or the cell's error, that names the effort.
//   The cell here is PBI 18's engine over a real git repo, with PBI 18's scripted agent, given the effort from the
//   context the real cell API served for a real run in the database. A cell started for a queued item is the one that
//   claims it after sign-off, so it runs red through the PR review in one claim (PBI 128's scripted reviewer); specify
//   runs in a claim of its own from understand, and address in one that resumes at address with a trusted comment,
//   since sign-off and review end a claim. A call is the Definition of Done check's ("dod") when its prompt asks for
//   the `"person"` status, and otherwise belongs to the stage last reported started.
// - haikuJudge(sop, run, effort) and SplitDeps.effort take a reader of the effort setting, which each judge or split
//   call calls when it runs. Here it's src/store/effort.ts's currentEffort over the test database. The gate runs on
//   PBI 13's terms over a fake board, with a scripted model that answers the judge's lines and a valid split.
// - A stage attempt's row in stage_run, and a readiness or split call's in readiness_check, hold `model` and `effort`.
//   The cell API's POST /stage stores a stage attempt, and turns one down with a 4xx when its model or effort is
//   missing or blank. recordReadinessCheck stores a readiness or split call, and throws for one missing either, or
//   naming it blank. A row from before PBI 319 has a null effort.
// - Run detail (GET /items/:id) shows each model as "<model> (<effort>)" in the Model column of its Stages table and of
//   its Readiness checks table, and a null effort as "(medium)".
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { fakeBacklog, fakeRepoHost } from "../../src/adapters/fake.ts";
import type { FactoryItem } from "../../src/adapters/types.ts";
import { haikuJudge, runAgent, type AgentArgs, type AgentResult, type Send } from "../../src/agent/run.ts";
import { cellApi, runToken } from "../../src/control/cell-api.ts";
import { gate } from "../../src/gate/readiness.ts";
import { startServer } from "../../src/http/server.ts";
import { loadPolicy } from "../../src/policy/policy.ts";
import { currentEffort } from "../../src/store/effort.ts";
import { recordReadinessCheck, type ReadinessCheck } from "../../src/store/readiness-checks.ts";
import { long, need } from "./pbi-8.steps.ts";
import { ctx as schedulerCtx } from "./pbi-17.steps.ts";
import { runTheCell, setUp, type Ctx as CellCtx } from "./pbi-18.steps.ts";
import { ctx as prReview } from "./pbi-128.steps.ts";
import { ctx as configCtx, get, text } from "./pbi-175.steps.ts";
import { loggedOneSettingEvent } from "./pbi-176.steps.ts";

const SECRET = "pbi-319-cell-secret";
const CODING = "claude-opus-5-5";
const TRIAGE = "claude-haiku-4-5";
const SCHEDULER_REPO = "ricksu978/software-factory";
/** The Definition of Done check's prompt asks for this status, and no other call's does. */
const DOD_ASK = 'Use "person" for a line only a person can check';
const DOR = "# Definition of Ready\n\n- [ ] The item says who it's for.\n- [ ] Each criterion can be checked.\n";

type Call = { cell: string; stage: string; attempt: number; model: unknown; effort: unknown; agent?: string; mode: string };
type Cell = {
  name: string; itemId: string | null; runId: string | null; generation: number;
  /** The context the cell API served as the cell started, or the one a scenario hands the cell. */
  context: Record<string, unknown>;
  /** The stage a run of this cell starts at. */
  from: string;
  error?: unknown;
};
type JudgeCall = { item: string; kind: "judge" | "split"; args: AgentArgs };
type Ctx = {
  server?: Server;
  origin?: string;
  /** How many times each run's context was read from the cell API. */
  reads: Map<string, number>;
  sourceId?: string;
  repoId?: string;
  items: Map<string, string>;
  cells: Map<string, Cell>;
  calls: Call[];
  /** Every /stage report each cell sent, in order. */
  reports: (Record<string, unknown> & { cell: string })[];
  /** Why a stage report couldn't be passed on to the cell API. */
  forwardErrors: string[];
  /** The item "an item is queued" queued. */
  queued?: string;
  /** The item a judge scenario's When runs the gate on. */
  target?: { name: string; oversized: boolean };
  board?: ReturnType<typeof fakeBacklog>;
  judgeCalls: JudgeCall[];
  judgeErrors: unknown[];
  /** An agent call made straight through runAgent. */
  direct?: { requests: number; result?: AgentResult; error?: unknown };
  /** A store asked to keep a record missing its model or effort: what it was, and whether each try was turned down. */
  store?: { what: "stage" | "readiness"; id: string; tries: { refused: boolean; detail: string }[] };
  runs: Map<string, string>;
  /** Each Run detail row Given added, oldest first, so they start in order. */
  rows: number;
  roots: string[];
};

function ctx(world: object): Ctx {
  const w = world as { pbi319?: Ctx };
  w.pbi319 ??= {
    reads: new Map(), items: new Map(), cells: new Map(), calls: [], reports: [], forwardErrors: [], judgeCalls: [], judgeErrors: [],
    runs: new Map(), rows: 0, roots: [],
  };
  return w.pbi319;
}

/** True in a PBI 319 scenario. PBI 173's and PBI 222's steps of the same words hand those scenarios to the ones here. */
export const isPbi319 = (world: object): boolean => (world as { pbi319?: Ctx }).pbi319 !== undefined;

const pool = () => need().pool;

// PBI 175's Before empties the database first. The effort goes back to medium, and PBI 17's scheduler gets its fakes.
Before({ tags: "@pbi-319", ...long }, async function () {
  ctx(this);
  await pool().query("update wip_policy set effort = 'medium'");
  const s = schedulerCtx(this);
  s.backlog = fakeBacklog();
  s.repoHost = fakeRepoHost();
  s.repoHost.heads.set(SCHEDULER_REPO, "c0ffee0");
  await pool().query("insert into repo (host_adapter, url) values ('github', $1) on conflict (url) do nothing", [`https://github.com/${SCHEDULER_REPO}`]);
});

After({ tags: "@pbi-319", ...long }, async function () {
  const c = ctx(this);
  for (const root of c.roots) rmSync(root, { recursive: true, force: true });
  if (c.server) {
    c.server.closeAllConnections();
    await new Promise<void>((resolve) => c.server!.close(() => resolve()));
  }
});

/** PBI 222's "a fresh factory database", in a PBI 319 scenario: the Before emptied it, and the effort is its default. */
export async function freshForPbi319(): Promise<void> {
  await pool().query("update wip_policy set effort = default");
}

// ---- the setting ----

Given("the effort is set to {string}", long, async function (effort: string) {
  await pool().query("update wip_policy set effort = $1", [effort]);
});

When("an operator changes the effort to {string}", long, async function (effort: string) {
  await pool().query("update wip_policy set effort = $1", [effort]);
});

Then("the factory logged one setting event", long, async function () {
  await loggedOneSettingEvent(this);
});

// ---- items, runs and the cell API ----

async function source(c: Ctx): Promise<string> {
  c.sourceId ??= (await pool().query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'pbi-319:' || gen_random_uuid()) returning id")).rows[0].id;
  return c.sourceId;
}

async function repo(c: Ctx): Promise<string> {
  c.repoId ??= (await pool().query<{ id: string }>(
    "insert into repo (host_adapter, url) values ('github', 'https://github.com/acme/pbi-319-' || gen_random_uuid()) returning id")).rows[0].id;
  return c.repoId;
}

/** An item in the database, by the name a scenario gives it. "#46 Add search" is item 46, titled "Add search". */
async function dbItem(c: Ctx, name: string, state = "Queued"): Promise<string> {
  const known = c.items.get(name);
  if (known) return known;
  const m = /^#(\d+) (.+)$/.exec(name);
  const id = (await pool().query<{ id: string }>(
    "insert into item (source_id, external_id, title, state) values ($1, $2, $3, $4) returning id",
    [await source(c), m ? m[1] : `pbi-319-${c.items.size + 1}`, m ? m[2] : name, state],
  )).rows[0].id;
  c.items.set(name, id);
  return id;
}

/** An item's id, from this file's items or PBI 17's. */
function itemId(world: object, name: string): string {
  const id = ctx(world).items.get(name) ?? schedulerCtx(world).items[name];
  assert.ok(id, `no item "${name}"`);
  return id;
}

/** The real cell API, on a free port, counting each run's context reads. */
async function api(c: Ctx): Promise<string> {
  if (c.origin) return c.origin;
  const handler = cellApi({
    pool: pool(), secret: SECRET, repoHost: fakeRepoHost() as never, backlogFor: () => fakeBacklog().adapter as never,
    stageAfter: () => null, uploadUrl: async (path) => `http://blob.test/${path}`,
    gateway: { upstream: "http://model.test", ownerToken: () => "unused" }, webToolsOf: () => [],
  });
  c.server = await startServer([(req, res) => {
    const m = /^\/internal\/cells\/([^/]+)\/context$/.exec(req.url ?? "");
    if (req.method === "GET" && m) c.reads.set(m[1], (c.reads.get(m[1]) ?? 0) + 1);
    return handler(req, res);
  }], { port: 0 });
  c.origin = `http://127.0.0.1:${(c.server.address() as AddressInfo).port}`;
  return c.origin;
}

const bearer = (cell: Cell) => ({ authorization: `Bearer ${runToken(SECRET, cell.runId!, cell.generation)}` });

/**
 * Starts a cell for the item, as the scheduler's claim and the cell's start do: the item goes InProgress under the
 * cell's lease, with a run at `from`, and the cell asks the cell API for its context, once.
 */
async function startCell(world: object, name: string, item: string, from: string): Promise<Cell> {
  const c = ctx(world);
  const id = itemId(world, item);
  const generation = (await pool().query<{ g: number }>(
    `update item set state = 'InProgress', lease_generation = lease_generation + 1, lease_owner = $2, lease_expires = now() + interval '1 hour'
     where id = $1 returning lease_generation as g`, [id, name],
  )).rows[0].g;
  const runId = (await pool().query<{ id: string }>(
    `insert into run (item_id, next_stage, execution_name, branch, repo_id, config_sha, sop_version)
     values ($1, $2, $3, 'factory/pbi-482-r1', $4, 'c0ffee0', '0.2.0') returning id`,
    [id, from, name, await repo(c)],
  )).rows[0].id;
  const cell: Cell = { name, itemId: id, runId, generation, context: {}, from };
  const r = await fetch(`${await api(c)}/internal/cells/${runId}/context`, { headers: bearer(cell) });
  const body = await r.text();
  assert.equal(r.status, 200, `the cell API answered ${r.status} for the cell's context: ${body}`);
  cell.context = JSON.parse(body) as Record<string, unknown>;
  c.cells.set(name, cell);
  return cell;
}

function cellNamed(world: object, name: string): Cell {
  const cell = ctx(world).cells.get(name);
  assert.ok(cell, `no cell "${name}" started`);
  return cell;
}

type RunOptions = {
  /** PBI 128's scripted PR reviewer, so the PR review runs. */
  prReview?: boolean;
  /** A trusted reviewer's comment for address to answer. */
  trusted?: boolean;
  /** The first green attempt's scenarios still fail, so green retries. */
  failFirstGreen?: boolean;
  /** The SOP's coding model. */
  model?: string;
  /** Each red stage report also goes to the real cell API, which stores it. */
  store?: boolean;
};

/** Runs PBI 18's engine as `cell`, from the stage it starts at, with the effort its context holds, recording each call. */
async function runCell(world: object, cell: Cell, o: RunOptions = {}): Promise<void> {
  const c = ctx(world);
  const before = (world as { pbi18?: CellCtx }).pbi18;
  if (before) c.roots.push(before.root);
  const run = setUp(world, cell.from, cell.from !== "understand");
  run.dod = "- [ ] Typecheck passes. `run: true`\n- [ ] The PR body says what changed.\n";
  if (o.trusted) run.trusted.push({ author: "owner", body: "Please name the helper after what it does." });
  if (o.prReview) prReview(world);
  if (o.model) run.editSop = (sop) => { sop.models.coding = o.model; };
  run.context = "effort" in cell.context ? { effort: cell.context.effort } : {};
  let attempt = 0;
  const origin = o.store ? await api(c) : undefined;
  run.apiExtra = {
    async stage(b: Record<string, unknown>) {
      run.calls.push({ route: "/stage", body: b, at: Date.now() });
      if (b.status === "started") {
        run.stage = String(b.stageId);
        attempt = Number(b.attempt);
      }
      c.reports.push({ ...b, cell: cell.name });
      if (origin && b.stageId === "red") {
        const r = await fetch(`${origin}/internal/cells/${cell.runId}/stage`, {
          method: "POST", headers: { ...bearer(cell), "content-type": "application/json" }, body: JSON.stringify(b),
        });
        if (!r.ok) c.forwardErrors.push(`${r.status} ${await r.text()}`);
      }
    },
  };
  run.agent = async (a: AgentArgs, base: (a: AgentArgs) => Promise<AgentResult>) => {
    const dod = a.prompt.includes(DOD_ASK);
    c.calls.push({ cell: cell.name, stage: dod ? "dod" : run.stage, attempt, model: a.model, effort: a.effort, agent: a.agent, mode: a.mode });
    const r = await base(a);
    // Green's own call left every scenario passing; on its first attempt they're put back to failing.
    if (o.failFirstGreen && run.stage === "green" && attempt === 1 && !dod && a.mode === "cell") {
      copyFileSync(join(run.fixtures, "parse.ndjson"), join(run.fixtures, "run.ndjson"));
    }
    return r;
  };
  await runTheCell(world);
  cell.error = run.error;
}

function callsOf(world: object, stage: string | null, cell?: string, attempt?: number): Call[] {
  const c = ctx(world);
  const got = c.calls.filter((x) => (stage === null || x.stage === stage) && (cell === undefined || x.cell === cell) && (attempt === undefined || x.attempt === attempt));
  const errors = [...c.cells.values()].filter((x) => x.error).map((x) => `${x.name}: ${String(x.error)}`);
  assert.ok(got.length > 0,
    `no agent call was made${stage ? ` at ${stage}` : ""}${cell ? ` by ${cell}` : ""}${attempt ? ` in attempt ${attempt}` : ""}; the calls: ${JSON.stringify(c.calls.map((x) => `${x.cell} ${x.stage}-${x.attempt}`))}${errors.length ? `; ${errors.join("; ")}` : ""}`);
  return got;
}

function allName(calls: Call[], key: "model" | "effort", want: string): void {
  const wrong = calls.filter((x) => x[key] !== want);
  assert.deepEqual(wrong.map((x) => `${x.cell} ${x.stage}-${x.attempt}: ${String(x[key])}`), [], `these calls don't name the ${key} "${want}"`);
}

// ---- a cell's calls (AC-2, AC-3, AC-4) ----

Given("an item is queued with a cell that runs every stage", long, async function () {
  const c = ctx(this);
  c.queued = "the item";
  await dbItem(c, c.queued);
});

Given("an item is queued", long, async function () {
  const c = ctx(this);
  c.queued = "the item";
  await dbItem(c, c.queued);
});

/** PBI 173's "the cell runs the {word} stage", in a PBI 319 scenario: a cell starts for the queued item and runs it. */
export async function runsTheStage(world: object, stage: string): Promise<void> {
  const c = ctx(world);
  const handed = c.cells.get("cell");
  if (handed && handed.runId === null) {
    // The cell a scenario started with a context of its own, at the stage it starts at.
    handed.from = stage;
    return runCell(world, handed);
  }
  assert.ok(c.queued, "no item is queued");
  const from = stage === "specify" ? "understand" : stage === "address" ? "address" : "red";
  const cell = await startCell(world, "cell", c.queued, from);
  await runCell(world, cell, { prReview: from === "red", trusted: stage === "address" });
}

Then(/^the (\S+) stage's agent call names the model "([^"]*)"$/, function (stage: string, model: string) {
  allName(callsOf(this, stage), "model", model);
});

Then(/^the (\S+) stage's agent call names the effort "([^"]*)"$/, function (stage: string, effort: string) {
  allName(callsOf(this, stage), "effort", effort);
});

Given("a cell that started with no effort to pass on", function () {
  ctx(this).cells.set("cell", { name: "cell", itemId: null, runId: null, generation: 0, context: {}, from: "red" });
});

Then("the red attempt fails with an error that names the missing effort", function () {
  const c = ctx(this);
  const cell = cellNamed(this, "cell");
  const red = c.reports.filter((r) => r.cell === "cell" && r.stageId === "red");
  const failed = red.find((r) => r.status === "failed");
  assert.ok(failed, `the red attempt didn't fail: ${JSON.stringify(red.map((r) => r.status))}${cell.error ? `; the cell's error: ${String(cell.error)}` : ""}`);
  const said = `${String(failed.message ?? "")}\n${cell.error ? String(cell.error) : ""}`;
  assert.match(said, /\beffort\b/i, `the red attempt's failure doesn't name the effort: ${said}`);
});

When("a cell starts for that item and runs every stage to the end", long, async function () {
  const c = ctx(this);
  assert.ok(c.queued, "no item is queued");
  await runCell(this, await startCell(this, "cell", c.queued, "red"), { prReview: true });
});

Then("every agent call the cell made named the effort {string}", function (effort: string) {
  allName(callsOf(this, null, "cell"), "effort", effort);
});

Then("the cell read the effort once, when it started", long, async function () {
  const c = ctx(this);
  const cell = cellNamed(this, "cell");
  assert.equal(c.reads.get(cell.runId!) ?? 0, 1, "the cell didn't read its context exactly once");
  const set = (await pool().query<{ effort: string }>("select effort from wip_policy limit 1")).rows[0].effort;
  assert.equal(cell.context.effort, set, `the context the cell started with carries the effort ${JSON.stringify(cell.context.effort)}, not the setting's "${set}"`);
});

Given("a cell has started for an item", long, async function () {
  const c = ctx(this);
  c.queued = "the item";
  await dbItem(c, c.queued);
  await startCell(this, "cell", c.queued, "green");
});

// The cell has started, and its first green attempt leaves the scenarios failing; the engine runs it in the When.
Given("its green attempt {int} failed", function (n: number) {
  assert.equal(n, 1, "only a first attempt can fail here");
  ctx(this).cells.get("cell")!.context.failFirstGreen = true;
});

When("the cell runs green attempt {int}", long, async function (_n: number) {
  const cell = cellNamed(this, "cell");
  const failFirstGreen = cell.context.failFirstGreen === true;
  delete cell.context.failFirstGreen;
  await runCell(this, cell, { failFirstGreen });
});

Then("green attempt {int}'s agent call names the effort {string}", function (n: number, effort: string) {
  allName(callsOf(this, "green", "cell", n), "effort", effort);
});

const NEXT: Record<string, string> = { specify: "red", red: "green", green: "self-review" };

Given(/^item "([^"]*)" is running in cell "([^"]*)", which started at effort "([^"]*)" and has finished its (\S+) stage$/, long,
  async function (item: string, cell: string, effort: string, finished: string) {
    const c = ctx(this);
    assert.ok(NEXT[finished], `no stage follows ${finished} here`);
    await pool().query("update wip_policy set effort = $1", [effort]);
    await dbItem(c, item);
    await startCell(this, cell, item, NEXT[finished]);
  });

When(/^cell "([^"]*)" runs (?:its \S+ stage|every remaining stage to the end)$/, long, async function (name: string) {
  await runCell(this, cellNamed(this, name));
});

When("a cell {string} starts for item {string} and runs its specify stage", long, async function (name: string, item: string) {
  await runCell(this, await startCell(this, name, item, "understand"));
});

Then(/^cell "([^"]*)"'s (\S+) call names the effort "([^"]*)"$/, function (cell: string, stage: string, effort: string) {
  allName(callsOf(this, stage, cell), "effort", effort);
});

// Every call cell-a made came in the When that ran it, after the change.
Then("every agent call cell {string} made after the change named the effort {string}", function (cell: string, effort: string) {
  allName(callsOf(this, null, cell), "effort", effort);
});

Then("item {string} is still {string} in cell {string}", long, async function (name: string, state: string, cell: string) {
  const row = (await pool().query<{ state: string; lease_owner: string | null }>("select state, lease_owner from item where id = $1", [itemId(this, name)])).rows[0];
  // The scenario shows a change leaves the cell alone only when there was one.
  const changes = (await pool().query("select 1 from event where kind = 'setting' and lower(payload->>'setting') = 'effort'")).rowCount;
  assert.ok(changes, "no change to the effort was taken, so nothing was asked of the running cell");
  assert.deepEqual({ state: row.state, cell: row.lease_owner }, { state, cell });
});

// ---- an agent call straight to the model (AC-2) ----

function answered(): AsyncIterable<SDKMessage> {
  return (async function* () {
    yield {
      type: "result", subtype: "success", is_error: false, result: "done", errors: [], total_cost_usd: 0, modelUsage: {},
      duration_ms: 1, duration_api_ms: 1, num_turns: 1, stop_reason: null, permission_denials: [],
      uuid: "00000000-0000-0000-0000-000000000000", session_id: "s1",
    } as unknown as SDKMessage;
  })();
}

When(/^an agent call is made with no (model|effort)$/, long, async function (missing: "model" | "effort") {
  const c = ctx(this);
  const d: NonNullable<Ctx["direct"]> = { requests: 0 };
  c.direct = d;
  const send: Send = () => {
    d.requests++;
    return answered();
  };
  const args: Record<string, unknown> = { prompt: "Say done.", model: CODING, effort: "medium", cwd: tmpdir(), mode: "judge", maxTurns: 1, signal: new AbortController().signal };
  delete args[missing];
  try {
    d.result = await runAgent(args as AgentArgs, send);
  } catch (e) {
    d.error = e;
  }
});

Then(/^the call fails with an error that names the missing (model|effort)$/, function (missing: string) {
  const d = ctx(this).direct;
  assert.ok(d, "no agent call was made");
  const said = d.error !== undefined ? String(d.error instanceof Error ? d.error.message : d.error) : d.result && !d.result.ok ? d.result.text : null;
  assert.ok(said !== null, `the call didn't fail: ${JSON.stringify(d.result?.text)}`);
  assert.match(said, new RegExp(`\\b${missing}\\b`, "i"), `the call's error doesn't name the ${missing}: ${said}`);
});

Then("no request goes to the model", function () {
  const c = ctx(this);
  if (c.direct) return assert.equal(c.direct.requests, 0, "the call went to the model");
  const sent = c.calls.filter((x) => x.cell === "cell");
  assert.deepEqual(sent.map((x) => `${x.stage}-${x.attempt}`), [], "the cell's calls reached the model");
});

// ---- the readiness judge and the split (AC-2, AC-3, AC-5) ----

/** The scripted model: the judge's lines all pass, with `oversized` on the last line, and a split is two children. */
function model(c: Ctx, item: string, oversized: boolean) {
  return async (a: AgentArgs): Promise<AgentResult> => {
    const judge = a.prompt.startsWith("You check one backlog item against a team's Definition of Ready");
    c.judgeCalls.push({ item, kind: judge ? "judge" : "split", args: a });
    const text = judge
      ? [...[...a.prompt.matchAll(/^\{"index":(\d+),"criterion":".*"\}$/gm)].map((m) => JSON.stringify({ index: Number(m[1]), status: "passed", reason: "ok" })),
        JSON.stringify({ flags: [], oversized, rules: [] })].join("\n")
      : JSON.stringify({ children: [
        { title: `${item}: card payments`, body: `Part of "${item}".`, criteria: [1], needs: [] },
        { title: `${item}: refunds`, body: `Part of "${item}".`, criteria: [2], needs: [1] },
      ] });
    return { ok: true, text, costUsd: 0.01, tokensIn: 100, tokensOut: 20, model: a.model, limit: null, usage: null, transcript: "" };
  };
}

/** Runs the readiness gate on the item, as the poller does, recording each judge or split call in the database. */
async function judgeItem(world: object, name: string, oversized = false): Promise<void> {
  const c = ctx(world);
  const id = await dbItem(c, name, "Eligible");
  c.board ??= fakeBacklog();
  const ext = await c.board.seed({ externalId: `judged-${c.items.size}`, title: name, body: `What "${name}" is for.`, acceptanceCriteria: ["Card payments work.", "Refunds work."], repo: "acme/app" });
  const item = (await c.board.adapter.getItem(ext)) as FactoryItem;
  const dor = await loadPolicy(async (p) => (p === ".factory/dor.md" ? DOR : null), "dor");
  const run = model(c, name, oversized);
  const effort = () => currentEffort(pool());
  // PBI 132's "that readiness check records the model" reads the checks it keeps.
  const p132 = (world as { pbi132?: { checks: unknown[]; items: Map<string, unknown> } });
  p132.pbi132 ??= { checks: [], items: new Map() };
  try {
    await gate(item, {
      readinessSha: "pbi-319", dor, dodExists: true, configValid: true, repoKnown: true,
      judge: haikuJudge({ models: { triage: TRIAGE } }, run, effort),
      adapter: c.board.adapter,
      recordCheck: async (fi: FactoryItem, check: ReadinessCheck) => {
        p132.pbi132!.checks.push({ title: fi.title, ...check });
        await recordReadinessCheck(pool(), id, check);
      },
      split: { sop: { models: { coding: CODING } }, agent: run, effort },
    });
  } catch (e) {
    c.judgeErrors.push(e);
  }
}

function judgeCalls(world: object, kind: "judge" | "split", item?: string): JudgeCall[] {
  const c = ctx(world);
  const got = c.judgeCalls.filter((x) => x.kind === kind && (item === undefined || x.item === item));
  assert.ok(got.length > 0, `no ${kind} call was made${item ? ` on item "${item}"` : ""}${c.judgeErrors.length ? `; the gate failed: ${c.judgeErrors.map(String).join("; ")}` : ""}`);
  return got;
}

function allNameJudged(calls: JudgeCall[], key: "model" | "effort", want: string): void {
  const wrong = calls.filter((x) => x.args[key] !== want);
  assert.deepEqual(wrong.map((x) => `${x.kind} on "${x.item}": ${String(x.args[key])}`), [], `these calls don't name the ${key} "${want}"`);
}

Given("a new item on the board that the readiness judge checks", function () {
  ctx(this).target = { name: "a new item", oversized: false };
});

Given("an item that the readiness judge finds oversized", function () {
  ctx(this).target = { name: "an oversized item", oversized: true };
});

When(/^(?:the readiness judge runs on|the coding model is asked for a split of) that item$/, long, async function () {
  const t = ctx(this).target;
  assert.ok(t, "no item was set up");
  await judgeItem(this, t.name, t.oversized);
});

When("the coding model is asked for a split of an oversized item", long, async function () {
  await judgeItem(this, "an oversized item", true);
});

When("the readiness judge runs on a new item", long, async function () {
  await judgeItem(this, "a new item");
});

Given("the readiness judge has checked item {string} at effort {string}", long, async function (name: string, effort: string) {
  await pool().query("update wip_policy set effort = $1", [effort]);
  await judgeItem(this, name);
});

When("the readiness judge runs on item {string}", long, async function (name: string) {
  await judgeItem(this, name);
});

Then("the judge call names the model {string}", function (want: string) {
  allNameJudged(judgeCalls(this, "judge"), "model", want);
});

Then("the judge call names the effort {string}", function (want: string) {
  allNameJudged(judgeCalls(this, "judge"), "effort", want);
});

Then("the judge call on item {string} names the effort {string}", function (item: string, want: string) {
  allNameJudged(judgeCalls(this, "judge", item), "effort", want);
});

Then("the split call names the effort {string}", function (want: string) {
  allNameJudged(judgeCalls(this, "split"), "effort", want);
});

Then("the split call names its model", function () {
  const blank = judgeCalls(this, "split").filter((x) => typeof x.args.model !== "string" || x.args.model.trim() === "");
  assert.deepEqual(blank.map((x) => String(x.args.model)), [], "a split call names no model");
});

/** The readiness_check rows of `kind`, or of every kind. */
async function stored(kind?: "judge" | "split"): Promise<{ kind: string; model: string | null; effort: string | null }[]> {
  return (await pool().query<{ kind: string; model: string | null; effort: string | null }>(
    "select kind, model, effort from readiness_check where $1::text is null or kind = $1 order by ran_at, id", [kind ?? null],
  )).rows;
}

Then("that readiness check records the effort {string}", long, async function (want: string) {
  const rows = await stored();
  assert.equal(rows.length, 1, `${rows.length} readiness checks are stored: ${JSON.stringify(rows)}`);
  assert.equal(rows[0].effort, want, "the readiness check's effort");
});

Then("that split call's record holds its model", long, async function () {
  const rows = await stored("split");
  assert.equal(rows.length, 1, `${rows.length} split calls are stored: ${JSON.stringify(rows)}`);
  assert.ok(rows[0].model?.trim(), "the split call's record holds no model");
});

Then("that split call's record holds the effort {string}", long, async function (want: string) {
  const rows = await stored("split");
  assert.equal(rows.length, 1, `${rows.length} split calls are stored: ${JSON.stringify(rows)}`);
  assert.equal(rows[0].effort, want, "the split call's effort");
});

// ---- stage attempt records (AC-5) ----

When("a cell runs red attempt {int} on model {string}", long, async function (_n: number, m: string) {
  const c = ctx(this);
  c.queued = "the item";
  await dbItem(c, c.queued);
  await runCell(this, await startCell(this, "cell", c.queued, "red"), { model: m, store: true });
});

async function attemptRow(world: object, stage: string, attempt: number): Promise<{ model: string | null; effort: string | null }> {
  const cell = cellNamed(world, "cell");
  const row = (await pool().query<{ model: string | null; effort: string | null }>(
    "select model, effort from stage_run where run_id = $1 and stage_id = $2 and attempt = $3", [cell.runId, stage, attempt],
  )).rows[0];
  const c = ctx(world);
  assert.ok(row, `no ${stage} attempt ${attempt} is stored${c.forwardErrors.length ? `; the cell API answered ${c.forwardErrors.join("; ")}` : ""}${cell.error ? `; the cell failed: ${String(cell.error)}` : ""}`);
  return row;
}

Then(/^(\S+) attempt (\d+)'s record holds the model "([^"]*)"$/, long, async function (stage: string, n: string, want: string) {
  assert.equal((await attemptRow(this, stage, Number(n))).model, want);
});

Then(/^(\S+) attempt (\d+)'s record holds the effort "([^"]*)"$/, long, async function (stage: string, n: string, want: string) {
  assert.equal((await attemptRow(this, stage, Number(n))).effort, want);
});

// A record missing its model or effort is tried twice: with the field left out, and with it blank.
const WITHOUT = (missing: string, full: Record<string, unknown>): Record<string, unknown>[] => {
  const left = { ...full };
  delete left[missing];
  return [left, { ...full, [missing]: "" }];
};

When(/^a stage attempt is stored with no (model|effort)$/, long, async function (missing: string) {
  const c = ctx(this);
  c.queued = "the item";
  await dbItem(c, c.queued);
  const cell = await startCell(this, "cell", c.queued, "red");
  const tries: { refused: boolean; detail: string }[] = [];
  for (const body of WITHOUT(missing, { stageId: "red", attempt: 1, status: "started", model: CODING, effort: "medium", tokensIn: 0, tokensOut: 0, costUsd: 0 })) {
    const r = await fetch(`${await api(c)}/internal/cells/${cell.runId}/stage`, {
      method: "POST", headers: { ...bearer(cell), "content-type": "application/json" }, body: JSON.stringify(body),
    });
    tries.push({ refused: r.status >= 400 && r.status < 500, detail: `${JSON.stringify(body)} answered ${r.status}: ${await r.text()}` });
  }
  c.store = { what: "stage", id: cell.runId!, tries };
});

When(/^a (readiness|split) call is stored with no (model|effort)$/, long, async function (call: string, missing: string) {
  const c = ctx(this);
  const id = await dbItem(c, "the item", "Eligible");
  const tries: { refused: boolean; detail: string }[] = [];
  const full = { kind: call === "split" ? "split" : "judge", model: call === "split" ? CODING : TRIAGE, effort: "medium", tokensIn: 100, tokensOut: 20, costUsd: 0.01, ranAt: new Date() };
  for (const check of WITHOUT(missing, full)) {
    try {
      await recordReadinessCheck(pool(), id, check as unknown as ReadinessCheck);
      tries.push({ refused: false, detail: `${JSON.stringify(check)} was stored` });
    } catch (e) {
      tries.push({ refused: true, detail: `${JSON.stringify(check)} was turned down: ${String(e)}` });
    }
  }
  c.store = { what: "readiness", id, tries };
});

Then("the store turns it down", function () {
  const s = ctx(this).store;
  assert.ok(s, "nothing was stored");
  const taken = s.tries.filter((t) => !t.refused);
  assert.deepEqual(taken.map((t) => t.detail), [], "the store took a record missing what it needs");
});

Then("no stage attempt is stored", long, async function () {
  const s = ctx(this).store;
  assert.ok(s?.what === "stage", "no stage attempt was stored");
  const n = (await pool().query("select 1 from stage_run where run_id = $1", [s.id])).rowCount;
  assert.equal(n, 0, `${n} stage attempts are stored`);
});

Then("no readiness check is stored", long, async function () {
  const s = ctx(this).store;
  assert.ok(s?.what === "readiness", "no readiness or split call was stored");
  const n = (await pool().query("select 1 from readiness_check where item_id = $1", [s.id])).rowCount;
  assert.equal(n, 0, `${n} readiness checks are stored`);
});

// ---- Run detail (AC-6) ----

async function runOf(c: Ctx, name: string): Promise<string> {
  const known = c.runs.get(name);
  if (known) return known;
  const id = await dbItem(c, name, "InProgress");
  const run = (await pool().query<{ id: string }>(
    "insert into run (item_id, run_number, next_stage, branch) values ($1, 1, 'self-review', 'factory/pbi-46-r1') returning id", [id],
  )).rows[0].id;
  c.runs.set(name, run);
  return run;
}

Given(/^(?:item "([^"]*)"|it) has a finished "([^"]*)" attempt (\d+) on model "([^"]*)" (?:at effort "([^"]*)"|with no effort stored)$/, long,
  async function (item: string | null, stage: string, n: string, m: string, effort: string | null) {
    const c = ctx(this);
    const name = item ?? [...c.runs.keys()].at(-1);
    assert.ok(name, "no item named before");
    const run = await runOf(c, name);
    const offset = 60 - ++c.rows * 10;
    await pool().query(
      `insert into stage_run (run_id, stage_id, attempt, status, model, effort, started_at, ended_at, tokens_in, tokens_out, cost_usd)
       values ($1, $2, $3, 'passed', $4, $5, now() - make_interval(mins => $6), now() - make_interval(mins => $6 - 5), 5000, 900, 0.5)`,
      [run, stage, Number(n), m, effort ?? null, offset],
    );
  });

Given(/^item "([^"]*)" has a (readiness|split) call on model "([^"]*)" (?:at effort "([^"]*)"|with no effort stored)$/, long,
  async function (item: string, call: string, m: string, effort: string | null) {
    const c = ctx(this);
    await runOf(c, item);
    await pool().query(
      `insert into readiness_check (item_id, kind, model, effort, tokens_in, tokens_out, cost_usd, ran_at)
       values ($1, $2, $3, $4, 1000, 50, 0.01, now() - interval '2 hours')`,
      [c.items.get(item), call === "split" ? "split" : "judge", m, effort ?? null],
    );
  });

When("{string} opens Run detail for {string}", long, async function (login: string, item: string) {
  await get(this, `/items/${itemId(this, item)}`, login);
});

/** The table under Run detail's <h2> `title`: its header cells and each body row's cells, as text. */
function table(world: object, title: string): { head: string[]; rows: string[][] } {
  const c = configCtx(world);
  assert.equal(c.status, 200, `Run detail answered ${c.status}: ${(c.page ?? "").slice(0, 300)}`);
  const html = c.page ?? "";
  const start = html.search(new RegExp(`<h2\\b[^>]*>\\s*${title}\\s*</h2>`, "i"));
  assert.ok(start >= 0, `Run detail has no "${title}" section`);
  const rest = html.slice(start).replace(/^<h2\b[^>]*>[\s\S]*?<\/h2>/i, "");
  const end = rest.search(/<h2\b/i);
  const body = end < 0 ? rest : rest.slice(0, end);
  const head = [...body.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => text(m[1]));
  const rows = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((m) => [...m[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => text(x[1])))
    .filter((cells) => cells.length > 0);
  return { head, rows };
}

function modelCell(t: { head: string[]; rows: string[][] }, row: string[]): string {
  const i = t.head.findIndex((h) => h.toLowerCase() === "model");
  assert.ok(i >= 0, `the table has no Model column: ${t.head.join(", ")}`);
  return row[i];
}

Then("the stage attempts row for {string} attempt {int} shows the model {string}", function (stage: string, n: number, want: string) {
  const t = table(this, "Stages");
  const row = t.rows.find((r) => r[0] === stage && r[1] === String(n));
  assert.ok(row, `the stage attempts table has no ${stage} attempt ${n}: ${JSON.stringify(t.rows)}`);
  assert.equal(modelCell(t, row), want);
});

Then("that call's row in the readiness checks table shows the model {string}", function (want: string) {
  const t = table(this, "Readiness checks");
  assert.equal(t.rows.length, 1, `the readiness checks table has ${t.rows.length} rows: ${JSON.stringify(t.rows)}`);
  assert.equal(modelCell(t, t.rows[0]), want);
});
