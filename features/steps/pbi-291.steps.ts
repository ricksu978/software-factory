// Step definitions for features/pbi-291-fenced-body-inner-blocks.feature. Every other step is PBI 216's, PBI 142's
// or PBI 152's: the run resumes at open-pr, PBI 216's scripted open-pr agent answers with the scenario's replies and
// records its briefs on the world as `pbi216`, and the open-pr stage's reports are the "/stage" calls the fake
// control plane recorded.
import { Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { Ctx as CellCtx } from "./pbi-18.steps.ts";

/** The cell ran without crashing. */
function ran(world: object): CellCtx {
  const w = world as { pbi18?: CellCtx };
  assert.ok(w.pbi18, "no run was set up");
  assert.equal(w.pbi18.error, null, `the cell failed: ${w.pbi18.error instanceof Error ? w.pbi18.error.stack : String(w.pbi18.error)}`);
  return w.pbi18;
}

/** The report that ended an open-pr attempt. */
function ended(world: object, attempt: number): Record<string, any> {
  const r = ran(world)
    .calls.filter((x) => x.route === "/stage" && x.body.stageId === "open-pr")
    .map((x) => x.body)
    .filter((s) => s.attempt === attempt && s.status !== "started")
    .at(-1);
  assert.ok(r, `open-pr attempt ${attempt} never ended`);
  return r;
}

/** A line says the PR body leaves a code block (or fence) open. */
const leavesOpen = (text: string) =>
  text.split("\n").some((l) => /\bPR body\b/i.test(l) && /\b(?:code block|fence)\b/i.test(l) && /\b(?:open|unclosed|never closes?)\b/i.test(l));

Then("that attempt's finding says the PR body leaves a code block open", function () {
  const message = String(ended(this, 1).message ?? "");
  assert.ok(leavesOpen(message), `open-pr's first attempt's message doesn't say the PR body leaves a code block open: ${message}`);
});

Then("the open-pr agent's second brief says its last attempt failed because the PR body leaves a code block open", function () {
  ran(this);
  const briefs = (this as { pbi216?: { briefs: string[] } }).pbi216?.briefs ?? [];
  assert.ok(briefs.length >= 2, `the open-pr agent was briefed ${briefs.length} time(s)`);
  const b = briefs[1];
  assert.match(b, /last attempt failed/i, "the second brief doesn't say the last attempt failed");
  assert.ok(leavesOpen(b), `the second brief doesn't say the PR body leaves a code block open:\n${b}`);
});
