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
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** A fake clock that reads `start`. Not built yet (PBI 396): it neither fires timers nor moves. */
export function fakeClock(start: Date = new Date(0)): FakeClock {
  const at = start.getTime();
  return {
    now: () => new Date(at),
    setTimeout: () => undefined,
    clearTimeout: () => {},
    advance: async () => {},
  };
}
