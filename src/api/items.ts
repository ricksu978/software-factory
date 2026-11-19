// GET /v1/items/{id} (2026-11-07 design §05): Run detail as JSON, read from Postgres alone. The API holds no GitHub
// credentials, so the criteria and the locked files come from the snapshots the cell API stores with the run (§08).
import type pg from "pg";
import { revivable } from "../control/decisions.ts";
import { itemTime } from "../http/routes.ts";
import { issueRepos } from "../store/issues.ts";
import { readinessChecks } from "../store/readiness-checks.ts";

/** The item's latest run, its stages, policy results, readiness checks, open question and time, or null for no item. */
export async function itemDetail(pool: pg.Pool, id: string, canOperate: boolean, now: Date) {
  const item = (await pool.query("select id, external_id, title, state, held from item where id = $1", [id])).rows[0];
  if (!item) return null;
  const run = (await pool.query(
    `select id, run_number, sop_version, config_sha, scenarios_sha, features_lock_sha, risk_tier, tier_reasons, next_stage, locked_files,
       acceptance_criteria, pr_number, pr_url, started_at, ended_at
     from run where item_id = $1 order by run_number desc, started_at desc limit 1`, [id],
  )).rows[0] ?? null;
  const stages = run ? (await pool.query(
    `select stage_id, attempt, status, started_at, ended_at, cost_usd, message, transcript_ref, report_ref
     from stage_run where run_id = $1 order by started_at`, [run.id],
  )).rows : [];
  const files = run ? (await pool.query("select path, sha, text from run_file where run_id = $1 order by path", [run.id])).rows : [];
  const policies = (await pool.query(
    `select distinct on (file, criterion_index) file, source, criterion, status, reason from policy_result
     where item_id = $1 order by file, criterion_index, at desc`, [id],
  )).rows;
  // A question shows only where a decision can still apply: an item still waiting, or one that timed out waiting.
  const open = (await pool.query("select kind, body, asked_at from question where item_id = $1 and answer is null and closed_at is null order by asked_at desc limit 1", [id])).rows[0] ?? null;
  const waiting = item.state === "SignOff" || item.state === "NeedsInput" || (item.state === "Abandoned" && (await revivable(pool, id)));
  return {
    item: { ...item, repo: (await issueRepos(pool, [id])).get(id) ?? null },
    run, stages, files, policies,
    question: waiting ? open : null,
    readiness: await readinessChecks(pool, id),
    durations: await itemTime(pool, id, item.state, now),
    canOperate,
  };
}
