// Step definitions for features/pbi-297-note-after-wrapper.feature. Every other step is PBI 216's, PBI 142's or PBI 18's:
// the run resumes at open-pr, PBI 216's scripted open-pr agent answers with the scenario's reply, and the PR bodies
// are the ones PBI 18's fake repo host recorded. The "summary part" of a PR body is what comes before the factory's
// own "Refs #482" line.
import { Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { Ctx as CellCtx } from "./pbi-18.steps.ts";

/** The last PR body the cell wrote, after checking the cell ran without crashing. */
function lastBody(world: object): string {
  const w = world as { pbi18?: CellCtx };
  assert.ok(w.pbi18, "no run was set up");
  const run = w.pbi18;
  assert.equal(run.error, null, `the cell failed: ${run.error instanceof Error ? run.error.stack : String(run.error)}`);
  assert.ok(run.prBodies.length > 0, "no PR was opened");
  return run.prBodies.at(-1)!;
}

Then("the summary part of the PR body ends with {string}", function (end: string) {
  const body = lastBody(this);
  const at = body.indexOf("Refs #482");
  assert.ok(at >= 0, `the PR body has no "Refs #482" line:\n${body}`);
  const part = body.slice(0, at).replace(/\s+$/, "");
  assert.ok(part.endsWith(end), `the summary part of the PR body doesn't end with ${JSON.stringify(end)}. It ends:\n${part.slice(-200)}`);
});
