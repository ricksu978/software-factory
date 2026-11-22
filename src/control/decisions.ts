// Sign-off and answers (plan Task 15). The dashboard routes and item comments both go through `decide`, so the two
// channels can't drift.
import type pg from "pg";
import type { BacklogAdapter, RepoHost } from "../adapters/types.ts";
import type { ItemState } from "../core/states.ts";
import { withTx } from "../store/db.ts";
import { appendEvent } from "../store/events.ts";
import { transitionItem } from "../store/items.ts";
import { CONSUMER, writeOutboxRows } from "../store/outbox.ts";

export type DecisionKind = "approve" | "changes" | "answer";
/**
 * `askedBy`, when given, is the latest time the question may have been asked: a comment command run late from a
 * retried outbox row passes its webhook event's time, so it never answers a question asked after it was posted.
 */
export type Decision = { itemId: string; userId: string; kind: DecisionKind; text: string; via: "dashboard" | "comment"; askedBy?: Date };
export type Outcome = "applied" | "ignored" | "forbidden";

/** Reads only a leading /approve, /changes or /answer, with the rest of the comment as its text. */
export function parseCommand(body: string): { kind: DecisionKind; text: string } | null {
  const m = /^\s*\/(approve|changes|answer)\b(.*)$/s.exec(body);
  return m ? { kind: m[1] as DecisionKind, text: m[2].trim() } : null;
}

/**
 * True when an Abandoned item may come back through a late decision: only one that timed out waiting for it. An
 * item withdrawn from the backlog stays gone, even with its question still open.
 */
export async function revivable(c: pg.Pool | pg.PoolClient, itemId: string): Promise<boolean> {
  const last = (await c.query<{ event: string }>(
    "select payload->>'event' as event from event where item_id = $1 and kind = 'transition' and payload->>'to' = 'Abandoned' order by at desc limit 1",
    [itemId],
  )).rows[0];
  return last?.event === "timed_out";
}

/** Who may make a decision of `kind`: a product owner signs off, and an operator or product owner answers. */
function allowed(kind: DecisionKind, u: { role: string; product_owner: boolean }): boolean {
  return kind === "answer" ? u.product_owner || u.role === "operator" || u.role === "owner" : u.product_owner;
}

/**
 * Answers the item's open question with the decision. Run contract 1 sets the resume point: approve resumes at red
 * and locks the scenarios, changes sends the run back to specify, and an answer leaves the resume point where the
 * question was asked. An Abandoned item comes back through `requeued`. A user without the right role gets
 * `forbidden`, and an item with no open question of the right kind gets `ignored`. An applied decision writes its
 * event and the event's decision announcement outbox row on the caller's transaction.
 */
export async function decide(c: pg.PoolClient, d: Decision): Promise<Outcome> {
  const user = (await c.query<{ role: string; product_owner: boolean }>(`select role, product_owner from "user" where id = $1`, [d.userId])).rows[0];
  if (!user || !allowed(d.kind, user)) return "forbidden";
  const item = (await c.query<{ state: ItemState }>("select state from item where id = $1 for update", [d.itemId])).rows[0];
  const kind = d.kind === "answer" ? "needs_input" : "sign_off";
  const question = (await c.query<{ id: string; asked_at: Date }>(
    "select id, asked_at from question where item_id = $1 and kind = $2 and answer is null and closed_at is null order by asked_at desc limit 1",
    [d.itemId, kind],
  )).rows[0];
  const waiting = d.kind === "answer" ? "NeedsInput" : "SignOff";
  if (!item || !question) return "ignored";
  // The open question was asked after the command was posted, so its author never saw it: the command is dropped.
  if (d.askedBy && question.asked_at.getTime() > d.askedBy.getTime()) return "ignored";
  if (item.state !== waiting && !(item.state === "Abandoned" && (await revivable(c, d.itemId)))) return "ignored";

  await c.query("update question set answer = $2, decision = $3, answered_by = $4, answered_at = now() where id = $1", [question.id, d.text, d.kind, d.userId]);
  const run = "(select id from run where item_id = $1 and ended_at is null order by started_at desc limit 1)";
  if (d.kind === "approve") {
    await c.query(`update run set next_stage = 'red', features_lock_sha = scenarios_sha, signed_off_by = $2, signed_off_at = now() where id = ${run}`, [d.itemId, d.userId]);
  } else if (d.kind === "changes") {
    await c.query(`update run set next_stage = 'specify' where id = ${run}`, [d.itemId]);
  }
  if (item.state === "Abandoned") await transitionItem(c, d.itemId, "requeued", { actor: "human", actorId: d.userId });
  const eventId = await appendEvent(c, { actor: "human", actorId: d.userId, itemId: d.itemId, kind: "decision", payload: { kind: d.kind, via: d.via, text: d.text } });
  await writeOutboxRows(c, CONSUMER.decisionAnnouncement, eventId, [d.itemId]);
  return "applied";
}

