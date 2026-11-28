// Dashboard routes (plan Task 15): Floor, Run detail, sign-off and answers, overrides, users, the event stream,
// the stored evidence and the Phase 0 exit report.
import type { IncomingMessage, ServerResponse } from "node:http";
import type pg from "pg";
import type { BacklogAdapter, FactoryItem, RepoHost } from "../adapters/types.ts";
import { classify, REGRESSION_TAG } from "../bdd/messages.ts";
import { itemDurations, type Move, type QuestionSpan, type StageSpan } from "../core/durations.ts";
import type { ItemState } from "../core/states.ts";
import type { CiFailure } from "../cell/api-client.ts";
import { decide, decideFeatureChange, FEATURE_CHANGE, revivable, type DecisionKind } from "../control/decisions.ts";
import { issueRepos } from "../store/issues.ts";
import { repoName } from "../store/runs.ts";
import { withTx } from "../store/db.ts";
import { claimKeys, ENDED_BY_BOARD_ORDER, factoryQueue, LEASE_RAN_OUT, moveInQueue, nextUp } from "../store/items.ts";
import { PRODUCTION_LINE_ROWS, twoLists, type ProductionLineRow, type WaitingOnYouRow } from "./floor-lists.ts";
import { readinessChecks, readinessSpend } from "../store/readiness-checks.ts";
import { activeOverrides, setOverride, type OverrideKind } from "../store/overrides.ts";
import { readCellImage } from "../store/cell-image.ts";
import { splitChildren } from "../store/splits.ts";
import { approveRuleChange, latestApproval, ruleChangesChecked, waitsForApproval } from "../store/rule-changes.ts";
import { acceptRewrite, proposedRewrites } from "../store/rewrites.ts";
import { ruleChangesHash } from "../gate/rule-changes.ts";
import { featureChangeRequest } from "../store/feature-change.ts";
import { requireRole, type Auth, type Role } from "./auth.ts";
import { zoneFrom } from "./format.ts";
import { failedOnMain } from "../store/rechecks.ts";
import { BadRequest, readJson, type Handler } from "./server.ts";
import { changeSetting, envSettings, RUNTIME_SETTINGS, runtimeValues } from "./configuration.ts";
import { activityPage, configurationPage, floorPage, noAccessPage, phase0Page, runDetailPage, signInPage, type ActivityRow, type MainBreakRow, type Phase0Row, type Restart, type RunDetail, type Scenario } from "./views.ts";

export type DashboardDeps = {
  pool: pg.Pool;
  auth: Auth;
  /** The dashboard's own origin, such as http://localhost:7400. A POST must carry it as its Origin header. */
  origin: string;
  adapter: BacklogAdapter;
  sourceId: string;
  /** Reads the signed-off feature files for the sign-off view. Without it, that view is left out. */
  repoHost?: RepoHost;
  env?: Record<string, string | undefined>;
  /** Reads a stored transcript or report by its blob path, or null when it's missing. Without it, Run detail shows paths. */
  readBlob?: (path: string) => Promise<string | null>;
  /** The time now: what Run detail's durations count open spells up to (PBI 187), and how long a running stage attempt has taken so far (PBI 189). Defaults to the system clock. */
  now?: () => Date;
  /**
   * PBI 439: what accepting a proposed rewrite on the item page needs. `editBody` writes the accepted text over the
   * item's issue body as the factory, and `recheck` runs the readiness check on the item at once, without waiting for
   * the poller. Without it, no rewrite can be accepted.
   */
  rewrites?: RewriteDeps;
};

export type RewriteDeps = {
  editBody(externalId: string, body: string): Promise<void>;
  recheck(itemId: string): Promise<void>;
};

const FACTORY_KINDS: OverrideKind[] = ["pause", "resume", "drain", "kill", "restart"];
const ITEM_KINDS: OverrideKind[] = ["hold", "unhold", "stop_run", "requeue", "start_now", "move_up", "move_down"];

/**
 * Which of PBI 265's selection overrides an item takes. Start now fits an item that can still be picked up: Eligible,
 * NotReady, Queued, or waiting on a question that's been answered. Move up and Move down fit an item in the factory
 * queue: Queued, or answered.
 */
export async function selectable(pool: pg.Pool, id: string, state: string): Promise<{ startable: boolean; movable: boolean }> {
  let answered = false;
  if (state === "SignOff" || state === "NeedsInput") {
    answered = (await pool.query(
      `select from item i where i.id = $1
         and exists (select from question q where q.item_id = i.id and q.answer is not null)
         and not exists (select from question q where q.item_id = i.id and q.answer is null and q.closed_at is null)`, [id],
    )).rowCount === 1;
  }
  const movable = state === "Queued" || answered;
  return { startable: movable || state === "Eligible" || state === "NotReady", movable };
}
// The paths the cell API hands out: transcripts/<run>/<stage>-<attempt>.jsonl and reports/<run>/<stage>-<attempt>.ndjson.
export const BLOB_PATH = /^\/blobs\/((?:transcripts\/[0-9a-f-]{36}\/[a-z0-9-]+-\d+\.jsonl)|(?:reports\/[0-9a-f-]{36}\/[a-z0-9-]+-\d+\.ndjson))$/;

type User = { id: string; role: Role; product_owner: boolean; github_login: string | null };

function send(res: ServerResponse, status: number, html: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
  res.end(html);
}

const MAX_FORM = 1024 * 1024;

/** A form post or a JSON body, capped at 1 MiB like readJson, so an oversized or broken body is a 4xx. */
async function form(req: IncomingMessage): Promise<Record<string, string>> {
  if ((req.headers["content-type"] ?? "").includes("application/json")) {
    return Object.fromEntries(Object.entries(await readJson(req)).map(([k, v]) => [k, String(v ?? "")]));
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size <= MAX_FORM) chunks.push(chunk as Buffer);
  }
  if (size > MAX_FORM) throw new BadRequest("the body is over 1 MiB", 413);
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
}

