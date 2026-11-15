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
 * The factory's answer to an older "Address failed" question that names only CI failures (PBI 317). The cell reads it
 * back as its decision: a claim at green that carries it reads CI on the PR's head, and Green's findings are its failed checks.
 */
export const CI_BACK_TO_GREEN = "Address failed only on CI. Since #292 a CI failure goes back to Green, so the factory sends the item back to Green to fix the CI failure on the PR's head, merging the base first.";
