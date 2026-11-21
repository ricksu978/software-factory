import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeClock, realClock } from "./clock.ts";

test("a fake clock reads its start and stands still until moved on", async () => {
  const c = fakeClock(new Date("2026-01-01T09:00:00Z"));
  assert.equal(c.now().toISOString(), "2026-01-01T09:00:00.000Z");
  await c.advance(15_000);
  assert.equal(c.now().toISOString(), "2026-01-01T09:00:15.000Z");
});

test("a fake clock fires a timer only once it has moved the timer's whole wait on", async () => {
  const c = fakeClock();
  let fired = 0;
  c.setTimeout(() => fired++, 15_000);
  await c.advance(14_999);
  assert.equal(fired, 0);
  await c.advance(1);
  assert.equal(fired, 1);
  await c.advance(60_000);
  assert.equal(fired, 1);
});

test("each timer fires at its own time, in order, and a cleared one never fires", async () => {
  const c = fakeClock(new Date(0));
  const seen: [string, number][] = [];
  c.setTimeout(() => seen.push(["b", c.now().getTime()]), 2_000);
  c.setTimeout(() => seen.push(["a", c.now().getTime()]), 1_000);
  c.setTimeout(() => seen.push(["c", c.now().getTime()]), 2_000);
  const gone = c.setTimeout(() => seen.push(["x", c.now().getTime()]), 500);
  c.clearTimeout(gone);
  await c.advance(5_000);
  assert.deepEqual(seen, [["a", 1_000], ["b", 2_000], ["c", 2_000]]);
  assert.equal(c.now().getTime(), 5_000);
});

test("a fake clock waits for each timer's work, and fires the timers that work sets within the same move", async () => {
  const c = fakeClock(new Date(0));
  const runs: { start: number; end: number; at: number }[] = [];
  let busy = false;
  const work = async () => {
    assert.equal(busy, false, "two runs overlapped");
    busy = true;
    const start = performance.now();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    runs.push({ start, end: performance.now(), at: c.now().getTime() });
    busy = false;
    c.setTimeout(work, 3_000);
  };
  c.setTimeout(work, 3_000);
  await c.advance(45_000);
  assert.equal(runs.length, 15);
  assert.deepEqual(runs.map((r) => r.at), Array.from({ length: 15 }, (_, i) => (i + 1) * 3_000));
  await c.advance(2_999);
  assert.equal(runs.length, 15);
});

test("moves called together run one after the other", async () => {
  const c = fakeClock(new Date(0));
  const at: number[] = [];
  const tick = () => {
    at.push(c.now().getTime());
    c.setTimeout(tick, 1_000);
  };
  c.setTimeout(tick, 1_000);
  await Promise.all([c.advance(2_000), c.advance(2_000)]);
  assert.deepEqual(at, [1_000, 2_000, 3_000, 4_000]);
});

test("the real clock fires a timer on the process's own clock", async () => {
  const before = Date.now();
  assert.ok(Math.abs(realClock.now().getTime() - before) < 1_000);
  await new Promise<void>((resolve) => realClock.setTimeout(resolve, 5));
  const h = realClock.setTimeout(() => assert.fail("a cleared timer fired"), 5);
  realClock.clearTimeout(h);
  await new Promise((r) => setTimeout(r, 20));
});