/** A banner once the Claude token is within 30 days of its 365-day life, counted from CLAUDE_TOKEN_CREATED_AT. */
export function tokenBanner(env: Record<string, string | undefined>, now = Date.now()): string | null {
  const created = Date.parse(env.CLAUDE_TOKEN_CREATED_AT ?? "");
  if (Number.isNaN(created)) return null;
  const days = Math.floor((created + 365 * 86_400_000 - now) / 86_400_000);
  return days <= 30 ? `The Claude token expires in ${Math.max(days, 0)} days. Make a new one with claude setup-token and update the secret.` : null;
}

export async function floor(pool: pg.Pool) {
  // One row per item, by its oldest open question, counted as the scheduler counts the waiting (Run contract 3). The
  // question shown is that oldest one's.
  const asked = (await pool.query<{ id: string; external_id: string; title: string; state: string; since: Date; question: string }>(
    `select distinct on (i.id) i.id, i.external_id, i.title, i.state, q.asked_at as since, q.body as question from item i
     join question q on q.item_id = i.id and q.answer is null and q.closed_at is null
     where i.state in ('SignOff', 'NeedsInput') order by i.id, q.asked_at, q.id`,
  )).rows;
  const reviews = (await pool.query(
    `select i.id, i.external_id, i.title, i.state, (select max(at) from event e where e.item_id = i.id and e.payload->>'to' = 'InReview') as since,
       r.pr_number, r.pr_url
     from item i left join lateral (select pr_number, pr_url from run where item_id = i.id and ended_at is null order by started_at desc limit 1) r on true
     where i.state = 'InReview'`,
  )).rows;
  // PBI 366: an item in FeatureChangeRequest waits on the Product Owner from its move there, with no question asked.
  const featureChanges = (await pool.query(
    `select i.id, i.external_id, i.title, i.state, true as feature_change,
       (select max(at) from event e where e.item_id = i.id and e.kind = 'transition' and e.payload->>'to' = 'FeatureChangeRequest') as since
     from item i where i.state = 'FeatureChangeRequest'`,
  )).rows;
  const capacity = (await pool.query<{ review_capacity: number }>("select review_capacity from wip_policy limit 1")).rows[0]?.review_capacity ?? 3;
  // An engine rule or a judge flag is stored at index 0 with its explanation in reason, as the gate's comment reads it.
  // A Not ready item waits from its last move to NotReady, or else from the gate's verdict.
  const notReady = (await pool.query<{ id: string; external_id: string; title: string; state: string; failed: string[]; since: Date | null }>(
    `select i.id, i.external_id, i.title, i.state, coalesce(array_agg(case when p.criterion_index > 0 then p.criterion else p.reason end order by p.criterion_index)
       filter (where p.id is not null), '{}') as failed,
       coalesce((select max(e.at) from event e where e.item_id = i.id and e.kind in ('transition', 'override') and e.payload->>'to' = 'NotReady'), max(p.at)) as since
     from item i left join policy_result p on p.item_id = i.id and p.file = 'dor' and p.status = 'failed'
       and p.at = (select max(at) from policy_result where item_id = i.id and file = 'dor')
     where i.state = 'NotReady' group by i.id`,
  )).rows;
  // PBI 215: items waiting on a question that says the base fails in the cell, for Floor's notice.
  const baseFails = (await pool.query<{ id: string; external_id: string; title: string; sha: string; tests: string[] }>(
    `select i.id, i.external_id, i.title, q.base_failure->>'sha' as sha,
       coalesce((select array_agg(t) from jsonb_array_elements_text(q.base_failure->'tests') t), '{}') as tests
     from item i join question q on q.item_id = i.id and q.answer is null and q.closed_at is null and q.base_failure is not null
     where i.state = 'NeedsInput' order by q.asked_at`,
  )).rows;
  // PBI 255: each break on main that still stands, with the item it charged and its bug item, for Floor's notice.
  const mainBreaks = (await pool.query<{ branch: string; sha: string; repo_url: string; pr_number: number | null; charged: string | null; bug_external_id: string | null; bug_id: string | null; bug_title: string | null; bug_state: string | null }>(
    `select b.branch, b.merge_sha as sha, repo.url as repo_url, b.pr_number, charged.external_id as charged, b.bug_external_id, bug.id as bug_id, bug.title as bug_title, bug.state as bug_state
     from main_break b join repo on repo.id = b.repo_id left join item charged on charged.id = b.item_id left join item bug on bug.id = b.bug_item_id
     where b.cleared_at is null order by b.at`,
  )).rows.map(({ repo_url, ...b }): MainBreakRow => ({ ...b, repo: repoName(repo_url) }));
  const overrides = await activeOverrides(pool, new Date());
  const overridden = new Set(overrides.filter((o) => o.scope === "item").map((o) => o.targetId));
  const badges = (r: { id: string; held: boolean }) => [...(r.held ? ["held"] : []), ...(overridden.has(r.id) ? ["override"] : [])];
  // PBI 292: an item In progress whose run's newest attempt is a Green attempt sent back to fix a CI failure is fixing
  // CI, with the commit CI failed on and the failed checks.
  // The last agent message is the newest non-empty one the open run's stages sent (the cell API cuts it to 500). The
  // factory's own note on an attempt it closed (PBI 239) isn't an agent message, so Floor skips it; Run detail shows it.
  const active = (await pool.query(
    `select i.id, i.external_id, i.title, i.state, i.held, r.next_stage as stage, r.pr_number, r.pr_url,
       (select max(started_at) from stage_run s where s.run_id = r.id) as since,
       coalesce((select sum(cost_usd) from stage_run s where s.run_id = r.id), 0)::text as cost,
       (select message from stage_run s where s.run_id = r.id and message <> '' and message <> $1 order by ended_at desc nulls last, started_at desc limit 1) as message,
       (select case when s.stage_id = 'green' then s.ci_failure end from stage_run s
         where s.run_id = r.id order by s.started_at desc, s.attempt desc limit 1) as ci_failure
     from item i left join lateral (select * from run where item_id = i.id and ended_at is null order by started_at desc limit 1) r on true
     where i.state = 'InProgress' order by i.title`,
    [LEASE_RAN_OUT],
  )).rows.map(({ held, ...a }) => ({ ...a, badges: badges({ id: a.id, held }), waitsOn: [] as string[] }));
  const factory = overrides.filter((o) => o.scope === "factory").map((o) => ({ kind: o.kind, reason: o.reason }));
  // A restart being prepared (PBI 140) and a drain (PBI 316) both show how many cells still hold a live lease, counted
  // once so the two lines agree. None is stopped (PBI 300).
  const prepared = overrides.find((o) => o.scope === "factory" && o.kind === "restart");
  const draining = factory.some((o) => o.kind === "drain");
  const running = prepared || draining
    ? (await pool.query<{ n: number }>("select count(*)::int as n from item where state = 'InProgress' and lease_expires > now()")).rows[0].n
    : undefined;
  const restart: Restart | null = prepared ? { running: running!, reason: prepared.reason } : null;
  // The claimable items come from the claim's own query, so Production Line can't show an order the claim doesn't
  // take. It applies the same brake the scheduler does: at capacity, only work already in flight starts.
  const waitingCount = asked.length + featureChanges.length + reviews.length;
  const queue = await factoryQueue(pool);
  const claimable = await nextUp(pool, PRODUCTION_LINE_ROWS, { resumeOnly: waitingCount >= capacity });
  // PBI 320: each item's priority and group, an item in the group through a dependent included.
  const keys = await claimKeys(pool);
  // PBI 369: each item that failed its Definition of Done on main, since its move to Failed, and when the factory
  // last re-checked it.
  const failed = await failedOnMain(pool);
  // PBI 430: each split child the factory holds, with the parent it's part of.
  const parents = new Map((await pool.query<{ child: string; id: string; external_id: string }>(
    `select c.id as child, p.id, p.external_id from split_child sc join item p on p.id = sc.parent_id
     join item c on c.source_id = p.source_id and c.external_id = sc.external_id`,
  )).rows.map((r) => [r.child, { id: r.id, external_id: r.external_id }]));
  const repos = await issueRepos(pool, [...asked, ...featureChanges, ...reviews, ...notReady, ...active, ...queue, ...baseFails, ...failed].map((r) => r.id));
  const withRepo = <T extends { id: string }>(rows: T[]) => rows.map((r) => ({ ...r, repo: repos.get(r.id) ?? null }));
  const part = (id: string) => parents.get(id) ?? null;
  const waiting: Omit<WaitingOnYouRow, "repo">[] = [
    ...asked.map((r) => ({ ...r, why: r.state === "SignOff" ? "sign-off" as const : "question" as const, partOf: part(r.id) })),
    ...reviews.map((r) => ({ ...r, why: "review" as const, partOf: part(r.id) })),
    ...featureChanges.map((r) => ({ ...r, why: "feature-change" as const, partOf: part(r.id) })),
    ...notReady.map((r) => ({ ...r, why: "not-ready" as const, partOf: part(r.id) })),
    ...failed.map(({ failed_at, ...f }) => ({ ...f, state: "Failed", since: failed_at, why: "failed-on-main" as const, partOf: part(f.id) })),
  ];
  const queued = (r: (typeof queue)[number]): Omit<ProductionLineRow, "repo"> => ({
    id: r.id, external_id: r.external_id, title: r.title, state: r.state, stage: null, since: null, cost: null, message: null, ci_failure: null,
    badges: badges(r), waitsOn: r.blocked_by, partOf: part(r.id),
  });
  const inQueue = new Map(queue.map((r) => [r.id, r]));
  const lists = twoLists({
    waiting: withRepo(waiting),
    inProgress: withRepo(active.map((a) => ({ ...a, partOf: part(a.id) }))),
    claimable: withRepo(claimable.flatMap((c) => (inQueue.has(c.id) ? [queued(inQueue.get(c.id)!)] : []))),
    queue: withRepo(queue.map(queued)),
  });
  return {
    ...lists, waitingCount, capacity, factory, keys,
    baseFails: withRepo(baseFails), mainBreaks,
    restart, running, cellImage: await readCellImage(pool),
  };
}

