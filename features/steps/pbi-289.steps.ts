// Step definitions for features/pbi-289-bff-guards-and-forwards.feature.
//
// The scenarios run the BFF as `node src/bff/main.ts` in a child process, as PBI 288's do, with the same settings and
// one more: API_URL, the base address of the API it forwards /bff/v1/* to, here the stand-in API in
// features/fixtures/pbi-289-api.ts, which records every call it gets. Signing in, the scripted browser, the session
// cookie and the stored refresh token are PBI 288's steps and helpers (features/steps/pbi-288.steps.ts), and they share
// its context. The test provider (features/fixtures/pbi-288-provider.ts) answers refreshes, and its "next refresh"
// settings shape the next one.
// Time is moved in the session table: a step that says a token expires, or a session was used or began some time ago,
// sets that row's timestamps, as the BFF wrote them, to where they would be.
// Every step asserts something. A Given asserts only what it arranges, so a scenario can't pass on a precondition that
// never held.
import { After, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { startApi, type ApiCall, type StandInApi } from "../fixtures/pbi-289-api.ts";
import {
  answers, bffHost, bffUrl, browser, Browser, CLIENT_ID, CLIENT_SECRET, ctx as shared, dbUrl, freePort, providerOf,
  sessionCookie, signOut, startBff, stopBff, type Ctx as Shared, type Seen,
} from "./pbi-288.steps.ts";
import { long, need } from "./pbi-8.steps.ts";

type Ctx = {
  api?: StandInApi;
  /** The BFF's answer to the last call a browser made. */
  last?: Seen;
};

function ctx(world: object): Ctx {
  const w = world as { pbi289?: Ctx };
  w.pbi289 ??= {};
  return w.pbi289;
}

const pool = () => need().pool;

After({ tags: "@pbi-289", ...long }, async function () {
  const s = shared(this);
  await stopBff(s);
  await s.provider?.stop();
  await ctx(this).api?.stop();
});

// ---- Background ----

Given("a stand-in API is running", long, async function () {
  const api = (ctx(this).api = await startApi());
  const r = await fetch(new URL("/v1/ping", api.url), { signal: AbortSignal.timeout(10_000) });
  assert.equal(r.status, 200, `the stand-in API answered ${r.status}`);
  assert.equal(api.calls.length, 1, "the stand-in API didn't record the call it got");
  api.calls.length = 0;
});

Given("the BFF is running against that provider as its issuer and that stand-in as its API", long, async function () {
  const s = shared(this);
  const api = ctx(this).api;
  assert.ok(api, "no stand-in API is running");
  const url = await dbUrl();
  await pool().query("truncate session");
  s.port = await freePort();
  s.key = randomBytes(32).toString("base64");
  s.env = {
    FACTORY_DB_URI: url,
    OIDC_ISSUER: providerOf(s).issuer,
    OIDC_CLIENT_ID: CLIENT_ID,
    OIDC_CLIENT_SECRET: CLIENT_SECRET,
    OIDC_SCOPES: "openid",
    BFF_SESSION_KEY: s.key,
    PORT: String(s.port),
    BFF_ORIGIN: `http://localhost:${s.port}`,
    API_URL: api.url,
  };
  await startBff(s);
});

Given("the BFF's own origin is {string}", long, async function (origin: string) {
  const s = shared(this);
  const u = new URL(origin);
  assert.equal(u.hostname, bffHost, `the scenarios reach the BFF on ${bffHost}, not ${u.hostname}`);
  const port = Number(u.port);
  await stopBff(s);
  assert.ok(!(await answers(port)), `something else already answers on port ${port}`);
  s.port = port;
  s.env = { ...s.env!, PORT: String(port), BFF_ORIGIN: u.origin };
  await startBff(s);
  assert.equal(bffUrl(s, "/").origin, u.origin, `the browser reaches the BFF on ${bffUrl(s, "/").origin}`);
});

// ---- Arranging the API and the provider ----

Given("the API will answer {word} {string} with {int} and the body {string}", function (method: string, url: string, status: number, body: string) {
  const api = ctx(this).api;
  assert.ok(api, "no stand-in API is running");
  api.answer(method, url, { status, body });
  assert.deepEqual(api.answering(method, url), { status, body }, `the stand-in API won't answer ${method} ${url} as told`);
});


Given("the provider issues a different access token for each sign-in", function () {
  const p = providerOf(shared(this));
  p.distinctAccessTokens = true;
  assert.equal(p.distinctAccessTokens, true, "the test provider didn't keep the setting");
});

Given("the provider will issue the access token {string} on the next refresh", function (token: string) {
  const p = providerOf(shared(this));
  p.nextRefresh.accessToken = token;
  assert.equal(p.nextRefresh.accessToken, token, "the test provider didn't keep the next refresh's access token");
});

Given("the provider will issue the access token {string}, lasting {int} minutes, on the next refresh", function (token: string, minutes: number) {
  const p = providerOf(shared(this));
  p.nextRefresh.accessToken = token;
  p.nextRefresh.expiresIn = minutes * 60;
  assert.equal(p.nextRefresh.accessToken, token, "the test provider didn't keep the next refresh's access token");
  assert.equal(p.nextRefresh.expiresIn, minutes * 60, "the test provider didn't keep the next refresh's lifetime");
});

Given("the provider will issue the refresh token {string} on the next refresh", function (token: string) {
  const p = providerOf(shared(this));
  p.nextRefresh.refreshToken = token;
  assert.equal(p.nextRefresh.refreshToken, token, "the test provider didn't keep the next refresh's refresh token");
});

Given("the provider will refuse the next refresh", function () {
  const p = providerOf(shared(this));
  p.nextRefresh.refuse = true;
  assert.equal(p.nextRefresh.refuse, true, "the test provider didn't keep the setting");
});

// ---- Arranging the session ----

/** The hash of the session cookie browser `n` holds, which keys its session row. */
async function cookieHashOf(s: Shared, n: number): Promise<string> {
  const name = await sessionCookie();
  const id = browser(s, n).cookies(bffHost).get(name);
  assert.ok(id, `browser ${n} holds no ${name} cookie`);
  return createHash("sha256").update(id).digest("hex");
}

/** Runs `set` on alice's session row, the one her first browser's cookie names, and asserts it changed that row. */
async function setAlice(world: object, set: string, params: unknown[] = []): Promise<void> {
  const hash = await cookieHashOf(shared(world), 1);
  const r = await pool().query(`update session set ${set} where cookie_hash = $1`, [hash, ...params]);
  assert.equal(r.rowCount, 1, "alice's browser's cookie names no session row");
}

Given("alice's browser has signed out at {string}", long, async function (path: string) {
  const s = shared(this);
  const b = browser(s, 1);
  await signOut(s, b, path);
  assert.ok(s.logout && s.logout.status < 400, `${path} answered ${s.logout?.status}: ${s.logout?.body}`);
  assert.ok(!b.cookies(bffHost).has(await sessionCookie()), "alice's browser still holds its session cookie");
});

Given("alice's access token expires in {int} seconds", long, async function (seconds: number) {
  await setAlice(this, "access_token_expires_at = now() + make_interval(secs => $2)", [seconds]);
});

Given("alice's access token expires in {int} minutes", long, async function (minutes: number) {
  await setAlice(this, "access_token_expires_at = now() + make_interval(mins => $2)", [minutes]);
});

Given("alice's access token expired {int} seconds ago", long, async function (seconds: number) {
  await setAlice(this, "access_token_expires_at = now() - make_interval(secs => $2)", [seconds]);
});

Given("alice's session was last used {int} day(s) ago", long, async function (days: number) {
  await setAlice(this, "last_seen_at = now() - make_interval(days => $2)", [days]);
});

Given("alice's session began {int} days ago", long, async function (days: number) {
  // The BFF set the session's end 30 days after it began, so the end moves back with the start.
  await setAlice(this, "expires_at = expires_at - (created_at - (now() - make_interval(days => $2))), created_at = now() - make_interval(days => $2)", [days]);
});

When("{int} more days pass", long, async function (days: number) {
  const r = await pool().query(
    `update session set created_at = created_at - make_interval(days => $1), last_seen_at = last_seen_at - make_interval(days => $1),
       expires_at = expires_at - make_interval(days => $1), access_token_expires_at = access_token_expires_at - make_interval(days => $1)`,
    [days],
  );
  assert.ok((r.rowCount ?? 0) >= 1, "no session to move through time");
});

// ---- Calling the BFF ----

type CallOptions = { origin?: string; json?: string; bearer?: string };

async function call(world: object, b: Browser, method: string, path: string, o: CallOptions = {}): Promise<void> {
  const s = shared(world);
  const headers: Record<string, string> = {};
  if (o.origin !== undefined) headers.origin = o.origin;
  if (o.bearer !== undefined) headers.authorization = `Bearer ${o.bearer}`;
  if (o.json !== undefined) headers["content-type"] = "application/json";
  const seen = await b.request(bffUrl(s, path), { method, headers, body: o.json });
  assert.notEqual(seen.status, 0, `the BFF didn't answer ${method} ${path}: ${seen.body}`);
  ctx(world).last = seen;
}

const ownOrigin = (world: object) => bffUrl(shared(world), "/").origin;

async function stranger(): Promise<Browser> {
  const b = new Browser();
  b.cookies(bffHost).set(await sessionCookie(), randomBytes(32).toString("base64url"));
  return b;
}

/** A new browser holding the session cookie alice's browser copied. */
async function copied(world: object): Promise<Browser> {
  const s = shared(world);
  assert.ok(s.copied, "no session cookie was copied to present");
  const b = new Browser();
  b.cookies(bffHost).set(await sessionCookie(), s.copied);
  return b;
}

When("a browser with no session cookie calls {word} {string}", long, async function (method: string, path: string) {
  await call(this, new Browser(), method, path);
});

When("a browser with no session cookie calls {word} {string} from the BFF's own origin", long, async function (method: string, path: string) {
  await call(this, new Browser(), method, path, { origin: ownOrigin(this) });
});

When("a browser presenting a session cookie the BFF never issued calls {word} {string}", long, async function (method: string, path: string) {
  await call(this, await stranger(), method, path);
});

When("a browser presenting the copied session cookie calls {word} {string}", long, async function (method: string, path: string) {
  await call(this, await copied(this), method, path);
});

When("alice's browser calls {word} {string}", long, async function (method: string, path: string) {
  await call(this, browser(shared(this), 1), method, path);
});

When("alice's browser calls {word} {string} again", long, async function (method: string, path: string) {
  await call(this, browser(shared(this), 1), method, path);
});

When("alice's browser calls {word} {string} from the BFF's own origin", long, async function (method: string, path: string) {
  await call(this, browser(shared(this), 1), method, path, { origin: ownOrigin(this) });
});

When("alice's browser calls {word} {string} from the BFF's own origin with the JSON body {string}", long, async function (method: string, path: string, body: string) {
  await call(this, browser(shared(this), 1), method, path, { origin: ownOrigin(this), json: body });
});

When("alice's browser calls {word} {string} with its own bearer token {string}", long, async function (method: string, path: string, token: string) {
  await call(this, browser(shared(this), 1), method, path, { bearer: token });
});

When("alice's browser calls {word} {string} with the Origin {string}", long, async function (method: string, path: string, origin: string) {
  await call(this, browser(shared(this), 1), method, path, { origin });
});

When("alice's browser calls {word} {string} with no Origin", long, async function (method: string, path: string) {
  await call(this, browser(shared(this), 1), method, path);
});

When("the first browser calls {word} {string}", long, async function (method: string, path: string) {
  await call(this, browser(shared(this), 1), method, path);
});

When("the second browser calls {word} {string}", long, async function (method: string, path: string) {
  await call(this, browser(shared(this), 2), method, path);
});

// ---- What the BFF answered ----

function last(world: object): Seen {
  const l = ctx(world).last;
  assert.ok(l, "no browser called the BFF");
  return l;
}

Then("the BFF answers {int}", function (status: number) {
  const l = last(this);
  assert.equal(l.status, status, `${l.method} ${l.url.pathname}${l.url.search} answered ${l.status}: ${l.body}`);
});

Then("the BFF answers {int} with the body {string}", function (status: number, body: string) {
  const l = last(this);
  assert.equal(l.status, status, `${l.method} ${l.url.pathname}${l.url.search} answered ${l.status}: ${l.body}`);
  assert.equal(l.body, body);
});

// ---- What the API received ----

function calls(world: object): ApiCall[] {
  const api = ctx(world).api;
  assert.ok(api, "no stand-in API is running");
  return api.calls;
}

const listed = (cs: ApiCall[]) => JSON.stringify(cs.map((x) => `${x.method} ${x.url}`));

/** The one call the API received, asserting it received exactly one. */
function onlyCall(world: object): ApiCall {
  const cs = calls(world);
  assert.equal(cs.length, 1, `the API received ${cs.length} calls: ${listed(cs)}`);
  return cs[0];
}

/** The API's `n`th call, counting from 1. */
function nthCall(world: object, n: number): ApiCall {
  const cs = calls(world);
  assert.ok(cs.length >= n, `the API received ${cs.length} calls, not ${n} or more: ${listed(cs)}`);
  return cs[n - 1];
}

function bearer(k: ApiCall): string | undefined {
  return /^Bearer\s+(\S+)$/i.exec(k.headers.authorization ?? "")?.[1];
}

function carriesBearer(k: ApiCall, token: string, whose: string): void {
  assert.ok(k.headers.authorization, `${k.method} ${k.url} carried no Authorization header`);
  assert.equal(bearer(k), token, `${k.method} ${k.url} didn't carry ${whose} as a bearer token`);
}

/** The access token the provider issued alice last, at sign-in or on a refresh. */
function currentToken(world: object): string {
  const p = providerOf(shared(world));
  const t = p.issued.filter((i) => i.user === "alice").at(-1);
  assert.ok(t, "the provider issued alice no access token");
  return t.accessToken;
}

/** The access token the provider issued alice when she last signed in. */
function signInToken(world: object): string {
  const p = providerOf(shared(world));
  const t = p.issued.filter((i) => i.user === "alice" && i.grant === "authorization_code").at(-1);
  assert.ok(t, "the provider issued alice no access token at sign-in");
  return t.accessToken;
}

/** The access token in the session row that browser `n`'s cookie names. */
async function browserToken(world: object, n: number): Promise<string> {
  const hash = await cookieHashOf(shared(world), n);
  const r = await pool().query<{ access_token: string }>("select access_token from session where cookie_hash = $1", [hash]);
  assert.equal(r.rows.length, 1, `browser ${n}'s cookie names no session row`);
  return r.rows[0].access_token;
}

Then("the API received no call", function () {
  const cs = calls(this);
  assert.equal(cs.length, 0, `the API received ${listed(cs)}`);
});

Then("the API received one call, {word} {string}", function (method: string, url: string) {
  const k = onlyCall(this);
  assert.equal(`${k.method} ${k.url}`, `${method} ${url}`);
});

Then("the API received {int} calls", function (n: number) {
  const cs = calls(this);
  assert.equal(cs.length, n, `the API received ${cs.length} calls: ${listed(cs)}`);
});

Then("that call carried alice's current access token as a bearer token", function () {
  carriesBearer(onlyCall(this), currentToken(this), "alice's current access token");
});

Then("that call carried alice's access token from sign-in as a bearer token", function () {
  carriesBearer(onlyCall(this), signInToken(this), "alice's access token from sign-in");
});

Then("that call carried {string} as a bearer token", function (token: string) {
  carriesBearer(onlyCall(this), token, JSON.stringify(token));
});

Then("that call carried the JSON body {string}", function (body: string) {
  const k = onlyCall(this);
  let got: unknown;
  try {
    got = JSON.parse(k.body);
  } catch {
    assert.fail(`${k.method} ${k.url} carried ${JSON.stringify(k.body)}, not JSON`);
  }
  assert.deepEqual(got, JSON.parse(body));
});

Then("the call the API received carried no cookie", function () {
  const k = onlyCall(this);
  assert.equal(k.headers.cookie, undefined, `${k.method} ${k.url} carried the cookie ${k.headers.cookie}`);
});

Then("the call the API received carried alice's current access token as a bearer token", function () {
  carriesBearer(onlyCall(this), currentToken(this), "alice's current access token");
});

Then("the call the API received didn't carry {string}", function (text: string) {
  const k = onlyCall(this);
  const sent = `${k.method} ${k.url}\n${Object.entries(k.headers).map(([h, v]) => `${h}: ${v}`).join("\n")}\n${k.body}`;
  assert.ok(!sent.includes(text), `${k.method} ${k.url} carried ${JSON.stringify(text)}`);
});

Then("the API's first call carried the first browser's access token", long, async function () {
  carriesBearer(nthCall(this, 1), await browserToken(this, 1), "the first browser's access token");
});

Then("the API's second call carried the second browser's access token", long, async function () {
  carriesBearer(nthCall(this, 2), await browserToken(this, 2), "the second browser's access token");
});

Then("the API's second call carried {string} as a bearer token", function (token: string) {
  carriesBearer(nthCall(this, 2), token, JSON.stringify(token));
});

// ---- What the provider received ----

function refreshes(world: object) {
  return providerOf(shared(world)).tokenRequests.filter((t) => t.form.grant_type === "refresh_token");
}

Then("the provider received a refresh with alice's refresh token", function () {
  const p = providerOf(shared(this));
  const signIn = p.issued.filter((i) => i.user === "alice" && i.grant === "authorization_code").at(-1);
  assert.ok(signIn?.refreshToken, "the provider issued alice no refresh token at sign-in");
  const rs = refreshes(this);
  assert.ok(rs.length > 0, "the provider received no refresh");
  assert.ok(rs.some((r) => r.form.refresh_token === signIn.refreshToken), "no refresh the provider received carried alice's refresh token");
});

Then("the provider received no refresh", function () {
  const rs = refreshes(this);
  assert.equal(rs.length, 0, `the provider received ${rs.length} refreshes`);
});

Then("the provider received one refresh", function () {
  const rs = refreshes(this);
  assert.equal(rs.length, 1, `the provider received ${rs.length} refreshes`);
});
