import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bugItem, compareWithParent, failingTests } from "./main-break.ts";

describe("failingTests (PBI 255)", () => {
  test("names each `not ok` test in a TAP log, once, and no passing one", () => {
    const log = ["TAP version 13", "ok 1 - loads the policy", "not ok 2 - parses the config", "not ok 3 - reads the board", "not ok 4 - parses the config", "1..4"].join("\n");
    assert.deepEqual(failingTests(log), ["parses the config", "reads the board"]);
  });

  test("names the failing test inside a failing suite, and not the suite", () => {
    const log = [
      "# Subtest: config", "    # Subtest: parses the config", "    not ok 1 - parses the config", "      ---", "      ...",
      "    ok 2 - reads defaults", "    1..2", "not ok 1 - config", "not ok 2 - a test on its own", "1..2",
    ].join("\n");
    assert.deepEqual(failingTests(log), ["parses the config", "a test on its own"]);
  });

  test("reads a GitHub Actions log, whose lines start with a timestamp, and skips a TODO", () => {
    const log = ["2026-11-14T10:00:00.1234567Z not ok 1 - reads the board", "2026-11-14T10:00:00.2Z not ok 2 - later # TODO not yet"].join("\n");
    assert.deepEqual(failingTests(log), ["reads the board"]);
  });

  // Node 26's spec reporter, as `npm test` prints it on CI, with GitHub's timestamps and the reporter's colours.
  const spec = [
    "▶ suite one", "  ✖ parses the config (0.58ms)", "  ✔ passes (0.10ms)", "✖ suite one (1.22ms)", "✖ reads the board (0.11ms)",
    "⚠ later (0.10ms) # TODO", "ℹ tests 4", "ℹ fail 2", "", "✖ failing tests:", "", "test at src/a.test.ts:3:31",
    "\x1b[31m✖ parses the config (0.58ms)\x1b[39m", "  AssertionError [ERR_ASSERTION]: 1 == 2", "      at TestContext.<anonymous> (file:///src/a.test.ts:3:70)",
    "", "test at src/a.test.ts:4:1", "✖ reads the board (0.11ms)", "  Error: x", "", "test at src/a.test.ts:5:6", "⚠ later (0.10ms) # TODO", "  Error: t",
  ].map((l) => `2026-11-14T10:00:00.1234567Z ${l}`).join("\n");

  test("names each failing test in the spec reporter's failing tests list, and no suite or TODO", () => {
    assert.deepEqual(failingTests(spec), ["parses the config", "reads the board"]);
  });

  test("names each scenario cucumber's summary lists as failed or ambiguous, with its file and line", () => {
    const log = [
      "##[group]Run npm run bdd -- --tags \"not @local\"", "##[endgroup]", "FA.", "", "Ambiguous scenarios:", "  1) Two steps match # features/a.feature:4",
      "       Given amb", "           Multiple matching step definitions found:", "             • amb # features/steps/s.ts:3", "",
      "Failed scenarios:",
      "  1) The stage reads the PR's diff at the head the reviewer reviewed before it posts the review # features/pbi-266-review-findings-outside-diff.feature:27",
      "       Given a thing # features/steps/s.ts:2", "           Error: boom", "", "3 scenarios (1 passed, 1 ambiguous, 1 failed)", "3 steps (1 passed, 1 ambiguous, 1 failed)",
      "##[error]Process completed with exit code 1.",
    ].map((l) => `2026-11-14T10:00:00.1234567Z ${l}`).join("\n");
    assert.deepEqual(failingTests(log), [
      "Two steps match (features/a.feature:4)",
      "The stage reads the PR's diff at the head the reviewer reviewed before it posts the review (features/pbi-266-review-findings-outside-diff.feature:27)",
    ]);
  });

  test("names nothing for a log that names no test, or no log", () => {
    assert.deepEqual(failingTests("src/main.ts(3,1): error TS1005: ';' expected."), []);
    assert.deepEqual(failingTests(null), []);
  });
});

describe("compareWithParent (PBI 255)", () => {
  const run = (name: string, status: "success" | "failure" | "pending" | "cancelled") => ({ name, status, url: `u/${name}` });

  test("a merge that fails a check its first parent passed broke main, and every failed check is listed", () => {
    const got = compareWithParent([run("test", "failure"), run("lint", "failure"), run("bdd", "success")], [run("test", "success"), run("lint", "failure")]);
    assert.equal(got.verdict, "broke");
    assert.deepEqual(got.failed.map((r) => r.name), ["test", "lint"]);
  });

  test("a merge that fails only checks its first parent failed found main already red", () => {
    assert.equal(compareWithParent([run("test", "failure")], [run("test", "failure"), run("bdd", "success")]).verdict, "already red");
  });

  test("a check its first parent never ran counts as passed there, so the merge broke main", () => {
    assert.equal(compareWithParent([run("test", "failure")], []).verdict, "broke");
  });

  test("a check still running on the first parent leaves it undecided", () => {
    assert.equal(compareWithParent([run("test", "failure")], [run("test", "pending")]).verdict, "undecided");
  });

  test("a check cancelled on the first parent counts as never run there, so the merge broke main", () => {
    assert.equal(compareWithParent([run("test", "failure")], [run("test", "cancelled")]).verdict, "broke");
  });

  test("a merge whose only unpassed runs were cancelled failed nothing, so it reads as cancelled", () => {
    assert.equal(compareWithParent([run("test", "cancelled"), run("lint", "success")], [run("test", "failure")]).verdict, "cancelled");
  });

  test("with no failed check run, nothing can be compared", () => {
    assert.equal(compareWithParent([run("test", "success")], []).verdict, "no checks");
  });
});

describe("bugItem (PBI 255)", () => {
  const base = { sha: "m3rg0010123456789", branch: "main", prNumber: 57, prUrl: "https://github.com/acme/widgets/pull/57", itemExternalId: "482" };

  test("names the merge commit, its PR and item, and each failed check with its URL on one line", () => {
    const { title, body } = bugItem({ ...base, checks: [{ name: "test", url: "https://x/runs/901", tests: ["parses the config"] }, { name: "bdd", url: "https://x/runs/902", tests: [] }] });
    assert.match(title, /m3rg001/);
    assert.match(body, /m3rg0010123456789/);
    assert.match(body, /PR #57/);
    assert.match(body, /item #482/);
    assert.ok(body.split("\n").includes("- test: https://x/runs/901"));
    assert.ok(body.split("\n").includes("- bdd: https://x/runs/902"));
    assert.match(body, /Failing tests[^\n]*\n- parses the config$/m);
    assert.match(body, /^## Acceptance criteria\n\n- /m);
  });

  test("says no log names a failing test, and lists none, when none does", () => {
    const { body } = bugItem({ ...base, checks: [{ name: "build", url: "u", tests: [] }] });
    assert.doesNotMatch(body, /^Failing tests/m);
    assert.match(body, /No check's log names a failing test\./);
  });
});
