// Dashboard routes (plan Task 15): Floor, Run detail, sign-off and answers, overrides, users, the event stream,
// the stored evidence and the Phase 0 exit report.
import type { IncomingMessage, ServerResponse } from "node:http";
import type pg from "pg";
import type { BacklogAdapter, FactoryItem, RepoHost } from "../adapters/types.ts";
import { classify, REGRESSION_TAG } from "../bdd/messages.ts";
import { itemDurations, type Move, type QuestionSpan, type StageSpan } from "../core/durations.ts";
import type { ItemState } from "../core/states.ts";
import { decideAndAnnounce, revivable, type DecisionKind } from "../control/decisions.ts";
import { issueRepos } from "../store/issues.ts";
import { nextUp } from "../store/items.ts";
import { readinessChecks, readinessSpend } from "../store/readiness-checks.ts";
import { activeOverrides, restartWaitMs, setOverride, type OverrideKind } from "../store/overrides.ts";
import { requireRole, type Auth, type Role } from "./auth.ts";
import { BadRequest, readJson, type Handler } from "./server.ts";
import { activityPage, floorPage, noAccessPage, phase0Page, runDetailPage, signInPage, type ActivityRow, type Phase0Row, type Restart, type RunDetail, type Scenario } from "./views.ts";

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
  /** The time now, for the open spells Run detail's durations count up to (PBI 187). Defaults to the system clock. */
  now?: () => Date;
};

const FACTORY_KINDS: OverrideKind[] = ["pause", "resume", "drain", "kill", "restart"];
const ITEM_KINDS: OverrideKind[] = ["hold", "unhold", "stop_run", "requeue"];
// The paths the cell API hands out: transcripts/<run>/<stage>-<attempt>.jsonl and reports/<run>/<stage>-<attempt>.ndjson.
const BLOB_PATH = /^\/blobs\/((?:transcripts\/[0-9a-f-]{36}\/[a-z0-9-]+-\d+\.jsonl)|(?:reports\/[0-9a-f-]{36}\/[a-z0-9-]+-\d+\.ndjson))$/;

type User = { id: string; role: Role; product_owner: boolean };

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

async function floor(pool: pg.Pool) {
  // One row per item, by its oldest open question, counted as the scheduler counts the waiting (Run contract 3).
  const waiting = (await pool.query(
    `select i.id, i.external_id, i.title, i.state, min(q.asked_at) as since from item i
     join question q on q.item_id = i.id and q.answer is null and q.closed_at is null
     where i.state in ('SignOff', 'NeedsInput') group by i.id order by since`,
  )).rows;
  const reviews = (await pool.query(
    `select i.id, i.external_id, i.title, i.state, (select max(at) from event e where e.item_id = i.id and e.payload->>'to' = 'InReview') as since,
       r.pr_number, r.pr_url
     from item i left join lateral (select pr_number, pr_url from run where item_id = i.id and ended_at is null order by started_at desc limit 1) r on true
     where i.state = 'InReview' order by since nulls last, i.title`,
  )).rows;
  const capacity = (await pool.query<{ review_capacity: number }>("select review_capacity from wip_policy limit 1")).rows[0]?.review_capacity ?? 3;
  // An engine rule or a judge flag is stored at index 0 with its explanation in reason, as the gate's comment reads it.
  const notReady = (await pool.query<{ id: string; external_id: string; title: string; failed: string[] }>(
    `select i.id, i.external_id, i.title, coalesce(array_agg(case when p.criterion_index > 0 then p.criterion else p.reason end order by p.criterion_index)
       filter (where p.id is not null), '{}') as failed
     from item i left join policy_result p on p.item_id = i.id and p.file = 'dor' and p.status = 'failed'
       and p.at = (select max(at) from policy_result where item_id = i.id and file = 'dor')
     where i.state = 'NotReady' group by i.id order by i.title`,
  )).rows;
  const overrides = await activeOverrides(pool, new Date());
  const overridden = new Set(overrides.filter((o) => o.scope === "item").map((o) => o.targetId));
  // The last agent message is the newest non-empty one the open run's stages sent (the cell API cuts it to 500).
  const active = (await pool.query(
    `select i.id, i.external_id, i.title, i.state, i.held, r.next_stage as stage, r.pr_number, r.pr_url,
       (select max(started_at) from stage_run s where s.run_id = r.id) as since,
       coalesce((select sum(cost_usd) from stage_run s where s.run_id = r.id), 0)::text as cost,
       (select message from stage_run s where s.run_id = r.id and message <> '' order by ended_at desc nulls last, started_at desc limit 1) as message
     from item i left join lateral (select * from run where item_id = i.id and ended_at is null order by started_at desc limit 1) r on true
     where i.state in ('InProgress', 'SignOff', 'NeedsInput', 'InReview') order by i.title`,
  )).rows.map((a) => ({ ...a, badges: [...(a.held ? ["held"] : []), ...(overridden.has(a.id) ? ["override"] : [])] }));
  const factory = overrides.filter((o) => o.scope === "factory").map((o) => ({ kind: o.kind, reason: o.reason }));
  // A restart being prepared (PBI 140) counts down its wrap-up while any cell still holds a live lease.
  const prepared = overrides.find((o) => o.scope === "factory" && o.kind === "restart");
  let restart: Restart | null = null;
  if (prepared) {
    const running = (await pool.query<{ n: number }>("select count(*)::int as n from item where state = 'InProgress' and lease_expires > now()")).rows[0].n;
    const left = prepared.createdAt.getTime() + restartWaitMs() - Date.now();
    restart = { running, minutesLeft: Math.max(0, Math.ceil(left / 60_000)), reason: prepared.reason };
  }
  // "Next up" applies the same brake the scheduler does: at capacity, only work already in flight starts.
  const waitingCount = waiting.length + reviews.length;
  const next = await nextUp(pool, 5, { resumeOnly: waitingCount >= capacity });
  const repos = await issueRepos(pool, [...waiting, ...reviews, ...notReady, ...active, ...next].map((r) => r.id));
  const withRepo = <T extends { id: string }>(rows: T[]) => rows.map((r) => ({ ...r, repo: repos.get(r.id) ?? null }));
  return {
    active: withRepo(active), waiting: withRepo([...waiting, ...reviews]), waitingCount, capacity, next: withRepo(next), notReady: withRepo(notReady), factory,
    restart,
  };
}

