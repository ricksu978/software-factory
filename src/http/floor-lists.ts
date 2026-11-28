// PBI 430: Floor's two lists, "Waiting on you" and "Production Line", in place of its eight sections. routes.ts's
// floor() reads the rows from the database. twoLists puts them in order and makes sure no item shows twice. Today's
// Floor, the SPA's Floor and GET /v1/floor all show what it returns.
import type { CiFailure, Issue, OpenPr } from "./views.ts";

/** "Production Line" holds up to this many rows, the InProgress items included. */
export const PRODUCTION_LINE_ROWS = 10;

/** The split parent a split child is part of, or null for an item that isn't one. */
export type PartOf = { id: string; external_id: string } | null;

/**
 * What a row of "Waiting on you" waits on. A question or sign-off waits from the oldest open question's asked_at. An
 * item in review waits from its move to InReview, a Not ready item from its move to NotReady, one that failed on main
 * from its move to Failed, and a feature change request (PBI 366) from its move to FeatureChangeRequest.
 */
export type WaitingWhy = "sign-off" | "question" | "review" | "not-ready" | "failed-on-main" | "feature-change";

export type WaitingOnYouRow = Issue & OpenPr & {
  id: string; title: string; state: string;
  /** When it began waiting, or null when the factory can't tell. */
  since: Date | null;
  why: WaitingWhy;
  /** The open question's text, for a question. */
  question?: string | null;
  /** The readiness lines it failed, for an item that's Not ready. */
  failed?: string[];
  /** When it was last re-checked, for an item that failed on main, or null before its first re-check. */
  rechecked?: Date | null;
  /** True for an item in FeatureChangeRequest (PBI 366). */
  feature_change?: boolean;
  partOf: PartOf;
};

/** A row of "Production Line". An InProgress row fills In flight's columns. A queued row leaves them null. */
export type ProductionLineRow = Issue & OpenPr & {
  id: string; title: string; state: string;
  stage: string | null;
  /** When its newest stage attempt started, for time in stage. */
  since: Date | null;
  cost: string | null;
  message: string | null;
  ci_failure: CiFailure | null;
  /** "held" and "override". */
  badges: string[];
  /** The external id of each open dependency it waits on. Empty for an item that waits on none. */
  waitsOn: string[];
  partOf: PartOf;
};

export type TwoLists = { waitingOnYou: WaitingOnYouRow[]; productionLine: ProductionLineRow[]; productionMore: number };

function once<T extends { id: string }>(rows: T[], taken: Set<string>): T[] {
  const out: T[] = [];
  for (const r of rows) {
    if (taken.has(r.id)) continue;
    taken.add(r.id);
    out.push(r);
  }
  return out;
}

/**
 * Puts the rows in their lists, each item once. "Waiting on you" takes every waiting row, oldest first, with any whose
 * time isn't known last. "Production Line" takes every InProgress row, then the queued rows: `claimable` in the claim's
 * own order, then the rest of `queue` that waits on no open dependency, such as a held item, then the rest that waits on
 * one, each in queue order. The queued rows fill what's left of PRODUCTION_LINE_ROWS, and `productionMore` counts the
 * ones that didn't fit. An item already in "Waiting on you" is left out of "Production Line".
 */
export function twoLists(input: { waiting: WaitingOnYouRow[]; inProgress: ProductionLineRow[]; claimable: ProductionLineRow[]; queue: ProductionLineRow[] }): TwoLists {
  const taken = new Set<string>();
  const time = (r: WaitingOnYouRow) => r.since?.getTime() ?? Number.POSITIVE_INFINITY;
  const waitingOnYou = once(input.waiting, taken).sort((a, b) => time(a) - time(b));
  const inProgress = once(input.inProgress, taken);
  const queued = once([
    ...input.claimable,
    ...input.queue.filter((r) => r.waitsOn.length === 0),
    ...input.queue.filter((r) => r.waitsOn.length > 0),
  ], taken);
  const room = Math.max(0, PRODUCTION_LINE_ROWS - inProgress.length);
  const shown = queued.slice(0, room);
  return { waitingOnYou, productionLine: [...inProgress, ...shown], productionMore: queued.length - shown.length };
}
