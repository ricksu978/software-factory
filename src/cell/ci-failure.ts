// PBI 292: a CI failure on a commit one of the run's stages pushed. Spec §6 rows 7 and 8 send it back to Green, with
// each failed check, its URL and the tests it names as failing, and the Floor and the item's page show the item as
// fixing CI while Green works on it. When Green leaves the commit unchanged, CI has nothing new to judge, so the
// factory gives up and asks a person the question built here. A failure whose tests the base fails too stays the base's (PBI 215).
import type { CiCheck } from "../adapters/types.ts";
import { ciSharedWithBase, testsOf, type CiFailure } from "../core/ci-findings.ts";
import type { BaseLine } from "./base-run.ts";

export { ciFailureOf, ciFindings } from "../core/ci-findings.ts";
export type { CiFailure };

const short = (sha: string) => sha.slice(0, 7);

/**
 * The failed checks, as lines for the base question, when the base is at fault: every failed check names failing tests,
 * and the base's failed checks fail each of them too. Null when any of it fails only on the item, so the item fixes it.
 */
export function sharedCiLines(f: CiFailure, onBase: CiCheck[] | null): BaseLine[] | null {
  if (!ciSharedWithBase(f, onBase)) return null;
  return f.checks.map((c) => ({ criterion: c.name, tests: c.failingTests, check: { name: c.name, url: c.url } }));
}

/**
 * The question the factory asks when it gives up on a CI failure, because Green left the commit CI failed on unchanged:
 * what Green tried, on which commits, and each check that failed on the last commit, with its URL and failing tests.
 * `failures` holds every CI failure Green was sent back to fix in this cell, oldest first.
 */
export function ciQuestion(failures: CiFailure[]): string {
  const last = failures.at(-1)!;
  const n = failures.length;
  const commits = failures.map((f) => short(f.sha)).join(n === 2 ? " and " : ", ");
  const checks = last.checks.length
    ? last.checks.map((c) => `- \`${c.name}\`: ${c.url}. ${testsOf(c)}`).join("\n")
    : "- CI named no failed check the factory could read.";
  return [
    `CI failed on the factory's own commit ${short(last.sha)}, and the factory gave up fixing it.`,
    `Green tried to fix the CI failure ${n} time${n === 1 ? "" : "s"}, on the commit${n === 1 ? "" : "s"} ${commits} that CI failed on.`,
    `Green's last attempt left ${short(last.sha)} unchanged, so CI has nothing new to judge.`,
    `The checks that failed on ${short(last.sha)}:\n${checks}`,
    "Fix the cause on the branch, or say what the factory should do, then answer this question, and Green runs again.",
  ].join("\n\n");
}
