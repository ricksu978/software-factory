// GET /v1/items/{id} (2026-11-07 design §05): Run detail as JSON, read from Postgres alone. The API holds no GitHub
// credentials, so the criteria and the locked files come from the snapshots the cell API stores with the run (§08).
// Since step 8b (PBI 279) it answers everything the SPA's Run detail shows, as web/src/api.ts's ItemData lays it out:
// the dashboard's own queries in src/http/routes.ts fill the override buttons, Start now, an ended Move, the claim key,
// a Split parent's children, a Failed item's re-check, the CI failure being fixed and the scenario verdicts. The issue's
// body isn't stored, so `scope` is null.
import type pg from "pg";
import { revivable } from "../control/decisions.ts";
import { criteriaWithScenarios, fixingCi, itemStanding, itemTime, verdicts } from "../http/routes.ts";
import { featureChangeRequest } from "../store/feature-change.ts";
import { issueRepos } from "../store/issues.ts";
import { readinessChecks } from "../store/readiness-checks.ts";

type File = { path: string; sha: string; text: string };

/** The item's latest run, its stages, policy results, readiness checks, open question and time, or null for no item. */
export async function itemDetail(pool: pg.Pool, id: string, canOperate: boolean, now: Date, readBlob?: (path: string) => Promise<string | null>) {
  const item = (await pool.query("select id, external_id, title, state, held from item where id = $1", [id])).rows[0];
  if (!item) return null;
  const run = (await pool.query(
    `select id, run_number, sop_version, config_sha, scenarios_sha, features_lock_sha, risk_tier, tier_reasons, next_stage, locked_files,
       acceptance_criteria, pr_number, pr_url, started_at, ended_at, ended_at is null as open
     from run where item_id = $1 order by run_number desc, started_at desc limit 1`, [id],
  )).rows[0] ?? null;
  const stages = run ? (await pool.query(
    `select stage_id, attempt, status, model, effort, tokens_in, tokens_out, started_at, ended_at, cost_usd, message, restates, ci_failure, transcript_ref, report_ref
     from stage_run where run_id = $1 order by started_at`, [run.id],
  )).rows : [];
  const files = run ? (await pool.query<File>("select path, sha, text from run_file where run_id = $1 order by path", [run.id])).rows : [];
  const policies = (await pool.query(
    `select distinct on (file, criterion_index) file, source, criterion, status, reason from policy_result
     where item_id = $1 order by file, criterion_index, at desc`, [id],
  )).rows;
  // A question shows only where a decision can still apply: an item still waiting, or one that timed out waiting.
  const open = (await pool.query("select kind, body, asked_at from question where item_id = $1 and answer is null and closed_at is null order by asked_at desc limit 1", [id])).rows[0] ?? null;
  const waiting = item.state === "SignOff" || item.state === "NeedsInput" || (item.state === "Abandoned" && (await revivable(pool, id)));
  const question = waiting ? open : null;
  // While the sign-off form shows, the owner gets the criteria and the files at the scenarios sha, as today's page.
  const signing: string | null = (item.state === "SignOff" || question?.kind === "sign_off") && run?.scenarios_sha ? run.scenarios_sha : null;
  const at = (sha: string | null) => (sha ? files.filter((f) => f.sha === sha).map(({ path, text }) => ({ path, text })) : []);
  const pending = at(signing);
  return {
    item: { ...item, repo: (await issueRepos(pool, [id])).get(id) ?? null },
    run, stages, files, policies, question,
    readiness: await readinessChecks(pool, id),
    durations: await itemTime(pool, id, item.state, now),
    canOperate,
    criteria: signing && run?.acceptance_criteria ? criteriaWithScenarios(run.acceptance_criteria, pending) : null,
    scope: null,
    pending,
    features: at(run?.features_lock_sha ?? null),
    verdicts: await verdicts({ readBlob }, item.external_id, stages),
    // The API serves every stored transcript at /v1/blobs/{ref}, so each one is a link.
    linkBlobs: true,
    fixingCi: fixingCi(item.state, run, stages),
    // PBI 366: the request the item waits on in FeatureChangeRequest, or null.
    featureChange: await featureChangeRequest(pool, id),
    ...(await itemStanding(pool, id, item.state, canOperate)),
  };
}
