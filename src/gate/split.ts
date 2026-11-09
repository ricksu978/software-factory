// A proposed split of an oversized item (PBI 143). The readiness judge's last line says whether the item is too big
// for one Sprint, beside its flags. When it is, the gate asks the SOP's coding model for 2 to 4 child items, checks
// the split, and posts a valid one on the parent as its own comment. Being oversized never decides readiness.
import type { AgentArgs, AgentResult } from "../agent/run.ts";

/** One proposed child. `criteria` holds 1-based indices of the parent's acceptance criteria, `needs` 1-based child numbers. */
export type SplitChild = { title: string; body: string; criteria: number[]; needs: number[] };

/**
 * The coding model's reply carries one JSON line {"children":[{"title","body","criteria":[...],"needs":[...]}, ...]}.
 * A split is posted only when it's valid: 2 to 4 children, each with a title and a needs list naming earlier
 * children only, and every parent criterion given to exactly one child.
 */
export type SplitOutcome = { proposed: true; children: SplitChild[] } | { proposed: false; reason: string };

/** What the gate needs to ask for a split: the SOP, for its coding model, and the agent runner. */
export type SplitDeps = { sop: { models: { coding: string } }; agent: (a: AgentArgs) => Promise<AgentResult> };

/** Every split proposal comment opens with this line, so it never reads as the readiness comment. */
export const SPLIT_HEADING = "The factory proposes splitting this item into smaller items:";
