// PBI 215: a Definition of Done command that fails in a cell is run again on the run's base commit, `origin/<base>`,
// before the failure is charged to the item. When every test that failed on the item's branch fails on the base too,
// the base is at fault, so the stage stops and asks one question instead of spending its retries. The base run is a
// plain command, with no AI call, in a worktree of its own, so the item's checkout stays as it was.
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { sh } from "./engine.ts";

const run = promisify(execFile);

/**
 * The names of the tests a command's output says failed, in the order first seen: TAP's `not ok` lines (TODO and SKIP
 * left out), node's spec reporter's `✖ name (1.2ms)` lines and cucumber-js's "Failing scenarios:" list. Output that
 * names no test, such as a type error, gives none.
 */
export function failingTests(output: string): string[] {
  const out = new Set<string>();
  let cucumber = false;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "Failing scenarios:") { cucumber = true; continue; }
    if (cucumber) {
      const m = /^\S+:\d+ # (.+)$/.exec(line);
      if (m) { out.add(m[1].trim()); continue; }
      cucumber = false;
    }
    const tap = /^not ok \d+ - (.+?)(?: # (.*))?$/.exec(line);
    if (tap) {
      if (!/^(TODO|SKIP)\b/i.test(tap[2] ?? "")) out.add(tap[1].trim());
      continue;
    }
    const spec = /^✖ (.+?) \([\d.]+m?s\)$/.exec(line);
    if (spec) out.add(spec[1].trim());
  }
  return [...out];
}

/** Whether the base is at fault: every test that failed on the item's branch fails on the base too, and some did. */
export function sharedWithBase(onBranch: string[], onBase: string[]): boolean {
  const base = new Set(onBase);
  return onBranch.length > 0 && onBranch.every((t) => base.has(t));
}

/** The one question a stage asks when the base fails the same tests: it names the base commit, the lines and the tests. */
export function baseQuestion(base: string, sha: string, lines: { criterion: string; tests: string[] }[]): string {
  const each = lines.map((l) => `The Definition of Done line "${l.criterion}" fails these tests on the base commit as on the item's branch:\n${l.tests.map((t) => `- ${t}`).join("\n")}`);
  return [
    `The base fails in the cell. The base commit ${sha.slice(0, 7)}, \`origin/${base}\`, fails the same tests this item's branch fails, so the item isn't at fault and the factory stopped instead of retrying.`,
    ...each,
    `Fix the base, then answer this question, and the item carries on from where it stopped.`,
  ].join("\n\n");
}

/**
 * Runs `command` at `origin/<base>` in a temporary worktree, after the repo's setup command when it has one, as a
 * fresh checkout needs, then removes the worktree. The item's checkout, its branch and its files are left as they were.
 */
export async function runOnBase(dir: string, base: string, command: string, setup?: string): Promise<{ sha: string; code: number; out: string }> {
  const git = async (...args: string[]) => (await run("git", args, { cwd: dir, maxBuffer: 64 * 1024 * 1024 })).stdout.trim();
  const sha = await git("rev-parse", `origin/${base}^{commit}`);
  const parent = await mkdtemp(join(tmpdir(), "factory-base-"));
  const tree = join(parent, "base");
  try {
    await git("worktree", "add", "-q", "--detach", tree, sha);
    if (setup) {
      const s = await sh(setup, tree);
      if (s.code !== 0) return { sha, code: s.code, out: `commands.setup exited ${s.code} on the base commit: ${s.all}` };
    }
    const r = await sh(command, tree);
    return { sha, code: r.code, out: r.all };
  } finally {
    await git("worktree", "remove", "--force", tree).catch(() => {});
    await rm(parent, { recursive: true, force: true });
    await git("worktree", "prune").catch(() => {});
  }
}
