// PBI 255: what the factory reads from CI when a merge commit fails on main. It compares the commit's checks with its
// first parent's, to tell a merge that broke main from one merged onto a main already red, reads the failing tests out
// of a failed check's log, and writes the bug item it files for a break.
import type { CheckRun } from "../adapters/types.ts";

/** A failed check as a break records it in main_break.failed_checks: its name, its page and the tests its log names. */
export type FailedCheck = { name: string; url: string; tests: string[] };

/**
 * What CI on a red merge commit says against its first parent. `broke`: at least one check failed that the first parent
 * passed or never ran. `already red`: the first parent failed every check that failed. `undecided`: a failed check is
 * still running on the first parent. `no checks`: no check run failed, so there is nothing to compare, as with a CI
 * that reports only commit statuses.
 */
export type Comparison = { verdict: "broke" | "already red" | "undecided" | "no checks"; failed: CheckRun[] };

export function compareWithParent(merge: CheckRun[], parent: CheckRun[]): Comparison {
  const failed = merge.filter((r) => r.status === "failure");
  if (failed.length === 0) return { verdict: "no checks", failed };
  const onParent = new Map(parent.map((r) => [r.name, r.status]));
  if (failed.some((r) => (onParent.get(r.name) ?? "success") === "success")) return { verdict: "broke", failed };
  if (failed.some((r) => onParent.get(r.name) === "pending")) return { verdict: "undecided", failed };
  return { verdict: "already red", failed };
}

// A TAP result line, as node's test runner prints it, after any timestamp GitHub Actions puts in front of each log line.
const TAP_LINE = /^(?:\d{4}-\d\d-\d\dT[\d:.]+Z )?(\s*)(not ok|ok) \d+(?: - (.*))?$/;

/**
 * The failing tests a check's log names: each `not ok` line of TAP, once each, in order. A failing suite is left out
 * when a test inside it failed, so only the leaf is named, and a TODO doesn't count. A log with no TAP names none.
 */
export function failingTests(log: string | null): string[] {
  const results: { indent: number; failed: boolean; name: string }[] = [];
  for (const line of (log ?? "").split(/\r?\n/)) {
    const m = TAP_LINE.exec(line);
    if (!m || /\s#\s*TODO\b/i.test(m[3] ?? "")) continue;
    results.push({ indent: m[1].length, failed: m[2] === "not ok", name: (m[3] ?? "").replace(/\s+#\s*SKIP\b.*$/i, "").trim() });
  }
  const names: string[] = [];
  results.forEach((r, i) => {
    if (!r.failed || !r.name) return;
    // A suite's own line comes after its tests' lines, which are indented deeper.
    for (let k = i - 1; k >= 0 && results[k].indent > r.indent; k--) if (results[k].failed) return;
    if (!names.includes(r.name)) names.push(r.name);
  });
  return names;
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
