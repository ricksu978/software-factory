// Keeps the cell image current with `main` while the factory runs (PBI 210). The worker builds `factory-cell:local` from
// `main`'s fetched commit as it starts, unless `main` changes control plane or worker code compared with the checkout's
// HEAD, the commit those processes run. Each poll fetches `main` again. When `main`'s new commits change only
// cell-side files (sop/, policy/, cell/, src/cell/, but for SHARED_CELL_FILES), it rebuilds the image from `main`'s newest commit. The control
// plane, the worker and any running cell carry on, and the next cell started runs the new image. When they also change
// code the control plane or the worker runs, it builds nothing, and Floor says a restart is needed and names the commit a
// restart would pick up. It builds from the fetched commit, never from the operator's checkout's working tree, branch or
// local commits. Each image records its commit in REVISION_LABEL. A rebuild logs REBUILT_EVENT, naming the old and the
// new commit. A failed build keeps the current image, logs BUILD_FAILED_EVENT and is tried again on a later poll.
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type pg from "pg";
import { readCellImage, writeCellImage } from "../store/cell-image.ts";
import { appendEvent } from "../store/events.ts";

const run = promisify(execFile);

/** The tag cells run. The launcher's `docker run` resolves it as each cell starts, so a running cell keeps its image. */
export const CELL_IMAGE = "factory-cell:local";
/** The image label that records the commit an image was built from. */
export const REVISION_LABEL = "org.opencontainers.image.revision";
/** Logged on each rebuild, with `{ from, to }`: the commit the old image was built from and the new image's commit. */
export const REBUILT_EVENT = "cell_image_rebuilt";
/** Logged on each failed build, with `{ commit, error }`: the commit it tried to build and the build's error. */
export const BUILD_FAILED_EVENT = "cell_image_build_failed";

/** Builds an image tagged `tag` from the files in `context`, a directory holding one commit's files, with `labels`. */
export type ImageBuilder = { build(b: { tag: string; context: string; labels: Record<string, string> }): Promise<void> };

export type CellImageDeps = {
  pool: pg.Pool;
  /** The operator's checkout. `main` is fetched into it, and its working tree, branch and HEAD are never touched. */
  checkout: string;
  /** The remote `main` is fetched from. "origin" by default. */
  remote?: string;
  /** "main" by default. */
  branch?: string;
  builder: ImageBuilder;
  /** CELL_IMAGE by default. */
  tag?: string;
  log?: Pick<Console, "log" | "error">;
};

/** The files only a cell runs, apart from SHARED_CELL_FILES. A change to nothing else needs no restart, only a new cell image. */
export const CELL_SIDE = ["sop/", "policy/", "cell/", "src/cell/"];
/**
 * Files under a cell-side prefix that the control plane or the worker loads too: src/main.ts reads sop/default.yml for
 * stageAfter, the judge, the split and the sopVersion a run is stamped with, and src/control/cell-api.ts imports
 * src/cell/sop-move.ts. A change to one of them needs a restart.
 */
export const SHARED_CELL_FILES = ["sop/default.yml", "src/cell/sop-move.ts"];
/** Files neither the control plane nor the worker runs, nor a cell: docs, the factory's own scenarios and tests. */
const INERT = ["docs/", "features/", "reports/"];

/**
 * Whether a change to `path` leaves the control plane and the worker as they are. Cell-side files and files no process
 * runs do. Anything else, shared code such as src/core/ included, is code the control plane or the worker may run.
 */
export function needsNoRestart(path: string): boolean {
  if (SHARED_CELL_FILES.includes(path)) return false;
  if (CELL_SIDE.some((p) => path.startsWith(p)) || INERT.some((p) => path.startsWith(p))) return true;
  if (!path.includes("/") && path.endsWith(".md")) return true;
  return path.endsWith(".test.ts");
}

