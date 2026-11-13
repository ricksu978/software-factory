// PBI 173: a run pinned to an older SOP moves to the SOP in the cell image and carries on from its stage, instead of
// asking a question no answer can fix. The one run that can't move is one whose next stage the image's SOP lacks.
import type { Sop } from "../config/sop.ts";
import type { CellApi } from "./api-client.ts";
import type { CellContext } from "./engine.ts";

/** The kind of the system event that records a run's move from one SOP version to another, on the run's item. */
export const SOP_MOVED = "sop_moved";

/** What the cell needs from the cell API to move its run: a question when it can't, and the move when it can. */
export type SopMoveApi = Pick<CellApi, "transition"> & {
  /** Records the run's move to SOP `to` from SOP `from`, and logs it as a system event on the item. */
  moveSop(b: { from: string; to: string }): Promise<void>;
};

/**
 * Settles which SOP the run goes on with before any stage runs. A run pinned to the image's SOP goes on as it is. A run
 * pinned to another version moves to the image's SOP when that SOP has the run's next stage, and the context it gets
 * back carries the new version. A run whose next stage the image's SOP lacks asks for input, naming the stage, and gets
 * null, so no stage runs.
 *
 * The run keeps its config commit, its branch and the stage it was at; only the SOP it goes on with changes.
 */
export async function resumeOnImageSop(api: SopMoveApi, ctx: CellContext, sop: Sop): Promise<CellContext | null> {
  if (ctx.sopVersion === sop.version) return ctx;
  if (!sop.stages.some((s) => s.id === ctx.nextStage)) {
    const body = `This cell image has SOP ${sop.version}. The run is pinned to SOP ${ctx.sopVersion} and goes on at ${ctx.nextStage}, but SOP ${sop.version} has no ${ctx.nextStage} stage, so the run can't move to it.`;
    await api.transition({ event: "blocked", question: { kind: "needs_input", body } });
    return null;
  }
  await api.moveSop({ from: ctx.sopVersion, to: sop.version });
  return { ...ctx, sopVersion: sop.version };
}
