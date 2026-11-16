// The split the factory files for an item (PBI 144), kept before any child is filed so a restart finishes the same one,
// and the children it filed, read back to tell when a Split parent is done (PBI 226).
import type pg from "pg";
import type { ChildIssue } from "../gate/file-split.ts";
import type { SplitChild } from "../gate/split.ts";
import type { DoneChild } from "../gate/split-done.ts";

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

/** Every split kept for the item, newest first, each with the text hash it was kept for (PBI 226). */
export async function keptSplits(c: pg.Pool | pg.PoolClient, itemId: string): Promise<{ textHash: string; children: SplitChild[] }[]> {
  const r = await c.query<{ text_hash: string; children: SplitChild[] }>(
    "select text_hash, children from item_split where item_id = $1 order by created_at desc", [itemId]);
  return r.rows.map((x) => ({ textHash: x.text_hash, children: x.children }));
}

/**
 * The children the factory filed for a Split parent, in filing order, as its move to Split recorded them (PBI 226).
 * Null when that move recorded none, as a parent split before PBI 226 did: the poller then finds them by their split
 * markers (`filedFromMarkers`).
 */
export async function filedChildren(c: pg.Pool | pg.PoolClient, itemId: string): Promise<ChildIssue[] | null> {
  const r = await c.query<{ children: ChildIssue[] | null }>(
    `select payload->'children' as children from event
     where item_id = $1 and kind = 'transition' and payload->>'event' = 'split_filed' order by at desc, id desc limit 1`,
    [itemId],
  );
  const children = r.rows[0]?.children;
  return Array.isArray(children) && children.length > 0 ? children : null;
}

/**
 * Each filed child as a Done child with the PR that closed it, or null when any child isn't Done: one the factory
 * doesn't hold, because it never entered the factory or a person closed it first, counts as not Done (PBI 226). The
 * PR is the child's newest merged one, or else its newest one.
 */
export async function doneChildren(c: pg.Pool | pg.PoolClient, sourceId: string, children: ChildIssue[]): Promise<DoneChild[] | null> {
  const r = await c.query<{ external_id: string; state: string; pr_number: number | null; pr_url: string | null }>(
    `select i.external_id, i.state, r.pr_number, r.pr_url from item i
     left join lateral (
       select pr_number, pr_url from run where item_id = i.id and pr_number is not null
       order by (merge_sha is not null) desc, started_at desc limit 1
     ) r on true
     where i.source_id = $1 and i.external_id = any($2)`,
    [sourceId, children.map((ch) => ch.externalId)],
  );
  const held = new Map(r.rows.map((x) => [x.external_id, x]));
  const done: DoneChild[] = [];
  for (const ch of children) {
    const x = held.get(ch.externalId);
    if (x?.state !== "Done") return null;
    done.push({ title: ch.title, url: ch.url, prNumber: x.pr_number, prUrl: x.pr_url });
  }
  return done;
}
