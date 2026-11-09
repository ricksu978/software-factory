import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { minutes, seconds, watch, type Clock } from "./slow-work.ts";

/** A clock that only moves when told to, firing each timer that falls due in order. */
function fakeClock(): Clock & { advance(ms: number): void; pending(): number } {
  let t = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimeout(fn, ms) {
      timers.set(++seq, { at: t + ms, fn });
      return seq;
    },
    clearTimeout: (h) => void timers.delete(h as number),
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
      }
      t = end;
    },
    pending: () => timers.size,
  };
}

const MIN = 60_000;

describe("watch", () => {
  test("warns nothing before the first warning is due", () => {
    const clock = fakeClock();
    const lines: string[] = [];
    watch(5 * MIN, 5 * MIN, (ms) => `ran ${ms}`, { clock, log: (l) => lines.push(l) });
    clock.advance(5 * MIN - 1);
    assert.deepEqual(lines, []);
  });

  test("warns at the first mark and every interval after, with the running time and the current step", () => {
    const clock = fakeClock();
    const lines: string[] = [];
    const w = watch(5 * MIN, 5 * MIN, (ms, step) => `${ms / MIN} ${step}`, { clock, log: (l) => lines.push(l) });
    w.step("a");
    clock.advance(6 * MIN);
    w.step("b");
    clock.advance(9 * MIN);
    assert.deepEqual(lines, ["5 a", "10 b", "15 b"]);
  });

  test("warns once when there is no interval", () => {
    const clock = fakeClock();
    const lines: string[] = [];
    watch(60_000, null, (ms) => `open ${ms}`, { clock, log: (l) => lines.push(l) });
    clock.advance(10 * MIN);
    assert.deepEqual(lines, ["open 60000"]);
    assert.equal(clock.pending(), 0);
  });

  test("stops warning once it ends, and leaves no timer behind", () => {
    const clock = fakeClock();
    const lines: string[] = [];
    const w = watch(5 * MIN, 5 * MIN, () => "slow", { clock, log: (l) => lines.push(l) });
    clock.advance(7 * MIN);
    w.end();
    clock.advance(20 * MIN);
    assert.deepEqual(lines, ["slow"]);
    assert.equal(clock.pending(), 0);
  });

  test("ending before the first mark warns nothing", () => {
    const clock = fakeClock();
    const lines: string[] = [];
    const w = watch(5 * MIN, 5 * MIN, () => "slow", { clock, log: (l) => lines.push(l) });
    clock.advance(4 * MIN);
    w.end();
    clock.advance(20 * MIN);
    assert.deepEqual(lines, []);
  });
});

describe("minutes and seconds", () => {
  test("say a whole count with the right plural", () => {
    assert.equal(minutes(5 * MIN), "5 minutes");
    assert.equal(minutes(MIN), "1 minute");
    assert.equal(seconds(60_000), "60 seconds");
    assert.equal(seconds(1000), "1 second");
  });
});
