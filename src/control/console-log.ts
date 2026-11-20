// The control plane's console line for each committed transition (PBI 105), such as
// `item 95: Eligible -> NotReady (readiness_failed)`. transitionItem and overrideItem write it once their transaction
// commits, so a rolled-back transition writes nothing.
import type { ItemEvent, ItemState } from "../core/states.ts";

/** One transition's console line. An operator's move names `override` as its event. */
export function transitionLine(externalId: string, from: ItemState, to: ItemState, event: ItemEvent | "override"): string {
  return `item ${externalId}: ${from} -> ${to} (${event})`;
}
