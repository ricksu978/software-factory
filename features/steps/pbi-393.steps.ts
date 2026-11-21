// Step definitions for features/pbi-393-drain-ends-cells-at-attempt-boundary.feature. They build on PBI 140's, PBI
// 301's and PBI 379's steps and hooks, which also run for @pbi-393: PBI 140's clock and cell API, PBI 301's cell engine
// against a fake control plane or, for @db, as the run's cell against the real cell API, and PBI 379's drain and
// scripted attempts, the drain set mid-retry included. Only what those have no wording for lives here: an attempt that
// fails at address, the attempt boundary a cell ends its claim at, and the new cell that claims the item once the drain or
// restart is cleared, with the brief it writes.
// A scenario that only scripts its attempts, as "green's first attempt fails its checks" does, has no step that runs
// the cell. A hook runs it before the scenario's first Then, as the last When would have.
import { BeforeStep, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newCellContext } from "./pbi-140.steps.ts";
import { newItem, ctx as p17 } from "./pbi-17.steps.ts";
import type { Ctx as Pbi18 } from "./pbi-18.steps.ts";
import { atStage, ctx as p301, finished, pbi18, runAsCell, runAsRun, runCell, stageCalls } from "./pbi-301.steps.ts";
import { attemptNow, ctx as p379, ordinal, runOf, script, scriptAttempt } from "./pbi-379.steps.ts";
import { long, need } from "./pbi-8.steps.ts";

type Brief = { stage: string; attempt: number; prompt: string };

type Ctx = {
  /** The test a green attempt fails, by attempt, named in the report instead of the item's first scenario. */
  failingTest: Map<number, string>;
  /** The prompts the new cell's stages sent its agent, with the attempt each was sent in. A stage's brief is its attempt's first. */
  briefs: Brief[];
  /** The cell the scheduler started once the drain or restart was cleared, once it ran. */
  newCell?: Pbi18;
};

function ctx(world: object): Ctx {
  const w = world as { pbi393?: Ctx };
  w.pbi393 ??= { failingTest: new Map(), briefs: [] };
  return w.pbi393;
}

/** The judged Definition of Done line that an address attempt scripted to fail is judged to fail on. */
const JUDGED = "The change reads well.";

/**
 * PBI 379's scripting, and on top of it: an address attempt scripted to fail, whose DoD check judges a line failed, a green attempt that fails a named test, and each brief.
 */
function scriptMore(world: object, p: Pbi18): void {
  script(world, p);
  const c = ctx(world);
  if (!p.dod.includes(JUDGED)) p.dod = `${p.dod}- [ ] ${JUDGED}\n`;
  const inner = p.wrapAgent!;
  p.wrapAgent = (base) => {
    const wrapped = inner(base);
    return async (a: any) => {
      const stage = p.stage;
      const attempt = attemptNow(p);
      const judge = String(a.prompt).startsWith("# Definition of Done");
      if (!judge && !a.agent) c.briefs.push({ stage, attempt, prompt: a.prompt });
      const out = await wrapped(a);
      const outcome = p379(world).outcomes.get(stage)?.[attempt - 1];
      if (stage === "address" && outcome === "fail" && judge && a.prompt.includes(JUDGED)) {
        out.text = String(out.text).replace(/"status":"passed"/g, '"status":"failed"');
      }
      const test = c.failingTest.get(attempt);
      if (stage === "green" && test && !judge) {
        const file = join(p.fixtures, "run.ndjson");
        writeFileSync(file, readFileSync(file, "utf8").replace(/"name":"Criterion 1 holds"/g, `"name":${JSON.stringify(test)}`));
      }
      return out;
    };
  };
}

// ---- the cell engine against a fake control plane ----

BeforeStep({ tags: "@pbi-393 and not @db", ...long }, async function ({ pickleStep }) {
  if (pickleStep.type !== "Outcome") return;
  const c = p301(this);
  if (!c.stage || c.ran) return;
  scriptMore(this, pbi18(this));
  await runCell(this);
});

