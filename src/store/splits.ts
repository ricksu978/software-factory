// The split the factory files for an item (PBI 144), kept before any child is filed so a restart finishes the same one.
import type pg from "pg";
import type { ChildIssue } from "../gate/file-split.ts";
import type { SplitChild } from "../gate/split.ts";
import type { ItemState } from "../core/states.ts";

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

/** A child a parent's split filed, with the state the factory holds it in, or null while it isn't in the factory. */
export type SplitChildView = ChildIssue & { state: ItemState | null };

/** Keeps the issues the parent's split filed, in order (PBI 227). A parent's children are kept once and never replaced. */
export async function keepSplitChildren(c: pg.Pool | pg.PoolClient, parentId: string, children: ChildIssue[]): Promise<void> {
  await c.query(
    `insert into split_child (parent_id, position, external_id, title, url)
     select $1, k.n, k.external_id, k.title, k.url from unnest($2::text[], $3::text[], $4::text[]) with ordinality as k(external_id, title, url, n)
     where not exists (select 1 from split_child where parent_id = $1)
     on conflict do nothing`,
    [parentId, children.map((k) => k.externalId), children.map((k) => k.title), children.map((k) => k.url)],
  );
}

/**
 * Each parent's filed children in the order of the split, by parent id, with each child's state when the factory
 * holds it on the parent's board. A parent with none filed has no entry.
 */
export async function splitChildren(c: pg.Pool | pg.PoolClient, parentIds: string[]): Promise<Map<string, SplitChildView[]>> {
  const out = new Map<string, SplitChildView[]>();
  if (!parentIds.length) return out;
  const r = await c.query<{ parent_id: string; external_id: string; title: string; url: string; state: ItemState | null }>(
    `select sc.parent_id, sc.external_id, sc.title, sc.url, ci.state from split_child sc
     join item p on p.id = sc.parent_id
     left join item ci on ci.source_id = p.source_id and ci.external_id = sc.external_id
     where sc.parent_id = any($1::uuid[]) order by sc.parent_id, sc.position`,
    [parentIds],
  );
  for (const k of r.rows) {
    const list = out.get(k.parent_id) ?? [];
    list.push({ externalId: k.external_id, title: k.title, url: k.url, state: k.state });
    out.set(k.parent_id, list);
  }
  return out;
}
