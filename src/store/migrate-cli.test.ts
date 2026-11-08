import assert from "node:assert/strict";
import { test } from "node:test";
import { principalGrants } from "./migrate-cli.ts";

// Redesign §08: each service's Entra principal maps onto its own role, and FACTORY_APP_PRINCIPAL is today's single mapping.
test("each service's principal setting maps onto its role", () => {
  const env = {
    FACTORY_BFF_PRINCIPAL: "id-bff",
    FACTORY_API_PRINCIPAL: "id-api",
    FACTORY_WORKER_PRINCIPAL: "id-worker",
    FACTORY_CELL_API_PRINCIPAL: "id-cellapi",
  };
  assert.deepEqual(principalGrants(env), [
    { principal: "id-bff", role: "factory_bff" },
    { principal: "id-api", role: "factory_app" },
    { principal: "id-worker", role: "factory_app" },
    { principal: "id-cellapi", role: "factory_app" },
  ]);
});

test("a service whose setting is missing or empty gets nothing", () => {
  assert.deepEqual(principalGrants({ FACTORY_API_PRINCIPAL: "id-api", FACTORY_BFF_PRINCIPAL: "" }), [{ principal: "id-api", role: "factory_app" }]);
});

test("with no service's principal set, FACTORY_APP_PRINCIPAL maps onto factory_app as today", () => {
  assert.deepEqual(principalGrants({ FACTORY_APP_PRINCIPAL: "id-control" }), [{ principal: "id-control", role: "factory_app" }]);
});

test("once any service's principal is set, FACTORY_APP_PRINCIPAL is left alone", () => {
  assert.deepEqual(principalGrants({ FACTORY_APP_PRINCIPAL: "id-control", FACTORY_BFF_PRINCIPAL: "id-bff" }), [{ principal: "id-bff", role: "factory_bff" }]);
});

test("with nothing set, no principal is mapped", () => {
  assert.deepEqual(principalGrants({}), []);
});
