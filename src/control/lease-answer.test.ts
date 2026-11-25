import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { leaseAnswer } from "./cell-api.ts";

// PBI 379: a drain ends cells as a restart being prepared does (PBI 301). The cell carries on, finishes the stage it's
// in and ends its claim at that stage boundary. A pause, the kill switch or an operator's stop still stops it.
describe("leaseAnswer", () => {
  const none = { kill: false, pause: false, restart: false, stopRun: false, drain: false };

  test("tells a cell to carry on with nothing set", () => {
    assert.deepEqual(leaseAnswer(none), { stop: false, restarting: false });
  });

  test("under a drain, tells the cell to carry on and end its claim at the next stage boundary", () => {
    assert.deepEqual(leaseAnswer({ ...none, drain: true }), { stop: false, restarting: true });
  });

  test("under a drain and a restart being prepared, gives the same word", () => {
    assert.deepEqual(leaseAnswer({ ...none, drain: true, restart: true }), { stop: false, restarting: true });
  });

  for (const k of ["pause", "kill", "stopRun"] as const) {
    test(`under a drain, ${k} still tells the cell to stop`, () => {
      assert.deepEqual(leaseAnswer({ ...none, drain: true, [k]: true }), { stop: true, restarting: false });
    });
  }
});