/**
 * The item's own scenarios with their verdict in the latest red and the latest green report, read from the stored
 * reports with classify. A report that's gone leaves its column empty.
 */
export async function verdicts(deps: { readBlob?: (path: string) => Promise<string | null> }, externalId: string, stages: { stage_id: string; report_ref: string | null }[]): Promise<RunDetail["verdicts"]> {
  if (!deps.readBlob) return [];
  const tag = `@pbi-${externalId}`;
  const byName = new Map<string, { red: string; green: string }>();
  for (const stage of ["red", "green"] as const) {
    const ref = stages.filter((s) => s.stage_id === stage && s.report_ref).at(-1)?.report_ref;
    const text = ref ? await deps.readBlob(ref) : null;
    for (const r of text ? classify(text).values() : []) {
      if (!r.tags.includes(tag)) continue;
      const row = byName.get(r.name) ?? { red: "", green: "" };
      row[stage] = r.verdict;
      byName.set(r.name, row);
    }
  }
  return [...byName].map(([name, v]) => ({ name, ...v }));
}

/**
 * Spec §13's Phase 0 exit measure from this database: every run with a merge sha, oldest merge first. A run's merge
 * date is the item's first move to Accepted after the run started, and its cost is its own stage runs' sum.
 */
export async function phase0(pool: pg.Pool): Promise<Phase0Row[]> {
  const rows = (await pool.query<Omit<Phase0Row, "repo">>(
    `select * from (
       select i.id as item_id, i.external_id, i.title, r.pr_url, r.risk_tier, r.tier_reasons,
         (select min(e.at) from event e where e.item_id = r.item_id and e.kind = 'transition' and e.payload->>'to' = 'Accepted' and e.at >= r.started_at) as merged_at,
         coalesce((select sum(s.cost_usd) from stage_run s where s.run_id = r.id), 0)::float8 as cost
       from run r join item i on i.id = r.item_id where r.merge_sha is not null) m
     order by merged_at nulls last`,
  )).rows;
  const repos = await issueRepos(pool, rows.map((r) => r.item_id));
  return rows.map((r) => ({ ...r, repo: repos.get(r.item_id) ?? null }));
}

