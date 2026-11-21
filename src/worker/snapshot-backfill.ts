// The one-off snapshot backfill (redesign step 4c, PBI 224). Runs that recorded a scenarios sha before the cell API
// stored snapshots have no `run.acceptance_criteria` and no `run_file` rows, so Run detail, which reads only the
// factory's own database, has nothing to show for them. The worker's backfill reads each such run's item from its
// board and each locked file from its repo at the run's scenarios sha, once, and stores them as the cell API would.
// A run that already has `run_file` rows is skipped, so a second backfill changes nothing. A run whose reads fail is
// left unfilled and named in the report, so the next backfill tries it again.
import type pg from "pg";
import type { BacklogAdapter, RepoHost } from "../adapters/types.ts";

export type BackfillDeps = {
  pool: pg.Pool;
  repoHost: RepoHost;
  /** The board adapter for an item's backlog source. */
  backlogFor: (sourceId: string) => BacklogAdapter;
};

export type BackfillReport = {
  /** The ids of the runs this backfill filled. */
  filled: string[];
  /** The runs it couldn't fill, each with why. */
  unfilled: { runId: string; reason: string }[];
};

/** Fills the snapshot of every run with a scenarios sha and no `run_file` rows. Stub: fills nothing yet. */
export async function backfillSnapshots(_deps: BackfillDeps): Promise<BackfillReport> {
  return { filled: [], unfilled: [] };
}
