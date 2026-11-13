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
];

for (const [from, ev, to] of edges) test(`${from} --${ev}--> ${to}`, () => assert.equal(next(from, ev), to));
test("undrawn edge is null", () => assert.equal(next("Done", "claimed"), null));
test("a returning item never skips the gate", () => assert.equal(next("Abandoned", "ready"), null));
test("answer alone does not move state", () => assert.equal(next("NeedsInput", "ready"), null));
test("override goes anywhere", () => assert.equal(overrideTo("Done", "Queued"), "Queued"));
