import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bugItem, compareWithParent } from "./main-break.ts";

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
