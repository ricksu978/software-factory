import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { shellGit } from "./git.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function commit(dir: string, path: string, text: string): string {
  writeFileSync(join(dir, path), text);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", path);
  return git(dir, "rev-parse", "HEAD");
}

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

/** An origin with main, a pusher clone on main and a work clone on a branch that changed a.txt. */
function repos() {
  const root = mkdtempSync(join(tmpdir(), "git-test-"));
  roots.push(root);
  const origin = join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  const pusher = join(root, "pusher");
  git(root, "clone", "-q", origin, pusher);
  for (const d of [pusher]) { git(d, "config", "user.email", "t@example.com"); git(d, "config", "user.name", "t"); }
  git(pusher, "checkout", "-q", "-b", "main");
  commit(pusher, "a.txt", "start\n");
  git(pusher, "push", "-q", "origin", "main");
  const work = join(root, "work");
  git(root, "clone", "-q", "-b", "main", origin, work);
  git(work, "config", "user.email", "t@example.com");
  git(work, "config", "user.name", "t");
  git(work, "checkout", "-q", "-b", "feature");
  commit(work, "a.txt", "branch\n");
  return { origin, pusher, work };
}

describe("shellGit", () => {
  test("fetchBase fetches the base and returns the commit it fetched", async () => {
    const { pusher, work } = repos();
    const b1 = commit(pusher, "b.txt", "base\n");
    git(pusher, "push", "-q", "origin", "main");
    assert.equal(await shellGit(work, "feature").fetchBase("main"), b1);
  });

  test("mergeAt merges the commit it's given without fetching, so a base that moved since isn't merged", async () => {
    const { pusher, work } = repos();
    const b1 = commit(pusher, "b.txt", "base\n");
    git(pusher, "push", "-q", "origin", "main");
    const g = shellGit(work, "feature");
    const at = await g.fetchBase("main");
    const b2 = commit(pusher, "a.txt", "base moved on\n");
    git(pusher, "push", "-q", "origin", "main");
    assert.deepEqual(await g.mergeAt("main", at), []);
    git(work, "merge-base", "--is-ancestor", b1, "HEAD");
    assert.throws(() => git(work, "merge-base", "--is-ancestor", b2, "HEAD"));
    assert.throws(() => git(work, "cat-file", "-e", b2), "the cell fetched the base again");
    assert.match(git(work, "log", "-1", "--format=%s"), /main/);
  });

  test("mergeAt returns the conflicting paths, and a merge left half done is still a conflict", async () => {
    const { pusher, work } = repos();
    commit(pusher, "a.txt", "base\n");
    git(pusher, "push", "-q", "origin", "main");
    const g = shellGit(work, "feature");
    const at = await g.fetchBase("main");
    assert.deepEqual(await g.mergeAt("main", at), ["a.txt"]);
    assert.deepEqual(await g.mergeAt("main", at), ["a.txt"]);
  });

  test("mergeAt finds nothing to merge once the commit is merged", async () => {
    const { pusher, work } = repos();
    commit(pusher, "b.txt", "base\n");
    git(pusher, "push", "-q", "origin", "main");
    const g = shellGit(work, "feature");
    const at = await g.fetchBase("main");
    assert.deepEqual(await g.mergeAt("main", at), []);
    const head = await g.head();
    assert.deepEqual(await g.mergeAt("main", at), []);
    assert.equal(await g.head(), head);
  });
});
