import assert from "node:assert/strict";
import { test } from "node:test";
import { next, overrideTo, type ItemEvent, type ItemState } from "./states.ts";

const edges: [ItemState, ItemEvent, ItemState][] = [
  ["Eligible", "readiness_failed", "NotReady"], ["NotReady", "item_edited", "Eligible"],
  ["NotReady", "policy_changed", "Eligible"],
  ["Eligible", "ready", "Queued"], ["Queued", "claimed", "InProgress"],
  ["SignOff", "claimed", "InProgress"], ["NeedsInput", "claimed", "InProgress"],
  ["InProgress", "scenarios_written", "SignOff"], ["InProgress", "blocked", "NeedsInput"],
  ["InProgress", "pr_opened", "InReview"], ["InReview", "changes_requested", "Queued"],
  ["InReview", "merged", "Accepted"], ["InProgress", "merged", "Accepted"], ["NeedsInput", "merged", "Accepted"],
  ["InReview", "approvals_met", "Accepted"], ["Accepted", "dod_verified", "Done"],
  ["Accepted", "dod_failed", "Failed"], ["InProgress", "retries_exhausted", "Failed"],
  ["NeedsInput", "timed_out", "Abandoned"], ["SignOff", "timed_out", "Abandoned"],
  ["InProgress", "lease_expired", "Queued"], ["InProgress", "usage_limited", "Queued"],
  ["Failed", "requeued", "Queued"], ["Abandoned", "requeued", "Queued"],
  ["Abandoned", "reopened_signoff", "SignOff"], ["Abandoned", "reopened_question", "NeedsInput"],
  ...(["Queued", "InProgress", "SignOff", "NeedsInput", "InReview"] as const).flatMap((s) => [
    [s, "withdrawn", "Abandoned"], [s, "criteria_changed", "Queued"]] as [ItemState, ItemEvent, ItemState][]),
  // PBI 168: an item that leaves the backlog before it's Queued is withdrawn too, and comes back through the gate.
  ["Eligible", "withdrawn", "Abandoned"], ["NotReady", "withdrawn", "Abandoned"], ["Abandoned", "returned", "Eligible"],
  // PBI 225: a parent whose split is filed rests in Split.
  ["NotReady", "split_filed", "Split"],
  // PBI 226: a Split parent whose filed children are all Done moves to Done.
  ["Split", "children_done", "Done"],
  // PBI 228: a parent withdrawn to Abandoned after its split was filed, before PBI 225, moves to Split.
  ["Abandoned", "split_filed", "Split"],
  // PBI 369: a re-check that no longer finds the merge broke main sends the item back to Accepted.
  ["Failed", "rechecked", "Accepted"],
  // PBI 395: the owner's approval of a rule change sends a waiting item on through the gate, and an edit to an approved
  // section sends a Queued or later item back to it.
  ["NotReady", "rule_change_approved", "Eligible"], ["Queued", "rules_edited", "Eligible"],
  ["InProgress", "rules_edited", "Eligible"], ["SignOff", "rules_edited", "Eligible"],
  ["NeedsInput", "rules_edited", "Eligible"], ["InReview", "rules_edited", "Eligible"],
  // PBI 364: a stage after sign-off asks to change a locked feature file.
  ["InProgress", "feature_change_requested", "FeatureChangeRequest"],
  // PBI 364: backlog changes and a merge reach an item waiting in FeatureChangeRequest.
  ["FeatureChangeRequest", "withdrawn", "Abandoned"], ["FeatureChangeRequest", "criteria_changed", "Queued"],
  ["FeatureChangeRequest", "rules_edited", "Eligible"], ["FeatureChangeRequest", "merged", "Accepted"],
  // PBI 366: an item that waits in FeatureChangeRequest more than 5 days times out, as one in SignOff does.
  ["FeatureChangeRequest", "timed_out", "Abandoned"],
];

for (const [from, ev, to] of edges) test(`${from} --${ev}--> ${to}`, () => assert.equal(next(from, ev), to));
test("undrawn edge is null", () => assert.equal(next("Done", "claimed"), null));
test("a returning item never skips the gate", () => assert.equal(next("Abandoned", "ready"), null));
test("answer alone does not move state", () => assert.equal(next("NeedsInput", "ready"), null));
test("a Split item has no way back to the gate", () => {
  for (const ev of ["returned", "policy_changed", "item_edited", "withdrawn", "ready"] as ItemEvent[]) assert.equal(next("Split", ev), null);
});
test("children_done moves only a Split item", () => {
  for (const s of ["NotReady", "Eligible", "Abandoned", "Failed", "Done"] as ItemState[]) assert.equal(next(s, "children_done"), null);
});
test("split_filed moves only a NotReady or Abandoned item", () => {
  for (const s of ["Eligible", "Queued", "Failed", "Done", "Split"] as ItemState[]) assert.equal(next(s, "split_filed"), null);
});
test("override goes anywhere", () => assert.equal(overrideTo("Done", "Queued"), "Queued"));
test("rechecked moves only a Failed item", () => {
  for (const s of ["Accepted", "Abandoned", "Done", "Queued"] as ItemState[]) assert.equal(next(s, "rechecked"), null);
});
test("only a NotReady item takes a rule change approval, and only a Queued or later one a rules edit", () => {
  for (const s of ["Eligible", "Queued", "InProgress", "Abandoned"] as ItemState[]) assert.equal(next(s, "rule_change_approved"), null);
  for (const s of ["NotReady", "Eligible", "Accepted", "Done", "Abandoned"] as ItemState[]) assert.equal(next(s, "rules_edited"), null);
});
test("feature_change_requested moves only an InProgress item", () => {
  for (const s of ["Queued", "SignOff", "NeedsInput", "InReview", "FeatureChangeRequest"] as ItemState[]) assert.equal(next(s, "feature_change_requested"), null);
});
