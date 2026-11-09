import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { matchesLock, restoreLock } from "./lock.ts";

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

test("restoring the lock puts back an edited and a deleted locked file, and keeps every other change", async (t) => {
  const { dir, git } = repoWithLockedFile();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "features/b.feature"), "@pbi-1\nFeature: B\n");
  git("add", ".");
  git("commit", "-q", "-m", "a second locked file");
  const lock = git("rev-parse", "HEAD");
  writeFileSync(join(dir, "features/a.feature"), "@pbi-1\nFeature: A, edited\n");
  git("rm", "-q", "features/b.feature");
  writeFileSync(join(dir, "app.txt"), "kept\n");
  git("add", ".");
  git("commit", "-q", "-m", "edit and drop");
  const files = ["features/a.feature", "features/b.feature"];
  assert.deepEqual(await restoreLock(dir, lock, files), files);
  git("commit", "-q", "-m", "restore");
  assert.equal(await matchesLock(dir, lock, files), true);
  assert.equal(readFileSync(join(dir, "app.txt"), "utf8"), "kept\n");
});

test("restoring a lock that holds restores nothing and stages nothing", async (t) => {
  const { dir, git, lockSha } = repoWithLockedFile();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(await restoreLock(dir, lockSha, ["features/a.feature"]), []);
  assert.equal(git("status", "--porcelain"), "");
});