/**
 * The 100 newest events, newest first, for the activity log (PBI 105). Only `from`, `to` and `event` leave the
 * payload, so a decision's text or a readiness detail never reaches the page. A setting change (PBI 175) also gives its
 * setting, and its reason (PBI 176), which an operator wrote for everyone to read. A factory-wide event has no item.
 */
export async function activity(pool: pg.Pool): Promise<ActivityRow[]> {
  const rows = (await pool.query<Omit<ActivityRow, "repo"> & { item_id: string | null }>(
    `select e.at, i.id as item_id, i.external_id, i.title, e.kind, e.payload->>'from' as "from", e.payload->>'to' as "to", e.payload->>'event' as event,
       coalesce(u.github_login, e.actor_id) as actor, e.payload->>'setting' as setting,
       case when e.kind = 'setting' then e.payload->>'reason' end as reason
     from event e left join item i on i.id = e.item_id
       left join "user" u on e.kind = 'setting' and u.id::text = e.actor_id
     order by e.at desc, e.id desc limit 100`,
  )).rows;
  const repos = await issueRepos(pool, [...new Set(rows.flatMap((r) => (r.item_id ? [r.item_id] : [])))]);
  return rows.map(({ item_id, ...r }) => ({ ...r, repo: item_id ? (repos.get(item_id) ?? null) : null }));
}

/**
 * Acceptance criteria with the scenarios tagged @ac-N under each, parsed from the feature files already read at the
 * scenarios sha, so each file costs one read for both the criteria list and its full text. A scenario carrying
 * @regression, itself or through its feature, is marked, since Red expects it to pass.
 */
function criteriaView(deps: DashboardDeps, fi: FactoryItem | null, files: RunDetail["features"]): RunDetail["criteria"] {
  if (!fi || !deps.repoHost || !fi.repo) return null;
  return criteriaWithScenarios(fi.acceptanceCriteria, files);
}

/** Each acceptance criterion, in order, with the scenarios the feature files tag @ac-N for it, the Nth criterion. */
export function criteriaWithScenarios(acceptanceCriteria: string[], files: RunDetail["features"]): NonNullable<RunDetail["criteria"]> {
  const byAc = new Map<number, Scenario[]>();
  for (const { text } of files) {
    let tags: string[] = [];
    let featureTags: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (t.startsWith("@")) tags.push(...t.split(/\s+/));
      else if (/^Feature:/.test(t)) {
        featureTags = tags;
        tags = [];
      } else if (/^Scenario( Outline)?:/.test(t)) {
        const scenario = { name: t.replace(/^Scenario( Outline)?:\s*/, ""), regression: [...featureTags, ...tags].includes(REGRESSION_TAG) };
        for (const tag of tags) {
          const n = /^@ac-(\d+)$/.exec(tag)?.[1];
          if (n) byAc.set(Number(n), [...(byAc.get(Number(n)) ?? []), scenario]);
        }
        tags = [];
      } else if (t && !t.startsWith("#")) tags = [];
    }
  }
  return acceptanceCriteria.map((criterion, i) => ({ criterion, scenarios: byAc.get(i + 1) ?? [] }));
}

/** The item's feature files as they stand at `sha`: the lock sha once signed off, the scenarios sha while waiting. */
async function featuresAt(deps: DashboardDeps, fi: FactoryItem | null, sha: string, files: string[]): Promise<RunDetail["features"]> {
  if (!fi?.repo || !deps.repoHost) return [];
  const out: RunDetail["features"] = [];
  for (const path of files) out.push({ path, text: (await deps.repoHost.readFile(fi.repo, sha, path)) ?? "(missing at this commit)" });
  return out;
}

/**
 * PBI 292: the CI failure the item is fixing, while it's In progress on an open run whose newest attempt is a Green
 * attempt the cell reported as fixing one. Null otherwise.
 */
export function fixingCi(state: string, run: { open?: boolean } | null, stages: { stage_id: string; attempt: number; started_at?: Date; ci_failure?: CiFailure | null }[]): CiFailure | null {
  if (state !== "InProgress" || !run?.open) return null;
  const newest = stages.reduce<(typeof stages)[number] | null>((a, s) =>
    !a || (s.started_at?.getTime() ?? 0) > (a.started_at?.getTime() ?? 0) || ((s.started_at?.getTime() ?? 0) === (a.started_at?.getTime() ?? 0) && s.attempt > a.attempt) ? s : a, null);
  return newest?.stage_id === "green" ? newest.ci_failure ?? null : null;
}

/**
 * PBI 395: the rule changes the item's last readiness check read, whether the item waits for the owner's approval of
 * them, the approval that matches them as they read now, and whether this viewer may approve. Null when it read none.
 */
export async function ruleChangesOf(pool: pg.Pool, id: string, isOwner: boolean): Promise<RunDetail["ruleChanges"]> {
  const changes = await ruleChangesChecked(pool, id);
  if (!changes?.length) return null;
  const waiting = await waitsForApproval(pool, id);
  const approval = await latestApproval(pool, id);
  return {
    changes, waiting, canApprove: waiting && isOwner,
    approval: approval && approval.rulesHash === ruleChangesHash(changes) ? { by: approval.by, at: approval.at } : null,
  };
}

/** PBI 439: the rewrite proposed for the item that stands, and whether this viewer may accept it. Null when none does. */
async function rewriteOf(pool: pg.Pool, id: string, canAccept: boolean): Promise<RunDetail["rewrite"]> {
  const p = (await proposedRewrites(pool, id)).at(-1);
  return p ? { id: p.id, current: p.current, body: p.body, canAccept } : null;
}

/**
 * PBI 439: the owner accepts the rewrite proposed for the item. In one transaction the proposal is accepted, with the
 * owner's approval of a rules section it adds or changes and the outbox row the worker posts the acceptance's comment
 * from, retrying it until it's posted, and the issue's body is edited to it, so a failed edit accepts nothing. An edit
 * that lands under a transaction that then fails to commit leaves the proposal standing with the issue reading its
 * body: the poller neither withdraws it, nor moves the item out of NotReady, nor asks for a rewrite of that text, so
 * the owner's retry accepts it without editing again. Then the readiness check runs at once.
 */
