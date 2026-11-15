import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { bearerVerifier, discoverJwks } from "./auth.ts";

describe("the API's bearer tokens", () => {
  let server: Server;
  let issuer: string;
  let discovery: Record<string, unknown>;
  let published: CryptoKey;
  let unpublished: CryptoKey;

  before(async () => {
    const a = await generateKeyPair("RS256", { extractable: true });
    published = a.privateKey;
    unpublished = (await generateKeyPair("RS256")).privateKey;
    const jwk = { ...(await exportJWK(a.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    server = createServer((req, res) => {
      const send = (b: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(b));
      if (req.url === "/realm/.well-known/openid-configuration") send(discovery);
      else if (req.url === "/realm/certs") send({ keys: [jwk] });
      else res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}/realm`;
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  const fullDiscovery = () => (discovery = { issuer, jwks_uri: `${issuer}/certs` });

  test("discovery finds the issuer's key set", async () => {
    fullDiscovery();
    assert.equal(String(await discoverJwks(issuer)), `${issuer}/certs`);
    assert.equal(String(await discoverJwks(`${issuer}/`)), `${issuer}/certs`, "a trailing slash on the issuer changes nothing");
  });

  test("discovery with no jwks_uri refuses, naming jwks_uri", async () => {
    discovery = { issuer };
    await assert.rejects(discoverJwks(issuer), /jwks_uri/);
  });

  test("discovery naming another issuer refuses", async () => {
    discovery = { issuer: "http://elsewhere.test", jwks_uri: `${issuer}/certs` };
    await assert.rejects(discoverJwks(issuer), /issuer/);
  });

  test("an issuer with no discovery document refuses", async () => {
    await assert.rejects(discoverJwks(`${issuer}/nothing-here`), /discovery/);
  });

  async function token(o: { iss?: string; aud?: string | null; sub?: string | null; exp?: number; key?: CryptoKey } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const jwt = new SignJWT({}).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(o.iss ?? issuer).setIssuedAt(now - 60).setExpirationTime(now + (o.exp ?? 300));
    if (o.sub !== null) jwt.setSubject(o.sub ?? "vera");
    if (o.aud !== null) jwt.setAudience(o.aud ?? "factory-api");
    return jwt.sign(o.key ?? published);
  }

  test("a valid bearer token names its issuer and subject", async () => {
    fullDiscovery();
    const verify = bearerVerifier({ issuer, audience: "factory-api", jwks: await discoverJwks(issuer) });
    assert.deepEqual(await verify(`Bearer ${await token()}`), { issuer, subject: "vera" });
    assert.deepEqual(await verify(`bearer ${await token()}`), { issuer, subject: "vera" }, "the scheme is case-insensitive");
  });

  test("every flawed token or header is refused", async () => {
    fullDiscovery();
    const verify = bearerVerifier({ issuer, audience: "factory-api", jwks: await discoverJwks(issuer) });
    const good = await token();
    const [head, body, sig] = good.split(".");
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    const altered = [head, Buffer.from(JSON.stringify({ ...claims, sub: "olga" })).toString("base64url"), sig].join(".");
    const refused: Record<string, string | undefined> = {
      "no header": undefined,
      "another scheme": `Basic ${good}`,
      "no token": "Bearer ",
      "not a JWT": "Bearer not-a-jwt",
      "another issuer": `Bearer ${await token({ iss: "http://elsewhere.test" })}`,
      "another audience": `Bearer ${await token({ aud: "some-other-api" })}`,
      "no audience": `Bearer ${await token({ aud: null })}`,
      "no subject": `Bearer ${await token({ sub: null })}`,
      "expired": `Bearer ${await token({ exp: -60 })}`,
      "an unpublished key": `Bearer ${await token({ key: unpublished })}`,
      "an altered payload": `Bearer ${altered}`,
    };
    for (const [why, header] of Object.entries(refused)) assert.equal(await verify(header), null, why);
  });
});
