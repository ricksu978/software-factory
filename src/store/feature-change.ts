// PBI 364: the feature change request a cell sends for its run, stored so the item page can show it, and the item's
// move from InProgress to FeatureChangeRequest.
import type pg from "pg";
import type { FeatureChangeFile } from "../core/feature-change.ts";
import { transitionItem } from "./items.ts";

/**
 * Records the request on `runId`'s item and moves the item from InProgress to FeatureChangeRequest. The transition's
 * payload carries the request, so the worker posts it on the PBI as it stood when the move committed.
 */
export async function requestFeatureChange(c: pg.PoolClient, runId: string, files: FeatureChangeFile[]): Promise<void> {
  const r = await c.query<{ item_id: string }>("update run set feature_change = $2, feature_change_reminders = 0 where id = $1 returning item_id", [runId, JSON.stringify(files)]);
  if (!r.rows[0]) throw new Error(`no run ${runId}`);
  await transitionItem(c, r.rows[0].item_id, "feature_change_requested", { actor: "agent", actorId: runId }, { featureChange: files });
}

/** The item's open feature change request, or null when it has none: the latest run's, while the item waits on it. */
export async function featureChangeRequest(pool: pg.Pool | pg.ClientBase, itemId: string): Promise<FeatureChangeFile[] | null> {
  const r = await pool.query<{ feature_change: FeatureChangeFile[] | null }>(
    `select r.feature_change from item i
     join lateral (select feature_change from run where run.item_id = i.id order by run_number desc, started_at desc limit 1) r on true
     where i.id = $1 and i.state = 'FeatureChangeRequest'`, [itemId]);
  return r.rows[0]?.feature_change ?? null;
}
