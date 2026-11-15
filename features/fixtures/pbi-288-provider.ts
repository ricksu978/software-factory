// A test OIDC sign-in provider for PBI 288's scenarios. It publishes a discovery document and a JWKS, signs its ID
// tokens with RS256, and enforces PKCE (S256) at its token address as a real provider does. Its /authorize signs the
// browser straight in as the provider's current user, with no page in between. Each "next sign-in" setting applies to
// the next token response only. It records every authorization request, every token request and every token it issued.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type AccessTokenKind = "jwt" | "opaque" | "dotted";

type Grant = { user: string; clientId: string; redirectUri: string; challenge?: string; method?: string; nonce?: string };

export type TokenRequest = { form: Record<string, string>; authorization?: string; status: number };
export type Issued = { user: string; accessToken: string; idToken: string; refreshToken?: string };

export type Provider = {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** The subject the provider gives `user` in its tokens. */
  subjectOf(user: string): string;
  /** A code for `user` the BFF never asked for, with no PKCE challenge and no nonce. */
  mintCode(user: string, redirectUri: string, clientId: string): string;
  authorizations: URLSearchParams[];
  tokenRequests: TokenRequest[];
  issued: Issued[];
  next: {
    accessToken?: AccessTokenKind;
    differentNonce?: boolean;
    /** A string to issue it, null to issue none, undefined for a fresh random one. */
    refreshToken?: string | null;
  };
  stop(): Promise<void>;
};

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

function jwt(key: KeyObject, kid: string, claims: Record<string, unknown>): string {
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const body = b64url(JSON.stringify(claims));
  const sig = sign("sha256", Buffer.from(`${head}.${body}`), key);
  return `${head}.${body}.${b64url(sig)}`;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let s = "";
    req.setEncoding("utf8");
    req.on("data", (d: string) => (s += d));
    req.on("end", () => resolve(s));
    req.on("error", reject);
  });
}

export async function startProvider(user: string): Promise<Provider> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = randomBytes(8).toString("hex");
  const grants = new Map<string, Grant>();
  const subjectOf = (u: string) => `subject-${u}`;
  let base = "";

  const p: Provider = {
    issuer: "",
    authorizationEndpoint: "",
    tokenEndpoint: "",
    subjectOf,
    mintCode(u, redirectUri, clientId) {
      const code = randomBytes(16).toString("hex");
      grants.set(code, { user: u, clientId, redirectUri });
      return code;
    },
    authorizations: [],
    tokenRequests: [],
    issued: [],
    next: {},
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };

  const json = (res: import("node:http").ServerResponse, status: number, body: unknown) =>
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", base);
    if (req.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
      return json(res, 200, {
        issuer: p.issuer,
        authorization_endpoint: p.authorizationEndpoint,
        token_endpoint: p.tokenEndpoint,
        jwks_uri: `${base}/jwks`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        scopes_supported: ["openid", "profile", "offline_access"],
      });
    }
    if (req.method === "GET" && url.pathname === "/jwks") {
      return json(res, 200, { keys: [{ ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" }] });
    }
    if (req.method === "GET" && url.pathname === "/authorize") {
      const q = url.searchParams;
      p.authorizations.push(new URLSearchParams(q));
      const redirectUri = q.get("redirect_uri");
      if (!redirectUri) return json(res, 400, { error: "invalid_request" });
      const back = new URL(redirectUri);
      const code = randomBytes(16).toString("hex");
      grants.set(code, {
        user, clientId: q.get("client_id") ?? "", redirectUri,
        challenge: q.get("code_challenge") ?? undefined, method: q.get("code_challenge_method") ?? undefined,
        nonce: q.get("nonce") ?? undefined,
      });
      back.searchParams.set("code", code);
      if (q.get("state") !== null) back.searchParams.set("state", q.get("state")!);
      back.searchParams.set("iss", p.issuer);
      return res.writeHead(302, { location: back.href }).end();
    }
    if (req.method === "POST" && url.pathname === "/token") {
      const form = Object.fromEntries(new URLSearchParams(await readBody(req)));
      const record: TokenRequest = { form, authorization: req.headers.authorization, status: 400 };
      p.tokenRequests.push(record);
      const g = form.code ? grants.get(form.code) : undefined;
      if (form.grant_type !== "authorization_code" || !g) return json(res, 400, { error: "invalid_grant" });
      grants.delete(form.code);
      if (g.challenge) {
        const verifier = form.code_verifier ?? "";
        if (g.method !== "S256" || b64url(createHash("sha256").update(verifier).digest()) !== g.challenge) {
          return json(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
        }
      }
      const next = p.next;
      p.next = {};
      const now = Math.floor(Date.now() / 1000);
      const sub = subjectOf(g.user);
      const kind = next.accessToken ?? "jwt";
      const accessToken = kind === "opaque"
        ? randomBytes(24).toString("hex")
        : kind === "dotted"
          ? `not-a.real-jwt.${randomBytes(8).toString("hex")}`
          : jwt(privateKey, kid, { iss: p.issuer, sub, aud: "factory-api", azp: g.clientId, scope: "openid", iat: now, exp: now + 300, jti: randomBytes(8).toString("hex") });
      const nonce = g.nonce === undefined ? undefined : next.differentNonce ? `not-${g.nonce}` : g.nonce;
      const idToken = jwt(privateKey, kid, {
        iss: p.issuer, sub, aud: g.clientId, azp: g.clientId, iat: now, exp: now + 300, preferred_username: g.user,
        ...(nonce === undefined ? {} : { nonce }),
      });
      const refreshToken = next.refreshToken === null ? undefined : next.refreshToken ?? `rt-${randomBytes(16).toString("hex")}`;
      p.issued.push({ user: g.user, accessToken, idToken, refreshToken });
      record.status = 200;
      return json(res, 200, {
        access_token: accessToken, token_type: "Bearer", expires_in: 300, id_token: idToken, scope: "openid",
        ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
      });
    }
    json(res, 404, { error: "not_found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  p.issuer = base;
  p.authorizationEndpoint = `${base}/authorize`;
  p.tokenEndpoint = `${base}/token`;
  return p;
}
