// The worker's handling of the outbox (2026-11-07 design, §07 "An outbox in place of hooks"). The worker is the one
// place outbox rows are handled: it mirrors each transition and override onto the item's board, runs each comment
// command and posts each decision's announcement, and removes a row once every effect of it has succeeded. A row
// whose effect fails stays in the outbox and holds back no other item.
import type { BoardDeps } from "../control/board.ts";
import type { Consumer } from "../store/outbox.ts";

export type OutboxDeps = BoardDeps;

/** One outbox row, as the worker reads it. */
export type OutboxRow = { seq: string; consumer: Consumer; eventId: string; itemId: string | null };

/** Handles every row that is due, once, and then returns. */
export async function workOutbox(_deps: OutboxDeps): Promise<void> {
  // PBI 219: not built yet.
}

/**
 * Runs every effect of one row, without removing it. Running a row's effects again, as after a crash before its
 * removal, repeats no effect that already took place.
 */
export async function runRowEffects(_deps: OutboxDeps, _row: OutboxRow): Promise<void> {
  // PBI 219: not built yet.
}
