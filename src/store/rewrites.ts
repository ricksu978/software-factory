// The rewrites the factory proposes for a NotReady item a person wrote that fails only dor.md lines (PBI 439). The
// factory asks the coding model for one rewrite of the item's body per version of its text, keeps it here, and shows
// it on the item page beside the current body. Only the owner accepts one; a person's edit to the item withdraws it.
import type pg from "pg";
import { parseRuleChanges, ruleChangesHash } from "../gate/rule-changes.ts";
import { appendEvent, type Actor } from "./events.ts";
import { RULE_CHANGE_APPROVED } from "./rule-changes.ts";

/**
 * One proposal. `body` is the proposed issue body in full, its acceptance criteria kept word for word except one the
 * judge found untestable, which moves to its Notes. `current` is the issue body the proposal rewrites, as it read when
 * the proposal was made.
 */
export type ProposedRewrite = { id: string; itemId: string; body: string; current: string; proposedAt: Date };

/** The kind of the event that logs a person's edit withdrawing a proposal. Its payload's `cause` is "item_edited". */
export const REWRITE_WITHDRAWN = "rewrite_withdrawn";
/** The kind of the event that logs the owner accepting a proposal. Its payload names the proposal as `rewriteId`. */
export const REWRITE_ACCEPTED = "rewrite_accepted";

type Row = { id: string; item_id: string; body: string; current: string; proposed_at: Date };
const view = (r: Row): ProposedRewrite => ({ id: r.id, itemId: r.item_id, body: r.body, current: r.current, proposedAt: r.proposed_at });

/**
 * The item's proposals that stand: neither accepted nor withdrawn. At most one per version of the item's text. The
 * item page shows one only while the item is NotReady.
 */
export async function proposedRewrites(pool: pg.Pool | pg.ClientBase, itemId: string): Promise<ProposedRewrite[]> {
  const r = await pool.query<Row>(
    `select id, item_id, body, current, proposed_at from item_rewrite
     where item_id = $1 and body is not null and accepted_at is null and withdrawn_at is null order by proposed_at, id`,
    [itemId],
  );
  return r.rows.map(view);
}

/**
 * What the factory already did for the item's text `textHash`, whose body is `body`: "standing" when a proposal for it
 * stands, "spent" when the coding model was asked for it already, or when the text is a rewrite the owner accepted, and
 * null when nothing was asked yet.
 */
export async function rewriteAsked(pool: pg.Pool | pg.ClientBase, itemId: string, textHash: string, body: string): Promise<"standing" | "spent" | null> {
  const r = await pool.query<{ standing: boolean }>(
    `select (body is not null and accepted_at is null and withdrawn_at is null) as standing from item_rewrite
     where item_id = $1 and (text_hash = $2 or (accepted_at is not null and body = $3))
     order by (text_hash = $2) desc limit 1`,
    [itemId, textHash, body],
  );
  const row = r.rows[0];
  return !row ? null : row.standing ? "standing" : "spent";
}

/** Keeps the coding model's rewrite for the item's text, or null when its reply carried none. A text keeps its first. */
export async function keepRewrite(pool: pg.Pool | pg.ClientBase, a: { itemId: string; textHash: string; body: string | null; current: string; at?: Date }): Promise<void> {
  await pool.query(
    "insert into item_rewrite (item_id, text_hash, body, current, proposed_at) values ($1, $2, $3, $4, coalesce($5, now())) on conflict do nothing",
    [a.itemId, a.textHash, a.body, a.current, a.at ?? null],
  );
}

/**
 * Withdraws each of the item's standing proposals made for a text other than `textHash`, after a person's edit, and
 * logs each withdrawal as `rewrite_withdrawn` with the cause "item_edited". Returns how many it withdrew.
 */
