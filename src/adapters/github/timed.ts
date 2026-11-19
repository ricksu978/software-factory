// A time limit on every request to GitHub (PBI 259). Without one, a GitHub that hangs fails only when undici gives up
// after about 300 seconds, long after the cell stops waiting on its call (90 seconds), so the cell never sees the 503
// and the hung handler holds the run's row lock. With it, Octokit turns the timeout into its HttpError with status
// 500, which githubFailed reads as GitHub failing, and the cell API answers 503 in time for the cell to retry.
import { Octokit } from "@octokit/core";

/** How long one request to GitHub may take before it's dropped as GitHub failing; well under the cell's 90 seconds. */
export const GITHUB_REQUEST_TIMEOUT_MS = 30_000;

/** `fetch`, but aborted with a TimeoutError after `ms`, on top of any signal the caller passed. */
export function timedFetch(ms: number, base: typeof fetch = fetch): typeof fetch {
  const wrapped = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const limit = AbortSignal.timeout(ms);
    const signal = init?.signal ? AbortSignal.any([init.signal, limit]) : limit;
    return base(input, { ...init, signal });
  };
  return wrapped as typeof fetch;
}

/** Octokit whose every request, and every installation client an App builds from it, has the time limit. */
export const TimedOctokit = Octokit.defaults({ request: { fetch: timedFetch(GITHUB_REQUEST_TIMEOUT_MS) } });
