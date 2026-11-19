// Step definitions for features/pbi-284-api-bearer-auth-roles.feature. The API runs in this process from
// src/api/main.ts's startApi on port 7402, on PBI 4's shared test database, as PBI 222's steps run the cell API from
// serveCellApi. A fake issuer on a free port publishes a discovery document and an RS256 key set, and signs the
// scenario's tokens with jose. A person's token carries their name as its subject. Stored blobs live in a map the
// API reads through ApiDeps.readBlob, so no blob account is needed.
//
// PBI 175's and 176's "{string} is a viewer", "an operator" and "an owner" key people on today's microsoft provider,
// with their name as subject and GitHub login. The API keys people on (issuer, subject), so when the API starts, any
// person known only by a provider is put under the configured issuer first. The people these steps add themselves
// name their issuer.
//
// The API's contract these steps read:
// - Every /v1 route answers JSON. GET /v1/floor carries `claudeToken.ageDays`, the whole days since
//   CLAUDE_TOKEN_CREATED_AT, and `workerHeartbeat`, the worker_heartbeat row's ticked_at as an ISO time.
// - GET /v1/items/{id} carries `canOperate`, true when the caller may operate.
// - GET /v1/blobs/<path> answers the stored text, under the same path pattern as today's /blobs.
// - POST /v1/overrides takes {kind, value, reason}. A WIP limit override is kind "wip" with the limit as its value,
//   stored as one active factory override row of kind 'wip' whose value is the limit.
// - POST /v1/users takes {issuer, subject, role, github_login, product_owner}.
// - POST /v1/items/{id}/decisions takes {kind, text}, kind being approve, changes or answer, under decide's rules.
// - POST /webhooks/github is today's handleWebhook, checked by its signature and never by a bearer token.
// - startApi rejects, before it listens, when the issuer's discovery document has no jwks_uri, naming jwks_uri.
// PBI 285's steps (features/steps/pbi-285.steps.ts) share this context, these hooks and the steps above.
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import pg from "pg";
import { ctx as pbi175 } from "./pbi-175.steps.ts";
import { load, long, need, testDb } from "./pbi-8.steps.ts";

export const PORT = 7402;
export const WEBHOOK_SECRET = "pbi-284-webhook-secret";
const OTHER_ISSUER = "http://other-issuer.test/realms/elsewhere";
const KID = "pbi-284-key";

type Serving = { server: Server; stop(): Promise<void> };
type ApiModule = { startApi?: (d: object, port: number) => Promise<Serving> };
export type Reply = { status: number | null; text: string; json?: unknown; error?: string };

export type Ctx = {
  issuer?: Server;
  issuerUrl?: string;
  /** False once "the fake issuer's discovery document has no jwks_uri". */
  publishJwks: boolean;
  audience?: string;
  env: Record<string, string>;
  blobs: Map<string, string>;
  items: Map<string, string>;
  transcript?: { path: string; text: string };
  heartbeat?: Date;
  api?: Serving;
  startError?: unknown;
  started: boolean;
  /** True for a scenario tagged @db, whose "fresh factory database" step may be PBI 222's, so the API gets the database. */
  db: boolean;
  /** Each person's last token, so "again with the same token" sends it. */
  tokens: Map<string, string>;
  reply?: Reply;
  delivery?: string;
  /** Statuses a When-position "the API answers" expected of the replies it read, checked by every later Then. */
  checks: { status: number; reply: Reply }[];
};

export function ctx(world: object): Ctx {
  const w = world as { pbi284?: Ctx };
  w.pbi284 ??= { publishJwks: true, env: {}, blobs: new Map(), items: new Map(), tokens: new Map(), started: false, db: false, checks: [] };
  return w.pbi284;
}

const pool = () => need().pool;

