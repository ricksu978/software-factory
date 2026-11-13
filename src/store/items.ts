import type pg from "pg";
import { next, overrideTo, type ItemEvent, type ItemState } from "../core/states.ts";
import { inTx, runAfterCommit, txPool } from "./db.ts";
import { appendEvent, type Actor } from "./events.ts";

export class IllegalTransition extends Error {
  override name = "IllegalTransition";
  constructor(from: ItemState, event: ItemEvent) {
    super(`no edge from ${from} on ${event}`);
  }
}

// "override" marks an operator's move through overrideItem, which follows no edge of the state machine.
type Hook = (itemId: string, from: ItemState, to: ItemState, event: ItemEvent | "override") => Promise<void>;
const hooks: { hook: Hook; pool?: pg.Pool }[] = [];

/**
 * Registers a hook that runs after each committed transition, and returns the call that removes it. Board mirroring is
 * one (Run contract 8). Given a pool, the hook runs only for transitions committed through that pool, so a process
 * handles the transitions it made, and two in one test process don't each handle the other's.
 */
export function onTransition(hook: Hook, pool?: pg.Pool): () => void {
  const entry = { hook, pool };
  hooks.push(entry);
  return () => {
    const i = hooks.indexOf(entry);
    if (i !== -1) hooks.splice(i, 1);
  };
}

function runHooks(c: pg.PoolClient, ...args: Parameters<Hook>): void {
  const pool = txPool(c);
  for (const h of hooks) if (!h.pool || h.pool === pool) runAfterCommit(c, () => h.hook(...args));
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
  runHooks(c, itemId, from, to, event);
  return to;
}

/**
 * An operator's move to any state, such as a stopped run going to Failed (overrideTo, plan Task 3). It writes like
 * transitionItem, fences the old cell when leaving InProgress, logs an override event with the reason, and runs the
 * same hooks, so the board mirrors it.
 */
export async function overrideItem(c: pg.PoolClient, itemId: string, to: ItemState, actor: Actor, reason: string): Promise<ItemState> {
  if (!inTx(c)) throw new Error("overrideItem needs a client inside withTx");
  const r = await c.query<{ state: ItemState }>("select state from item where id = $1 for update", [itemId]);
  if (r.rowCount === 0) throw new Error(`no item ${itemId}`);
  const from = r.rows[0].state;
  const target = overrideTo(from, to);
  if (from === "InProgress") {
    await c.query("update item set state = $2, lease_generation = lease_generation + 1, lease_owner = null, lease_expires = null where id = $1", [itemId, target]);
  } else {
    await c.query("update item set state = $2 where id = $1", [itemId, target]);
  }
  await appendEvent(c, { ...actor, itemId, kind: "override", payload: { from, to: target, reason } });
  runHooks(c, itemId, from, target, "override");
  return target;
}

export const LEASE_RENEW_MS = 60_000;
export const LEASE_EXPIRY_MS = 300_000;

const system = (actorId: string): Actor => ({ actor: "system", actorId });

// The claim order, shared by claimNext and Floor's "Next up", so the preview can't drift from what's claimed. $1 is
// `resumeOnly`, the waiting-count brake.
const CLAIMABLE = `from item i
     where not i.held and cardinality(i.blocked_by) = 0
       and ((i.state = 'Queued'
           and (not $1 or exists (select from run r join stage_run s on s.run_id = r.id where r.item_id = i.id and r.ended_at is null)))
         or (i.state in ('SignOff', 'NeedsInput')
           and exists (select from question q where q.item_id = i.id and q.answer is not null)
           and not exists (select from question q where q.item_id = i.id and q.answer is null and q.closed_at is null)))
     order by i.state = 'Queued', i.priority desc, i.backlog_rank asc nulls last, i.id`;

/** The first `limit` items claimNext would pick with the same `resumeOnly`, in order, without claiming or locking. */
export async function nextUp(
  c: pg.Pool | pg.PoolClient, limit: number, opts: { resumeOnly?: boolean } = {},
): Promise<{ id: string; external_id: string; title: string; state: ItemState }[]> {
  return (await c.query<{ id: string; external_id: string; title: string; state: ItemState }>(`select i.id, i.external_id, i.title, i.state ${CLAIMABLE} limit $2`, [opts.resumeOnly ?? false, limit])).rows;
}

/**
 * Claims the next item for `owner` and leases it until now + LEASE_EXPIRY_MS. Answered SignOff and NeedsInput items
 * come before Queued ones, then highest priority, then lowest backlog rank. Held items and items with an open
 * dependency are skipped. SKIP LOCKED means two concurrent claims never get the same item, and a claim never waits.
 * The claim raises the generation by 1 (Run contract 2) and reuses the item's open run, or starts one at understand.
 * With `resumeOnly`, the waiting-count brake is on, so a Queued item counts only when its open run already has a
 * stage behind it, such as one back from changes_requested. Answered items always count (Run contract 3).
 */
export async function claimNext(
  c: pg.PoolClient, owner: string, now: Date, opts: { resumeOnly?: boolean } = {},
): Promise<{ itemId: string; runId: string; generation: number } | null> {
  const pick = await c.query<{ id: string }>(`select i.id ${CLAIMABLE} limit 1 for update of i skip locked`, [opts.resumeOnly ?? false]);
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

/** `repo` is the `owner/name` of the repo the item's issue is in, or null for a board item in no repo (PBI 137). */
export type NewItem = { sourceId: string; externalId: string; title: string; rank?: number; repo?: string | null };

/** Inserts an item as Eligible, or refreshes its title, backlog rank and repo, keyed on (source_id, external_id). */
export async function upsertItem(c: pg.Pool | pg.PoolClient, item: NewItem): Promise<string> {
  const r = await c.query<{ id: string }>(
    `insert into item (source_id, external_id, title, state, backlog_rank, repo) values ($1, $2, $3, 'Eligible', $4, $5)
     on conflict (source_id, external_id) do update set title = excluded.title, backlog_rank = coalesce(excluded.backlog_rank, item.backlog_rank),
       repo = excluded.repo
     returning id`,
    [item.sourceId, item.externalId, item.title, item.rank ?? null, item.repo ?? null],
  );
  return r.rows[0].id;
}

/**
 * True when an Abandoned item's last move to Abandoned was a withdrawal from Eligible or NotReady, so it never passed
 * the readiness gate. Such an item comes back only through `returned`, to Eligible, never to Queued (PBI 168).
 */
export async function withdrawnBeforeQueue(c: pg.PoolClient, itemId: string): Promise<boolean> {
  const last = (await c.query<{ from: string; event: string | null }>(
    `select payload->>'from' as from, payload->>'event' as event from event
     where item_id = $1 and kind in ('transition', 'override') and payload->>'to' = 'Abandoned' order by at desc limit 1`,
    [itemId],
  )).rows[0];
  return last?.event === "withdrawn" && (last.from === "Eligible" || last.from === "NotReady");
}
