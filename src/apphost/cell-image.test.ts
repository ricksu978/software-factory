import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCellImage, CELL_IMAGE, CellImageFailed, REVISION_LABEL, runCellImageResource, type CellImageDeps, type DockerBuild } from "./cell-image.ts";
import type { GitResult } from "./start.ts";

/** A checkout at `head`, with `status` as `git status --porcelain` prints it, and a Docker that exits with `exit`. */
function fake(opts: { status?: GitResult; head?: GitResult; exit?: number; output?: string[] } = {}) {
  const builds: DockerBuild[] = [];
  const ok = (stdout: string): GitResult => ({ status: 0, stdout, stderr: "" });
  const deps: CellImageDeps = {
    git(args) {
      if (args[0] === "status") return opts.status ?? ok("");
      if (args[0] === "rev-parse") return opts.head ?? ok("abc123\n");
      throw new Error(`unexpected git ${args.join(" ")}`);
    },
    async dockerBuild(build, log) {
      builds.push(build);
      for (const l of opts.output ?? []) log(l);
      return opts.exit ?? 0;
    },
  };
  const log: string[] = [];
  return { deps, builds, log, run: () => buildCellImage(deps, (l) => void log.push(l)) };
}

test("a clean checkout builds factory-cell:local from the checkout with cell/Dockerfile, labelled with HEAD", async () => {
  const f = fake();
  await f.run();
  assert.deepEqual(f.builds, [{ tag: CELL_IMAGE, dockerfile: "cell/Dockerfile", context: ".", labels: { [REVISION_LABEL]: "abc123" } }]);
});

test("a checkout with uncommitted edits builds an image that records no commit", async () => {
  const f = fake({ status: { status: 0, stdout: " M sop/sop.yml\n", stderr: "" } });
  await f.run();
  assert.deepEqual(f.builds[0]?.labels, {});
  assert.ok(f.log.some((l) => /uncommitted edits/.test(l)), JSON.stringify(f.log));
});

test("when git can't say whether the checkout is clean, the image records no commit", async () => {
  const f = fake({ status: { status: 128, stdout: "", stderr: "fatal: not a git repository" } });
  await f.run();
  assert.deepEqual(f.builds[0]?.labels, {});
});

test("when git can't name HEAD, the image records no commit", async () => {
  const f = fake({ head: { status: 128, stdout: "", stderr: "fatal: bad HEAD" } });
  await f.run();
  assert.deepEqual(f.builds[0]?.labels, {});
});

test("the build's output goes to the log", async () => {
  const f = fake({ output: ["#1 [internal] load build definition"] });
  await f.run();
  assert.ok(f.log.includes("#1 [internal] load build definition"));
});

test("a build that exits non-zero throws CellImageFailed, naming its exit code", async () => {
  const f = fake({ exit: 1, output: ["ERROR: failed to solve"] });
  await assert.rejects(f.run(), (e: unknown) => e instanceof CellImageFailed && /factory-cell:local/.test(e.message) && /1/.test(e.message));
  assert.ok(f.log.includes("ERROR: failed to solve"));
});

test("the resource's process exits 0 once the build finishes, printing the build's output", async () => {
  const f = fake({ output: ["#1 done"] });
  const out: string[] = [];
  assert.equal(await runCellImageResource(f.deps, (l) => void out.push(l), () => assert.fail("printed an error")), 0);
  assert.ok(out.includes("#1 done"));
});

test("the resource's process exits 1 with the failure on stderr when the build fails", async () => {
  const f = fake({ exit: 2, output: ["ERROR: failed to solve"] });
  const out: string[] = [];
  const err: string[] = [];
  assert.equal(await runCellImageResource(f.deps, (l) => void out.push(l), (l) => void err.push(l)), 1);
  assert.ok(out.includes("ERROR: failed to solve"));
  assert.match(err.join("\n"), /factory-cell:local failed with exit code 2/);
});