// One published key and one the issuer never publishes, made once for the run.
let keys: Promise<{ published: CryptoKey; unpublished: CryptoKey; jwk: JWK }> | undefined;
function signingKeys() {
  keys ??= (async () => {
    const a = await generateKeyPair("RS256", { extractable: true });
    const b = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(a.publicKey)), kid: KID, alg: "RS256", use: "sig" };
    return { published: a.privateKey, unpublished: b.privateKey, jwk };
  })();
  return keys;
}

Before({ tags: "(@pbi-284 or @pbi-285) and @db" }, function () {
  ctx(this).db = true;
});

After({ tags: "@pbi-284 or @pbi-285", ...long }, async function () {
  const c = ctx(this);
  await c.api?.stop();
  if (c.issuer) {
    c.issuer.closeAllConnections();
    await new Promise((resolve) => c.issuer!.close(resolve));
  }
});

// ---- the fake issuer and tokens ----

type Claims = { iss?: string; aud?: string | null; sub: string; expiresIn?: number };

async function sign(c: Ctx, claims: Claims, key: "published" | "unpublished" = "published"): Promise<string> {
  assert.ok(c.issuerUrl, "no fake issuer is running");
  const k = await signingKeys();
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({}).setProtectedHeader({ alg: "RS256", kid: KID, typ: "JWT" })
    .setIssuer(claims.iss ?? c.issuerUrl).setSubject(claims.sub).setIssuedAt(now - 120)
    .setExpirationTime(now + (claims.expiresIn ?? 300));
  if (claims.aud !== null) jwt.setAudience(claims.aud ?? c.audience ?? "factory-api");
  return jwt.sign(key === "published" ? k.published : k.unpublished);
}

/** A valid token for `name`, remembered as their last one. */
export async function validToken(c: Ctx, name: string): Promise<string> {
  const token = await sign(c, { sub: name });
  c.tokens.set(name, token);
  return token;
}

/** A token for `name` with the flaw an Examples row names. */
async function flawed(c: Ctx, name: string, flaw: string): Promise<string> {
  switch (flaw) {
    case "names another issuer": return sign(c, { sub: name, iss: OTHER_ISSUER });
    case "carries no audience": return sign(c, { sub: name, aud: null });
    case "is signed by a key the issuer doesn't publish": return sign(c, { sub: name }, "unpublished");
    case "expired a minute ago": return sign(c, { sub: name, expiresIn: -60 });
    case "isn't a JWT at all": return "not-a-jwt";
    case "has had its payload altered after signing": {
      const [head, body, sig] = (await sign(c, { sub: name })).split(".");
      const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      // Another hour of life: the claims still pass every check but the signature.
      claims.exp += 3600;
      return [head, Buffer.from(JSON.stringify(claims)).toString("base64url"), sig].join(".");
    }
  }
  const aud = /^is for the audience "(.+)"$/.exec(flaw);
  if (aud) return sign(c, { sub: name, aud: aud[1] });
  throw new Error(`no such token flaw: ${flaw}`);
}