async function acceptance(deps: DashboardDeps, rw: RewriteDeps, a: { itemId: string; rewriteId: string; user: User; login: string }):
  Promise<{ status: number; text: string }> {
  const item = (await deps.pool.query<{ external_id: string }>("select external_id from item where id = $1", [a.itemId])).rows[0];
  if (!item) return { status: 404, text: "No such item." };
  const fi = await deps.adapter.getItem(item.external_id);
  if (!fi) return { status: 404, text: "The item's issue isn't on the board." };
  const at = (deps.now ?? (() => new Date()))();
  const out = await withTx(deps.pool, async (c) => {
    const r = await acceptRewrite(c, { itemId: a.itemId, rewriteId: a.rewriteId, userId: a.user.id, login: a.login, at, issueBody: fi.body });
    if (r.outcome === "accepted" && r.edit) await rw.editBody(item.external_id, r.rewrite.body);
    return r;
  });
  if (out.outcome === "unknown") return { status: 404, text: "No such proposed rewrite." };
  if (out.outcome === "withdrawn") return { status: 409, text: "That proposed rewrite was withdrawn by an edit to the item." };
  if (out.outcome === "edited") return { status: 409, text: "The item was edited since the rewrite was proposed, so the proposal is withdrawn." };
  if (out.outcome === "accepted_already") return { status: 409, text: "That proposed rewrite was accepted already." };
  if (out.outcome === "not_waiting") return { status: 409, text: "That item isn't waiting in NotReady, so it takes no rewrite." };
  await rw.recheck(a.itemId);
  return { status: 303, text: "" };
}

async function runDetail(deps: DashboardDeps, id: string, canOperate: boolean, isOwner = false, productOwner = false): Promise<RunDetail | null> {
  const { pool } = deps;
  const item = (await pool.query("select id, title, state, external_id from item where id = $1", [id])).rows[0];
  if (!item) return null;
  const run = (await pool.query(
    `select id, sop_version, config_sha, scenarios_sha, features_lock_sha, risk_tier, tier_reasons, next_stage, locked_files,
       pr_number, pr_url, ended_at is null as open
     from run where item_id = $1 order by run_number desc, started_at desc limit 1`, [id],
  )).rows[0] ?? null;
  const policies = (await pool.query(
    `select distinct on (file, criterion_index) file, source, criterion, status, reason from policy_result
     where item_id = $1 order by file, criterion_index, at desc`, [id],
  )).rows;
  const stages = run ? (await pool.query("select * from stage_run where run_id = $1 order by started_at", [run.id])).rows : [];
  // A form shows only where a decision can still apply: an item still waiting, or one that timed out waiting.
  const open = (await pool.query("select kind, body from question where item_id = $1 and answer is null and closed_at is null order by asked_at desc limit 1", [id])).rows[0] ?? null;
  const waiting = item.state === "SignOff" || item.state === "NeedsInput" || (item.state === "Abandoned" && (await revivable(pool, id)));
  const question = waiting ? open : null;
  // While the sign-off form shows, the owner gets the criteria, the issue's body and the files at the scenarios sha.
  const signing: string | null = (item.state === "SignOff" || question?.kind === "sign_off") && run?.scenarios_sha ? run.scenarios_sha : null;
  const fi = signing || run?.features_lock_sha ? await deps.adapter.getItem(item.external_id) : null;
  const pending = signing ? await featuresAt(deps, fi, signing, run.locked_files ?? []) : [];
  const criteria = signing ? criteriaView(deps, fi, pending) : null;
  const scope = signing && fi?.body.trim() ? fi.body : null;
  const features = run?.features_lock_sha ? await featuresAt(deps, fi, run.features_lock_sha, run.locked_files ?? []) : [];
  return {
    item: { ...item, repo: (await issueRepos(pool, [id])).get(id) ?? null }, run, policies, stages, readiness: await readinessChecks(pool, id), question, criteria, scope, pending, features,
    verdicts: await verdicts(deps, item.external_id, stages), linkBlobs: Boolean(deps.readBlob),
    fixingCi: fixingCi(item.state, run, stages),
    durations: await itemTime(pool, id, item.state, (deps.now ?? (() => new Date()))()),
    ruleChanges: await ruleChangesOf(pool, id, isOwner),
    rewrite: item.state === "NotReady" ? await rewriteOf(pool, id, isOwner && !!deps.rewrites) : null,
    featureChange: await featureChangeRequest(pool, id),
    // PBI 365: only the Product Owner decides on a feature change request, as at sign-off.
    canDecideFeatureChange: productOwner,
    featureChangeDecision: await featureChangeDecision(pool, id),
    ...(await itemStanding(pool, id, item.state, canOperate)),
  };
}

/** PBI 365: the latest decision on a feature change request of the item, with who made it and when, or null. */
async function featureChangeDecision(pool: pg.Pool, id: string): Promise<{ kind: "approve" | "changes"; by: string; at: Date } | null> {
  return (await pool.query<{ kind: "approve" | "changes"; by: string; at: Date }>(
    `select e.payload->>'kind' as kind, coalesce(u.github_login, u.email, u.subject) as by, e.at from event e
     left join "user" u on u.id::text = e.actor_id
     where e.item_id = $1 and e.kind = 'decision' and e.payload->>'about' = $2 order by e.at desc limit 1`, [id, FEATURE_CHANGE],
  )).rows[0] ?? null;
}

/**
 * Where an item stands, for Run detail on today's dashboard and in the API (redesign step 8b): an operator's override
 * buttons, or null for anyone else, its Start now and a Move the board's order ended, which anyone sees, its claim key,
 * a Split parent's children and a Failed item's last re-check.
 */
