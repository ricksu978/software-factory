// The BFF's routes (redesign step 7a, 2026-11-07 design §04), on Hono:
//   GET  /auth/login     starts the authorization code flow with PKCE at the issuer, keeping state, nonce and verifier
//                        sealed in a short-lived sign-in cookie that survives the provider's redirect back.
//   GET  /auth/callback  checks state, trades the code, checks the ID token, refuses an access token that isn't a JWT,
//                        stores the session and sets the session cookie, the only cookie the browser keeps.
//   POST /auth/logout    deletes the session and clears the cookie. It needs an Origin of the BFF's own.
//   GET  /auth/session   the signed-in browser's { issuer, subject }, or 401.
// And step 7b (§04 and §05):
//   *    /bff/*          a state-changing call (anything but GET, HEAD and OPTIONS) needs an Origin of the BFF's own,
//                        or gets 403.
//   *    /bff/v1/*       needs a live session, or gets 401. The BFF refreshes an access token that expires within 60
//                        seconds, then forwards the call one for one to the API's /v1/*, with the session's access token
//                        as a bearer token and none of the browser's cookies or credentials.
// And step 7c (§03 and §05):
//   POST /webhooks/github  GitHub's deliveries, which reach the API's /webhooks/github with their bytes and headers as
//                        GitHub sent them, and the API's answer goes back to GitHub. No session and no Origin are
//                        needed, and the BFF doesn't check the signature: only the API holds the webhook secret.
//   GET  /bff/v1/events  goes through /bff/v1/* like any call, but an answer of server-sent events streams to the
//                        browser for as long as the API keeps it open, and closes at the API when the browser leaves.
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { ResponseBodyError } from "openid-client";
import { discover, finishSignIn, isJwt, refresh, startSignIn, type Provider, type SignedIn, type SignInChecks } from "./oidc.ts";
import {
  hashSessionId, newSessionId, open, REFRESH_TOKEN, seal, SESSION_COOKIE, SESSION_MAX_SECONDS, type Session, type SessionStore,
} from "./session.ts";

/** An access token with this long or less left is refreshed before a call goes to the API. */
export const REFRESH_WITHIN_MS = 60_000;
/** How long the API has to answer an ordinary call. A stream of server-sent events only has this long to start. */
const API_TIMEOUT_MS = 30_000;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** The browser's request headers that go on to the API. Cookies, Authorization and Origin never do. */
const FORWARDED_REQUEST_HEADERS = [
  "accept", "accept-language", "content-type", "if-match", "if-none-match", "if-modified-since", "if-unmodified-since",
];
/** The API's response headers that don't come back: hop-by-hop ones, cookies, and those fetch has already undone. */
const DROPPED_RESPONSE_HEADERS = new Set([
  "connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length", "set-cookie", "upgrade",
  "proxy-authenticate", "trailer", "te",
]);
/**
 * A webhook delivery's headers that don't go on to the API: hop-by-hop ones and those fetch sets for itself, and the
 * cookie and credentials a browser might add, which GitHub never sends. Every other header goes as GitHub sent it.
 */
const DROPPED_WEBHOOK_HEADERS = new Set([
  "host", "connection", "keep-alive", "transfer-encoding", "content-length", "upgrade", "expect", "te", "trailer",
  "proxy-authorization", "proxy-connection", "cookie", "authorization",
]);

/** The sign-in cookie: state, nonce and PKCE verifier, sealed under the session key, for the provider's round trip. */
export const SIGNIN_COOKIE = "factory_signin";
const SIGNIN_SECONDS = 600;
const SIGNIN_PATH = "/auth";

export type BffConfig = {
  issuer: string;
  clientId: string;
  /** Empty for a public client such as the local Keycloak's dashboard client. */
  clientSecret?: string;
  scopes: string;
  /** The address the browser reaches the BFF on, such as http://localhost:7403. */
  origin: string;
  key: Buffer;
  sessions: SessionStore;
  /** The API's base address, with no path. Without it /bff/v1/* answers 502. */
  apiUrl?: string;
  /** How long the API has to answer an ordinary call, 30 seconds unless set. */
  apiTimeoutMs?: number;
  fetch?: typeof fetch;
};

type SignIn = SignInChecks;

