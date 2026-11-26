// PBI 234: the cap on how long the cell waits for CI on any one commit.
import { LeaseLost, type CellApi } from "./api-client.ts";

/** How long the cell waits for CI that stays pending on one commit before it asks a person. */
export const PENDING_CI_CAP_MS = 60 * 60_000;

/**
 * Called each time CI answers pending on `sha`, `waitedMs` after the cell began waiting on that commit. Returns null
 * while the cell should go on waiting, and once CI has been pending for PENDING_CI_CAP_MS, the question for
 * NeedsInput, naming each check still pending (from the cell API's `pendingChecks`) and none that already finished.
 * Pending CI isn't failed CI, so the engine moves the item to NeedsInput rather than back to Green. A `pendingChecks`
 * call that fails (an error, a rate limit, a PR that merged in the last poll) still gives the question, so a timeout is
 * a NeedsInput every time, but the question says the factory couldn't read which checks are pending rather than that
 * none is, and the error goes to the cell's log (not the question, which is posted on the item). Only LeaseLost goes
 * through, since a fenced cell must end its run.
 */
export async function pendingCiQuestion(api: CellApi, sha: string, waitedMs: number): Promise<string | null> {
  if (waitedMs < PENDING_CI_CAP_MS) return null;
  let pending: string[] | undefined;
  try {
    pending = await api.pendingChecks?.(sha);
  } catch (e) {
    if (e instanceof LeaseLost) throw e;
    console.error(`pendingChecks(${sha}) failed after CI stayed pending past the cap:`, e);
  }
  const minutes = PENDING_CI_CAP_MS / 60_000;
  const which = pending === undefined ? "The factory couldn't read which checks are pending"
    : pending.length === 0 ? "No check named itself as pending"
    : `${pending.length === 1 ? "This check is" : "These checks are"} still pending: ${pending.map((n) => `"${n}"`).join(", ")}`;
  return `CI on ${sha} stayed pending for ${minutes} minutes, so the cell stopped waiting. ${which}. `
    + "Look at why the check hasn't reported, then rerun it or answer how the run should go on.";
}

/**
 * PBI 423: called each time CI answers cancelled on `sha` while the run's branch still points at it, so no later push
 * cancelled the run: a person may have. A cancelled run neither failed nor passed, so the cell waits for a re-run or a
 * push under the same cap as pending CI, and then asks a person. Null while it should go on waiting.
 */
export function cancelledCiQuestion(sha: string, waitedMs: number): string | null {
  if (waitedMs < PENDING_CI_CAP_MS) return null;
  return `CI on ${sha} was cancelled, and nothing was pushed to the branch after it, so the cell stopped waiting after ${PENDING_CI_CAP_MS / 60_000} minutes. `
    + "A cancelled run neither failed nor passed. Rerun CI on the commit, or answer how the run should go on.";
}
