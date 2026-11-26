// The readiness gate's AI spend, one row per judge or split call (PBI 132). Run detail and the Phase 0 report read it back.
import type pg from "pg";
import type { JudgeSpend } from "../agent/run.ts";
import { assertNamed, type Effort } from "./effort.ts";

/** Which of the gate's AI calls a check was: the readiness judge, or the coding model's split proposal (PBI 143). */
export type ReadinessCheckKind = "judge" | "split";

/**
 * What a judge call decided (PBI 348): passed every dor.md line with no flag, failed with each failed line and the
 * judge's reason and each flag it raised, a reply the gate couldn't read, or an error before the judge replied.
 */
export type CheckVerdict =
  | { outcome: "passed" }
  | { outcome: "failed"; lines: { criterion: string; reason: string }[]; flags: string[] }
  | { outcome: "unreadable" }
  | { outcome: "error" };

/**
 * One readiness gate AI call: which call, what it spent and when it ran. A failed call records what it spent before
 * failing. `kind` defaults to judge. A judge call recorded since PBI 348 has its `verdict`, and `child` is the title of
 * the proposed split child it judged, when the call is recorded against that child's parent. A split call has neither,
 * and neither does a check recorded before PBI 348.
 */
export type ReadinessCheck = JudgeSpend & { kind?: ReadinessCheckKind; ranAt: Date; verdict?: CheckVerdict; child?: string };

/** A readiness check as read back: one recorded before PBI 319 has no effort, and ran at medium. */
export type StoredReadinessCheck = Omit<ReadinessCheck, "effort"> & { effort: Effort | null };

/** Records one readiness check against the item's row. One missing its model or its effort is turned down (PBI 319). */
export async function recordReadinessCheck(c: pg.Pool | pg.PoolClient, itemId: string, check: ReadinessCheck): Promise<void> {
  try {
    assertNamed(check);
  } catch (e) {
    throw new Error(`A ${check.kind ?? "judge"} call's check isn't stored: ${e instanceof Error ? e.message : e}`);
  }
  await c.query(
    "insert into readiness_check (item_id, kind, model, effort, tokens_in, tokens_out, cost_usd, ran_at, verdict, child) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    [itemId, check.kind ?? "judge", check.model, check.effort, check.tokensIn, check.tokensOut, check.costUsd, check.ranAt,
      check.verdict ? JSON.stringify(check.verdict) : null, check.child ?? null],
  );
}

/** The item's readiness checks, oldest first. A check with no verdict or child has no such key. */
export async function readinessChecks(c: pg.Pool | pg.PoolClient, itemId: string): Promise<StoredReadinessCheck[]> {
  const rows = (await c.query<StoredReadinessCheck & { verdict: CheckVerdict | null; child: string | null }>(
    `select kind, model, effort, tokens_in as "tokensIn", tokens_out as "tokensOut", cost_usd::float8 as "costUsd", ran_at as "ranAt", verdict, child
     from readiness_check where item_id = $1 order by ran_at, id`, [itemId],
  )).rows;
  return rows.map(({ verdict, child, ...check }) => ({ ...check, ...(verdict ? { verdict } : {}), ...(child !== null ? { child } : {}) }));
}

/** What every readiness check has cost, across every item, the turned-away ones included. */
export async function readinessSpend(c: pg.Pool | pg.PoolClient): Promise<number> {
  return (await c.query<{ sum: number }>("select coalesce(sum(cost_usd), 0)::float8 as sum from readiness_check")).rows[0].sum;
}
