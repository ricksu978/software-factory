// The outbox (2026-11-07 design, §07 "An outbox in place of hooks"). Each row names its consumer, the event that caused
// it and the item it's for, and is written in the same transaction as that event, so both commit or neither does.
// The worker (src/worker/outbox.ts) handles each row and deletes it once its effect is done.
import type pg from "pg";

/** The consumers an outbox row can name. */
export const CONSUMER = {
  boardMirror: "board_mirror",
  decisionAnnouncement: "decision_announcement",
  commentCommands: "comment_commands",
} as const;

export type Consumer = (typeof CONSUMER)[keyof typeof CONSUMER];

/**
 * Writes one `consumer` row for `eventId` per item in `itemIds`, in that order, on the caller's transaction, so the rows
 * commit or roll back with the event. No items writes no row. Each row's seq is also recorded in `outbox_worker_row`,
 * which sets it apart from a row a pre-219 process writes while old and new revisions overlap
 * (db/migrations/016_outbox_cutover.sql).
 */
export async function writeOutboxRows(c: pg.ClientBase, consumer: Consumer, eventId: string, itemIds: string[]): Promise<void> {
  if (itemIds.length === 0) return;
  await c.query(
    `with o as (insert into outbox (consumer, event_id, item_id) select $1, $2, i.id from unnest($3::uuid[]) with ordinality as i (id, n) order by i.n returning seq)
     insert into outbox_worker_row (seq) select seq from o`,
    [consumer, eventId, itemIds],
  );
}
