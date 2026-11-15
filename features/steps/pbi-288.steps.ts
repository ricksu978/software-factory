// Step definitions for features/pbi-288-bff-entry-point.feature and features/pbi-288-bff-sign-in-sessions.feature.
//
// The @db scenarios run the BFF as `node src/bff/main.ts` in a child process, as the AppHost does, on PBI 4's shared
// test database, against the test sign-in provider in features/fixtures/pbi-288-provider.ts. The BFF gets:
//   FACTORY_DB_URI      the test database, as the superuser. The BFF does its own work in Postgres as factory_bff.
//   OIDC_ISSUER         the provider's issuer. Discovery finds the rest.
//   OIDC_CLIENT_ID      "dashboard", OIDC_CLIENT_SECRET a test secret, OIDC_SCOPES "openid".
//   BFF_SESSION_KEY     32 random bytes in base64, the key refresh tokens are sealed under.
//   PORT                a free port, and BFF_ORIGIN, http://localhost:<that port>, the address the browser uses.
// A scripted browser keeps cookies per host name, follows redirects itself, and records everything it was sent.
// The BFF's routes, as the scenarios use them:
//   GET /auth/login       sends the browser to the provider, setting the sign-in cookie.
//   GET /auth/callback    where the provider sends the browser back. A refusal answers 400, 401 or 403.
//   POST /auth/logout     signs the browser out, with an Origin of the BFF's own.
//   GET /auth/session     200 with the signed-in browser's { issuer, subject }, 401 for a browser not signed in.
// The session cookie is named by SESSION_COOKIE in src/bff/session.ts, and openRefreshToken there opens a refresh token
// sealed under a session key. While the session table has a test audit on it, every statement or row the BFF touches
// records the role it ran as. "I read the AppHost" is PBI 169's step, and "{string} is up" is PBI 6's.
// Givens never assert on the BFF's answers, so a scenario fails on its Then.
import { After, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import pg from "pg";
import { startProvider, type Provider } from "../fixtures/pbi-288-provider.ts";
import { load, long, need, testDb } from "./pbi-8.steps.ts";

const repo = process.cwd();
const BFF_MAIN = join(repo, "src", "bff", "main.ts");
const APPHOST_FILE = join(repo, "aspire-apphost", "apphost.mts");
const REALM_DIR = join(repo, "aspire-apphost", "keycloak");
const APPHOST = "--apphost . --non-interactive --nologo";
const CLIENT_ID = "dashboard";
const CLIENT_SECRET = "pbi-288-client-secret";
const local = { timeout: 600_000 };

type SessionModule = {
  SESSION_COOKIE: string;
  openRefreshToken: (key: string, sealed: string) => string;
};

type Cookie = { name: string; value: string; attrs: Record<string, string | true> };
type Seen = { url: URL; method: string; status: number; headers: Headers; setCookies: Cookie[]; body: string };
type Check = { status: number; body: string };

type Bff = { child: ChildProcess; out: string; exit?: { code: number | null; signal: string | null } };

type Ctx = {
  provider?: Provider;
  bff?: Bff;
  env?: Record<string, string>;
  port?: number;
  key?: string;
  browsers: Browser[];
  /** The browser of the last When that wasn't one of the numbered ones. */
  other?: Browser;
  copied?: string;
  check?: Check;
  checks: Check[];
  /** The last callback the BFF answered, in whichever browser. */
  callback?: Seen;
  logout?: Seen;
  before?: Record<string, unknown>[];
  issuedBefore: number;
  audited?: boolean;
  revoked?: boolean;
  aspireStarted?: boolean;
  local?: { browser: Browser; page?: Seen; back?: Seen };
};

function ctx(world: object): Ctx {
  const w = world as { pbi288?: Ctx };
  w.pbi288 ??= { browsers: [], checks: [], issuedBefore: 0 };
  return w.pbi288;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const pool = () => need().pool;
const isRedirect = (s: Seen | undefined) => !!s && s.status >= 300 && s.status < 400 && s.headers.has("location");

async function sessionModule(): Promise<SessionModule> {
  const m = await load<SessionModule>("src/bff/session.ts");
  assert.ok(m, "src/bff/session.ts doesn't exist");
  return m;
}

// ---- The scripted browser ----

function parseSetCookie(raw: string): Cookie {
  const [pair, ...rest] = raw.split(";");
  const eq = pair.indexOf("=");
  const attrs: Record<string, string | true> = {};
  for (const part of rest) {
    const i = part.indexOf("=");
    const k = (i < 0 ? part : part.slice(0, i)).trim().toLowerCase();
    if (k) attrs[k] = i < 0 ? true : part.slice(i + 1).trim();
  }
  return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), attrs };
}

/** Whether a Set-Cookie takes the cookie away: Max-Age of 0 or less, or an Expires in the past. */
function clears(c: Cookie): boolean {
  const maxAge = c.attrs["max-age"];
  if (typeof maxAge === "string" && Number(maxAge) <= 0) return true;
  const expires = c.attrs.expires;
  return typeof expires === "string" && Date.parse(expires) <= Date.now();
}

/** Seconds until the cookie expires, or null when it lasts the browser session. */
function lifetime(c: Cookie): number | null {
  const maxAge = c.attrs["max-age"];
  if (typeof maxAge === "string") return Number(maxAge);
  const expires = c.attrs.expires;
  if (typeof expires === "string") return (Date.parse(expires) - Date.now()) / 1000;
  return null;
}

class Browser {
  /** Cookies by host name, as a browser keeps them: not per port. */
  jar = new Map<string, Map<string, string>>();
  seen: Seen[] = [];
  login?: Seen;
  callback?: Seen;

