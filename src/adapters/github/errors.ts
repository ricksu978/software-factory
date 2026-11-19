// Telling a GitHub outage from the factory's own fault (PBI 259). Octokit throws a RequestError, named HttpError,
// with GitHub's status, and with status 500 when the request never got an answer (refused, reset, timed out); an
// aborted request keeps its AbortError name with status 500.

/** True when `e` is Octokit's error for GitHub answering 5xx, or for GitHub not answering at all. */
export function githubFailed(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const x = e as { name?: unknown; status?: unknown };
  if (typeof x.status !== "number" || x.status < 500 || x.status > 599) return false;
  return x.name === "HttpError" || x.name === "AbortError" || x.name === "TimeoutError";
}
