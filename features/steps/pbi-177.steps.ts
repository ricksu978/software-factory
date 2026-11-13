import { Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { changeSetting } from "../../src/http/configuration.ts";
import { ctx, freshDb, newItem, tick } from "./pbi-17.steps.ts";
import { long, need } from "./pbi-8.steps.ts";

// PBI 177: the scheduler honours a live raise or lower of current WIP. Builds on PBI 17's steps: the same fresh
// database, the same recorder launcher and the same items. An operator changes current WIP through the
// Configuration page's own changeSetting, so the change is the one an operator makes, and the scheduler, which
// reads the policy each tick, is never restarted. "The scheduler ticks again" keeps the first tick's starts and
// stops alongside the second's, so the Thens see every cell both ticks started or stopped.

Given(
  "a fresh factory database with WIP minimum {int}, WIP maximum {int}, current WIP {int} and a review capacity of {int}",
  long,
  async function (min: number, max: number, current: number, capacity: number) {
    await freshDb(this, current);
    const set = await need().pool.query(
      "update wip_policy set wip_min = $1, wip_max = $2, current_wip = $3, review_capacity = $4",
      [min, max, current, capacity],
    );
    assert.equal(set.rowCount, 1, `the WIP policy update changed ${set.rowCount} row(s), not one`);
  },
);

Given("current WIP is {int}", long, async function (wip: number) {
  const set = await need().pool.query("update wip_policy set current_wip = $1", [wip]);
  assert.equal(set.rowCount, 1, `setting current WIP changed ${set.rowCount} row(s), not one`);
});

Given("item {string} is queued behind them", long, async function (name: string) {
  const id = await newItem(ctx(this), name, "Queued", { rank: 10_000 });
  const r = await need().pool.query<{ state: string }>("select state from item where id = $1", [id]);
  assert.equal(r.rows[0]?.state, "Queued", `item ${name} is ${r.rows[0]?.state}, not Queued`);
});

// Nothing in review and no open question, so the review brake can't hold work back.
Given("no item waits on a person", long, async function () {
  const waiting = await need().pool.query(
    `select 1 from item i where i.state = 'InReview'
       or (i.state in ('SignOff', 'NeedsInput')
         and exists (select from question q where q.item_id = i.id and q.answer is null and q.closed_at is null))`,
  );
  assert.equal(waiting.rowCount, 0, "an item already waits on a person");
});

When("an operator changes current WIP from {int} to {int} while the scheduler keeps running", long, async function (from: number, to: number) {
  const c = ctx(this);
  const before = await need().pool.query<{ current_wip: number }>("select current_wip from wip_policy limit 1");
  assert.equal(before.rows[0].current_wip, from, "current WIP isn't where the scenario says it starts");
  const checked = await changeSetting(need().pool, c.operator!, "current_wip", String(to), `scenario: WIP ${from} to ${to}`);
  assert.ok(checked.ok, `the change was turned down: ${JSON.stringify(checked)}`);
});

When("the scheduler ticks again", long, async function () {
  const c = ctx(this);
  const started = c.started;
  const stopped = c.stopped;
  await tick(c);
  c.started = [...started, ...c.started];
  c.stopped = [...stopped, ...c.stopped];
});

function ran(world: object) {
  const c = ctx(world);
  assert.ok(c.ticked, "the scheduler never ticked");
  return c;
}

async function states(world: object, items: string[], expected: string) {
  const c = ran(world);
  for (const name of items) {
    const r = await need().pool.query<{ state: string }>("select state from item where id = $1", [c.items[name]]);
    assert.equal(r.rows[0]?.state, expected, `item ${name} is ${r.rows[0]?.state}, not ${expected}`);
  }
}

Then("items {string}, {string} and {string} are {string}", long, async function (a: string, b: string, cc: string, expected: string) {
  await states(this, [a, b, cc], expected);
});

Then("items {string} and {string} are {string}", long, async function (a: string, b: string, expected: string) {
  await states(this, [a, b], expected);
});

Then("exactly three cells have started, one for each of {string}, {string} and {string}", function (a: string, b: string, cc: string) {
  const c = ran(this);
  const started = c.started.map((env) => env.ITEM_ID).sort();
  const wanted = [a, b, cc].map((n) => c.items[n]).sort();
  assert.deepEqual(started, wanted, `${c.started.length} cell(s) started, for ${JSON.stringify(started)}`);
});

Then("cells {string} and {string} are not stopped", function (a: string, b: string) {
  const c = ran(this);
  for (const cell of [a, b]) assert.ok(!c.stopped.includes(cell), `${cell} was stopped`);
});