Given("a fake issuer publishing a discovery document and its signing keys", long, async function () {
  const c = ctx(this);
  const { jwk } = await signingKeys();
  c.issuer = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const send = (body: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (path.endsWith("/.well-known/openid-configuration")) {
      send({
        issuer: c.issuerUrl,
        authorization_endpoint: `${c.issuerUrl}/protocol/openid-connect/auth`,
        token_endpoint: `${c.issuerUrl}/protocol/openid-connect/token`,
        ...(c.publishJwks ? { jwks_uri: `${c.issuerUrl}/protocol/openid-connect/certs` } : {}),
        id_token_signing_alg_values_supported: ["RS256"],
      });
    } else if (path.endsWith("/protocol/openid-connect/certs") && c.publishJwks) {
      send({ keys: [jwk] });
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => c.issuer!.listen(0, "127.0.0.1", () => resolve()));
  c.issuerUrl = `http://127.0.0.1:${(c.issuer.address() as AddressInfo).port}/realms/factory`;
});

Given("the API is configured with that issuer and the audience {string}", function (audience: string) {
  ctx(this).audience = audience;
});

Given("the fake issuer's discovery document has no jwks_uri", function () {
  ctx(this).publishJwks = false;
});

// ---- the database ----

async function fresh(c: Ctx, items: { name: string; state: string; question?: "sign_off" | "needs_input" }[] = []): Promise<void> {
  const d = await testDb();
  assert.ok(d, "src/store/test-db.ts doesn't exist");
  c.db = true;
  await d.pool.query(`truncate item, event, "user", backlog_source, repo, webhook_delivery, override, worker_heartbeat cascade`);
  await d.pool.query("update wip_policy set usage_paused_until = null, current_wip = 1");
  if (!items.length) return;
  const source = (await d.pool.query<{ id: string }>(
    "insert into backlog_source (adapter, url) values ('fake', 'pbi-284:' || gen_random_uuid()) returning id")).rows[0].id;
  for (const [i, it] of items.entries()) {
    const id = (await d.pool.query<{ id: string }>(
      "insert into item (source_id, external_id, title, state) values ($1, $2, $3, $4) returning id",
      [source, String(284_000 + i), `item ${it.name}`, it.state])).rows[0].id;
    c.items.set(it.name, id);
    if (!it.question) continue;
    await d.pool.query("insert into run (item_id, next_stage, scenarios_sha) values ($1, $2, 'abc123')", [id, it.question === "sign_off" ? "sign-off" : "green"]);
    await d.pool.query("insert into question (item_id, kind, body) values ($1, $2, $3)",
      [id, it.question, it.question === "sign_off" ? "Please sign off the scenarios." : "Which port should the API use?"]);
  }
}

export function itemId(c: Ctx, name: string): string {
  const id = c.items.get(name);
  assert.ok(id, `no item "${name}"`);
  return id;
}

Given("a fresh factory database with item {string}", long, async function (name: string) {
  await fresh(ctx(this), [{ name, state: "InProgress" }]);
});

Given("a fresh factory database where item {string} waits in SignOff", long, async function (name: string) {
  await fresh(ctx(this), [{ name, state: "SignOff", question: "sign_off" }]);
});

Given("a fresh factory database where item {string} waits in NeedsInput with a question", long, async function (name: string) {
  await fresh(ctx(this), [{ name, state: "NeedsInput", question: "needs_input" }]);
});

Given("item {string}'s run has a stored transcript", long, async function (name: string) {
  const c = ctx(this);
  const id = itemId(c, name);
  const run = (await pool().query<{ id: string }>("insert into run (item_id, next_stage) values ($1, 'red') returning id", [id])).rows[0].id;
  const path = `transcripts/${run}/red-1.jsonl`;
  await pool().query("insert into stage_run (run_id, stage_id, attempt, status, transcript_ref) values ($1, 'red', 1, 'passed', $2)", [run, path]);
  const text = `${JSON.stringify({ type: "assistant", message: "Wrote the step definitions." })}\n`;
  c.blobs.set(path, text);
  c.transcript = { path, text };
});

Given("the Claude token was created {int} days ago", function (days: number) {
  ctx(this).env.CLAUDE_TOKEN_CREATED_AT = new Date(Date.now() - days * 86_400_000 - 3_600_000).toISOString();
});

Given("the worker last sent a heartbeat a moment ago", long, async function () {
  const c = ctx(this);
  c.heartbeat = new Date(Date.now() - 2_000);
  await pool().query("insert into worker_heartbeat (ticked_at) values ($1)", [c.heartbeat]);
});

// ---- people ----

async function person(c: Ctx, name: string, role: string, productOwner: boolean, issuer?: string): Promise<void> {
  assert.ok(c.issuerUrl, "no fake issuer is running");
  await pool().query(
    `insert into "user" (issuer, subject, github_login, role, product_owner) values ($1, $2, $2, $3, $4)`,
    [issuer ?? c.issuerUrl, name, role, productOwner]);
}

Given("{string} is a viewer who is the Product Owner", long, async function (name: string) {
  await person(ctx(this), name, "viewer", true);
});

Given("{string} is a viewer who isn't the Product Owner", long, async function (name: string) {
  await person(ctx(this), name, "viewer", false);
});

Given("{string} is an owner who isn't the Product Owner", long, async function (name: string) {
  await person(ctx(this), name, "owner", false);
});

Given("{string} is a viewer known through another issuer", long, async function (name: string) {
  await person(ctx(this), name, "viewer", false, OTHER_ISSUER);
});

Given("{string} holds a valid token but is not a user", long, async function (name: string) {
  const c = ctx(this);
  await validToken(c, name);
  const n = (await pool().query(`select count(*)::int as n from "user" where subject = $1 or github_login = $1`, [name])).rows[0].n;
  assert.equal(n, 0, `"${name}" is in the user table`);
});

When("{string} is removed from the user table", long, async function (name: string) {
  const r = await pool().query(`delete from "user" where subject = $1 or github_login = $1`, [name]);
  assert.equal(r.rowCount, 1, `"${name}" wasn't one user`);
});

// ---- starting the API ----

When("the API starts from src\\/api\\/main.ts", long, async function () {
  const c = ctx(this);
  assert.ok(c.issuerUrl && c.audience, "the API isn't configured with an issuer and an audience");
  const mod = await load<ApiModule>("src/api/main.ts");
  assert.ok(mod?.startApi, "src/api/main.ts has no startApi");
  const db = c.db ? need() : null;
  // People PBI 175's and 176's steps added by provider alone are known through the configured issuer here.
  if (db) await db.pool.query(`update "user" set issuer = $1 where issuer is null`, [c.issuerUrl]);
  // The scenario with no @db has no database to reach, and the API must refuse before it touches one.
  const apiPool = db?.pool ?? new pg.Pool({ connectionString: "postgres://nobody@127.0.0.1:9/none", connectionTimeoutMillis: 1_000 });
  c.started = true;
  try {
    c.api = await mod.startApi({
      pool: apiPool, issuer: c.issuerUrl, audience: c.audience, webhookSecret: WEBHOOK_SECRET,
      readBlob: async (path: string) => c.blobs.get(path) ?? null,
      env: { ...c.env },
    }, PORT);
  } catch (e) {
    c.startError = e;
  } finally {
    if (!db) await apiPool.end();
  }
});

Then("it exits with an error naming jwks_uri", function () {
  const c = ctx(this);
  assert.ok(c.started, "the API wasn't started");
  assert.ok(c.startError, "the API started although the discovery document has no jwks_uri");
  assert.match(String((c.startError as Error).message ?? c.startError), /jwks_uri/);
});

// ---- requests ----

async function call(world: object, method: string, path: string, opts: { auth?: string; body?: unknown; raw?: Buffer; headers?: Record<string, string> } = {}): Promise<void> {
  const c = ctx(world);
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.auth !== undefined) headers.authorization = opts.auth;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      method, headers, redirect: "manual",
      body: opts.raw ? new Uint8Array(opts.raw) : (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
    });
    // An event stream stays open for minutes, so only its first chunk is read.
    const stream = (r.headers.get("content-type") ?? "").includes("text/event-stream");
    const text = stream ? await firstChunk(r) : await r.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    c.reply = { status: r.status, text, json };
  } catch (e) {
    // Nothing answered. The Then that reads the reply fails on it.
    c.reply = { status: null, text: "", error: String((e as Error).cause ?? e) };
  }
}

