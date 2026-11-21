// Run detail in the SPA (redesign step 8b): the item, where it stands and what its run is pinned to, its stages, time,
// policies, readiness checks and scenario verdicts, the Sign off and Answer forms, and an operator's Controls. Not built
// yet (PBI 279).
import type { Call, ItemData, RunDetailProps, Submitted } from "../api.ts";

export function RunDetail(_props: RunDetailProps) {
  return null;
}

/** Sends an item override from Run detail's Controls form, and reads the item again once it's accepted. */
export async function submitItemControls(_call: Call, _item: ItemData, _button: string, _reason: string): Promise<Submitted<ItemData>> {
  throw new Error("not built yet (PBI 279)");
}

/** Sends the owner's sign-off decision with their note, and reads the item again once it's accepted. */
export async function submitSignOff(_call: Call, _item: ItemData, _button: string, _note: string): Promise<Submitted<ItemData>> {
  throw new Error("not built yet (PBI 279)");
}

/** Sends the answer to the item's question, and reads the item again once it's accepted. */
export async function submitAnswer(_call: Call, _item: ItemData, _button: string, _answer: string): Promise<Submitted<ItemData>> {
  throw new Error("not built yet (PBI 279)");
}
