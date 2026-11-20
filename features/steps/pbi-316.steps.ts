// Step definitions for features/pbi-316-drain-shows-cells-running.feature. Every scenario reuses PBI 140's steps and
// hooks, which also run for @pbi-316: its control plane, clock, Prepare restart, Resume and Floor steps, "no cell is
// running", and PBI 17's running, waiting and in-review items and scheduler tick. Only the wording PBI 140 has none
// for lives here: draining the factory, now or some minutes ago, and a cell that finishes its run and exits.
import { Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { long, need } from "./pbi-8.steps.ts";
import { ctx as p140 } from "./pbi-140.steps.ts";
import { ctx as p89, headers } from "./pbi-89.steps.ts";

const unescape = (html: string) => html.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Sets a factory override through the dashboard's Controls, as the signed-in operator does. */
async function postOverride(world: object, kind: string, reason: string): Promise<void> {
  const control = p89(world);
  assert.ok(control.origin && control.login, "the control plane isn't running, or no one is signed in");
  const r = await fetch(`${control.origin}/overrides`, {
    method: "POST", redirect: "manual", body: new URLSearchParams({ kind, reason }).toString(),
    headers: { ...headers(control.login), origin: control.origin, "content-type": "application/x-www-form-urlencoded" },
  });
  control.status = r.status;
  assert.ok(r.status < 400, `the dashboard answered ${r.status} to the ${kind}`);
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
  assert.ok(unescape(control.html!).includes(reason), `Floor doesn't show the drain's reason "${reason}"`);
});
