// Retries for the cell's calls to the outside world (PBI 259): the cell API, and git push and fetch against GitHub.
// A call that fails on the network, a 5xx or a timeout is tried again after a wait, at least 3 more times over at
// least 2 minutes. Anything else, such as a 4xx answer or a rejected push, fails at once as before.

/** The waits between tries: 5 tries, the last 150 seconds after the first. */
export const RETRY_WAITS_MS = [10_000, 20_000, 40_000, 80_000];

/** A try that failed on the network or on GitHub, so it's worth trying again. */
export class Transient extends Error {
  override name = "Transient";
}

/** A call that still failed on the network or on GitHub after all its tries. Its message names the call and the count. */
export class NetworkError extends Error {
  override name = "NetworkError";
  readonly tries: number;
  constructor(what: string, tries: number, last: unknown) {
    super(`${what} failed on a network or GitHub error after ${tries} tries: ${last instanceof Error ? last.message : String(last)}`, { cause: last });
    this.tries = tries;
  }
}

/**
 * What stops a retry loop early. `signal` ends it, mid-try or mid-wait, with its reason. `beforeRetry` runs before
 * every try after the first, and its throw ends the loop: a git push checks the lease there, so a cell that lost its
 * lease while it waited pushes nothing (PBI 259).
 */
export type RetryFence = { signal?: AbortSignal; beforeRetry?: () => Promise<void> };

const reasonOf = (s: AbortSignal) => (s.reason instanceof Error ? s.reason : new Error("aborted"));

/**
 * Runs `once` until it succeeds or fails on something `transient` doesn't accept, waiting `waits` between tries.
 * After the last wait a transient failure throws NetworkError, naming `what` and the number of tries.
 * `once` gets the signal, so it can kill what it started when the loop is aborted.
 */
export async function withRetries<T>(
  what: string,
  once: (signal?: AbortSignal) => Promise<T>,
  opts: { transient: (e: unknown) => boolean; sleep: (ms: number) => Promise<void>; waits?: number[] } & RetryFence,
): Promise<T> {
  const waits = opts.waits ?? RETRY_WAITS_MS;
  const { signal } = opts;
  for (let n = 0; ; n++) {
    if (signal?.aborted) throw reasonOf(signal);
    if (n > 0 && opts.beforeRetry) await opts.beforeRetry();
    if (signal?.aborted) throw reasonOf(signal);
    try {
      return await once(signal);
    } catch (e) {
      // A try killed by the abort isn't a network fault, whatever it looks like.
      if (signal?.aborted) throw reasonOf(signal);
      if (!opts.transient(e)) throw e;
      if (n >= waits.length) throw new NetworkError(what, n + 1, e);
      await abortable(opts.sleep(waits[n]), signal);
    }
  }
}

/** Waits for `p`, or rejects with the signal's reason as soon as it aborts. */
function abortable(p: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(reasonOf(signal));
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(reasonOf(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
