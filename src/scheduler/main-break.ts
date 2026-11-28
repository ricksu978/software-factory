// PBI 255: what the factory reads from CI when a merge commit fails on main. It compares the commit's checks with its
// first parent's, to tell a merge that broke main from one merged onto a main already red, and writes the bug item it
// files for a break. The failing tests a failed check's log names are read with core's failingTests (PBI 321).
import type { CheckRun } from "../adapters/types.ts";

/** A failed check as a break records it in main_break.failed_checks: its name, its page and the tests its log names. */
export type FailedCheck = { name: string; url: string; tests: string[] };

/**
 * What CI on a red merge commit says against its first parent. `broke`: at least one check failed that the first parent
 * passed or never ran. `already red`: the first parent failed every check that failed. `undecided`: a failed check is
 * still running on the first parent. `cancelled`: no check run failed and at least one was cancelled, as when a later
 * push to the branch cancelled it, so nothing failed to charge. `no checks`: no check run failed or was cancelled, so
 * there is nothing to compare, as with a CI that reports only commit statuses. A check cancelled on the first parent
 * counts as one that never ran there.
 */
export type Comparison = { verdict: "broke" | "already red" | "undecided" | "cancelled" | "no checks"; failed: CheckRun[] };

export function compareWithParent(merge: CheckRun[], parent: CheckRun[]): Comparison {
  const failed = merge.filter((r) => r.status === "failure");
  if (failed.length === 0) return { verdict: merge.some((r) => r.status === "cancelled") ? "cancelled" : "no checks", failed };
  const onParent = new Map(parent.filter((r) => r.status !== "cancelled").map((r) => [r.name, r.status]));
  if (failed.some((r) => (onParent.get(r.name) ?? "success") === "success")) return { verdict: "broke", failed };
  if (failed.some((r) => onParent.get(r.name) === "pending")) return { verdict: "undecided", failed };
  return { verdict: "already red", failed };
}

/** At most this many failing tests are listed for each check, so a log full of failures can't swamp the item. */
const TESTS_PER_CHECK = 20;

/**
 * The bug item the factory files when `sha` broke `branch`: it names the commit, the PR and item it came from, each
 * failed check with its URL on one line, and the failing tests the logs name. Its one acceptance criterion is a green
 * branch, so the item meets the Definition of Ready's need for one.
 */
export function bugItem(p: { sha: string; branch: string; prNumber: number | null; prUrl: string | null; itemExternalId: string; checks: FailedCheck[] }): { title: string; body: string } {
  const pr = p.prNumber === null ? "a PR" : `PR #${p.prNumber}${p.prUrl ? ` (${p.prUrl})` : ""}`;
  const tests = p.checks.flatMap((c) => [...c.tests.slice(0, TESTS_PER_CHECK), ...(c.tests.length > TESTS_PER_CHECK ? [`and ${c.tests.length - TESTS_PER_CHECK} more in ${c.name}`] : [])]);
  const body = [
    `CI failed on \`${p.branch}\` for the merge commit ${p.sha}, the merge of ${pr} for item #${p.itemExternalId}. At least one of the checks below passed on the commit's first parent, so this merge broke \`${p.branch}\`. The factory fixes it before it builds anything else.`,
    "",
    "## Acceptance criteria",
    "",
    `- CI passes every check on \`${p.branch}\` again, the checks below included.`,
    "",
    "## Failed checks",
    "",
    ...p.checks.map((c) => `- ${c.name}: ${c.url}`),
    "",
    ...(tests.length ? ["Failing tests the checks' logs name:", ...tests.map((t) => `- ${t}`)] : ["No check's log names a failing test."]),
  ].join("\n");
  return { title: `${p.branch} is red: commit ${p.sha.slice(0, 7)} broke it`, body };
}
