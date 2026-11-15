// The BFF's OIDC client (redesign step 7a, 2026-11-07 design §04): discovery, PKCE, the code exchange, and the checks
// on what comes back. The ID token is checked against the issuer's JWKS. The access token is only checked for being a
// JWT, because the API checks it in full and can only check JWTs.
import { constants, createHash, createPublicKey, randomBytes, verify, type webcrypto } from "node:crypto";

export type Discovery = { issuer: string; authorizationEndpoint: string; tokenEndpoint: string; jwksUri: string };
export type Jwk = webcrypto.JsonWebKey & { kid?: string; alg?: string; use?: string; kty?: string };
export type TokenResponse = { access_token: string; id_token: string; refresh_token?: string; expires_in?: number };

const trim = (u: string) => u.replace(/\/+$/, "");

async function getJson(url: string, f: typeof fetch): Promise<Record<string, unknown>> {
  const r = await f(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  return (await r.json()) as Record<string, unknown>;
}

/** Reads the issuer's discovery document, and refuses one that names another issuer or lacks an endpoint. */
export async function discover(issuer: string, f: typeof fetch = fetch): Promise<Discovery> {
  const want = trim(issuer);
  const doc = await getJson(`${want}/.well-known/openid-configuration`, f);
  if (typeof doc.issuer !== "string" || trim(doc.issuer) !== want) throw new Error(`the discovery document names the issuer ${doc.issuer}, not ${want}`);
  for (const k of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
    if (typeof doc[k] !== "string") throw new Error(`the discovery document has no ${k}`);
  }
  return {
    issuer: doc.issuer,
    authorizationEndpoint: doc.authorization_endpoint as string,
    tokenEndpoint: doc.token_endpoint as string,
    jwksUri: doc.jwks_uri as string,
  };
}

export async function fetchKeys(d: Discovery, f: typeof fetch = fetch): Promise<Jwk[]> {
  const doc = await getJson(d.jwksUri, f);
  if (!Array.isArray(doc.keys)) throw new Error("the JWKS has no keys");
  return doc.keys as Jwk[];
}

/** A PKCE verifier and its S256 challenge. */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** A random value for state or nonce. */
export const randomToken = () => randomBytes(32).toString("base64url");

function decodeObject(part: string): Record<string, unknown> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) return null;
  try {
    const v: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

type Parsed = { header: Record<string, unknown>; payload: Record<string, unknown>; signed: string; signature: Buffer };

function parseJwt(token: string): Parsed | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[2] || !/^[A-Za-z0-9_-]+$/.test(parts[2])) return null;
  const header = decodeObject(parts[0]);
  const payload = decodeObject(parts[1]);
  if (!header || !payload || typeof header.alg !== "string" || header.alg === "none") return null;
  return { header, payload, signed: `${parts[0]}.${parts[1]}`, signature: Buffer.from(parts[2], "base64url") };
}

/** Whether a token is a signed JWT: a JSON header naming an algorithm, a JSON payload and a signature. */
export function isJwt(token: string): boolean {
  return parseJwt(token) !== null;
}

const ALGS: Record<string, { hash: string; pss?: boolean; ec?: boolean }> = {
  RS256: { hash: "sha256" }, RS384: { hash: "sha384" }, RS512: { hash: "sha512" },
  PS256: { hash: "sha256", pss: true }, PS384: { hash: "sha384", pss: true }, PS512: { hash: "sha512", pss: true },
  ES256: { hash: "sha256", ec: true }, ES384: { hash: "sha384", ec: true }, ES512: { hash: "sha512", ec: true },
};

function verifySignature(p: Parsed, keys: Jwk[]): boolean {
  const alg = ALGS[p.header.alg as string];
  if (!alg) return false;
  const kid = p.header.kid;
  const candidates = keys.filter((k) => (kid === undefined || k.kid === kid) && (k.use === undefined || k.use === "sig") && (k.alg === undefined || k.alg === p.header.alg));
  return candidates.some((k) => {
    try {
      const key = createPublicKey({ key: k, format: "jwk" });
      const opts = alg.pss ? { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST } : alg.ec ? { key, dsaEncoding: "ieee-p1363" as const } : key;
      return verify(alg.hash, Buffer.from(p.signed), opts, p.signature);
    } catch {
      return false;
    }
  });
}

export type IdTokenCheck = { keys: Jwk[]; issuer: string; clientId: string; nonce: string; now?: number };

/** Checks an ID token's signature, issuer, audience, expiry and nonce, and gives its claims. Throws on any failure. */
export function verifyIdToken(token: string, want: IdTokenCheck): Record<string, unknown> & { iss: string; sub: string } {
  const p = parseJwt(token);
  if (!p) throw new Error("the ID token isn't a JWT");
  if (!verifySignature(p, want.keys)) throw new Error("the ID token's signature doesn't check out against the issuer's keys");
  const c = p.payload;
  if (typeof c.iss !== "string" || trim(c.iss) !== trim(want.issuer)) throw new Error(`the ID token is from ${c.iss}, not ${want.issuer}`);
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(want.clientId)) throw new Error("the ID token isn't for this client");
  if (aud.length > 1 && c.azp !== want.clientId) throw new Error("the ID token was issued to another party");
  const now = want.now ?? Math.floor(Date.now() / 1000);
  if (typeof c.exp !== "number" || c.exp < now - 60) throw new Error("the ID token has expired");
  if (c.nonce !== want.nonce) throw new Error("the ID token's nonce doesn't match the one sent");
  if (typeof c.sub !== "string" || !c.sub) throw new Error("the ID token has no subject");
  return c as Record<string, unknown> & { iss: string; sub: string };
}

export type CodeExchange = { code: string; verifier: string; redirectUri: string; clientId: string; clientSecret?: string };

/** Trades the code for tokens at the token endpoint, as a confidential client when there is a secret. */
export async function exchangeCode(d: Discovery, x: CodeExchange, f: typeof fetch = fetch): Promise<TokenResponse> {
  const form = new URLSearchParams({ grant_type: "authorization_code", code: x.code, redirect_uri: x.redirectUri, code_verifier: x.verifier });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (x.clientSecret) {
    const enc = (s: string) => encodeURIComponent(s);
    headers.authorization = `Basic ${Buffer.from(`${enc(x.clientId)}:${enc(x.clientSecret)}`).toString("base64")}`;
  } else {
    form.set("client_id", x.clientId);
  }
  const r = await f(d.tokenEndpoint, { method: "POST", headers, body: form.toString(), signal: AbortSignal.timeout(10_000) });
  const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new Error(`the token endpoint answered ${r.status}${typeof body.error === "string" ? `: ${body.error}` : ""}`);
  if (typeof body.access_token !== "string" || typeof body.id_token !== "string") throw new Error("the token response lacks an access token or an ID token");
  return body as unknown as TokenResponse;
}
