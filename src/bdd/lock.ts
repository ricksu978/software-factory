import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// True when none of the locked files differ between the lock commit and HEAD (spec §6 "The lock").
// Only the locked files are diffed, so other items merged into the branch never trip it.
export async function matchesLock(repoDir: string, lockSha: string, files: string[]): Promise<boolean> {
  // An empty path list would diff the whole tree, so refuse it rather than guess.
  if (files.length === 0) throw new Error("matchesLock needs at least one locked file");
  try {
    await run("git", ["diff", "--quiet", lockSha, "HEAD", "--", ...files], { cwd: repoDir });
    return true;
  } catch (e) {
    if ((e as { code?: unknown }).code === 1) return false; // git diff --quiet exits 1 when the files differ
    throw e;
  }
}
