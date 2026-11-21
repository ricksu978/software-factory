import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fakeClock } from "../clock.ts";
import { minutes, seconds, watch } from "./slow-work.ts";

const MIN = 60_000;

describe("watch", () => {
  test("warns nothing before the first warning is due", async () => {
    const clock = fakeClock();
    const lines: string[] = [];
    watch(5 * MIN, 5 * MIN, (ms) => `ran ${ms}`, { clock, log: (l) => lines.push(l) });
    await clock.advance(5 * MIN - 1);
    assert.deepEqual(lines, []);
  });

  test("warns at the first mark and every interval after, with the running time and the current step", async () => {
    const clock = fakeClock();
    const lines: string[] = [];
    const w = watch(5 * MIN, 5 * MIN, (ms, step) => `${ms / MIN} ${step}`, { clock, log: (l) => lines.push(l) });
    w.step("a");
    await clock.advance(6 * MIN);
    w.step("b");
    await clock.advance(9 * MIN);
    assert.deepEqual(lines, ["5 a", "10 b", "15 b"]);
  });

  test("warns once when there is no interval", async () => {
    const clock = fakeClock();
    const lines: string[] = [];
    watch(60_000, null, (ms) => `open ${ms}`, { clock, log: (l) => lines.push(l) });
    await clock.advance(10 * MIN);
    assert.deepEqual(lines, ["open 60000"]);
    assert.equal(clock.pending(), 0);
  });

  test("stops warning once it ends, and leaves no timer behind", async () => {
    const clock = fakeClock();
    const lines: string[] = [];
    const w = watch(5 * MIN, 5 * MIN, () => "slow", { clock, log: (l) => lines.push(l) });
    await clock.advance(7 * MIN);
    w.end();
    await clock.advance(20 * MIN);
    assert.deepEqual(lines, ["slow"]);
    assert.equal(clock.pending(), 0);
  });

  test("ending before the first mark warns nothing", async () => {
    const clock = fakeClock();
    const lines: string[] = [];
    const w = watch(5 * MIN, 5 * MIN, () => "slow", { clock, log: (l) => lines.push(l) });
    await clock.advance(4 * MIN);
    w.end();
    await clock.advance(20 * MIN);
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
