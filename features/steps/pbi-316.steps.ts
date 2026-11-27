// Step definitions for features/pbi-316-drain-shows-cells-running.feature. Every scenario reuses PBI 140's steps and
// hooks, which also run for @pbi-316: its control plane, clock, Prepare restart, Resume and Floor steps, "no cell is
// running", and PBI 17's running, waiting and in-review items and scheduler tick. Only the wording PBI 140 has none
// for lives here: draining the factory, now or some minutes ago, and a cell that finishes its run and exits.
import { Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { long, need } from "./pbi-8.steps.ts";
import { ctx as p140, pageText } from "./pbi-140.steps.ts";
import { viaBff } from "./pbi-19.steps.ts";
import { ctx as p89 } from "./pbi-89.steps.ts";

/** Sets a factory override through Floor's Controls, as the signed-in operator does: through the BFF, from its origin. */
async function postOverride(world: object, kind: string, reason: string): Promise<void> {
  const control = p89(world);
  assert.ok(control.dash && control.login, "the control plane isn't running, or no one is signed in");
  const b = control.dash.browsers.get(control.login);
  assert.ok(b, `${control.login} isn't signed in through the BFF`);
  const r = await viaBff(control.dash, b, "POST", "/bff/v1/overrides", { kind, reason });
  control.status = r.status;
  assert.equal(r.status, 201, `the API answered ${r.status} to the ${kind}: ${r.body}`);
}

When("the operator drains the factory with the reason {string}", long, async function (reason: string) {
  await postOverride(this, "drain", reason);
});

Given("the operator drained the factory with the reason {string} {int} minute(s) ago", long, async function (reason: string, n: number) {
  await postOverride(this, "drain", reason);
  const at = new Date(p140(this).clock.getTime() - n * 60_000);
  const r = await need().pool.query("update override set created_at = $1 where scope = 'factory' and kind = 'drain' and cleared_at is null", [at]);
  assert.equal(r.rowCount, 1, "the drain wasn't recorded as one active factory override");
});

When("cell {string} finishes and exits", long, async function (cell: string) {
  // The cell's last stage opened its PR: the item moves to InReview, its lease is released, and the cell exits.
  const pool = need().pool;
  const r = await pool.query<{ item_id: string }>(
    "update run set pr_number = 7, execution_name = null where execution_name = $1 and ended_at is null returning item_id", [cell]);
  assert.equal(r.rowCount, 1, `no open run has the cell ${cell}`);
  await pool.query("update run set next_stage = 'address' where item_id = $1 and ended_at is null", [r.rows[0].item_id]);
  await pool.query("update item set state = 'InReview', lease_owner = null, lease_expires = null where id = $1", [r.rows[0].item_id]);
  const live = await pool.query("select 1 from item where id = $1 and state = 'InProgress'", [r.rows[0].item_id]);
  assert.equal(live.rowCount, 0, `cell ${cell}'s item is still InProgress`);
});

Then("Floor shows the drain's reason {string}", function (reason: string) {
  const control = p89(this);
  assert.equal(control.status, 200, "Floor didn't open");
  assert.ok(pageText(control.html!).includes(reason), `Floor doesn't show the drain's reason "${reason}"`);
});
