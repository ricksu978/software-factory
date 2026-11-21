// Step definitions for features/pbi-379-drain-ends-cells-at-stage-boundary.feature. They build on PBI 140's, PBI 300's
// and PBI 301's steps and hooks, which also run for @pbi-379: PBI 140's clock, cell API, renewals and Floor, PBI 300's
// item at green in a cell, PBI 17's scheduler, and PBI 301's cell engine against a fake control plane or, for @db, as
// the run's cell against the real cell API. Only what those have no wording for lives here: a drain, set now or some
// time ago, or set and cleared on the fake control plane, a stage's attempts that fail before one passes, and an item
// at self-review in a cell.
// A drain is the factory override the dashboard's Drain sets. A renewal that tells the cell to end its claim at the next
// stage boundary is the one PBI 301's restart gives: `stop: false` with `restarting: true`, which the engine reads at
// each stage boundary.
import { Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setOverride } from "../../src/store/overrides.ts";
import { ctx as p140, renew } from "./pbi-140.steps.ts";
import { ctx as p17, newItem } from "./pbi-17.steps.ts";
import type { Ctx as Pbi18 } from "./pbi-18.steps.ts";
import { ctx as p301, events, finished, pbi18, ranStage, runAsCell, runCell, stageCalls } from "./pbi-301.steps.ts";
import { ctx as p89, open } from "./pbi-89.steps.ts";
import { long, need } from "./pbi-8.steps.ts";

type Outcome = "fail" | "pass";

type Ctx = {
  /** Each stage's scripted attempts, in order. An attempt with none scripted does the stage's work as PBI 18's agent does. */
  outcomes: Map<string, Outcome[]>;
  /** Retries set for a stage, over the SOP's own. */
  retries: Map<string, number>;
};

export function ctx(world: object): Ctx {
  const w = world as { pbi379?: Ctx };
  w.pbi379 ??= { outcomes: new Map(), retries: new Map() };
  return w.pbi379;
}

const ORDINALS = ["first", "second", "third", "fourth"];
export const ordinal = (word: string) => {
  const n = ORDINALS.indexOf(word) + 1;
  assert.ok(n > 0, `no attempt "${word}"`);
  return n;
};

// ---- the drain ----

async function operatorId(world: object): Promise<string | null> {
  const s = p17(world);
  if (s.operator) return s.operator;
  const login = p89(world).login;
  if (!login) return null;
  return (await need().pool.query<{ id: string }>(`select id from "user" where subject = $1`, [login])).rows[0]?.id ?? null;
}

/** Sets the factory's drain, dated `minutesAgo` before the scenario's clock. */
async function drain(world: object, reason: string, minutesAgo: number): Promise<void> {
  const pool = need().pool;
  await setOverride(pool, { scope: "factory", targetId: null, kind: "drain", reason, createdBy: (await operatorId(world)) as string, expiresAt: null });
  const at = new Date(p140(world).clock.getTime() - minutesAgo * 60_000);
  const r = await pool.query("update override set created_at = $1 where scope = 'factory' and kind = 'drain' and cleared_at is null", [at]);
  assert.equal(r.rowCount, 1, "the drain wasn't recorded as one active factory override");
}

When("an operator drains the factory with the reason {string}", long, async function (reason: string) {
  await drain(this, reason, 0);
});

Given("an operator drained the factory with the reason {string} {int} minute(s) ago", long, async function (reason: string, n: number) {
  await drain(this, reason, n);
});

Given("an operator drained the factory with the reason {string} {int} hour(s) ago", long, async function (reason: string, n: number) {
  await drain(this, reason, n * 60);
});

When("an operator resumes the factory with the reason {string}", long, async function (reason: string) {
  await setOverride(need().pool, { scope: "factory", targetId: null, kind: "resume", reason, createdBy: (await operatorId(this)) as string, expiresAt: null });
  const r = await need().pool.query("select 1 from override where scope = 'factory' and kind = 'drain' and cleared_at is null");
  assert.equal(r.rowCount, 0, "the drain is still set after the Resume");
});

// ---- renewals through the real cell API ----

/** The renewal ends the cell's claim at the next stage boundary: the word PBI 301's restart gives the engine. */
function endsAtBoundary(answer: { status: number; body: Record<string, any> }, cell: string): void {
  assert.equal(answer.status, 200, `${cell}'s renewal wasn't answered: ${JSON.stringify(answer)}`);
  assert.equal(answer.body.restarting, true, `${cell}'s renewal doesn't tell it to end its claim at the next stage boundary: ${JSON.stringify(answer.body)}`);
}

Then("both renewals tell the cell to end its claim at the next stage boundary", function () {
  const rs = p140(this).renewals.slice(-2);
  assert.equal(rs.length, 2, "two cells didn't renew");
  for (const r of rs) endsAtBoundary(r.answer, r.cell);
});

Then("the renewal tells the cell to end its claim at the next stage boundary", function () {
  const r = p140(this).renewals.at(-1);
  assert.ok(r, "no cell renewed its lease");
  endsAtBoundary(r.answer, r.cell);
});

