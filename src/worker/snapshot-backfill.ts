// The one-off snapshot backfill (redesign step 4c, PBI 224). Runs that recorded a scenarios sha before the cell API
// stored snapshots have no `run.acceptance_criteria` and no `run_file` rows, so Run detail, which reads only the
// factory's own database, has nothing to show for them. The worker's backfill reads each such run's item from its
// board and each locked file from its repo at the run's scenarios sha, once, and stores them as the cell API would.
// A run that already has `run_file` rows is skipped, so a second backfill changes nothing. A run whose reads fail is
// left unfilled and named in the report, so the next backfill tries it again.
//
// Run it once from the operator's checkout, with the worker's settings: `node src/worker/snapshot-backfill.ts`.
import { App } from "@octokit/app";
import type pg from "pg";
import { loadAppKey } from "../adapters/github/app-key.ts";
import { githubRepoHost } from "../adapters/github/repo-host.ts";
import { TimedOctokit } from "../adapters/github/timed.ts";
import type { BacklogAdapter, RepoHost } from "../adapters/types.ts";
import { githubSources, missing } from "../main.ts";
import { createPool, withTx } from "../store/db.ts";
import { readSnapshot, storeSnapshot } from "../store/run-snapshot.ts";
import { repoName } from "../store/runs.ts";

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

type Pending = { id: string; sha: string; locked_files: string[] | null; source_id: string; external_id: string; repo_url: string | null };

/** Fills the snapshot of every run with a scenarios sha and no `run_file` rows. One run's failure leaves the others. */
export async function backfillSnapshots(d: BackfillDeps): Promise<BackfillReport> {
  const runs = (await d.pool.query<Pending>(
    `select r.id, r.scenarios_sha as sha, r.locked_files, i.source_id, i.external_id, repo.url as repo_url
     from run r join item i on i.id = r.item_id left join repo on repo.id = r.repo_id
     where r.scenarios_sha is not null and not exists (select from run_file f where f.run_id = r.id)
     order by r.started_at`,
  )).rows;
  const report: BackfillReport = { filled: [], unfilled: [] };
  for (const run of runs) {
    try {
      if (!run.repo_url) throw new Error("the run has no repo");
      if (!run.locked_files?.length) throw new Error("the run locked no files");
      const snapshot = await readSnapshot(
        { repoHost: d.repoHost, backlog: d.backlogFor(run.source_id) },
        { repo: repoName(run.repo_url), externalId: run.external_id, sha: run.sha, paths: run.locked_files },
      );
      const stored = await withTx(d.pool, async (c) => {
        // The cell API may have stored a newer snapshot since the select, and that one stands.
        const r = await c.query("select from run where id = $1 and scenarios_sha = $2 and not exists (select from run_file where run_id = $1) for update",
          [run.id, run.sha]);
        if (r.rowCount === 0) return false;
        await storeSnapshot(c, run.id, snapshot);
        return true;
      });
      if (stored) report.filled.push(run.id);
    } catch (e) {
      report.unfilled.push({ runId: run.id, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return report;
}

/** The command: the worker's database, boards and repo host, then one backfill, its report logged. */
export async function main(env: NodeJS.ProcessEnv, log: Pick<Console, "log"> = console): Promise<BackfillReport> {
  loadAppKey(env);
  const need = (name: string) => {
    const v = env[name];
    if (!v) throw new Error(`${name} is not set`);
    return v;
  };
  const [dbUri, appId, appKey] = ["FACTORY_DB_URI", "GITHUB_APP_ID", "GITHUB_APP_KEY"].map(need);
  const pool = createPool(dbUri);
  try {
    const app = new App({ appId, privateKey: appKey, Octokit: TimedOctokit });
    const { sources, installationId } = await githubSources(pool, app, env.GITHUB_PROJECT_TOKEN || null);
    const repoHost = installationId === null ? missing<RepoHost>("no repo is configured") : githubRepoHost(app, installationId);
    const backlogFor = (sourceId: string) => sources.find((s) => s.id === sourceId)?.adapter ?? missing<BacklogAdapter>(`no board for backlog source ${sourceId}`);
    const report = await backfillSnapshots({ pool, repoHost, backlogFor });
    log.log(`The snapshot backfill filled ${report.filled.length} run(s) and couldn't fill ${report.unfilled.length}.`);
    for (const u of report.unfilled) log.log(`  run ${u.runId}: ${u.reason}`);
    return report;
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  main(process.env).then((r) => process.exit(r.unfilled.length ? 1 : 0), (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