const git = async (cwd: string, args: string[], env?: NodeJS.ProcessEnv) =>
  (await run("git", args, { cwd, env: env && { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 })).stdout.trim();

/** Fetches `main` into the checkout's remote-tracking ref, leaving its working tree, index, branch and HEAD alone. */
async function fetchMain(d: CellImageDeps): Promise<string> {
  const remote = d.remote ?? "origin";
  const branch = d.branch ?? "main";
  const ref = `refs/remotes/${remote}/${branch}`;
  await git(d.checkout, ["fetch", "--quiet", "--no-tags", remote, `+refs/heads/${branch}:${ref}`]);
  return git(d.checkout, ["rev-parse", "--verify", `${ref}^{commit}`]);
}

const worker = { actor: "system", actorId: "worker", itemId: null } as const;

async function inTransaction(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<void>): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await fn(c);
    await c.query("commit");
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/**
 * Builds the image from `commit`'s files, written out of the checkout's object store into a temporary directory through
 * an index of its own, so neither the checkout's index nor its working tree is read or written. True when it built.
 * A success records `commit` as the built one, and logs REBUILT_EVENT when `announce` is set. A failure logs
 * BUILD_FAILED_EVENT and keeps the image there was.
 */
async function build(d: CellImageDeps, from: string | null, commit: string, announce: boolean): Promise<boolean> {
  const log = d.log ?? console;
  const dir = await mkdtemp(join(tmpdir(), "factory-cell-"));
  try {
    const context = join(dir, "context");
    const index = { GIT_INDEX_FILE: join(dir, "index") };
    await git(d.checkout, ["read-tree", commit], index);
    await git(d.checkout, ["checkout-index", "--all", "--force", `--prefix=${context.split("\\").join("/")}/`], index);
    await d.builder.build({ tag: d.tag ?? CELL_IMAGE, context, labels: { [REVISION_LABEL]: commit } });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log.error(`Building the cell image from ${commit} failed, so cells keep the image built from ${from ?? "an unknown commit"}. A later poll tries again:`, error);
    await inTransaction(d.pool, (c) => appendEvent(c, { ...worker, kind: BUILD_FAILED_EVENT, payload: { commit, error } }));
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  await inTransaction(d.pool, async (c) => {
    await writeCellImage(c, { built: commit });
    if (announce) await appendEvent(c, { ...worker, kind: REBUILT_EVENT, payload: { from, to: commit } });
  });
  log.log(`The cell image was built from ${commit}${from && from !== commit ? `, replacing the one built from ${from}` : ""}.`);
  return true;
}

/**
 * Lists the files that differ between `from` and `to` that the control plane or the worker runs. --no-renames lists both
 * paths of a rename, so moving worker code into cell/ still counts as a change to worker code.
 */
async function heldChanges(d: CellImageDeps, from: string, to: string): Promise<string[]> {
  if (from === to) return [];
  const changed = (await git(d.checkout, ["diff", "--name-only", "--no-renames", from, to])).split("\n").filter(Boolean);
  return changed.filter((p) => !needsNoRestart(p));
}

function askRestart(d: CellImageDeps, head: string, held: string[]): void {
  (d.log ?? console).log(`main is at ${head}, which changes code the control plane or the worker runs (${held.slice(0, 5).join(", ")}), so the cell image waits for a restart.`);
}

/**
 * Run as the worker starts. The control plane and the worker run the checkout's files, and `main` is only fetched, never
 * checked out, so the commit they run is the checkout's HEAD, which may be behind `main` (Aspire restarts a worker that
 * lost its lock without a pull) or hold local commits. That commit is recorded as the start commit. When `main` changes
 * nothing the control plane or the worker runs compared with it, the image is built from `main`'s commit and no restart
 * is asked for. Otherwise nothing is built, the image there was stays, and Floor asks for a restart that picks up `main`.
 */
export async function startCellImage(d: CellImageDeps): Promise<void> {
  const running = await git(d.checkout, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const head = await fetchMain(d);
  const held = await heldChanges(d, running, head);
  await writeCellImage(d.pool, { started: running, restart: held.length ? head : null });
  if (held.length) return askRestart(d, head, held);
  await build(d, (await readCellImage(d.pool))?.built ?? null, head, false);
}

/** One poll: fetches `main`, then rebuilds the cell image, or holds the rebuild for a restart, as the header says. */
export async function pollCellImage(d: CellImageDeps): Promise<void> {
  const head = await fetchMain(d);
  const s = await readCellImage(d.pool);
  if (!s) return startCellImage(d);
  // Measured from the commit the control plane and the worker run, so a cell-side commit after one that changes their
  // code still waits for the restart, and the restart picks up main's newest commit.
  const held = await heldChanges(d, s.started, head);
  if (held.length) {
    if (s.restart !== head) {
      await writeCellImage(d.pool, { restart: head });
      askRestart(d, head, held);
    }
    return;
  }
  if (s.restart !== null) await writeCellImage(d.pool, { restart: null });
  if (s.built !== head) await build(d, s.built, head, true);
}

/** Builds with the local Docker, from the commit's files, with the Dockerfile the commit holds. */
export function dockerBuilder(): ImageBuilder {
  return {
    async build({ tag, context, labels }) {
      const args = ["build", "--quiet", "-f", join(context, "cell", "Dockerfile"), "-t", tag];
      for (const [k, v] of Object.entries(labels)) args.push("--label", `${k}=${v}`);
      try {
        await run("docker", [...args, context], { maxBuffer: 64 * 1024 * 1024 });
      } catch (e) {
        const stderr = (e as { stderr?: string }).stderr?.trim();
        throw new Error(stderr ? stderr.split("\n").slice(-20).join("\n") : e instanceof Error ? e.message : String(e), { cause: e });
      }
    },
  };
}
