import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { startProvider, type Provider } from "../../features/fixtures/pbi-288-provider.ts";
import { startApi, type StandInApi } from "../../features/fixtures/pbi-289-api.ts";
import { createBff, SIGNIN_COOKIE } from "./app.ts";
import { hashSessionId, openRefreshToken, SESSION_COOKIE, type NewSession, type Session, type SessionStore } from "./session.ts";

const ORIGIN = "http://localhost:7403";
const KEY = randomBytes(32).toString("base64");

function memory(): SessionStore & { rows: Map<string, NewSession>; failing?: boolean } {
  const rows = new Map<string, NewSession>();
  const store = {
    rows,
    failing: false,
    async create(s: NewSession) {
      if (store.failing) throw new Error("permission denied for table session");
      rows.set(s.cookieHash, s);
    },
    async find(h: string): Promise<Session | null> {
      const s = rows.get(h);
      return s ? { ...s } : null;
    },
    async updateTokens(h: string, t: Pick<Session, "accessToken" | "accessTokenExpiresAt" | "refreshTokenEncrypted">) {
      const s = rows.get(h);
      if (s) rows.set(h, { ...s, ...t });
    },
    async remove(h: string) {
      rows.delete(h);
    },
  };
  return store;
}

let provider: Provider;
let api: StandInApi;
let store: ReturnType<typeof memory>;
let app: ReturnType<typeof createBff>;

before(async () => {
  provider = await startProvider("alice");
  api = await startApi();
});
after(async () => {
  await provider.stop();
  await api.stop();
});
beforeEach(() => {
  store = memory();
  api.calls.length = 0;
  provider.tokenRequests.length = 0;
  app = createBff({
    issuer: provider.issuer, clientId: "dashboard", clientSecret: "s", scopes: "openid", origin: ORIGIN, key: Buffer.from(KEY, "base64"),
    sessions: store, apiUrl: api.url,
  });
});

type Jar = Map<string, string>;
const cookieHeader = (jar: Jar) => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

function absorb(jar: Jar, r: Response): string[] {
  const set = r.headers.getSetCookie();
  for (const raw of set) {
    const [pair] = raw.split(";");
    const [name, value] = [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)];
    if (/max-age=0/i.test(raw)) jar.delete(name);
    else jar.set(name, value);
  }
  return set;
}

async function get(jar: Jar, path: string, init: RequestInit = {}): Promise<Response> {
  const r = await app.request(new URL(path, ORIGIN).href, { ...init, headers: { ...(init.headers as Record<string, string>), cookie: cookieHeader(jar) } });
  absorb(jar, r);
  return r;
}

/** Login, the provider's authorize, and the callback. Returns the callback's answer. */
async function signIn(jar: Jar): Promise<Response> {
  const login = await get(jar, "/auth/login");
  assert.equal(login.status, 302);
  const back = await fetch(login.headers.get("location")!, { redirect: "manual" });
  const cb = new URL(back.headers.get("location")!);
  return get(jar, cb.pathname + cb.search);
}

test("login sends the browser to the provider with a code request, PKCE, state, nonce and the callback", async () => {
  const jar: Jar = new Map();
  const r = await get(jar, "/auth/login");
  const to = new URL(r.headers.get("location")!);
  assert.equal(`${to.origin}${to.pathname}`, provider.authorizationEndpoint);
  assert.equal(to.searchParams.get("response_type"), "code");
  assert.equal(to.searchParams.get("client_id"), "dashboard");
  assert.equal(to.searchParams.get("scope"), "openid");
  assert.equal(to.searchParams.get("code_challenge_method"), "S256");
  assert.ok(to.searchParams.get("state") && to.searchParams.get("nonce") && to.searchParams.get("code_challenge"));
  assert.equal(to.searchParams.get("redirect_uri"), `${ORIGIN}/auth/callback`);
  const set = r.headers.getSetCookie().join("\n");
  assert.match(set, new RegExp(`${SIGNIN_COOKIE}=`));
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Lax/);
  assert.match(set, /Max-Age=600/);
});

