// Step definitions for features/pbi-301-restart-ends-cells-at-stage-boundary.feature. They build on PBI 140's restart
// steps and hooks, which also run for @pbi-301: its clock, its cell API, the restart it prepares and the items PBI 17's
// steps put in cells. The @db scenarios renew and report through the real cell API. A cell that runs a stage there is
// the real cell engine, PBI 18's scripted agent and repo, whose lease, stage and release calls go to the real cell API
// as the run's cell, so what the control plane answers is what the engine acts on.
// The other scenarios run the engine against a fake control plane, whose renewals answer through the cell API's own
// `leaseAnswer`, with the engine's 60-second renewal timer mocked, so a renewal can arrive while the agent is mid-stage.
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { mock } from "node:test";
import { LeaseLost } from "../../src/cell/api-client.ts";
import { leaseAnswer } from "../../src/control/cell-api.ts";
import { LEASE_EXPIRY_MS } from "../../src/store/items.ts";
import { setOverride } from "../../src/store/overrides.ts";
import { attemptStatus, call, cellRun, ctx as p140, newCellContext } from "./pbi-140.steps.ts";
import { ctx as p17 } from "./pbi-17.steps.ts";
import { runTheCell, setUp, type Ctx as Pbi18 } from "./pbi-18.steps.ts";
import { long, need } from "./pbi-8.steps.ts";

const RENEW_MS = 60_000;

/** What happens while the agent works at the run's stage, in order: renewals, and a restart prepared or cleared. */
type Event = { renewals: number } | { restarting: boolean };

type Ctx = {
  /** The stage the run is at when its cell starts. */
  stage?: string;
  /** A restart is being prepared, as the fake control plane's renewals see it. */
  restarting: boolean;
  events: Event[];
  played: boolean;
  /** Each agent call, by the stage it ran at, and whether a stop had cut it short by the time it would return. */
  agentCalls: { stage: string; cut: boolean }[];
  ran: boolean;
  /** PBI 18's repos made in this scenario, which its After hook removes only the last of. */
  roots: string[];
};

function ctx(world: object): Ctx {
  const w = world as { pbi301?: Ctx };
  w.pbi301 ??= { restarting: false, events: [], played: false, agentCalls: [], ran: false, roots: [] };
  return w.pbi301;
}

const pbi18 = (world: object): Pbi18 => {
  const c = (world as { pbi18?: Pbi18 }).pbi18;
  assert.ok(c, "no cell was set up");
  return c;
};

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
};

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();

Before({ tags: "@pbi-301 and not @db" }, function () {
  // PBI 140's "a run for item 482 that is at green's first attempt" and "the factory is preparing to restart", and PBI
  // 173's "green passes", reach this file's cell through these.
  Object.assign(this, {
    atStage: (stage: string) => atStage(this, stage),
    preparingRestart: () => {
      const c = ctx(this);
      assert.equal(c.ran, false, "the cell already ran");
      c.restarting = true;
    },
    stagePasses: (stage: string) => stagePasses(this, stage),
  });
});

After({ tags: "@pbi-301" }, function () {
  mock.timers.reset();
  const c = ctx(this);
  const last = (this as { pbi18?: Pbi18 }).pbi18?.root;
  for (const root of c.roots) if (root !== last) rmSync(root, { recursive: true, force: true });
});

// ---- the cell engine against a fake control plane ----

function atStage(world: object, stage: string): void {
  const c = ctx(world);
  c.stage = stage;
  c.roots.push(setUp(world, stage, true).root);
}

function record(p: Pbi18, route: string, body: Record<string, any> = {}): void {
  p.calls.push({ route, body, at: Date.now() } as never);
}

/** The fake control plane: a renewal answers as the cell API's lease route does for what's set, which here is only a restart. */
function fakeApi(world: object, p: Pbi18) {
  const c = ctx(world);
  return {
    async lease() {
      record(p, "/lease");
      return leaseAnswer({ kill: false, pause: false, restart: c.restarting, stopRun: false });
    },
    async stage(b: Record<string, any>) {
      record(p, "/stage", b);
      if (b.status === "started") p.stage = b.stageId;
    },
    async transition(b: Record<string, any>) { record(p, "/transition", b); },
    async policyResults(b: Record<string, any>) { record(p, "/policy-results", b); },
    async pr(b: Record<string, any>) { record(p, "/pr", b); },
    async checks() { return { status: "success", failedChecks: [] }; },
    async upload(b: Record<string, any>) { record(p, "/upload-url", { kind: b.kind, stageId: b.stageId, attempt: b.attempt }); },
    async release() { record(p, "/release"); },
  };
}

