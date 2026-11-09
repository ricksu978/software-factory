// Slow-work warnings (PBI 134). A database transaction that never ends can freeze the scheduler, the board poller or
// a cell API request with nothing in the log. Each of them times itself with `watch` and speaks up when it runs long:
//
//   slow: the scheduler tick has run for 5 minutes, in step "expiring leases"
//   slow: the poll of board <backlog_source.url> has run for 10 minutes, in step "listing new and changed items"
//   slow: the cell API request POST /stage for run <run id> has been open for 60 seconds
//
// A tick or a poll warns at 5 minutes and every 5 minutes after, naming the step it is in at that moment. A cell API
// request warns at 60 seconds. Every warning stops once the work ends, whether it ended well or with an error.
//
// The tick's steps: "applying overrides", "stopping every cell", "expiring leases", "chasing questions", "polling
// merged CI" and "starting the next item". The poll's steps: "reading the board", "listing new and changed items",
// "reading the PRs of items in review", "checking the items the factory holds", "checking readiness" and "saving the
// cursor".

export const SLOW_TICK_MS = 300_000;
export const SLOW_POLL_MS = 300_000;
export const SLOW_REQUEST_MS = 60_000;

/** The clock a watch reads and the timers it sets. Tests pass a fake one to move time on by hand. */
export type Clock = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** Where slow-work warnings go, console.warn by default, and the clock that times them, the real one by default. */
export type Slow = { log?: (line: string) => void; clock?: Clock };

/** A running watch. `step` names what the work is doing now, and `end` stops the warnings. */
export type Watch = { step(name: string): void; end(): void };

/**
 * Starts timing a piece of work and logs `say(runningMs, step)` after `firstMs`, then every `everyMs` until `end`. A
 * null `everyMs` warns once. `step` is the name last passed to `Watch.step`, or "" before any.
 */
export function watch(firstMs: number, everyMs: number | null, say: (ms: number, step: string) => string, slow: Slow = {}): Watch {
  const clock = slow.clock ?? realClock;
  const log = slow.log ?? ((line: string) => console.warn(line));
  const started = clock.now();
  let step = "";
  let handle: unknown = null;
  const fire = () => {
    handle = everyMs === null ? null : clock.setTimeout(fire, everyMs);
    log(say(clock.now() - started, step));
  };
  handle = clock.setTimeout(fire, firstMs);
  return {
    step(name) {
      step = name;
    },
    end() {
      if (handle !== null) clock.clearTimeout(handle);
      handle = null;
    },
  };
}

/** Runs `fn` under a watch and ends the watch however `fn` ends. */
export async function watched<T>(w: Watch, fn: (w: Watch) => Promise<T>): Promise<T> {
  try {
    return await fn(w);
  } finally {
    w.end();
  }
}

const count = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
/** "5 minutes", from a running time in milliseconds. */
export const minutes = (ms: number) => count(Math.floor(ms / 60_000), "minute");
/** "60 seconds", from a running time in milliseconds. */
export const seconds = (ms: number) => count(Math.floor(ms / 1000), "second");
