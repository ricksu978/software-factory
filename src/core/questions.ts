// Questions the factory itself asks and later reads back, so the cell and the poller name them the same way.

/**
 * The question an address run asks when it finds no trusted review text and no conflict to resolve (Issue #28 AC-3).
 * The poller answers it once the PR conflicts with its base or a newer trusted review asks for changes (PBI 305).
 */
export const NO_REVIEW_TEXT = "no trusted review text to address";

/**
 * Whether a question is the older "Address failed" one, asked before #292 sent a CI failure back to Green, and every
 * finding it names, one per line as "- <text>", is a CI failure: "CI failed on <commit>", perhaps followed by what the
 * commit was. The poller answers such a question itself (PBI 317). A question naming anything else waits for a person.
 */
export function onlyCiFailures(body: string): boolean {
  const [head, ...lines] = body.replace(/\r\n/g, "\n").trim().split("\n");
  if (head.trim() !== "Address failed:" || !lines.length) return false;
  return lines.every((l) => /^\s*- CI failed on [0-9A-Za-z]+(?=[,:.\s]|$)/.test(l));
}

/**
 * When #292 (PR #309) shipped and a CI failure began going back to Green. Address still asks the same "Address failed"
 * question when CI fails on its own fix on every retry, and that one must reach a person: the run's thread replies
 * were never posted, so only a rerun of address posts them. So the poller answers only a question asked before this
 * (PBI 317).
 */
export const CI_TO_GREEN_SINCE = new Date("2026-11-15T05:50:19Z");

/** Whether the poller answers this question itself, for Green: an older "Address failed" one naming only CI failures (PBI 317). */
export function olderCiFailedQuestion(body: string, askedAt: Date): boolean {
  return askedAt.getTime() < CI_TO_GREEN_SINCE.getTime() && onlyCiFailures(body);
}

/**
 * The factory's answer to an older "Address failed" question that names only CI failures (PBI 317). The cell reads it
 * back as its decision: a claim at green that carries it reads CI on the PR's head, and Green's findings are its failed checks.
 */
export const CI_BACK_TO_GREEN = "Address failed only on CI. Since #292 a CI failure goes back to Green, so the factory sends the item back to Green to fix the CI failure on the PR's head, merging the base first.";

/**
 * When #331 (PR #332) merged, and the check after a cell's `merge` pass stopped fetching the base again. Before it, a
 * base that moved while the merge agent worked blocked the item with "Merging <base> left conflicts in: ..." on files
 * the agent was never given, the same question an agent that left conflict markers asks. The poller answers such a
 * question asked before this, once: a re-run that truly can't resolve asks again, after this, and waits (PBI 338).
 */
// ponytail: a cell image still built from before #332 can block this way until the worker rebuilds it from main (PBI 210).
export const BASE_FETCHED_ONCE_SINCE = new Date("2026-11-19T12:38:57Z");

/** Whether the poller answers this question itself: a "left conflicts" one asked before #331 shipped (PBI 338). */
export function olderMergeConflictQuestion(body: string, askedAt: Date): boolean {
  return askedAt.getTime() < BASE_FETCHED_ONCE_SINCE.getTime() && /^Merging \S+ left conflicts in: /.test(body);
}

/** The factory's answer to an older "left conflicts" question (PBI 338). */
export const MERGE_AGAIN = "Before #331 a base that moved during the merge pass blocked the item on conflicts the agent was never given. The factory picks the item up again at its stage and merges the base first.";
