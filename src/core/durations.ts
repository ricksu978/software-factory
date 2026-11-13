// Where an item's time went, for Run detail (PBI 187). Pure: the caller reads the history and passes the clock.
import type { ItemState } from "./states.ts";

/** One move between states, from a transition or override event. */
export type Move = { from: ItemState; to: ItemState; at: Date };
/** `runEndedAt` is when the attempt's run ended, if it has: an attempt left open by a run that ended stops there. */
export type StageSpan = { stageId: string; startedAt: Date; endedAt: Date | null; runEndedAt?: Date | null };
export type QuestionSpan = { kind: "sign_off" | "needs_input"; askedAt: Date; answeredAt: Date | null; closedAt: Date | null };

export type ItemDurations = {
  /** From the issue's creation to Done, Failed or Abandoned, or to now while the item is open. Null with no creation time. */
  totalMs: number | null;
  /** Every spell Queued, waiting for a WIP slot. */
  queuedMs: number;
  waiting: { signOffMs: number; needsInputMs: number; inReviewMs: number; totalMs: number };
  /** Each stage that ran, in the order it first started, summed over its attempts in every run. */
  stages: { stageId: string; ms: number; attempts: number }[];
};

const ENDED: ItemState[] = ["Done", "Failed", "Abandoned"];

export function itemDurations(d: { createdAt: Date | null; state: ItemState; now: Date; moves: Move[]; stages: StageSpan[]; questions: QuestionSpan[] }): ItemDurations {
  const now = d.now.getTime();
  const moves = inOrder(d.moves);
  // An ended item stops at its last move into the state it's in. An item re-queued after Failed is open again.
  const endMove = ENDED.includes(d.state) ? moves.findLast((m) => m.to === d.state) : undefined;
  const end = endMove ? endMove.at.getTime() : now;
  // A spell that closed is counted as logged. Only an ended item's end cuts one short, such as a question left open.
  const span = (from: Date, to: number) => Math.max(0, (endMove ? Math.min(to, end) : to) - from.getTime());

  // Each move starts a spell in its `to` state that lasts until the next move, the last one until the end.
  const inState = new Map<ItemState, number>();
  moves.forEach((m, i) => inState.set(m.to, (inState.get(m.to) ?? 0) + span(m.at, moves[i + 1]?.at.getTime() ?? end)));

  const asked = (kind: QuestionSpan["kind"]) => d.questions
    .filter((q) => q.kind === kind)
    .reduce((ms, q) => ms + span(q.askedAt, (q.answeredAt ?? q.closedAt)?.getTime() ?? now), 0);
  const signOffMs = asked("sign_off");
  const needsInputMs = asked("needs_input");
  const inReviewMs = inState.get("InReview") ?? 0;

  const stages = new Map<string, { stageId: string; ms: number; attempts: number; first: number }>();
  for (const s of d.stages) {
    // A closed attempt counts as logged. One left open, as a stopped run or an expired lease leaves it, stops at its
    // run's end if that run ended, otherwise at the item's end, and runs up to now only while the item is open.
    const ms = s.endedAt ? Math.max(0, s.endedAt.getTime() - s.startedAt.getTime()) : span(s.startedAt, s.runEndedAt?.getTime() ?? now);
    const row = stages.get(s.stageId) ?? { stageId: s.stageId, ms: 0, attempts: 0, first: s.startedAt.getTime() };
    row.ms += ms;
    row.attempts += 1;
    row.first = Math.min(row.first, s.startedAt.getTime());
    stages.set(s.stageId, row);
  }

  return {
    totalMs: d.createdAt ? Math.max(0, end - d.createdAt.getTime()) : null,
    queuedMs: inState.get("Queued") ?? 0,
    waiting: { signOffMs, needsInputMs, inReviewMs, totalMs: signOffMs + needsInputMs + inReviewMs },
    stages: [...stages.values()].sort((a, b) => a.first - b.first).map(({ stageId, ms, attempts }) => ({ stageId, ms, attempts })),
  };
}

/**
 * The moves in time order. Moves logged at the same instant, such as InReview to Queued to InProgress, follow their
 * chain, each starting from the state the one before it left, since the log's ids don't order them.
 */
function inOrder(all: Move[]): Move[] {
  const left = [...all].sort((a, b) => a.at.getTime() - b.at.getTime());
  const out: Move[] = [];
  while (left.length) {
    const at = left[0].at.getTime();
    const prev = out.at(-1)?.to;
    const i = left.findIndex((m) => m.at.getTime() === at && m.from === prev);
    out.push(...left.splice(i < 0 ? 0 : i, 1));
  }
  return out;
}

const MINUTES_A_DAY = 24 * 60;

/** "6h 45m", or "1d 2h 30m" once a duration passes 24 hours. Seconds are dropped. */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  const hm = (m: number) => `${Math.floor(m / 60)}h ${m % 60}m`;
  return minutes > MINUTES_A_DAY ? `${Math.floor(minutes / MINUTES_A_DAY)}d ${hm(minutes % MINUTES_A_DAY)}` : hm(minutes);
}