  cookies(host: string): Map<string, string> {
    let m = this.jar.get(host);
    if (!m) this.jar.set(host, (m = new Map()));
    return m;
  }

  async request(url: URL, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Seen> {
    const jar = this.cookies(url.hostname);
    const headers: Record<string, string> = { ...init.headers };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const method = init.method ?? "GET";
    let r: Response;
    try {
      r = await fetch(url, { method, headers, body: init.body, redirect: "manual", signal: AbortSignal.timeout(20_000) });
    } catch (e) {
      const seen: Seen = { url, method, status: 0, headers: new Headers(), setCookies: [], body: String(e) };
      this.seen.push(seen);
      return seen;
    }
    const setCookies = r.headers.getSetCookie().map(parseSetCookie);
    for (const c of setCookies) {
      if (clears(c)) jar.delete(c.name);
      else jar.set(c.name, c.value);
    }
    const seen: Seen = { url, method, status: r.status, headers: r.headers, setCookies, body: await r.text() };
    this.seen.push(seen);
    return seen;
  }

  async next(from: Seen): Promise<Seen> {
    return this.request(new URL(from.headers.get("location")!, from.url));
  }
}

// ---- The BFF as a child process ----

async function answers(port: number): Promise<boolean> {
  const on = (host: string) => new Promise<boolean>((resolve) => {
    const s = connect({ host, port, timeout: 2_000 });
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
    s.once("timeout", () => { s.destroy(); resolve(false); });
  });
  return (await on("127.0.0.1")) || (await on("::1"));
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", () => resolve()));
  const port = (s.address() as { port: number }).port;
  await new Promise((resolve) => s.close(resolve));
  return port;
}

function spawnBff(c: Ctx, env: Record<string, string>): Bff {
  const child = spawn(process.execPath, [BFF_MAIN], {
    cwd: repo,
    env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", ...env },
  });
  const b: Bff = { child, out: "" };
  child.stdout!.setEncoding("utf8").on("data", (d: string) => (b.out += d));
  child.stderr!.setEncoding("utf8").on("data", (d: string) => (b.out += d));
  child.once("exit", (code, signal) => (b.exit = { code, signal }));
  c.bff = b;
  return b;
}

/** Waits until something answers on `port` or the BFF exits, for up to `ms`. */
async function settle(b: Bff, port: number, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (b.exit === undefined && !(await answers(port)) && Date.now() < end) await sleep(100);
}

async function stopBff(c: Ctx): Promise<void> {
  const b = c.bff;
  if (!b) return;
  c.bff = undefined;
  if (b.exit !== undefined) return;
  const gone = new Promise((resolve) => b.child.once("exit", resolve));
  b.child.kill();
  await Promise.race([gone, sleep(10_000)]);
  if (b.exit === undefined) {
    b.child.kill("SIGKILL");
    await gone;
  }
}

async function startBff(c: Ctx): Promise<void> {
  const b = spawnBff(c, c.env!);
  await settle(b, c.port!);
  assert.ok(b.exit === undefined, `the BFF exited (${JSON.stringify(b.exit)}) before it answered: ${b.out}`);
  assert.ok(await answers(c.port!), `the BFF doesn't answer on port ${c.port} after 30 seconds`);
}

const bffUrl = (c: Ctx, path: string) => new URL(path, `http://localhost:${c.port}`);
const bffHost = "localhost";

// ---- The database ----

async function dbUrl(): Promise<string> {
  const d = await testDb();
  assert.ok(d, "src/store/test-db.ts doesn't exist");
  return (d as unknown as { url: string }).url;
}

type SessionRow = { cookie_hash: string; issuer: string; subject: string; refresh_token_encrypted: string | null; [k: string]: unknown };

async function sessions(): Promise<SessionRow[]> {
  return (await pool().query<SessionRow>("select * from session order by cookie_hash")).rows;
}

async function sessionsOf(c: Ctx, user: string): Promise<SessionRow[]> {
  const p = c.provider!;
  return (await sessions()).filter((r) => r.issuer === p.issuer && r.subject === p.subjectOf(user));
}

/**
 * Records the role behind every write to session, once per statement, and behind every row read, changed or removed,
 * through a row-level policy. A superuser skips the policy but not the trigger.
 */
async function audit(): Promise<void> {
  await pool().query(`
    create table if not exists pbi288_audit (role text not null, what text not null, at timestamptz not null default now());
    grant select, insert on pbi288_audit to public;
    truncate pbi288_audit;
    create or replace function pbi288_saw(what text) returns boolean language plpgsql as $$
    begin
      insert into pbi288_audit (role, what) values (current_user, what);
      return true;
    end $$;
    create or replace function pbi288_wrote() returns trigger language plpgsql as $$
    begin
      insert into pbi288_audit (role, what) values (current_user, tg_op);
      return null;
    end $$;
    drop trigger if exists pbi288_wrote on session;
    create trigger pbi288_wrote after insert or update or delete on session for each statement execute function pbi288_wrote();
    drop policy if exists pbi288_saw on session;
    create policy pbi288_saw on session for all to public using (pbi288_saw('row')) with check (true);
    alter table session enable row level security;
  `);
}

async function unaudit(): Promise<void> {
  await pool().query(`
    alter table session disable row level security;
    drop policy if exists pbi288_saw on session;
    drop trigger if exists pbi288_wrote on session;
    drop function if exists pbi288_wrote();
    drop function if exists pbi288_saw(text);
    drop table if exists pbi288_audit;
  `);
}

After({ tags: "@pbi-288", ...long }, async function () {
  const c = ctx(this);
  await stopBff(c);
  await c.provider?.stop();
  if (c.audited) await unaudit();
  if (c.revoked) await pool().query("grant select, insert, update, delete on session to factory_bff");
  if (c.aspireStarted) spawnSync(`aspire stop ${APPHOST}`, { cwd: repo, shell: true });
});

// ---- Background ----

Given("a test sign-in provider is running with the user {string}", long, async function (user: string) {
  ctx(this).provider = await startProvider(user);
});

Given("the BFF is running against that provider as its issuer", long, async function () {
  const c = ctx(this);
  const url = await dbUrl();
  await pool().query("truncate session");
  await audit();
  c.audited = true;
  c.port = await freePort();
  c.key = randomBytes(32).toString("base64");
  c.env = {
    FACTORY_DB_URI: url,
    OIDC_ISSUER: c.provider!.issuer,
    OIDC_CLIENT_ID: CLIENT_ID,
    OIDC_CLIENT_SECRET: CLIENT_SECRET,
    OIDC_SCOPES: "openid",
    BFF_SESSION_KEY: c.key,
    PORT: String(c.port),
    BFF_ORIGIN: `http://localhost:${c.port}`,
  };
  await startBff(c);
});

// ---- Starting and stopping the BFF ----

Given("the BFF is stopped", long, async function () {
  await stopBff(ctx(this));
});

When("the BFF starts with no port set", long, async function () {
  const c = ctx(this);
  const { PORT: _port, BFF_ORIGIN: _origin, ...env } = c.env!;
  await settle(spawnBff(c, env), 7403);
});

When("the BFF starts with no session key set", long, async function () {
  const c = ctx(this);
  const { BFF_SESSION_KEY: _key, ...env } = c.env!;
  await settle(spawnBff(c, env), c.port!);
});

async function restart(c: Ctx): Promise<void> {
  c.before = await sessions();
  await stopBff(c);
  await startBff(c);
}

When("the BFF is stopped and started again", long, async function () {
  await restart(ctx(this));
});

When("the BFF is stopped and started again with the same session key", long, async function () {
  await restart(ctx(this));
});

Given("the BFF has been stopped and started again", long, async function () {
  await restart(ctx(this));
});

Then("the BFF answers on port {int}", long, async function (port: number) {
  const b = ctx(this).bff;
  assert.ok(b, "the BFF was never started");
  assert.equal(b.exit, undefined, `the BFF exited: ${b.out}`);
  assert.ok(await answers(port), `nothing answers on port ${port}`);
});

Then("it exits with a failure code", long, async function () {
  const b = ctx(this).bff;
  assert.ok(b, "the BFF was never started");
  const end = Date.now() + 10_000;
  while (b.exit === undefined && Date.now() < end) await sleep(100);
  assert.ok(b.exit, "the BFF is still running 10 seconds after it started");
  assert.ok(b.exit.code !== 0, `the BFF exited with ${JSON.stringify(b.exit)}`);
});

Then("its log names the missing session key", function () {
  const b = ctx(this).bff;
  assert.ok(b, "the BFF was never started");
  assert.match(b.out, /BFF_SESSION_KEY/, `the BFF's log doesn't name BFF_SESSION_KEY: ${b.out}`);
});

// ---- Signing in ----

function browser(c: Ctx, n: number): Browser {
  while (c.browsers.length < n) c.browsers.push(new Browser());
  return c.browsers[n - 1];
}

async function startSignIn(c: Ctx, b: Browser): Promise<Seen> {
  b.login = await b.request(bffUrl(c, "/auth/login"));
  return b.login;
}

/** Signs in all the way: the BFF's login, the provider, and back to the BFF's callback, which ends the walk. */
async function signIn(c: Ctx, b: Browser): Promise<void> {
  let at = await startSignIn(c, b);
  for (let hop = 0; hop < 10 && isRedirect(at); hop++) {
    at = await b.next(at);
    if (at.url.port === String(c.port) && at.url.pathname === "/auth/callback") {
      b.callback = c.callback = at;
      return;
    }
  }
}

async function callback(c: Ctx, b: Browser, query: Record<string, string>): Promise<void> {
  const url = bffUrl(c, "/auth/callback");
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  b.callback = c.callback = await b.request(url);
}

function loginParams(b: Browser): URLSearchParams | null {
  if (!b.login || !isRedirect(b.login)) return null;
  return new URL(b.login.headers.get("location")!, b.login.url).searchParams;
}

When("a browser starts sign-in at {string}", long, async function (path: string) {
  const c = ctx(this);
  const b = browser(c, 1);
  b.login = await b.request(bffUrl(c, path));
});

Given("a browser has started sign-in at {string}", long, async function (path: string) {
  const c = ctx(this);
  const b = browser(c, 1);
  b.login = await b.request(bffUrl(c, path));
});

When("{string} signs in through the BFF", long, async function (_user: string) {
  const c = ctx(this);
  c.issuedBefore = c.provider!.issued.length;
  await signIn(c, browser(c, 1));
});

Given("{string} has signed in through the BFF", long, async function (_user: string) {
  const c = ctx(this);
  await signIn(c, browser(c, 1));
});

When("{string} signs in through the BFF in one browser", long, async function (_user: string) {
  const c = ctx(this);
  await signIn(c, browser(c, 1));
});

Given("{string} has signed in through the BFF in one browser", long, async function (_user: string) {
  const c = ctx(this);
  await signIn(c, browser(c, 1));
});

When("{string} signs in through the BFF in a second browser", long, async function (_user: string) {
  const c = ctx(this);
  await signIn(c, browser(c, 2));
});

Given("{string} has signed in through the BFF in a second browser", long, async function (_user: string) {
  const c = ctx(this);
  await signIn(c, browser(c, 2));
});

When("the provider sends the browser back to {string} with a code for {string} and a different state", long, async function (_path: string, user: string) {
  const c = ctx(this);
  const b = browser(c, 1);
  const sent = loginParams(b);
  const code = c.provider!.mintCode(user, sent?.get("redirect_uri") ?? bffUrl(c, "/auth/callback").href, CLIENT_ID);
  await callback(c, b, { code, state: `not-${sent?.get("state") ?? "the-state"}`, iss: c.provider!.issuer });
});

When("the provider sends the browser back to {string} with an access denied error", long, async function (_path: string) {
  const c = ctx(this);
  const b = browser(c, 1);
  const state = loginParams(b)?.get("state") ?? "no-state";
  await callback(c, b, { error: "access_denied", error_description: "The user said no", state, iss: c.provider!.issuer });
});

When("a browser arrives at {string} with a code for {string} and no sign-in cookie", long, async function (_path: string, user: string) {
  const c = ctx(this);
  const b = browser(c, 1);
  const code = c.provider!.mintCode(user, bffUrl(c, "/auth/callback").href, CLIENT_ID);
  await callback(c, b, { code, state: randomBytes(16).toString("base64url"), iss: c.provider!.issuer });
});

Given("the provider will put a different nonce in the next ID token", function () {
  ctx(this).provider!.next.differentNonce = true;
});

Given("the provider will issue an opaque access token for the next sign-in", function () {
  ctx(this).provider!.next.accessToken = "opaque";
});

Given("the provider will issue an access token of three dotted parts that don't decode to a JWT for the next sign-in", function () {
  ctx(this).provider!.next.accessToken = "dotted";
});

Given("the provider will issue a JWT access token for the next sign-in", function () {
  ctx(this).provider!.next.accessToken = "jwt";
});

Given("the provider will issue the refresh token {string} for the next sign-in", function (token: string) {
  ctx(this).provider!.next.refreshToken = token;
});

Given("the provider will issue no refresh token for the next sign-in", function () {
  ctx(this).provider!.next.refreshToken = null;
});

// ---- The authorization request ----

function login(c: Ctx): Seen {
  const l = browser(c, 1).login;
  assert.ok(l, "no browser started sign-in");
  return l;
}

function authorization(c: Ctx): URLSearchParams {
  const l = login(c);
  assert.ok(isRedirect(l), `/auth/login answered ${l.status}, not a redirect`);
  return new URL(l.headers.get("location")!, l.url).searchParams;
}

Then("the BFF sends the browser to the authorization address in the issuer's discovery document", function () {
  const c = ctx(this);
  const l = login(c);
  assert.ok(isRedirect(l), `/auth/login answered ${l.status}, not a redirect`);
  const to = new URL(l.headers.get("location")!, l.url);
  assert.equal(`${to.origin}${to.pathname}`, c.provider!.authorizationEndpoint, "the browser isn't sent to the discovery document's authorization_endpoint");
});

Then("the request asks for an authorization code", function () {
  assert.equal(authorization(ctx(this)).get("response_type"), "code");
});

Then("the request carries a PKCE challenge made with S256", function () {
  const q = authorization(ctx(this));
  assert.match(q.get("code_challenge") ?? "", /^[A-Za-z0-9_-]{43}$/, "no S256 code_challenge");
  assert.equal(q.get("code_challenge_method"), "S256");
});

Then("the request carries a state and a nonce", function () {
  const q = authorization(ctx(this));
  assert.ok(q.get("state"), "the request carries no state");
  assert.ok(q.get("nonce"), "the request carries no nonce");
});

Then("the request asks to come back to the BFF at {string}", function (path: string) {
  const c = ctx(this);
  const uri = authorization(c).get("redirect_uri");
  assert.ok(uri, "the request carries no redirect_uri");
  const u = new URL(uri);
  assert.equal(u.port, String(c.port), `the redirect_uri ${uri} isn't the BFF's`);
  assert.equal(u.pathname, path);
});

function signInCookies(c: Ctx): Cookie[] {
  const set = login(c).setCookies.filter((k) => !clears(k));
  assert.ok(set.length > 0, "/auth/login set no cookie");
  return set;
}

Then("the BFF sets a sign-in cookie that is HttpOnly and SameSite=Lax", function () {
  for (const k of signInCookies(ctx(this))) {
    assert.ok(k.attrs.httponly, `the sign-in cookie ${k.name} isn't HttpOnly`);
    assert.equal(String(k.attrs.samesite).toLowerCase(), "lax", `the sign-in cookie ${k.name} isn't SameSite=Lax`);
  }
});

Then("the sign-in cookie expires within minutes, not days", function () {
  for (const k of signInCookies(ctx(this))) {
    const s = lifetime(k);
    assert.ok(s !== null, `the sign-in cookie ${k.name} has no expiry`);
    assert.ok(s > 0 && s <= 3600, `the sign-in cookie ${k.name} lasts ${s} seconds`);
  }
});

// ---- The callback ----

function lastCallback(c: Ctx): Seen {
  assert.ok(c.callback, "the browser never came back to /auth/callback");
  return c.callback;
}

Then("the provider received the code at its token address with a PKCE verifier that matches the challenge", function () {
  const c = ctx(this);
  const p = c.provider!;
  const challenge = p.authorizations.at(-1)?.get("code_challenge");
  assert.ok(challenge, "the provider received no PKCE challenge");
  const t = p.tokenRequests.at(-1);
  assert.ok(t, "the provider's token address received no request");
  assert.equal(t.form.grant_type, "authorization_code");
  assert.ok(t.form.code, "the token request carries no code");
  const verifier = t.form.code_verifier;
  assert.ok(verifier, "the token request carries no code_verifier");
  assert.equal(createHash("sha256").update(verifier).digest("base64url"), challenge, "the verifier doesn't match the challenge");
});

Then("the sign-in succeeds", function () {
  const c = ctx(this);
  const cb = lastCallback(c);
  assert.ok(isRedirect(cb), `/auth/callback answered ${cb.status}: ${cb.body}`);
  const to = new URL(cb.headers.get("location")!, cb.url);
  assert.equal(to.port, String(c.port), `the callback sends the browser to ${to.href}, not back to the BFF`);
  assert.ok(!to.pathname.startsWith("/auth/") && !to.searchParams.has("error"), `the callback sends the browser to ${to.href}`);
});

Then("the BFF refuses the sign-in", function () {
  const cb = lastCallback(ctx(this));
  assert.ok([400, 401, 403].includes(cb.status), `/auth/callback answered ${cb.status}, not a refusal`);
});

Then("the BFF refuses the sign-in because the provider's access token isn't a JWT", function () {
  const cb = lastCallback(ctx(this));
  assert.ok([400, 401, 403].includes(cb.status), `/auth/callback answered ${cb.status}, not a refusal`);
  assert.match(cb.body, /JWT/, `the refusal doesn't say the access token isn't a JWT: ${cb.body}`);
});

Then("the sign-in fails", function () {
  const cb = lastCallback(ctx(this));
  assert.ok(cb.status >= 400 && cb.status !== 404, `/auth/callback answered ${cb.status}`);
});

Then("the sign-in cookie is cleared", function () {
  const c = ctx(this);
  const names = signInCookies(c).map((k) => k.name);
  const cb = lastCallback(c);
  for (const n of names) {
    assert.ok(cb.setCookies.some((k) => k.name === n && clears(k)), `the callback doesn't clear the sign-in cookie ${n}`);
    assert.ok(!browser(c, 1).cookies(bffHost).has(n), `the browser still holds the sign-in cookie ${n}`);
  }
});

// ---- Sessions ----

Then("a session for {string} from the provider's issuer exists", long, async function (user: string) {
  const rows = await sessionsOf(ctx(this), user);
  assert.ok(rows.length >= 1, `no session for ${user}: ${JSON.stringify(await sessions())}`);
});

Then("no session exists", long, async function () {
  const rows = await sessions();
  assert.equal(rows.length, 0, `${rows.length} sessions exist`);
});

Then("no session for {string} exists", long, async function (user: string) {
  assert.equal((await sessionsOf(ctx(this), user)).length, 0);
});

Then("one session for {string} exists", long, async function (user: string) {
  assert.equal((await sessionsOf(ctx(this), user)).length, 1);
});

Then("two sessions for {string} exist", long, async function (user: string) {
  assert.equal((await sessionsOf(ctx(this), user)).length, 2);
});

// ---- The session cookie ----

async function sessionCookie(): Promise<string> {
  return (await sessionModule()).SESSION_COOKIE;
}

async function setSessionCookie(c: Ctx): Promise<Cookie> {
  const name = await sessionCookie();
  const k = lastCallback(c).setCookies.find((x) => x.name === name && !clears(x));
  assert.ok(k, `the callback set no ${name} cookie`);
  return k;
}

Then("the BFF sets a session cookie that is HttpOnly and SameSite=Strict", long, async function () {
  const k = await setSessionCookie(ctx(this));
  assert.ok(k.attrs.httponly, "the session cookie isn't HttpOnly");
  assert.equal(String(k.attrs.samesite).toLowerCase(), "strict", "the session cookie isn't SameSite=Strict");
});

Then("the session cookie's path is {string}", long, async function (path: string) {
  assert.equal((await setSessionCookie(ctx(this))).attrs.path, path);
});

Then("the only cookie the browser holds is the session cookie", long, async function () {
  const held = [...browser(ctx(this), 1).cookies(bffHost).keys()];
  assert.deepEqual(held, [await sessionCookie()], `the browser holds ${JSON.stringify(held)}`);
});

Then("the browser holds no session cookie", long, async function () {
  const c = ctx(this);
  const name = await sessionCookie();
  const b = c.other ?? browser(c, 1);
  assert.ok(!b.cookies(bffHost).has(name), "the browser holds a session cookie");
});

Then("the browser holds a session cookie", long, async function () {
  const name = await sessionCookie();
  assert.ok(browser(ctx(this), 1).cookies(bffHost).has(name), "the browser holds no session cookie");
});

function tokensOf(c: Ctx, user: string): string[] {
  const issued = c.provider!.issued.slice(c.issuedBefore).filter((i) => i.user === user);
  assert.ok(issued.length > 0, `the provider issued ${user} no tokens`);
  return issued.flatMap((i) => [i.accessToken, i.idToken, ...(i.refreshToken ? [i.refreshToken] : [])]);
}

Then("nothing the BFF sent the browser during sign-in holds alice's access token, ID token or refresh token", function () {
  const c = ctx(this);
  const tokens = tokensOf(c, "alice");
  for (const s of browser(c, 1).seen.filter((x) => x.url.port === String(c.port))) {
    const sent = `${[...s.headers].map(([k, v]) => `${k}: ${v}`).join("\n")}\n${s.body}`;
    for (const t of tokens) assert.ok(!sent.includes(t), `${s.method} ${s.url.pathname} sent the browser one of alice's tokens`);
  }
});

Then("the session cookie's value is not any of alice's tokens", long, async function () {
  const c = ctx(this);
  const value = browser(c, 1).cookies(bffHost).get(await sessionCookie());
  assert.ok(value, "the browser holds no session cookie");
  for (const t of tokensOf(c, "alice")) assert.ok(!value.includes(t) && !t.includes(value), "the session cookie holds one of alice's tokens");
});

Then("the two browsers hold different session cookies", long, async function () {
  const c = ctx(this);
  const name = await sessionCookie();
  const [a, b] = [browser(c, 1), browser(c, 2)].map((x) => x.cookies(bffHost).get(name));
  assert.ok(a, "the first browser holds no session cookie");
  assert.ok(b, "the second browser holds no session cookie");
  assert.notEqual(a, b);
});

// ---- Who the BFF treats as signed in ----

async function check(c: Ctx, b: Browser): Promise<Check> {
  const s = await b.request(bffUrl(c, "/auth/session"));
  c.check = { status: s.status, body: s.body };
  c.checks.push(c.check);
  return c.check;
}

function signedInAs(c: Ctx, k: Check, user: string): void {
  assert.equal(k.status, 200, `/auth/session answered ${k.status}: ${k.body}`);
  let who: { issuer?: string; subject?: string };
  try {
    who = JSON.parse(k.body);
  } catch {
    assert.fail(`/auth/session answered ${k.body}, not JSON`);
  }
  assert.equal(who.issuer, c.provider!.issuer);
  assert.equal(who.subject, c.provider!.subjectOf(user));
}

function notSignedIn(k: Check | undefined): void {
  assert.ok(k, "no browser asked the BFF who it is");
  assert.equal(k.status, 401, `/auth/session answered ${k.status}: ${k.body}`);
}

Then("the BFF still treats alice's browser as signed in as {string}", long, async function (user: string) {
  const c = ctx(this);
  signedInAs(c, await check(c, browser(c, 1)), user);
});

Then("the BFF still treats both browsers as signed in as {string}", long, async function (user: string) {
  const c = ctx(this);
  signedInAs(c, await check(c, browser(c, 1)), user);
  signedInAs(c, await check(c, browser(c, 2)), user);
});

Then("the BFF still treats the second browser as signed in as {string}", long, async function (user: string) {
  const c = ctx(this);
  signedInAs(c, await check(c, browser(c, 2)), user);
});

Then("the BFF no longer treats alice's browser as signed in", long, async function () {
  const c = ctx(this);
  notSignedIn(await check(c, browser(c, 1)));
});

Then("alice's session is unchanged", long, async function () {
  const c = ctx(this);
  const p = c.provider!;
  const mine = (rows: Record<string, unknown>[]) => rows
    .filter((r) => r.issuer === p.issuer && r.subject === p.subjectOf("alice"))
    .map(({ last_seen_at: _seen, ...r }) => r);
  const before = mine(c.before ?? []);
  assert.equal(before.length, 1, `alice had ${before.length} sessions before the restart`);
  assert.deepEqual(mine(await sessions()), before);
});

async function stranger(c: Ctx): Promise<Browser> {
  const b = new Browser();
  b.cookies(bffHost).set(await sessionCookie(), randomBytes(32).toString("base64url"));
  return b;
}

When("a browser presents a session cookie the BFF never issued", long, async function () {
  const c = ctx(this);
  c.other = await stranger(c);
  await check(c, c.other);
});

Given("alice's browser has kept a copy of its session cookie", long, async function () {
  const c = ctx(this);
  c.copied = browser(c, 1).cookies(bffHost).get((await load<SessionModule>("src/bff/session.ts"))?.SESSION_COOKIE ?? "");
});

When("a browser presents the copied session cookie", long, async function () {
  const c = ctx(this);
  c.other = new Browser();
  const name = (await load<SessionModule>("src/bff/session.ts"))?.SESSION_COOKIE;
  if (name && c.copied) c.other.cookies(bffHost).set(name, c.copied);
  await check(c, c.other);
});

Then("the BFF doesn't treat the browser as signed in", function () {
  notSignedIn(ctx(this).check);
});

// ---- Signing out ----

async function signOut(c: Ctx, b: Browser, path: string): Promise<void> {
  c.logout = await b.request(bffUrl(c, path), { method: "POST", headers: { origin: bffUrl(c, "/").origin } });
}

When("alice's browser signs out at {string}", long, async function (path: string) {
  const c = ctx(this);
  await signOut(c, browser(c, 1), path);
});

When("the first browser signs out at {string}", long, async function (path: string) {
  const c = ctx(this);
  await signOut(c, browser(c, 1), path);
});

When("a browser with no session cookie signs out at {string}", long, async function (path: string) {
  const c = ctx(this);
  c.other = new Browser();
  await signOut(c, c.other, path);
});

When("a browser presenting a session cookie the BFF never issued signs out at {string}", long, async function (path: string) {
  const c = ctx(this);
  const name = (await load<SessionModule>("src/bff/session.ts"))?.SESSION_COOKIE;
  c.other = new Browser();
  if (name) c.other.cookies(bffHost).set(name, randomBytes(32).toString("base64url"));
  await signOut(c, c.other, path);
});

Then("the BFF clears the session cookie", long, async function () {
  const c = ctx(this);
  assert.ok(c.logout, "no browser signed out");
  const name = await sessionCookie();
  assert.ok(c.logout.status < 400, `/auth/logout answered ${c.logout.status}: ${c.logout.body}`);
  const k = c.logout.setCookies.find((x) => x.name === name);
  assert.ok(k && clears(k), `/auth/logout doesn't clear the ${name} cookie`);
  assert.equal(k.attrs.path, "/", "/auth/logout clears the session cookie on a path other than /");
});

// ---- factory_bff ----

Then("every query the BFF ran ran as the role {string}", long, async function (role: string) {
  const rows = (await pool().query<{ role: string; what: string }>("select role, what from pbi288_audit")).rows;
  assert.ok(rows.length > 0, "the BFF ran no query on session");
  const others = rows.filter((r) => r.role !== role);
  assert.deepEqual(others, [], `the BFF ran queries as ${[...new Set(others.map((r) => r.role))].join(", ")}`);
  assert.ok(rows.some((r) => r.what === "INSERT"), "the BFF never wrote a session");
});

Given("the role {string} has lost its grants on sessions", long, async function (role: string) {
  const c = ctx(this);
  await pool().query(`revoke all on session from ${role}`);
  c.revoked = true;
});

// ---- Refresh tokens ----

async function storedRefreshToken(c: Ctx): Promise<string> {
  const rows = await sessionsOf(c, "alice");
  assert.equal(rows.length, 1, `alice has ${rows.length} sessions`);
  const sealed = rows[0].refresh_token_encrypted;
  assert.ok(sealed, "alice's session holds no refresh token");
  return sealed;
}

Then("alice's session holds a refresh token", long, async function () {
  await storedRefreshToken(ctx(this));
});

Then("alice's session holds no refresh token", long, async function () {
  const rows = await sessionsOf(ctx(this), "alice");
  assert.equal(rows.length, 1, `alice has ${rows.length} sessions`);
  assert.equal(rows[0].refresh_token_encrypted, null);
});

Then("the stored refresh token doesn't contain {string}", long, async function (token: string) {
  const sealed = await storedRefreshToken(ctx(this));
  assert.ok(!sealed.includes(token), "the stored refresh token holds the refresh token in the clear");
  assert.ok(!sealed.includes(Buffer.from(token).toString("base64")), "the stored refresh token holds the refresh token in base64");
});

async function opened(key: string, sealed: string): Promise<string | Error> {
  const m = await sessionModule();
  try {
    return m.openRefreshToken(key, sealed);
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

async function decryptsTo(c: Ctx, token: string): Promise<void> {
  const got = await opened(c.key!, await storedRefreshToken(c));
  assert.ok(!(got instanceof Error), `the stored refresh token doesn't open under the BFF's session key: ${(got as Error).message}`);
  assert.equal(got, token);
}

Then("the stored refresh token decrypts to {string} under the BFF's session key", long, async function (token: string) {
  await decryptsTo(ctx(this), token);
});

Then("the stored refresh token still decrypts to {string} under the BFF's session key", long, async function (token: string) {
  await decryptsTo(ctx(this), token);
});

Then("the stored refresh token doesn't decrypt under a different session key", long, async function () {
  const c = ctx(this);
  const got = await opened(randomBytes(32).toString("base64"), await storedRefreshToken(c));
  assert.ok(got instanceof Error || !c.provider!.issued.some((i) => i.refreshToken === got), "the stored refresh token opens under another key");
});

// ---- Reading the code and the AppHost ----

When("I read src\\/bff\\/main.ts", function () {
  // The Thens read src/bff/ themselves.
});

Then("it serves its routes with Hono", function () {
  assert.ok(existsSync(BFF_MAIN), "src/bff/main.ts doesn't exist");
  const dir = join(repo, "src", "bff");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => readFileSync(join(dir, f), "utf8"));
  const main = readFileSync(BFF_MAIN, "utf8");
  assert.ok(files.some((s) => /from\s+["']hono["']/.test(s) && /new\s+Hono\b/.test(s)), "nothing in src/bff/ builds its routes with new Hono()");
  assert.match(main, /from\s+["']@hono\/node-server["']/, "src/bff/main.ts doesn't serve through @hono/node-server");
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  for (const dep of ["hono", "@hono/node-server"]) assert.ok(pkg.dependencies?.[dep], `package.json doesn't depend on ${dep}`);
});

function appHost(): string {
  assert.ok(existsSync(APPHOST_FILE), "the AppHost source is missing");
  return readFileSync(APPHOST_FILE, "utf8");
}

/** The BFF resource's statements: the addNodeApp('bff', ...) one, and any later one on the variable it's held in. */
function bffResource(source: string): { runs: string; text: string } {
  const m = /(?:const|let)\s+(\w+)\s*=\s*await\s+builder\s*\.addNodeApp\(\s*(['"`])bff\2\s*,\s*[^,]+,\s*(['"`])([^'"`]+)\3/.exec(source);
  assert.ok(m, "the AppHost adds no 'bff' resource with addNodeApp");
  const statement = (at: number) => source.slice(at, source.indexOf(";", at) < 0 ? undefined : source.indexOf(";", at));
  const parts = [statement(m.index)];
  const uses = new RegExp(`\\b${m[1]}\\s*\\.`, "g");
  for (let u = uses.exec(source); u; u = uses.exec(source)) if (u.index > m.index) parts.push(statement(u.index));
  return { runs: m[4], text: parts.join("\n") };
}

/** The expression the BFF resource gets for an environment variable, with a bare identifier resolved once. */
function envValue(source: string, name: string): string | null {
  const m = new RegExp(`withEnvironment\\(\\s*(['"\`])${name}\\1\\s*,\\s*([^)]+?)\\s*\\)`).exec(bffResource(source).text);
  if (!m) return null;
  const v = m[2];
  if (/^\w+$/.test(v)) {
    const d = new RegExp(`(?:const|let)\\s+${v}\\s*=\\s*([^;]+);`).exec(source);
    if (d) return d[1];
  }
  return v;
}

Then("it adds a BFF resource that runs src\\/bff\\/main.ts", function () {
  assert.equal(bffResource(appHost()).runs, "src/bff/main.ts");
});

Then("it gives the BFF port {int}", function (port: number) {
  const text = bffResource(appHost()).text;
  assert.match(text, new RegExp(`withHttpEndpoint\\([^;]*\\bport\\s*:\\s*${port}\\b`), `the BFF resource isn't given port ${port}`);
});

Then("it hands the BFF the issuer, the client id, the client secret and the session key", function () {
  const source = appHost();
  for (const name of ["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "BFF_SESSION_KEY"]) {
    assert.ok(envValue(source, name), `the AppHost doesn't hand the BFF ${name}`);
  }
});

function realmName(): string {
  for (const f of readdirSync(REALM_DIR).filter((x) => x.endsWith(".json"))) {
    const doc = JSON.parse(readFileSync(join(REALM_DIR, f), "utf8")) as { realm?: string };
    if (typeof doc.realm === "string") return doc.realm;
  }
  throw new Error("no realm JSON in aspire-apphost/keycloak");
}

Then("the issuer it hands the BFF is the Keycloak realm on port {int}", function (port: number) {
  const v = envValue(appHost(), "OIDC_ISSUER");
  assert.ok(v, "the AppHost doesn't hand the BFF OIDC_ISSUER");
  assert.ok(v.includes(`/realms/${realmName()}`), `the issuer ${v} isn't the realm ${realmName()}`);
  assert.ok(v.includes(String(port)) || /\bkeycloak\b/.test(v), `the issuer ${v} isn't on port ${port}`);
});

Then("the client id it hands the BFF is {string}", function (id: string) {
  const v = envValue(appHost(), "OIDC_CLIENT_ID");
  assert.ok(v, "the AppHost doesn't hand the BFF OIDC_CLIENT_ID");
  assert.equal(v.replace(/^(['"`])(.*)\1$/, "$2"), id);
});

// ---- @local: the owner runs these, and the PR records the run ----

function testOwner(): { id: string; username: string; password: string } {
  for (const f of readdirSync(REALM_DIR).filter((x) => x.endsWith(".json"))) {
    const doc = JSON.parse(readFileSync(join(REALM_DIR, f), "utf8")) as { users?: Record<string, any>[] };
    for (const u of doc.users ?? []) {
      const cred = (u.credentials ?? []).find((cr: Record<string, unknown>) => cr.type === "password" && typeof cr.value === "string");
      if (typeof u.username === "string" && typeof u.id === "string" && cred) return { id: u.id, username: u.username, password: cred.value };
    }
  }
  throw new Error("the realm import has no test owner with a password and a fixed id");
}

function lc(c: Ctx): NonNullable<Ctx["local"]> {
  c.aspireStarted = true;
  c.local ??= { browser: new Browser() };
  return c.local;
}

/** Follows redirects from `at` until a page that isn't one, up to ten hops. */
async function follow(b: Browser, at: Seen): Promise<Seen> {
  for (let hop = 0; hop < 10 && isRedirect(at); hop++) at = await b.next(at);
  return at;
}

When("a browser opens {string}", local, async function (url: string) {
  const l = lc(ctx(this));
  l.page = await follow(l.browser, await l.browser.request(new URL(url)));
});

Then("the browser lands on Keycloak's sign-in page for the realm on port {int}", function (port: number) {
  const l = lc(ctx(this));
  assert.ok(l.page, "the browser opened nothing");
  assert.equal(l.page.url.port, String(port), `the browser landed on ${l.page.url.href}`);
  assert.match(l.page.url.pathname, new RegExp(`/realms/${realmName()}/protocol/openid-connect/auth`));
  assert.match(l.page.body, /id="kc-form-login"/, "the page has no Keycloak sign-in form");
});

When("the browser signs in there as the test owner", local, async function () {
  const l = lc(ctx(this));
  assert.ok(l.page, "the browser is on no sign-in page");
  const action = /<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/.exec(l.page.body)?.[1].replaceAll("&amp;", "&");
  assert.ok(action, "the sign-in page has no form action");
  const owner = testOwner();
  const posted = await l.browser.request(new URL(action, l.page.url), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: owner.username, password: owner.password, credentialId: "" }).toString(),
  });
  l.back = await follow(l.browser, posted);
});

Then("the browser comes back to {string}", function (url: string) {
  const l = lc(ctx(this));
  assert.ok(l.back, "the browser never signed in");
  assert.equal(l.back.url.origin, new URL(url).origin, `the browser ended on ${l.back.url.href}`);
  assert.ok(!l.back.url.pathname.startsWith("/auth/"), `the browser ended on ${l.back.url.href}`);
});

Then("a session for the test owner from the realm's issuer on port {int} exists", local, async function (port: number) {
  const r = spawnSync(`aspire describe bff --format Json ${APPHOST}`, { cwd: repo, shell: true, encoding: "utf8" });
  // Asserted on, never printed: describe shows environment values such as FACTORY_DB_URI.
  const uri = /"FACTORY_DB_URI"\s*:\s*"([^"]+)"/.exec(r.stdout ?? "")?.[1] ?? /postgres(?:ql)?:\/\/[^"\s]+/.exec(r.stdout ?? "")?.[0];
  assert.ok(uri, "Aspire gave the BFF resource no FACTORY_DB_URI");
  const client = new pg.Client({ connectionString: uri });
  await client.connect();
  try {
    const issuer = `http://localhost:${port}/realms/${realmName()}`;
    const rows = (await client.query("select 1 from session where issuer = $1 and subject = $2", [issuer, testOwner().id])).rows;
    assert.ok(rows.length >= 1, `no session for the test owner from ${issuer}`);
  } finally {
    await client.end();
  }
});
