import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createAuth, DEV_COOKIE, devIdentityProblem, requireRole } from "./auth.ts";

const principal = { "x-ms-client-principal-idp": "aad", "x-ms-client-principal-id": "octo", "x-ms-client-principal-name": "octo" };

describe("identify", () => {
  test("never identifies a request to /webhooks or /internal, even with every principal header, in either mode", () => {
    const azure = createAuth({ mode: "azure" });
    const local = createAuth({ mode: "local", devLogin: "octo" });
    const cookie = `${DEV_COOKIE}=${local.devToken}`;
    for (const path of ["/webhooks/github", "/internal/cells/x"]) {
      assert.equal(azure.identify(path, principal), null, path);
      assert.equal(local.identify(path, { ...principal, cookie }), null, path);
    }
  });

  test("in Azure, reads the principal headers and maps the provider", () => {
    const auth = createAuth({ mode: "azure" });
    assert.deepEqual(auth.identify("/", principal), { provider: "microsoft", subject: "octo", tenantId: null });
    assert.equal(auth.identify("/", { "x-ms-client-principal-idp": "google", "x-ms-client-principal-id": "g1" })?.provider, "google");
    assert.equal(auth.identify("/", { "x-ms-client-principal-idp": "github", "x-ms-client-principal-id": "x" }), null);
    assert.equal(auth.identify("/", {}), null);
  });

  test("in Azure, the dev cookie means nothing", () => {
    const auth = createAuth({ mode: "azure" });
    assert.equal(auth.identify("/", { cookie: `${DEV_COOKIE}=anything` }), null);
    assert.equal(auth.devLoginCookie(""), null);
  });

  test("locally, only this start's cookie identifies the dev user, and principal headers never do", () => {
    const auth = createAuth({ mode: "local", devLogin: "octo" });
    assert.equal(auth.identify("/", principal), null);
    assert.equal(auth.identify("/", { cookie: `${DEV_COOKIE}=${auth.devToken}x` }), null);
    assert.equal(auth.identify("/", { cookie: `other=1; ${DEV_COOKIE}=${createAuth({ mode: "local", devLogin: "octo" }).devToken}` }), null);
    assert.deepEqual(auth.identify("/", { cookie: `other=1; ${DEV_COOKIE}=${auth.devToken}` }), { provider: "dev", subject: "octo", tenantId: null });
  });

  test("the sign-in link sets an HttpOnly, SameSite=Strict cookie only for the right token", () => {
    const auth = createAuth({ mode: "local", devLogin: "octo" });
    assert.match(auth.devToken, /^[0-9a-f]{64}$/);
    assert.equal(auth.devLoginCookie("wrong"), null);
    assert.equal(auth.devLoginCookie(""), null);
    const set = auth.devLoginCookie(auth.devToken) ?? "";
    assert.match(set, new RegExp(`^${DEV_COOKIE}=${auth.devToken};`));
    assert.match(set, /HttpOnly/);
    assert.match(set, /SameSite=Strict/);
  });
});

describe("devIdentityProblem", () => {
  test("refuses a dev login outside local mode, local mode without one, and either inside a Container App", () => {
    assert.ok(devIdentityProblem({ FACTORY_DEV_LOGIN: "octo" }));
    assert.ok(devIdentityProblem({ FACTORY_ENV: "local" }));
    assert.ok(devIdentityProblem({ FACTORY_ENV: "local", FACTORY_DEV_LOGIN: "octo", CONTAINER_APP_NAME: "ca-factory-control" }));
  });

  test("allows local mode with a dev login, and Azure with neither", () => {
    assert.equal(devIdentityProblem({ FACTORY_ENV: "local", FACTORY_DEV_LOGIN: "octo" }), null);
    assert.equal(devIdentityProblem({ CONTAINER_APP_NAME: "ca-factory-control" }), null);
  });
});

describe("requireRole", () => {
  test("a role covers itself and every lower one", () => {
    assert.equal(requireRole({ role: "owner" }, "operator"), true);
    assert.equal(requireRole({ role: "operator" }, "operator"), true);
    assert.equal(requireRole({ role: "viewer" }, "operator"), false);
  });
});
