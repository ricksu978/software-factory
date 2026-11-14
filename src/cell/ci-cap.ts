// PBI 234: the cap on how long the cell waits for CI on any one commit.
import type { CellApi } from "./api-client.ts";

/** How long the cell waits for CI that stays pending on one commit before it asks a person. */
export const PENDING_CI_CAP_MS = 60 * 60_000;

/**
 * Called each time CI answers pending on `sha`, `waitedMs` after the cell began waiting on that commit. Returns null
 * while the cell should go on waiting, and once CI has been pending for PENDING_CI_CAP_MS, the question for
 * NeedsInput, naming each check still pending (from the cell API's `pendingChecks`) and none that already finished.
 */
export async function pendingCiQuestion(_api: CellApi, _sha: string, _waitedMs: number): Promise<string | null> {
  throw new Error("not implemented: PBI 234 caps pending CI at 60 minutes");
}
