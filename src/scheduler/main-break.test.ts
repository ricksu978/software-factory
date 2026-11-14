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

  test("names nothing for a log with no TAP lines, or no log", () => {
    assert.deepEqual(failingTests("src/main.ts(3,1): error TS1005: ';' expected."), []);
    assert.deepEqual(failingTests(null), []);
  });
});

describe("compareWithParent (PBI 255)", () => {
  const run = (name: string, status: "success" | "failure" | "pending") => ({ name, status, url: `u/${name}` });

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
