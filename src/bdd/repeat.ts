// `npm run bdd:repeat -- --times <n> --name "<scenario name>"` (PBI 376) runs one scenario n times back to back, to
// prove it steady. It exits 0 only when every run passes, and names each run that failed with that run's output.
// Each run is its own cucumber-js process, run as `npm run bdd` runs it, so each starts its own test database and
// nothing one run leaves in memory reaches the next.
import { spawn } from "node:child_process";
import { join } from "node:path";

export type RepeatArgs = { times: number; name: string };
export type RunResult = { passed: boolean; output: string };

const COUNT_ERROR = "The run count must be a whole number above zero: pass it as --times <n>.";

/** Reads `--times <n> --name "<scenario name>"`, either order, `--flag=value` too. */
export function parseRepeatArgs(argv: string[]): RepeatArgs | { error: string } {
  const values: Record<string, string | undefined> = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(times|name)(?:=(.*))?$/s.exec(argv[i]);
    if (!m) return { error: `bdd:repeat takes --times <n> and --name "<scenario name>", not ${argv[i]}.` };
    values[m[1]] = m[2] ?? argv[++i];
  }
  const times = values.times;
  if (times === undefined || !/^\d+$/.test(times) || Number(times) < 1) return { error: COUNT_ERROR };
  if (!values.name) return { error: 'bdd:repeat needs the scenario\'s name: pass it as --name "<scenario name>".' };
  return { times: Number(times), name: values.name };
}

/** A cucumber-js --name pattern that matches `name` exactly, so a scenario whose name merely contains it doesn't run. */
export function exactName(name: string): string {
  return `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

const list = (ns: number[]) => (ns.length === 1 ? String(ns[0]) : `${ns.slice(0, -1).join(", ")} and ${ns.at(-1)}`);

/**
 * Runs `run` for runs 1 to `times`, one after another, each whatever the last one did. A failed run is named as
 * "run <i> of <n> failed" with its output. The last line says how many passed. True only when every run passed.
 */
export async function repeat(times: number, run: (i: number) => Promise<RunResult>, say: (line: string) => void): Promise<boolean> {
  const failed: number[] = [];
  for (let i = 1; i <= times; i++) {
    const started = Date.now();
    const r = await run(i);
    const took = `${((Date.now() - started) / 1000).toFixed(1)}s`;
    if (r.passed) {
      say(`run ${i} of ${times} passed (${took})`);
      continue;
    }
    failed.push(i);
    say(`run ${i} of ${times} failed (${took}). Its output:`);
    say(r.output.trimEnd());
    say(`(end of run ${i}'s output)`);
  }
  const passed = times - failed.length;
  say(`${passed} of ${times} runs passed.${failed.length ? ` Run${failed.length > 1 ? "s" : ""} ${list(failed)} failed.` : ""}`);
  return failed.length === 0;
}

export type Cucumber = { cwd: string; env: NodeJS.ProcessEnv; bin: string };

/** Runs cucumber-js with `npm run bdd`'s step definitions and `args`, and gives back its exit code and its output. */
function cucumber(c: Cucumber, args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [c.bin, "--import", "features/steps/**/*.ts", ...args], { cwd: c.cwd, env: c.env, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => out.push(b));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output: Buffer.concat(out).toString() }));
  });
}

/** How many scenarios, an outline's examples each counted, have exactly this name. A dry run, so nothing runs. The report holds a pickle for every scenario parsed, but a test case only for each one the name selects. */
export async function countScenarios(c: Cucumber, name: string): Promise<number> {
  const r = await cucumber(c, ["--dry-run", "--name", exactName(name), "--format", "message"]);
  if (r.code !== 0) throw new Error(`cucumber-js couldn't list the scenarios:\n${r.output}`);
  return r.output.split("\n").filter((line) => line.startsWith('{"testCase":')).length;
}

/**
 * The arguments of one run. --force-exit ends the process once cucumber-js has run every hook and reported, so a run
 * doesn't sit out the 10 seconds an idle pg pool client keeps the event loop alive. Over the 15 inner runs PBI 376's
 * scenarios make, that wait alone would cost two and a half minutes of the 15 a cell gives `npm run bdd`.
 */
export function runArgs(name: string): string[] {
  return ["--name", exactName(name), "--force-exit"];
}

/** One run of the scenario. It passes when cucumber-js exits 0. */
export async function runScenario(c: Cucumber, name: string): Promise<RunResult> {
  const r = await cucumber(c, runArgs(name));
  return { passed: r.code === 0, output: r.output };
}

/** The script: exits 0 only when the scenario exists and every run of it passed. */
export async function main(argv: string[], repo: string, env: NodeJS.ProcessEnv): Promise<number> {
  const args = parseRepeatArgs(argv);
  if ("error" in args) {
    console.error(args.error);
    return 2;
  }
  // BDD_REPEAT_CWD runs the scenarios of another cucumber project, as PBI 376's own scenarios do with practice ones.
  const c: Cucumber = { cwd: env.BDD_REPEAT_CWD || repo, env, bin: join(repo, "node_modules", "@cucumber", "cucumber", "bin", "cucumber.js") };
  const found = await countScenarios(c, args.name);
  if (found === 0) {
    console.error(`No run passed: no scenario is named "${args.name}".`);
    return 1;
  }
  console.log(`Running "${args.name}" ${args.times} time${args.times > 1 ? "s" : ""}, one run after another.`);
  const ok = await repeat(args.times, () => runScenario(c, args.name), (line) => console.log(line));
  return ok ? 0 : 1;
}
