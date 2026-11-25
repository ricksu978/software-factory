// The fake clocks of the workers a scenario starts in this process (PBI 396). PBI 157's and PBI 158's steps start each
// of their workers on one, made here and kept on the scenario's world, and move them all on together wherever they
// waited on the real clock before for a lock retry, a tick or a heartbeat. A scenario that made none waits on the real
// clock as before, so PBI 156's steps, which PBI 157 and PBI 158 share, behave as they did for every other feature.
//
// Moving on goes a chunk at a time, every clock by the same amount at once, with a short real pause between chunks. The
// pause lets the work a worker starts outside a timer, such as the first tick after a takeover, reach the database, and
// lets a step's check see it before the clocks move further on.
import assert from "node:assert/strict";
import { fakeClock, type FakeClock } from "../../src/clock.ts";

/** How far each chunk moves the clocks on: under every interval PBI 157's and PBI 158's workers run at but PBI 156's tick. */
const CHUNK_MS = 250;
/** The real pause between chunks. */
const PAUSE_MS = 5;

const clocks = new WeakMap<object, FakeClock[]>();
/** How far the scenario's fake clocks have moved on in all, in milliseconds. */
const movedBy = new WeakMap<object, number>();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A new fake clock for one of the scenario's workers. It reads the real time it was made at, as a new worker would. */
export function workerClock(world: object): FakeClock {
  const c = fakeClock(new Date());
  clocks.set(world, [...(clocks.get(world) ?? []), c]);
  return c;
}

/** Whether the scenario has started any worker on a fake clock. */
export const onFakeClocks = (world: object) => (clocks.get(world)?.length ?? 0) > 0;

/** How far the scenario's fake clocks have moved on since they were made, in milliseconds. */
export const moved = (world: object) => movedBy.get(world) ?? 0;

async function chunk(world: object, ms: number): Promise<void> {
  await Promise.all((clocks.get(world) ?? []).map((c) => c.advance(ms)));
  movedBy.set(world, moved(world) + ms);
  await sleep(PAUSE_MS);
}

/** Moves every fake clock of the scenario `ms` on, firing each timer that falls due and waiting for its work. */
export async function pass(world: object, ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= CHUNK_MS) await chunk(world, Math.min(left, CHUNK_MS));
}

/**
 * Whether `ok` holds within `realMs` real milliseconds, moving the scenario's fake clocks on while it doesn't. With no
 * fake clock, it checks on the real clock every 25 ms, as the steps did before. Given `fakeMs`, the clocks move no more
 * than that on, so a check bounded in a worker's own time fails once that time is used up, however fast it went by.
 */
export async function passWithin(world: object, realMs: number, ok: () => boolean | Promise<boolean>, fakeMs = Infinity): Promise<boolean> {
  const end = Date.now() + realMs;
  let left = fakeMs;
  while (!(await ok())) {
    if (Date.now() >= end) return false;
    if (onFakeClocks(world)) {
      if (left <= 0) return false;
      const ms = Math.min(left, CHUNK_MS);
      await chunk(world, ms);
      left -= ms;
    } else await sleep(25);
  }
  return true;
}

/** passWithin, failing with `timed out waiting until <what>`. */
export async function passUntil(world: object, what: string, ok: () => boolean | Promise<boolean>, realMs = 30_000, fakeMs = Infinity): Promise<void> {
  assert.ok(await passWithin(world, realMs, ok, fakeMs), `timed out waiting until ${what}`);
}