async function firstChunk(r: Response): Promise<string> {
  const reader = r.body!.getReader();
  const { value } = await reader.read();
  await reader.cancel();
  return new TextDecoder().decode(value);
}

const bearer = (token: string) => `Bearer ${token}`;

/** "GET /v1/items/A" as a method and a path, with each item name after /items/ swapped for its id. */
function route(c: Ctx, text: string): { method: string; path: string } {
  const [method, path] = text.split(" ");
  return { method, path: path.replace(/\/items\/([^/]+)/, (_m, name: string) => `/items/${c.items.get(name) ?? name}`) };
}

When("{string} asks port {int} for {string} with a valid token", long, async function (name: string, _port: number, text: string) {
  const c = ctx(this);
  const { method, path } = route(c, text);
  await call(this, method, path, { auth: bearer(await validToken(c, name)) });
});

When("{string} asks port {int} for item {string}'s transcript under \\/v1\\/blobs with a valid token", long, async function (name: string, _port: number, item: string) {
  const c = ctx(this);
  itemId(c, item);
  assert.ok(c.transcript, `item "${item}" has no stored transcript`);
  await call(this, "GET", `/v1/blobs/${c.transcript.path}`, { auth: bearer(await validToken(c, name)) });
});

When("{string} asks port {int} for the floor with a valid token", long, async function (name: string, _port: number) {
  await call(this, "GET", "/v1/floor", { auth: bearer(await validToken(ctx(this), name)) });
});

