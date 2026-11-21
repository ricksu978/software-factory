// The clock the worker sets its timers and reads its times through (PBI 396). The worker's scheduler tick, outbox
// loop, board polls, standby lock retry and holder lock check all run on it, and each tick's time is its now(). A
// worker given no clock runs on realClock. A test hands it a fakeClock, which stands still until the test moves it on.

/** Sets timers and tells the time. */
export type Clock = {
  now(): Date;
  /** Calls `fn` once `ms` have passed. A fake clock waits for what `fn` returns before it fires the next timer. */
  setTimeout(fn: () => unknown, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

/** A clock that stands still until advance() moves it on. */
export type FakeClock = Clock & {
  /**
   * Moves the clock `ms` on, firing each timer that falls due in that time, in order, each at its own time, and waits
   * for the work each one starts before it fires the next.
   */
  advance(ms: number): Promise<void>;
};

/** The process's own clock and timers. */
export const realClock: Clock = {
  now: () => new Date(),
  setTimeout: (fn, ms) => setTimeout(() => void fn(), ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

type Timer = { at: number; seq: number; fn: () => unknown };

/**
 * A fake clock that reads `start` and sets no timer on the real clock. A timer falls due `ms` after the clock's time
 * when it was set. Timers due at the same time fire in the order they were set. Moves overlapping one another run one
 * after the other.
 */
export function fakeClock(start: Date = new Date(0)): FakeClock {
  let at = start.getTime();
  let seq = 0;
  const timers = new Set<Timer>();
  let moving = Promise.resolve();
  const next = (until: number) => {
    let first: Timer | undefined;
    for (const t of timers) if (t.at <= until && (!first || t.at < first.at || (t.at === first.at && t.seq < first.seq))) first = t;
    return first;
  };
  const move = async (ms: number) => {
    const until = at + Math.max(ms, 0);
    for (let t = next(until); t; t = next(until)) {
      timers.delete(t);
      at = Math.max(at, t.at);
      await t.fn();
    }
    at = until;
  };
  return {
    now: () => new Date(at),
    setTimeout(fn, ms) {
      const t: Timer = { at: at + Math.max(Number(ms) || 0, 0), seq: seq++, fn };
      timers.add(t);
      return t;
    },
    clearTimeout(handle) {
      timers.delete(handle as Timer);
    },
    advance(ms) {
      const done = moving.then(() => move(ms));
      moving = done.catch(() => {});
      return done;
    },
  };
}
