import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { mainDefaults } from "./main-defaults.ts";

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
const write = (dir: string, path: string, text: string) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
};

// PBI 261.
describe("reading the default policies from main's fetched commit", () => {
  let root: string;
  let seed: string;
  let checkout: string;
  const push = (path: string, text: string) => {
    write(seed, path, text);
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", path);
    git(seed, "push", "-q", "origin", "main");
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "main-defaults-test-"));
    seed = join(root, "seed");
    checkout = join(root, "checkout");
    git(root, "init", "-q", "--bare", "-b", "main", "origin.git");
    git(root, "init", "-q", "-b", "main", seed);
    git(seed, "remote", "add", "origin", join(root, "origin.git"));
    push("policy/dor.md", "- [ ] Size is 5 or less\n");
    git(root, "clone", "-q", join(root, "origin.git"), checkout);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("reads a default from the fetched main, byte for byte", async () => {
    assert.equal(await mainDefaults({ checkout })("dor"), "- [ ] Size is 5 or less\n");
  });

  test("ignores an uncommitted edit in the checkout", async () => {
    write(checkout, "policy/dor.md", "- [ ] Size is 5 or less\n- [ ] Has a designer's sign-off\n");
    assert.equal(await mainDefaults({ checkout })("dor"), "- [ ] Size is 5 or less\n");
  });

  test("ignores a local commit in the checkout that isn't on main", async () => {
    write(checkout, "policy/dor.md", "- [ ] Local only\n");
    git(checkout, "commit", "-q", "-am", "local");
    assert.equal(await mainDefaults({ checkout })("dor"), "- [ ] Size is 5 or less\n");
  });

  test("reads a change merged to main once it's fetched, before the checkout pulls it", async () => {
    const read = mainDefaults({ checkout });
    push("policy/dor.md", "- [ ] Names the user it serves\n");
    assert.equal(await read("dor"), "- [ ] Size is 5 or less\n", "read before the fetch");
    git(checkout, "fetch", "-q", "origin", "+refs/heads/main:refs/remotes/origin/main");
    assert.equal(await read("dor"), "- [ ] Names the user it serves\n");
  });

  test("a pinned reader keeps reading the commit it pinned after a fetch moves main", async () => {
    push("policy/risk.md", "r\n");
    git(checkout, "fetch", "-q", "origin", "+refs/heads/main:refs/remotes/origin/main");
    const pinned = await mainDefaults({ checkout }).pin!();
    assert.equal(await pinned("dor"), "- [ ] Size is 5 or less\n");
    push("policy/dor.md", "- [ ] Names the user it serves\n");
    push("policy/risk.md", "r changed\n");
    git(checkout, "fetch", "-q", "origin", "+refs/heads/main:refs/remotes/origin/main");
    assert.equal(await pinned("risk"), "r\n", "the pinned commit, not the one fetched since");
    assert.equal(await (await mainDefaults({ checkout }).pin!())("risk"), "r changed\n", "a new pin sees the new commit");
  });

  test("pinning a ref that doesn't exist throws, naming the ref", async () => {
    await assert.rejects(mainDefaults({ checkout, branch: "nope" }).pin!(), /refs\/remotes\/origin\/nope/);
  });

  test("honours another remote and branch", async () => {
    git(checkout, "fetch", "-q", "origin", "+refs/heads/main:refs/remotes/up/trunk");
    push("policy/dor.md", "- [ ] Later\n");
    assert.equal(await mainDefaults({ checkout, remote: "up", branch: "trunk" })("dor"), "- [ ] Size is 5 or less\n");
  });

  test("a default main doesn't hold throws, naming the file and the ref", async () => {
    await assert.rejects(mainDefaults({ checkout })("risk"), /policy\/risk\.md.*refs\/remotes\/origin\/main/);
  });
});
