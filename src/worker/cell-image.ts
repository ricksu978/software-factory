// Keeps the cell image current with `main` while the factory runs (PBI 210). The worker builds `factory-cell:local` from
// `main`'s fetched commit as it starts, and each poll fetches `main` again. When `main`'s new commits change only
// cell-side files (sop/, policy/, cell/, src/cell/), it rebuilds the image from `main`'s newest commit. The control
// plane, the worker and any running cell carry on, and the next cell started runs the new image. When they also change
// code the control plane or the worker runs, it builds nothing, and Floor says a restart is needed and names the commit a
// restart would pick up. It builds from the fetched commit, never from the operator's checkout's working tree, branch or
// local commits. Each image records its commit in REVISION_LABEL. A rebuild logs REBUILT_EVENT, naming the old and the
// new commit. A failed build keeps the current image, logs BUILD_FAILED_EVENT and is tried again on a later poll.
import type pg from "pg";

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

/** Builds the cell image from `main`'s fetched commit as the worker starts, and records that commit as the last seen. */
export async function startCellImage(_d: CellImageDeps): Promise<void> {}

/** One poll: fetches `main`, then rebuilds the cell image, or holds the rebuild for a restart, as the header says. */
export async function pollCellImage(_d: CellImageDeps): Promise<void> {}
