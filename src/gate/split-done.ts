// A Split parent moves to Done once every child the factory filed for it is Done (PBI 226). The factory comments on the
// parent with each child and the PR that closed it, under this heading, then closes the parent as completed.

/** The first line of the comment that tells a Split parent its children are all done. */
export const SPLIT_DONE_HEADING = "## Every child of this split is done";
