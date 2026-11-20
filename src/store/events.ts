import type pg from "pg";

export type Actor = { actor: "agent" | "human" | "system"; actorId: string };

/**
 * Appends one row to the append-only event log, wakes LISTEN factory_events listeners, and returns the event's id. `at`
 * is when it happened, clock_timestamp() when left out as the column's default, so events in one transaction keep
 * their order. The scheduler passes its own clock for what it times by.
 */
export async function appendEvent(c: pg.ClientBase, e: Actor & { itemId: string | null; kind: string; payload: unknown; at?: Date }): Promise<string> {
  const r = await c.query<{ id: string }>(
    "insert into event (actor, actor_id, item_id, kind, payload, at) values ($1, $2, $3, $4, $5, coalesce($6, clock_timestamp())) returning id",
    [e.actor, e.actorId, e.itemId, e.kind, JSON.stringify(e.payload ?? {}), e.at ?? null],
  );
  await c.query("select pg_notify('factory_events', $1)", [JSON.stringify({ id: r.rows[0].id, itemId: e.itemId, kind: e.kind })]);
  return r.rows[0].id;
}
