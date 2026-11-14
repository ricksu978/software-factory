import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { localIssuer, PINNED_KEYCLOAK, readRealm, realmTestOwner } from "./keycloak-owner.ts";

const realm = {
  realm: "factory",
  users: [
    { id: "no-password", username: "svc", credentials: [] },
    { id: "5f0c", username: "owner", credentials: [{ type: "password", value: "x" }] },
  ],
};

test("the realm's test owner is the user with a password, keyed by its fixed id", () => {
  assert.deepEqual(realmTestOwner(realm), { realm: "factory", subject: "5f0c" });
});

test("a realm with no user holding a password and a fixed id names no test owner", () => {
  assert.throws(() => realmTestOwner({ realm: "factory", users: [{ username: "owner", credentials: [{ type: "password" }] }] }), /test owner/);
  assert.throws(() => realmTestOwner({ users: [] }), /realm/);
});

test("the committed realm import has a test owner", () => {
  const owner = realmTestOwner(readRealm());
  assert.equal(owner.realm, "factory");
  assert.ok(owner.subject.length > 0);
});

test("with pinned ports the issuer is the realm on 7430, and Keycloak isn't asked", async () => {
  let asked = false;
  const fetchFn = (async () => {
    asked = true;
    throw new Error("no");
  }) as typeof fetch;
  assert.equal(PINNED_KEYCLOAK, "http://localhost:7430");
  assert.equal(await localIssuer({}, "factory", fetchFn), "http://localhost:7430/realms/factory");
  assert.equal(await localIssuer({ FACTORY_FLOAT_PORTS: "0", services__keycloak__http__0: "http://localhost:1" }, "factory", fetchFn), "http://localhost:7430/realms/factory");
  assert.equal(asked, false);
});

test("with floating ports the issuer is the one the live realm's discovery document names", async () => {
  const server = createServer((req, res) => {
    const port = (server.address() as AddressInfo).port;
    if (req.url === "/realms/factory/.well-known/openid-configuration") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ issuer: `http://localhost:${port}/realms/factory` }));
    } else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const env = { FACTORY_FLOAT_PORTS: "1", services__keycloak__http__0: `http://localhost:${port}/` };
    assert.equal(await localIssuer(env, "factory"), `http://localhost:${port}/realms/factory`);
    await assert.rejects(localIssuer(env, "other"), /Keycloak/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("with floating ports migrate fails naming Keycloak rather than guess", async () => {
  const env = { FACTORY_FLOAT_PORTS: "1" };
  await assert.rejects(localIssuer(env, "factory"), /Keycloak.*services__keycloak__http__0/);
  const refused = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  await assert.rejects(localIssuer({ ...env, services__keycloak__http__0: "http://localhost:1" }, "factory", refused), /Keycloak/);
  const noIssuer = (async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
  await assert.rejects(localIssuer({ ...env, services__keycloak__http__0: "http://localhost:1" }, "factory", noIssuer), /Keycloak.*issuer/);
});