/**
 * Wraps PBI 18's scripted agent: at the run's stage, its first call plays the scenario's events while it works. A call
 * whose signal a stop aborted ends cut short, as the real agent does, with ok:false and none of the stage's work done.
 */
function playingAgent(world: object) {
  const c = ctx(world);
  return async (a: { signal?: AbortSignal }, base: (a: any) => Promise<any>) => {
    const p = pbi18(world);
    const stage = p.stage;
    if (stage === c.stage && !c.played) {
      c.played = true;
      for (const e of c.events) {
        if ("restarting" in e) c.restarting = e.restarting;
        else for (let i = 0; i < e.renewals; i++) {
          mock.timers.tick(RENEW_MS);
          await flush();
        }
      }
    }
    const cut = a.signal?.aborted === true;
    c.agentCalls.push({ stage, cut });
    if (cut) return { ok: false, text: "", costUsd: 0, tokensIn: 0, tokensOut: 0, model: "claude-opus-5-5", limit: null, usage: null, transcript: "" };
    return base(a);
  };
}

/** Runs the cell over the run set up at its stage, with the renewal timer mocked. A failure lands in PBI 18's ctx.error. */
async function runCell(world: object): Promise<void> {
  const c = ctx(world);
  assert.ok(c.stage, "no run was set up");
  assert.equal(c.ran, false, "the cell already ran");
  const p = pbi18(world);
  p.api = fakeApi(world, p);
  p.agent = playingAgent(world) as never;
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    await runTheCell(world);
  } finally {
    mock.timers.reset();
    c.ran = true;
  }
}

async function stagePasses(world: object, stage: string): Promise<void> {
  assert.equal(ctx(world).stage, stage, `the run is at ${ctx(world).stage}, not ${stage}`);
  await runCell(world);
}

function finished(world: object): Pbi18 {
  assert.ok(ctx(world).ran, "the cell never ran");
  const p = pbi18(world);
  assert.equal(p.error, null, `the cell failed: ${String(p.error)}`);
  return p;
}

const stageCalls = (p: Pbi18) => p.calls.filter((x) => x.route === "/stage");

function events(world: object, stage: string): Event[] {
  const c = ctx(world);
  assert.equal(c.stage, stage, `the run is at ${c.stage}, not ${stage}`);
  assert.equal(c.ran, false, "the cell already ran");
  return c.events;
}

Given("a run for item {int} that is at red's first attempt", function (_item: number) {
  atStage(this, "red");
});

Given("a run for item {int} that is at self-review's first attempt", function (_item: number) {
  atStage(this, "self-review");
});

Given("the factory is not preparing to restart", function () {
  const c = ctx(this);
  assert.ok(c.stage, "no run was set up");
  c.restarting = false;
});

When(/^the cell renews its lease while (\S+)'s agent works$/, function (stage: string) {
  events(this, stage).push({ renewals: 1 });
});

When(/^the cell renews its lease (\d+) times while (\S+)'s agent works$/, function (n: string, stage: string) {
  events(this, stage).push({ renewals: Number(n) });
});

When(/^the cell renews its lease twice more while (\S+)'s agent works$/, function (stage: string) {
  events(this, stage).push({ renewals: 2 });
});

When("the factory starts preparing to restart", function () {
  events(this, ctx(this).stage!).push({ restarting: true });
});

When("an operator resumes the factory before green ends", function () {
  events(this, "green").push({ restarting: false });
});

When("green's agent finishes and green's checks pass", long, async function () {
  await stagePasses(this, "green");
});

When("self-review's agent finishes and approves", long, async function () {
  await stagePasses(this, "self-review");
});

When(/^(red|self-review) passes$/, long, async function (stage: string) {
  await stagePasses(this, stage);
});

Then(/^the agent's work at (\S+) was not cut short$/, function (stage: string) {
  finished(this);
  const calls = ctx(this).agentCalls.filter((a) => a.stage === stage);
  assert.ok(calls.length > 0, `${stage}'s agent never ran`);
  assert.deepEqual(calls.filter((a) => a.cut).length, 0, `a stop cut ${stage}'s agent short`);
});

Then(/^the cell reports (\S+)'s first attempt as passed$/, function (stage: string) {
  const p = finished(this);
  const reports = stageCalls(p).filter((x) => x.body.stageId === stage && x.body.attempt === 1).map((x) => x.body.status);
  assert.ok(reports.includes("passed"), `the cell reported ${stage}'s attempt 1 as ${JSON.stringify(reports)}, never passed`);
});

Then("the cell reports no attempt as stopped", function () {
  const stopped = stageCalls(finished(this)).filter((x) => x.body.status === "stopped").map((x) => `${x.body.stageId}:${x.body.attempt}`);
  assert.deepEqual(stopped, [], "the cell reported an attempt as stopped");
});