Given("a run for item {int} that is at address's first attempt", function (_item: number) {
  atStage(this, "address");
});

Given("address allows {int} retries", function (n: number) {
  assert.ok(Number.isInteger(n) && n >= 0, `address can't allow ${n} retries`);
  assert.equal(p301(this).ran, false, "the cell already ran, so address's retries come too late");
  p379(this).retries.set("address", n);
});

When(/^(green|address)'s first attempt fails$/, function (stage: string) {
  scriptAttempt(this, stage, 1, "fail");
});

Then(/^the cell starts no (second|third) (\S+) attempt$/, function (n: string, stage: string) {
  const attempt = ordinal(n);
  const started = stageCalls(finished(this)).filter((x) => x.body.stageId === stage && x.body.status === "started" && x.body.attempt >= attempt);
  assert.deepEqual(started.map((x) => x.body.attempt), [], `the cell started ${stage}'s attempt ${attempt} or later`);
});

Then("the cell ends its claim at the attempt boundary and exits", function () {
  const p = finished(this);
  const stage = p301(this).stage!;
  const failed = p.calls.findLastIndex((x) => x.route === "/stage" && x.body.stageId === stage && x.body.status === "failed");
  assert.ok(failed >= 0, `the cell never reported a ${stage} attempt as failed`);
  const after = p.calls.slice(failed + 1);
  const started = after.filter((x) => x.route === "/stage" && x.body.status === "started").map((x) => `${x.body.stageId}:${x.body.attempt}`);
  assert.deepEqual(started, [], `the cell started a further attempt after ${stage}'s failed one`);
  const release = after.findIndex((x) => x.route === "/release");
  assert.ok(release >= 0, `the cell didn't end its claim after ${stage}'s failed attempt: ${after.map((x) => x.route).join(", ")}`);
  assert.ok(!after.some((x) => x.route === "/transition"), "the cell moved the item itself instead of ending its claim");
  const beyond = after.slice(release + 1).filter((x) => x.route !== "/lease" && x.route !== "/upload-url");
  assert.deepEqual(beyond.map((x) => x.route), [], "the cell carried on after ending its claim");
});

Then("the cell reports green's retries used up", function () {
  const p = finished(this);
  const t = p.calls.filter((x) => x.route === "/transition").at(-1);
  assert.equal(t?.body.event, "retries_exhausted", `the cell's last transition is ${JSON.stringify(t?.body)}, not retries_exhausted`);
  const ended = stageCalls(p).filter((x) => x.body.stageId === "green" && x.body.status !== "started").at(-1);
  assert.equal(ended?.body.status, "failed", "green's last attempt wasn't reported as failed");
});

// ---- the control plane, with Postgres ----

Given("item {string} is at red in cell {string} with a live lease", long, async function (name: string, cell: string) {
  const s = p17(this);
  const now = s.now!;
  const id = await newItem(s, name, "InProgress", { owner: cell, expires: new Date(now.getTime() + 4 * 60_000) });
  const pool = need().pool;
  const run = await pool.query<{ id: string }>(
    "insert into run (item_id, next_stage, execution_name, branch) values ($1, 'red', $2, 'factory/pbi-x-r1') returning id", [id, cell]);
  await pool.query(
    "insert into stage_run (run_id, stage_id, attempt, status) values ($1, 'understand', 1, 'passed'), ($1, 'red', 1, 'started')", [run.rows[0].id]);
  const r = await pool.query<{ state: string; lease_owner: string | null; lease_expires: Date | null; next_stage: string }>(
    "select i.state, i.lease_owner, i.lease_expires, r.next_stage from item i join run r on r.item_id = i.id where i.id = $1", [id]);
  assert.equal(r.rowCount, 1, `item ${name} has more than one run`);
  const row = r.rows[0];
  assert.equal(row.state, "InProgress", `item ${name} is ${row.state}, not InProgress`);
  assert.equal(row.lease_owner, cell, `item ${name}'s lease is held by ${row.lease_owner}, not ${cell}`);
  assert.ok(row.lease_expires && row.lease_expires > now, `item ${name}'s lease isn't live`);
  assert.equal(row.next_stage, "red", `item ${name}'s run is at ${row.next_stage}, not red`);
});

