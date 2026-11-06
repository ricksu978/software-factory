import type pg from "pg";
import { next, type ItemEvent, type ItemState } from "../core/states.ts";
import { inTx, runAfterCommit } from "./db.ts";
import { appendEvent, type Actor } from "./events.ts";

export class IllegalTransition extends Error {
  override name = "IllegalTransition";
  constructor(from: ItemState, event: ItemEvent) {
    super(`no edge from ${from} on ${event}`);
  }
}

type Hook = (itemId: string, from: ItemState, to: ItemState, event: ItemEvent) => Promise<void>;
const hooks: Hook[] = [];

/** Registers a hook that runs after each committed transition, and returns the call that removes it. Board mirroring is one (Run contract 8). */
export function onTransition(hook: Hook): () => void {
  hooks.push(hook);
  return () => {
    const i = hooks.indexOf(hook);
    if (i !== -1) hooks.splice(i, 1);
  };
}

/**
 * Moves an item along one state-machine edge. It writes the state and its event on the caller's withTx
 * transaction, so both commit or neither does, and leaving InProgress fences the old cell (Run contract 2).
 * Outside withTx it refuses before any write: the row lock, the atomicity and the hooks all depend on it.
 * `detail` adds fields to the event's payload, such as the attempts behind retries_exhausted.
 */
export async function transitionItem(c: pg.PoolClient, itemId: string, event: ItemEvent, actor: Actor, detail: Record<string, unknown> = {}): Promise<ItemState> {
  if (!inTx(c)) throw new Error("transitionItem needs a client inside withTx");
  const r = await c.query<{ state: ItemState }>("select state from item where id = $1 for update", [itemId]);
  if (r.rowCount === 0) throw new Error(`no item ${itemId}`);
  const from = r.rows[0].state;
  const to = next(from, event);
  if (!to) throw new IllegalTransition(from, event);
  if (from === "InProgress") {
    await c.query("update item set state = $2, lease_generation = lease_generation + 1, lease_owner = null, lease_expires = null where id = $1", [itemId, to]);
  } else {
    await c.query("update item set state = $2 where id = $1", [itemId, to]);
  }
  await appendEvent(c, { ...actor, itemId, kind: "transition", payload: { ...detail, from, to, event } });
  for (const hook of hooks) runAfterCommit(c, () => hook(itemId, from, to, event));
  return to;
}

export const LEASE_RENEW_MS = 60_000;
export const LEASE_EXPIRY_MS = 300_000;

const system = (actorId: string): Actor => ({ actor: "system", actorId });

/**
 * Claims the next item for `owner` and leases it until now + LEASE_EXPIRY_MS. Answered SignOff and NeedsInput items
 * come before Queued ones, then highest priority, then lowest backlog rank. Held items and items with an open
 * dependency are skipped. SKIP LOCKED means two concurrent claims never get the same item, and a claim never waits.
 * The claim raises the generation by 1 (Run contract 2) and reuses the item's open run, or starts one at understand.
 */
// The claim order, shared by claimNext and Floor's "Next up", so the preview can't drift from what's claimed.
const CLAIMABLE = `from item i
     where not i.held and cardinality(i.blocked_by) = 0
       and (i.state = 'Queued'
         or (i.state in ('SignOff', 'NeedsInput')
           and exists (select from question q where q.item_id = i.id and q.answer is not null)
           and not exists (select from question q where q.item_id = i.id and q.answer is null and q.closed_at is null)))
     order by i.state = 'Queued', i.priority desc, i.backlog_rank asc nulls last, i.id`;

/** The first `limit` items claimNext would pick, in order, without claiming or locking anything. */
export async function nextUp(c: pg.Pool | pg.PoolClient, limit: number): Promise<{ id: string; title: string; state: ItemState }[]> {
  return (await c.query<{ id: string; title: string; state: ItemState }>(`select i.id, i.title, i.state ${CLAIMABLE} limit $1`, [limit])).rows;
}

