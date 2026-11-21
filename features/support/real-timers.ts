// Which timers the factory's own code sets on the process's real clock (PBI 396). The process's setTimeout and
// setInterval, the global ones and node:timers' alike, are wrapped once, here, before any step file or src module loads,
// so code that reads them later gets the wrapped ones.
//
// A timer counts when the code that set it is the factory's own: the nearest caller frame, past Node's internals, is a
// file under src/ that isn't a test. A timer pg or another package sets itself doesn't count.
//
// - In process, a step starts a worker inside trackTimers(tag, ...). Every async continuation of that start carries the
//   tag, so the timers that worker sets, and only those, are kept under it, for realTimers(tag) to read.
// - A whole cucumber run records every such timer of its process to the file PBI396_REAL_TIMERS names, one JSON line
//   each, after a first line that says the spy was installed. PBI 396's @ac-5 steps set it for the runs they start.
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, sep } from "node:path";
import timers from "node:timers";
import { fileURLToPath } from "node:url";

export type RealTimer = { kind: "setTimeout" | "setInterval"; ms: number; caller: string; stack: string };

const als = new AsyncLocalStorage<string>();
const kept = new Map<string, RealTimer[]>();
const SRC = join(process.cwd(), "src") + sep;
const RECORD = process.env.PBI396_REAL_TIMERS;
const HERE = fileURLToPath(import.meta.url);

/** The file of a stack frame, or undefined for one with none. */
function frameFile(line: string): string | undefined {
  const m = /\((.*?):\d+:\d+\)$/.exec(line) ?? /at (?:async )?(.*?):\d+:\d+$/.exec(line);
  if (!m) return undefined;
  const f = m[1];
  return f.startsWith("file://") ? fileURLToPath(f) : f;
}

/** The nearest caller outside this file and Node's internals, with the whole stack. */
function caller(): { file: string; stack: string } | undefined {
  const stack = new Error().stack ?? "";
  for (const line of stack.split("\n").slice(1)) {
    const f = frameFile(line.trim());
    if (!f || f === HERE || f.startsWith("node:") || f === "<anonymous>") continue;
    return { file: f, stack };
  }
  return undefined;
}

const own = (file: string) => file.startsWith(SRC) && !/\.test\.ts$/.test(file);

if (RECORD) appendFileSync(RECORD, `${JSON.stringify({ installed: process.pid })}\n`);

function wrap<F extends (...args: any[]) => unknown>(kind: RealTimer["kind"], original: F): F {
  const wrapped = function (this: unknown, ...args: unknown[]) {
    const tag = als.getStore();
    if (tag !== undefined || RECORD) {
      const c = caller();
      if (c && own(c.file)) {
        const t: RealTimer = { kind, ms: Number(args[1] ?? 0), caller: c.file, stack: c.stack };
        if (tag !== undefined) {
          const list = kept.get(tag) ?? [];
          list.push(t);
          kept.set(tag, list);
        }
        if (RECORD) appendFileSync(RECORD, `${JSON.stringify({ pid: process.pid, ...t })}\n`);
      }
    }
    return original.apply(this, args);
  };
  // setTimeout's promisified form and the like.
  for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(original))) {
    if (k !== "length" && k !== "name" && k !== "prototype") Object.defineProperty(wrapped, k, d);
  }
  for (const s of Object.getOwnPropertySymbols(original)) Object.defineProperty(wrapped, s, Object.getOwnPropertyDescriptor(original, s)!);
  return wrapped as unknown as F;
}

const g = globalThis as { __pbi396Timers?: boolean };
if (!g.__pbi396Timers) {
  g.__pbi396Timers = true;
  const st = wrap("setTimeout", globalThis.setTimeout);
  const si = wrap("setInterval", globalThis.setInterval);
  globalThis.setTimeout = st;
  globalThis.setInterval = si;
  timers.setTimeout = st;
  timers.setInterval = si;
  syncBuiltinESMExports();
}

/** Runs `fn` so every timer the code it starts sets on the real clock is kept under `tag`. */
export function trackTimers<T>(tag: string, fn: () => T): T {
  kept.set(tag, kept.get(tag) ?? []);
  return als.run(tag, fn);
}

/** The timers code started under `tag` set on the real clock, in the order it set them. */
export function realTimers(tag: string): RealTimer[] {
  return kept.get(tag) ?? [];
}
