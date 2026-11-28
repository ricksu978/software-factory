// The rewrites the factory proposes for a NotReady item a person wrote that fails only dor.md lines (PBI 439). The
// factory asks the coding model for one rewrite of the item's body per version of its text, keeps it here, and shows
// it on the item page beside the current body. Only the owner accepts one; a person's edit to the item withdraws it.
import type pg from "pg";
import { parseRuleChanges, ruleChangesHash } from "../gate/rule-changes.ts";
import { appendEvent, type Actor } from "./events.ts";
import { CONSUMER, writeOutboxRows } from "./outbox.ts";
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
 * stands, or when the text is the body of a proposal that stands (the factory's edit for an acceptance whose
 * transaction didn't commit, which the owner's retry completes); "spent" when the coding model was asked for it
 * already, or when the text is a rewrite the factory proposed and the owner accepted or a person's edit withdrew; and
 * null when nothing was asked yet. So the factory never asks for a rewrite of a text it proposed itself.
 */
export async function rewriteAsked(pool: pg.Pool | pg.ClientBase, itemId: string, textHash: string, body: string): Promise<"standing" | "spent" | null> {
  const r = await pool.query<{ standing: boolean }>(
    `select (body is not null and accepted_at is null and withdrawn_at is null) as standing from item_rewrite
     where item_id = $1 and (text_hash = $2 or body = $3)
     order by (text_hash = $2) desc limit 1`,
    [itemId, textHash, body],
  );
  const row = r.rows[0];
  return !row ? null : row.standing ? "standing" : "spent";
}

/**
 * Whether the issue's `body` is the body of one of the item's standing proposals: the factory's edit for an acceptance
 * whose transaction didn't commit landed. The item waits in NotReady for the owner's retry, which completes the
 * acceptance, so the poller doesn't treat that text as a person's edit and re-gate the item past it.
 */
export async function acceptanceUnfinished(pool: pg.Pool | pg.ClientBase, itemId: string, body: string): Promise<boolean> {
  const r = await pool.query(
    "select 1 from item_rewrite where item_id = $1 and body = $2 and accepted_at is null and withdrawn_at is null limit 1",
    [itemId, body],
  );
  return (r.rowCount ?? 0) > 0;
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
 * logs each withdrawal as `rewrite_withdrawn` with the cause "item_edited". Returns how many it withdrew. A proposal
 * whose body is the issue's `body` now stays: that text is the factory's own edit for an acceptance whose transaction
 * didn't commit, not a person's. The poller keeps such an item in NotReady (see acceptanceUnfinished), so the owner's
 * retry completes the acceptance.
 */
export async function withdrawRewrites(c: pg.ClientBase, itemId: string, textHash: string, actor: Actor = { actor: "system", actorId: "poller" }, body: string | null = null): Promise<number> {
  const r = await c.query<{ id: string }>(
    `update item_rewrite set withdrawn_at = now()
     where item_id = $1 and text_hash <> $2 and body is not null and accepted_at is null and withdrawn_at is null
       and body is distinct from $3 returning id`,
    [itemId, textHash, body],
  );
  for (const { id } of r.rows) {
    await appendEvent(c, { ...actor, itemId, kind: REWRITE_WITHDRAWN, payload: { cause: "item_edited", rewriteId: id } });
  }
  return r.rowCount ?? 0;
}

/** The comment the factory posts on the issue when it applies the rewrite the owner accepted. */
export function acceptedComment(login: string): string {
  return `The factory applied the rewrite of this item's body that ${login}, the owner, accepted on the item's page in the factory's dashboard. The factory checks the item again now.`;
}

/**
 * `edit` is true when the issue body still reads the text the proposal rewrites, so the caller writes the proposed body
 * over it, and false when the issue already reads the proposed body: the factory's edit for an earlier acceptance of
 * it landed, and that acceptance's transaction didn't commit.
 */
export type Acceptance =
  | { outcome: "accepted"; rewrite: ProposedRewrite; rulesApproved: boolean; edit: boolean }
  | { outcome: "unknown" | "withdrawn" | "accepted_already" | "edited" | "not_waiting" };

/**
 * The owner accepts the proposal `rewriteId` of the item, inside a transaction that locks it. `issueBody` is the issue
 * body as it reads now: when it is neither the body the proposal rewrites nor the proposed body, a person edited the
 * item since, so the proposal is withdrawn as the poller would withdraw it and nothing is accepted. The
 * `rewrite_accepted` event, which names the owner's `login`, gets a `rewrite_accepted` outbox row on the same
 * transaction, from which the worker posts the comment saying the factory applied the rewrite, retrying it with
 * backoff until it's posted. When the proposed body adds or changes a
 * "Changes the factory's rules" section, the owner's approval of that section as it reads is logged as PBI 395's
 * `rule_change_approved` at `at`, so the item doesn't wait for a second click.
 */
export async function acceptRewrite(c: pg.ClientBase, a: { itemId: string; rewriteId: string; userId: string; login?: string; at: Date; issueBody: string }): Promise<Acceptance> {
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
  if (row.current !== a.issueBody && row.body !== a.issueBody) {
    await withdrawRewrites(c, a.itemId, "", actor);
    return { outcome: "edited" };
  }
  await c.query("update item_rewrite set accepted_at = $2, accepted_by = $3 where id = $1", [row.id, a.at, a.userId]);
  const accepted = await appendEvent(c, { ...actor, itemId: a.itemId, kind: REWRITE_ACCEPTED, payload: { rewriteId: row.id, login: a.login ?? null }, at: a.at });
  await writeOutboxRows(c, CONSUMER.rewriteAccepted, accepted, [a.itemId]);
  const changes = parseRuleChanges(row.body).map((ch) => ({ place: ch.place, before: ch.before, after: ch.after }));
  const rulesApproved = changes.length > 0 && ruleChangesHash(changes) !== ruleChangesHash(parseRuleChanges(row.current));
  if (rulesApproved) {
    await appendEvent(c, { ...actor, itemId: a.itemId, kind: RULE_CHANGE_APPROVED, payload: { rulesHash: ruleChangesHash(changes), changes, via: "rewrite" }, at: a.at });
  }
  return { outcome: "accepted", rewrite: view(row), rulesApproved, edit: row.current === a.issueBody && row.body !== a.issueBody };
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
