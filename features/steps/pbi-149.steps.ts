// Step definitions for features/pbi-149-readiness-logic-change.feature. The @ac-1 scenarios compare readinessSha over
// the same repo files with two sets of readiness logic. The @db scenarios reuse PBI 12's poller harness, so its "the
// poller runs once", "the factory holds the item in state" and "both items are in state" steps read the same context.
// A restart is a new readiness logic in that context, which every later poll passes to the poller.
import { Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { readinessLogic } from "../../src/agent/run.ts";
import { readinessSha, type ReadinessLogic, type ReadinessTexts } from "../../src/policy/policy.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";
import { baseFiles, baseline, ctx as pollCtx, poll, polled, REPO, setup, stateOf, type Ctx as PollCtx } from "./pbi-12.steps.ts";

// ---- the fingerprint ----

type Check = { texts: ReadinessTexts; logic: ReadinessLogic };
type Ctx = { checks: Check[]; commentsBefore: Map<string, number> };

export function ctx(world: object): Ctx {
  const w = world as { pbi149?: Ctx };
  w.pbi149 ??= { checks: [], commentsBefore: new Map() };
  return w.pbi149;
}

const files: ReadinessTexts = {
  dor: "- [ ] Has a title\n", scenarios: "Keep each scenario short.\n", "pr-review": "- [ ] The change is correct.\n",
  risk: "Low means docs only.\n", dod: "- [ ] Tests pass\n", config: "bdd: {}\n",
};

/** The same prompt with one word more, so it differs by exactly one word whatever the current prompt holds. */
export const oneWordOff = (logic: ReadinessLogic): ReadinessLogic => ({ ...logic, judgePrompt: `${logic.judgePrompt} Briefly.` });
const versionUp = (logic: ReadinessLogic): ReadinessLogic => ({ ...logic, version: logic.version + 1 });

export function first(world: object): Check {
  const checks = ctx(world).checks;
  assert.ok(checks.length >= 1, "no readiness check was set up");
  return checks[0];
}

Given("one readiness check that reads a set of repo files with the factory's current logic", function () {
  ctx(this).checks.push({ texts: { ...files }, logic: readinessLogic() });
});

Given("another that reads the same files with a judge prompt that differs by one word", function () {
  const base = first(this);
  ctx(this).checks.push({ texts: { ...base.texts }, logic: oneWordOff(base.logic) });
});

Given("another that reads the same files with the readiness version raised by one", function () {
  const base = first(this);
  ctx(this).checks.push({ texts: { ...base.texts }, logic: versionUp(base.logic) });
});

Then("the two checks have different fingerprints", function () {
  const checks = ctx(this).checks;
  assert.equal(checks.length, 2, "a scenario compares exactly two checks");
  const [a, b] = checks.map((k) => readinessSha(k.texts, k.logic));
  assert.notEqual(a, b, `both checks hash to ${a}`);
});

Then("its fingerprint differs from the fingerprint of the repo files alone", function () {
  const check = first(this);
  const withLogic = readinessSha(check.texts, check.logic);
  assert.notEqual(withLogic, readinessSha(check.texts), `the check hashes to ${withLogic}, the same as the repo files alone`);
});

// ---- the poller ----

Before({ tags: "@pbi-149 and @db", ...long }, async function () {
  const d = await testDb();
  if (d) await d.pool.query('truncate item, backlog_source, repo, "user" cascade');
});

/** The logic the factory runs with now: the last restart's, or its own current logic before any restart. */
export const running = (c: PollCtx): ReadinessLogic => c.logic ?? readinessLogic();

/**
 * Gates each item into NotReady with a failing judge, which records the readiness files and logic it was checked
 * against. Then counts the judge's asks and each item's comments from zero, so the Thens see only what came after.
 */
async function gateIntoNotReady(world: object, c: PollCtx, state: string): Promise<void> {
  c.judge = "fail";
  await poll(c);
  if (c.polls === 0) return;
  polled(c);
  for (const ext of c.extIds) assert.equal(await stateOf(c, ext), state, "setup didn't reach the expected state");
  c.asked.clear();
  for (const ext of c.extIds) ctx(world).commentsBefore.set(ext, (await c.fake!.comments(ext)).length);
  c.baseline = await baseline(c);
}

Given("the factory holds an item in state {string}, checked against the repo's current readiness files", long, async function (state: string) {
  const c = pollCtx(this);
  if (!(await setup(c))) return;
  c.extIds = [await c.fake!.seed({ labels: ["factory"], repo: REPO })];
  await gateIntoNotReady(this, c, state);
});

Given("the factory holds an item in state {string} in repo {string} and another in repo {string}", long, async function (state: string, a: string, b: string) {
  const c = pollCtx(this);
  if (!(await setup(c))) return;
  for (const repo of [a, b]) {
    for (const [path, text] of Object.entries(baseFiles)) c.host!.files.set(`${repo}@c1:${path}`, text);
    c.host!.heads.set(repo, "c1");
    await need().pool.query("insert into repo (host_adapter, url) values ('fake', $1)", [`https://github.com/${repo}`]);
  }
  c.extIds = [await c.fake!.seed({ labels: ["factory"], repo: a }), await c.fake!.seed({ labels: ["factory"], repo: b })];
  await gateIntoNotReady(this, c, state);
});

Given("neither the items nor the repo's readiness files change", long, async function () {
  const c = pollCtx(this);
  polled(c);
  assert.ok(c.baseline, "the setup recorded no baseline to compare against");
  assert.deepEqual(await baseline(c), c.baseline, "an item or a repo's readiness files changed after the setup");
});

Given("the factory restarts with a judge prompt that differs by one word", function () {
  const c = pollCtx(this);
  c.logic = oneWordOff(running(c));
});

When("the factory restarts with the readiness version raised by one", function () {
  const c = pollCtx(this);
  c.logic = versionUp(running(c));
});

When("the factory restarts again with the same judge prompt and readiness version", function () {
  const c = pollCtx(this);
  c.logic = { ...running(c) };
});

Given("the readiness judge still fails line {int} because {string}", function (index: number, reason: string) {
  const c = pollCtx(this);
  c.judge = "fail";
  c.failLine = { index, reason };
});

Given("the readiness judge still fails every line", function () {
  const c = pollCtx(this);
  c.judge = "fail";
  c.failLine = undefined;
});

When("the poller runs three times", long, async function () {
  const c = pollCtx(this);
  for (let i = 0; i < 3; i++) await poll(c);
});

/** How many times an item's history shows the event, by external id. */
export async function moves(c: PollCtx, ext: string, event: string): Promise<number> {
  const r = await need().pool.query<{ n: number }>(
    `select count(*)::int as n from event e join item i on i.id = e.item_id
     where i.source_id = $1 and i.external_id = $2 and e.kind = 'transition' and e.payload->>'event' = $3`,
    [c.sourceId, ext, event],
  );
  return r.rows[0].n;
}

function held(world: object, n?: number): PollCtx {
  const c = pollCtx(world);
  polled(c);
  if (n !== undefined) assert.equal(c.extIds.length, n, `the scenario holds ${c.extIds.length} items`);
  return c;
}

Then("each item's history shows one move {string}", long, async function (event: string) {
  const c = held(this, 2);
  for (const ext of c.extIds) assert.equal(await moves(c, ext, event), 1, `item ${ext}`);
});

Then("neither item's history shows a move {string}", long, async function (event: string) {
  const c = held(this, 2);
  for (const ext of c.extIds) assert.equal(await moves(c, ext, event), 0, `item ${ext}`);
});

Then("the item's history shows one move {string}", long, async function (event: string) {
  const c = held(this, 1);
  assert.equal(await moves(c, c.extIds[0], event), 1);
});

Then("the item's history shows exactly one move {string}", long, async function (event: string) {
  const c = held(this, 1);
  assert.equal(await moves(c, c.extIds[0], event), 1);
});

Then("the item's history shows exactly two moves {string}", long, async function (event: string) {
  const c = held(this, 1);
  assert.equal(await moves(c, c.extIds[0], event), 2);
});

Then("the readiness judge was asked about the item once", function () {
  const c = held(this, 1);
  assert.equal(c.asked.get(c.extIds[0]) ?? 0, 1);
});

Then("the readiness judge was asked about the item twice", function () {
  const c = held(this, 1);
  assert.equal(c.asked.get(c.extIds[0]) ?? 0, 2);
});

Then("the board item has a new readiness comment saying {string}", async function (text: string) {
  const c = held(this, 1);
  const ext = c.extIds[0];
  const all = await c.fake!.comments(ext);
  const fresh = all.slice(ctx(this).commentsBefore.get(ext) ?? 0);
  assert.ok(fresh.some((body) => body.includes(text)), `no new comment says "${text}":\n${fresh.join("\n---\n")}`);
});
