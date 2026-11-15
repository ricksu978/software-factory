import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { test } from "node:test";
import { discover, isJwt, pkce, verifyIdToken, type Jwk } from "./oidc.ts";

const b64 = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

function keys(kid = "k1") {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" } as Jwk;
  const jwt = (claims: Record<string, unknown>, header: Record<string, unknown> = {}) => {
    const head = b64({ alg: "RS256", typ: "JWT", kid, ...header });
    const body = b64(claims);
    return `${head}.${body}.${sign("sha256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url")}`;
  };
  return { jwk, jwt };
}

test("a JWT is three base64url parts whose first two are JSON objects and whose header names an algorithm", () => {
  const { jwt } = keys();
  assert.equal(isJwt(jwt({ sub: "a" })), true);
  assert.equal(isJwt(randomBytes(24).toString("hex")), false);
  assert.equal(isJwt(`not-a.real-jwt.${randomBytes(8).toString("hex")}`), false);
  assert.equal(isJwt(`${b64({ alg: "none" })}.${b64({ sub: "a" })}.`), false);
  assert.equal(isJwt(`${b64({ alg: "RS256" })}.${b64("[1]")}.c2ln`), false);
  assert.equal(isJwt(`${b64({ alg: "RS256" })}.${b64({ sub: "a" })}`), false);
});

test("a PKCE pair's challenge is the verifier's S256 hash", () => {
  const p = pkce();
  assert.match(p.verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.equal(p.challenge, createHash("sha256").update(p.verifier).digest("base64url"));
  assert.notEqual(pkce().verifier, p.verifier);
});

const now = () => Math.floor(Date.now() / 1000);
const claims = (over: Record<string, unknown> = {}) => ({ iss: "https://idp", sub: "s1", aud: "dashboard", exp: now() + 60, iat: now(), nonce: "n1", ...over });
const expect = { issuer: "https://idp", clientId: "dashboard", nonce: "n1" };

test("a good ID token gives its claims", () => {
  const { jwk, jwt } = keys();
  assert.equal(verifyIdToken(jwt(claims()), { ...expect, keys: [jwk] }).sub, "s1");
  assert.equal(verifyIdToken(jwt(claims({ aud: ["other", "dashboard"], azp: "dashboard" })), { ...expect, keys: [jwk] }).sub, "s1");
});

test("an ID token is refused for a bad signature, issuer, audience, expiry, nonce or subject", () => {
  const { jwk, jwt } = keys();
  const other = keys().jwk;
  const refused = (token: string, keysUsed: Jwk[] = [jwk]) => assert.throws(() => verifyIdToken(token, { ...expect, keys: keysUsed }));
  refused(jwt(claims()), [other]);
  refused(jwt(claims({ iss: "https://elsewhere" })));
  refused(jwt(claims({ aud: "someone-else" })));
  refused(jwt(claims({ exp: now() - 600 })));
  refused(jwt(claims({ nonce: "not-n1" })));
  refused(jwt(claims({ nonce: undefined })));
  refused(jwt(claims({ sub: "" })));
  refused(jwt(claims({ aud: ["other", "dashboard"], azp: "other" })));
  refused(jwt(claims(), { alg: "none" }));
  refused("not.a.jwt");
});

function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!(url in routes)) return new Response("{}", { status: 404 });
    return Response.json(routes[url]);
  }) as typeof fetch;
}

test("discovery reads the issuer's endpoints and refuses a document for another issuer", async () => {
  const doc = { issuer: "https://idp", authorization_endpoint: "https://idp/auth", token_endpoint: "https://idp/token", jwks_uri: "https://idp/jwks" };
  const d = await discover("https://idp", fakeFetch({ "https://idp/.well-known/openid-configuration": doc }));
  assert.equal(d.authorizationEndpoint, "https://idp/auth");
  assert.equal(d.tokenEndpoint, "https://idp/token");
  assert.equal(d.jwksUri, "https://idp/jwks");
  const slash = await discover("https://idp/", fakeFetch({ "https://idp/.well-known/openid-configuration": doc }));
  assert.equal(slash.issuer, "https://idp");
  await assert.rejects(discover("https://idp", fakeFetch({ "https://idp/.well-known/openid-configuration": { ...doc, issuer: "https://evil" } })));
  await assert.rejects(discover("https://idp", fakeFetch({ "https://idp/.well-known/openid-configuration": { ...doc, jwks_uri: undefined } })));
  await assert.rejects(discover("https://idp", fakeFetch({})));
});
