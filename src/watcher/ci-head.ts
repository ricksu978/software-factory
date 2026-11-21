// PBI 235: CI on the head of an InReview item's PR. When it has failed there, the poller and a `checks_completed`
// webhook delivery send the item back to address, with the failure detail as its findings. Only the PR's head counts:
// a failure on an older commit of the PR, or on any commit that isn't the head when the factory reads it, is ignored.
import type pg from "pg";
import { githubFailed } from "../adapters/github/errors.ts";
import type { ChangeCause, CiCheck, RepoHost } from "../adapters/types.ts";
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
 * With `reruns`, the failed checks are re-run once first, and only a check still red after its re-run counts.
 */
export async function headCiFailure(
  host: RepoHost, repo: string, prNumber: number, at: { sha?: string; head?: string | null } = {}, reruns?: RerunLedger,
): Promise<CiFailure | null> {
  const head = at.head !== undefined ? at.head : (await host.mergeView(repo, prNumber)).headSha;
  if (!head || (at.sha !== undefined && at.sha !== head)) return null;
  if ((await host.checksOnSha(repo, head)) !== "failure") return null;
  const checks = reruns ? await afterRerun(host, repo, head, reruns, await host.ciChecksOnSha(repo, head)) : await host.ciChecksOnSha(repo, head);
  if (checks === WAIT) return null;
  const f = ciFailureOf(head, checks);
  if (!f.checks.length) return null;
  // The base is only read for a failure every check of which names its tests, since only then can the base share it.
  // A base that can't be read leaves the failure the item's, as the cell charges it.
  if (f.checks.every((c) => c.failingTests.length)) {
    const base = await host.defaultBranchSha(repo).catch(() => null);
    if (base && base !== head && ciSharedWithBase(f, await host.ciChecksOnSha(repo, base).catch(() => null))) return null;
  }
  return f;
}

/**
 * PBI 233's one re-run of a commit's failed checks, by the item's run and the sha, as `ci_rerun` holds it. The cell's
 * `POST rerun-checks` and the watcher share the record, so a commit's checks are re-run once at most, whichever asks.
 */
export interface RerunLedger {
  /** The re-run recorded for `sha`, or null when its checks were never re-run. */
  get(sha: string): Promise<{ checks: string[]; requestedAt: Date } | null>;
  /** Records the re-run, and answers false when another path recorded one first. */
  claim(sha: string, checks: string[], requestedAt: Date): Promise<boolean>;
  /** Keeps only the checks the host did re-run, or drops the record when it re-ran none. */
  settle(sha: string, checks: string[]): Promise<void>;
}

/** The ledger of the run's re-runs in `ci_rerun`. */
export function rerunLedger(pool: pg.Pool, runId: string): RerunLedger {
  return {
    async get(sha) {
      const r = (await pool.query<{ checks: string[]; requested_at: Date }>("select checks, requested_at from ci_rerun where run_id = $1 and sha = $2", [runId, sha])).rows[0];
      return r ? { checks: r.checks, requestedAt: r.requested_at } : null;
    },
    async claim(sha, checks, requestedAt) {
      const r = await pool.query("insert into ci_rerun (run_id, sha, checks, requested_at) values ($1, $2, $3, $4) on conflict (run_id, sha) do nothing", [runId, sha, checks, requestedAt]);
      return r.rowCount === 1;
    },
    async settle(sha, checks) {
      if (checks.length) await pool.query("update ci_rerun set checks = $3 where run_id = $1 and sha = $2", [runId, sha, checks]);
      else await pool.query("delete from ci_rerun where run_id = $1 and sha = $2", [runId, sha]);
    },
  };
}

const WAIT = Symbol("wait for the re-run");

/**
 * PBI 233 for the watcher: a failed head's failed checks are re-run once before the item goes back to address, so a
 * flaky check doesn't cost a claim, a base merge and a PR review round. Answers the checks to judge, or WAIT while
 * the re-run hasn't shown. A re-run check shows its re-run once it has finished after the re-run was asked for. GitHub
 * may still report the old failed run right after the ask, so the ask's time is kept no earlier than the old runs'
 * finish, whatever the two clocks say. A check with no finish time can't be told apart, so it's taken as it reads, as
 * the cell takes it. A check the host refused to re-run, or one a host that can't re-run reports, stands as it failed.
 * GitHub failing to answer the ask throws, and the next poll asks again.
 */
async function afterRerun(host: RepoHost, repo: string, sha: string, reruns: RerunLedger, checks: CiCheck[] | null): Promise<CiCheck[] | null | typeof WAIT> {
  if (!checks || !host.rerunChecksOnSha) return checks;
  let done = await reruns.get(sha);
  if (!done) {
    // GitHub won't re-run a job until its workflow run has finished, and a check that fails later needs its re-run too.
    if (checks.some((c) => c.conclusion === "pending")) return WAIT;
    const failed = checks.filter((c) => c.conclusion === "failure").map((c) => c.name);
    if (!failed.length) return checks;
    const finished = Math.max(0, ...checks.filter((c) => failed.includes(c.name) && c.completedAt).map((c) => Date.parse(c.completedAt!) + 1));
    const requestedAt = new Date(Math.max(Date.now(), finished));
    if (await reruns.claim(sha, failed, requestedAt)) {
      let rerun: string[] = [];
      try {
        rerun = (await host.rerunChecksOnSha(repo, sha, failed)).rerun;
      } catch (e) {
        await reruns.settle(sha, []);
        if (githubFailed(e)) throw e;
        console.error(`re-running ${failed.join(", ")} on ${sha} failed, so the red CI stands:`, e);
      }
      if (!rerun.length) return checks;
      await reruns.settle(sha, rerun);
      checks = await host.ciChecksOnSha(repo, sha);
      if (!checks) return checks;
    }
    done = await reruns.get(sha);
    if (!done) return checks;
  }
  const at = done.requestedAt.getTime(), rerun = done.checks;
  const stale = checks.some((c) => rerun.includes(c.name)
    && (c.conclusion === "pending" || (!!c.completedAt && Date.parse(c.completedAt) <= at)));
  return stale ? WAIT : checks;
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
