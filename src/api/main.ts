// The orchestrator API (redesign step 6a, 2026-11-07 design §03, §04, §05 and §12). It serves §05's /v1 routes on
// Hono on port 7402, each open only to the role §05's table names. Every caller but GitHub's webhook brings the
// issuer's access token as a bearer token: its signature is checked against the keys the issuer's discovery document
// points at, and so are its issuer, audience and expiry. The caller is looked up in "user" on every request, so
// removing someone ends their access on their next request.
import { createAdaptorServer, type HttpBindings } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import type { Server } from "node:http";
import type pg from "pg";
import { decide, type DecisionKind } from "../control/decisions.ts";
import { requireRole, type Role } from "../http/auth.ts";
import { activity, BLOB_PATH, floor, phase0, selectable, tokenBanner } from "../http/routes.ts";
import { blobReader } from "../main.ts";
import { createPool, withTx } from "../store/db.ts";
import { moveInQueue } from "../store/items.ts";
import { setOverride, type OverrideKind } from "../store/overrides.ts";
import { readinessSpend } from "../store/readiness-checks.ts";
import { activityLog } from "./activity.ts";
import { bearerVerifier, discoverJwks, type VerifyBearer } from "./auth.ts";
import { eventFeed, STREAM_MS } from "./events.ts";
import { itemDetail } from "./items.ts";
import { webhookIntake } from "./webhook.ts";

/** The API's port when PORT doesn't set one (design §10). */
export const API_PORT = 7402;

export type ApiDeps = {
  pool: pg.Pool;
  /** OIDC_ISSUER: the issuer whose discovery document names the signing keys, and every token's `iss`. */
  issuer: string;
  /** API_AUDIENCE: the `aud` every token must carry. */
  audience: string;
  /** GITHUB_WEBHOOK_SECRET, which signs GitHub's deliveries to /webhooks/github. */
  webhookSecret: string;
  /** Reads a stored transcript or report by its blob path, or null when it's missing. */
  readBlob: (path: string) => Promise<string | null>;
  /** The settings the floor reads, such as CLAUDE_TOKEN_CREATED_AT. */
  env: Record<string, string | undefined>;
  /** The time now, for the floor's token age and Run detail's durations. Defaults to the system clock. */
  now?: () => Date;
};

export type Api = { server: Server; stop(): Promise<void> };

type User = { id: string; role: Role; product_owner: boolean; github_login: string | null };
type Env = { Bindings: Partial<HttpBindings>; Variables: { user: User } };