When("{string} asks port {int} for the floor again with the same token", long, async function (name: string, _port: number) {
  const token = ctx(this).tokens.get(name);
  assert.ok(token, `"${name}" hasn't sent a token yet`);
  await call(this, "GET", "/v1/floor", { auth: bearer(token) });
});

When("{string} asks port {int} for item {string} with a valid token", long, async function (name: string, _port: number, item: string) {
  const c = ctx(this);
  await call(this, "GET", `/v1/items/${itemId(c, item)}`, { auth: bearer(await validToken(c, name)) });
});

When("someone asks port {int} for the floor with no Authorization header", long, async function (_port: number) {
  await call(this, "GET", "/v1/floor");
});

When(/^"([^"]*)" asks port (\d+) for the floor with a token that (.+)$/, long, async function (name: string, _port: string, flaw: string) {
  await call(this, "GET", "/v1/floor", { auth: bearer(await flawed(ctx(this), name, flaw)) });
});

When("{string} sends a valid token to port {int} under the {string} scheme", long, async function (name: string, _port: number, scheme: string) {
  await call(this, "GET", "/v1/floor", { auth: `${scheme} ${await validToken(ctx(this), name)}` });
});

When("a valid token from the configured issuer carrying {string}'s subject asks port {int} for the floor", long, async function (name: string, _port: number) {
  await call(this, "GET", "/v1/floor", { auth: bearer(await validToken(ctx(this), name)) });
});

const WIP_OVERRIDE = (limit: number) => ({ kind: "wip", value: limit, reason: "PBI 284: hold the factory at a fixed WIP" });

When("{string} sets the WIP limit override to {int} through port {int} with a valid token", long, async function (name: string, limit: number, _port: number) {
  await call(this, "POST", "/v1/overrides", { auth: bearer(await validToken(ctx(this), name)), body: WIP_OVERRIDE(limit) });
});

const NEW_VIEWER = (c: Ctx, name: string) => ({ issuer: c.issuerUrl, subject: name, role: "viewer", github_login: name, product_owner: false });

When("{string} adds {string} as a viewer through port {int} with a valid token", long, async function (name: string, added: string, _port: number) {
  const c = ctx(this);
  await call(this, "POST", "/v1/users", { auth: bearer(await validToken(c, name)), body: NEW_VIEWER(c, added) });
});

When("{string} adds {string} as a viewer through port {int} with a token that expired a minute ago", long, async function (name: string, added: string, _port: number) {
  const c = ctx(this);
  await call(this, "POST", "/v1/users", { auth: bearer(await flawed(c, name, "expired a minute ago")), body: NEW_VIEWER(c, added) });
});

