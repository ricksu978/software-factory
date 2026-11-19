import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { splitStatus } from "./board.ts";

describe("the board status a Split parent mirrors to (PBI 227)", () => {
  test("is the status the field map names for Split, whatever its name", () => {
    assert.equal(splitStatus({ statusFor: { Split: "Done" } }), "Done");
    assert.equal(splitStatus({ statusFor: { Split: "Split up", Done: "Done" } }), "Split up");
  });

  test("is none when the field map names no status for Split, so the board status stays as it was", () => {
    assert.equal(splitStatus({ statusFor: { Eligible: "Backlog" } }), null);
    assert.equal(splitStatus({ statusFor: { Split: null } }), null);
    assert.equal(splitStatus({ statusFor: { Split: "" } }), null);
    assert.equal(splitStatus({}), null);
    assert.equal(splitStatus(null), null);
  });
});
