// The BDD suite's parallel rule (PBI 390 AC-2). A scenario tagged @serial, or in a feature tagged @serial, can't share
// the machine with another, so it runs alone: it starts only when no other scenario runs, and no scenario starts while
// it runs. Every other scenario shares the machine with any but a @serial one. features/support/parallel.ts hands
// canAssign to cucumber-js's setParallelCanAssign.
//
// cucumber-js 13.3.0 hands a worker its next scenario only as that worker finishes one, and a worker that finishes
// while nothing may start beside a running @serial scenario stays idle for the rest of the run. So a @serial scenario
// in the middle of the queue would leave the rest of the run to one worker. serialLast, which src/bdd/serial-last.ts
// hands cucumber-js as a plugin, puts every @serial scenario at the end of the queue, so the others all run in parallel
// first, and each @serial one starts once they've stopped.

export const SERIAL_TAG = "@serial";

type Tagged = { tags: readonly { name: string }[] };

export const isSerial = (pickle: Tagged) => pickle.tags.some((t) => t.name === SERIAL_TAG);

/** Whether `pickle` may start now, beside the scenarios `running`. */
export function canAssign(pickle: Tagged, running: readonly Tagged[]): boolean {
  if (isSerial(pickle)) return running.length === 0;
  return !running.some(isSerial);
}

/** `pickles` in their order, with the @serial ones moved to the end, still in their order. */
export function serialLast<T extends { pickle: Tagged }>(pickles: readonly T[]): T[] {
  return [...pickles.filter((p) => !isSerial(p.pickle)), ...pickles.filter((p) => isSerial(p.pickle))];
}
