// Sign-off and answers (plan Task 15). The dashboard routes and item comments both go through `decide`, so the two
// channels can't drift.
import type pg from "pg";
import type { BacklogAdapter, RepoHost } from "../adapters/types.ts";
import type { ItemState } from "../core/states.ts";
import type { FeatureChangeFile } from "../core/feature-change.ts";
import { withTx } from "../store/db.ts";
import { appendEvent } from "../store/events.ts";
import { transitionItem } from "../store/items.ts";
import { CONSUMER, writeOutboxRows } from "../store/outbox.ts";
import { repoName, runBranch } from "../store/runs.ts";

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

/** The `about` of a decision event on a feature change request (PBI 365). A sign-off or an answer has none. */
export const FEATURE_CHANGE = "feature_change";

const featureChangeAnnouncements: Record<"approve" | "changes", string> = {
  approve: "Feature change approved. The factory committed the proposed feature files to the branch, locked them there, and resumes the stage that asked.",
  changes: "Feature change turned down. The locked feature files stay as they were, and the stage that asked runs again with this note.",
};

/**
 * The comment that announces an applied decision on the item, quoting its text. The worker posts it from the decision's
 * outbox row (PBI 219), so the dashboard and a comment command only apply the decision, and it's announced once.
 */
export function announcement(kind: DecisionKind, text: string, about?: string): string {
  const said = about === FEATURE_CHANGE && kind !== "answer" ? featureChangeAnnouncements[kind] : announcements[kind];
  return text ? `${said}\n\n> ${text.replace(/\n/g, "\n> ")}` : said;
}

const featureChangeRefusal =
  "Only a product owner can approve or turn down a feature change request. Ask the factory's owner to add your GitHub login as a product owner.";

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
  const item = (await deps.pool.query<{ id: string; state: ItemState }>("select id, state from item where source_id = $1 and external_id = $2", [deps.sourceId, e.externalId])).rows[0];
  if (!item) return "ignored";
  const fi = await deps.adapter.getItem(e.externalId);
  if (!fi?.repo || fi.repo.toLowerCase() !== e.repo.toLowerCase()) return "ignored";
  const user = (await deps.pool.query<{ id: string }>(`select id from "user" where lower(github_login) = lower($1)`, [e.login])).rows[0];
  // PBI 365: the /approve and /changes that sign off scenarios answer a feature change request too.
  const featureChange = item.state === "FeatureChangeRequest" && command.kind !== "answer";
  const outcome = !user
    ? "forbidden"
    : featureChange
      ? await decideFeatureChange(deps, { itemId: item.id, userId: user.id, kind: command.kind as "approve" | "changes", text: command.text, via: "comment", askedBy: postedAt })
      : await withTx(deps.pool, (c) => decide(c, { itemId: item.id, userId: user.id, kind: command.kind, text: command.text, via: "comment", askedBy: postedAt }));
  if (outcome === "forbidden") await deps.adapter.comment(e.externalId, `@${e.login} ${featureChange ? featureChangeRefusal : refusal[command.kind]}`, `refused:${e.commentId}`);
  return outcome;
}

/** The finding a turned-down feature change request hands the stage that asked, the Product Owner's note whole. */
export function turnedDownFinding(note: string): string {
  const head = "The Product Owner turned down your feature change request, so the locked feature files stay as they were at the lock commit. Make the scenarios pass as they're locked.";
  return note ? `${head} Their note:\n\n${note}` : head;
}

/**
 * PBI 365: the Product Owner's decision on the feature change request the item waits on in FeatureChangeRequest. Only
 * a product owner's applies, as at sign-off (spec §8). Approve commits each file's proposed version to the run's
 * branch in one commit on top of its head, through the repo host, and moves the run's lock to that commit, so every
 * later gate compares the feature files against it. Changes keeps the lock and puts the note in the findings of the
 * run's last attempt, which `/context` hands the stage's next attempt as its retry. Either way the item goes back to
 * Queued at the stage that asked, and the decision is logged with `about: "feature_change"` and announced from its
 * outbox row. The item's row stays locked while the commit is made, so the same decision handled twice commits once:
 * the second finds the item Queued and is ignored. A decision posted before the request was asked is ignored too.
 */
export async function decideFeatureChange(
  deps: { pool: pg.Pool; repoHost?: Pick<RepoHost, "commitFiles"> },
  d: Omit<Decision, "kind"> & { kind: "approve" | "changes" },
): Promise<Outcome> {
  return withTx(deps.pool, async (c) => {
    const user = (await c.query<{ product_owner: boolean }>(`select product_owner from "user" where id = $1`, [d.userId])).rows[0];
    if (!user?.product_owner) return "forbidden";
    const item = (await c.query<{ state: ItemState; external_id: string }>("select state, external_id from item where id = $1 for update", [d.itemId])).rows[0];
    if (item?.state !== "FeatureChangeRequest") return "ignored";
    const run = (await c.query<{ id: string; branch: string | null; run_number: number; feature_change: FeatureChangeFile[] | null; repo_url: string | null }>(
      `select r.id, r.branch, r.run_number, r.feature_change, repo.url as repo_url from run r left join repo on repo.id = r.repo_id
       where r.item_id = $1 order by r.run_number desc, r.started_at desc limit 1`, [d.itemId])).rows[0];
    if (!run?.feature_change?.length) return "ignored";
    if (d.askedBy) {
      const asked = (await c.query<{ at: Date }>(
        `select at from event where item_id = $1 and kind = 'transition' and payload->>'event' = 'feature_change_requested' order by at desc limit 1`,
        [d.itemId])).rows[0];
      // The request was asked after the command was posted, so its author never saw it.
      if (asked && asked.at.getTime() > d.askedBy.getTime()) return "ignored";
    }
    if (d.kind === "approve") {
      if (!deps.repoHost) throw new Error("approving a feature change request needs a repo host to commit the proposed files");
      if (!run.repo_url) throw new Error(`run ${run.id} has no repo`);
      const files = run.feature_change;
      const sha = await deps.repoHost.commitFiles({
        repo: repoName(run.repo_url),
        branch: runBranch({ branch: run.branch, externalId: item.external_id, runNumber: run.run_number }),
        message: `Feature change approved: ${files.map((f) => f.path).join(", ")}\n\n${files.map((f) => `${f.path}: ${f.reason}`).join("\n")}`,
        files: files.map((f) => ({ path: f.path, text: f.after })),
      });
      await c.query("update run set features_lock_sha = $2 where id = $1", [run.id, sha]);
    } else {
      // The run's last attempt, at any stage but a claim's base merge, is the one that asked, which `/context` reads as
      // the next claim's retry. For pr-review, which runs while the run stays at open-pr or address, `/context` hands
      // it as pr-review's, and the engine keeps it for pr-review's addresser. No tries are spent: the owner's answer
      // gives the stage its tries afresh.
      await c.query(
        `update stage_run set retry_carry = $2 where id = (
           select id from stage_run where run_id = $1 and stage_id <> 'merge' order by started_at desc, attempt desc limit 1)`,
        [run.id, JSON.stringify({ tried: 0, findings: [turnedDownFinding(d.text)] })]);
    }
    await transitionItem(c, d.itemId, "feature_change_decided", { actor: "human", actorId: d.userId }, { decision: d.kind });
    const eventId = await appendEvent(c, {
      actor: "human", actorId: d.userId, itemId: d.itemId, kind: "decision", payload: { about: FEATURE_CHANGE, kind: d.kind, via: d.via, text: d.text },
    });
    await writeOutboxRows(c, CONSUMER.decisionAnnouncement, eventId, [d.itemId]);
    return "applied";
  });
}
