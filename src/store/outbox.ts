// The outbox (2026-11-07 design, §07 "An outbox in place of hooks"). Each row names its consumer, the event that caused
// it and the item it's for, and is written in the same transaction as that event, so both commit or neither does.
// This first part only writes the rows; nothing handles them yet.
import type pg from "pg";

/** The consumers an outbox row can name. */
export const CONSUMER = {
  boardMirror: "board_mirror",
  decisionAnnouncement: "decision_announcement",
  commentCommands: "comment_commands",
} as const;

export type Consumer = (typeof CONSUMER)[keyof typeof CONSUMER];

/** Writes one `consumer` row for `eventId` per item in `itemIds`, on the caller's transaction. Not built yet. */
export async function writeOutboxRows(_c: pg.ClientBase, _consumer: Consumer, _eventId: string, _itemIds: string[]): Promise<void> {}
