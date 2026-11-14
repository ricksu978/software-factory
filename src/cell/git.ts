// The cell's git, through the git CLI in its checkout (plan Task 14). Tokens never touch .git/config: main.ts
// configures a credential helper that asks the cell API for a fresh token on demand.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realSleep, type RetryFence, withRetries } from "./retry.ts";

const run = promisify(execFile);

export type Git = {
  /**
   * Merges the base into the branch. Returns the paths still in conflict, empty when the merge is clean.
   * `fence` stops the fetch's retries, as for push.
   */
  mergeBase(base: string, fence?: RetryFence): Promise<string[]>;
  /** Commits every change, deletions included. Returns HEAD, unchanged when there's nothing to commit. */
  commitAll(msg: string): Promise<string>;
  /**
   * Pushes HEAD to the run's branch, retrying a network fault. `fence.signal` ends the retries and kills a push in
   * flight. `fence.beforeRetry` runs before each retry, so a lease check there keeps a fenced-off cell from pushing.
   */
  push(fence?: RetryFence): Promise<void>;
  head(): Promise<string>;
};

/** Runs one git command in `cwd`. It rejects as execFile does, with the exit code, signal and stderr on the error. */
export type GitExec = (args: string[], opts: { cwd: string; timeout?: number; signal?: AbortSignal }) => Promise<{ stdout: string; stderr: string }>;

/** How long one git push or fetch may run before it's killed and counts as a timeout (PBI 259). */
export const REMOTE_TIMEOUT_MS = 10 * 60_000;

// What git and curl print when the network, a proxy or GitHub's front end failed, rather than GitHub refusing the
// request: a host that can't be resolved or reached, a dropped connection, a timeout, or a 5xx from GitHub or a proxy.
const NETWORK_FAULT = new RegExp([
  "Could not resolve (host|proxy)", "Failed to connect", "Couldn't connect to server", "Connection (reset|refused|timed out)",
  "Operation timed out", "early EOF", "unexpected disconnect", "CONNECT tunnel failed, response 5\\d\\d", "HTTP 5\\d\\d",
  "returned error: 5\\d\\d",
].join("|"), "i");

/**
 * True when a failed git command failed on the network, a proxy 5xx or its time limit, so trying it again may work.
 * A push GitHub rejects, a 4xx or a ref that doesn't exist isn't one.
 */
export function gitNetworkFault(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const x = e as Error & { killed?: boolean; signal?: string | null; stderr?: string };
  if (x.killed || x.signal) return true;
  return NETWORK_FAULT.test(x.stderr ?? "");
}

/**
 * What the cell's git runs on, for tests: the command runner and the clock it waits on between tries (PBI 259).
 * Each defaults to the real one.
 */
export type GitDeps = {
  exec?: GitExec;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
};

const execGit: GitExec = (args, opts) => run("git", args, { cwd: opts.cwd, timeout: opts.timeout, signal: opts.signal, maxBuffer: 64 * 1024 * 1024 });

export function shellGit(dir: string, branch: string, deps: GitDeps = {}): Git {
  const exec = deps.exec ?? execGit;
  const sleep = deps.sleep ?? realSleep;
  const git = async (...args: string[]) => (await exec(args, { cwd: dir })).stdout.trim();
  // A push or fetch talks to GitHub, so a network fault is retried, and it has a time limit (PBI 259). The fence's
  // signal kills the git child and ends the retries.
  const remote = (fence: RetryFence, ...args: string[]) =>
    withRetries(`git ${args[0]}`, (signal) => exec(args, { cwd: dir, timeout: REMOTE_TIMEOUT_MS, signal }),
      { transient: gitNetworkFault, sleep, ...fence });
  const unmerged = async () => (await git("diff", "--name-only", "--diff-filter=U")).split("\n").filter(Boolean);
  return {
    async mergeBase(base, fence = {}) {
      // A merge an agent left half done is still a conflict, whatever the base holds now.
      const left = await unmerged();
      if (left.length) return left;
      await remote(fence, "fetch", "-q", "origin", base);
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
    async push(fence = {}) {
      await remote(fence, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
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
