// The PBI state machine (spec §5, plan Task 3). Pure: no I/O, no clock.

export type ItemState =
  | "Eligible" | "NotReady" | "Queued" | "InProgress" | "SignOff" | "NeedsInput"
  | "InReview" | "Accepted" | "Done" | "Failed" | "Abandoned";

export type ItemEvent =
  | "readiness_failed" | "item_edited" | "ready" | "claimed" | "scenarios_written" | "blocked"
  | "pr_opened" | "changes_requested" | "merged" | "approvals_met" | "dod_verified" | "dod_failed"
  | "retries_exhausted" | "timed_out" | "lease_expired" | "usage_limited" | "policy_changed"
  | "requeued" | "reopened_signoff" | "reopened_question" | "criteria_changed" | "withdrawn"
  | "returned";

const edges: [ItemState, ItemEvent, ItemState][] = [
  ["Eligible", "readiness_failed", "NotReady"],
  ["NotReady", "item_edited", "Eligible"],
  ["NotReady", "policy_changed", "Eligible"],
  ["Eligible", "ready", "Queued"],
  ["Queued", "claimed", "InProgress"],
  ["SignOff", "claimed", "InProgress"],
  ["NeedsInput", "claimed", "InProgress"],
  ["InProgress", "scenarios_written", "SignOff"],
  ["InProgress", "blocked", "NeedsInput"],
  ["InProgress", "pr_opened", "InReview"],
  ["InReview", "changes_requested", "Queued"],
  ["InReview", "merged", "Accepted"],
  ["InProgress", "merged", "Accepted"],
  ["InReview", "approvals_met", "Accepted"], // Phase 1. In Phase 0 a person's merge is `merged`.
  ["Accepted", "dod_verified", "Done"],
  ["Accepted", "dod_failed", "Failed"],
  ["InProgress", "retries_exhausted", "Failed"],
  ["NeedsInput", "timed_out", "Abandoned"],
  ["SignOff", "timed_out", "Abandoned"],
  ["InProgress", "lease_expired", "Queued"],
  ["InProgress", "usage_limited", "Queued"],
  ["Failed", "requeued", "Queued"],
  ["Abandoned", "requeued", "Queued"],
  ["Abandoned", "reopened_signoff", "SignOff"],
  ["Abandoned", "reopened_question", "NeedsInput"],
  // Backlog changes (spec §5) reach every state that holds or awaits a run.
  ...(["Queued", "InProgress", "SignOff", "NeedsInput", "InReview"] as const).flatMap(
    (s): [ItemState, ItemEvent, ItemState][] => [[s, "withdrawn", "Abandoned"], [s, "criteria_changed", "Queued"]],
  ),
  // An item that leaves the backlog before it's Queued is withdrawn too, and one withdrawn from either state that gets
  // its label back returns to Eligible, so it meets the readiness gate again (PBI 168). The poller only fires
  // `returned` for such an item: one withdrawn from Queued or later stays gone.
  ["Eligible", "withdrawn", "Abandoned"],
  ["NotReady", "withdrawn", "Abandoned"],
  ["Abandoned", "returned", "Eligible"],
];

const table = new Map(edges.map(([from, event, to]) => [`${from}:${event}`, to]));

/** The state `event` moves an item in `from` to, or null when the diagram draws no such edge. */
export function next(from: ItemState, event: ItemEvent): ItemState | null {
  return table.get(`${from}:${event}`) ?? null;
}

/** An operator override always succeeds. The caller logs it as an override event. */
export function overrideTo(_from: ItemState, to: ItemState): ItemState {
  return to;
}