Then("the cell makes no commit {string}", function (message: string) {
  const p = finished(this);
  const local = git("-C", p.dir, "log", "--all", "--format=%s").split("\n");
  const pushed = git("--git-dir", p.origin, "log", "--all", "--format=%s").split("\n");
  assert.ok(!local.includes(message), `the cell committed "${message}"`);
  assert.ok(!pushed.includes(message), `the cell pushed a commit "${message}"`);
});

Then(/^the cell starts no (\S+) attempt$/, function (stage: string) {
  const started = stageCalls(finished(this)).filter((x) => x.body.stageId === stage && x.body.status === "started");
  assert.deepEqual(started.map((x) => x.body.attempt), [], `the cell started ${stage}`);
});

Then(/^the cell doesn't run (\S+)'s agent$/, function (stage: string) {
  finished(this);
  assert.deepEqual(ctx(this).agentCalls.filter((a) => a.stage === stage).length, 0, `the cell ran ${stage}'s agent`);
});

Then("the cell ends its claim at the stage boundary and exits", function () {
  const p = finished(this);
  const stage = ctx(this).stage!;
  const passed = p.calls.findIndex((x) => x.route === "/stage" && x.body.stageId === stage && x.body.status === "passed");
  assert.ok(passed >= 0, `the cell never reported ${stage} as passed`);
  const after = p.calls.slice(passed + 1);
  assert.ok(after.some((x) => x.route === "/release"), `the cell didn't end its claim after ${stage}: ${after.map((x) => x.route).join(", ")}`);
  const release = after.findIndex((x) => x.route === "/release");
  const beyond = after.slice(release + 1).filter((x) => x.route !== "/lease" && x.route !== "/upload-url");
  assert.deepEqual(beyond.map((x) => x.route), [], "the cell carried on after ending its claim");
  assert.ok(!after.some((x) => x.route === "/transition"), "the cell moved the item itself instead of ending its claim");
});

Then(/^the cell starts (\S+)'s first attempt$/, function (stage: string) {
  const started = stageCalls(finished(this)).filter((x) => x.body.stageId === stage && x.body.status === "started");
  assert.ok(started.some((x) => x.body.attempt === 1), `the cell didn't start ${stage}'s first attempt`);
});

// ---- the control plane, with Postgres ----

Then("both renewals are answered and tell the cell to carry on", function () {
  const rs = p140(this).renewals.slice(-2);
  assert.equal(rs.length, 2, "two cells didn't renew");
  for (const r of rs) {
    assert.equal(r.answer.status, 200, `${r.cell}'s renewal wasn't answered: ${JSON.stringify(r.answer)}`);
    assert.equal(r.answer.body.stop, false, `${r.cell}'s renewal told it to stop`);
  }
});

Then("cell {string}'s lease is pushed out", long, async function (cell: string) {
  const r = await need().pool.query<{ lease_expires: Date | null }>(
    "select i.lease_expires from item i join run r on r.item_id = i.id where r.execution_name = $1", [cell]);
  const expected = p140(this).clock.getTime() + LEASE_EXPIRY_MS;
  assert.equal(r.rows[0]?.lease_expires?.getTime(), expected, `${cell}'s lease runs to ${r.rows[0]?.lease_expires?.toISOString()}, not 5 minutes on`);
});

async function operator(world: object): Promise<string> {
  const id = p17(world).operator;
  assert.ok(id, "no operator");
  return id;
}

When("a pause of the factory is set", long, async function () {
  await setOverride(need().pool, { scope: "factory", targetId: null, kind: "pause", reason: "scenario: pause", createdBy: await operator(this), expiresAt: null });
});

When("the kill switch is set", long, async function () {
  await setOverride(need().pool, { scope: "factory", targetId: null, kind: "kill", reason: "scenario: kill", createdBy: await operator(this), expiresAt: null });
});

When("an operator's stop on item {string}'s run is set", long, async function (name: string) {
  await setOverride(need().pool, { scope: "item", targetId: p17(this).items[name], kind: "stop_run", reason: "scenario: stop", createdBy: await operator(this), expiresAt: null });
});

/**
 * The cell in `cell` runs its stage to the end: the real engine, with PBI 18's scripted agent, whose stage's work passes.
 * Its lease, stage and release calls go to the real cell API as that cell's run, and a 409 is a lost lease, as the cell's
 * own client has it. Anything else it calls is the fake's.
 */
