import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { gitNetworkFault, shellGit, type GitExec } from "./git.ts";
import { NetworkError } from "./retry.ts";

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

const failed = (stderr: string, code: number | null = 128, killed = false) =>
  Object.assign(new Error(`Command failed: git push\n${stderr}`), { code, killed, signal: killed ? "SIGTERM" : null, stderr, stdout: "" });

const NETWORK = [
  "fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com",
  "fatal: unable to access 'https://github.com/a/b.git/': Failed to connect to github.com port 443 after 3 ms: Couldn't connect to server",
  "error: RPC failed; curl 56 Recv failure: Connection reset by peer\nfatal: the remote end hung up unexpectedly",
  "fatal: unable to access 'https://github.com/a/b.git/': CONNECT tunnel failed, response 502",
  "error: RPC failed; HTTP 503 curl 22 The requested URL returned error: 503",
  "fatal: unable to access 'https://github.com/a/b.git/': The requested URL returned error: 504",
  "fatal: unable to access 'https://github.com/a/b.git/': Operation timed out after 300000 milliseconds",
];
const NOT = [
  " ! [rejected]        HEAD -> b (fetch first)\nerror: failed to push some refs",
  "fatal: unable to access 'https://github.com/a/b.git/': The requested URL returned error: 403",
  "fatal: couldn't find remote ref nope",
];

test("git failures on the network, a proxy 5xx or a timeout are network faults", () => {
  for (const s of NETWORK) assert.ok(gitNetworkFault(failed(s)), s);
  assert.ok(gitNetworkFault(failed("", null, true)), "killed by its time limit");
});

test("a rejected push, a 403 or a missing ref isn't", () => {
  for (const s of NOT) assert.ok(!gitNetworkFault(failed(s, s.includes("rejected") ? 1 : 128)), s);
  assert.ok(!gitNetworkFault(new Error("boom")));
});

function scripted(faults: (string | null)[]) {
  const runs: string[][] = [];
  const slept: number[] = [];
  const exec: GitExec = async (args) => {
    runs.push(args);
    if (args[0] === "push" || args[0] === "fetch") {
      const n = runs.filter((a) => a[0] === args[0]).length - 1;
      const f = faults[Math.min(n, faults.length - 1)];
      if (f) throw failed(f, f.includes("rejected") ? 1 : 128);
    }
    return { stdout: "", stderr: "" };
  };
  return { runs, slept, git: shellGit("/nowhere", "b", { exec, sleep: async (ms) => void slept.push(ms) }) };
}

test("a push that fails on the network is tried again and goes through", async () => {
  const s = scripted([NETWORK[2], null]);
  await s.git.push();
  assert.equal(s.runs.filter((a) => a[0] === "push").length, 2);
  assert.equal(s.slept.length, 1);
});

test("a fetch that fails on the network every time ends with NetworkError naming git fetch and the tries", async () => {
  const s = scripted([NETWORK[4]]);
  await assert.rejects(s.git.fetchBase("main"), (e: unknown) => e instanceof NetworkError && /^git fetch failed on a network or GitHub error after 5 tries/.test(e.message));
  assert.ok(s.slept.reduce((a, b) => a + b, 0) >= 120_000);
});

test("a push rejected after a network failure isn't tried again", async () => {
  const s = scripted([NETWORK[2], NOT[0]]);
  await assert.rejects(s.git.push(), (e: unknown) => !(e instanceof NetworkError) && /rejected/.test(String(e)));
  assert.equal(s.runs.filter((a) => a[0] === "push").length, 2);
});

test("a push whose fence aborts while it waits to retry stops there and pushes no more", async () => {
  const fence = new AbortController();
  const runs: string[][] = [];
  const exec: GitExec = async (args) => { runs.push(args); throw failed(NETWORK[2]); };
  const lost = new Error("lease lost");
  const git = shellGit("/nowhere", "b", { exec, sleep: async () => { fence.abort(lost); } });
  await assert.rejects(git.push({ signal: fence.signal }), (e: unknown) => e === lost);
  assert.equal(runs.length, 1);
});

test("a push in flight gets the fence's signal, and a try it kills isn't retried", async () => {
  const fence = new AbortController();
  const lost = new Error("lease lost");
  let n = 0;
  const exec: GitExec = (_args, opts) => new Promise((_r, reject) => {
    n++;
    assert.equal(opts.signal, fence.signal);
    opts.signal!.addEventListener("abort", () => reject(failed("", null, true)), { once: true });
    fence.abort(lost);
  });
  const git = shellGit("/nowhere", "b", { exec, sleep: async () => {} });
  await assert.rejects(git.push({ signal: fence.signal }), (e: unknown) => e === lost);
  assert.equal(n, 1);
});

test("a push checks the lease before each retry, and a lease check that fails pushes no more", async () => {
  const runs: string[][] = [];
  const exec: GitExec = async (args) => { runs.push(args); throw failed(NETWORK[2]); };
  const lost = new Error("409 lease lost");
  let checks = 0;
  const git = shellGit("/nowhere", "b", { exec, sleep: async () => {} });
  await assert.rejects(git.push({ beforeRetry: async () => { if (++checks === 2) throw lost; } }), (e: unknown) => e === lost);
  assert.equal(runs.length, 2);
  assert.equal(checks, 2);
});
