// The "cell-image" resource (PBI 206): the AppHost builds factory-cell:local from this checkout, with the checkout's
// cell/Dockerfile, as a resource of its own that the worker waits on. The image records
// the checkout's commit in its revision label only when the checkout has no uncommitted edits.
import type { GitResult } from "./start.ts";

export const CELL_IMAGE = "factory-cell:local";
export const CELL_IMAGE_RESOURCE = "cell-image";
export const CELL_DOCKERFILE = "cell/Dockerfile";
export const REVISION_LABEL = "org.opencontainers.image.revision";

/** One `docker build`. The paths are relative to the checkout. */
export type DockerBuild = { tag: string; dockerfile: string; context: string; labels: Record<string, string> };

export type CellImageDeps = {
  /** Runs git in the checkout with these arguments. */
  git(args: string[]): GitResult;
  /** Runs `docker build` in the checkout, passing each line of its output to `log`. Resolves to its exit status. */
  dockerBuild(build: DockerBuild, log: (line: string) => void): Promise<number>;
};

/** Thrown when the build fails. The resource shows as failed, with the build's output in its log. */
export class CellImageFailed extends Error {
  override name = "CellImageFailed";
}

/**
 * What the cell-image resource runs: builds factory-cell:local from the checkout as it is, with its cell/Dockerfile.
 * Labels the image with HEAD's commit only when `git status --porcelain` is empty, and labels nothing when git can't
 * say. Throws CellImageFailed when the build exits non-zero, with the build's own output already in `log`.
 */
export async function buildCellImage(deps: CellImageDeps, log: (line: string) => void): Promise<void> {
  const commit = cleanCommit(deps);
  log(commit
    ? `Building ${CELL_IMAGE} from commit ${commit}...`
    : `Building ${CELL_IMAGE} from the checkout as it is. It has uncommitted edits, or git couldn't say, so the image records no commit.`);
  const labels: Record<string, string> = commit ? { [REVISION_LABEL]: commit } : {};
  const exit = await deps.dockerBuild({ tag: CELL_IMAGE, dockerfile: CELL_DOCKERFILE, context: ".", labels }, log);
  if (exit !== 0) throw new CellImageFailed(`Building ${CELL_IMAGE} failed with exit code ${exit}. Docker's output above says why.`);
  log(`Built ${CELL_IMAGE}.`);
}

/** HEAD's commit when the checkout has no uncommitted edits, else null. */
function cleanCommit(deps: CellImageDeps): string | null {
  const status = deps.git(["status", "--porcelain"]);
  if (status.status !== 0 || status.stdout.trim()) return null;
  const head = deps.git(["rev-parse", "HEAD"]);
  const sha = head.stdout.trim();
  return head.status === 0 && sha ? sha : null;
}

/**
 * The cell-image resource's process under `aspire run` (cell-image-main.ts): builds the image, printing the build's
 * output to `out`, and returns the exit code. A failed build prints why to `err` and returns 1, so Aspire shows the
 * resource as failed, and the worker, which waits for it to complete with 0, never starts.
 */
export async function runCellImageResource(deps: CellImageDeps, out: (line: string) => void, err: (line: string) => void): Promise<number> {
  try {
    await buildCellImage(deps, out);
    return 0;
  } catch (e) {
    if (!(e instanceof CellImageFailed)) throw e;
    err(e.message);
    return 1;
  }
}