/**
 * The cell in `cell` runs its stage with the first attempt scripted to fail, as the real engine against the real cell
 * API, its transitions included, so a stage whose retries run out moves the item there. Only that the cell didn't fail
 * and reported that attempt failed is checked here: how the claim ended is the Thens'.
 */
async function runsFailingFirst(world: object, cell: string, stage: string, test?: string): Promise<void> {
  scriptAttempt(world, stage, 1, "fail");
  if (test) ctx(world).failingTest.set(1, test);
  await runAsCell(world, cell, (p) => scriptMore(world, p), ["transition"]);
  const p = finished(world);
  const first = stageCalls(p).find((x) => x.body.stageId === stage && x.body.status !== "started");
  assert.deepEqual([first?.body.attempt, first?.body.status], [1, "failed"], `the cell didn't report ${stage}'s first attempt as failed`);
}

When("cell {string} runs green's first attempt, which fails its checks", long, async function (cell: string) {
  await runsFailingFirst(this, cell, "green");
});

Given("cell {string} ran green's first attempt, which failed its checks", long, async function (cell: string) {
  await runsFailingFirst(this, cell, "green");
});

Given("cell {string} ran green's first attempt, which failed the test {string}", long, async function (cell: string, test: string) {
  await runsFailingFirst(this, cell, "green", test);
});

When("cell {string} runs red's first attempt, which fails", long, async function (cell: string) {
  await runsFailingFirst(this, cell, "red");
});

Given("cell {string} ran red's first attempt, which failed", long, async function (cell: string) {
  await runsFailingFirst(this, cell, "red");
});

/**
 * Runs the cell the scheduler started for item A, once: the real engine as that cell's run, against the real cell API,
 * with the attempts, the resume and whatever else the control plane's context gives a new claim, over PBI 18's repo.
 * The context's item, repo and branch are the scenario's fake ones, so only those fields stay PBI 18's.
 */
async function runNewCell(world: object): Promise<Pbi18> {
  const c = ctx(world);
  if (c.newCell) return c.newCell;
  const s = p17(world);
  const env = s.started.find((e: Record<string, string>) => e.ITEM_ID === s.items.A);
  assert.ok(env, "no cell started for item A");
  const context = await newCellContext(world, "A");
  const own = new Set(["externalId", "title", "acceptanceCriteria", "decision", "lockSha", "lockedFiles", "prNumber", "repo", "base",
    "branch", "configSha", "sopVersion", "dodVerdicts", "dodCheckedSha", "scenarioNotes", "trustedComments", "threadCommentCounts", "trustedBot", "nextStage"]);
  const carried = Object.fromEntries(Object.entries(context).filter(([k]) => !own.has(k)));
  c.briefs = [];
  await runAsRun(world, { runId: env.RUN_ID, generation: Number(env.GENERATION) }, (p) => {
    p.context = { stageAttempts: {}, resume: null, ...carried };
    scriptMore(world, p);
  }, ["transition", "pr"]);
  c.newCell = pbi18(world);
  return c.newCell;
}

When("the new cell runs green and every green attempt fails", long, async function () {
  p379(this).outcomes.set("green", ["fail", "fail", "fail", "fail", "fail"]);
  await runNewCell(this);
});

When("the new cell runs green and green's second attempt passes", long, async function () {
  const list = p379(this).outcomes.get("green") ?? [];
  assert.deepEqual(list, ["fail"], "green's first attempt wasn't scripted to fail");
  scriptAttempt(this, "green", 2, "pass");
  await runNewCell(this);
});

const startedIn = (p: Pbi18, stage: string) =>
  p.calls.filter((x) => x.route === "/stage" && x.body.stageId === stage && x.body.status === "started").map((x) => x.body.attempt);

Then(/^the new cell's first (red|green) attempt is \1's second attempt$/, long, async function (stage: string) {
  const p = await runNewCell(this);
  assert.equal(startedIn(p, stage)[0], 2, `the new cell's ${stage} attempts were ${JSON.stringify(startedIn(p, stage))}`);
});

