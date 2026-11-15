// The BFF's routes (redesign step 7a, 2026-11-07 design §04), on Hono:
//   GET  /auth/login     starts the authorization code flow with PKCE at the issuer, keeping state, nonce and verifier
//                        sealed in a short-lived sign-in cookie that survives the provider's redirect back.
//   GET  /auth/callback  checks state, trades the code, checks the ID token, refuses an access token that isn't a JWT,
//                        stores the session and sets the session cookie, the only cookie the browser keeps.
//   POST /auth/logout    deletes the session and clears the cookie. It needs an Origin of the BFF's own.
//   GET  /auth/session   the signed-in browser's { issuer, subject }, or 401.
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { discover, exchangeCode, fetchKeys, isJwt, pkce, randomToken, verifyIdToken, type Discovery } from "./oidc.ts";
import {
  hashSessionId, newSessionId, open, REFRESH_TOKEN, seal, SESSION_COOKIE, SESSION_MAX_SECONDS, type SessionStore,
} from "./session.ts";

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
  fetch?: typeof fetch;
};

type SignIn = { state: string; nonce: string; verifier: string };

export function createBff(cfg: BffConfig): Hono {
  const f = cfg.fetch ?? fetch;
  const origin = new URL(cfg.origin).origin;
  const secure = origin.startsWith("https:");
  const redirectUri = `${origin}/auth/callback`;
  let discovery: Promise<Discovery> | undefined;
  // Discovery is read on first use and kept, and read again after a failure, so the BFF starts without the provider.
  const provider = () => (discovery ??= discover(cfg.issuer, f).catch((e) => { discovery = undefined; throw e; }));

  const clearSignIn = (c: Context) => deleteCookie(c, SIGNIN_COOKIE, { path: SIGNIN_PATH, secure, httpOnly: true, sameSite: "Lax" });
  const clearSession = (c: Context) => deleteCookie(c, SESSION_COOKIE, { path: "/", secure, httpOnly: true, sameSite: "Strict" });
  const refuse = (c: Context, status: 400 | 401 | 403, why: string) => {
    clearSignIn(c);
    return c.text(`Sign-in refused: ${why}`, status);
  };

  const app = new Hono();

  app.get("/auth/login", async (c) => {
    const d = await provider();
    const { verifier, challenge } = pkce();
    const s: SignIn = { state: randomToken(), nonce: randomToken(), verifier };
    const to = new URL(d.authorizationEndpoint);
    for (const [k, v] of Object.entries({
      response_type: "code", client_id: cfg.clientId, redirect_uri: redirectUri, scope: cfg.scopes,
      state: s.state, nonce: s.nonce, code_challenge: challenge, code_challenge_method: "S256",
    })) to.searchParams.set(k, v);
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
    let d: Discovery;
    try {
      d = await provider();
    } catch (e) {
      console.error("the BFF couldn't read the provider's discovery document:", (e as Error).message);
      clearSignIn(c);
      return c.text("Sign-in failed: the sign-in provider didn't answer", 502);
    }
    if (q.iss !== undefined && q.iss !== d.issuer) return refuse(c, 400, "the response came from another issuer");

    let tokens;
    let claims;
    try {
      tokens = await exchangeCode(d, { code: q.code, verifier: s.verifier, redirectUri, clientId: cfg.clientId, clientSecret: cfg.clientSecret }, f);
      claims = verifyIdToken(tokens.id_token, { keys: await fetchKeys(d, f), issuer: d.issuer, clientId: cfg.clientId, nonce: s.nonce });
    } catch (e) {
      return refuse(c, 401, (e as Error).message);
    }
    // The API can only check JWTs (design §04), so a provider that issues opaque access tokens can't sign anyone in.
    if (!isJwt(tokens.access_token)) return refuse(c, 401, "the provider's access token isn't a JWT");

    const id = newSessionId();
    const now = Date.now();
    try {
      await cfg.sessions.create({
        cookieHash: hashSessionId(id),
        issuer: claims.iss,
        subject: claims.sub,
        accessToken: tokens.access_token,
        accessTokenExpiresAt: new Date(now + (Number(tokens.expires_in) || 300) * 1000),
        refreshTokenEncrypted: tokens.refresh_token ? seal(cfg.key, REFRESH_TOKEN, tokens.refresh_token) : null,
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
