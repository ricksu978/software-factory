// Step definitions for features/pbi-281-bff-cut-over.feature, redesign step 9a.
// The untagged scenarios read the repo: the AppHost, the docs, and the source files, step definitions and package
// scripts, with comments left out, so a file that only mentions an old path in prose doesn't count as using it.
// The @db scenarios run the API from src/api/main.ts and the BFF from src/bff/main.ts in this process, the BFF on
// port 7400 as the scenarios say, on PBI 4's shared test database, against a fake OIDC provider started here. The
// "started without a port" scenario runs src/bff/main.ts as its own process from the environment it sets, as Aspire
// does. Every When records what happened rather than throwing, so a scenario fails on the Then that checks it.
// The @local scenarios drive `aspire run` with pinned ports and Keycloak on 7430. The owner runs them.
// "I read the AppHost" is PBI 169's, "a fresh factory database" and "nothing answers on port …" are PBI 222's, and
// "\"aspire run\" is up" is PBI 6's.
import { After, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, createHmac, generateKeyPairSync, randomBytes, sign as rsaSign, type KeyObject } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { parseGitHubWebhook } from "../../src/adapters/github/backlog.ts";
import { main as apiMain } from "../../src/api/main.ts";
import { main as bffMain } from "../../src/bff/main.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";

const repo = process.cwd();
const APPHOST_FILE = join(repo, "aspire-apphost", "apphost.mts");
const APPHOST = "--apphost . --non-interactive --nologo";
const BFF_PORT = 7400;
const AUDIENCE = "factory-api";
const CLIENT_ID = "dashboard";
const CLIENT_SECRET = "dashboard-secret";
const OWNER_SUBJECT = "pbi-281-owner";
const DEV_LOGIN = "owner";
const BLOB = "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=a2V5;BlobEndpoint=http://127.0.0.1:7410/devstoreaccount1;";

type Reply = { status: number; headers: IncomingHttpHeaders; body: Buffer };
type Outcome = Reply | { error: string };
type Stoppable = { stop(): Promise<void> };
type Delivery = { id: string; body: Buffer; headers: Record<string, string> };

type FakeIdp = {
  issuer: string;
  authorizationEndpoint: string;
  server: Server;
  /** Each authorization request's query, in order. */
  authorizations: URLSearchParams[];
};

type Ctx = {
  idp?: FakeIdp;
  webhookSecret?: string;
  api?: Stoppable;
  apiUrl?: string;
  bff?: Stoppable;
  bffEnv?: Record<string, string>;
  child?: ChildProcess;
  childExit?: { code: number | null };
  childOut: string;
  /** What the BFF answered each call a When made, in order. */
  replies: Outcome[];
  deliveries: Delivery[];
  /** The sign-in flow's last answer from the BFF's /auth/callback. */
  callback?: Outcome;
  /** Cookies the browser holds, per host:port. */
  jar: Map<string, Map<string, string>>;
  // Reading the repo.
  lookedFor?: { path: string; there: boolean };
  files?: string[];
  scripts?: string[];
  docs?: Record<string, string | null>;
  // aspire run.
  started?: boolean;
  bffHealthy?: boolean;
  resources?: string[];
  page?: { url: string; reply: Outcome };
  backOn?: { url: string; reply: Outcome };
};

