// What holds the factory's merge of a PR (PBI 181). The poller merges an InReview item's PR only when nothing here does.
import type { MergeView } from "../adapters/types.ts";

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
