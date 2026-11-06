// Runs, stage runs and questions. Task 12 adds the naming helpers; Task 13 adds the scheduler's pins.

/** A run's branch, `factory/pbi-<externalId>-r<runNumber>` (Run contract 7), unless the run already recorded one. */
export function runBranch(run: { branch: string | null; externalId: string; runNumber: number }): string {
  return run.branch ?? `factory/pbi-${run.externalId}-r${run.runNumber}`;
}

/** `owner/name` from a repo row's url, which migrate writes as `https://github.com/<owner>/<name>`. */
export function repoName(url: string): string {
  return new URL(url).pathname.replace(/^\/|\/$/g, "");
}
