import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { startProvider, type Provider } from "../../features/fixtures/pbi-288-provider.ts";
import { createBff, SIGNIN_COOKIE } from "./app.ts";
import { hashSessionId, openRefreshToken, SESSION_COOKIE, type NewSession, type SessionStore, type Who } from "./session.ts";

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
    async find(h: string): Promise<Who | null> {
      const s = rows.get(h);
      return s ? { issuer: s.issuer, subject: s.subject } : null;
    },
    async remove(h: string) {
      rows.delete(h);
    },
  };
  return store;
}

let provider: Provider;
let store: ReturnType<typeof memory>;
let app: ReturnType<typeof createBff>;

before(async () => {
  provider = await startProvider("alice");
});
after(async () => provider.stop());
beforeEach(() => {
  store = memory();
  app = createBff({ issuer: provider.issuer, clientId: "dashboard", clientSecret: "s", scopes: "openid", origin: ORIGIN, key: Buffer.from(KEY, "base64"), sessions: store });
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
