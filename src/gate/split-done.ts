// A Split parent moves to Done once every child the factory filed for it is Done (PBI 226). The factory comments on the
// parent with each child and the PR that closed it, under this heading, then closes the parent as completed.

/** The first line of the comment that tells a Split parent its children are all done. */
export const SPLIT_DONE_HEADING = "## Every child of this split is done";

/** A Done child of a Split parent, with the PR that closed it, or none when its runs recorded no PR. */
export type DoneChild = { title: string; url: string; prNumber: number | null; prUrl: string | null };

/** The parent's one comment once its children are all Done: each child, in filing order, with the PR that closed it. */
export function splitDoneComment(children: DoneChild[]): string {
  const lines = children.map((c) => {
    const pr = c.prNumber === null ? "with no PR on record" : `closed by [PR #${c.prNumber}](${c.prUrl ?? ""})`;
    return `- [${c.title}](${c.url}), ${pr}`;
  });
  return `${SPLIT_DONE_HEADING}\n\n${lines.join("\n")}\n\nThe factory closes this item as completed.\n`;
}

/** The comment's dedupe key. A parent is split once, so its id alone keys it. */
export function splitDoneKey(parentExternalId: string): string {
  return `split-done:${parentExternalId}`;
}
