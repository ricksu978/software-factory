// PBI 364: the feature change request a cell sends for its run, stored so the item page can show it, and the item's
// move from InProgress to FeatureChangeRequest. Not built yet.
import type pg from "pg";
import type { FeatureChangeFile } from "../core/feature-change.ts";

/** Records the request on `runId`'s item and moves the item from InProgress to FeatureChangeRequest. */
export async function requestFeatureChange(_c: pg.PoolClient, _runId: string, _files: FeatureChangeFile[]): Promise<void> {
  // Not built yet (PBI 364).
}

/** The item's open feature change request, or null when it has none. */
export async function featureChangeRequest(_pool: pg.Pool, _itemId: string): Promise<FeatureChangeFile[] | null> {
  return null; // Not built yet (PBI 364).
}
