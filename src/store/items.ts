import type pg from "pg";
import { next, overrideTo, type ItemEvent, type ItemState } from "../core/states.ts";
import { inTx, runAfterCommit, txPool } from "./db.ts";
import { appendEvent, type Actor } from "./events.ts";
import { CONSUMER, writeOutboxRows } from "./outbox.ts";

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
 * Moves an item along one state-machine edge. It writes the state, its event and the event's board mirror outbox row
 * on the caller's withTx transaction, so all commit or none does, and leaving InProgress fences the old cell (Run contract 2).
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
  // A merge answers whatever the item waited on, so its open question closes unanswered and nobody is asked any more (PBI 194).
  if (from === "NeedsInput" && to === "Accepted") {
    await c.query("update question set closed_at = now() where item_id = $1 and answer is null and closed_at is null", [itemId]);
  }
  const eventId = await appendEvent(c, { ...actor, itemId, kind: "transition", payload: { ...detail, from, to, event } });
  await writeOutboxRows(c, CONSUMER.boardMirror, eventId, [itemId]);
  runHooks(c, itemId, from, to, event);
  return to;
}

/**
 * An operator's move to any state, such as a stopped run going to Failed (overrideTo, plan Task 3). It writes like
 * transitionItem, fences the old cell when leaving InProgress, logs an override event with the reason and its board
 * mirror outbox row, and runs the same hooks, so the board mirrors it.
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
  const eventId = await appendEvent(c, { ...actor, itemId, kind: "override", payload: { from, to: target, reason } });
  await writeOutboxRows(c, CONSUMER.boardMirror, eventId, [itemId]);
  runHooks(c, itemId, from, target, "override");
  return target;
}

export const LEASE_RENEW_MS = 60_000;
export const LEASE_EXPIRY_MS = 300_000;

const system = (actorId: string): Actor => ({ actor: "system", actorId });

// An item's active item overrides of the given kinds, for the claim order below.
const activeOn = (kinds: string) =>
  `o.scope = 'item' and o.target_id = i.id and o.kind in (${kinds}) and o.cleared_at is null and (o.expires_at is null or o.expires_at > now())`;
// Start now (PBI 265, spec §8) puts an item ahead of every other claimable item, answered ones included.
const START_NOW = `exists (select from override o where ${activeOn("'start_now'")})`;
// Move up and Move down (PBI 265) give an item a place in the factory queue, its latest move's key, in place of its
// board one. The board's own order is never touched, and a board poll leaves the move as it is. A key is a rank and a
// tie: an unmoved item's rank is its board rank and its tie is its id read as a 128-bit number, so no two items' keys
// are equal, even when two backlog sources both rank from 1. A move stores a key strictly between the two items it
// lands between, its rank null when it lands among items with no board rank, which sort last. A moved item that has a
// board rank keeps its rank as an offset from that board rank, so when a board change shifts it and the items around
// it alike, it moves with them and keeps its moved place. One with no board rank keeps an absolute rank.
const LATEST_MOVE = `(select o.value from override o where ${activeOn("'move_up', 'move_down'")} order by o.created_at desc, o.id desc limit 1)`;
const ID_NUM = `((('x' || substr(replace(i.id::text, '-', ''), 1, 16))::bit(64)::bigint::numeric + 9223372036854775808) * 18446744073709551616
       + (('x' || substr(replace(i.id::text, '-', ''), 17, 16))::bit(64)::bigint::numeric + 9223372036854775808))`;
const QUEUE_RANK = `(case when ${LATEST_MOVE} is null then i.backlog_rank
       when ${LATEST_MOVE} ? 'offset' then i.backlog_rank + (${LATEST_MOVE}->>'offset')::numeric
       else (${LATEST_MOVE}->>'rank')::numeric end)`;
const QUEUE_TIE = `coalesce((${LATEST_MOVE}->>'tie')::numeric, ${ID_NUM})`;
// A SignOff or NeedsInput item whose question was answered, and that has no newer open one.
const ANSWERED = `(i.state in ('SignOff', 'NeedsInput')
           and exists (select from question q where q.item_id = i.id and q.answer is not null)
           and not exists (select from question q where q.item_id = i.id and q.answer is null and q.closed_at is null))`;
// The bug item of a break on main that still stands (PBI 255), ahead of everything else, Start now included.
const MAIN_BREAK_BUG = `exists (select from main_break b where b.bug_item_id = i.id and b.cleared_at is null)`;
// PBI 320: an item is final-stage on its own while its open run's PR is open and it's in the review loop: InReview,
// or Queued or InProgress with next_stage at address. A passed address leaves next_stage there (stageAfter), so the
// pr-review the same claim runs after it counts too.
const OWN_FINAL_STAGE = `exists (select from run r where r.item_id = i.id and r.ended_at is null and r.pr_number is not null and r.merge_sha is null
         and (i.state = 'InReview'
           or (i.state in ('Queued', 'InProgress') and r.next_stage = 'address')))`;
// The states in which an item's dependencies stand. A Done, Accepted, Failed, Abandoned or Split item lends no one its
// group or priority, and a dependency isn't followed through it.
const LIVE = `i.state in ('Eligible', 'NotReady', 'Queued', 'InProgress', 'SignOff', 'NeedsInput', 'InReview')`;
/**
 * PBI 320: every item's claim key, as the CTE `claim_key`: its group and priority, and the item it inherits each from.
 * An item's own priority is the board's, 3 until a poll reads it. A dependency is the board's open one, which the
 * poller copies into `blocked_by` by external id. An item is in the final-stage group when it's final-stage itself, or
 * when a final-stage item depends on it, directly or through other live items. Its priority is the highest of its own
 * and those of the items in its group that depend on it: in the final-stage group the final-stage dependents, outside
 * it every dependent. `fs_from` names the dependent the group comes from, and `p_from` the one the priority comes from,
 * only when it's higher than the item's own; the higher priority wins, then the lower board rank, then the id.
 */
