// Step definitions for features/pbi-302-restart-running-cells.feature. Every scenario reuses PBI 140's steps and
// hooks, which also run for @pbi-302: its control plane, clock, restart override and Floor steps, and PBI 17's running
// items. Only the step PBI 140 has no wording for lives here.
import { Given } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { long, need } from "./pbi-8.steps.ts";
import { ctx as p17, newItem } from "./pbi-17.steps.ts";

Given("item {string} is running in cell {string} whose lease ran out a minute ago", long, async function (name: string, cell: string) {
  // Still InProgress under its cell, with an open run, but the lease ended a minute before the scenario's clock.
  const s = p17(this);
  const now = s.now ?? new Date();
  const id = await newItem(s, name, "InProgress", { owner: cell, expires: new Date(now.getTime() - 60_000) });
  const run = await need().pool.query<{ id: string }>(
    "insert into run (item_id, next_stage, execution_name, branch) values ($1, 'green', $2, 'factory/pbi-x-r1') returning id", [id, cell]);
  await need().pool.query("insert into stage_run (run_id, stage_id, attempt, status) values ($1, 'understand', 1, 'passed')", [run.rows[0].id]);
  // Check the setup landed as named, so the scenario's count really covers a lapsed lease rather than a broken insert.
  const row = (await need().pool.query<{ state: string; lease_owner: string | null; lease_expires: Date | null; open_runs: number }>(
    `select i.state, i.lease_owner, i.lease_expires,
            (select count(*)::int from run r where r.item_id = i.id and r.ended_at is null and r.execution_name = $2) as open_runs
       from item i where i.id = $1`, [id, cell])).rows[0];
  assert.ok(row, `item ${name} should exist`);
  assert.equal(row.state, "InProgress", `item ${name} should be InProgress`);
  assert.equal(row.lease_owner, cell, `item ${name} should be leased to ${cell}`);
  assert.ok(row.lease_expires && row.lease_expires.getTime() < now.getTime(), `item ${name}'s lease should have ended before the scenario's clock`);
  assert.equal(row.open_runs, 1, `item ${name} should have one open run in ${cell}`);
});
