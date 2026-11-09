// Operator overrides (plan Task 13). A row stays active until it's cleared or expires. The scheduler applies the
// item ones on its next tick, and the cell API's /lease reads pause, kill and stop_run directly.
import type pg from "pg";

export type OverrideKind = "pause" | "resume" | "drain" | "hold" | "unhold" | "stop_run" | "requeue" | "kill" | "restart";
export type Override = {
  id: string; scope: "factory" | "backlog" | "item"; targetId: string | null; kind: OverrideKind;
  reason: string; createdBy: string | null; createdAt: Date; expiresAt: Date | null;
};

/** Records an override. Every override needs a reason, so a blank one throws before anything is written. */
export async function setOverride(
  c: pg.Pool | pg.PoolClient,
  o: { scope: "factory" | "item"; targetId: string | null; kind: OverrideKind; reason: string; createdBy: string; expiresAt: Date | null },
): Promise<void> {
  if (!o.reason.trim()) throw new Error("an override needs a reason");
  if ((o.scope === "item") !== (o.targetId !== null)) throw new Error("an item override names its item, and a factory override names none");
  // resume clears the factory's pause, drain and kill, recording who cleared them, and keeps its own row for the audit trail
  // (spec §8). That row is cleared from the start, so it's never active.
  const resume = o.kind === "resume";
  if (resume) {
    await c.query("update override set cleared_at = now(), cleared_by = $1 where cleared_at is null and scope = 'factory' and kind in ('pause', 'drain', 'kill')", [o.createdBy]);
  }
  await c.query(
    `insert into override (scope, target_id, kind, reason, created_by, expires_at, cleared_at, cleared_by)
     values ($1, $2, $3, $4, $5, $6, case when $7 then now() end, case when $7 then $5::uuid end)`,
    [o.scope, o.targetId, o.kind, o.reason, o.createdBy, o.expiresAt, resume],
  );
}

/** Every override not cleared and not past its expiry at `now`, oldest first. */
export async function activeOverrides(c: pg.Pool | pg.PoolClient, now: Date): Promise<Override[]> {
  const r = await c.query(
    `select id, scope, target_id, kind, reason, created_by, created_at, expires_at from override
     where cleared_at is null and (expires_at is null or expires_at > $1) order by created_at, id`,
    [now],
  );
  return r.rows.map((row) => ({
    id: row.id, scope: row.scope, targetId: row.target_id, kind: row.kind, reason: row.reason,
    createdBy: row.created_by, createdAt: row.created_at, expiresAt: row.expires_at,
  }));
}

/** Clears the item's active overrides of the given kinds, or all of them when `kinds` is omitted. */
export async function clearItemOverrides(c: pg.Pool | pg.PoolClient, itemId: string, kinds?: OverrideKind[]): Promise<void> {
  await c.query(
    "update override set cleared_at = now() where cleared_at is null and scope = 'item' and target_id = $1 and ($2::text[] is null or kind = any($2))",
    [itemId, kinds ?? null],
  );
}

/**
 * Clears a restart override left from before this control plane started, so the restarted factory runs (PBI 140).
 * ponytail: a stub until PBI 140's Green. It clears nothing yet.
 */
export async function clearRestartOnStart(_c: pg.Pool | pg.PoolClient): Promise<void> {}
