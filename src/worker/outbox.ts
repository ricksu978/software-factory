// The worker's handling of the outbox (2026-11-07 design, §07 "An outbox in place of hooks"). The worker is the one
// place outbox rows are handled: it mirrors each transition and override onto the item's board, runs each comment
// command and posts each decision's announcement, and removes a row once every effect of it has succeeded. A row
// whose effect fails stays in the outbox, is tried again with backoff, and holds back no other item. After its tenth
// failed attempt it's marked failed and set aside (PBI 221).
import type { FactoryWebhookEvent } from "../adapters/types.ts";
import { mirror, type BoardDeps } from "../control/board.ts";
import type { FeatureChangeFile } from "../core/feature-change.ts";
import { announcement, applyComment, type DecisionKind } from "../control/decisions.ts";
import type { ItemEvent, ItemState } from "../core/states.ts";
import { CONSUMER, type Consumer } from "../store/outbox.ts";
import { acceptedComment } from "../store/rewrites.ts";

export type OutboxDeps = BoardDeps;

/** One outbox row, as the worker reads it. */
export type OutboxRow = { seq: string; consumer: Consumer; eventId: string; itemId: string | null };

/** How often the worker works through the outbox. */
export const OUTBOX_MS = 1_000;

/** A failed row's wait before its next attempt: 30 seconds after the first failure, doubling up to 30 minutes. */
export function backoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(attempts - 1, 0), 30 * 60_000);
}

/** The failed attempts after which a row is marked failed and set aside: it stays in the outbox, and isn't tried again. */
export const MAX_ATTEMPTS = 10;

/**
 * Handles every row that is due, once, and then returns. Rows go in seq order. A row waits while an earlier row for
 * the same item and consumer is still in the outbox and not set aside, so one item's rows run in the order they were
 * written, and a failing one holds back only its own item's later rows. A row that fails is tried again after
 * `backoffMs`, and on its `MAX_ATTEMPTS`th failure it's marked failed and set aside, which lets its item's later rows
 * run. A row written while it works, such as the announcement of a decision a comment command made, is handled in the
 * same pass. Each row is taken with `for no key update skip locked`, so another worker skips it, and recording its
 * effects in `outbox_effect` from another connection doesn't wait on the lock. A row whose seq isn't in
 * `outbox_worker_row` came from a pre-219 process that already acted on it, and is deleted unhandled.
 */
export async function workOutbox(deps: OutboxDeps): Promise<void> {
  // A row a pre-219 process wrote, as one still running while old and new revisions overlap in a swap (§07), was
  // already acted on by that process's own hooks, so it's removed unhandled (db/migrations/016_outbox_cutover.sql).
  await deps.pool.query("delete from outbox o where not exists (select from outbox_worker_row w where w.seq = o.seq)");
  const tried: string[] = [];
  for (;;) {
    const c = await deps.pool.connect();
    let handled = false;
    try {
      await c.query("begin");
      const r = await c.query<{ seq: string; consumer: Consumer; event_id: string; item_id: string | null; attempts: number }>(
        `select o.seq, o.consumer, o.event_id, o.item_id, o.attempts from outbox o
         where o.failed_at is null and o.next_attempt_at <= now() and o.seq <> all($1::bigint[])
           and exists (select from outbox_worker_row w where w.seq = o.seq)
           and not exists (select from outbox p where p.item_id = o.item_id and p.consumer = o.consumer and p.seq < o.seq and p.failed_at is null)
         order by o.seq limit 1 for no key update skip locked`,
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
          const attempts = found.attempts + 1;
          if (attempts >= MAX_ATTEMPTS) {
            console.error(`outbox: the ${row.consumer} row ${row.seq} for item ${row.itemId} failed ${attempts} times, and is marked failed and set aside:`, e);
            await c.query("update outbox set attempts = $2, failed_at = now() where seq = $1", [row.seq, attempts]);
          } else {
            const wait = backoffMs(attempts);
            console.error(`outbox: the ${row.consumer} row ${row.seq} for item ${row.itemId} failed, and is tried again in ${wait / 1000} seconds:`, e);
            await c.query("update outbox set attempts = $2, next_attempt_at = now() + $3 * interval '1 millisecond' where seq = $1", [row.seq, attempts, wait]);
          }
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

type Event = { kind: string; payload: Record<string, unknown>; at: Date };

/**
 * Runs every effect of one row, without removing it. Running a row's effects again, as after a crash before its
 * removal, repeats no effect that already took place: every idempotency key comes from the event id, every text from
 * the event's payload, and a board mirror row's board calls are each recorded against the row once they succeed and
 * skipped after (PBI 220). It throws when any effect failed.
 */
export async function runRowEffects(deps: OutboxDeps, row: OutboxRow): Promise<void> {
  if (!row.itemId) return;
  const event = (await deps.pool.query<Event>("select kind, payload, at from event where id = $1", [row.eventId])).rows[0];
  const item = (await deps.pool.query<{ source_id: string; external_id: string }>(
    "select source_id, external_id from item where id = $1", [row.itemId],
  )).rows[0];
  if (!event || !item) return;
  const p = event.payload;
  if (row.consumer === CONSUMER.boardMirror) {
    const how = event.kind === "override" ? "override" : (p.event as ItemEvent);
    const question = typeof p.question === "string" ? p.question : null;
    const featureChange = Array.isArray(p.featureChange) ? (p.featureChange as FeatureChangeFile[]) : null;
    await mirror(deps, row.itemId, p.to as ItemState, how, { eventId: row.eventId, seq: row.seq, question, featureChange });
  } else if (row.consumer === CONSUMER.decisionAnnouncement) {
    const body = announcement(p.kind as DecisionKind, typeof p.text === "string" ? p.text : "", typeof p.about === "string" ? p.about : undefined);
    await deps.backlogFor(item.source_id).comment(item.external_id, body, `decision:${row.eventId}`);
  } else if (row.consumer === CONSUMER.rewriteAccepted) {
    // PBI 439: the comment for the owner's accepted rewrite, keyed by the proposal, so it's posted once however often
    // the row is tried.
    const login = typeof p.login === "string" ? p.login : "the owner";
    await deps.backlogFor(item.source_id).comment(item.external_id, acceptedComment(login), `rewrite-accepted:${String(p.rewriteId)}`);
  } else if (row.consumer === CONSUMER.commentCommands) {
    const e = p.event as FactoryWebhookEvent;
    if (e?.kind !== "comment") return;
    // Run for the row's own item alone: another board's item with the same number has a row of its own. The event's
    // time bounds which question it answers, so a retried row never answers one asked after the comment was posted.
    await applyComment({ pool: deps.pool, adapter: deps.backlogFor(item.source_id), sourceId: item.source_id, repoHost: deps.repoHost }, { ...e, externalId: item.external_id }, event.at);
  } else {
    throw new Error(`no handler for the outbox consumer ${String(row.consumer)}`);
  }
}