test("a completed sign-in stores a session, sets only the session cookie, and seals the refresh token", async () => {
  provider.next.refreshToken = "rt-1";
  const jar: Jar = new Map();
  const r = await signIn(jar);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "/");
  assert.deepEqual([...jar.keys()], [SESSION_COOKIE]);
  const set = r.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
  assert.match(set, /Path=\//);
  assert.doesNotMatch(set, /Secure/);
  const row = store.rows.get(hashSessionId(jar.get(SESSION_COOKIE)!))!;
  assert.equal(row.issuer, provider.issuer);
  assert.equal(row.subject, provider.subjectOf("alice"));
  assert.equal(openRefreshToken(KEY, row.refreshTokenEncrypted!), "rt-1");
  const who = await get(jar, "/auth/session");
  assert.deepEqual(await who.json(), { issuer: provider.issuer, subject: provider.subjectOf("alice") });
});

test("a sign-in with no refresh token stores none", async () => {
  provider.next.refreshToken = null;
  await signIn(new Map());
  assert.equal([...store.rows.values()][0].refreshTokenEncrypted, null);
});

for (const kind of ["opaque", "dotted"] as const) {
  test(`a sign-in whose access token is ${kind} is refused because it isn't a JWT`, async () => {
    provider.next.accessToken = kind;
    const jar: Jar = new Map();
    const r = await signIn(jar);
    assert.equal(r.status, 401);
    assert.match(await r.text(), /JWT/);
    assert.equal(store.rows.size, 0);
    assert.ok(!jar.has(SESSION_COOKIE));
  });
}

test("a callback with the wrong state, no sign-in cookie, a provider error or a different nonce is refused", async () => {
  const wrongState = new Map<string, string>();
  const login = await get(wrongState, "/auth/login");
  const state = new URL(login.headers.get("location")!).searchParams.get("state");
  assert.equal((await get(wrongState, `/auth/callback?code=x&state=not-${state}`)).status, 400);
  assert.equal((await get(new Map(), "/auth/callback?code=x&state=y")).status, 400);
  const denied = new Map<string, string>();
  const l2 = await get(denied, "/auth/login");
  const s2 = new URL(l2.headers.get("location")!).searchParams.get("state");
  assert.equal((await get(denied, `/auth/callback?error=access_denied&state=${s2}`)).status, 401);
  provider.next.differentNonce = true;
  assert.equal((await signIn(new Map())).status, 401);
  assert.equal(store.rows.size, 0);
});

test("a sign-in fails when the session can't be stored", async () => {
  store.failing = true;
  const jar: Jar = new Map();
  assert.equal((await signIn(jar)).status, 500);
  assert.ok(!jar.has(SESSION_COOKIE));
});

