// Run detail's snapshot of a run (redesign step 4c, PBI 224): the item's acceptance criteria in
// `run.acceptance_criteria` and each locked file's text at the scenarios sha in `run_file`. The cell API stores it when
// it records a run's scenarios sha, and the worker's one-off backfill stores it for runs from before then, so Run
// detail reads only the factory's own database.
import type pg from "pg";
import type { BacklogAdapter, RepoHost } from "../adapters/types.ts";

export type Snapshot = { sha: string; criteria: string[]; files: { path: string; text: string }[] };

/** Thrown when the board or the repo answers but hasn't got what the snapshot needs. */
export class SnapshotMissing extends Error {}

/**
 * Reads the snapshot of `externalId`'s run at `sha`: the item's criteria as the board holds them now, and each of
 * `paths` in `repo` at `sha`. An item the board doesn't hold, or a file the repo doesn't hold at `sha`, throws
 * SnapshotMissing. A failing read throws its own error.
 */
export async function readSnapshot(
  d: { repoHost: RepoHost; backlog: BacklogAdapter },
  at: { repo: string; externalId: string; sha: string; paths: string[] },
): Promise<Snapshot> {
  const item = await d.backlog.getItem(at.externalId);
  if (!item) throw new SnapshotMissing(`the board holds no item ${at.externalId}`);
  const files = await Promise.all(at.paths.map(async (path) => {
    const text = await d.repoHost.readFile(at.repo, at.sha, path);
    if (text === null) throw new SnapshotMissing(`${at.repo} holds no ${path} at ${at.sha}`);
    return { path, text };
  }));
  return { sha: at.sha, criteria: [...item.acceptanceCriteria], files };
}

/** Stores `s` as `runId`'s snapshot, replacing the run's earlier criteria and files. Run it inside a transaction. */
export async function storeSnapshot(c: pg.ClientBase, runId: string, s: Snapshot): Promise<void> {
  await c.query("update run set acceptance_criteria = $2 where id = $1", [runId, s.criteria]);
  await c.query("delete from run_file where run_id = $1", [runId]);
  if (s.files.length === 0) return;
  await c.query(
    `insert into run_file (run_id, sha, path, text)
     select $1, $2, f.path, f.text from unnest($3::text[], $4::text[]) as f(path, text)`,
    [runId, s.sha, s.files.map((f) => f.path), s.files.map((f) => f.text)],
  );
}