export const CLAIM_KEYS = `with recursive
  own as (
    select i.id, i.source_id, i.external_id, i.blocked_by, i.backlog_rank, ${LIVE} as live,
      coalesce(i.board_priority, 3)::int as p, ${OWN_FINAL_STAGE} as fs
    from item i
  ),
  reach (root, id) as (
    select o.id, o.id from own o where o.live
    union
    select r.root, d.id from reach r join own a on a.id = r.id and a.live
      join own d on d.source_id = a.source_id and d.external_id = any(a.blocked_by)
  ),
  lent as (
    select r.id, l.id as from_id, l.external_id as from_ext, l.p, l.fs, l.backlog_rank
    from reach r join own l on l.id = r.root where r.root <> r.id
  ),
  grouped as (
    select o.id, o.p as own_p, o.fs as own_fs, o.fs or coalesce(bool_or(l.fs), false) as fs,
      min(l.p) filter (where l.fs) as fs_p,
      (array_agg(l.from_id order by l.p, l.backlog_rank nulls last, l.from_id) filter (where l.fs))[1] as fs_id,
      (array_agg(l.from_ext order by l.p, l.backlog_rank nulls last, l.from_id) filter (where l.fs))[1] as fs_ext,
      min(l.p) as any_p,
      (array_agg(l.from_id order by l.p, l.backlog_rank nulls last, l.from_id))[1] as any_id,
      (array_agg(l.from_ext order by l.p, l.backlog_rank nulls last, l.from_id))[1] as any_ext
    from own o left join lent l on l.id = o.id group by o.id, o.p, o.fs
  ),
  claim_key as (
    select g.id, g.own_p, g.fs,
      case when g.fs and not g.own_fs then g.fs_id end as fs_from, case when g.fs and not g.own_fs then g.fs_ext end as fs_from_ext,
      least(g.own_p, case when g.fs then g.fs_p else g.any_p end) as p,
      case when (case when g.fs then g.fs_p else g.any_p end) < g.own_p then (case when g.fs then g.fs_id else g.any_id end) end as p_from,
      case when (case when g.fs then g.fs_p else g.any_p end) < g.own_p then (case when g.fs then g.fs_ext else g.any_ext end) end as p_from_ext
    from grouped g
  )`;

/** An item's claim key (PBI 320): its priority from 1 to 5 and whether it's final-stage, each with the item it comes from. */
export type ClaimKey = {
  /** The item's own priority, from the board. */
  own: number;
  /** The priority it's claimed at: its own, or a higher one from an item that depends on it. */
  priority: number;
  priorityFrom: { id: string; externalId: string } | null;
  finalStage: boolean;
  /** The final-stage item that depends on it, when it's in the group only because of that item. */
  finalStageFrom: { id: string; externalId: string } | null;
};