async function runAsCell(world: object, cell: string): Promise<void> {
  const run = await cellRun(cell);
  const stage = (await need().pool.query<{ next_stage: string }>("select next_stage from run where id = $1", [run.runId])).rows[0].next_stage;
  const c = ctx(world);
  atStage(world, stage);
  const p = pbi18(world);
  const fake = fakeApi(world, p);
  const forward = async (route: string, body: Record<string, unknown>) => {
    const a = await call(world, run, "POST", route, body);
    if (a.status === 409) throw new LeaseLost(`${route}: the lease generation moved on`);
    if (a.status !== 200) throw new Error(`the cell API answered ${route} with ${a.status}: ${JSON.stringify(a.body)}`);
    return a.body;
  };
  p.api = {
    ...fake,
    async lease() {
      record(p, "/lease");
      return forward("lease", { generation: run.generation });
    },
    async stage(b: Record<string, any>) {
      record(p, "/stage", b);
      if (b.status === "started") p.stage = b.stageId;
      await forward("stage", b);
    },
    async release() {
      record(p, "/release");
      await forward("release", {});
    },
  };
  p.agent = playingAgent(world) as never;
  try {
    await runTheCell(world);
  } finally {
    c.ran = true;
  }
}

When("cell {string} runs green to the end and green passes", long, async function (cell: string) {
  await runAsCell(this, cell);
});

Given("cell {string} ran green to the end and green passed", long, async function (cell: string) {
  // How the cell ended isn't judged here: the scenario's Thens read what the control plane holds after it.
  await runAsCell(this, cell);
});

async function itemRow(world: object, name: string) {
  const id = p17(world).items[name];
  assert.ok(id, `no item ${name}`);
  const r = await need().pool.query<{ lease_owner: string | null; lease_expires: Date | null; run_id: string; next_stage: string }>(
    `select i.lease_owner, i.lease_expires, r.id as run_id, r.next_stage from item i join run r on r.item_id = i.id
     where i.id = $1 order by r.started_at desc limit 1`, [id]);
  assert.ok(r.rowCount, `item ${name} has no run`);
  return r.rows[0];
}

Then("item {string} holds no lease", long, async function (name: string) {
  const row = await itemRow(this, name);
  assert.equal(row.lease_owner, null, `item ${name} is still leased to ${row.lease_owner}`);
  assert.equal(row.lease_expires, null, `item ${name}'s lease runs to ${row.lease_expires?.toISOString()}`);
});

Then("item {string}'s run's next stage is {word}", long, async function (name: string, stage: string) {
  assert.equal((await itemRow(this, name)).next_stage, stage);
});

Then("item {string}'s green attempt is recorded as passed", long, async function (name: string) {
  assert.equal(await attemptStatus(p17(this).items[name], "green", 1), "passed");
});

Then("green's attempt is still recorded as passed", long, async function () {
  assert.equal(await attemptStatus(p17(this).items.A, "green", 1), "passed");
});

Then("no attempt of item {string}'s run is recorded as stopped", long, async function (name: string) {
  const r = await need().pool.query<{ stage_id: string; attempt: number }>(
    "select s.stage_id, s.attempt from stage_run s where s.run_id = $1 and s.status = 'stopped'", [(await itemRow(this, name)).run_id]);
  assert.deepEqual(r.rows.map((x) => `${x.stage_id}:${x.attempt}`), [], `item ${name}'s run has attempts recorded as stopped`);
});

Then("the run's branch holds no commit {string}", function (message: string) {
  const p = pbi18(this);
  assert.ok(ctx(this).ran, "the cell never ran");
  const subjects = git("--git-dir", p.origin, "log", "--format=%s", "factory/pbi-482-r1").split("\n");
  assert.ok(!subjects.includes(message), `the run's branch holds a commit "${message}"`);
});

Then("self-review's brief doesn't tell the agent to carry on from earlier work", long, async function () {
  // The new cell runs with the context the control plane gives it, so its self-review brief is the one that cell writes.
  const context = await newCellContext(this, "A");
  assert.equal(context.nextStage, "self-review", `the new cell resumes at ${context.nextStage}`);
  const c = ctx(this);
  c.roots.push(setUp(this, "self-review", true).root);
  const p = pbi18(this);
  p.context = { stageAttempts: context.stageAttempts ?? {}, resume: context.resume ?? null };
  await runTheCell(this);
  assert.equal(p.error, null, `the cell failed: ${String(p.error)}`);
  const briefs = p.agentCalls.filter((a) => a.stage === "self-review");
  assert.ok(briefs.length > 0, "self-review never ran");
  for (const b of briefs) {
    assert.doesNotMatch(b.prompt, /Carry on from the earlier work/i, "self-review's brief tells the agent to carry on from earlier work");
    assert.doesNotMatch(b.prompt, /already on the branch/i, "self-review's brief says earlier work is already on the branch");
  }
});
