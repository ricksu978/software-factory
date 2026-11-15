import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { test } from "node:test";
import { discover, finishSignIn, isJwt, startSignIn } from "./oidc.ts";

const b64 = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

function keys(kid = "k1") {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
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

const ISS = "https://idp";
const REDIRECT = "https://bff/auth/callback";
const doc = {
  issuer: ISS, authorization_endpoint: `${ISS}/auth`, token_endpoint: `${ISS}/token`, jwks_uri: `${ISS}/jwks`,
  response_types_supported: ["code"], id_token_signing_alg_values_supported: ["RS256"],
};

type IdTokenOver = { claims?: Record<string, unknown>; signer?: ReturnType<typeof keys> };

/** A provider behind a fake fetch: discovery, a JWKS of `signing`, and a token endpoint answering with `idToken(nonce)`. */
function idp(signing: ReturnType<typeof keys>, over: IdTokenOver = {}, discovery: Record<string, unknown> = doc) {
  const seen: { nonce?: string } = {};
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${ISS}/.well-known/openid-configuration`) return Response.json(discovery);
    if (url === `${ISS}/jwks`) return Response.json({ keys: [signing.jwk] });
    if (url === `${ISS}/token`) {
      const form = new URLSearchParams(String(init?.body ?? ""));
      assert.ok(form.get("code_verifier"), "no PKCE verifier reached the token endpoint");
      const now = Math.floor(Date.now() / 1000);
      const id = (over.signer ?? signing).jwt({ iss: ISS, sub: "s1", aud: "dashboard", exp: now + 60, iat: now, nonce: seen.nonce, ...over.claims });
      return Response.json({ access_token: signing.jwt({ sub: "s1" }), token_type: "Bearer", expires_in: 300, id_token: id, refresh_token: "rt" });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { f, seen };
}

async function roundTrip(signing: ReturnType<typeof keys>, over: IdTokenOver = {}) {
  const { f, seen } = idp(signing, over);
  const p = await discover({ issuer: ISS, clientId: "dashboard", clientSecret: "s", fetch: f });
  const { checks, to } = await startSignIn(p, REDIRECT, "openid");
  seen.nonce = checks.nonce;
  return { checks, to, finish: () => finishSignIn(p, new URL(`${REDIRECT}?code=c1&state=${checks.state}`), checks) };
}

test("sign-in asks for a code with an S256 challenge, state and nonce, and gives the ID token's subject", async () => {
  const k = keys();
  const { checks, to, finish } = await roundTrip(k);
  assert.equal(`${to.origin}${to.pathname}`, `${ISS}/auth`);
  assert.equal(to.searchParams.get("response_type"), "code");
  assert.equal(to.searchParams.get("code_challenge_method"), "S256");
  assert.equal(to.searchParams.get("state"), checks.state);
  assert.equal(to.searchParams.get("nonce"), checks.nonce);
  const out = await finish();
  assert.equal(out.issuer, ISS);
  assert.equal(out.subject, "s1");
  assert.equal(out.refreshToken, "rt");
});

test("an ID token is refused for a bad signature, issuer, audience, expiry or nonce", async () => {
  const k = keys();
  for (const over of [
    { signer: keys() },
    { claims: { iss: "https://elsewhere" } },
    { claims: { aud: "someone-else" } },
    { claims: { exp: Math.floor(Date.now() / 1000) - 600 } },
    { claims: { nonce: "not-the-nonce" } },
  ] as IdTokenOver[]) {
    const { finish } = await roundTrip(k, over);
    await assert.rejects(finish(), Error, JSON.stringify(over.claims ?? "another key"));
  }
});

test("discovery refuses a document for another issuer, and plain HTTP away from localhost", async () => {
  const k = keys();
  await assert.rejects(discover({ issuer: ISS, clientId: "dashboard", fetch: idp(k, {}, { ...doc, issuer: "https://evil" }).f }));
  await assert.rejects(discover({ issuer: ISS, clientId: "dashboard", fetch: (async () => new Response("{}", { status: 404 })) as typeof fetch }));
  let calls = 0;
  const counting = (async () => { calls++; return Response.json({ ...doc, issuer: "http://idp.example" }); }) as typeof fetch;
  await assert.rejects(discover({ issuer: "http://idp.example", clientId: "dashboard", fetch: counting }));
  assert.equal(calls, 0, "discovery went out over plain HTTP to a remote issuer");
  const slash = await discover({ issuer: `${ISS}/`, clientId: "dashboard", fetch: idp(k).f });
  assert.equal(slash.serverMetadata().issuer, ISS);
});
