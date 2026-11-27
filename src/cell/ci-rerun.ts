// PBI 233: a red CI on a commit a stage pushed has its failed checks re-run once before it is charged to the attempt.
// A flaky check that passes on the re-run costs no attempt. These are the sentences the stage's message carries about it.
import type { CiCheck } from "../adapters/types.ts";

const short = (sha: string) => sha.slice(0, 7);

/** The checks that failed, each named once. A check that passed or still runs isn't one. */
export function failedNames(checks: CiCheck[] | null): string[] {
  return [...new Set((checks ?? []).filter((c) => c.conclusion === "failure").map((c) => c.name))];
}

/**
 * One sentence per re-run check: it passed, failed again, was cancelled, or hadn't finished on the re-run. `after` is each check as the re-run left it;
 * when it couldn't be read, CI's overall answer `status` stands for every check.
 */
export function rerunNotes(sha: string, rerun: string[], status: "success" | "failure" | "cancelled", after: CiCheck[] | null): string[] {
  return rerun.map((name) => {
    const head = `The check "${name}" failed on ${short(sha)}, so the factory re-ran it once, and`;
    if (!after) {
      if (status === "cancelled") return `${head} CI's run was cancelled after the re-run.`;
      return status === "success" ? `${head} it passed on the re-run.` : `${head} CI was still red after the re-run.`;
    }
    const mine = after.filter((c) => c.name === name);
    if (mine.some((c) => c.conclusion === "failure")) return `${head} it failed again on the re-run.`;
    // A check whose re-run hasn't finished hasn't passed.
    if (mine.some((c) => c.conclusion === "pending")) return `${head} its re-run hadn't finished when CI was read.`;
    // PBI 423: a cancelled re-run neither failed nor passed.
    if (mine.some((c) => c.conclusion === "cancelled")) return `${head} its re-run was cancelled.`;
    return `${head} it passed on the re-run.`;
  });
}

/** One sentence per check the repo host wouldn't re-run, with why, so the failure is charged as it stands. */
export function refusedNotes(sha: string, checks: string[], e: unknown): string[] {
  const why = (e instanceof Error ? e.message : String(e)).split("\n")[0].trim();
  return checks.map((name) => `The check "${name}" failed on ${short(sha)}, and the factory couldn't re-run it${why ? ` (${why})` : ""}, so the failure stands.`);
}
