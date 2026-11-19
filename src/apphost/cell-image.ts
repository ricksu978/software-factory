// The "cell-image" resource (PBI 206): the AppHost builds factory-cell:local from this checkout, with the checkout's
// cell/Dockerfile, as a resource of its own that the worker waits on. As `npm run factory` does, the image records
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

/** What the cell-image resource runs: builds factory-cell:local from the checkout. Throws CellImageFailed. */
export async function buildCellImage(_deps: CellImageDeps, _log: (line: string) => void): Promise<void> {
  throw new Error("buildCellImage isn't built yet (PBI 206)");
}
