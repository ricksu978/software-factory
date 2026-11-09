// The readiness judge's spend, one row per judge call (PBI 132). Run detail and the Phase 0 report read it back.
import type pg from "pg";
import type { JudgeSpend } from "../agent/run.ts";

/** One readiness judge call: what it spent and when it ran. A failed call records what it spent before failing. */
export type ReadinessCheck = JudgeSpend & { ranAt: Date };

/** Records one readiness check against the item's row. */
export async function recordReadinessCheck(c: pg.Pool | pg.PoolClient, itemId: string, check: ReadinessCheck): Promise<void> {
  await c.query(
    "insert into readiness_check (item_id, model, tokens_in, tokens_out, cost_usd, ran_at) values ($1, $2, $3, $4, $5, $6)",
    [itemId, check.model, check.tokensIn, check.tokensOut, check.costUsd, check.ranAt],
  );
}

/** The item's readiness checks, oldest first. */
export async function readinessChecks(c: pg.Pool | pg.PoolClient, itemId: string): Promise<ReadinessCheck[]> {
  return (await c.query<ReadinessCheck>(
    `select model, tokens_in as "tokensIn", tokens_out as "tokensOut", cost_usd::float8 as "costUsd", ran_at as "ranAt"
     from readiness_check where item_id = $1 order by ran_at, id`, [itemId],
  )).rows;
}

/** What every readiness check has cost, across every item, the turned-away ones included. */
export async function readinessSpend(c: pg.Pool | pg.PoolClient): Promise<number> {
  return (await c.query<{ sum: number }>("select coalesce(sum(cost_usd), 0)::float8 as sum from readiness_check")).rows[0].sum;
}
