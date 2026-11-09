// The readiness judge's spend, one row per judge call (PBI 132). Run detail and the Phase 0 report read it back.
import type pg from "pg";
import type { JudgeSpend } from "../agent/run.ts";

/** One readiness judge call: what it spent and when it ran. A failed call records what it spent before failing. */
export type ReadinessCheck = JudgeSpend & { ranAt: Date };

/** Records one readiness check against the item's row. */
export async function recordReadinessCheck(_c: pg.Pool | pg.PoolClient, _itemId: string, _check: ReadinessCheck): Promise<void> {
  // ponytail: PBI 132 stub. Nothing is stored yet.
}
