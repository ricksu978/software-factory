// The cell's git, through the git CLI in its checkout (plan Task 14). Tokens never touch .git/config: main.ts
// configures a credential helper that asks the cell API for a fresh token on demand.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export type Git = {
  /** Merges the base into the branch. Returns the paths still in conflict, empty when the merge is clean. */
  mergeBase(base: string): Promise<string[]>;
  /** Commits every change, deletions included. Returns HEAD, unchanged when there's nothing to commit. */
  commitAll(msg: string): Promise<string>;
  push(): Promise<void>;
  head(): Promise<string>;
};

/** Runs one git command in `cwd`. It rejects as execFile does, with the exit code, signal and stderr on the error. */
export type GitExec = (args: string[], opts: { cwd: string }) => Promise<{ stdout: string; stderr: string }>;

/**
 * What the cell's git runs on, for tests: the command runner and the clock it waits on between tries (PBI 259).
 * Each defaults to the real one.
 */
export type GitDeps = {
  exec?: GitExec;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
};

const execGit: GitExec = (args, opts) => run("git", args, { cwd: opts.cwd, maxBuffer: 64 * 1024 * 1024 });

export function shellGit(dir: string, branch: string, deps: GitDeps = {}): Git {
  const exec = deps.exec ?? execGit;
  const git = async (...args: string[]) => (await exec(args, { cwd: dir })).stdout.trim();
  const unmerged = async () => (await git("diff", "--name-only", "--diff-filter=U")).split("\n").filter(Boolean);
  return {
    async mergeBase(base) {
      // A merge an agent left half done is still a conflict, whatever the base holds now.
      const left = await unmerged();
      if (left.length) return left;
      await git("fetch", "-q", "origin", base);
      try {
        await git("merge", "-q", "--no-edit", `origin/${base}`);
        return [];
      } catch (e) {
        const paths = await unmerged();
        if (paths.length) return paths;
        throw e;
      }
    },
    async commitAll(msg) {
      await git("add", "-A");
      try {
        await git("diff", "--cached", "--quiet");
      } catch {
        await git("commit", "-q", "-m", msg);
      }
      return git("rev-parse", "HEAD");
    },
    async push() {
      await git("push", "-q", "origin", `HEAD:refs/heads/${branch}`);
    },
    head: () => git("rev-parse", "HEAD"),
  };
}

/**
 * Clones `branch` into `dir`, or the base when the branch doesn't exist yet, and starts the branch from it.
 * `helper` is the credential helper command, set for the clone and kept in the checkout's config.
 */
export async function cloneRun(url: string, branch: string, base: string, dir: string, helper: string): Promise<void> {
  const cred = ["-c", "credential.helper=", "-c", `credential.helper=${helper}`];
  const exists = (await run("git", [...cred, "ls-remote", "--heads", url, branch])).stdout.trim() !== "";
  await run("git", [...cred, "clone", "-q", "-b", exists ? branch : base, url, dir]);
  const git = (...args: string[]) => run("git", args, { cwd: dir });
  await git("config", "credential.helper", helper);
  await git("config", "user.name", "software-factory");
  await git("config", "user.email", "software-factory@users.noreply.github.com");
  if (!exists) await git("checkout", "-q", "-b", branch);
}
