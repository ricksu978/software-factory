// What holds the factory's merge of a PR (PBI 181). The poller merges an InReview item's PR only when nothing here does.
import type pg from "pg";
import type { MergeView } from "../adapters/types.ts";
import { appendEvent, type Actor } from "../store/events.ts";

/** The note open-pr puts after each Definition of Done line left for the person who merges. */
const PERSON_NOTE = /\s*\*\(for the person who merges to check\)\*\s*$/;

/**
 * Each unticked line in the PR body's `## Definition of Done` section, which runs to the next heading. The factory
 * ticks the lines it checked itself, so an unticked one is left for the person who merges. A box elsewhere in the body
 * never counts.
 */
export function untickedDodLines(body: string): string[] {
  const out: string[] = [];
  let inDod = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^#{1,6}\s/.test(line)) {
      inDod = /^##\s+Definition of Done\s*$/i.test(line);
      continue;
    }
    const m = inDod ? /^\s*[-*]\s+\[ \]\s+(.*)$/.exec(line) : null;
    if (m) out.push(m[1].replace(PERSON_NOTE, ""));
  }
  return out;
}

/**
 * Why the factory leaves the PR alone, or null when it may merge: GitHub must read it `clean`, someone must have
 * approved it, and every Definition of Done line left for the person who merges must be ticked. A pending or failing
 * required check reads as `blocked` or `unstable`, so it holds the merge through the merge state.
 */
export function mergeBlocker(view: MergeView): string | null {
  if (view.mergeState !== "clean") return `GitHub reports the PR as ${view.mergeState}`;
  if (view.approvedBy.length === 0) return "nobody has approved the PR";
  const unticked = untickedDodLines(view.body);
  if (unticked.length) return `Definition of Done lines still unticked: ${unticked.join("; ")}`;
  return null;
}

/** The note on a question the factory's merge closed unanswered (PBI 262). */
export function mergedNote(prNumber: number, mergeSha: string | null): string {
  return mergeSha ? `The factory merged PR #${prNumber} as commit ${mergeSha}.` : `The factory merged PR #${prNumber}.`;
}

/**
 * Logs `factory_merged` for a merge the factory asked for but never saw answered (PBI 181). The poller records each
 * merge attempt as `factory_merge_attempt` in its own committed write before it calls GitHub, so a merge that went
 * through while the call failed (a 5xx or a timeout after the merge, or a commit that failed afterwards) is still
 * logged as the factory's when the poller or the webhook later sees the PR merged. Only the item's latest attempt on
 * this PR counts, and only while no `factory_merged` or `factory_merge_refused` for the PR came after it. Called in
 * the transaction that moves the item through `merged`. Returns whether it logged the merge.
 */
export async function logAttemptedMerge(c: pg.ClientBase, itemId: string, prNumber: number, mergeSha: string | null, actor: Actor): Promise<boolean> {
  const attempt = (await c.query<{ payload: { repo: string; prNumber: number; approvers: string[]; waitingIn?: string; question?: string | null; questionId?: string | null } }>(
    `select a.payload from event a
     where a.item_id = $1 and a.kind = 'factory_merge_attempt' and (a.payload->>'prNumber')::int = $2
       and not exists (
         select 1 from event e
         where e.item_id = $1 and e.kind in ('factory_merged', 'factory_merge_refused') and (e.payload->>'prNumber')::int = $2 and e.at >= a.at
       )
       and a.at = (select max(at) from event where item_id = $1 and kind = 'factory_merge_attempt' and (payload->>'prNumber')::int = $2)`,
    [itemId, prNumber],
  )).rows[0];
  if (!attempt) return false;
  const { repo, approvers, waitingIn, question, questionId } = attempt.payload;
  // An attempt made while the item waited in NeedsInput names its question. The move through `merged` has closed it
  // unanswered by now, so it gets the note the direct merge gives it, and the event names it (PBI 262).
  if (questionId) {
    await c.query("update question set closed_note = $2 where id = $1 and answer is null", [questionId, mergedNote(prNumber, mergeSha)]);
  }
  const waiting = waitingIn ? { waitingIn, question: question ?? null } : {};
  await appendEvent(c, { ...actor, itemId, kind: "factory_merged", payload: { repo, prNumber, mergeSha, approvers, ...waiting } });
  return true;
}