export async function itemStanding(pool: pg.Pool, id: string, state: string, canOperate: boolean) {
  const held = (await pool.query<{ held: boolean }>("select held from item where id = $1", [id])).rows[0].held;
  // An active Start now shows to anyone who opens the page (PBI 265).
  const startNow = (await pool.query<{ reason: string; by: string | null }>(
    `select o.reason, u.github_login as by from override o left join "user" u on u.id = o.created_by
     where o.scope = 'item' and o.target_id = $1 and o.kind = 'start_now' and o.cleared_at is null and (o.expires_at is null or o.expires_at > now())
     order by o.created_at desc limit 1`, [id],
  )).rows[0] ?? null;
  // PBI 311: the item's latest Move up or Move down, when the board's order ended it, shows to anyone who opens the page.
  const latestMove = (await pool.query<{ kind: "move_up" | "move_down"; cleared_at: Date | null; cleared_cause: string | null }>(
    `select kind, cleared_at, cleared_cause from override where scope = 'item' and target_id = $1 and kind in ('move_up', 'move_down')
     order by created_at desc, id desc limit 1`, [id],
  )).rows[0];
  const moveEnded = latestMove?.cleared_at && latestMove.cleared_cause === ENDED_BY_BOARD_ORDER
    ? { control: latestMove.kind === "move_up" ? "Move up" as const : "Move down" as const, at: latestMove.cleared_at }
    : null;
  const claim = (await claimKeys(pool, [id])).get(id) ?? null;
  return {
    controls: canOperate
      ? { held, stoppable: state === "InProgress", requeueable: state === "Failed" || state === "Abandoned", ...(await selectable(pool, id, state)) }
      : null,
    startNow,
    moveEnded,
    claim,
    splitInto: (await splitChildren(pool, [id])).get(id) ?? [],
    recheck: await recheckOf(pool, id, state),
  };
}

/** PBI 369: when a Failed item that failed its Definition of Done on main was last re-checked. Null for any other item. */
async function recheckOf(pool: pg.Pool, id: string, state: string): Promise<RunDetail["recheck"]> {
  if (state !== "Failed") return null;
  const row = (await failedOnMain(pool, id))[0];
  return row ? { last: row.rechecked } : null;
}

/** Where the item's time went (PBI 187): its moves, every run's stage attempts and its questions, read up to `now`. */
export async function itemTime(pool: pg.Pool, id: string, state: ItemState, now: Date) {
  // An item held from before issue_created_at was stored counts from its first logged event until a poll fills it in.
  const createdAt = (await pool.query<{ at: Date | null }>(
    "select coalesce(issue_created_at, (select min(at) from event where item_id = $1)) as at from item where id = $1", [id],
  )).rows[0].at;
  const moves = (await pool.query<Move>(
    `select payload->>'from' as from, payload->>'to' as to, at from event
     where item_id = $1 and kind in ('transition', 'override') and payload ? 'to' order by at, id`, [id],
  )).rows;
  const stages = (await pool.query<StageSpan>(
    `select s.stage_id as "stageId", s.started_at as "startedAt", s.ended_at as "endedAt", r.ended_at as "runEndedAt"
     from stage_run s join run r on r.id = s.run_id where r.item_id = $1 order by s.started_at`, [id],
  )).rows;
  const questions = (await pool.query<QuestionSpan>(
    `select kind, asked_at as "askedAt", answered_at as "answeredAt", closed_at as "closedAt" from question where item_id = $1`, [id],
  )).rows;
  return itemDurations({ createdAt, state, now, moves, stages, questions });
}

/**
 * Server-sent events for every open dashboard, fed by one LISTEN factory_events client the streams share, so open
 * tabs never hold more than one pool connection. `close` releases it.
 */
function eventStreams(pool: pg.Pool) {
  const streams = new Set<ServerResponse>();
  let listener: Promise<pg.PoolClient> | null = null;
  const listen = () =>
    (listener ??= (async () => {
      const c = await pool.connect();
      c.on("notification", (m) => {
        if (m.channel === "factory_events") for (const s of streams) s.write(`data: ${m.payload ?? "{}"}\n\n`);
      });
      // A checked-out client has no pool error handler, so a dropped connection would otherwise crash the process.
      // Drop the dead client and end the open streams: each browser's EventSource reconnects and LISTENs again.
      c.on("error", (e) => {
        console.error("dashboard event listener lost its connection:", e.message);
        listener = null;
        c.release(true);
        for (const s of streams) s.end();
        streams.clear();
      });
      try {
        await c.query("listen factory_events");
      } catch (e) {
        c.release(true);
        listener = null;
        throw e;
      }
      return c;
    })());
  return {
    async open(req: IncomingMessage, res: ServerResponse): Promise<void> {
      // Listen first, so no event is missed between the stream opening and the LISTEN taking effect.
      await listen();
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      // Node holds headers until the first write, so a comment line opens the stream at once.
      res.write(": open\n\n");
      streams.add(res);
      req.on("close", () => streams.delete(res));
    },
    async close(): Promise<void> {
      for (const s of streams) s.end();
      streams.clear();
      const c = await listener;
      listener = null;
      c?.release(true);
    },
  };
}

/**
 * The dashboard as one handler. Anything under /webhooks, /internal or /probe belongs to other handlers. Those
 * checks, and sign-in, use the raw path: a path whose dot segments or encoding normalise to something else is
 * refused, so no request can pass as a webhook to a proxy and land on a dashboard route here (Review Focus 4).
 */
