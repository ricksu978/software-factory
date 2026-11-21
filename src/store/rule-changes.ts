// What the readiness check read from an item's "## Changes the factory's rules" section (PBI 395).
import type pg from "pg";

/** Where a rule lives: a section of the factory's spec, such as "§6", or one of its policy files, such as "policy/dor.md". */
export type RulePlace = { kind: "spec"; section: string } | { kind: "policy"; path: string };

/** One rule the item changes: its place, its current text quoted as Before, and its text once the item ships as After. Null when the entry gives none. */
export type RuleChange = { place: RulePlace; before: string | null; after: string | null };

/**
 * The rule changes the item's last readiness check read from its "## Changes the factory's rules" section, in the
 * section's order: an empty list when the item has no such section, and null when no readiness check has read the
 * item since the factory began reading the section.
 */
export async function ruleChangesRead(_pool: pg.Pool, _itemId: string): Promise<RuleChange[] | null> {
  return null;
}
