// The cell image the worker keeps current with main (PBI 210): the factory's one cell_image row, which the worker writes
// and Floor reads. See src/worker/cell-image.ts for what each commit means.
import type pg from "pg";

/** The factory's one cell_image row. */
export type CellImageState = { started: string; built: string | null; restart: string | null };

/** The row, or null before the worker first started with PBI 210. */
export async function readCellImage(pool: pg.Pool | pg.PoolClient): Promise<CellImageState | null> {
  const r = await pool.query<{ started_commit: string; built_commit: string | null; restart_commit: string | null }>(
    "select started_commit, built_commit, restart_commit from cell_image",
  );
  const row = r.rows[0];
  return row ? { started: row.started_commit, built: row.built_commit, restart: row.restart_commit } : null;
}

/** Records the columns given, keeping the others. The table's unique index on true keeps it to one row. */
export async function writeCellImage(pool: pg.Pool | pg.PoolClient, s: Partial<CellImageState> & { started?: string }): Promise<void> {
  const set = (["started", "built", "restart"] as const).filter((k) => k in s);
  const column = { started: "started_commit", built: "built_commit", restart: "restart_commit" };
  const values = set.map((k) => s[k] ?? null);
  const updated = await pool.query(
    `update cell_image set ${set.map((k, i) => `${column[k]} = $${i + 1}`).join(", ")}, updated_at = now()`,
    values,
  );
  if (updated.rowCount) return;
  if (s.started === undefined) throw new Error("the cell image has no row yet, so its start commit is needed");
  await pool.query(
    "insert into cell_image (started_commit, built_commit, restart_commit) values ($1, $2, $3) on conflict ((true)) do nothing",
    [s.started, s.built ?? null, s.restart ?? null],
  );
}
