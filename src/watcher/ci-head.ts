// PBI 235: CI on the head of an InReview item's PR. When it has failed there, the poller and a `checks_completed`
// webhook delivery send the item back to address, with the failure detail as its findings. Only the PR's head counts:
// a failure on an older commit of the PR, or on any commit that isn't the head when the factory reads it, is ignored.
import type pg from "pg";
import type { ChangeCause, RepoHost } from "../adapters/types.ts";
import { ciFailureOf, ciFindings, ciSharedWithBase, type CiFailure } from "../core/ci-findings.ts";
import { withTx } from "../store/db.ts";
import { IllegalTransition, transitionItem } from "../store/items.ts";

/**
 * The CI failure on the head of the PR, or null when CI still runs there, passed, or reported nothing. With `at.sha`,
 * the commit a delivery names, it's null too unless that commit is the head as the PR is read now. With `at.head`, the
 * head the caller read the PR at, as the poller's `prState` gives it, the PR isn't read again. A failure that names no
 * failed check is null as well: address would get no failure detail to work from, so the item stays in review and a
 * failing required check only holds the merge (PBI 181). So is one whose failing tests the base commit fails too: the
 * base is at fault, not the item, as the cell finds it (PBI 215, PBI 292), and the failing check only holds the merge.
 */
export async function headCiFailure(
  host: RepoHost, repo: string, prNumber: number, at: { sha?: string; head?: string | null } = {},
): Promise<CiFailure | null> {
  const head = at.head !== undefined ? at.head : (await host.mergeView(repo, prNumber)).headSha;
  if (!head || (at.sha !== undefined && at.sha !== head)) return null;
  if ((await host.checksOnSha(repo, head)) !== "failure") return null;
  const f = ciFailureOf(head, await host.ciChecksOnSha(repo, head));
  if (!f.checks.length) return null;
  // The base is only read for a failure every check of which names its tests, since only then can the base share it.
  // A base that can't be read leaves the failure the item's, as the cell charges it.
  if (f.checks.every((c) => c.failingTests.length)) {
    const base = await host.defaultBranchSha(repo).catch(() => null);
    if (base && base !== head && ciSharedWithBase(f, await host.ciChecksOnSha(repo, base).catch(() => null))) return null;
  }
  return f;
}

/** What the `changes_requested` event holds for a CI failure: the failure as its cause, and the findings address gets. */
export function ciChangeDetail(f: CiFailure): { cause: Extract<ChangeCause, { kind: "ci_failed" }>; findings: string[] } {
  return { cause: { kind: "ci_failed", sha: f.sha, checks: f.checks }, findings: ciFindings(f) };
}

/**
 * Moves the InReview item to Queued with its run's next stage at address, naming the CI failure. An item another path
 * moved first, a review, a merge or an earlier poll or delivery of the same failure, is left alone. Returns whether it
 * moved the item.
 */
export async function sendBackForCi(
  pool: pg.Pool, item: { itemId: string; runId: string }, f: CiFailure, actor: { actor: "system"; actorId: string },
): Promise<boolean> {
  try {
    await withTx(pool, async (c) => {
      await transitionItem(c, item.itemId, "changes_requested", actor, ciChangeDetail(f));
      await c.query("update run set next_stage = 'address' where id = $1", [item.runId]);
    });
    return true;
  } catch (e) {
    if (e instanceof IllegalTransition) return false;
    throw e;
  }
}