/** The claim keys of the given items, or of every item, by id. */
export async function claimKeys(c: pg.Pool | pg.PoolClient, ids?: string[]): Promise<Map<string, ClaimKey>> {
  const rows = (await c.query<{ id: string; own_p: number; p: number; fs: boolean; fs_from: string | null; fs_from_ext: string | null; p_from: string | null; p_from_ext: string | null }>(
    `${CLAIM_KEYS} select * from claim_key k where $1::uuid[] is null or k.id = any($1::uuid[])`, [ids ?? null],
  )).rows;
  return new Map(rows.map((r) => [r.id, {
    own: r.own_p, priority: r.p, finalStage: r.fs,
    priorityFrom: r.p_from ? { id: r.p_from, externalId: r.p_from_ext! } : null,
    finalStageFrom: r.fs_from ? { id: r.fs_from, externalId: r.fs_from_ext! } : null,
  }]));
}

// PBI 320: the final-stage group comes after Start now and before everything else, then the claim priority, 1 first.
// Within one priority today's order holds: answered items, the older priority column, then the queue rank.
const ORDER = `order by ${MAIN_BREAK_BUG} desc, ${START_NOW} desc, k.fs desc, k.p asc, i.state = 'Queued', i.priority desc, ${QUEUE_RANK} asc nulls last, ${QUEUE_TIE} asc, i.id`;

// The claim order, shared by claimNext and Floor's "Next up", so the preview can't drift from what's claimed. $1 is
// `resumeOnly`, the waiting-count brake. The bug item of a break that still stands comes first, so the factory fixes
// main before it builds anything else (PBI 255). None of the overrides above gets an item past a hold, an open blocker
// or the readiness gate: they only order the items that are claimable anyway.
// A priority-1 item, its own or inherited, gets past the brake (PBI 320), though never past a hold or a blocker.
const CLAIMABLE = `from item i join claim_key k on k.id = i.id
     where not i.held and cardinality(i.blocked_by) = 0
       and ((i.state = 'Queued'
           and (not $1 or k.p = 1 or exists (select from run r join stage_run s on s.run_id = r.id where r.item_id = i.id and r.ended_at is null)))
         or ${ANSWERED})
     ${ORDER}`;

/**
 * Moves an item one place up or down the factory queue (PBI 265) and logs it as a move_up or move_down override with
 * the person and the reason. The queue here is every Queued or answered item in the claim order, held and blocked ones
 * included, so a held item keeps the place it was moved to once it's released. A move stays among the items it's
 * ordered with: those that match it on being a standing break's bug item, Start now, the final-stage group, the claim
 * priority (PBI 320), Queued or answered, and the older priority column.
 * The item's new queue key, strictly between the two items it lands between even when their board ranks tie, is kept
 * on the override, so it ends when the override does. Its rank is kept as an offset from the item's board rank where it
 * has one, so a board reorder that shifts the item and its neighbours alike leaves the moved order as it was. An item
 * already at that end is logged all the same and stays put. One that isn't in the queue throws.
 */
export async function moveInQueue(
  c: pg.PoolClient, itemId: string, dir: "up" | "down", o: { reason: string; createdBy: string },
): Promise<void> {
  if (!inTx(c)) throw new Error("moveInQueue needs a client inside withTx");
  if (!o.reason.trim()) throw new Error("an override needs a reason");
  // Two moves at once would read the same neighbours, so they take turns.
  await c.query("select pg_advisory_xact_lock(265)");
  const rows = (await c.query<{ id: string; bug: boolean; first: boolean; fs: boolean; p: number; queued: boolean; priority: number; rank: string | null; tie: string; idnum: string; board: string | null }>(
    `${CLAIM_KEYS} select i.id, ${MAIN_BREAK_BUG} as bug, ${START_NOW} as first, k.fs, k.p, i.state = 'Queued' as queued, i.priority,
       ${QUEUE_RANK}::text as rank, ${QUEUE_TIE}::text as tie, ${ID_NUM}::text as idnum, i.backlog_rank::text as board
     from item i join claim_key k on k.id = i.id where i.state = 'Queued' or ${ANSWERED} ${ORDER}`,
  )).rows;
  const me = rows.find((r) => r.id === itemId);
  if (!me) throw new Error(`item ${itemId} isn't in the factory queue`);
  const group = rows.filter((r) => r.bug === me.bug && r.first === me.first && r.fs === me.fs && r.p === me.p && r.queued === me.queued && r.priority === me.priority);
  const at = group.indexOf(me);
  const last = group.length - 1;
  // The two items the move lands between, either of them missing at an end of the queue. An item already at the end
  // it's moved towards keeps its own key.
  const [before, after] = dir === "up" ? [group[at - 2], group[at - 1]] : [group[at + 1], group[at + 2]];
  const stays = dir === "up" ? at === 0 : at === last;
  const key = stays ? { rank: me.rank, tie: me.tie } : keyBetween(before, after, me.idnum);
  // Kept relative to the item's own board rank where it has one, so a board change that shifts it carries the move.
  const value = key.rank !== null && me.board !== null ? { offset: decAdd(key.rank, `-${me.board}`.replace(/^--/, "")), tie: key.tie } : key;
  await c.query(
    "insert into override (scope, target_id, kind, value, reason, created_by) values ('item', $1, $2, $3, $4, $5)",
    [itemId, dir === "up" ? "move_up" : "move_down", value, o.reason.trim(), o.createdBy],
  );
}