const announcements: Record<DecisionKind, string> = {
  approve: "Scenarios signed off. The factory locks them and starts Red.",
  changes: "Scenarios sent back for changes. The factory rewrites them and asks for sign-off again.",
  answer: "Answer received. The factory picks the item up again.",
};

/**
 * The comment that announces an applied decision on the item, quoting its text. The worker posts it from the decision's
 * outbox row (PBI 219), so the dashboard and a comment command only apply the decision, and it's announced once.
 */
export function announcement(kind: DecisionKind, text: string): string {
  return text ? `${announcements[kind]}\n\n> ${text.replace(/\n/g, "\n> ")}` : announcements[kind];
}

const refusal: Record<DecisionKind, string> = {
  approve: "Only a product owner can sign off scenarios. Ask the factory's owner to add your GitHub login as a product owner.",
  changes: "Only a product owner can sign off scenarios. Ask the factory's owner to add your GitHub login as a product owner.",
  answer: "Only an operator or a product owner can answer the factory. Ask the factory's owner to add your GitHub login.",
};

/**
 * Applies an item comment that starts with /approve, /changes or /answer. It must be on the item's own repo, since
 * the same issue number exists in every repo. The author's GitHub login must map to an allowlisted user with the
 * right role. A refused command gets one reply naming who may decide, keyed on the comment, and changes nothing. An
 * applied one goes through `decide` alone, so its announcement comes from the decision's outbox row. The worker runs
 * it from the comment's outbox row (PBI 219), passing the webhook event's time as `postedAt`, so a command handled
 * late, as from a retried row, applies only to a question asked by the time it was posted.
 */
export async function applyComment(
  deps: { pool: pg.Pool; adapter: BacklogAdapter; sourceId: string; /** PBI 365: commits an approved feature change to the run's branch. */ repoHost?: Pick<RepoHost, "commitFiles"> },
  e: { externalId: string; repo: string; login: string; body: string; commentId: string },
  postedAt?: Date,
): Promise<Outcome> {
  const command = parseCommand(e.body);
  if (!command) return "ignored";
  const item = (await deps.pool.query<{ id: string }>("select id from item where source_id = $1 and external_id = $2", [deps.sourceId, e.externalId])).rows[0];
  if (!item) return "ignored";
  const fi = await deps.adapter.getItem(e.externalId);
  if (!fi?.repo || fi.repo.toLowerCase() !== e.repo.toLowerCase()) return "ignored";
  const user = (await deps.pool.query<{ id: string }>(`select id from "user" where lower(github_login) = lower($1)`, [e.login])).rows[0];
  const outcome = user
    ? await withTx(deps.pool, (c) => decide(c, { itemId: item.id, userId: user.id, kind: command.kind, text: command.text, via: "comment", askedBy: postedAt }))
    : "forbidden";
  if (outcome === "forbidden") await deps.adapter.comment(e.externalId, `@${e.login} ${refusal[command.kind]}`, `refused:${e.commentId}`);
  return outcome;
}
