// The control plane's console line for each committed transition (PBI 105), such as
// `item 95: Eligible -> NotReady (readiness_failed)`. It rides on onTransition, as board mirroring does, so a
// rolled-back transition writes nothing.
import type pg from "pg";

/** Logs every committed transition from here on, and returns the call that stops it. */
export function logTransitions(_deps: { pool: pg.Pool }): () => void {
  // Red stub (PBI 105): no behaviour yet.
  return () => {};
}
