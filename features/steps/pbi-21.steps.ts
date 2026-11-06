// Step definitions for features/pbi-21-walking-skeleton.feature. Each scenario starts the whole factory in process
// through src/e2e.ts, on PBI 4's shared test database, and drives it the way people and GitHub would.
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import type { DataTable } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { REPO, startFactory, type Factory } from "../../src/e2e.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";

type Ctx = { f: Factory; items: Map<string, string>; current: string; mergeSha: string | null };

function ctx(world: object): Ctx {
  const c = (world as { pbi21?: Ctx }).pbi21;
  assert.ok(c, "the factory didn't start");
  return c;
}
const ext = (c: Ctx, title: string) => {
  const id = c.items.get(title);
  assert.ok(id, `no item "${title}"`);
  return id;
};

Before({ tags: "@pbi-21", ...long }, async function () {
  const d = await testDb();
  if (!d) return;
  await d.pool.query(`truncate item, "user", backlog_source, repo, webhook_delivery, override cascade`);
  await d.pool.query("update wip_policy set usage_paused_until = null");
});

After({ tags: "@pbi-21", ...long }, async function () {
  await (this as { pbi21?: Ctx }).pbi21?.f.stop();
});

Given("a fake backlog, and a fake repo whose only policy files are .factory\\/config.yml and .factory\\/dod.md", long, async function () {
  await testDb();
  (this as { pbi21?: Ctx }).pbi21 = { f: await startFactory(need().pool), items: new Map(), current: "", mergeSha: null };
});

Given("a scripted agent that writes the scenarios, step definitions and code each stage asks for", function () {
  // src/e2e.ts's launcher already runs every cell with the scripted agent.
  ctx(this);
});

Given("CI on the fake repo goes green for every commit unless a scenario says otherwise", function () {
  assert.equal(ctx(this).f.ci.redOnMerge, false);
});

Given("CI on the fake repo goes red for the merge commit", function () {
  ctx(this).f.ci.redOnMerge = true;
});

async function addItem(c: Ctx, title: string, n: number) {
  const id = await c.f.addItem(title, Array.from({ length: n }, (_, i) => `${title} criterion ${i + 1}`));
  c.items.set(title, id);
  c.current = id;
}

Given("a labelled item {string} with two acceptance criteria", long, async function (title: string) {
  await addItem(ctx(this), title, 2);
});

Given("a labelled item {string} with one acceptance criterion", long, async function (title: string) {
  await addItem(ctx(this), title, 1);
});

// Readiness is one poll, and each later stage is one scheduler tick, which waits for the cell it started.
async function throughSpecify(c: Ctx) {
  await c.f.poll();
  await c.f.tick();
}
async function merge(c: Ctx) {
  c.mergeSha = await c.f.merge(c.current);
  await c.f.tick();
}

When("the factory takes the item through readiness and Specify", long, async function () {
  await throughSpecify(ctx(this));
});

When("the product owner approves the scenarios in Run detail", long, async function () {
  const c = ctx(this);
  await c.f.approveInRunDetail(c.current);
});

When("the product owner comments {string} on the item", long, async function (body: string) {
  const c = ctx(this);
  await c.f.commentOnItem(c.current, body);
});

When("the factory takes the item through Red, Green and its pull request", long, async function () {
  await ctx(this).f.tick();
});

When("a trusted reviewer requests changes on the pull request", long, async function () {
  const c = ctx(this);
  await c.f.requestChanges(c.current);
});

When("the factory addresses the requested changes", long, async function () {
  await ctx(this).f.tick();
});

When("a person merges the pull request", long, async function () {
  await merge(ctx(this));
});

Given("the item {string} went from Eligible to Done, and its scenarios are on main", long, async function (title: string) {
  const c = ctx(this);
  await addItem(c, title, 2);
  await throughSpecify(c);
  await c.f.approveInRunDetail(c.current);
  await c.f.tick();
  await merge(c);
});

When("the factory takes {string} through readiness, Specify, sign-off, Red, Green, its pull request and a merge", long, async function (title: string) {
  const c = ctx(this);
  c.current = ext(c, title);
  await throughSpecify(c);
  await c.f.approveInRunDetail(c.current);
  await c.f.tick();
  await merge(c);
});

Then("the item {string} is {word}", long, async function (title: string, state: string) {
  const c = ctx(this);
  assert.equal(await c.f.state(ext(c, title)), state, `states so far: ${(await c.f.states(ext(c, title))).join(" > ")}`);
});

Then("the board shows {string} with the status {string} and closed", long, async function (title: string, status: string) {
  const c = ctx(this);
  const item = await c.f.board.adapter.getItem(ext(c, title));
  assert.equal(item?.status, status);
  assert.equal(item?.closed, true);
});

Then("{string} passed through these states in order:", long, async function (title: string, table: DataTable) {
  const c = ctx(this);
  assert.deepEqual(await c.f.states(ext(c, title)), table.hashes().map((r) => r.state));
});

Then("the board has a comment on {string} that links the failed CI run", long, async function (title: string) {
  const c = ctx(this);
  assert.ok(c.mergeSha, "nothing was merged");
  const link = `https://github.com/${REPO}/commit/${c.mergeSha}/checks`;
  const comments = await c.f.board.comments(ext(c, title));
  assert.ok(comments.some((body) => body.includes(link)), `no comment links ${link}:\n${comments.join("\n---\n")}`);
});

Then("Red for {string} passed while the scenarios of {string} were green", long, async function (title: string, earlier: string) {
  const c = ctx(this);
  const red = await c.f.report(ext(c, title), "red");
  assert.ok(red, `no red report for "${title}"`);
  const passed = await need().pool.query(
    "select 1 from stage_run s join run r on r.id = s.run_id join item i on i.id = r.item_id where i.external_id = $1 and s.stage_id = 'red' and s.status = 'passed'",
    [ext(c, title)],
  );
  assert.equal(passed.rowCount, 1, "Red didn't pass");
  const theirs = [...red].filter(([name]) => name.includes(`item ${ext(c, earlier)} `));
  const mine = [...red].filter(([name]) => name.includes(`item ${ext(c, title)} `));
  assert.ok(theirs.length > 0 && theirs.every(([, v]) => v === "green"), `"${earlier}" at Red: ${JSON.stringify(theirs)}`);
  assert.ok(mine.length > 0 && mine.every(([, v]) => v === "red"), `"${title}" at Red: ${JSON.stringify(mine)}`);
});

Then("every scenario of {string} still passes on main", long, async function (title: string) {
  const c = ctx(this);
  // The second item's last green run had main merged in, so it shows the earlier item's scenarios on main.
  const green = await c.f.report(c.current, "green");
  assert.ok(green, "no green report");
  const theirs = [...green].filter(([name]) => name.includes(`item ${ext(c, title)} `));
  assert.ok(theirs.length > 0 && theirs.every(([, v]) => v === "green"), JSON.stringify(theirs));
});