export function createBff(cfg: BffConfig): Hono {
  const origin = new URL(cfg.origin).origin;
  const secure = origin.startsWith("https:");
  const redirectUri = `${origin}/auth/callback`;
  let discovery: Promise<Provider> | undefined;
  // Discovery is read on first use and kept, and read again after a failure, so the BFF starts without the provider.
  const provider = () => (discovery ??= discover({ issuer: cfg.issuer, clientId: cfg.clientId, clientSecret: cfg.clientSecret, fetch: cfg.fetch }).catch((e) => { discovery = undefined; throw e; }));

  const clearSignIn = (c: Context) => deleteCookie(c, SIGNIN_COOKIE, { path: SIGNIN_PATH, secure, httpOnly: true, sameSite: "Lax" });
  const clearSession = (c: Context) => deleteCookie(c, SESSION_COOKIE, { path: "/", secure, httpOnly: true, sameSite: "Strict" });
  const refuse = (c: Context, status: 400 | 401 | 403, why: string) => {
    clearSignIn(c);
    return c.text(`Sign-in refused: ${why}`, status);
  };

  const doFetch = cfg.fetch ?? fetch;
  const apiTimeoutMs = cfg.apiTimeoutMs ?? API_TIMEOUT_MS;

  /**
   * Sends a call to the API and hands its answer back. The API has apiTimeoutMs to answer, and an ordinary answer has
   * that long to arrive whole. An answer of server-sent events has no end set by the BFF: it lasts until the API ends it
   * or the browser leaves, which closes it at the API. Null when the API doesn't answer.
   */
  const toApi = async (c: Context, to: string, init: RequestInit): Promise<Response | null> => {
    const timer = new AbortController();
    const t = setTimeout(() => timer.abort(new Error(`the API didn't answer within ${apiTimeoutMs} ms`)), apiTimeoutMs);
    let r: Response;
    try {
      r = await doFetch(to, { ...init, redirect: "manual", signal: AbortSignal.any([timer.signal, c.req.raw.signal]) });
    } catch (e) {
      clearTimeout(t);
      console.error(`the BFF couldn't reach the API for ${init.method} ${new URL(to).pathname}:`, (e as Error).message);
      return null;
    }
    const streaming = r.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "text/event-stream";
    let body = r.body;
    if (streaming || !body) clearTimeout(t);
    else body = body.pipeThrough(new TransformStream({ flush: () => clearTimeout(t) }));
    const back = new Headers();
    r.headers.forEach((v, k) => {
      if (!DROPPED_RESPONSE_HEADERS.has(k)) back.set(k, v);
    });
    return new Response(body, { status: r.status, statusText: r.statusText, headers: back });
  };
  /** Refreshes in flight, by cookie hash, so calls that arrive together spend the refresh token once. */
  const refreshing = new Map<string, Promise<Session | null>>();

  /** The session with an access token good for more than a minute, refreshing it if need be, or null. */
  const freshSession = async (hash: string): Promise<Session | null> => {
    const s = await cfg.sessions.find(hash);
    if (!s || s.accessTokenExpiresAt.getTime() - Date.now() > REFRESH_WITHIN_MS) return s;
    let p = refreshing.get(hash);
    if (!p) {
      p = refreshTokens(hash, s).finally(() => refreshing.delete(hash));
      refreshing.set(hash, p);
    }
    return p;
  };

  /** Trades the session's refresh token at the provider and stores what comes back. Null when there is none or it's refused. */
  const refreshTokens = async (hash: string, s: Session): Promise<Session | null> => {
    if (!s.refreshTokenEncrypted) return null;
    let token: string;
    try {
      token = open(cfg.key, REFRESH_TOKEN, s.refreshTokenEncrypted);
    } catch {
      return null;
    }
    let t: Awaited<ReturnType<typeof refresh>>;
    try {
      t = await refresh(await provider(), token);
    } catch (e) {
      // The provider refusing the refresh token ends the session's use. Anything else is the provider not answering.
      if (e instanceof ResponseBodyError) return null;
      throw e;
    }
    const tokens = {
      accessToken: t.accessToken,
      accessTokenExpiresAt: new Date(Date.now() + (Number(t.expiresIn) || 300) * 1000),
      refreshTokenEncrypted: t.refreshToken ? seal(cfg.key, REFRESH_TOKEN, t.refreshToken) : s.refreshTokenEncrypted,
    };
    await cfg.sessions.updateTokens(hash, tokens);
    return { ...s, ...tokens };
  };

  const app = new Hono();

  app.use("/bff/*", async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method) && c.req.header("origin") !== origin) {
      return c.json({ error: "a state-changing call needs an Origin of the BFF's own" }, 403);
    }
    await next();
  });

  app.all("/bff/v1/*", async (c) => {
    const id = getCookie(c, SESSION_COOKIE);
    let s: Session | null = null;
    if (id) {
      try {
        s = await freshSession(hashSessionId(id));
      } catch (e) {
        console.error("the BFF couldn't refresh an access token:", (e as Error).message);
        return c.json({ error: "the sign-in provider didn't answer" }, 502);
      }
    }
    if (!s) return c.json({ error: "not signed in" }, 401);
    if (!cfg.apiUrl) return c.json({ error: "the BFF has no API to forward to" }, 502);

    const from = new URL(c.req.url);
    const to = `${cfg.apiUrl}${from.pathname.slice("/bff".length)}${from.search}`;
    const headers = new Headers({ authorization: `Bearer ${s.accessToken}` });
    for (const h of FORWARDED_REQUEST_HEADERS) {
      const v = c.req.header(h);
      if (v !== undefined) headers.set(h, v);
    }
    const method = c.req.method;
    const body = method === "GET" || method === "HEAD" ? undefined : await c.req.arrayBuffer();
    return (await toApi(c, to, { method, headers, body })) ?? c.json({ error: "the API didn't answer" }, 502);
  });

  app.post("/webhooks/github", async (c) => {
    if (!cfg.apiUrl) return c.json({ error: "the BFF has no API to forward to" }, 502);
    const headers = new Headers();
    c.req.raw.headers.forEach((v, k) => {
      if (!DROPPED_WEBHOOK_HEADERS.has(k)) headers.set(k, v);
    });
    const body = await c.req.arrayBuffer();
    return (await toApi(c, `${cfg.apiUrl}/webhooks/github`, { method: "POST", headers, body })) ?? c.json({ error: "the API didn't answer" }, 502);
  });

  app.get("/auth/login", async (c) => {
    const { checks: s, to } = await startSignIn(await provider(), redirectUri, cfg.scopes);
    setCookie(c, SIGNIN_COOKIE, seal(cfg.key, SIGNIN_COOKIE, JSON.stringify(s)), {
      path: SIGNIN_PATH, httpOnly: true, sameSite: "Lax", secure, maxAge: SIGNIN_SECONDS,
    });
    return c.redirect(to.href, 302);
  });

  app.get("/auth/callback", async (c) => {
    const raw = getCookie(c, SIGNIN_COOKIE);
    let s: SignIn;
    try {
      s = JSON.parse(open(cfg.key, SIGNIN_COOKIE, raw ?? ""));
    } catch {
      return refuse(c, 400, "this browser didn't start a sign-in, or it took too long");
    }
    const q = c.req.query();
    if (!q.state || q.state !== s.state) return refuse(c, 400, "the state doesn't match the one sent");
    if (q.error) return refuse(c, 401, `the provider answered ${q.error}`);
    if (!q.code) return refuse(c, 400, "the provider sent no code");
    let d: Provider;
    try {
      d = await provider();
    } catch (e) {
      console.error("the BFF couldn't read the provider's discovery document:", (e as Error).message);
      clearSignIn(c);
      return c.text("Sign-in failed: the sign-in provider didn't answer", 502);
    }
    if (q.iss !== undefined && q.iss !== d.serverMetadata().issuer) return refuse(c, 400, "the response came from another issuer");

    // openid-client takes the redirect URI from the address it's given, so it gets the one the provider was sent.
    const back = new URL(redirectUri);
    back.search = new URL(c.req.url).search;
    let tokens: SignedIn;
    try {
      tokens = await finishSignIn(d, back, s);
    } catch (e) {
      return refuse(c, 401, (e as Error).message);
    }
    // The API can only check JWTs (design §04), so a provider that issues opaque access tokens can't sign anyone in.
    if (!isJwt(tokens.accessToken)) return refuse(c, 401, "the provider's access token isn't a JWT");

    const id = newSessionId();
    const now = Date.now();
    try {
      await cfg.sessions.create({
        cookieHash: hashSessionId(id),
        issuer: tokens.issuer,
        subject: tokens.subject,
        accessToken: tokens.accessToken,
        accessTokenExpiresAt: new Date(now + (Number(tokens.expiresIn) || 300) * 1000),
        refreshTokenEncrypted: tokens.refreshToken ? seal(cfg.key, REFRESH_TOKEN, tokens.refreshToken) : null,
        expiresAt: new Date(now + SESSION_MAX_SECONDS * 1000),
      });
    } catch (e) {
      console.error("the BFF couldn't store a session:", (e as Error).message);
      clearSignIn(c);
      return c.text("Sign-in failed: the session couldn't be stored", 500);
    }
    clearSignIn(c);
    setCookie(c, SESSION_COOKIE, id, { path: "/", httpOnly: true, sameSite: "Strict", secure, maxAge: SESSION_MAX_SECONDS });
    return c.redirect("/", 302);
  });

  app.post("/auth/logout", async (c) => {
    if (c.req.header("origin") !== origin) return c.text("Sign-out needs an Origin of the BFF's own", 403);
    const id = getCookie(c, SESSION_COOKIE);
    if (id) await cfg.sessions.remove(hashSessionId(id));
    clearSession(c);
    return c.body(null, 204);
  });

  app.get("/auth/session", async (c) => {
    const id = getCookie(c, SESSION_COOKIE);
    const who = id ? await cfg.sessions.find(hashSessionId(id)) : null;
    if (!who) return c.json({ error: "not signed in" }, 401);
    return c.json({ issuer: who.issuer, subject: who.subject });
  });

  return app;
}