function ctx(world: object): Ctx {
  const w = world as { pbi281?: Ctx };
  w.pbi281 ??= { childOut: "", replies: [], deliveries: [], jar: new Map() };
  return w.pbi281;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const failed = (o: Outcome | undefined): o is { error: string } | undefined => !o || "error" in o;

After({ tags: "@pbi-281", ...long }, async function () {
  const c = ctx(this);
  await c.bff?.stop().catch(() => undefined);
  await c.api?.stop().catch(() => undefined);
  if (c.child && c.childExit === undefined) {
    const gone = new Promise((r) => c.child!.once("exit", r));
    c.child.kill();
    await gone;
  }
  if (c.idp) await new Promise((r) => c.idp!.server.close(r));
  if (c.started) spawnSync(`aspire stop ${APPHOST}`, { cwd: repo, shell: true });
});

// ---- HTTP, as a browser or GitHub would send it ----

/** One request with exactly the headers given: no Origin, no cookie and no redirect following unless asked. */
function send(url: string, opts: { method?: string; headers?: Record<string, string>; body?: Buffer } = {}): Promise<Outcome> {
  return new Promise((done) => {
    const req = request(url, { method: opts.method ?? "GET", headers: opts.headers ?? {}, timeout: 15_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (d: Buffer) => chunks.push(d));
      res.on("end", () => done({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", (e) => done({ error: e.message }));
    });
    req.on("timeout", () => req.destroy(new Error(`no answer from ${url} in 15 s`)));
    req.on("error", (e) => done({ error: `${url}: ${e.message}` }));
    req.end(opts.body);
  });
}

function setCookies(r: Reply): string[] {
  const h = r.headers["set-cookie"];
  return h === undefined ? [] : Array.isArray(h) ? h : [h];
}

function hostKey(url: string): string {
  const u = new URL(url);
  return `${u.hostname === "127.0.0.1" ? "localhost" : u.hostname}:${u.port}`;
}

function remember(c: Ctx, url: string, r: Reply): void {
  const jar = c.jar.get(hostKey(url)) ?? new Map<string, string>();
  for (const line of setCookies(r)) {
    const [pair, ...attrs] = line.split(";");
    const at = pair.indexOf("=");
    const name = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    const gone = value === "" || attrs.some((a) => /^\s*max-age\s*=\s*0\s*$/i.test(a));
    if (gone) jar.delete(name);
    else jar.set(name, value);
  }
  c.jar.set(hostKey(url), jar);
}

function cookieHeader(c: Ctx, url: string): Record<string, string> {
  const jar = c.jar.get(hostKey(url));
  return jar && jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {};
}

/** A browser's GET: its cookies for that host go along, and the cookies it's given are kept. */
async function browse(c: Ctx, url: string, opts: { method?: string; headers?: Record<string, string>; body?: Buffer } = {}): Promise<Outcome> {
  const r = await send(url, { ...opts, headers: { ...cookieHeader(c, url), ...(opts.headers ?? {}) } });
  if (!failed(r)) remember(c, url, r);
  return r;
}

/** Follows redirects as a browser does, keeping each host's cookies, until a page that isn't a redirect. */
async function follow(c: Ctx, url: string, first?: Outcome): Promise<{ url: string; reply: Outcome }> {
  let at = url;
  let r = first ?? (await browse(c, at));
  for (let hops = 0; hops < 20 && !failed(r) && r.status >= 300 && r.status < 400 && r.headers.location; hops++) {
    at = new URL(r.headers.location, at).href;
    r = await browse(c, at);
  }
  return { url: at, reply: r };
}

/** True when something accepts a TCP connection on `port`, over IPv4 or IPv6. */
async function answers(port: number): Promise<boolean> {
  const on = (host: string) => new Promise<boolean>((done) => {
    const s = connect({ host, port, timeout: 2_000 });
    s.once("connect", () => { s.destroy(); done(true); });
    s.once("error", () => done(false));
    s.once("timeout", () => { s.destroy(); done(false); });
  });
  return (await on("127.0.0.1")) || (await on("::1"));
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

function describeOutcome(o: Outcome | undefined): string {
  if (!o) return "no call was made";
  if ("error" in o) return `the call failed: ${o.error}`;
  return `status ${o.status}`;
}

// ---- A fake OIDC provider: discovery, authorize, token and JWKS ----

function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString("base64url");
}

function jwt(key: KeyObject, kid: string, claims: Record<string, unknown>): string {
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const body = b64url(JSON.stringify(claims));
  return `${head}.${body}.${b64url(rsaSign("sha256", Buffer.from(`${head}.${body}`), key))}`;
}

async function startIdp(c: Ctx): Promise<FakeIdp> {
  if (c.idp) return c.idp;
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "pbi-281";
  const codes = new Map<string, { clientId: string; redirectUri: string; nonce: string | null; challenge: string | null }>();
  const authorizations: URLSearchParams[] = [];
  let issuer = "";
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", issuer);
      const json = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      if (url.pathname === "/.well-known/openid-configuration") {
        return json(200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          code_challenge_methods_supported: ["S256"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
          scopes_supported: ["openid", "profile", "email"],
        });
      }
      if (url.pathname === "/jwks") return json(200, { keys: [{ ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" }] });
      if (url.pathname === "/authorize") {
        authorizations.push(url.searchParams);
        const q = url.searchParams;
        const redirectUri = q.get("redirect_uri");
        if (q.get("client_id") !== CLIENT_ID || !redirectUri || q.get("response_type") !== "code") return json(400, { error: "invalid_request" });
        // The owner is already signed in at the provider, so it answers at once, as a provider with a live session does.
        const code = randomBytes(16).toString("hex");
        codes.set(code, { clientId: CLIENT_ID, redirectUri, nonce: q.get("nonce"), challenge: q.get("code_challenge") });
        const back = new URL(redirectUri);
        back.searchParams.set("code", code);
        if (q.get("state") !== null) back.searchParams.set("state", q.get("state")!);
        back.searchParams.set("iss", issuer);
        return res.writeHead(302, { location: back.href }).end();
      }
      if (url.pathname === "/token" && req.method === "POST") {
        const form = new URLSearchParams(raw);
        const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? "");
        const [id, secret] = basic
          ? Buffer.from(basic[1], "base64").toString("utf8").split(":").map(decodeURIComponent)
          : [form.get("client_id"), form.get("client_secret")];
        if (id !== CLIENT_ID || secret !== CLIENT_SECRET) return json(401, { error: "invalid_client" });
        const now = Math.floor(Date.now() / 1000);
        const tokens = (nonce: string | null) => ({
          token_type: "Bearer",
          expires_in: 300,
          scope: "openid",
          refresh_token: randomBytes(16).toString("hex"),
          access_token: jwt(privateKey, kid, { iss: issuer, sub: OWNER_SUBJECT, aud: AUDIENCE, azp: CLIENT_ID, iat: now, exp: now + 300 }),
          id_token: jwt(privateKey, kid, { iss: issuer, sub: OWNER_SUBJECT, aud: CLIENT_ID, iat: now, exp: now + 300, ...(nonce ? { nonce } : {}) }),
        });
        if (form.get("grant_type") === "refresh_token") return json(200, tokens(null));
        const grant = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        if (!grant || grant.redirectUri !== form.get("redirect_uri")) return json(400, { error: "invalid_grant" });
        if (grant.challenge !== null) {
          const verifier = form.get("code_verifier") ?? "";
          if (b64url(createHash("sha256").update(verifier).digest()) !== grant.challenge) return json(400, { error: "invalid_grant" });
        }
        return json(200, tokens(grant.nonce));
      }
      json(404, { error: "not_found" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  c.idp = { issuer, authorizationEndpoint: `${issuer}/authorize`, server, authorizations };
  return c.idp;
}

// ---- The database, the API and the BFF ----

async function fresh(): Promise<void> {
  const d = await testDb();
  assert.ok(d, "src/store/test-db.ts doesn't exist");
  await d.pool.query(`truncate item, "user", backlog_source, repo, webhook_delivery, override, session cascade`);
  await d.pool.query("update wip_policy set usage_paused_until = null, current_wip = 1");
}

const dbUrl = () => (need() as unknown as { url: string }).url;

async function startApi(c: Ctx): Promise<void> {
  if (c.api) return;
  const idp = await startIdp(c);
  const port = await freePort();
  c.apiUrl = `http://127.0.0.1:${port}`;
  c.api = await apiMain({
    PORT: String(port),
    FACTORY_DB_URI: dbUrl(),
    FACTORY_BLOB: BLOB,
    GITHUB_WEBHOOK_SECRET: c.webhookSecret ?? "pbi-281-webhook-secret",
    OIDC_ISSUER: idp.issuer,
    API_AUDIENCE: AUDIENCE,
    CLAUDE_TOKEN_CREATED_AT: new Date().toISOString(),
  });
}

/** The BFF's settings, all but PORT. */
function bffEnv(c: Ctx): Record<string, string> {
  return {
    FACTORY_DB_URI: dbUrl(),
    API_URL: c.apiUrl!,
    OIDC_ISSUER: c.idp!.issuer,
    OIDC_CLIENT_ID: CLIENT_ID,
    OIDC_CLIENT_SECRET: CLIENT_SECRET,
    OIDC_SCOPES: "openid",
    BFF_SESSION_KEY: randomBytes(32).toString("base64"),
  };
}

async function bffOn7400(world: object, webhookSecret?: string): Promise<void> {
  const c = ctx(world);
  if (webhookSecret !== undefined) c.webhookSecret = webhookSecret;
  await startIdp(c);
  await startApi(c);
  c.bff = await bffMain({ ...bffEnv(c), PORT: String(BFF_PORT) });
}

// ---- Given ----

Given("a fresh factory database with an owner known to the fake identity provider", long, async function () {
  await fresh();
  const idp = await startIdp(ctx(this));
  await need().pool.query(`insert into "user" (issuer, subject, role) values ($1, $2, 'owner')`, [idp.issuer, OWNER_SUBJECT]);
});

Given("a fresh factory database with a dev owner", long, async function () {
  await fresh();
  await need().pool.query(`insert into "user" (provider, subject, github_login, role) values ('dev', $1, $1, 'owner')`, [DEV_LOGIN]);
});

Given("the BFF's environment doesn't set PORT", long, async function () {
  const c = ctx(this);
  await startIdp(c);
  await startApi(c);
  c.bffEnv = bffEnv(c);
});

Given("the BFF on port {int} in front of the API", long, async function (port: number) {
  assert.equal(port, BFF_PORT);
  await bffOn7400(this);
});

Given("the BFF on port {int} in front of the API, both sharing the webhook secret {string}", long, async function (port: number, secret: string) {
  assert.equal(port, BFF_PORT);
  await bffOn7400(this, secret);
});

Given("the BFF on port {int} in front of the API, pointed at a fake identity provider", long, async function (port: number) {
  assert.equal(port, BFF_PORT);
  await bffOn7400(this);
});

Given("the BFF on port {int} in front of the API, pointed at that fake identity provider", long, async function (port: number) {
  assert.equal(port, BFF_PORT);
  assert.ok(ctx(this).idp, "no fake identity provider was started");
  await bffOn7400(this);
});

// ---- When: the BFF as its own process ----

When("the BFF starts", long, async function () {
  const c = ctx(this);
  const child = spawn(process.execPath, ["src/bff/main.ts"], {
    cwd: repo,
    env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", ...c.bffEnv },
  });
  c.child = child;
  child.stdout.setEncoding("utf8").on("data", (d: string) => (c.childOut += d));
  child.stderr.setEncoding("utf8").on("data", (d: string) => (c.childOut += d));
  child.once("exit", (code) => (c.childExit = { code }));
  const end = Date.now() + 30_000;
  while (c.childExit === undefined && !(await answers(BFF_PORT)) && Date.now() < end) await sleep(200);
});

// ---- When: GitHub's webhook ----

/** An issue comment delivery, laid out unlike JSON.stringify would, so a BFF that re-encodes it changes its bytes. */
function commentDelivery(id: string): Buffer {
  const text = `{\n\t"action" : "created",\n\t"issue" : { "number" : 281 },\n\t"comment" : { "id" : "${id}", "body" : "caf\\u00e9 \\/approve", "user" : { "login" : "someone", "type" : "User" } },\n\t"repository" : { "full_name" : "ricksu978/software-factory" }\n}\n`;
  return Buffer.from(text, "utf8");
}

const signature = (secret: string, body: Buffer) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

async function post(c: Ctx, id: string, path: string, port: number, secret: string | null, body = commentDelivery(id)): Promise<void> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "GitHub-Hookshot/pbi-281",
    "x-github-event": "issue_comment",
    "x-github-delivery": id,
    "x-github-hook-id": "281",
  };
  if (secret !== null) headers["x-hub-signature-256"] = signature(secret, body);
  c.deliveries.push({ id, body, headers });
  c.replies.push(await send(`http://localhost:${port}${path}`, { method: "POST", headers, body }));
}

When("GitHub posts an issue comment delivery {string} to {string} on port {int}, signed with {string}", long, async function (id: string, path: string, port: number, secret: string) {
  await post(ctx(this), id, path, port, secret);
});

When("GitHub posts an issue comment delivery {string} to {string} on port {int} with no signature", long, async function (id: string, path: string, port: number) {
  await post(ctx(this), id, path, port, null);
});

When("GitHub posts an issue comment delivery {string} to {string} on port {int}, signed with {string}, with no session cookie and no Origin header", long, async function (id: string, path: string, port: number, secret: string) {
  // send() adds no header of its own, so the request carries neither a cookie nor an Origin.
  await post(ctx(this), id, path, port, secret);
});

When("GitHub posts delivery {string} again, signed with {string}", long, async function (id: string, secret: string) {
  const c = ctx(this);
  const first = c.deliveries.find((d) => d.id === id);
  assert.ok(first, `delivery "${id}" wasn't posted before`);
  await post(c, id, "/webhooks/github", BFF_PORT, secret, first.body);
});

// ---- When: signing in ----

When("a browser with no session asks port {int} for {string}", long, async function (port: number, path: string) {
  const c = ctx(this);
  c.replies.push(await browse(c, `http://localhost:${port}${path}`));
});

When("the owner starts sign-in on port {int} and the identity provider sends them back to {string} on port {int}", long, async function (port: number, path: string, backPort: number) {
  const c = ctx(this);
  const login = `http://localhost:${port}/auth/login`;
  const start = await browse(c, login);
  c.replies.push(start);
  if (failed(start) || !start.headers.location) return;
  const atIdp = await browse(c, new URL(start.headers.location, login).href);
  if (failed(atIdp) || !atIdp.headers.location) {
    c.callback = failed(atIdp) ? atIdp : { error: `the identity provider answered ${atIdp.status} with no redirect` };
    return;
  }
  // Wherever the provider was told to send them, the owner comes back to the path and port the scenario names.
  const sentTo = new URL(atIdp.headers.location);
  c.callback = await browse(c, `http://localhost:${backPort}${path}${sentTo.search}`);
});

// ---- Then: the BFF's answers ----

function only(c: Ctx): Reply {
  const r = c.replies.at(-1);
  assert.ok(!failed(r), `the BFF didn't answer: ${describeOutcome(r)}`);
  return r;
}

Then("the BFF answers with the API's success status", function () {
  const r = only(ctx(this));
  assert.ok(r.status >= 200 && r.status < 300, `the BFF answered ${r.status}, not a success status`);
});

Then("the BFF answers both with the API's success status", function () {
  const c = ctx(this);
  assert.equal(c.replies.length, 2, `${c.replies.length} deliveries were posted, not 2`);
  for (const [i, r] of c.replies.entries()) {
    assert.ok(!failed(r), `delivery ${i + 1}: ${describeOutcome(r)}`);
    assert.ok(r.status >= 200 && r.status < 300, `delivery ${i + 1}: the BFF answered ${r.status}, not a success status`);
  }
});

Then("the BFF answers {int}", function (status: number) {
  assert.equal(only(ctx(this)).status, status);
});

Then("the BFF answers on port {int}", long, async function (port: number) {
  const c = ctx(this);
  const r = await send(`http://127.0.0.1:${port}/`);
  assert.ok(!failed(r), `nothing answers HTTP on port ${port} (${describeOutcome(r)}); the BFF ${c.childExit ? `exited with code ${c.childExit.code}` : "is still running"}, saying: ${c.childOut.slice(-2000)}`);
});

// ---- Then: what the factory recorded ----

async function webhookEvents(delivery: string): Promise<{ payload: { deliveryId: string; githubEvent: string | null; event: unknown } }[]> {
  const r = await need().pool.query("select payload from event where kind = 'webhook' and payload->>'deliveryId' = $1", [delivery]);
  return r.rows;
}

Then("the factory has recorded one webhook event for delivery {string}", long, async function (delivery: string) {
  assert.equal((await webhookEvents(delivery)).length, 1, `webhook events for delivery "${delivery}"`);
  const seen = await need().pool.query("select 1 from webhook_delivery where id = $1", [delivery]);
  assert.equal(seen.rowCount, 1, `delivery "${delivery}" isn't recorded as received`);
});

Then("the factory has recorded no webhook event", long, async function () {
  const c = ctx(this);
  assert.ok(c.deliveries.length > 0, "no delivery was posted");
  // The scenario must have reached the BFF at all, or "nothing recorded" says nothing.
  only(c);
  for (const d of c.deliveries) {
    assert.equal((await webhookEvents(d.id)).length, 0, `a webhook event was recorded for delivery "${d.id}"`);
    const seen = await need().pool.query("select 1 from webhook_delivery where id = $1", [d.id]);
    assert.equal(seen.rowCount, 0, `delivery "${d.id}" is recorded as received`);
  }
});

Then("the recorded payload is byte for byte the delivery GitHub sent", long, async function () {
  const c = ctx(this);
  const d = c.deliveries.at(-1);
  assert.ok(d, "no delivery was posted");
  // The delivery's layout differs from JSON.stringify's, so a re-encoded body would fail the API's HMAC check.
  assert.notEqual(JSON.stringify(JSON.parse(d.body.toString("utf8"))), d.body.toString("utf8"));
  const events = await webhookEvents(d.id);
  assert.equal(events.length, 1, `webhook events for delivery "${d.id}"`);
  // The API recorded it, so the signature over the bytes it got matched the one GitHub made over the bytes it sent.
  // What it recorded is what those bytes and headers parse to.
  assert.equal(events[0].payload.githubEvent, d.headers["x-github-event"]);
  assert.deepEqual(events[0].payload.event, parseGitHubWebhook(d.headers, JSON.parse(d.body.toString("utf8"))));
});

// ---- Then: signing in ----

Then("the BFF redirects it to the identity provider's sign-in page", function () {
  const c = ctx(this);
  const r = only(c);
  assert.ok([302, 303, 307].includes(r.status), `the BFF answered ${r.status}, not a redirect`);
  assert.ok(r.headers.location, "the redirect has no Location");
  const to = new URL(r.headers.location, `http://localhost:${BFF_PORT}`);
  assert.equal(`${to.origin}${to.pathname}`, c.idp!.authorizationEndpoint, "the redirect isn't to the identity provider's authorization endpoint");
  assert.equal(to.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(to.searchParams.get("response_type"), "code");
  assert.equal(to.searchParams.get("code_challenge_method"), "S256");
});

Then("the redirect asks to come back to {string}", function (url: string) {
  const r = only(ctx(this));
  const to = new URL(r.headers.location ?? "", `http://localhost:${BFF_PORT}`);
  assert.equal(to.searchParams.get("redirect_uri"), url);
});

function sessionCookie(r: Reply): string | undefined {
  return setCookies(r).find((line) => {
    const [pair, ...attrs] = line.split(";").map((s) => s.trim());
    const value = pair.slice(pair.indexOf("=") + 1);
    return value !== "" && !attrs.some((a) => /^max-age=0$/i.test(a)) && attrs.some((a) => /^samesite=strict$/i.test(a));
  });
}

Then("the BFF sets a session cookie for port {int}", function (port: number) {
  const c = ctx(this);
  assert.equal(port, BFF_PORT);
  assert.ok(!failed(c.callback), `the BFF's /auth/callback didn't answer: ${describeOutcome(c.callback)}`);
  const cookie = sessionCookie(c.callback);
  assert.ok(cookie, `/auth/callback answered ${c.callback.status} with no session cookie: ${JSON.stringify(setCookies(c.callback))}`);
  const attrs = cookie.split(";").slice(1).map((s) => s.trim().toLowerCase());
  assert.ok(attrs.includes("httponly"), "the session cookie isn't HttpOnly");
  assert.ok(attrs.includes("path=/"), "the session cookie isn't for Path=/");
  assert.ok(!attrs.some((a) => a.startsWith("domain=")), "the session cookie names a Domain, so it isn't the BFF's own");
});

Then("the owner's next call to {string} on port {int} shows the Floor", long, async function (path: string, port: number) {
  const c = ctx(this);
  const url = `http://localhost:${port}${path}`;
  const r = await browse(c, url);
  assert.ok(!failed(r), `${path} didn't answer: ${describeOutcome(r)}`);
  assert.equal(r.status, 200, `${path} answered ${r.status}: ${r.body.toString("utf8").slice(0, 500)}`);
  assert.match(String(r.headers["content-type"]), /application\/json/);
  const floor = JSON.parse(r.body.toString("utf8")) as unknown;
  assert.ok(floor && typeof floor === "object", "the Floor isn't a JSON object");
});

Then("it sets no session cookie", function () {
  const r = only(ctx(this));
  assert.deepEqual(setCookies(r), [], "the BFF set a cookie");
});

Then("the browser's next call to {string} on port {int} gets {int}", long, async function (path: string, port: number, status: number) {
  const c = ctx(this);
  const r = await browse(c, `http://localhost:${port}${path}`);
  assert.ok(!failed(r), `${path} didn't answer: ${describeOutcome(r)}`);
  assert.equal(r.status, status);
});

// ---- Reading the AppHost ----

/** The AppHost with its comments left out. */
function appHostCode(): string {
  assert.ok(existsSync(APPHOST_FILE), "aspire-apphost/apphost.mts doesn't exist");
  return code(readFileSync(APPHOST_FILE, "utf8"));
}

/** Each statement that adds a resource: from builder.addX( up to its semicolon. */
function resourceStatements(source: string): { kind: string; name: string; text: string }[] {
  const found: { kind: string; name: string; text: string }[] = [];
  const re = /\.add(\w+)\(\s*(['"`])([^'"`]+)\2/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const end = source.indexOf(";", m.index);
    found.push({ kind: m[1], name: m[3], text: source.slice(m.index, end < 0 ? undefined : end) });
  }
  return found;
}

function nodeApps(source: string): { name: string; entry: string; text: string }[] {
  return resourceStatements(source).flatMap((s) => {
    if (s.kind !== "NodeApp") return [];
    const m = /^\.addNodeApp\(\s*(['"`])[^'"`]+\1\s*,\s*[^,]+,\s*(['"`])([^'"`]+)\2/.exec(s.text);
    return m ? [{ name: s.name, entry: m[3], text: s.text }] : [];
  });
}

Then("it adds a BFF resource started from src\\/bff\\/main.ts on port {int}", function (port: number) {
  const apps = nodeApps(appHostCode()).filter((a) => a.entry === "src/bff/main.ts");
  assert.equal(apps.length, 1, "the AppHost adds no resource started from src/bff/main.ts");
  assert.match(apps[0].text, new RegExp(`\\bport:\\s*${port}\\b`), `the resource from src/bff/main.ts isn't on port ${port}`);
});

Then("no resource listens on port {int}", function (port: number) {
  assert.doesNotMatch(appHostCode(), new RegExp(`\\b${port}\\b`), `the AppHost still names port ${port}`);
});

Then("no resource is started from src\\/main.ts", function () {
  const apps = nodeApps(appHostCode()).filter((a) => resolve(repo, a.entry) === resolve(repo, "src/main.ts"));
  assert.deepEqual(apps.map((a) => a.name), [], "resources started from src/main.ts");
});

Then("no resource is named {string}", function (name: string) {
  const named = resourceStatements(appHostCode()).filter((s) => s.name === name);
  assert.deepEqual(named.map((s) => `add${s.kind}`), [], `the AppHost adds a resource named "${name}"`);
});

// ---- Reading the docs ----

When("I read README.md and scripts\\/factory.ps1", function () {
  const read = (p: string) => (existsSync(join(repo, p)) ? readFileSync(join(repo, p), "utf8") : null);
  ctx(this).docs = { "README.md": read("README.md"), "scripts/factory.ps1": read("scripts/factory.ps1") };
});

function docs(c: Ctx): [string, string][] {
  assert.ok(c.docs, "the docs weren't read");
  return Object.entries(c.docs).map(([name, text]) => {
    assert.ok(text !== null, `${name} doesn't exist`);
    return [name, text];
  });
}

Then("they tell the owner to open {string} and sign in with Keycloak", function (url: string) {
  for (const [name, text] of docs(ctx(this))) {
    assert.ok(new RegExp(`${url.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?![\\d])`).test(text), `${name} doesn't name ${url}`);
    assert.match(text, /keycloak/i, `${name} doesn't say to sign in with Keycloak`);
  }
});

Then("neither tells the owner to open a sign-in link from the {string} resource's console", function (resource: string) {
  for (const [name, text] of docs(ctx(this))) {
    // Sentences, or lines for the script's comments.
    const said = text.split(/(?<=[.!?])\s+|\n/).filter((s) => new RegExp(`\\b${resource}\\b`, "i").test(s) && /console/i.test(s) && /link/i.test(s));
    assert.deepEqual(said, [], `${name} still points at the ${resource} console's sign-in link`);
  }
});

// ---- Reading the repo's code ----

/**
 * The source with its comments blanked out, strings and regular expressions kept. A slash starts a regular expression
 * where an expression can start, as a JavaScript scanner decides it.
 */
function code(source: string): string {
  let out = "";
  let i = 0;
  let prev = "";
  const exprStart = (p: string) => p === "" || /[(,=:[!&|?{};+\-*%<>~^]$/.test(p) || /\b(return|typeof|case|do|else|in|of|new|delete|void|throw|await|yield)$/.test(p);
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 2;
      out += " ";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) {
        if (source[j] === "\\") j++;
        // A template's ${...} may hold strings of its own. Skipping to the matching brace keeps them in.
        else if (ch === "`" && source[j] === "$" && source[j + 1] === "{") {
          let depth = 0;
          for (j++; j < source.length; j++) {
            if (source[j] === "{") depth++;
            else if (source[j] === "}" && --depth === 0) break;
          }
        } else if (ch !== "`" && source[j] === "\n") break;
        j++;
      }
      out += source.slice(i, j + 1);
      i = j + 1;
      prev = "x";
      continue;
    }
    if (ch === "/" && exprStart(prev)) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source[j] !== "\n" && (inClass || source[j] !== "/")) {
        if (source[j] === "\\") j++;
        else if (source[j] === "[") inClass = true;
        else if (source[j] === "]") inClass = false;
        j++;
      }
      while (j + 1 < source.length && /[a-z]/i.test(source[j + 1])) j++;
      out += source.slice(i, j + 1);
      i = j + 1;
      prev = "x";
      continue;
    }
    out += ch;
    if (!/\s/.test(ch)) prev = (prev + ch).slice(-12);
    i++;
  }
  return out;
}

const SKIP_DIRS = new Set(["node_modules", ".aspire", ".git", "reports", "dist"]);
const CODE_FILE = /\.(ts|mts|cts|js|mjs|cjs|ps1|sh)$/;
const SELF = join(repo, "features", "steps", "pbi-281.steps.ts");

function walk(dir: string, found: string[] = []): string[] {
  if (!existsSync(dir)) return found;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, found);
    else if (CODE_FILE.test(name) && p !== SELF) found.push(p);
  }
  return found;
}

/** The repo's own code: src, scripts, the AppHost, the cell's files, and the step definitions too when asked. */
function sourceFiles(withSteps: boolean): string[] {
  const dirs = ["src", "scripts", "aspire-apphost", "cell", "db"];
  if (withSteps) dirs.push(join("features", "steps"));
  return dirs.flatMap((d) => walk(join(repo, d)));
}

function packageScripts(): string[] {
  return ["package.json", join("aspire-apphost", "package.json")].flatMap((p) => {
    const file = join(repo, p);
    if (!existsSync(file)) return [];
    const scripts = (JSON.parse(readFileSync(file, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
    return Object.entries(scripts).map(([name, cmd]) => `${p} ${name}: ${cmd}`);
  });
}

When("I search the repo's source files, step definitions and package scripts", function () {
  const c = ctx(this);
  c.files = sourceFiles(true);
  c.scripts = packageScripts();
});

When("I search the repo's source files", function () {
  ctx(this).files = sourceFiles(false);
});

/** Each quoted path in `file`'s code, resolved as an import resolves it, or against the repo root when it isn't relative. */
function pathsNamed(file: string): string[] {
  const text = code(readFileSync(file, "utf8"));
  const found: string[] = [];
  const re = /(['"`])((?:\.{1,2}\/|\/)?[\w.@/-]+\.(?:ts|mts|js|mjs))\1/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const p = m[2];
    found.push(p.startsWith(".") ? resolve(dirname(file), p) : resolve(repo, p.replace(/^\//, "")));
  }
  return found;
}

Then("none imports or starts {string}, {string} or {string}", function (a: string, b: string, d: string) {
  const c = ctx(this);
  assert.ok(c.files && c.files.length > 0, "no source files were searched");
  const gone = new Set([a, b, d].map((p) => resolve(repo, p)));
  const uses: string[] = [];
  for (const file of c.files) {
    for (const p of pathsNamed(file)) if (gone.has(p)) uses.push(`${relative(repo, file)} uses ${relative(repo, p)}`);
  }
  for (const script of c.scripts ?? []) {
    for (const word of script.split(/[\s"']+/)) if (/\.(ts|js|mjs)$/.test(word) && gone.has(resolve(repo, word))) uses.push(`${script}`);
  }
  assert.deepEqual([...new Set(uses)], [], "today's dashboard code is still used");
});

/** The searched files that aren't tests: a test may well check that something is gone. */
function nonTestCode(c: Ctx): [string, string][] {
  assert.ok(c.files && c.files.length > 0, "no source files were searched");
  return c.files.filter((f) => !/\.test\.(ts|mts|js|mjs)$/.test(f)).map((f) => [relative(repo, f), code(readFileSync(f, "utf8"))]);
}

Then("no source file makes, logs or checks a dev token", function () {
  const hits = nonTestCode(ctx(this)).flatMap(([file, text]) =>
    text.split("\n").flatMap((line, i) => (/dev[_-]?token|devLoginCookie|DEV_COOKIE|factory_dev\b/i.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : [])));
  assert.deepEqual(hits, [], "source files that still make, log or check a dev token");
});

Then("no source file handles {string}", function (path: string) {
  const hits = nonTestCode(ctx(this)).flatMap(([file, text]) =>
    text.split("\n").flatMap((line, i) => (line.includes(path) ? [`${file}:${i + 1}: ${line.trim()}`] : [])));
  assert.deepEqual(hits, [], `source files that still handle ${path}`);
});

When("I look for {string} in the repo", function (path: string) {
  ctx(this).lookedFor = { path, there: existsSync(join(repo, path)) };
});

Then("it isn't there", function () {
  const l = ctx(this).lookedFor;
  assert.ok(l, "nothing was looked for");
  assert.equal(l.there, false, `${l.path} is still in the repo`);
});

// ---- @local: aspire run, with pinned ports. The owner runs these, and the PR records the run ----

function sh(command: string): { status: number | null; stdout: string } {
  const r = spawnSync(command, { cwd: repo, shell: true, encoding: "utf8", env: { ...process.env, FACTORY_FLOAT_PORTS: "0" } });
  return { status: r.status, stdout: r.stdout ?? "" };
}

type Described = { name?: string; displayName?: string; resourceType?: string; type?: string; [k: string]: unknown };

/** Every resource `aspire describe` lists, never printed: it shows environment values such as FACTORY_DB_URI. */
function described(): Described[] {
  const r = sh(`aspire describe --format Json ${APPHOST}`);
  try {
    const doc = JSON.parse(r.stdout) as { resources?: Described[] } | Described[];
    return Array.isArray(doc) ? doc : (doc.resources ?? []);
  } catch {
    return [];
  }
}

const resourceName = (r: Described) => String(r.displayName ?? r.name ?? "");

function startAspire(c: Ctx): void {
  c.started = true;
  sh(`aspire start ${APPHOST}`);
}

When("I start {string} and wait until the BFF resource is healthy", long, function (_cmd: string) {
  const c = ctx(this);
  startAspire(c);
  c.bffHealthy = sh(`aspire wait bff --status healthy --timeout 300 ${APPHOST}`).status === 0;
});

When("I start {string} and wait until every resource is healthy", long, function (_cmd: string) {
  const c = ctx(this);
  startAspire(c);
  const apps = described().filter((r) => /project|executable|container/i.test(String(r.resourceType ?? r.type ?? "")));
  c.resources = [...new Set(apps.map(resourceName).filter(Boolean))];
  for (const name of c.resources) {
    // Migrate runs once and exits, so it is done rather than healthy.
    const status = name.startsWith("migrate") ? "down" : "healthy";
    sh(`aspire wait ${name} --status ${status} --timeout 300 ${APPHOST}`);
  }
});

Then("{string} serves the factory's single-page app", long, async function (url: string) {
  const c = ctx(this);
  assert.ok(c.bffHealthy, "the BFF resource didn't become healthy");
  const r = await send(url);
  assert.ok(!failed(r), `${url} didn't answer: ${describeOutcome(r)}`);
  assert.equal(r.status, 200);
  assert.match(String(r.headers["content-type"]), /text\/html/);
  assert.match(r.body.toString("utf8"), /<script[^>]*type="module"/, "the page loads no single-page app bundle");
});

Then("nothing answers on {string}", long, async function (url: string) {
  const port = Number(new URL(url).port);
  assert.equal(await answers(port), false, `something answers on ${url}`);
});

Then("the Aspire dashboard lists no {string} resource", function (name: string) {
  const all = described();
  assert.ok(all.length > 0, "aspire describe lists no resources");
  const named = all.map(resourceName).filter((n) => n === name || n.startsWith(`${name}-`));
  assert.deepEqual(named, [], `the Aspire dashboard lists a "${name}" resource`);
});

When("I open {string} with no session", long, async function (url: string) {
  const c = ctx(this);
  c.jar.clear();
  const home = await browse(c, url);
  if (failed(home)) {
    c.page = { url, reply: home };
    return;
  }
  // The single-page app asks the BFF for the Floor, and on 401 sends the browser to /auth/login.
  const floor = await browse(c, new URL("/bff/v1/floor", url).href);
  if (failed(floor) || floor.status !== 401) {
    c.page = { url: new URL("/bff/v1/floor", url).href, reply: floor };
    return;
  }
  c.page = await follow(c, new URL("/auth/login", url).href);
});

Then("I'm sent to Keycloak's sign-in page on port {int}", function (port: number) {
  const c = ctx(this);
  assert.ok(c.page, "no page was opened");
  assert.ok(!failed(c.page.reply), `${c.page.url}: ${describeOutcome(c.page.reply)}`);
  assert.equal(new URL(c.page.url).port, String(port), `the browser ended on ${c.page.url}`);
  assert.equal(c.page.reply.status, 200);
  assert.match(c.page.reply.body.toString("utf8"), /id="kc-form-login"|name="password"/, "the page isn't Keycloak's sign-in form");
});

function testOwner(): { username: string; password: string } {
  const realm = JSON.parse(readFileSync(join(repo, "aspire-apphost", "keycloak", "factory-realm.json"), "utf8")) as {
    users?: { username?: string; credentials?: { type?: string; value?: string }[] }[];
  };
  for (const u of realm.users ?? []) {
    const cred = (u.credentials ?? []).find((cr) => cr.type === "password" && typeof cr.value === "string");
    if (u.username && cred?.value) return { username: u.username, password: cred.value };
  }
  throw new Error("the realm import has no user with a password");
}

When("I sign in there as the test owner", long, async function () {
  const c = ctx(this);
  if (!c.page || failed(c.page.reply)) {
    c.backOn = { url: c.page?.url ?? "", reply: { error: "there was no sign-in page to sign in on" } };
    return;
  }
  const html = c.page.reply.body.toString("utf8");
  const action = /<form[^>]*action="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, "&");
  if (!action) {
    c.backOn = { url: c.page.url, reply: { error: "the sign-in page has no form" } };
    return;
  }
  const owner = testOwner();
  const to = new URL(action, c.page.url).href;
  const posted = await browse(c, to, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: Buffer.from(new URLSearchParams({ username: owner.username, password: owner.password, credentialId: "" }).toString()),
  });
  c.backOn = await follow(c, to, posted);
});

Then("I'm back on {string} signed in", long, async function (url: string) {
  const c = ctx(this);
  assert.ok(c.backOn, "nobody signed in");
  assert.ok(!failed(c.backOn.reply), `${c.backOn.url}: ${describeOutcome(c.backOn.reply)}`);
  assert.equal(new URL(c.backOn.url).origin, new URL(url).origin, `the browser ended on ${c.backOn.url}`);
  const floor = await browse(c, new URL("/bff/v1/floor", url).href);
  assert.ok(!failed(floor), `/bff/v1/floor: ${describeOutcome(floor)}`);
  assert.equal(floor.status, 200, "the browser isn't signed in");
  c.replies.push(floor);
});

Then("the Floor shows", function () {
  const r = only(ctx(this));
  assert.equal(r.status, 200);
  const floor = JSON.parse(r.body.toString("utf8")) as unknown;
  assert.ok(floor && typeof floor === "object", "the Floor isn't a JSON object");
});

Then("no resource's console shows a {string} link", function (link: string) {
  const c = ctx(this);
  assert.ok(c.resources && c.resources.length > 0, "aspire run started no resources");
  const showing = c.resources.filter((name) => sh(`aspire logs ${name} ${APPHOST}`).stdout.includes(link));
  assert.deepEqual(showing, [], `resources whose console shows a ${link} link`);
});

Then("{string} signs nobody in", long, async function (url: string) {
  const c = ctx(this);
  c.jar.clear();
  const r = await browse(c, url);
  assert.ok(!failed(r), `${url} didn't answer: ${describeOutcome(r)}`);
  assert.deepEqual(setCookies(r), [], `${url} set a cookie`);
  assert.equal(r.status, 404, `${url} answered ${r.status}`);
  const floor = await browse(c, new URL("/bff/v1/floor", url).href);
  assert.ok(!failed(floor), `/bff/v1/floor: ${describeOutcome(floor)}`);
  assert.equal(floor.status, 401, "the browser is signed in");
});
