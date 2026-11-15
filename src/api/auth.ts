// The orchestrator API's bearer tokens (2026-11-07 design §03 and §04). The API finds the issuer's signing keys
// through its OIDC discovery document and refuses to start when that names none. Each token's signature is checked
// against those keys, and its issuer, audience and expiry against the API's settings.
import { createRemoteJWKSet, jwtVerify } from "jose";

/** Who a valid token speaks for. The API looks the pair up in "user" on every request. */
export type Caller = { issuer: string; subject: string };
/** The caller an Authorization header proves, or null for no header, another scheme or a token that fails a check. */
export type VerifyBearer = (authorization: string | undefined) => Promise<Caller | null>;

// Asymmetric algorithms only: a token signed with a shared secret, or with "none", never passes.
const ALGORITHMS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"];

/**
 * Reads `issuer`'s discovery document and returns its jwks_uri. Throws when the document can't be read, names another
 * issuer, or has no jwks_uri. A provider that publishes no keys issues tokens the API can't check (design §04).
 */
export async function discoverJwks(issuer: string): Promise<URL> {
  const url = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  let doc: { issuer?: unknown; jwks_uri?: unknown };
  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`it answered ${r.status}`);
    doc = (await r.json()) as typeof doc;
  } catch (e) {
    throw new Error(`refusing to start the API: the issuer's discovery document at ${url} can't be read (${(e as Error).message})`);
  }
  if (typeof doc.issuer === "string" && doc.issuer.replace(/\/+$/, "") !== issuer.replace(/\/+$/, "")) {
    throw new Error(`refusing to start the API: the discovery document at ${url} names the issuer ${doc.issuer}, not ${issuer}`);
  }
  if (typeof doc.jwks_uri !== "string" || !doc.jwks_uri) {
    throw new Error(`refusing to start the API: the issuer's discovery document at ${url} has no jwks_uri, so its tokens can't be checked`);
  }
  return new URL(doc.jwks_uri);
}

/** Checks `Authorization: Bearer <JWT>` against the issuer's key set, `issuer` and `audience`, and the token's expiry. */
export function bearerVerifier(o: { issuer: string; audience: string; jwks: URL }): VerifyBearer {
  const keys = createRemoteJWKSet(o.jwks);
  return async (authorization) => {
    const token = /^Bearer +([A-Za-z0-9._~+/=-]+)$/i.exec(authorization ?? "")?.[1];
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer: o.issuer, audience: o.audience, algorithms: ALGORITHMS, requiredClaims: ["exp", "sub"],
      });
      return payload.sub ? { issuer: o.issuer, subject: payload.sub } : null;
    } catch {
      return null;
    }
  };
}
