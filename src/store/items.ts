import type pg from "pg";
import { next, type ItemEvent, type ItemState } from "../core/states.ts";
import { runAfterCommit } from "./db.ts";
import { appendEvent, type Actor } from "./events.ts";

export class IllegalTransition extends Error {
  override name = "IllegalTransition";
  constructor(from: ItemState, event: ItemEvent) {
    super(`no edge from ${from} on ${event}`);
  }
}

type Hook = (itemId: string, from: ItemState, to: ItemState, event: ItemEvent) => Promise<void>;
const hooks: Hook[] = [];

/** Registers a hook that runs after each committed transition. Task 12 registers board mirroring (Run contract 8). */
export function onTransition(hook: Hook): void {
  hooks.push(hook);
}

/**
 * Moves an item along one state-machine edge. It writes the state and its event on the caller's transaction,
 * so both commit or neither does, and leaving InProgress fences the old cell (Run contract 2).
 */
export async function transitionItem(c: pg.PoolClient, itemId: string, event: ItemEvent, actor: Actor): Promise<ItemState> {
  const r = await c.query<{ state: ItemState }>("select state from item where id = $1 for update", [itemId]);
  if (r.rowCount === 0) throw new Error(`no item ${itemId}`);
  const from = r.rows[0].state;
  const to = next(from, event);
  if (!to) throw new IllegalTransition(from, event);
  if (from === "InProgress") {
    await c.query("update item set state = $2, lease_generation = lease_generation + 1, lease_owner = null, lease_expires = null where id = $1", [itemId, to]);
  } else {
    await c.query("update item set state = $2 where id = $1", [itemId, to]);
  }
  await appendEvent(c, { ...actor, itemId, kind: "transition", payload: { from, to, event } });
  for (const hook of hooks) runAfterCommit(c, () => hook(itemId, from, to, event));
  return to;
}

export type NewItem = { sourceId: string; externalId: string; title: string };

/** Inserts an item as Eligible, or refreshes its title, keyed on (source_id, external_id). Task 6 widens the input to FactoryItem. */
export async function upsertItem(c: pg.Pool | pg.PoolClient, item: NewItem): Promise<string> {
  const r = await c.query<{ id: string }>(
    `insert into item (source_id, external_id, title, state) values ($1, $2, $3, 'Eligible')
     on conflict (source_id, external_id) do update set title = excluded.title
     returning id`,
    [item.sourceId, item.externalId, item.title],
  );
  return r.rows[0].id;
}
