// Gating split children against dor.md (PBI 264). Before a split is filed, the readiness judge checks each proposed
// child against the same dor.md as the parent. A child that fails a line gets one rewrite of its body from the coding
// model, given the judge's reasons, and is judged again; a child that still fails stops the whole split from being
// filed, and the proposal comment names it and the lines it failed. A child the factory filed that later fails a line
// has its body rewritten once the same way, keeping the parent's criteria section word for word, and is gated again,
// but only when the factory's own App opened it with a split marker and nobody else has edited it since. A failure only
// the owner can fix (a readiness flag such as a credential, or an engine rule such as a missing App permission) is
// never rewritten: the comment says what the owner has to do.
import type { FactoryItem } from "../adapters/types.ts";
import type { Policy, Verdict } from "../policy/policy.ts";
import type { IssueAuthorship } from "./file-split.ts";

/**
 * Every rewrite request opens with this line, so it never reads as a split request. The request carries the child
 * as fenced JSON with its "title", "body" and "acceptanceCriteria", the dor.md the judge read, word for word, and
 * each line the child failed with the judge's reason.
 */
export const REWRITE_HEADING = "Rewrite this child item's body so it meets the team's Definition of Ready.";

/** The rewrite request for `child`, which failed `failed` against `dor`. */
export function rewritePrompt(_child: FactoryItem, _dor: Policy, _failed: Verdict[]): string {
  throw new Error("rewritePrompt: not implemented (PBI 264)");
}

/**
 * Reads the coding model's rewrite: one JSON line {"body":"..."}. Null when the reply carries no non-empty body. Any
 * acceptance criteria section the model wrote is dropped where the body is filed or edited, never here.
 */
export function readRewrite(_reply: string): string | null {
  throw new Error("readRewrite: not implemented (PBI 264)");
}

/** True when `verdict` is a failure only the owner can fix: a readiness flag, or an engine rule they alone can clear. */
export function ownerOnly(_verdict: Verdict): boolean {
  throw new Error("ownerOnly: not implemented (PBI 264)");
}

/** What the owner has to do to clear `verdict`, an owner-only failure, as the readiness or proposal comment says it. */
export function ownerAction(_verdict: Verdict): string {
  throw new Error("ownerAction: not implemented (PBI 264)");
}

/** True when the factory may edit this issue's body: its App opened it, its body carries a split marker, and nobody else edited it. */
export function mayRewrite(_item: FactoryItem, _authorship: IssueAuthorship): boolean {
  throw new Error("mayRewrite: not implemented (PBI 264)");
}
