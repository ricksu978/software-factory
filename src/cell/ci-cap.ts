// PBI 234: the cap on how long the cell waits for CI on any one commit.
import type { CellApi } from "./api-client.ts";

/** How long the cell waits for CI that stays pending on one commit before it asks a person. */
export const PENDING_CI_CAP_MS = 60 * 60_000;

/**
 * Called each time CI answers pending on `sha`, `waitedMs` after the cell began waiting on that commit. Returns null
 * while the cell should go on waiting, and once CI has been pending for PENDING_CI_CAP_MS, the question for
 * NeedsInput, naming each check still pending (from the cell API's `pendingChecks`) and none that already finished.
 * Pending CI isn't failed CI, so the engine moves the item to NeedsInput rather than back to Green.
 */
export async function pendingCiQuestion(api: CellApi, sha: string, waitedMs: number): Promise<string | null> {
  if (waitedMs < PENDING_CI_CAP_MS) return null;
  const pending = (await api.pendingChecks?.(sha)) ?? [];
  const minutes = PENDING_CI_CAP_MS / 60_000;
  const which = pending.length === 0 ? "No check named itself as pending"
    : `${pending.length === 1 ? "This check is" : "These checks are"} still pending: ${pending.map((n) => `"${n}"`).join(", ")}`;
  return `CI on ${sha} stayed pending for ${minutes} minutes, so the cell stopped waiting. ${which}. `
    + "Look at why the check hasn't reported, then rerun it or answer how the run should go on.";
}
