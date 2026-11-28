import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { failingTests } from "./failing-tests.ts";

// PBI 321: the one reader of the tests a log says failed, for the cell's CI finding, the base-failure check and the bug
// item for a red main.
describe("failingTests", () => {
  test("names each `not ok` test in a TAP log once, and no passing one, TODO or SKIP", () => {
    const log = ["TAP version 13", "ok 1 - loads the policy", "not ok 2 - parses the config", "    not ok 3 - reads the board # took 3ms",
      "not ok 4 - parses the config", "not ok 5 - later # TODO", "not ok 6 - skipped # SKIP", "1..6"].join("\n");
    assert.deepEqual(failingTests(log), ["parses the config", "reads the board"]);
  });

  test("names the failing test inside a failing TAP suite, and not the suite", () => {
    const log = [
      "# Subtest: config", "    # Subtest: parses the config", "    not ok 1 - parses the config", "      ---", "      ...",
      "    ok 2 - reads defaults", "    1..2", "not ok 1 - config", "not ok 2 - a test on its own", "1..2",
    ].join("\n");
    assert.deepEqual(failingTests(log), ["parses the config", "a test on its own"]);
  });

  test("reads a GitHub Actions log, whose lines start with a timestamp", () => {
    const log = ["2026-11-14T10:00:00.1234567Z not ok 1 - reads the board", "2026-11-14T10:00:00.2Z not ok 2 - later # TODO not yet"].join("\n");
    assert.deepEqual(failingTests(log), ["reads the board"]);
  });

  // Node 26's spec reporter, as `npm test` prints it on CI, with GitHub's timestamps and the reporter's colours.
  test("names each failing test in the spec reporter's failing tests list, and no suite or TODO", () => {
    const log = [
      "▶ suite one", "  ✖ parses the config (0.58ms)", "  ✔ passes (0.10ms)", "✖ suite one (1.22ms)", "✖ reads the board (0.11ms)",
      "⚠ later (0.10ms) # TODO", "ℹ tests 4", "ℹ fail 2", "", "✖ failing tests:", "", "test at src/a.test.ts:3:31",
      "\x1b[31m✖ parses the config (0.58ms)\x1b[39m", "  AssertionError [ERR_ASSERTION]: 1 == 2", "      at TestContext.<anonymous> (file:///src/a.test.ts:3:70)",
      "", "test at src/a.test.ts:4:1", "✖ reads the board (0.11ms)", "  Error: x", "", "test at src/a.test.ts:5:6", "⚠ later (0.10ms) # TODO", "  Error: t",
    ].map((l) => `2026-11-14T10:00:00.1234567Z ${l}`).join("\n");
    assert.deepEqual(failingTests(log), ["parses the config", "reads the board"]);
  });

  test("names the scenarios in cucumber-js 13.3.0's Failed scenarios block by name, skipping the lines under each", () => {
    const out = [
      "F.F", "", "Failed scenarios:",
      "  1) The board loads # features/a.feature:2",
      "       Given it fails # features/steps/s.mjs:2",
      "           Error: boom",
      "               at World.<anonymous> (file:///tmp/x/features/steps/s.mjs:2:33)",
      "  2) Sign-off works # features\\b.feature:7",
      "       When it is signed # features\\steps\\s.mjs:5",
      "           not ok 1 - not a test",
      "", "3 scenarios (1 passed, 2 failed)", "3 steps (1 passed, 2 failed)", "0m 0.005s (0m 0.000s executing your code)",
    ].join("\r\n");
    assert.deepEqual(failingTests(out), ["The board loads", "Sign-off works"]);
  });

  test("names a log's 2 ambiguous scenarios when no scenario failed (PBI 321 @ac-3)", () => {
    const log = [
      "Ambiguous scenarios:", "  1) Two steps match the total # features/orders.feature:20", "  2) Two steps match the refund # features/refunds.feature:31",
      "", "9 scenarios (2 ambiguous, 7 passed)",
    ].join("\n");
    assert.deepEqual(failingTests(log), ["Two steps match the total", "Two steps match the refund"]);
  });

  test("names the scenarios under each of the failed, ambiguous, undefined and pending blocks once, in the log's order", () => {
    const log = [
      "##[group]Run npm run bdd", "##[endgroup]", "Ambiguous scenarios:", "  1) Two steps match # features/a.feature:4",
      "       Given amb", "           Multiple matching step definitions found:", "             • amb # features/steps/s.ts:3",
      "Undefined scenarios:", "  1) A refund needs the order's number # features/refunds.feature:8",
      "     ? Given an order numbered \"1001\"", "         Undefined. Implement with the following snippet:",
      "Pending scenarios:", "  1) A discount is shown # features/invoices.feature:15",
      "Failed scenarios:", "  1) The board loads # features/b.feature:2", "  2) Two steps match # features/a.feature:4",
      "", "5 scenarios (1 ambiguous, 1 undefined, 1 pending, 1 failed, 1 passed)", "##[error]Process completed with exit code 1.",
    ].map((l) => `2026-11-14T10:00:00.1234567Z ${l}`).join("\n");
    assert.deepEqual(failingTests(log), ["Two steps match", "A refund needs the order's number", "A discount is shown", "The board loads"]);
  });

  test("names node's failing tests and cucumber's scenarios from one log", () => {
    const log = ["✖ failing tests:", "", "test at src/config.test.ts:4:1", "✖ parses the config (1.2ms)", "",
      "Ambiguous scenarios:", "  1) Two steps match the total # features/orders.feature:20", "", "4 scenarios (1 ambiguous, 3 passed)"].join("\n");
    assert.deepEqual(failingTests(log), ["parses the config", "Two steps match the total"]);
  });

  test("names nothing for a log that names no test, or no log", () => {
    assert.deepEqual(failingTests("src/main.ts(3,1): error TS1005: ';' expected."), []);
    assert.deepEqual(failingTests(null), []);
  });
});