// ---- the cell engine against a fake control plane ----

Given("the factory is draining", function () {
  const c = p301(this);
  assert.ok(c.stage, "no run was set up");
  assert.equal(c.ran, false, "the cell already ran");
  c.draining = true;
});

Given("the factory is not draining", function () {
  const c = p301(this);
  assert.ok(c.stage, "no run was set up");
  c.draining = false;
});

When("an operator drains the factory", function () {
  events(this, p301(this).stage!).push({ draining: true });
});

When("an operator drains the factory while red's first attempt runs", function () {
  events(this, "red").push({ draining: true });
});

Given("red allows {int} retries", function (n: number) {
  assert.ok(Number.isInteger(n) && n >= 0, `red can't allow ${n} retries`);
  assert.equal(p301(this).ran, false, "the cell already ran, so red's retries come too late");
  ctx(this).retries.set("red", n);
  assert.equal(ctx(this).retries.get("red"), n, "red's retries weren't recorded");
});

/** The attempt the cell last started at its stage, as it reported it. */
export function attemptNow(p: Pbi18): number {
  const started = p.calls.filter((x) => x.route === "/stage" && x.body.stageId === p.stage && x.body.status === "started").at(-1);
  return Number(started?.body.attempt ?? 1);
}

/**
 * Scripts the cell's stages: each SOP retry the scenario set, and each attempt it scripted to fail. A green attempt
 * that fails leaves the item's scenarios failing, so its checks fail. A red attempt that fails leaves them passing,
 * so they don't fail on a Then. PBI 140's "green allows {int} retry" counts too.
 */
export function script(world: object, p: Pbi18): void {
  const c = ctx(world);
  const greenRetries = p140(world).greenRetries;
  const retries = new Map(c.retries);
  if (greenRetries !== undefined && !retries.has("green")) retries.set("green", greenRetries);
  p.editSop = (sop: { stages: { id: string; retries?: unknown }[] }) => {
    for (const s of sop.stages) if (retries.has(s.id)) s.retries = retries.get(s.id);
  };
  p.wrapAgent = (base) => async (a: any) => {
    const out = await base(a);
    const stage = p.stage;
    const outcome = c.outcomes.get(stage)?.[attemptNow(p) - 1];
    if (outcome === "fail" && (stage === "green" || stage === "red") && a.mode !== "judge") {
      const file = join(p.fixtures, "run.ndjson");
      const report = readFileSync(file, "utf8");
      writeFileSync(file, stage === "green"
        ? report.replace(/("testStepId":"t\d+b","testStepResult":)\{"status":"PASSED"\}/g, '$1{"status":"FAILED","message":"AssertionError"}')
        : report.replace(/\{"status":"FAILED","message":"AssertionError"\}/g, '{"status":"PASSED"}'));
    }
    return out;
  };
}

export function scriptAttempt(world: object, stage: string, n: number, outcome: Outcome): void {
  const list = ctx(world).outcomes.get(stage) ?? [];
  assert.equal(list.length, n - 1, `${stage}'s attempt ${n} is scripted out of order`);
  list.push(outcome);
  ctx(world).outcomes.set(stage, list);
}

export async function runScripted(world: object, stage: string): Promise<void> {
  assert.equal(p301(world).stage, stage, `the run is at ${p301(world).stage}, not ${stage}`);
  script(world, pbi18(world));
  await runCell(world);
}

When("green's first attempt fails its checks", function () {
  scriptAttempt(this, "green", 1, "fail");
});

When(/^red's (first|second) attempt fails$/, function (n: string) {
  scriptAttempt(this, "red", ordinal(n), "fail");
});

When(/^(red|green)'s (second|third) attempt passes$/, long, async function (stage: string, n: string) {
  scriptAttempt(this, stage, ordinal(n), "pass");
  await runScripted(this, stage);
});

Then(/^the cell reports (\S+)'s (second|third) attempt as passed$/, function (stage: string, n: string) {
  const attempt = ordinal(n);
  const reports = stageCalls(finished(this)).filter((x) => x.body.stageId === stage && x.body.attempt === attempt).map((x) => x.body.status);
  assert.ok(reports.includes("passed"), `the cell reported ${stage}'s attempt ${attempt} as ${JSON.stringify(reports)}, never passed`);
});

Then(/^the cell reports (\S+)'s first attempt as failed$/, function (stage: string) {
  const reports = stageCalls(finished(this)).filter((x) => x.body.stageId === stage && x.body.attempt === 1).map((x) => x.body.status);
  assert.ok(reports.includes("failed"), `the cell reported ${stage}'s attempt 1 as ${JSON.stringify(reports)}, never failed`);
});

// ---- the control plane, with Postgres ----

Given("the factory has WIP {int}", long, async function (n: number) {
  await need().pool.query("update wip_policy set mode = 'fixed', current_wip = $1", [n]);
  const r = await need().pool.query<{ current_wip: number }>("select current_wip from wip_policy");
  assert.deepEqual(r.rows.map((x) => x.current_wip), [n], "the factory's WIP isn't set");
});

