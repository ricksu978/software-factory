import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { baseQuestion, failingTests, runOnBase, sharedWithBase } from "./base-run.ts";

describe("failingTests", () => {
  test("reads TAP's not ok lines, leaving out TODO and SKIP", () => {
    const out = "TAP version 13\nnot ok 1 - parses the config\nok 2 - fine\n    not ok 3 - reads the board # took 3ms\nnot ok 4 - later # TODO\nnot ok 5 - skipped # SKIP\n1..5";
    assert.deepEqual(failingTests(out), ["parses the config", "reads the board"]);
  });

  test("reads node's spec reporter crosses once, though it lists each failure twice", () => {
    const out = "▶ config\n  ✖ parses the config (1.2ms)\n  ✔ fine (0.3ms)\n✖ config (2ms)\n\n✖ failing tests:\n\ntest at src/a.test.ts:3:3\n✖ parses the config (1.2ms)\n  AssertionError";
    assert.deepEqual(failingTests(out), ["parses the config", "config"]);
  });

  test("reads the scenarios in cucumber-js 13.3.0's Failed scenarios block, skipping the step lines under each", () => {
    // Captured from the pinned @cucumber/cucumber 13.3.0, run with this repo's `--format message:...` flag.
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

  test("finds nothing in output that names no test", () => {
    assert.deepEqual(failingTests("src/a.ts(3,1): error TS2304: Cannot find name 'x'."), []);
  });
});

describe("sharedWithBase", () => {
  test("holds when every test that failed on the branch fails on the base too", () => {
    assert.equal(sharedWithBase(["a"], ["a", "b"]), true);
    assert.equal(sharedWithBase(["a", "b"], ["b", "a"]), true);
  });

  test("doesn't hold when a test fails only on the branch, or when no test was named", () => {
    assert.equal(sharedWithBase(["a", "b"], ["a"]), false);
    assert.equal(sharedWithBase([], []), false);
  });
});

describe("baseQuestion", () => {
  test("says the base fails in the cell, names the base commit, the lines and their tests, and doesn't blame the item", () => {
    const q = baseQuestion("main", "b4se001ffffffff", [{ criterion: "Unit tests pass.", tests: ["parses the config", "reads the board"] }]);
    assert.match(q, /base fails in the cell/i);
    assert.ok(q.includes("b4se001"));
    assert.ok(q.includes("origin/main"));
    assert.ok(q.includes("Unit tests pass."));
    assert.ok(q.includes("- parses the config\n- reads the board"));
    assert.match(q, /isn't at fault/);
  });
});

describe("runOnBase", () => {
  const roots: string[] = [];
  afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

  test("runs the command at origin/<base> in a worktree of its own, then removes it, leaving the checkout as it was", async () => {
    const root = mkdtempSync(join(tmpdir(), "base-run-"));
    roots.push(root);
    const dir = join(root, "work");
    git(root, "init", "-q", "-b", "main", dir);
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    writeFileSync(join(dir, "f.txt"), "base\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    const base = git(dir, "rev-parse", "HEAD");
    git(dir, "update-ref", "refs/remotes/origin/main", base);
    git(dir, "checkout", "-q", "-b", "item");
    writeFileSync(join(dir, "f.txt"), "item\n");
    git(dir, "commit", "-qam", "item");
    const head = git(dir, "rev-parse", "HEAD");
    writeFileSync(join(dir, "untracked.txt"), "left alone\n");

    const r = await runOnBase(dir, "main", "cat f.txt && git rev-parse HEAD && echo set > ran.txt && exit 3", "echo setup > setup.txt");
    assert.equal(r.sha, base);
    assert.equal(r.code, 3);
    assert.match(r.out, /^base\n/);
    assert.ok(r.out.includes(base));
    assert.equal(git(dir, "rev-parse", "HEAD"), head);
    assert.equal(git(dir, "rev-parse", "--abbrev-ref", "HEAD"), "item");
    assert.equal(readFileSync(join(dir, "f.txt"), "utf8"), "item\n");
    assert.ok(existsSync(join(dir, "untracked.txt")));
    assert.ok(!existsSync(join(dir, "ran.txt")));
    assert.equal(git(dir, "worktree", "list").split("\n").length, 1);
  });

  test("reports a setup that fails instead of running the command", async () => {
    const root = mkdtempSync(join(tmpdir(), "base-run-"));
    roots.push(root);
    const dir = join(root, "work");
    git(root, "init", "-q", "-b", "main", dir);
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    git(dir, "commit", "-q", "--allow-empty", "-m", "base");
    git(dir, "update-ref", "refs/remotes/origin/main", git(dir, "rev-parse", "HEAD"));
    const r = await runOnBase(dir, "main", "echo ran", "exit 4");
    assert.equal(r.code, 4);
    assert.match(r.out, /commands\.setup/);
    assert.ok(!r.out.includes("ran"));
  });
});