export async function withdrawRewrites(c: pg.ClientBase, itemId: string, textHash: string, actor: Actor = { actor: "system", actorId: "poller" }): Promise<number> {
  const r = await c.query<{ id: string }>(
    `update item_rewrite set withdrawn_at = now()
     where item_id = $1 and text_hash <> $2 and body is not null and accepted_at is null and withdrawn_at is null returning id`,
    [itemId, textHash],
  );
  for (const { id } of r.rows) {
    await appendEvent(c, { ...actor, itemId, kind: REWRITE_WITHDRAWN, payload: { cause: "item_edited", rewriteId: id } });
  }
  return r.rowCount ?? 0;
}

export type Acceptance =
  | { outcome: "accepted"; rewrite: ProposedRewrite; rulesApproved: boolean }
  | { outcome: "unknown" | "withdrawn" | "accepted_already" | "edited" | "not_waiting" };

/**
 * The owner accepts the proposal `rewriteId` of the item, inside a transaction that locks it. `issueBody` is the issue
 * body as it reads now: when it isn't the body the proposal rewrites, a person edited the item since, so the proposal
 * is withdrawn as the poller would withdraw it and nothing is accepted. When the proposed body adds or changes a
 * "Changes the factory's rules" section, the owner's approval of that section as it reads is logged as PBI 395's
 * `rule_change_approved` at `at`, so the item doesn't wait for a second click.
 */
export async function acceptRewrite(c: pg.ClientBase, a: { itemId: string; rewriteId: string; userId: string; at: Date; issueBody: string }): Promise<Acceptance> {
  const row = (await c.query<Row & { accepted_at: Date | null; withdrawn_at: Date | null }>(
    `select id, item_id, body, current, proposed_at, accepted_at, withdrawn_at from item_rewrite
     where id = $1 and item_id = $2 and body is not null for update`,
    [a.rewriteId, a.itemId],
  )).rows[0];
  if (!row) return { outcome: "unknown" };
  if (row.withdrawn_at) return { outcome: "withdrawn" };
  if (row.accepted_at) return { outcome: "accepted_already" };
  // Only an item waiting in NotReady takes a rewrite: one that left it some other way, such as off the board, doesn't.
  const state = (await c.query<{ state: string }>("select state from item where id = $1 for update", [a.itemId])).rows[0]?.state;
  if (state !== "NotReady") return { outcome: "not_waiting" };
  const actor = { actor: "human" as const, actorId: a.userId };
  if (row.current !== a.issueBody) {
    await withdrawRewrites(c, a.itemId, "", actor);
    return { outcome: "edited" };
  }
  await c.query("update item_rewrite set accepted_at = $2, accepted_by = $3 where id = $1", [row.id, a.at, a.userId]);
  await appendEvent(c, { ...actor, itemId: a.itemId, kind: REWRITE_ACCEPTED, payload: { rewriteId: row.id }, at: a.at });
  const changes = parseRuleChanges(row.body).map((ch) => ({ place: ch.place, before: ch.before, after: ch.after }));
  const rulesApproved = changes.length > 0 && ruleChangesHash(changes) !== ruleChangesHash(parseRuleChanges(row.current));
  if (rulesApproved) {
    await appendEvent(c, { ...actor, itemId: a.itemId, kind: RULE_CHANGE_APPROVED, payload: { rulesHash: ruleChangesHash(changes), changes, via: "rewrite" }, at: a.at });
  }
  return { outcome: "accepted", rewrite: view(row), rulesApproved };
}

/** Each board with an accepted rewrite the worker hasn't run the readiness check for yet, by source id. */
export async function rechecksOwed(pool: pg.Pool): Promise<Map<string, string[]>> {
  const r = await pool.query<{ source_id: string; id: string }>(
    `select i.source_id, w.id from item_rewrite w join item i on i.id = w.item_id
     where w.accepted_at is not null and w.rechecked_at is null order by w.accepted_at`,
  );
  const out = new Map<string, string[]>();
  for (const row of r.rows) out.set(row.source_id, [...(out.get(row.source_id) ?? []), row.id]);
  return out;
}

/** Marks accepted rewrites as rechecked, once the worker has run the readiness check for them. */
export async function markRechecked(pool: pg.Pool, ids: string[]): Promise<void> {
  if (ids.length) await pool.query("update item_rewrite set rechecked_at = now() where id = any($1::uuid[])", [ids]);
}