Given("item {string} is at self-review in cell {string} with a live lease", long, async function (name: string, cell: string) {
  const s = p17(this);
  const now = s.now!;
  const id = await newItem(s, name, "InProgress", { owner: cell, expires: new Date(now.getTime() + 4 * 60_000) });
  const pool = need().pool;
  const run = await pool.query<{ id: string }>(
    "insert into run (item_id, next_stage, execution_name, branch) values ($1, 'self-review', $2, $3) returning id", [id, cell, `factory/pbi-${name.toLowerCase()}-r1`]);
  await pool.query(
    `insert into stage_run (run_id, stage_id, attempt, status) values ($1, 'understand', 1, 'passed'), ($1, 'red', 1, 'passed'),
       ($1, 'green', 1, 'passed'), ($1, 'self-review', 1, 'started')`, [run.rows[0].id]);
  const r = await pool.query<{ state: string; lease_owner: string | null; lease_expires: Date | null }>(
    "select state, lease_owner, lease_expires from item where id = $1", [id]);
  assert.equal(r.rows[0].state, "InProgress", `item ${name} is ${r.rows[0].state}, not InProgress`);
  assert.equal(r.rows[0].lease_owner, cell, `item ${name}'s lease is held by ${r.rows[0].lease_owner}, not ${cell}`);
  assert.ok(r.rows[0].lease_expires && r.rows[0].lease_expires > now, `item ${name}'s lease isn't live`);
});

// The cell runs its stage to the end through the real cell API. Each step checks the cell didn't fail and reported the
// stage as its wording says. How the item ended up isn't judged here: the Thens read what the control plane holds.
When("cell {string} runs self-review to the end and self-review passes", long, async function (cell: string) {
  await runAsCell(this, cell);
  ranStage(this, "self-review");
});

Given("cell {string} ran self-review to the end and self-review passed", long, async function (cell: string) {
  await runAsCell(this, cell);
  ranStage(this, "self-review");
});

When("green passes and cell {string} ends its claim at the stage boundary", long, async function (cell: string) {
  await runAsCell(this, cell);
  const p = ranStage(this, "green");
  const passed = p.calls.findIndex((x) => x.route === "/stage" && x.body.stageId === "green" && x.body.status === "passed");
  assert.ok(p.calls.slice(passed + 1).some((x) => x.route === "/release"), `${cell} didn't end its claim after green`);
});

When("cell {string} runs green, whose first attempt fails and whose second attempt passes", long, async function (cell: string) {
  const c = ctx(this);
  c.outcomes.set("green", ["fail", "pass"]);
  await runAsCell(this, cell, (p) => script(this, p));
  ranStage(this, "green", ["failed", "passed"]);
});

When("cell {string} renews its lease while green's agent works", long, async function (cell: string) {
  // The cell is mid-stage: its green attempt is open. The renewal is answered and doesn't cut the stage short; whether it
  // tells the cell to end its claim at the boundary is the scenario's Then.
  const answer = await renew(this, cell);
  assert.equal(answer.status, 200, `${cell}'s renewal wasn't answered: ${JSON.stringify(answer)}`);
  assert.equal(answer.body.stop, false, `${cell}'s renewal cut green short: ${JSON.stringify(answer.body)}`);
});

When("the operator opens Floor straight away, before cell {string}'s lease would have run out", long, async function (cell: string) {
  // PBI 300's cell holds a lease 4 minutes past the scenario's clock, so a Floor opened now is well inside it.
  assert.ok(Date.now() < p140(this).clock.getTime() + 4 * 60_000, `${cell}'s lease would have run out by now`);
  await open(p89(this), "/");
});

export async function runOf(world: object, name: string): Promise<string> {
  const id = p17(world).items[name];
  assert.ok(id, `no item ${name}`);
  const r = await need().pool.query<{ id: string }>("select id from run where item_id = $1 order by started_at desc limit 1", [id]);
  assert.ok(r.rowCount, `item ${name} has no run`);
  return r.rows[0].id;
}

Then("item {string}'s green attempts are recorded as failed, then passed", long, async function (name: string) {
  const r = await need().pool.query<{ status: string }>(
    "select status from stage_run where run_id = $1 and stage_id = 'green' order by attempt", [await runOf(this, name)]);
  assert.deepEqual(r.rows.map((x) => x.status), ["failed", "passed"], `item ${name}'s green attempts`);
});

Then("no attempt of item {string}'s or item {string}'s run is recorded as stopped", long, async function (a: string, b: string) {
  for (const name of [a, b]) {
    const r = await need().pool.query<{ stage_id: string; attempt: number }>(
      "select stage_id, attempt from stage_run where run_id = $1 and status = 'stopped'", [await runOf(this, name)]);
    assert.deepEqual(r.rows.map((x) => `${x.stage_id}:${x.attempt}`), [], `item ${name}'s run has attempts recorded as stopped`);
  }
});