When("{string} signs off item {string} through port {int} with a valid token", long, async function (name: string, item: string, _port: number) {
  const c = ctx(this);
  await call(this, "POST", `/v1/items/${itemId(c, item)}/decisions`, { auth: bearer(await validToken(c, name)), body: { kind: "approve", text: "" } });
});

When("{string} answers item {string}'s question through port {int} with a valid token", long, async function (name: string, item: string, _port: number) {
  const c = ctx(this);
  await call(this, "POST", `/v1/items/${itemId(c, item)}/decisions`, { auth: bearer(await validToken(c, name)), body: { kind: "answer", text: "Port 7402." } });
});

async function webhook(world: object, secret: string): Promise<void> {
  const c = ctx(world);
  c.delivery = randomUUID();
  const body = Buffer.from(JSON.stringify({
    action: "created", repository: { full_name: "octo/repo" }, issue: { number: 284 },
    comment: { id: 2840, body: "Looks good.", user: { login: "someone", type: "User" } },
  }));
  await call(world, "POST", "/webhooks/github", {
    raw: body,
    headers: {
      "content-type": "application/json", "x-github-event": "issue_comment", "x-github-delivery": c.delivery,
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    },
  });
}

When("GitHub delivers a comment webhook to port {int} signed with the webhook secret and no bearer token", long, async function (_port: number) {
  await webhook(this, WEBHOOK_SECRET);
});

When("GitHub delivers a comment webhook to port {int} signed with another secret", long, async function (_port: number) {
  await webhook(this, "another-secret");
});

// ---- what the API answered ----

const said = (r: Reply) => `${r.status ?? r.error}: ${r.text.slice(0, 300)}`;

/** The status each When-position "the API answers" expected, asserted once the scenario reaches its outcome. */
function checked(c: Ctx): void {
  for (const k of c.checks) assert.equal(k.reply.status, k.status, `earlier, the API answered ${said(k.reply)}`);
}

function reply(c: Ctx): Reply {
  assert.ok(c.started, "the API wasn't started");
  assert.ok(!c.startError, `the API didn't start: ${String((c.startError as Error)?.message ?? c.startError)}`);
  assert.ok(c.reply, "nothing was asked of the API");
  checked(c);
  return c.reply;
}

function body(c: Ctx): Record<string, unknown> {
  const r = reply(c);
  assert.equal(r.status, 200, `the API answered ${said(r)}`);
  assert.ok(r.json && typeof r.json === "object", `the API's answer isn't a JSON object: ${said(r)}`);
  return r.json as Record<string, unknown>;
}

// As a When ("And the API answers 200" between two requests) it records what the reply must have been, and the
// scenario's Thens assert it, so a step that sets the scene doesn't decide the scenario before its outcome.
Then("the API answers {int}", function (status: number) {
  const c = ctx(this);
  if (pbi175(this).stepType === "Action") {
    assert.ok(c.reply, "nothing was asked of the API");
    c.checks.push({ status, reply: c.reply });
    return;
  }
  const r = reply(c);
  assert.equal(r.status, status, `the API answered ${said(r)}`);
});

Then("the API accepts it", function () {
  const r = reply(ctx(this));
  assert.ok(r.status !== null && [200, 201, 204].includes(r.status), `the API answered ${said(r)}`);
});

Then("the body is the stored transcript", function () {
  const c = ctx(this);
  const r = reply(c);
  assert.equal(r.status, 200, `the API answered ${said(r)}`);
  assert.equal(r.text, c.transcript?.text);
});

Then("the floor shows the Claude token's age", function () {
  const token = body(ctx(this)).claudeToken as { ageDays?: unknown } | undefined;
  assert.equal(token?.ageDays, 80, `the floor's claudeToken is ${JSON.stringify(token)}`);
});

Then("the floor shows the worker's last heartbeat", function () {
  const c = ctx(this);
  const at = body(c).workerHeartbeat;
  assert.equal(typeof at, "string", `the floor's workerHeartbeat is ${JSON.stringify(at)}`);
  assert.equal(Date.parse(at as string), c.heartbeat!.getTime());
});