const FACTORY_KINDS: OverrideKind[] = ["pause", "resume", "drain", "kill", "restart", "wip"];
const ITEM_KINDS: OverrideKind[] = ["hold", "unhold", "stop_run", "requeue", "start_now", "move_up", "move_down"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROLES: Role[] = ["viewer", "operator", "owner"];
/** The largest webhook delivery the API reads, as today's handler in src/main.ts allows. */
export const MAX_WEBHOOK = 25 * 1024 * 1024;
/** The largest JSON body a /v1 route reads, as today's readJson allows. */
export const MAX_JSON = 1024 * 1024;

/** Thrown for a request the API refuses, answered as JSON with its status. */
class Refused extends Error {
  status: 400 | 401 | 403 | 404 | 409 | 413;
  constructor(status: Refused["status"], message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Whether `raw`, a request's path as it arrived, is the path the API routes on. Dot segments normalise to another
 * path, an encoded dot, slash or backslash would, and Hono decodes any other percent-escape before it routes, so
 * "/%761/floor" would reach /v1/floor. A malformed escape is refused too.
 */
export function cleanPath(raw: string): boolean {
  if (raw !== new URL(raw, "http://api").pathname || /%2e|%2f|%5c/i.test(raw)) return false;
  try {
    return decodeURI(raw) === raw;
  } catch {
    return false;
  }
}

/** The request's JSON object body, or a 400. */
async function body(c: Context<Env>): Promise<Record<string, unknown>> {
  let b: unknown;
  try {
    b = await c.req.json();
  } catch {
    throw new Refused(400, "the body isn't JSON");
  }
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new Refused(400, "the body isn't a JSON object");
  return b as Record<string, unknown>;
}

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

function only(c: Context<Env>, role: Role, what: string): User {
  const user = c.get("user");
  if (!requireRole(user, role)) throw new Refused(403, `only ${role === "owner" ? "an owner" : "an operator"} can ${what}`);
  return user;
}

/** The API as a Hono app, with the event feed it shares between streams. */
export function apiApp(d: ApiDeps & { verify: VerifyBearer }): { app: Hono<Env>; close(): Promise<void> } {
  const now = d.now ?? (() => new Date());
  const feed = eventFeed(d.pool);
  const app = new Hono<Env>();

  app.onError((e, c) => {
    if (e instanceof Refused) return c.json({ error: e.message }, e.status);
    console.error("API request failed:", e);
    return c.json({ error: "internal error" }, 500);
  });
  app.notFound((c) => c.json({ error: "not found" }, 404));

  // A path the API would read differently from how it arrived is refused before any route or sign-in check sees it,
  // so no request can pass as one route to a proxy and land on another here (design §05).
  app.use("*", async (c, next) => {
    if (!cleanPath((c.env?.incoming?.url ?? new URL(c.req.url).pathname).split("?")[0])) throw new Refused(400, "bad path");
    await next();
  });

  // GitHub's webhook is checked by its signature alone. It never reads a bearer token (design §03).
  // Each body is capped before it's read, so no caller can make the process hold more than the cap: a 413 instead.
  const capped = (maxSize: number, what: string) =>
    bodyLimit({ maxSize, onError: () => { throw new Refused(413, `the ${what} is over ${maxSize / (1024 * 1024)} MiB`); } });
  app.post("/webhooks/github", capped(MAX_WEBHOOK, "payload"), async (c) => {
    const rawBody = Buffer.from(await c.req.arrayBuffer());
    const { status } = await webhookIntake({ pool: d.pool, secret: d.webhookSecret }, { headers: c.req.header(), rawBody });
    return c.body(null, status);
  });

  // Every /v1 route: a valid bearer token, then the caller's row in "user", read afresh on every request.
  app.use("/v1/*", async (c, next) => {
    const caller = await d.verify(c.req.header("authorization"));
    if (!caller) {
      c.header("www-authenticate", 'Bearer error="invalid_token"');
      throw new Refused(401, "a valid bearer token is required");
    }
    const user = (await d.pool.query<User>(
      `select id, role, product_owner, github_login from "user" where issuer = $1 and subject = $2`, [caller.issuer, caller.subject],
    )).rows[0];
    if (!user) throw new Refused(403, "you aren't a user of this factory");
    c.set("user", user);
    await next();
  });
  app.use("/v1/*", capped(MAX_JSON, "body"));

  app.get("/v1/floor", async (c) => {
    const at = now();
    const created = Date.parse(d.env.CLAUDE_TOKEN_CREATED_AT ?? "");
    const claudeToken = Number.isNaN(created) ? null : {
      createdAt: new Date(created).toISOString(),
      ageDays: Math.floor((at.getTime() - created) / 86_400_000),
      banner: tokenBanner(d.env, at.getTime()),
    };
    const beat = (await d.pool.query<{ ticked_at: Date }>("select ticked_at from worker_heartbeat limit 1")).rows[0];
    // The claim keys are a Map in the dashboard's floor, which JSON can't carry, so they go as an object by item id.
    const f = await floor(d.pool);
    return c.json({
      ...f, keys: Object.fromEntries(f.keys), canOperate: requireRole(c.get("user"), "operator"),
      claudeToken, workerHeartbeat: beat ? beat.ticked_at.toISOString() : null,
    });
  });

  app.get("/v1/phase0", async (c) => c.json({ runs: await phase0(d.pool), readinessSpend: await readinessSpend(d.pool) }));

  app.get("/v1/items/:id", async (c) => {
    const id = c.req.param("id");
    const detail = UUID.test(id) ? await itemDetail(d.pool, id, requireRole(c.get("user"), "operator"), now(), d.readBlob) : null;
    if (!detail) throw new Refused(404, "no such item");
    return c.json(detail);
  });

  app.get("/v1/blobs/*", async (c) => {
    const blob = BLOB_PATH.exec(c.req.path.slice("/v1".length));
    const stored = blob ? await d.readBlob(blob[1]) : null;
    if (stored === null) throw new Refused(404, "no such file");
    return c.body(stored, 200, { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" });
  });

  // The activity log: the 100 newest events, newest first, with only what today's /activity page shows (PBI 286).
  app.get("/v1/activity", async (c) => c.json({ events: activityLog(await activity(d.pool)) }));

  // Server-sent events, each stream ended after five minutes.
  app.get("/v1/events", async (c) => {
    // Listen first, so no event is missed between the stream opening and the LISTEN taking effect.
    await feed.listen();
    return streamSSE(c, async (stream) => {
      let end!: () => void;
      const ended = new Promise<void>((resolve) => (end = resolve));
      const off = feed.subscribe({ send: (data) => void stream.writeSSE({ data }), end });
      const timer = setTimeout(end, STREAM_MS);
      stream.onAbort(end);
      await stream.write(": open\n\n");
      await ended;
      clearTimeout(timer);
      off();
    });
  });

  // Today's rules in src/control/decisions.ts decide who may sign off or answer (design §05). The worker posts the
  // board comment from the decision's outbox row.
  app.post("/v1/items/:id/decisions", async (c) => {
    const id = c.req.param("id");
    const b = await body(c);
    const kind = b.kind as DecisionKind;
    if (!["approve", "changes", "answer"].includes(kind)) throw new Refused(400, "a decision's kind is approve, changes or answer");
    if (!UUID.test(id) || !(await d.pool.query("select 1 from item where id = $1", [id])).rowCount) throw new Refused(404, "no such item");
    const outcome = await withTx(d.pool, (tx) => decide(tx, { itemId: id, userId: c.get("user").id, kind, text: text(b.text), via: "dashboard" }));
    if (outcome === "forbidden") throw new Refused(403, "you can't make that decision");
    if (outcome === "ignored") throw new Refused(409, "that item isn't waiting for this decision");
    return c.json({ outcome });
  });

  app.post("/v1/overrides", async (c) => {
    const user = only(c, "operator", "override the factory");
    const b = await body(c);
    const kind = b.kind as OverrideKind;
    const itemId = typeof b.itemId === "string" && b.itemId ? b.itemId : null;
    const reason = text(b.reason);
    const known = itemId ? ITEM_KINDS.includes(kind) : FACTORY_KINDS.includes(kind);
    if (!known || !reason || (itemId !== null && !UUID.test(itemId))) throw new Refused(400, "an override needs a kind that fits its scope and a reason");
    if (kind === "wip" && !(Number.isInteger(b.value) && (b.value as number) >= 1)) throw new Refused(400, "a WIP pin's value is a whole number of at least 1");
    if (itemId) {
      const state = (await d.pool.query<{ state: string }>("select state from item where id = $1", [itemId])).rows[0]?.state;
      if (!state) throw new Refused(404, "no such item");
      if (kind === "requeue" && state !== "Failed" && state !== "Abandoned") throw new Refused(409, "only a Failed or Abandoned item can be re-queued");
      if (kind === "start_now" || kind === "move_up" || kind === "move_down") {
        const can = await selectable(d.pool, itemId, state);
        if (kind === "start_now" && !can.startable) throw new Refused(409, "only an Eligible, NotReady or Queued item, or one whose question was answered, can be started now");
        if (kind !== "start_now" && !can.movable) throw new Refused(409, "only an item in the factory queue, Queued or answered, can move up or down it");
      }
    }
    // A move takes its new rank from its neighbours in the queue, so it's worked out and logged in one go (PBI 265).
    if (itemId && (kind === "move_up" || kind === "move_down")) {
      await withTx(d.pool, (tx) => moveInQueue(tx, itemId, kind === "move_up" ? "up" : "down", { reason, createdBy: user.id }));
      console.log(`override: user ${user.id} set the ${kind} on item ${itemId}: ${JSON.stringify(reason)}`);
      return c.json({ ok: true }, 201);
    }
    await withTx(d.pool, (tx) => setOverride(tx, {
      scope: itemId ? "item" : "factory", targetId: itemId, kind, reason, createdBy: user.id, expiresAt: null,
      ...(kind === "wip" ? { value: b.value as number } : {}),
    }));
    console.log(`override: user ${user.id} set the ${itemId ? `${kind} on item ${itemId}` : `factory ${kind}`}: ${JSON.stringify(reason)}`);
    return c.json({ ok: true }, 201);
  });

  app.post("/v1/users", async (c) => {
    const owner = only(c, "owner", "add people");
    const b = await body(c);
    const issuer = text(b.issuer);
    const subject = text(b.subject);
    const role = b.role as Role;
    if (!/^https?:\/\/\S+$/.test(issuer) || !subject || !ROLES.includes(role)) throw new Refused(400, "a user needs an http or https issuer, a subject and a role");
    try {
      await d.pool.query(
        `insert into "user" (issuer, subject, email, role, product_owner, github_login, added_by) values ($1, $2, $3, $4, $5, $6, $7)
         on conflict on constraint user_issuer_subject do update set role = excluded.role, product_owner = excluded.product_owner, github_login = excluded.github_login`,
        [issuer, subject, text(b.email) || null, role, b.product_owner === true, text(b.github_login) || null, owner.id],
      );
    } catch (e) {
      // GitHub logins are case-insensitive and belong to one user (migration 004).
      if ((e as { code?: string }).code !== "23505") throw e;
      throw new Refused(409, "another user already has that GitHub login");
    }
    return c.json({ ok: true }, 201);
  });

  return { app, close: feed.close };
}

/**
 * Reads the issuer's discovery document, then serves the API on `port`. Discovery with no jwks_uri rejects before
 * anything listens or touches the database.
 */
export async function startApi(d: ApiDeps, port: number = API_PORT): Promise<Api> {
  const jwks = await discoverJwks(d.issuer);
  const { app, close } = apiApp({ ...d, verify: bearerVerifier({ issuer: d.issuer, audience: d.audience, jwks }) });
  const server = createAdaptorServer({ fetch: app.fetch }) as Server;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "::", () => resolve());
  });
  return {
    server,
    async stop() {
      await close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Reads the API's settings from `env` and serves it on PORT, or 7402 when PORT isn't set. Every setting is checked
 * before anything connects or listens, so a missing one stops it with nothing started.
 */
export async function main(env: Record<string, string | undefined>): Promise<{ stop(): Promise<void> }> {
  const names = ["FACTORY_DB_URI", "FACTORY_BLOB", "OIDC_ISSUER", "API_AUDIENCE", "GITHUB_WEBHOOK_SECRET"];
  const unset = names.filter((name) => !env[name]);
  if (unset.length) throw new Error(`refusing to start the API: ${unset.join(", ")} ${unset.length === 1 ? "is" : "are"} not set`);
  const [dbUri, blob, issuer, audience, webhookSecret] = names.map((name) => env[name]!);
  const port = env.PORT ? Number(env.PORT) : API_PORT;
  if (!Number.isInteger(port) || port <= 0) throw new Error(`refusing to start the API: PORT ${env.PORT} isn't a port`);

  const pool = createPool(dbUri);
  try {
    const api = await startApi({ pool, issuer, audience, webhookSecret, readBlob: blobReader(blob), env: { ...env } }, port);
    console.log(`The orchestrator API answers on port ${port}.`);
    return {
      async stop() {
        await api.stop();
        await pool.end();
      },
    };
  } catch (e) {
    await pool.end();
    throw e;
  }
}

if (import.meta.main) {
  main(process.env).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
