// The BFF's OIDC client (redesign step 7a, 2026-11-07 design §04, §09), on openid-client 6.8: discovery, PKCE, the
// code exchange and the checks on what comes back. openid-client checks the authorization response (state, error,
// iss), the token response and the ID token's claims and nonce. Its non-repudiation checks are on, so the ID token's
// signature is also checked against the issuer's JWKS. The access token is only checked for being a JWT, here,
// because the API checks it in full and can only check JWTs.
import * as client from "openid-client";

export type Provider = client.Configuration;
export type SignInChecks = { state: string; nonce: string; verifier: string };
export type SignedIn = {
  issuer: string;
  subject: string;
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
};

const trim = (u: string) => u.replace(/\/+$/, "");

export type ProviderOptions = {
  issuer: string;
  clientId: string;
  /** Empty or absent for a public client. */
  clientSecret?: string;
  fetch?: typeof fetch;
};

/** Reads the issuer's discovery document. openid-client refuses one that names another issuer. */
export async function discover(o: ProviderOptions): Promise<Provider> {
  const issuer = new URL(trim(o.issuer));
  const auth = o.clientSecret ? client.ClientSecretBasic(o.clientSecret) : client.None();
  // Local providers (Keycloak on 7430, the test provider) answer over plain HTTP; anything else must be HTTPS.
  const local = issuer.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(issuer.hostname);
  const tenSeconds = (c: Provider) => { c.timeout = 10; };
  const execute = [client.enableNonRepudiationChecks, tenSeconds, ...(local ? [client.allowInsecureRequests] : [])];
  const f = o.fetch;
  return client.discovery(issuer, o.clientId, o.clientSecret || undefined, auth, {
    execute,
    ...(f ? { [client.customFetch]: (url: string, init: client.CustomFetchOptions) => f(url, init as RequestInit) } : {}),
  });
}

/** Fresh state, nonce and PKCE verifier for one sign-in, and the authorization address that carries them. */
export async function startSignIn(p: Provider, redirectUri: string, scope: string): Promise<{ checks: SignInChecks; to: URL }> {
  const checks = { state: client.randomState(), nonce: client.randomNonce(), verifier: client.randomPKCECodeVerifier() };
  const to = client.buildAuthorizationUrl(p, {
    redirect_uri: redirectUri,
    scope,
    state: checks.state,
    nonce: checks.nonce,
    code_challenge: await client.calculatePKCECodeChallenge(checks.verifier),
    code_challenge_method: "S256",
  });
  return { checks, to };
}

/** Checks the provider's answer at `callbackUrl`, trades the code and checks the ID token. Throws on any failure. */
export async function finishSignIn(p: Provider, callbackUrl: URL, checks: SignInChecks): Promise<SignedIn> {
  let t: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
  try {
    t = await client.authorizationCodeGrant(p, callbackUrl, {
      pkceCodeVerifier: checks.verifier,
      expectedState: checks.state,
      expectedNonce: checks.nonce,
      idTokenExpected: true,
    });
  } catch (e) {
    // openid-client's own message is often only "invalid response encountered"; the cause says which check failed.
    const cause = (e as Error).cause;
    const why = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
    throw new Error(why ? `${(e as Error).message}: ${why}` : (e as Error).message, { cause: e });
  }
  const claims = t.claims();
  if (!claims || typeof claims.sub !== "string" || !claims.sub) throw new Error("the ID token has no subject");
  return { issuer: claims.iss, subject: claims.sub, accessToken: t.access_token, refreshToken: t.refresh_token, expiresIn: t.expires_in };
}

function decodeObject(part: string | undefined): Record<string, unknown> | null {
  if (!part || !/^[A-Za-z0-9_-]+$/.test(part)) return null;
  try {
    const v: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Whether a token is a signed JWT: a JSON header naming an algorithm, a JSON payload and a signature. */
export function isJwt(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[2] || !/^[A-Za-z0-9_-]+$/.test(parts[2])) return false;
  const header = decodeObject(parts[0]);
  return !!header && !!decodeObject(parts[1]) && typeof header.alg === "string" && header.alg !== "none";
}

export type Refreshed = { accessToken: string; refreshToken?: string; expiresIn?: number };

/** Trades a refresh token for a new access token, and a new refresh token when the provider rotates it. */
export async function refresh(p: Provider, refreshToken: string): Promise<Refreshed> {
  const t = await client.refreshTokenGrant(p, refreshToken);
  return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresIn: t.expires_in };
}