type QueueKey = { rank: string | null; tie: string };

/**
 * A queue key strictly after `lo` and strictly before `hi`, in the order rank (nulls last) then tie. Either may be
 * missing, for an end of the queue. Where the ranks differ the new rank goes between them and the tie is the moved
 * item's own id number, so it can't equal another item's; where they're equal the tie goes between the two ties.
 */
export function keyBetween(lo: QueueKey | undefined, hi: QueueKey | undefined, ownTie: string): QueueKey {
  if (!lo && !hi) throw new Error("a move needs an item to pass");
  if (!lo) return { rank: hi!.rank === null ? "0" : decAdd(hi!.rank, "-1"), tie: ownTie };
  if (!hi) return lo.rank === null ? { rank: null, tie: decAdd(lo.tie, "1") } : { rank: decAdd(lo.rank, "1"), tie: ownTie };
  if (lo.rank === hi.rank || (lo.rank !== null && hi.rank !== null && decCmp(lo.rank, hi.rank) === 0)) {
    return { rank: lo.rank, tie: decMid(lo.tie, hi.tie) };
  }
  if (lo.rank === null) throw new Error("queue keys out of order");
  return { rank: hi.rank === null ? decAdd(lo.rank, "1") : decMid(lo.rank, hi.rank), tie: ownTie };
}

// Exact decimal arithmetic on Postgres numeric text, so halving a gap never runs out of precision as a float would.
function decParse(s: string): { m: bigint; e: number } {
  const neg = s.startsWith("-");
  const [int, frac = ""] = (neg ? s.slice(1) : s).split(".");
  const m = BigInt(int + frac);
  return { m: neg ? -m : m, e: frac.length };
}
function decAlign(a: string, b: string): [bigint, bigint, number] {
  const x = decParse(a), y = decParse(b);
  const e = Math.max(x.e, y.e);
  return [x.m * 10n ** BigInt(e - x.e), y.m * 10n ** BigInt(e - y.e), e];
}
function decFormat(m: bigint, e: number): string {
  const neg = m < 0n;
  let digits = (neg ? -m : m).toString().padStart(e + 1, "0");
  if (e > 0) digits = `${digits.slice(0, -e)}.${digits.slice(-e)}`.replace(/\.?0+$/, "");
  return (neg ? "-" : "") + digits;
}
function decCmp(a: string, b: string): number {
  const [x, y] = decAlign(a, b);
  return x < y ? -1 : x > y ? 1 : 0;
}
function decAdd(a: string, b: string): string {
  const [x, y, e] = decAlign(a, b);
  return decFormat(x + y, e);
}
function decMid(a: string, b: string): string {
  const [x, y, e] = decAlign(a, b);
  const sum = x + y;
  return sum % 2n === 0n ? decFormat(sum / 2n, e) : decFormat((sum * 10n) / 2n, e + 1);
}


/** The first `limit` items claimNext would pick with the same `resumeOnly`, in order, without claiming or locking. */
export async function nextUp(
  c: pg.Pool | pg.PoolClient, limit: number, opts: { resumeOnly?: boolean } = {},
): Promise<{ id: string; external_id: string; title: string; state: ItemState }[]> {
  return (await c.query<{ id: string; external_id: string; title: string; state: ItemState }>(`${CLAIM_KEYS} select i.id, i.external_id, i.title, i.state ${CLAIMABLE} limit $2`, [opts.resumeOnly ?? false, limit])).rows;
}

