// Which page the SPA shows for an address (redesign step 8b).
import assert from "node:assert/strict";
import { test } from "node:test";
import { routeOf, transcriptPath } from "./routes.ts";

test("each page has its address, and any other is none", () => {
  assert.deepEqual(routeOf("/"), { page: "floor" });
  assert.deepEqual(routeOf("/activity"), { page: "activity" });
  assert.deepEqual(routeOf("/phase0/"), { page: "phase0" });
  assert.deepEqual(routeOf("/runs/00000000-0000-4000-8000-000000000046"), { page: "item", id: "00000000-0000-4000-8000-000000000046" });
  assert.deepEqual(routeOf("/runs/a%2Fb"), { page: "item", id: "a/b" });
  assert.deepEqual(routeOf("/runs/%E2"), { page: "none" });
  assert.deepEqual(routeOf("/runs/"), { page: "none" });
  assert.deepEqual(routeOf("/configuration"), { page: "none" });
});

test("an attempt's transcript page has its address under the item's Run detail (PBI 326)", () => {
  const id = "00000000-0000-4000-8000-000000000326";
  assert.equal(transcriptPath(id, "build", 2), `/runs/${id}/transcripts/build/2`);
  assert.deepEqual(routeOf(transcriptPath(id, "build", 2)), { page: "transcript", id, stage: "build", attempt: 2 });
  assert.deepEqual(routeOf(transcriptPath("a/b", "pr-review", 1)), { page: "transcript", id: "a/b", stage: "pr-review", attempt: 1 });
  assert.deepEqual(routeOf(`/runs/${id}/transcripts/build/0`), { page: "none" });
  assert.deepEqual(routeOf(`/runs/${id}/transcripts/build/x`), { page: "none" });
  assert.deepEqual(routeOf(`/runs/${id}/transcripts/build`), { page: "none" });
});