Then("the new cell makes {int} green attempt(s) before it reports green's retries used up", long, async function (n: number) {
  const p = await runNewCell(this);
  assert.deepEqual(startedIn(p, "green"), Array.from({ length: n }, (_, i) => i + 2), "the new cell's green attempts");
  const t = p.calls.filter((x) => x.route === "/transition").at(-1);
  assert.equal(t?.body.event, "retries_exhausted", `the new cell's last transition is ${JSON.stringify(t?.body)}, not retries_exhausted`);
});

Then("the new cell starts self-review's first attempt", long, async function () {
  const p = await runNewCell(this);
  const stages = p.calls.filter((x) => x.route === "/stage");
  const passed = stages.findIndex((x) => x.body.stageId === "green" && x.body.attempt === 2 && x.body.status === "passed");
  assert.ok(passed >= 0, `the new cell didn't pass green's second attempt: ${JSON.stringify(stages.map((x) => [x.body.stageId, x.body.attempt, x.body.status]))}`);
  const next = stages.slice(passed + 1).find((x) => x.body.status === "started");
  assert.deepEqual([next?.body.stageId, next?.body.attempt], ["self-review", 1], "the new cell didn't start self-review's first attempt after green");
});

async function secondBrief(world: object, stage: string): Promise<string> {
  await runNewCell(world);
  const b = ctx(world).briefs.find((x) => x.stage === stage && x.attempt === 2);
  assert.ok(b, `the new cell wrote no brief for ${stage}'s second attempt: ${JSON.stringify(ctx(world).briefs.map((x) => [x.stage, x.attempt]))}`);
  return b.prompt;
}

Then("green's second brief says its last attempt failed", long, async function () {
  assert.match(await secondBrief(this, "green"), /## Your last attempt failed/, "green's second brief doesn't say its last attempt failed");
});

Then("green's second brief names the test {string}", long, async function (test: string) {
  const brief = await secondBrief(this, "green");
  const failed = brief.split("## Your last attempt failed")[1] ?? "";
  assert.ok(failed.includes(test), `green's second brief doesn't name the test "${test}" among its last attempt's findings`);
});

Then("green's second brief doesn't tell the agent to carry on from earlier work", long, async function () {
  const brief = await secondBrief(this, "green");
  assert.doesNotMatch(brief, /Carry on from the earlier work/i, "green's second brief tells the agent to carry on from earlier work");
  assert.doesNotMatch(brief, /already on the branch/i, "green's second brief says earlier work is already on the branch");
});

Then("red's second brief says its last attempt failed, with the first attempt's findings", long, async function () {
  const brief = await secondBrief(this, "red");
  const failed = brief.split("## Your last attempt failed")[1];
  assert.ok(failed !== undefined, "red's second brief doesn't say its last attempt failed");
  // Red's first attempt left every scenario passing, so its findings name each of them.
  for (const name of ["Criterion 1 holds", "Criterion 2 holds", "Criterion 3 holds"]) {
    assert.ok(failed.includes(`scenario passes before any behaviour exists: ${name}`), `red's second brief doesn't carry the first attempt's finding on "${name}"`);
  }
});

Then("item {string} moves to Failed", long, async function (name: string) {
  const r = await need().pool.query<{ state: string }>("select state from item where id = $1", [p17(this).items[name]]);
  assert.equal(r.rows[0]?.state, "Failed", `item ${name} is ${r.rows[0]?.state}, not Failed`);
});

Then(/^item "([^"]+)"'s green attempts are recorded as failed, (once|twice)$/, long, async function (name: string, times: string) {
  const r = await need().pool.query<{ status: string }>(
    "select status from stage_run where run_id = $1 and stage_id = 'green' order by attempt", [await runOf(this, name)]);
  const want = times === "once" ? ["failed"] : ["failed", "failed"];
  assert.deepEqual(r.rows.map((x) => x.status), want, `item ${name}'s green attempts`);
});
