import type pg from "pg";

export type Actor = { actor: "agent" | "human" | "system"; actorId: string };

/** Appends one row to the append-only event log and wakes LISTEN factory_events listeners. */
export async function appendEvent(c: pg.ClientBase, e: Actor & { itemId: string | null; kind: string; payload: unknown }): Promise<void> {
  const r = await c.query<{ id: string }>(
    "insert into event (actor, actor_id, item_id, kind, payload) values ($1, $2, $3, $4, $5) returning id",
    [e.actor, e.actorId, e.itemId, e.kind, JSON.stringify(e.payload)],
  );
  await c.query("select pg_notify('factory_events', $1)", [JSON.stringify({ id: r.rows[0].id, itemId: e.itemId, kind: e.kind })]);
}
