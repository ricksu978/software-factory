// The control plane's console line for each committed transition (PBI 105), such as
// `item 95: Eligible -> NotReady (readiness_failed)`. It rides on onTransition, as board mirroring does, so a
// rolled-back transition writes nothing.
import type pg from "pg";
import type { ItemEvent, ItemState } from "../core/states.ts";
import { onTransition } from "../store/items.ts";

/** One transition's console line. An operator's move names `override` as its event. */
export function transitionLine(externalId: string, from: ItemState, to: ItemState, event: ItemEvent | "override"): string {
  return `item ${externalId}: ${from} -> ${to} (${event})`;
}

/** Logs every transition committed through deps.pool from here on, and returns the call that stops it. */
export function logTransitions(deps: { pool: pg.Pool; log?: (line: string) => void }): () => void {
  const log = deps.log ?? ((line: string) => console.log(line));
  return onTransition(async (itemId, from, to, event) => {
    const ext = (await deps.pool.query<{ external_id: string }>("select external_id from item where id = $1", [itemId])).rows[0]?.external_id;
    log(transitionLine(ext ?? itemId, from, to, event));
  }, deps.pool);
}
