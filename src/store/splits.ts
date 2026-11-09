// The split the factory files for an item (PBI 144), kept before any child is filed so a restart finishes the same one.
import type pg from "pg";
import type { SplitChild } from "../gate/split.ts";

/** The split kept for the item's text, or null when none is. */
export async function keptSplit(c: pg.Pool | pg.PoolClient, itemId: string, textHash: string): Promise<SplitChild[] | null> {
  const r = await c.query<{ children: SplitChild[] }>("select children from item_split where item_id = $1 and text_hash = $2", [itemId, textHash]);
  return r.rows[0]?.children ?? null;
}

/**
 * Keeps `children` as the item's split for this text, unless one is kept already, and returns the kept split. A split
 * once kept is never replaced, so every filing of this text, before and after a restart, files the same children.
 */
export async function keepSplit(c: pg.Pool | pg.PoolClient, itemId: string, textHash: string, children: SplitChild[]): Promise<SplitChild[]> {
  await c.query("insert into item_split (item_id, text_hash, children) values ($1, $2, $3) on conflict do nothing",
    [itemId, textHash, JSON.stringify(children)]);
  return (await keptSplit(c, itemId, textHash))!;
}
