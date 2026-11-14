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
 * Runs `once` until it succeeds or fails on something `transient` doesn't accept, waiting `waits` between tries.
 * After the last wait a transient failure throws NetworkError, naming `what` and the number of tries.
 */
export async function withRetries<T>(
  what: string,
  once: () => Promise<T>,
  opts: { transient: (e: unknown) => boolean; sleep: (ms: number) => Promise<void>; waits?: number[] },
): Promise<T> {
  const waits = opts.waits ?? RETRY_WAITS_MS;
  for (let n = 0; ; n++) {
    try {
      return await once();
    } catch (e) {
      if (!opts.transient(e)) throw e;
      if (n >= waits.length) throw new NetworkError(what, n + 1, e);
      await opts.sleep(waits[n]);
    }
  }
}

export const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