/**
 * The item's own scenarios with their verdict in the latest red and the latest green report, read from the stored
 * reports with classify. A report that's gone leaves its column empty.
 */
async function verdicts(deps: DashboardDeps, externalId: string, stages: { stage_id: string; report_ref: string | null }[]): Promise<RunDetail["verdicts"]> {
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
async function phase0(pool: pg.Pool): Promise<Phase0Row[]> {
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
 * payload, so a reason, a decision's text or a readiness detail never reaches the page. A factory-wide event has no item.
 */
async function activity(pool: pg.Pool): Promise<ActivityRow[]> {
  const rows = (await pool.query<Omit<ActivityRow, "repo"> & { item_id: string | null }>(
    `select e.at, i.id as item_id, i.external_id, i.title, e.kind, e.payload->>'from' as "from", e.payload->>'to' as "to", e.payload->>'event' as event
     from event e left join item i on i.id = e.item_id order by e.at desc, e.id desc limit 100`,
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
  return fi.acceptanceCriteria.map((criterion, i) => ({ criterion, scenarios: byAc.get(i + 1) ?? [] }));
}

/** The item's feature files as they stand at `sha`: the lock sha once signed off, the scenarios sha while waiting. */
async function featuresAt(deps: DashboardDeps, fi: FactoryItem | null, sha: string, files: string[]): Promise<RunDetail["features"]> {
  if (!fi?.repo || !deps.repoHost) return [];
  const out: RunDetail["features"] = [];
  for (const path of files) out.push({ path, text: (await deps.repoHost.readFile(fi.repo, sha, path)) ?? "(missing at this commit)" });
  return out;
}

async function runDetail(deps: DashboardDeps, id: string, canOperate: boolean): Promise<RunDetail | null> {
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
  const held = (await pool.query<{ held: boolean }>("select held from item where id = $1", [id])).rows[0].held;
  const durations = await itemTime(pool, id, item.state, (deps.now ?? (() => new Date()))());
  return {
    item: { ...item, repo: (await issueRepos(pool, [id])).get(id) ?? null }, run, policies, stages, readiness: await readinessChecks(pool, id), question, criteria, scope, pending, features,
    verdicts: await verdicts(deps, item.external_id, stages), linkBlobs: Boolean(deps.readBlob),
    controls: canOperate ? { held, stoppable: item.state === "InProgress", requeueable: item.state === "Failed" || item.state === "Abandoned" } : null,
    durations,
  };
}

/** Where the item's time went (PBI 187): its moves, every run's stage attempts and its questions, read up to `now`. */
async function itemTime(pool: pg.Pool, id: string, state: ItemState, now: Date) {
  // An item held from before issue_created_at was stored counts from its first logged event until a poll fills it in.
  const createdAt = (await pool.query<{ at: Date | null }>(
    "select coalesce(issue_created_at, (select min(at) from event where item_id = $1)) as at from item where id = $1", [id],
  )).rows[0].at;
  const moves = (await pool.query<Move>(
    `select payload->>'from' as from, payload->>'to' as to, at from event
     where item_id = $1 and kind in ('transition', 'override') and payload ? 'to' order by at, id`, [id],
  )).rows;
  const stages = (await pool.query<StageSpan>(
    `select s.stage_id as "stageId", s.started_at as "startedAt", s.ended_at as "endedAt"
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
  const env = deps.env ?? process.env;
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
    const user = (await deps.pool.query<User>(`select id, role, product_owner from "user" where provider = $1 and subject = $2`, [identity.provider, identity.subject])).rows[0];
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
      send(res, 200, floorPage({ ...(await floor(deps.pool)), canOperate: requireRole(user, "operator") }, banner));
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
    const itemPath = /^\/items\/([0-9a-f-]{36})(?:\/(signoff|answer))?$/.exec(path);
    if (itemPath && req.method === "GET" && !itemPath[2]) {
      const detail = await runDetail(deps, itemPath[1], requireRole(user, "operator"));
      if (!detail) send(res, 404, "No such item.");
      else send(res, 200, runDetailPage(detail, banner));
      return true;
    }
    if (itemPath && req.method === "POST" && itemPath[2]) {
      const body = await form(req);
      const kind: DecisionKind | null = itemPath[2] === "answer" ? "answer" : body.decision === "approve" || body.decision === "changes" ? body.decision : null;
      if (!kind) {
        send(res, 400, "Pick approve or changes.");
        return true;
      }
      const ext = (await deps.pool.query<{ external_id: string }>("select external_id from item where id = $1", [itemPath[1]])).rows[0]?.external_id;
      if (!ext) {
        send(res, 404, "No such item.");
        return true;
      }
      const text = kind === "answer" ? (body.answer ?? "") : (body.note ?? "");
      const outcome = await decideAndAnnounce(deps, { itemId: itemPath[1], userId: user.id, kind, text, via: "dashboard" }, ext);
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
