// Questions the factory itself asks and later reads back, so the cell and the poller name them the same way.

/**
 * The question an address run asks when it finds no trusted review text and no conflict to resolve (Issue #28 AC-3).
 * The poller answers it once the PR conflicts with its base or a newer trusted review asks for changes (PBI 305).
 */
export const NO_REVIEW_TEXT = "no trusted review text to address";
