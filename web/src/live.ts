// Floor's live updates (redesign step 8c, 2026-11-07 design §05 and §07, PBI 280), kept free of React and of the
// browser's globals so it runs in Node against stand-ins, as the shell does.
//   - Floor follows the factory's events: it reads GET /bff/v1/events through the shell's call, a text/event-stream
//     whose `data:` lines are the API's /v1/events notifications. An event reads the floor again, after SETTLE_MS, so
//     a burst of events reads it once.
//   - The API ends each stream after five minutes, and a stream can drop. When one ends, Floor opens a new one, first
//     after RETRY_MS and then waiting longer after each attempt that fails, up to RETRY_MAX_MS, so it doesn't hammer a
//     BFF that can't open one. Once a new stream is open, Floor reads the floor again, to catch up on what it missed.
//     A 401 is the shell's to handle (it sends the browser to /auth/login), and Floor stops following.
//   - A worker that is ticking writes no event, so Floor also reads the floor every POLL_MS with no event.
//   - While the Controls' Reason field has focus or holds text, Floor reads nothing, so the reason isn't lost. It
//     catches up once the field is empty and has lost focus.
// The browser's Floor page starts it with the real clock, and the scenarios with a fake one. A timer's callback
// returns nothing long-lived, since a fake clock waits for what it returns.
import type { Call, FloorData } from "./api.ts";

export const EVENTS_PATH = "/bff/v1/events";
/** How long Floor waits after an event for more before it reads the floor. */
export const SETTLE_MS = 250;
/** The wait before the first attempt to open a new stream, and the least between one attempt and the next. */
export const RETRY_MS = 1_000;
/** The longest wait between attempts to open a stream. */
export const RETRY_MAX_MS = 15_000;
/** How often Floor reads the floor with no event, so it sees a heartbeat go stale. */
export const POLL_MS = 30_000;

/** The timers Floor sets, and the time. The browser's is the real clock. */
export type LiveClock = {
  now(): Date;
  setTimeout(fn: () => unknown, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type LiveFloorEnv = {
  call: Call;
  clock: LiveClock;
  /** Gets each fresh read of the floor, for Floor to draw. */
  onFloor(data: FloorData): void;
};

/** What the Controls' Reason field holds, and whether it has focus. */
export type ReasonField = { value: string; focused: boolean };

export type LiveFloor = {
  /** Tells Floor what the Reason field holds and whether it has focus, each time either changes. */
  reasonField(field: ReasonField): void;
  /** Stops following the events: closes the stream and clears every timer. */
  stop(): void;
};

/** Starts following the factory's events for Floor, which has already drawn from one read. */
export function startLiveFloor(env: LiveFloorEnv): LiveFloor {
  void env;
  return {
    reasonField() {},
    stop() {},
  };
}
