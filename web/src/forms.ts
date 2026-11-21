// What the SPA's forms send (redesign step 8b), kept free of React so Node's tests call it directly. Each handler takes
// the button pressed, by its text, and the form's field as typed. An override goes to /bff/v1/overrides, and sign-off
// and answers to /bff/v1/items/{id}/decisions. Once the factory accepts it, the handler reads the page's data again.
// An override needs a reason and an answer needs text, so a field left empty or holding only spaces sends nothing, as
// the field's `required` stops the browser sending an empty one.
import { readFloor, readItem, type Call, type DecisionSent, type FloorData, type ItemData, type OverrideSent, type Submitted } from "./api.ts";
import { sentence } from "./lines.ts";

/** Floor's override buttons and the factory-wide kind each sends. */
export const FLOOR_KINDS: Record<string, string> = { Pause: "pause", Drain: "drain", Resume: "resume", "Kill switch": "kill", "Prepare restart": "restart" };

/** Run detail's override buttons and the item kind each sends. */
export const ITEM_KINDS: Record<string, string> = {
  Hold: "hold", "Release the hold": "unhold", "Stop the run": "stop_run", "Re-queue": "requeue", "Start now": "start_now", "Move up": "move_up", "Move down": "move_down",
};

const DECISIONS: Record<string, DecisionSent["kind"]> = { "Approve the scenarios": "approve", "Ask for changes": "changes" };

/** The override buttons that fit an item, in the order today's Run detail offers them. */
export function buttonsFor(c: NonNullable<ItemData["controls"]>): string[] {
  return [
    c.held ? "Release the hold" : "Hold",
    ...(c.stoppable ? ["Stop the run"] : []),
    ...(c.requeueable ? ["Re-queue"] : []),
    ...(c.startable ? ["Start now"] : []),
    ...(c.movable ? ["Move up", "Move down"] : []),
  ];
}

function kindOf<T extends string>(kinds: Record<string, T>, button: string): T {
  const kind = Object.hasOwn(kinds, button) ? kinds[button] : undefined;
  if (!kind) throw new Error(`the form has no "${button}" button`);
  return kind;
}

/** Posts `body` as JSON, then reads the page again once the factory accepts it, or says what the factory said. */
async function send<T>(call: Call, path: string, body: unknown, again: () => Promise<T>): Promise<Submitted<T>> {
  const r = await call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) {
    const error = ((await r.json().catch(() => null)) as { error?: unknown } | null)?.error;
    return { outcome: "failed", message: sentence(typeof error === "string" ? error : `the factory answered ${r.status}`) };
  }
  return { outcome: "accepted", data: await again() };
}

/** Sends a factory-wide override from Floor's Controls form, and reads the floor again once it's accepted. */
export async function submitFloorControls(call: Call, button: string, reason: string): Promise<Submitted<FloorData>> {
  const kind = kindOf(FLOOR_KINDS, button);
  if (!reason.trim()) return { outcome: "refused", field: "Reason" };
  const body: OverrideSent = { kind, reason: reason.trim() };
  return send(call, "/bff/v1/overrides", body, () => readFloor(call));
}

/** Sends an item override from Run detail's Controls form, and reads the item again once it's accepted. */
export async function submitItemControls(call: Call, item: ItemData, button: string, reason: string): Promise<Submitted<ItemData>> {
  const kind = kindOf(ITEM_KINDS, button);
  if (!reason.trim()) return { outcome: "refused", field: "Reason" };
  const body: OverrideSent = { kind, reason: reason.trim(), itemId: item.item.id };
  return send(call, "/bff/v1/overrides", body, () => readItem(call, item.item.id));
}

const decide = (call: Call, item: ItemData, body: DecisionSent) =>
  send(call, `/bff/v1/items/${encodeURIComponent(item.item.id)}/decisions`, body, () => readItem(call, item.item.id));

/** Sends the owner's sign-off decision with their note, which may be empty, and reads the item again once it's accepted. */
export async function submitSignOff(call: Call, item: ItemData, button: string, note: string): Promise<Submitted<ItemData>> {
  return decide(call, item, { kind: kindOf(DECISIONS, button), text: note.trim() });
}

/** Sends the answer to the item's question, and reads the item again once it's accepted. */
export async function submitAnswer(call: Call, item: ItemData, button: string, answer: string): Promise<Submitted<ItemData>> {
  if (button !== "Send the answer") throw new Error(`the form has no "${button}" button`);
  if (!answer.trim()) return { outcome: "refused", field: "Your answer" };
  return decide(call, item, { kind: "answer", text: answer.trim() });
}