Then("the response says {string} may not operate", function (_name: string) {
  const b = body(ctx(this));
  assert.equal(b.canOperate, false, `canOperate is ${JSON.stringify(b.canOperate)}`);
});

Then("the response says {string} may operate", function (_name: string) {
  const b = body(ctx(this));
  assert.equal(b.canOperate, true, `canOperate is ${JSON.stringify(b.canOperate)}`);
});

Then("the WIP limit override is {int}", long, async function (limit: number) {
  const rows = (await pool().query<{ value: unknown }>(
    "select value from override where scope = 'factory' and kind = 'wip' and cleared_at is null")).rows;
  assert.deepEqual(rows.map((r) => r.value), [limit]);
});

Then("no override was recorded", long, async function () {
  assert.equal((await pool().query("select count(*)::int as n from override")).rows[0].n, 0);
});

Then("{string} is not a user", long, async function (name: string) {
  const n = (await pool().query(`select count(*)::int as n from "user" where subject = $1 or github_login = $1`, [name])).rows[0].n;
  assert.equal(n, 0, `"${name}" is in the user table`);
});

type SignOff = { state: string; answer: string | null; decision: string | null; next_stage: string | null };
async function signOff(c: Ctx, name: string): Promise<SignOff> {
  return (await pool().query<SignOff>(
    `select i.state, q.answer, q.decision, (select next_stage from run where item_id = i.id and ended_at is null order by started_at desc limit 1) as next_stage
     from item i join question q on q.item_id = i.id and q.kind = 'sign_off' where i.id = $1`, [itemId(c, name)])).rows[0];
}

// An approval answers the sign-off question and points the run at Red. The scheduler's next claim moves the state
// out of SignOff, so with no scheduler here, leaving SignOff means the item no longer waits there for a sign-off.
Then("item {string} leaves SignOff", long, async function (name: string) {
  const s = await signOff(ctx(this), name);
  assert.equal(s.decision, "approve", `the sign-off question is ${JSON.stringify(s)}`);
  assert.equal(s.next_stage, "red");
});

Then("item {string} is still in SignOff", long, async function (name: string) {
  const s = await signOff(ctx(this), name);
  assert.equal(s.state, "SignOff");
  assert.equal(s.answer, null, `the sign-off question was answered: ${JSON.stringify(s)}`);
  assert.equal(s.next_stage, "sign-off");
});

async function question(c: Ctx, name: string): Promise<{ answer: string | null; answered_by: string | null }> {
  return (await pool().query("select answer, answered_by from question where item_id = $1 and kind = 'needs_input'", [itemId(c, name)])).rows[0];
}

Then("item {string}'s question is answered", long, async function (name: string) {
  const q = await question(ctx(this), name);
  assert.equal(q.answer, "Port 7402.");
  assert.ok(q.answered_by, "nobody is recorded as answering");
});

Then("item {string}'s question is still open", long, async function (name: string) {
  const q = await question(ctx(this), name);
  assert.equal(q.answer, null, "the question was answered");
});

async function webhookEvents(c: Ctx): Promise<{ deliveries: number; events: number }> {
  const deliveries = (await pool().query("select count(*)::int as n from webhook_delivery where id = $1", [c.delivery])).rows[0].n;
  const events = (await pool().query("select count(*)::int as n from event where kind = 'webhook' and payload->>'deliveryId' = $1", [c.delivery])).rows[0].n;
  return { deliveries, events };
}

Then("a webhook event is recorded for that delivery", long, async function () {
  assert.deepEqual(await webhookEvents(ctx(this)), { deliveries: 1, events: 1 });
});

Then("no webhook event is recorded", long, async function () {
  assert.deepEqual(await webhookEvents(ctx(this)), { deliveries: 0, events: 0 });
});
