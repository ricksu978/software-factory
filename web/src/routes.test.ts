// Which page the SPA shows for an address (redesign step 8b).
import assert from "node:assert/strict";
import { test } from "node:test";
import { routeOf } from "./routes.ts";

test("each page has its address, and any other is none", () => {
  assert.deepEqual(routeOf("/"), { page: "floor" });
  assert.deepEqual(routeOf("/activity"), { page: "activity" });
  assert.deepEqual(routeOf("/phase0/"), { page: "phase0" });
  assert.deepEqual(routeOf("/runs/00000000-0000-4000-8000-000000000046"), { page: "item", id: "00000000-0000-4000-8000-000000000046" });
  assert.deepEqual(routeOf("/runs/a%2Fb"), { page: "item", id: "a/b" });
  assert.deepEqual(routeOf("/runs/%E2"), { page: "none" });
  assert.deepEqual(routeOf("/runs/"), { page: "none" });
  assert.deepEqual(routeOf("/configuration"), { page: "configuration" });
  assert.deepEqual(routeOf("/settings"), { page: "none" });
});
