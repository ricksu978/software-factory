import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { matchesLock } from "./lock.ts";

// The scenarios cover an edit, a new step definition and a merge. These cover the rest.
function repoWithLockedFile() {
  const dir = mkdtempSync(join(tmpdir(), "lock-test-"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  mkdirSync(join(dir, "features"));
  writeFileSync(join(dir, "features/a.feature"), "@pbi-1\nFeature: A\n");
  git("add", ".");
  git("commit", "-q", "-m", "specify");
  return { dir, git, lockSha: git("rev-parse", "HEAD") };
}

test("deleting a locked feature file fails the lock check", async (t) => {
  const { dir, git, lockSha } = repoWithLockedFile();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git("rm", "-q", "features/a.feature");
  git("commit", "-q", "-m", "drop it");
  assert.equal(await matchesLock(dir, lockSha, ["features/a.feature"]), false);
});

test("an empty list of locked files is refused, because it would diff the whole tree", async (t) => {
  const { dir, lockSha } = repoWithLockedFile();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(matchesLock(dir, lockSha, []), /at least one locked file/);
});

test("a lock commit git doesn't know throws instead of passing or failing", async (t) => {
  const { dir } = repoWithLockedFile();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(matchesLock(dir, "0".repeat(40), ["features/a.feature"]));
});
