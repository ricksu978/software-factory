// PBI 292: the failure detail of CI on one commit, as Green gets it back to fix, and PBI 235: as address gets it when
// CI fails on the head of an InReview item's PR. The cell and the poller write the same findings from it.
import type { CiCheck } from "../adapters/types.ts";

/** A CI failure on a commit: each failed check, with its URL and the tests it names as failing. */
export type CiFailure = { sha: string; checks: { name: string; url: string; failingTests: string[] }[] };

const quoted = (tests: string[]) => tests.map((t) => `"${t}"`).join(", ");

/** The failed checks CI named on `sha`, each with its URL and failing tests. A check that passed or still runs isn't one. */
export function ciFailureOf(sha: string, checks: CiCheck[] | null): CiFailure {
  const failed = (checks ?? []).filter((c) => c.conclusion === "failure");
  return { sha, checks: failed.map((c) => ({ name: c.name, url: c.url, failingTests: [...(c.failingTests ?? [])] })) };
}

/** What a failed check says about its tests. */
export const testsOf = (c: CiFailure["checks"][number]) => c.failingTests.length
  ? `Failing tests: ${quoted(c.failingTests)}.`
  : `CI named no failing test for the check "${c.name}".`;

/**
 * The findings for a CI failure: one per failed check, each saying CI failed on the commit, with the check, its URL
 * and its failing tests. `what` says what the commit was, such as the PR addresser's fix.
 */
export function ciFindings(f: CiFailure, what?: string): string[] {
  const on = `CI failed on ${f.sha}${what ? `, ${what}` : ""}`;
  if (!f.checks.length) return [`${on}, and named no failed check the factory could read.`];
  return f.checks.map((c) => `${on}: the check "${c.name}" failed, ${c.url}. ${testsOf(c)}`);
}