test("logout deletes the session and clears the cookie, and refuses another origin", async () => {
  const jar: Jar = new Map();
  await signIn(jar);
  const copy = jar.get(SESSION_COOKIE)!;
  assert.equal((await get(new Map(jar), "/auth/logout", { method: "POST", headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal(store.rows.size, 1);
  const r = await get(jar, "/auth/logout", { method: "POST", headers: { origin: ORIGIN } });
  assert.equal(r.status, 204);
  assert.match(r.headers.getSetCookie().join("\n"), new RegExp(`${SESSION_COOKIE}=; Max-Age=0; Path=/`));
  assert.equal(store.rows.size, 0);
  assert.equal((await get(new Map([[SESSION_COOKIE, copy]]), "/auth/session")).status, 401);
});

test("the session route answers 401 without a session cookie or with one never issued", async () => {
  assert.equal((await get(new Map(), "/auth/session")).status, 401);
  assert.equal((await get(new Map([[SESSION_COOKIE, "made-up"]]), "/auth/session")).status, 401);
});

test("a callback whose provider discovery fails answers 502 and clears the sign-in cookie", async () => {
  const jar: Jar = new Map();
  const login = await get(jar, "/auth/login");
  const state = new URL(login.headers.get("location")!).searchParams.get("state");
  assert.ok(jar.has(SIGNIN_COOKIE));
  const down = createBff({
    issuer: provider.issuer, clientId: "dashboard", scopes: "openid", origin: ORIGIN, key: Buffer.from(KEY, "base64"), sessions: store,
    fetch: async () => { throw new Error("connect ECONNREFUSED"); },
  });
  const r = await down.request(new URL(`/auth/callback?code=x&state=${state}`, ORIGIN).href, { headers: { cookie: cookieHeader(jar) } });
  assert.equal(r.status, 502);
  absorb(jar, r);
  assert.ok(!jar.has(SIGNIN_COOKIE));
  assert.equal(store.rows.size, 0);
});

// ---- /bff: the Origin guard, the session check, the refresh and the forward to the API (step 7b) ----

/** A signed-in jar, and the hash its session row is stored under. */
async function signedIn(): Promise<{ jar: Jar; hash: string }> {
  const jar: Jar = new Map();
  assert.equal((await signIn(jar)).status, 302);
  api.calls.length = 0;
  provider.tokenRequests.length = 0;
  return { jar, hash: hashSessionId(jar.get(SESSION_COOKIE)!) };
}

const refreshes = () => provider.tokenRequests.filter((t) => t.form.grant_type === "refresh_token");

test("a /bff/v1 call without a session, or with one never issued, gets 401 and doesn't reach the API", async () => {
  assert.equal((await get(new Map(), "/bff/v1/floor")).status, 401);
  assert.equal((await get(new Map([[SESSION_COOKIE, "made-up"]]), "/bff/v1/floor")).status, 401);
  assert.equal((await get(new Map(), "/bff/v1/items/1/hold", { method: "POST", headers: { origin: ORIGIN } })).status, 401);
  assert.equal(api.calls.length, 0);
});

test("a signed-in call goes to the API's /v1 with its query and the session's bearer token, and no cookie", async () => {
  const { jar, hash } = await signedIn();
  api.answer("GET", "/v1/items?state=Green&page=2", { status: 403, body: '{"error":"no access"}' });
  const r = await get(jar, "/bff/v1/items?state=Green&page=2", { headers: { authorization: "Bearer forged" } });
  assert.equal(r.status, 403);
  assert.equal(await r.text(), '{"error":"no access"}');
  assert.equal(r.headers.get("content-type"), "application/json");
  assert.equal(api.calls.length, 1);
  const k = api.calls[0];
  assert.equal(`${k.method} ${k.url}`, "GET /v1/items?state=Green&page=2");
  assert.equal(k.headers.authorization, `Bearer ${store.rows.get(hash)!.accessToken}`);
  assert.equal(k.headers.cookie, undefined);
  assert.equal(refreshes().length, 0);
});

test("a state-changing call from the BFF's own origin goes to the API with its method and body", async () => {
  const { jar } = await signedIn();
  const r = await get(jar, "/bff/v1/items/482/hold", {
    method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: '{"reason":"x"}',
  });
  assert.equal(r.status, 200);
  const k = api.calls[0];
  assert.equal(`${k.method} ${k.url}`, "POST /v1/items/482/hold");
  assert.equal(k.body, '{"reason":"x"}');
  assert.equal(k.headers["content-type"], "application/json");
  assert.equal(k.headers.origin, undefined);
});

test("a state-changing /bff call from another origin, or with none, gets 403, while a read from another origin goes through", async () => {
  const { jar } = await signedIn();
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal((await get(jar, "/bff/v1/items/1/hold", { method, headers: { origin: "https://evil.example" } })).status, 403, method);
  }
  assert.equal((await get(jar, "/bff/v1/items/1/hold", { method: "POST" })).status, 403);
  assert.equal((await get(jar, "/bff/v1/items/1/hold", { method: "POST", headers: { origin: "http://localhost:7400" } })).status, 403);
  assert.equal((await get(jar, "/bff/v2/anything", { method: "POST", headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await get(new Map(), "/bff/v1/x", { method: "POST", headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal(api.calls.length, 0);
  assert.equal((await get(jar, "/bff/v1/floor", { headers: { origin: "https://evil.example" } })).status, 200);
  assert.equal(api.calls.length, 1);
});

for (const left of [30, -10]) {
  test(`a token with ${left} seconds left is refreshed, kept with the new sealed refresh token, and the call carries the new one`, async () => {
    const { jar, hash } = await signedIn();
    const row = store.rows.get(hash)!;
    const old = openRefreshToken(KEY, row.refreshTokenEncrypted!);
    row.accessTokenExpiresAt = new Date(Date.now() + left * 1000);
    provider.nextRefresh.accessToken = "at-2";
    provider.nextRefresh.refreshToken = "rt-2";
    provider.nextRefresh.expiresIn = 300;
    assert.equal((await get(jar, "/bff/v1/floor")).status, 200);
    assert.equal(refreshes().length, 1);
    assert.equal(refreshes()[0].form.refresh_token, old);
    assert.equal(api.calls[0].headers.authorization, "Bearer at-2");
    const now = store.rows.get(hash)!;
    assert.equal(now.accessToken, "at-2");
    assert.equal(openRefreshToken(KEY, now.refreshTokenEncrypted!), "rt-2");
    assert.ok(Math.abs(now.accessTokenExpiresAt.getTime() - (Date.now() + 300_000)) < 5_000);
    assert.equal((await get(jar, "/bff/v1/floor")).status, 200);
    assert.equal(refreshes().length, 1);
    assert.equal(api.calls[1].headers.authorization, "Bearer at-2");
  });
}

test("a token with more than 60 seconds left isn't refreshed", async () => {
  const { jar, hash } = await signedIn();
  store.rows.get(hash)!.accessTokenExpiresAt = new Date(Date.now() + 61_000);
  assert.equal((await get(jar, "/bff/v1/floor")).status, 200);
  assert.equal(refreshes().length, 0);
});

test("two calls at once with a token about to expire share one refresh", async () => {
  const { jar, hash } = await signedIn();
  store.rows.get(hash)!.accessTokenExpiresAt = new Date(Date.now() + 10_000);
  const [a, b] = await Promise.all([get(new Map(jar), "/bff/v1/floor"), get(new Map(jar), "/bff/v1/floor")]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.equal(refreshes().length, 1);
});

test("a refused refresh, or no refresh token with a token about to expire, gets 401 and isn't forwarded", async () => {
  const { jar, hash } = await signedIn();
  store.rows.get(hash)!.accessTokenExpiresAt = new Date(Date.now() + 30_000);
  provider.nextRefresh.refuse = true;
  assert.equal((await get(jar, "/bff/v1/floor")).status, 401);
  store.rows.get(hash)!.refreshTokenEncrypted = null;
  assert.equal((await get(jar, "/bff/v1/floor")).status, 401);
  assert.equal(api.calls.length, 0);
});

test("a call the API doesn't answer gets 502, and a BFF with no API answers 502 too", async () => {
  const { jar } = await signedIn();
  const down = createBff({
    issuer: provider.issuer, clientId: "dashboard", clientSecret: "s", scopes: "openid", origin: ORIGIN, key: Buffer.from(KEY, "base64"),
    sessions: store, apiUrl: "http://127.0.0.1:1",
  });
  const r = await down.request(new URL("/bff/v1/floor", ORIGIN).href, { headers: { cookie: cookieHeader(jar) } });
  assert.equal(r.status, 502);
  const none = createBff({ issuer: provider.issuer, clientId: "dashboard", scopes: "openid", origin: ORIGIN, key: Buffer.from(KEY, "base64"), sessions: store });
  assert.equal((await none.request(new URL("/bff/v1/floor", ORIGIN).href, { headers: { cookie: cookieHeader(jar) } })).status, 502);
});

// ---- /webhooks/github and the event stream (step 7c) ----

test("a webhook reaches the API's /webhooks/github with its bytes and headers, and no cookie or bearer token of the BFF's", async () => {
  const { jar } = await signedIn();
  api.answer("POST", "/webhooks/github", { status: 202, body: "accepted" });
  const body = Buffer.concat([Buffer.from('{"a": 1,  "z":"'), Buffer.from([0xff, 0xfe, 0xc3, 0x28]), Buffer.from('"}\n')]);
  const headers = {
    "content-type": "application/json", "user-agent": "GitHub-Hookshot/abc", "x-github-event": "push",
    "x-github-delivery": "d-1", "x-hub-signature-256": "sha256=00", "x-github-future": "kept-as-is",
  };
  const r = await get(jar, "/webhooks/github", { method: "POST", headers, body });
  assert.equal(r.status, 202);
  assert.equal(await r.text(), "accepted");
  assert.equal(api.calls.length, 1);
  const k = api.calls[0];
  assert.equal(`${k.method} ${k.url}`, "POST /webhooks/github");
  assert.ok(k.raw.equals(body));
  for (const [h, v] of Object.entries(headers)) assert.equal(k.headers[h], v, h);
  assert.equal(k.headers.authorization, undefined);
  assert.equal(k.headers.cookie, undefined);
});

test("a webhook the API doesn't answer gets 502", async () => {
  const down = createBff({
    issuer: provider.issuer, clientId: "dashboard", scopes: "openid", origin: ORIGIN, key: Buffer.from(KEY, "base64"),
    sessions: store, apiUrl: "http://127.0.0.1:1",
  });
  const r = await down.request(new URL("/webhooks/github", ORIGIN).href, { method: "POST", body: "{}" });
  assert.equal(r.status, 502);
});

/** A BFF that gives an ordinary call `ms` to answer. */
const withTimeout = (ms: number) => createBff({
  issuer: provider.issuer, clientId: "dashboard", clientSecret: "s", scopes: "openid", origin: ORIGIN, key: Buffer.from(KEY, "base64"),
  sessions: store, apiUrl: api.url, apiTimeoutMs: ms,
});

test("an event stream outlasts the time an ordinary call gets, and ends when the API ends it", async () => {
  const { jar } = await signedIn();
  api.streams.length = 0;
  api.stream("/v1/events", { events: [{ afterMs: 400, event: "item-moved" }], endAfterMs: 600 });
  const r = await withTimeout(150).request(new URL("/bff/v1/events", ORIGIN).href, { headers: { cookie: cookieHeader(jar) } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "text/event-stream");
  assert.match(await r.text(), /event: item-moved\n/);
  assert.equal(api.streams[0].closedBy, "api");
});

test("an event stream to the API closes when the browser leaves", async () => {
  const { jar } = await signedIn();
  api.streams.length = 0;
  api.stream("/v1/events", { events: [] });
  const leave = new AbortController();
  const r = await withTimeout(150).request(new URL("/bff/v1/events", ORIGIN).href, { headers: { cookie: cookieHeader(jar) }, signal: leave.signal });
  assert.equal(r.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(api.streams[0].closedAt, undefined);
  leave.abort();
  await r.body?.cancel().catch(() => {});
  for (let i = 0; i < 40 && api.streams[0].closedAt === undefined; i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(api.streams[0].closedBy, "caller");
});

test("with spaDir, every other GET gets the SPA, and the BFF's own addresses keep their answers", async () => {
  const dist = mkdtempSync(join(tmpdir(), "bff-spa-"));
  try {
    writeFileSync(join(dist, "index.html"), '<div id="root"></div>');
    const spa = createBff({
      issuer: provider.issuer, clientId: "dashboard", scopes: "openid", origin: ORIGIN, key: Buffer.from(KEY, "base64"),
      sessions: store, apiUrl: api.url, spaDir: dist,
    });
    for (const path of ["/", "/runs/482"]) assert.equal(await (await spa.request(path)).text(), '<div id="root"></div>');
    assert.equal((await spa.request("/auth/session")).status, 401);
    assert.equal((await spa.request("/bff/v1/no-such-thing")).status, 401);
    assert.equal((await spa.request("/auth/nothing")).status, 404);
    assert.equal((await app.request("/")).status, 404, "without spaDir the BFF serves no SPA");
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});
