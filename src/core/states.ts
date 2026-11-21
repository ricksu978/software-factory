// The PBI state machine (spec §5, plan Task 3). Pure: no I/O, no clock.

export type ItemState =
  | "Eligible" | "NotReady" | "Queued" | "InProgress" | "SignOff" | "NeedsInput"
  | "InReview" | "Accepted" | "Done" | "Failed" | "Abandoned" | "Split";

export type ItemEvent =
  | "readiness_failed" | "item_edited" | "ready" | "claimed" | "scenarios_written" | "blocked"
  | "pr_opened" | "changes_requested" | "merged" | "approvals_met" | "dod_verified" | "dod_failed"
  | "retries_exhausted" | "timed_out" | "lease_expired" | "usage_limited" | "policy_changed"
  | "requeued" | "reopened_signoff" | "reopened_question" | "criteria_changed" | "withdrawn"
  | "returned" | "split_filed" | "children_done" | "rechecked" | "rule_change_approved" | "rules_edited";

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
  // A person may merge the PR while the item waits on a question asked after the PR opened (PBI 194).
  ["NeedsInput", "merged", "Accepted"],
  ["InReview", "approvals_met", "Accepted"], // Phase 1. In Phase 0 a merge is `merged`, a person's or the factory's (PBI 181).
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
  // A parent whose split is filed as child issues, its opt-in label off, rests in Split (PBI 225). The work goes on in
  // the children, so its label coming back or a policy change never gates it again.
  ["NotReady", "split_filed", "Split"],
  // Split's one way out: every child the factory filed for the parent reached Done (PBI 226).
  ["Split", "children_done", "Done"],
  // A parent split before PBI 225 lost its label once its split was filed and was withdrawn from NotReady to Abandoned.
  // Its children carrying their split markers, it moves on to Split, once (PBI 228).
  ["Abandoned", "split_filed", "Split"],
  // A Failed item's re-check finds today's post-merge rules no longer say its merge broke main, so it's Accepted again
  // and waits on main or goes to Done as an Accepted item does (PBI 369).
  ["Failed", "rechecked", "Accepted"],
  // The owner's approval of an item's change to the factory's own rules is a readiness input that changed, so the item
  // waiting for it goes back through the rest of the readiness check (PBI 395).
  ["NotReady", "rule_change_approved", "Eligible"],
  // A Queued or later item whose "Changes the factory's rules" section no longer reads as the owner approved it meets
  // the readiness check again, which leaves it waiting for a new approval, so nothing built from the edit ships (PBI 395).
  ...(["Queued", "InProgress", "SignOff", "NeedsInput", "InReview"] as const).map(
    (s): [ItemState, ItemEvent, ItemState] => [s, "rules_edited", "Eligible"],
  ),
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