/**
 * Claims the next item for `owner` and leases it until now + LEASE_EXPIRY_MS. The bug item of a standing break on main
 * comes first (PBI 255), then an item marked Start now, then the final-stage group, then by claim priority, 1 first
 * (PBI 320, see CLAIM_KEYS), then answered SignOff and NeedsInput items before Queued ones, then highest priority
 * column, then lowest queue rank: the latest Move up or Move down's, or else the backlog rank (PBI 265). Held items and
 * items with an open dependency are skipped. SKIP LOCKED means two concurrent claims never get the same item, and a claim never waits.
 * The claim raises the generation by 1 (Run contract 2) and reuses the item's open run, or starts one at understand.
 * With `resumeOnly`, the waiting-count brake is on, so a Queued item counts only when its open run already has a
 * stage behind it, such as one back from changes_requested. Answered items always count (Run contract 3), and so does
 * a Queued item at claim priority 1 (PBI 320).
 */
export async function claimNext(
  c: pg.PoolClient, owner: string, now: Date, opts: { resumeOnly?: boolean } = {},
): Promise<{ itemId: string; runId: string; generation: number } | null> {
  const pick = await c.query<{ id: string }>(`${CLAIM_KEYS} select i.id ${CLAIMABLE} limit 1 for update of i skip locked`, [opts.resumeOnly ?? false]);
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

/** The message on an attempt whose cell's claim ended before it reported the attempt (PBI 239). Migration 012 writes the same text. */
export const LEASE_RAN_OUT = "The cell's lease ran out before it reported this attempt.";

/**
 * Closes every attempt of the item's open run that is still started: it gets the status stopped, ends at `now` and
 * carries LEASE_RAN_OUT (PBI 239). The factory calls it whenever an InProgress item goes back to Queued because its
 * lease ran out or a cell wrapping up for a restart ended its claim, so no attempt is left started for a cell that's gone. Like any
 * stopped attempt, it uses up none of the stage's retries.
 */
export async function closeStartedAttempts(c: pg.PoolClient, itemId: string, now: Date): Promise<void> {
  await c.query(
    `update stage_run s set status = 'stopped', ended_at = $2, message = $3
     from run r where r.id = s.run_id and r.item_id = $1 and r.ended_at is null and s.status = 'started'`,
    [itemId, now, LEASE_RAN_OUT],
  );
}

/**
 * Sends every InProgress item whose lease ran out before `now` back to Queued through lease_expired, closing its run's
 * started attempts as stopped (PBI 239). run.next_stage is left alone.
 */
export async function expireLeases(c: pg.PoolClient, now: Date): Promise<string[]> {
  const r = await c.query<{ id: string }>(
    "select id from item where state = 'InProgress' and lease_expires < $1 order by lease_expires for update skip locked",
    [now],
  );
  for (const { id } of r.rows) {
    await closeStartedAttempts(c, id, now);
    await transitionItem(c, id, "lease_expired", system("lease-expiry"));
  }
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
export type NewItem = { sourceId: string; externalId: string; title: string; rank?: number; repo?: string | null; issueCreatedAt?: string | Date | null };

/**
 * Inserts an item as Eligible, or refreshes its title, backlog rank and repo, keyed on (source_id, external_id). It
 * keeps the issue's creation time once known, so an item held from before the column gets it on its next poll (PBI 187).
 */
export async function upsertItem(c: pg.Pool | pg.PoolClient, item: NewItem): Promise<string> {
  const r = await c.query<{ id: string }>(
    `insert into item (source_id, external_id, title, state, backlog_rank, repo, issue_created_at) values ($1, $2, $3, 'Eligible', $4, $5, $6)
     on conflict (source_id, external_id) do update set title = excluded.title, backlog_rank = coalesce(excluded.backlog_rank, item.backlog_rank),
       repo = excluded.repo, issue_created_at = coalesce(excluded.issue_created_at, item.issue_created_at)
     returning id`,
    [item.sourceId, item.externalId, item.title, item.rank ?? null, item.repo ?? null, item.issueCreatedAt ?? null],
  );
  return r.rows[0].id;
}

/**
 * True when an Abandoned item's last move to Abandoned was a withdrawal from Eligible or NotReady, so it never passed
 * the readiness gate. Such an item comes back only through `returned`, to Eligible, never to Queued (PBI 168).
 */
export async function withdrawnBeforeQueue(c: pg.Pool | pg.PoolClient, itemId: string): Promise<boolean> {
  const last = (await c.query<{ from: string; event: string | null }>(
    `select payload->>'from' as from, payload->>'event' as event from event
     where item_id = $1 and kind in ('transition', 'override') and payload->>'to' = 'Abandoned' order by at desc limit 1`,
    [itemId],
  )).rows[0];
  return last?.event === "withdrawn" && (last.from === "Eligible" || last.from === "NotReady");
}
