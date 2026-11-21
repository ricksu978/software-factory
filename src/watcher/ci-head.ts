// PBI 235: CI on the head of an InReview item's PR. When it has failed there, the poller and a `checks_completed`
// webhook delivery send the item back to address, with the failure detail as its findings. Only the PR's head counts:
// a failure on an older commit of the PR, or on any commit that isn't the head when the factory reads it, is ignored.
import type pg from "pg";
import type { ChangeCause, RepoHost } from "../adapters/types.ts";
import { ciFailureOf, ciFindings, type CiFailure } from "../core/ci-findings.ts";
import { withTx } from "../store/db.ts";
import { IllegalTransition, transitionItem } from "../store/items.ts";

/**
 * The CI failure on the head of the PR, or null when CI still runs there, passed, or reported nothing. With `sha`, the
 * commit a delivery names, it's null too unless that commit is the head as the PR is read now. A failure that names no
 * failed check is null as well: address would get no failure detail to work from, so the item stays in review and a
 * failing required check only holds the merge (PBI 181).
 */
export async function headCiFailure(host: RepoHost, repo: string, prNumber: number, sha?: string): Promise<CiFailure | null> {
  const head = (await host.mergeView(repo, prNumber)).headSha;
  if (!head || (sha !== undefined && sha !== head)) return null;
  if ((await host.checksOnSha(repo, head)) !== "failure") return null;
  const f = ciFailureOf(head, await host.ciChecksOnSha(repo, head));
  return f.checks.length ? f : null;
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