export function dashboardRoutes(deps: DashboardDeps): Handler & { close(): Promise<void> } {
  // A copy taken now, so the Configuration page shows the env the control plane started with.
  const env = { ...(deps.env ?? process.env) };
  const streams = eventStreams(deps.pool);
  const handler: Handler = async (req, res) => {
    const raw = (req.url ?? "/").split("?")[0];
    const url = new URL(req.url ?? "/", deps.origin);
    const path = url.pathname;
    if (raw.startsWith("/webhooks") || raw.startsWith("/internal") || raw.startsWith("/probe")) return false;
    if (raw !== path || /%2e|%2f|%5c/i.test(raw)) {
      send(res, 400, "Bad path.");
      return true;
    }

    if (req.method === "GET" && path === "/dev-login") {
      const cookie = deps.auth.devLoginCookie(url.searchParams.get("token") ?? "");
      if (!cookie) send(res, 403, signInPage());
      else send(res, 303, "", { "set-cookie": cookie, location: "/" });
      return true;
    }

    const identity = deps.auth.identify(path, req.headers);
    if (!identity) {
      send(res, 401, signInPage());
      return true;
    }
    const user = (await deps.pool.query<User>(`select id, role, product_owner, github_login from "user" where provider = $1 and subject = $2`, [identity.provider, identity.subject])).rows[0];
    if (!user) {
      send(res, 403, noAccessPage());
      return true;
    }
    // Sign-in rides on cookies, so a POST from any other origin is a cross-site form post and changes nothing.
    if (req.method === "POST" && req.headers.origin !== deps.origin) {
      send(res, 403, "Cross-origin request refused.");
      return true;
    }
    const banner = tokenBanner(env);

    if (req.method === "GET" && path === "/") {
      send(res, 200, floorPage({ ...(await floor(deps.pool)), canOperate: requireRole(user, "operator"), zone: zoneFrom(req.headers.cookie) }, banner));
      return true;
    }
    if (req.method === "GET" && path === "/activity") {
      send(res, 200, activityPage(await activity(deps.pool), banner));
      return true;
    }
    if (req.method === "GET" && path === "/phase0") {
      send(res, 200, phase0Page(await phase0(deps.pool), await readinessSpend(deps.pool), banner));
      return true;
    }
    if (path === "/configuration" && (req.method === "GET" || req.method === "POST")) {
      const canOperate = requireRole(user, "operator");
      const clock = deps.now ?? (() => new Date());
      const view = async (status: number, extra: { notice?: string | null; error?: string | null }) => {
        const now = await runtimeValues(deps.pool);
        const runtime = RUNTIME_SETTINGS.map((s) => ({ key: s.key, label: s.label, value: now[s.key], editable: s.editable, clearable: s.clearable, note: s.note }));
        send(res, status, configurationPage({ runtime, env: envSettings(env), canOperate, now: clock(), ...extra }, banner));
      };
      if (req.method === "GET") {
        const changed = RUNTIME_SETTINGS.find((s) => s.key === url.searchParams.get("changed"));
        await view(200, { notice: changed ? `Setting saved: ${changed.label} ${changed.clearable ? "cleared" : "changed"}.` : null });
        return true;
      }
      if (!canOperate) {
        send(res, 403, "Only an operator can change the factory's settings.");
        return true;
      }
      const b = await form(req);
      const outcome = await changeSetting(deps.pool, user.id, b.setting ?? "", b.value ?? "", b.reason, clock());
      if (!outcome.ok) await view(outcome.status, { error: outcome.message });
      else send(res, 303, "", { location: `/configuration?changed=${encodeURIComponent(outcome.updates[0].key)}` });
      return true;
    }
    const blob = BLOB_PATH.exec(path);
    if (req.method === "GET" && blob) {
      const text = deps.readBlob ? await deps.readBlob(blob[1]) : null;
      if (text === null) send(res, 404, "No such file.");
      else {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" });
        res.end(text);
      }
      return true;
    }
    if (req.method === "POST" && path === "/overrides") {
      if (!requireRole(user, "operator")) {
        send(res, 403, "Only an operator can override the factory.");
        return true;
      }
      const b = await form(req);
      const kind = b.kind as OverrideKind;
      const itemId = b.itemId || null;
      const known = itemId ? ITEM_KINDS.includes(kind) : FACTORY_KINDS.includes(kind);
      if (!known || !(b.reason ?? "").trim() || (itemId !== null && !/^[0-9a-f-]{36}$/.test(itemId))) {
        send(res, 400, "An override needs a kind that fits its scope and a reason.");
        return true;
      }
      if (itemId) {
        const state = (await deps.pool.query<{ state: string }>("select state from item where id = $1", [itemId])).rows[0]?.state;
        if (!state) {
          send(res, 404, "No such item.");
          return true;
        }
        if (kind === "requeue" && state !== "Failed" && state !== "Abandoned") {
          send(res, 409, "Only a Failed or Abandoned item can be re-queued.");
          return true;
        }
        if (kind === "start_now" || kind === "move_up" || kind === "move_down") {
          const can = await selectable(deps.pool, itemId, state);
          if (kind === "start_now" ? !can.startable : !can.movable) {
            send(res, 409, kind === "start_now"
              ? "Only an Eligible, NotReady or Queued item, or one whose question was answered, can be started now."
              : "Only an item in the factory queue, Queued or answered, can move up or down it.");
            return true;
          }
        }
      }
      // A move takes its new rank from its neighbours in the queue, so it's worked out and logged in one go (PBI 265).
      if (itemId && (kind === "move_up" || kind === "move_down")) {
        await withTx(deps.pool, (c) => moveInQueue(c, itemId, kind === "move_up" ? "up" : "down", { reason: b.reason.trim(), createdBy: user.id }));
        console.log(`override: ${identity.subject} set the ${kind} on item ${itemId}: ${JSON.stringify(b.reason.trim())}`);
        send(res, 303, "", { location: `/items/${itemId}` });
        return true;
      }
      // The scheduler applies it on its next tick, every 15 seconds, and /lease reads pause, kill, restart and stop_run directly.
      await setOverride(deps.pool, { scope: itemId ? "item" : "factory", targetId: itemId, kind, reason: b.reason.trim(), createdBy: user.id, expiresAt: null });
      console.log(`override: ${identity.subject} set the ${itemId ? `${kind} on item ${itemId}` : `factory ${kind}`}: ${JSON.stringify(b.reason.trim())}`);
      send(res, 303, "", { location: itemId ? `/items/${itemId}` : "/" });
      return true;
    }
    if (req.method === "GET" && path === "/events") {
      await streams.open(req, res);
      return true;
    }
    const itemPath = /^\/items\/([0-9a-f-]{36})(?:\/(signoff|answer|rule-approval|feature-change|rewrite-acceptance))?$/.exec(path);
    if (itemPath && req.method === "GET" && !itemPath[2]) {
      const detail = await runDetail(deps, itemPath[1], requireRole(user, "operator"), requireRole(user, "owner"), user.product_owner);
      if (!detail) send(res, 404, "No such item.");
      // Times show in the zone the viewer's browser sent, and a running attempt's time so far runs to now (PBI 189).
      else send(res, 200, runDetailPage({ ...detail, zone: zoneFrom(req.headers.cookie), now: deps.now?.() ?? new Date() }, banner));
      return true;
    }
    // PBI 395: only the owner approves an item's change to the factory's own rules, and only while the item waits for it.
    if (itemPath && req.method === "POST" && itemPath[2] === "rule-approval") {
      if (!requireRole(user, "owner")) {
        send(res, 403, "Only the owner can approve a change to the factory's rules.");
        return true;
      }
      // The form carries the hash of the rule changes the page showed, so the owner approves only what they saw.
      const shownHash = (await form(req)).ruleChangesHash ?? "";
      const at = (deps.now ?? (() => new Date()))();
      const outcome = await withTx(deps.pool, (c) => approveRuleChange(c, { itemId: itemPath[1], userId: user.id, at, shownHash }));
      if (outcome === "unknown") send(res, 404, "No such item.");
      else if (outcome === "not_waiting") send(res, 409, "That item isn't waiting for the owner's approval of a rule change.");
      else if (outcome === "stale") send(res, 409, "The item's rule changes changed since the page was shown. Reload it and review them again.");
      else {
        console.log(`rule change: ${identity.subject} approved the rule changes of item ${itemPath[1]}`);
        send(res, 303, "", { location: `/items/${itemPath[1]}` });
      }
      return true;
    }
    // PBI 439: only the owner accepts a proposed rewrite, and only while it stands.
    if (itemPath && req.method === "POST" && itemPath[2] === "rewrite-acceptance") {
      if (!requireRole(user, "owner")) {
        send(res, 403, "Only the owner can accept a proposed rewrite.");
        return true;
      }
      if (!deps.rewrites) {
        send(res, 503, "This dashboard can't edit the board, so no rewrite can be accepted here.");
        return true;
      }
      const rewriteId = (await form(req)).rewrite ?? "";
      if (!/^[0-9a-f-]{36}$/.test(rewriteId)) {
        send(res, 400, "Name the proposed rewrite to accept.");
        return true;
      }
      const login = user.github_login ?? identity.subject;
      const out = await acceptance(deps, deps.rewrites, { itemId: itemPath[1], rewriteId, user, login });
      if (out.status === 303) {
        console.log(`rewrite: ${identity.subject} accepted the proposed rewrite of item ${itemPath[1]}`);
        send(res, 303, "", { location: `/items/${itemPath[1]}` });
      } else send(res, out.status, out.text);
      return true;
    }
    // PBI 365: the Product Owner approves or turns down a feature change request, with the same effect as the comment.
    if (itemPath && req.method === "POST" && itemPath[2] === "feature-change") {
      const body = await form(req);
      const kind = body.decision === "approve" || body.decision === "changes" ? body.decision : null;
      if (!kind) {
        send(res, 400, "Pick approve or changes.");
        return true;
      }
      if (!user.product_owner) {
        send(res, 403, "Only a product owner can approve or turn down a feature change request.");
        return true;
      }
      const known = (await deps.pool.query("select 1 from item where id = $1", [itemPath[1]])).rowCount;
      if (!known) {
        send(res, 404, "No such item.");
        return true;
      }
      const outcome = await decideFeatureChange(deps, { itemId: itemPath[1], userId: user.id, kind, text: body.note ?? "", via: "dashboard" });
      if (outcome === "forbidden") send(res, 403, "Only a product owner can approve or turn down a feature change request.");
      else if (outcome === "ignored") send(res, 409, "That item isn't waiting on a feature change request.");
      else send(res, 303, "", { location: `/items/${itemPath[1]}` });
      return true;
    }
    if (itemPath && req.method === "POST" && itemPath[2]) {
      const body = await form(req);
      const kind: DecisionKind | null = itemPath[2] === "answer" ? "answer" : body.decision === "approve" || body.decision === "changes" ? body.decision : null;
      if (!kind) {
        send(res, 400, "Pick approve or changes.");
        return true;
      }
      const known = (await deps.pool.query("select 1 from item where id = $1", [itemPath[1]])).rowCount;
      if (!known) {
        send(res, 404, "No such item.");
        return true;
      }
      const text = kind === "answer" ? (body.answer ?? "") : (body.note ?? "");
      // The worker announces the decision on the item from its outbox row (PBI 219), so it's announced once.
      const outcome = await withTx(deps.pool, (c) => decide(c, { itemId: itemPath[1], userId: user.id, kind, text, via: "dashboard" }));
      if (outcome === "forbidden") send(res, 403, "You can't make that decision.");
      else if (outcome === "ignored") send(res, 409, "That item isn't waiting for this decision.");
      else send(res, 303, "", { location: `/items/${itemPath[1]}` });
      return true;
    }
    if (req.method === "POST" && path === "/users") {
      if (!requireRole(user, "owner")) {
        send(res, 403, "Only an owner can add people.");
        return true;
      }
      const b = await form(req);
      if (!["google", "microsoft", "dev"].includes(b.provider) || !b.subject || !["viewer", "operator", "owner"].includes(b.role)) {
        send(res, 400, "A user needs a provider, a subject and a role.");
        return true;
      }
      try {
        await deps.pool.query(
          `insert into "user" (provider, subject, email, role, product_owner, github_login, added_by) values ($1, $2, $3, $4, $5, $6, $7)
           on conflict (provider, subject) do update set role = excluded.role, product_owner = excluded.product_owner, github_login = excluded.github_login`,
          [b.provider, b.subject, b.email || null, b.role, b.product_owner === "on" || b.product_owner === "true", b.github_login || null, user.id],
        );
      } catch (e) {
        // GitHub logins are case-insensitive and belong to one user (migration 004).
        if ((e as { code?: string }).code !== "23505") throw e;
        send(res, 400, "Another user already has that GitHub login.");
        return true;
      }
      send(res, 303, "", { location: "/" });
      return true;
    }
    send(res, 404, "Not found.");
    return true;
  };
  return Object.assign(handler, { close: streams.close });
}
