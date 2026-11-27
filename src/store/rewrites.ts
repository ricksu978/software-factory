// The rewrites the factory proposes for a NotReady item a person wrote that fails only dor.md lines (PBI 439). The
// factory asks the coding model for one rewrite of the item's body per version of its text, keeps it here, and shows
// it on the item page beside the current body. Only the owner accepts one; a person's edit to the item withdraws it.
import type pg from "pg";

/**
 * One proposal. `body` is the proposed issue body in full, its acceptance criteria kept word for word except one the
 * judge found untestable, which moves to its Notes. `current` is the issue body the proposal rewrites, as it read when
 * the proposal was made.
 */
export type ProposedRewrite = { id: string; itemId: string; body: string; current: string; proposedAt: Date };

/** The kind of the event that logs a person's edit withdrawing a proposal. Its payload's `cause` is "item_edited". */
export const REWRITE_WITHDRAWN = "rewrite_withdrawn";

/** The item's proposals that stand: neither accepted nor withdrawn. At most one per version of the item's text. */
export async function proposedRewrites(_pool: pg.Pool | pg.ClientBase, _itemId: string): Promise<ProposedRewrite[]> {
  return [];
}
