import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { readCellImage } from "../store/cell-image.ts";
import { dbTest, startTestDb } from "../store/test-db.ts";
import { BUILD_FAILED_EVENT, needsNoRestart, pollCellImage, REBUILT_EVENT, REVISION_LABEL, startCellImage, type CellImageDeps } from "./cell-image.ts";

// PBI 210.
describe("which changes need no restart", () => {
  test("cell-side files and files no process runs need none", () => {
    for (const p of ["sop/sop.yml", "policy/dor.md", "cell/Dockerfile", "src/cell/engine.ts", "docs/x.html", "features/a.feature", "README.md", "src/scheduler/scheduler.test.ts"]) {
      assert.equal(needsNoRestart(p), true, p);
    }
  });
  test("code the control plane or the worker runs, shared code included, needs one", () => {
    for (const p of ["src/scheduler/scheduler.ts", "src/worker/main.ts", "src/control/cell-api.ts", "src/core/states.ts", "package.json", "db/migrations/012_cell_image.sql", "src/cellar.ts"]) {
      assert.equal(needsNoRestart(p), false, p);
    }
  });
});

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();

describe("keeping the cell image current with main", dbTest, () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let root: string;
  let seed: string;
  let checkout: string;
  let built: { context: string; labels: Record<string, string>; sop: string }[];
  let fail: string | null;
  before(async () => {
    db = await startTestDb();
  });
  after(async () => {
    await db.stop();
  });
  beforeEach(async () => {
    await db.pool.query("delete from cell_image");
    root = mkdtempSync(join(tmpdir(), "cell-image-test-"));
    seed = join(root, "seed");
    checkout = join(root, "checkout");
    git(root, "init", "-q", "--bare", "-b", "main", "origin.git");
    git(root, "init", "-q", "-b", "main", seed);
    push(["sop/sop.yml", "src/worker/main.ts"]);
    git(seed, "remote", "add", "origin", join(root, "origin.git"));
    git(seed, "push", "-q", "origin", "main");
    git(root, "clone", "-q", join(root, "origin.git"), checkout);
    built = [];
    fail = null;
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** Commits a change to each of `paths` on main and pushes it, returning the commit. */
  function push(paths: string[]): string {
    for (const p of paths) {
      mkdirSync(dirname(join(seed, p)), { recursive: true });
      writeFileSync(join(seed, p), `${Math.random()}\n`);
    }
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "change");
    if (git(seed, "remote")) git(seed, "push", "-q", "origin", "main");
    return git(seed, "rev-parse", "HEAD");
  }

  const deps = (): CellImageDeps => ({
    pool: db.pool, checkout, log: { log: () => {}, error: () => {} },
    builder: {
      async build({ context, labels }) {
        if (fail) throw new Error(fail);
        built.push({ context, labels, sop: readFileSync(join(context, "sop/sop.yml"), "utf8") });
      },
    },
  });
  const events = async (kind: string) => (await db.pool.query("select payload from event where kind = $1 order by at", [kind])).rows.map((r) => r.payload);

  test("builds main's commit at start, from its files, and asks for no restart", async () => {
    await db.pool.query("delete from event where kind in ($1, $2)", [REBUILT_EVENT, BUILD_FAILED_EVENT]);
    const head = git(seed, "rev-parse", "HEAD");
    await startCellImage(deps());
    assert.equal(built.length, 1);
    assert.equal(built[0].labels[REVISION_LABEL], head);
    assert.equal(built[0].sop, git(seed, "show", `${head}:sop/sop.yml`) + "\n");
    assert.deepEqual(await readCellImage(db.pool), { started: head, built: head, restart: null });
    assert.deepEqual(await events(REBUILT_EVENT), []);
  });

  test("a poll rebuilds a cell-side change and logs the old and the new commit", async () => {
    await db.pool.query("delete from event where kind = $1", [REBUILT_EVENT]);
    const start = git(seed, "rev-parse", "HEAD");
    await startCellImage(deps());
    const next = push(["sop/sop.yml"]);
    await pollCellImage(deps());
    assert.equal(built.at(-1)?.labels[REVISION_LABEL], next);
    assert.deepEqual(await events(REBUILT_EVENT), [{ from: start, to: next }]);
    await pollCellImage(deps());
    assert.equal(built.length, 2, "an unchanged main builds nothing");
  });

  test("a change to worker code holds the rebuild until a restart, even after a later cell-side commit", async () => {
    const start = git(seed, "rev-parse", "HEAD");
    await startCellImage(deps());
    push(["src/worker/main.ts"]);
    const newest = push(["sop/sop.yml"]);
    await pollCellImage(deps());
    assert.equal(built.length, 1);
    assert.deepEqual(await readCellImage(db.pool), { started: start, built: start, restart: newest });
    // A worker restarted without a pull still runs the old commit, so it builds nothing and still asks for a restart.
    await startCellImage(deps());
    assert.equal(built.length, 1);
    assert.deepEqual(await readCellImage(db.pool), { started: start, built: start, restart: newest });
    // A restart that pulls main runs main's commit, so it builds it and asks for no restart.
    git(checkout, "pull", "-q", "--ff-only");
    await startCellImage(deps());
    assert.deepEqual(await readCellImage(db.pool), { started: newest, built: newest, restart: null });
  });

  test("a worker that starts behind main records the commit it runs, and builds main when main changes only cell-side files", async () => {
    const running = git(seed, "rev-parse", "HEAD");
    const next = push(["sop/sop.yml"]);
    await startCellImage(deps());
    assert.deepEqual(await readCellImage(db.pool), { started: running, built: next, restart: null });
    const worker = push(["src/core/states.ts"]);
    await pollCellImage(deps());
    assert.equal(built.length, 1);
    assert.deepEqual(await readCellImage(db.pool), { started: running, built: next, restart: worker });
  });

  test("a worker that starts behind a main that changes worker code builds nothing and asks for a restart", async () => {
    const running = git(seed, "rev-parse", "HEAD");
    const worker = push(["src/worker/main.ts"]);
    await startCellImage(deps());
    assert.equal(built.length, 0);
    assert.deepEqual(await readCellImage(db.pool), { started: running, built: null, restart: worker });
  });

  test("moving worker code into cell/ holds the rebuild until a restart", async () => {
    const start = git(seed, "rev-parse", "HEAD");
    await startCellImage(deps());
    mkdirSync(join(seed, "cell"), { recursive: true });
    git(seed, "mv", "src/worker/main.ts", "cell/main.ts");
    git(seed, "commit", "-q", "-m", "move");
    git(seed, "push", "-q", "origin", "main");
    const moved = git(seed, "rev-parse", "HEAD");
    assert.equal(git(seed, "diff", "--name-only", start, moved), "cell/main.ts", "git follows the rename by default");
    await pollCellImage(deps());
    assert.equal(built.length, 1, "nothing is rebuilt");
    assert.deepEqual(await readCellImage(db.pool), { started: start, built: start, restart: moved });
  });

  test("a failed build keeps the built commit, logs the error and is tried again", async () => {
    await db.pool.query("delete from event where kind = $1", [BUILD_FAILED_EVENT]);
    const start = git(seed, "rev-parse", "HEAD");
    await startCellImage(deps());
    const next = push(["policy/dor.md"]);
    fail = "npm ci exited 1";
    await pollCellImage(deps());
    assert.equal((await readCellImage(db.pool))?.built, start);
    assert.deepEqual(await events(BUILD_FAILED_EVENT), [{ commit: next, error: "npm ci exited 1" }]);
    fail = null;
    await pollCellImage(deps());
    assert.equal((await readCellImage(db.pool))?.built, next);
  });

  test("leaves the checkout's edits, index and HEAD alone, and removes the build context", async () => {
    await startCellImage(deps());
    writeFileSync(join(checkout, "sop/sop.yml"), "an edit\n");
    const head = git(checkout, "rev-parse", "HEAD");
    const next = push(["sop/sop.yml"]);
    await pollCellImage(deps());
    assert.equal(built.at(-1)?.sop, git(seed, "show", `${next}:sop/sop.yml`) + "\n");
    assert.equal(readFileSync(join(checkout, "sop/sop.yml"), "utf8"), "an edit\n");
    assert.equal(git(checkout, "rev-parse", "HEAD"), head);
    assert.equal(git(checkout, "diff", "--cached", "--name-only"), "");
    assert.throws(() => readFileSync(join(built.at(-1)!.context, "sop/sop.yml")), "the build context is removed");
  });
});
