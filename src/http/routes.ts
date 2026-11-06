// Dashboard routes (plan Task 15): Floor, Run detail, sign-off and answers, users and the event stream.
// The override controls and the Re-queue button wait for Task 13's setOverride.
import type { IncomingMessage, ServerResponse } from "node:http";
import type pg from "pg";
import type { BacklogAdapter, RepoHost } from "../adapters/types.ts";
import { decideAndAnnounce, type DecisionKind } from "../control/decisions.ts";
import { nextUp } from "../store/items.ts";
import { requireRole, type Auth, type Role } from "./auth.ts";
import type { Handler } from "./server.ts";
import { floorPage, noAccessPage, runDetailPage, signInPage, type RunDetail } from "./views.ts";

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

async function form(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if ((req.headers["content-type"] ?? "").includes("application/json")) {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v ?? "")]));
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

/** A banner once the Claude token is within 30 days of its 365-day life, counted from CLAUDE_TOKEN_CREATED_AT. */
export function tokenBanner(env: Record<string, string | undefined>, now = Date.now()): string | null {
  const created = Date.parse(env.CLAUDE_TOKEN_CREATED_AT ?? "");
  if (Number.isNaN(created)) return null;
  const days = Math.floor((created + 365 * 86_400_000 - now) / 86_400_000);
  return days <= 30 ? `The Claude token expires in ${Math.max(days, 0)} days. Make a new one with claude setup-token and update the secret.` : null;
}

async function floor(pool: pg.Pool) {
  const waiting = (await pool.query(
    `select i.id, i.title, i.state, q.asked_at as since from item i
     join question q on q.item_id = i.id and q.answer is null and q.closed_at is null
     where i.state in ('SignOff', 'NeedsInput') order by q.asked_at`,
  )).rows;
  const reviews = (await pool.query(
    `select i.id, i.title, i.state, (select max(at) from event e where e.item_id = i.id and e.payload->>'to' = 'InReview') as since
     from item i where i.state = 'InReview' order by since nulls last, i.title`,
  )).rows;
  const capacity = (await pool.query<{ review_capacity: number }>("select review_capacity from wip_policy limit 1")).rows[0]?.review_capacity ?? 3;
  const notReady = (await pool.query<{ id: string; title: string; failed: string[] }>(
    `select i.id, i.title, coalesce(array_agg(p.criterion order by p.criterion_index) filter (where p.id is not null), '{}') as failed
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
  return { active, waiting: [...waiting, ...reviews], waitingCount: waiting.length + reviews.length, capacity, next: await nextUp(pool, 5), notReady };
}

/** Acceptance criteria with the scenarios tagged @ac-N under each, read from the files at the scenarios sha. */
async function criteriaView(deps: DashboardDeps, externalId: string, sha: string, files: string[]): Promise<RunDetail["criteria"]> {
  const fi = await deps.adapter.getItem(externalId);
  if (!fi || !deps.repoHost || !fi.repo) return null;
  const byAc = new Map<number, string[]>();
  for (const path of files) {
    let tags: string[] = [];
    for (const line of ((await deps.repoHost.readFile(fi.repo, sha, path)) ?? "").split(/\r?\n/)) {
      const t = line.trim();
      if (t.startsWith("@")) tags.push(...t.split(/\s+/));
      else if (/^Scenario( Outline)?:/.test(t)) {
        for (const tag of tags) {
          const n = /^@ac-(\d+)$/.exec(tag)?.[1];
          if (n) byAc.set(Number(n), [...(byAc.get(Number(n)) ?? []), t.replace(/^Scenario( Outline)?:\s*/, "")]);
        }
        tags = [];
      } else if (t && !t.startsWith("#")) tags = [];
    }
  }
  return fi.acceptanceCriteria.map((criterion, i) => ({ criterion, scenarios: byAc.get(i + 1) ?? [] }));
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
  const question = (await pool.query("select kind, body from question where item_id = $1 and answer is null and closed_at is null order by asked_at desc limit 1", [id])).rows[0] ?? null;
  const criteria = item.state === "SignOff" && run?.scenarios_sha ? await criteriaView(deps, item.external_id, run.scenarios_sha, run.locked_files ?? []) : null;
  return { item, run, policies, stages, question, criteria };
}

/** Streams every factory event as server-sent events, fed by LISTEN factory_events. */
async function events(pool: pg.Pool, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const c = await pool.connect();
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const forward = (m: { channel: string; payload?: string }) => {
    if (m.channel === "factory_events") res.write(`data: ${m.payload ?? "{}"}\n\n`);
  };
  c.on("notification", forward);
  await c.query("listen factory_events");
  req.on("close", () => {
    c.off("notification", forward);
    c.query("unlisten factory_events").finally(() => c.release());
  });
}

/** The dashboard as one handler. Anything under /webhooks or /internal belongs to other handlers. */
export function dashboardRoutes(deps: DashboardDeps): Handler {
  const env = deps.env ?? process.env;
  return async (req, res) => {
    const url = new URL(req.url ?? "/", deps.origin);
    const path = url.pathname;
    if (path.startsWith("/webhooks") || path.startsWith("/internal") || path.startsWith("/probe")) return false;

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
      await events(deps.pool, req, res);
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
      await deps.pool.query(
        `insert into "user" (provider, subject, email, role, product_owner, github_login, added_by) values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (provider, subject) do update set role = excluded.role, product_owner = excluded.product_owner, github_login = excluded.github_login`,
        [b.provider, b.subject, b.email || null, b.role, b.product_owner === "on" || b.product_owner === "true", b.github_login || null, user.id],
      );
      send(res, 303, "", { location: "/" });
      return true;
    }
    send(res, 404, "Not found.");
    return true;
  };
}
