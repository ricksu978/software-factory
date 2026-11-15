// Step definitions for features/pbi-302-restart-running-cells.feature. Every scenario reuses PBI 140's steps and
// hooks, which also run for @pbi-302: its control plane, clock, restart override, Floor and launcher steps, and PBI 17's
// running items and scheduler tick. Only the two steps PBI 140 has no wording for live here.
import { Given, When } from "@cucumber/cucumber";
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
});

When("the launcher can stop cell {string} again", function (cell: string) {
  p17(this).failStop?.delete(cell);
});
