// PBI 369: the items the factory re-checks, those whose last move to Failed was `dod_failed`, and when each was last
// re-checked since. A re-check is an event of kind `recheck` on the item.
import type pg from "pg";

/** The time of each Failed item's last move to Failed, as `f.at`, joined only when that move was `dod_failed`. */
export const FAILED_ON_MAIN = `join lateral (select e.at, e.payload->>'event' as event from event e
  where e.item_id = i.id and e.kind in ('transition', 'override') and e.payload->>'to' = 'Failed'
  order by e.at desc, e.id desc limit 1) f on f.event = 'dod_failed'`;

/** When the item was last re-checked since it last failed, or null, as `rechecked`. */
export const LAST_RECHECK = "(select max(e.at) from event e where e.item_id = i.id and e.kind = 'recheck' and e.at >= f.at)";

/** `failed_at` is the item's last move to Failed (PBI 430). */
export type FailedOnMain = { id: string; external_id: string; title: string; failed_at: Date; rechecked: Date | null };

/** Every Failed item that failed its Definition of Done on main, with its last re-check, oldest failure first. Just `itemId`'s when given. */
export async function failedOnMain(pool: pg.Pool, itemId: string | null = null): Promise<FailedOnMain[]> {
  return (await pool.query<FailedOnMain>(
    `select i.id, i.external_id, i.title, f.at as failed_at, ${LAST_RECHECK} as rechecked
     from item i ${FAILED_ON_MAIN}
     where i.state = 'Failed' and ($1::uuid is null or i.id = $1) order by f.at, i.title`,
    [itemId],
  )).rows;
}
