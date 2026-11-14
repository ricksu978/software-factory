// The factory's default policies as `main` holds them (PBI 261). The worker reads each default from the commit of `main`
// it last fetched into the operator's checkout, the commit it builds the cell image from, so a merged change to one
// takes effect on the next poll with no restart, and an edit or a local commit in the checkout never counts. Cells
// keep reading the defaults baked into their image.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DefaultPolicies, PolicyName } from "../policy/policy.ts";

const run = promisify(execFile);

export type MainDefaultsDeps = {
  /** The operator's checkout, which `main` is fetched into. */
  checkout: string;
  /** "origin" by default. */
  remote?: string;
  /** "main" by default. */
  branch?: string;
};

/**
 * Reads each default policy from `policy/<name>.md` at the checkout's remote-tracking ref for `main`, the commit the
 * worker's last successful fetch left there. It reads the object store only, never the working tree, index or HEAD. A
 * fetch that fails leaves the ref, so the defaults stay those of the last commit fetched. A file the commit doesn't hold
 * throws, naming the file and the ref.
 *
 * Each call resolves the ref afresh. `pin()` resolves it to a commit sha once and returns a reader of that commit, so
 * a fetch landing between two reads can't give them different commits.
 */
export function mainDefaults(d: MainDefaultsDeps): DefaultPolicies {
  const ref = `refs/remotes/${d.remote ?? "origin"}/${d.branch ?? "main"}`;
  const at = (rev: string, label: string) => async (name: Exclude<PolicyName, "dod">) => {
    const path = `policy/${name}.md`;
    try {
      // cat-file blob gives the bytes as committed, with no textconv or line-ending filter.
      return (await run("git", ["cat-file", "blob", `${rev}:${path}`], { cwd: d.checkout, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })).stdout;
    } catch (e) {
      throw new Error(`the default ${path} couldn't be read from ${label} in ${d.checkout}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const pin = async () => {
    let sha: string;
    try {
      sha = (await run("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: d.checkout, encoding: "utf8" })).stdout.trim();
    } catch (e) {
      throw new Error(`${ref} couldn't be resolved in ${d.checkout}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return at(sha, `${ref} (${sha})`);
  };
  return Object.assign(at(ref, ref), { pin });
}
