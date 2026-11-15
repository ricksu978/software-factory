// PBI 292: a CI failure on a commit one of the run's stages pushed. Spec §6 rows 7 and 8 send it back to Green, with
// each failed check, its URL and the tests it names as failing, and the Floor and the item's page show the item as
// fixing CI while Green works on it. When Green leaves the commit unchanged, or runs out of attempts, the factory gives
// up and asks a person the question built here. A failure whose tests the base fails too stays the base's (PBI 215).
import type { CiCheck } from "../adapters/types.ts";
import type { CiFailure } from "./api-client.ts";
import { sharedWithBase, type BaseLine } from "./base-run.ts";

export type { CiFailure };

const short = (sha: string) => sha.slice(0, 7);
const quoted = (tests: string[]) => tests.map((t) => `"${t}"`).join(", ");

/** The failed checks CI named on `sha`, each with its URL and failing tests. A check that passed or still runs isn't one. */
export function ciFailureOf(sha: string, checks: CiCheck[] | null): CiFailure {
  const failed = (checks ?? []).filter((c) => c.conclusion === "failure");
  return { sha, checks: failed.map((c) => ({ name: c.name, url: c.url, failingTests: [...(c.failingTests ?? [])] })) };
}

/** What a failed check says about its tests. */
const testsOf = (c: CiFailure["checks"][number]) => c.failingTests.length
  ? `Failing tests: ${quoted(c.failingTests)}.`
  : `CI named no failing test for the check "${c.name}".`;

/**
 * Green's findings for a CI failure: one per failed check, each saying CI failed on the commit, with the check, its URL
 * and its failing tests. `what` says what the commit was, such as the PR addresser's fix.
 */
export function ciFindings(f: CiFailure, what?: string): string[] {
  const on = `CI failed on ${f.sha}${what ? `, ${what}` : ""}`;
  if (!f.checks.length) return [`${on}, and named no failed check the factory could read.`];
  return f.checks.map((c) => `${on}: the check "${c.name}" failed, ${c.url}. ${testsOf(c)}`);
}

/**
 * The failed checks, as lines for the base question, when the base is at fault: every failed check names failing tests,
 * and the base's failed checks fail each of them too. Null when any of it fails only on the item, so the item fixes it.
 */
export function sharedCiLines(f: CiFailure, onBase: CiCheck[] | null): BaseLine[] | null {
  if (!f.checks.length || f.checks.some((c) => !c.failingTests.length)) return null;
  const baseTests = (onBase ?? []).filter((c) => c.conclusion === "failure").flatMap((c) => c.failingTests ?? []);
  if (!sharedWithBase(f.checks.flatMap((c) => c.failingTests), baseTests)) return null;
  return f.checks.map((c) => ({ criterion: c.name, tests: c.failingTests, check: { name: c.name, url: c.url } }));
}

/**
 * The question the factory asks when it gives up on a CI failure: what Green tried, on which commits, why it stopped,
 * and each check that failed on the last commit, with its URL and failing tests. `failures` holds every CI failure Green
 * was sent back to fix in this cell, oldest first.
 */
export function ciQuestion(failures: CiFailure[], why: { unchanged: true } | { attempts: number }): string {
  const last = failures.at(-1)!;
  const n = failures.length;
  const commits = failures.map((f) => short(f.sha)).join(n === 2 ? " and " : ", ");
  const checks = last.checks.length
    ? last.checks.map((c) => `- \`${c.name}\`: ${c.url}. ${testsOf(c)}`).join("\n")
    : "- CI named no failed check the factory could read.";
  return [
    `CI failed on the factory's own commit ${short(last.sha)}, and the factory gave up fixing it.`,
    `Green tried to fix the CI failure ${n} time${n === 1 ? "" : "s"}, on the commit${n === 1 ? "" : "s"} ${commits} that CI failed on.`,
    "unchanged" in why
      ? `Green's last attempt left ${short(last.sha)} unchanged, so CI has nothing new to judge.`
      : `Green has used all ${why.attempts} of its attempts in this run.`,
    `The checks that failed on ${short(last.sha)}:\n${checks}`,
    "Fix the cause on the branch, or say what the factory should do, then answer this question, and Green runs again.",
  ].join("\n\n");
}
