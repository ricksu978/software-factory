// Dashboard routes (plan Task 15): Floor, Run detail, sign-off and answers, users and the event stream.
// The override controls and the Re-queue button wait for Task 13's setOverride.
import type { IncomingMessage, ServerResponse } from "node:http";
import type pg from "pg";
import type { BacklogAdapter, RepoHost } from "../adapters/types.ts";
import { REGRESSION_TAG } from "../bdd/messages.ts";
import { decideAndAnnounce, revivable, type DecisionKind } from "../control/decisions.ts";
import { nextUp } from "../store/items.ts";
import { requireRole, type Auth, type Role } from "./auth.ts";
import { BadRequest, readJson, type Handler } from "./server.ts";
import { floorPage, noAccessPage, runDetailPage, signInPage, type RunDetail, type Scenario } from "./views.ts";

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
};

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
    `select i.id, i.title, i.state, min(q.asked_at) as since from item i
     join question q on q.item_id = i.id and q.answer is null and q.closed_at is null
     where i.state in ('SignOff', 'NeedsInput') group by i.id, i.title, i.state order by since`,
  )).rows;
  const reviews = (await pool.query(
    `select i.id, i.title, i.state, (select max(at) from event e where e.item_id = i.id and e.payload->>'to' = 'InReview') as since
     from item i where i.state = 'InReview' order by since nulls last, i.title`,
  )).rows;
  const capacity = (await pool.query<{ review_capacity: number }>("select review_capacity from wip_policy limit 1")).rows[0]?.review_capacity ?? 3;
  // An engine rule or a judge flag is stored at index 0 with its explanation in reason, as the gate's comment reads it.
  const notReady = (await pool.query<{ id: string; title: string; failed: string[] }>(
    `select i.id, i.title, coalesce(array_agg(case when p.criterion_index > 0 then p.criterion else p.reason end order by p.criterion_index)
       filter (where p.id is not null), '{}') as failed
     from item i left join policy_result p on p.item_id = i.id and p.file = 'dor' and p.status = 'failed'
       and p.at = (select max(at) from policy_result where item_id = i.id and file = 'dor')
     where i.state = 'NotReady' group by i.id, i.title order by i.title`,
  )).rows;
  const active = (await pool.query(
    `select i.id, i.title, i.state, i.held, r.next_stage as stage,
       (select max(started_at) from stage_run s where s.run_id = r.id) as since,
       coalesce((select sum(cost_usd) from stage_run s where s.run_id = r.id), 0)::text as cost,
       exists (select from override o where o.scope = 'item' and o.target_id = i.id and o.cleared_at is null and (o.expires_at is null or o.expires_at > now())) as overridden
     from item i left join lateral (select * from run where item_id = i.id and ended_at is null order by started_at desc limit 1) r on true
     where i.state in ('InProgress', 'SignOff', 'NeedsInput', 'InReview') order by i.title`,
  )).rows.map((a) => ({ ...a, badges: [...(a.held ? ["held"] : []), ...(a.overridden ? ["override"] : [])] }));
  // "Next up" applies the same brake the scheduler does: at capacity, only work already in flight starts.
  const waitingCount = waiting.length + reviews.length;
  const next = await nextUp(pool, 5, { resumeOnly: waitingCount >= capacity });
  return { active, waiting: [...waiting, ...reviews], waitingCount, capacity, next, notReady };
}

/**
 * Acceptance criteria with the scenarios tagged @ac-N under each, read from the files at the scenarios sha. A
 * scenario carrying @regression, itself or through its feature, is marked, since Red expects it to pass.
 */
async function criteriaView(deps: DashboardDeps, externalId: string, sha: string, files: string[]): Promise<RunDetail["criteria"]> {
  const fi = await deps.adapter.getItem(externalId);
  if (!fi || !deps.repoHost || !fi.repo) return null;
  const byAc = new Map<number, Scenario[]>();
  for (const path of files) {
    let tags: string[] = [];
    let featureTags: string[] = [];
    for (const line of ((await deps.repoHost.readFile(fi.repo, sha, path)) ?? "").split(/\r?\n/)) {
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

/** The signed-off feature files, read at the lock sha. */
async function lockedFeatures(deps: DashboardDeps, externalId: string, sha: string, files: string[]): Promise<RunDetail["features"]> {
  const fi = await deps.adapter.getItem(externalId);
  if (!fi?.repo || !deps.repoHost) return [];
  const out: RunDetail["features"] = [];
  for (const path of files) out.push({ path, text: (await deps.repoHost.readFile(fi.repo, sha, path)) ?? "(missing at this commit)" });
  return out;
}

async function runDetail(deps: DashboardDeps, id: string): Promise<RunDetail | null> {
  const { pool } = deps;
  const item = (await pool.query("select id, title, state, external_id from item where id = $1", [id])).rows[0];
  if (!item) return null;
  const run = (await pool.query(
    `select id, sop_version, config_sha, scenarios_sha, features_lock_sha, risk_tier, tier_reasons, next_stage, locked_files
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
  const criteria = item.state === "SignOff" && run?.scenarios_sha ? await criteriaView(deps, item.external_id, run.scenarios_sha, run.locked_files ?? []) : null;
  const features = run?.features_lock_sha ? await lockedFeatures(deps, item.external_id, run.features_lock_sha, run.locked_files ?? []) : [];
  return { item, run, policies, stages, question, criteria, features };
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
      send(res, 200, floorPage(await floor(deps.pool), banner));
      return true;
    }
    if (req.method === "GET" && path === "/events") {
      await streams.open(req, res);
      return true;
    }
    const itemPath = /^\/items\/([0-9a-f-]{36})(?:\/(signoff|answer))?$/.exec(path);
    if (itemPath && req.method === "GET" && !itemPath[2]) {
      const detail = await runDetail(deps, itemPath[1]);
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