export async function claimNext(c: pg.PoolClient, owner: string, now: Date): Promise<{ itemId: string; runId: string; generation: number } | null> {
  const pick = await c.query<{ id: string }>(`select i.id ${CLAIMABLE} limit 1 for update of i skip locked`);
  if (pick.rowCount === 0) return null;
  const itemId = pick.rows[0].id;
  await transitionItem(c, itemId, "claimed", system(owner));
  const lease = await c.query<{ lease_generation: number }>(
    "update item set lease_generation = lease_generation + 1, lease_owner = $2, lease_expires = $3 where id = $1 returning lease_generation",
    [itemId, owner, new Date(now.getTime() + LEASE_EXPIRY_MS)],
  );
  const open = await c.query<{ id: string; next_stage: string | null }>(
    "select id, next_stage from run where item_id = $1 and ended_at is null order by started_at desc limit 1",
    [itemId],
  );
  let runId: string;
  if (open.rowCount === 0) {
    const run = await c.query<{ id: string }>(
      `insert into run (item_id, run_number, next_stage)
       values ($1, (select coalesce(max(run_number), 0) + 1 from run where item_id = $1), 'understand') returning id`,
      [itemId],
    );
    runId = run.rows[0].id;
  } else {
    runId = open.rows[0].id;
    // Run contract 10: reviews older than the claim that starts an address run have been addressed.
    if (open.rows[0].next_stage === "address") await c.query("update run set reviews_seen_at = $2 where id = $1", [runId, now]);
  }
  return { itemId, runId, generation: lease.rows[0].lease_generation };
}

/** Pushes the lease out to now + LEASE_EXPIRY_MS while `generation` is current. An older generation gets "lost" and changes nothing. */
export async function renewLease(c: pg.PoolClient, itemId: string, generation: number, now: Date): Promise<"ok" | "lost"> {
  const r = await c.query(
    "update item set lease_expires = $3 where id = $1 and lease_generation = $2 and state = 'InProgress'",
    [itemId, generation, new Date(now.getTime() + LEASE_EXPIRY_MS)],
  );
  return r.rowCount === 1 ? "ok" : "lost";
}

/** Sends every InProgress item whose lease ran out before `now` back to Queued through lease_expired. run.next_stage is left alone. */
export async function expireLeases(c: pg.PoolClient, now: Date): Promise<string[]> {
  const r = await c.query<{ id: string }>(
    "select id from item where state = 'InProgress' and lease_expires < $1 order by lease_expires for update skip locked",
    [now],
  );
  for (const { id } of r.rows) await transitionItem(c, id, "lease_expired", system("lease-expiry"));
  return r.rows.map((row) => row.id);
}

/**
 * Clears the lease while `generation` is current. It leaves the generation as it is (Run contract 2). An InProgress
 * item keeps its lease: without lease_expires, expireLeases would never send it back to Queued.
 */
export async function releaseLease(c: pg.PoolClient, itemId: string, generation: number): Promise<void> {
  await c.query(
    "update item set lease_owner = null, lease_expires = null where id = $1 and lease_generation = $2 and state <> 'InProgress'",
    [itemId, generation],
  );
}

export type NewItem = { sourceId: string; externalId: string; title: string; rank?: number };

/** Inserts an item as Eligible, or refreshes its title and backlog rank, keyed on (source_id, external_id). */
export async function upsertItem(c: pg.Pool | pg.PoolClient, item: NewItem): Promise<string> {
  const r = await c.query<{ id: string }>(
    `insert into item (source_id, external_id, title, state, backlog_rank) values ($1, $2, $3, 'Eligible', $4)
     on conflict (source_id, external_id) do update set title = excluded.title, backlog_rank = coalesce(excluded.backlog_rank, item.backlog_rank)
     returning id`,
    [item.sourceId, item.externalId, item.title, item.rank ?? null],
  );
  return r.rows[0].id;
}
