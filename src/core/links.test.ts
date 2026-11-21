import assert from "node:assert/strict";
import { test } from "node:test";
import { issueUrl } from "./links.ts";

test("an issue's address on GitHub, or none when its repo or number can't be told", () => {
  assert.equal(issueUrl("acme/shop", "43"), "https://github.com/acme/shop/issues/43");
  assert.equal(issueUrl(null, "43"), null);
  assert.equal(issueUrl("acme/shop", "PROJ-4"), null);
});
