// The worker's handling of the outbox (2026-11-07 design, §07 "An outbox in place of hooks"). The worker is the one
// place outbox rows are handled: it mirrors each transition and override onto the item's board, runs each comment
// command and posts each decision's announcement, and removes a row once every effect of it has succeeded. A row
// whose effect fails stays in the outbox and holds back no other item.
import type { FactoryWebhookEvent } from "../adapters/types.ts";
import { mirror, type BoardDeps } from "../control/board.ts";
import { announcement, applyComment, type DecisionKind } from "../control/decisions.ts";
import type { ItemEvent, ItemState } from "../core/states.ts";
import { CONSUMER, type Consumer } from "../store/outbox.ts";

export type OutboxDeps = BoardDeps;

/** One outbox row, as the worker reads it. */
export type OutboxRow = { seq: string; consumer: Consumer; eventId: string; itemId: string | null };

/** How often the worker works through the outbox. */
export const OUTBOX_MS = 1_000;

/** A failed row's wait before its next attempt: 30 seconds after the first failure, doubling up to 30 minutes. */
export function backoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(attempts - 1, 0), 30 * 60_000);
}

/**
 * Handles every row that is due, once, and then returns. Rows go in seq order. A row waits while an earlier row for
 * the same item and consumer is still in the outbox, so one item's rows run in the order they were written, and a
 * failed one holds back only its own item's later rows. A row written while it works, such as the announcement of a
 * decision a comment command made, is handled in the same pass. Each row is taken with `for update skip locked`.
 */
export async function workOutbox(deps: OutboxDeps): Promise<void> {
  const tried: string[] = [];
  for (;;) {
    const c = await deps.pool.connect();
    let handled = false;
    try {
      await c.query("begin");
      const r = await c.query<{ seq: string; consumer: Consumer; event_id: string; item_id: string | null; attempts: number }>(
        `select o.seq, o.consumer, o.event_id, o.item_id, o.attempts from outbox o
         where o.failed_at is null and o.next_attempt_at <= now() and o.seq <> all($1::bigint[])
           and not exists (select from outbox p where p.item_id = o.item_id and p.consumer = o.consumer and p.seq < o.seq and p.failed_at is null)
         order by o.seq limit 1 for update skip locked`,
        [tried],
      );
      const found = r.rows[0];
      if (found) {
        handled = true;
        tried.push(found.seq);
        const row: OutboxRow = { seq: found.seq, consumer: found.consumer, eventId: found.event_id, itemId: found.item_id };
        try {
          await runRowEffects(deps, row);
          await c.query("delete from outbox where seq = $1", [row.seq]);
        } catch (e) {
          const wait = backoffMs(found.attempts + 1);
          console.error(`outbox: the ${row.consumer} row ${row.seq} for item ${row.itemId} failed, and is tried again in ${wait / 1000} seconds:`, e);
          await c.query("update outbox set attempts = attempts + 1, next_attempt_at = now() + $2 * interval '1 millisecond' where seq = $1", [row.seq, wait]);
        }
      }
      await c.query("commit");
    } catch (e) {
      await c.query("rollback").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
    if (!handled) return;
  }
}

type Event = { kind: string; payload: Record<string, unknown> };

/**
 * Runs every effect of one row, without removing it. Running a row's effects again, as after a crash before its
 * removal, repeats no effect that already took place: every idempotency key comes from the event id, and every text
 * from the event's payload. It throws when any effect failed.
 */
export async function runRowEffects(deps: OutboxDeps, row: OutboxRow): Promise<void> {
  if (!row.itemId) return;
  const event = (await deps.pool.query<Event>("select kind, payload from event where id = $1", [row.eventId])).rows[0];
  const item = (await deps.pool.query<{ source_id: string; external_id: string }>(
    "select source_id, external_id from item where id = $1", [row.itemId],
  )).rows[0];
  if (!event || !item) return;
  const p = event.payload;
  if (row.consumer === CONSUMER.boardMirror) {
    const how = event.kind === "override" ? "override" : (p.event as ItemEvent);
    const question = typeof p.question === "string" ? p.question : null;
    await mirror(deps, row.itemId, p.to as ItemState, how, { eventId: row.eventId, question });
  } else if (row.consumer === CONSUMER.decisionAnnouncement) {
    const body = announcement(p.kind as DecisionKind, typeof p.text === "string" ? p.text : "");
    await deps.backlogFor(item.source_id).comment(item.external_id, body, `decision:${row.eventId}`);
  } else if (row.consumer === CONSUMER.commentCommands) {
    const e = p.event as FactoryWebhookEvent;
    if (e?.kind !== "comment") return;
    // Run for the row's own item alone: another board's item with the same number has a row of its own.
    await applyComment({ pool: deps.pool, adapter: deps.backlogFor(item.source_id), sourceId: item.source_id }, { ...e, externalId: item.external_id });
  } else {
    throw new Error(`no handler for the outbox consumer ${String(row.consumer)}`);
  }
}
