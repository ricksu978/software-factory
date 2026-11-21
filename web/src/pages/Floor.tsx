// Floor in the SPA (redesign step 8b): what waits on a person, what's next, the final-stage, not-ready, blocked, split
// and failed items, what's in flight, the factory's banners, and an operator's Controls. Not built yet (PBI 279).
import type { Call, FloorData, FloorProps, Submitted } from "../api.ts";

export function Floor(_props: FloorProps) {
  return null;
}

/** Sends a factory-wide override from Floor's Controls form, and reads the floor again once it's accepted. */
export async function submitFloorControls(_call: Call, _button: string, _reason: string): Promise<Submitted<FloorData>> {
  throw new Error("not built yet (PBI 279)");
}
