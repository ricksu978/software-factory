// The worker's heartbeat (redesign §07 "Worker health", step 2c of §12, PBI 158): the factory's one worker_heartbeat row
// holds the time of the worker's latest scheduler tick, so a stopped worker doesn't look like a quiet factory.
import type pg from "pg";

/** Records `at` as the time of the worker's latest tick, replacing any earlier heartbeat, so the table keeps one row. */
export async function recordHeartbeat(c: pg.Pool | pg.PoolClient, at: Date): Promise<void> {
  // The table's unique index is on the constant true, so this conflicts with any row already there.
  await c.query(
    "insert into worker_heartbeat (ticked_at) values ($1) on conflict ((true)) do update set ticked_at = excluded.ticked_at",
    [at],
  );
}
