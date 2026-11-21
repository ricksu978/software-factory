// `npm run bdd` (PBI 390) runs the BDD suite in cucumber-js's own parallel workers. How many comes from one setting,
// BDD_WORKERS, so a cell, CI and a person's machine can each set their own; unset or empty, it's DEFAULT_WORKERS. A
// count that isn't a whole number above zero is refused before anything runs. The parallel rule for @serial lives in
// the suite's support code, features/support/parallel.ts, which src/bdd/parallel.ts holds the logic of, and the plugin
// src/bdd/serial-last.ts runs the @serial scenarios last.
//
// cucumber-js runs from the directory `npm run bdd` starts in, with the suite's support code and step definitions,
// writing the Cucumber Messages report Red and Green read to reports/bdd.ndjson, and any arguments after `--` on top.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The plugin that orders the @serial scenarios last, so they don't leave workers idle (src/bdd/parallel.ts). */
const SERIAL_LAST = pathToFileURL(join(import.meta.dirname, "serial-last.ts")).href;

export const SETTING = "BDD_WORKERS";
/** More than one, so an unset count still runs in parallel, and few enough for a cell's or CI's two to four cores. */
export const DEFAULT_WORKERS = 4;
export const REFUSAL = `the worker count must be a whole number above zero. Set ${SETTING} to one, such as 4, or leave it unset for ${DEFAULT_WORKERS}.`;

/** The worker count `env` sets, or the refusal when it sets one that isn't a whole number above zero. */
export function workerCount(env: NodeJS.ProcessEnv): { workers: number } | { error: string } {
  const raw = env[SETTING]?.trim();
  if (raw === undefined || raw === "") return { workers: DEFAULT_WORKERS };
  if (!/^\d+$/.test(raw) || Number(raw) < 1) return { error: `${SETTING} is ${JSON.stringify(env[SETTING])}: ${REFUSAL}` };
  return { workers: Number(raw) };
}

/** cucumber-js's arguments for `npm run bdd -- <extra>` in `workers` workers. An explicit --parallel in `extra` wins. */
export function cucumberArgs(workers: number, extra: string[]): string[] {
  const own = extra.some((a) => a === "--parallel" || a.startsWith("--parallel="));
  return [
    "--import", "features/support/**/*.ts",
    "--import", "features/steps/**/*.ts",
    "--format", "message:reports/bdd.ndjson",
    "--plugin", SERIAL_LAST,
    ...(own ? [] : ["--parallel", String(workers)]),
    ...extra,
  ];
}

/** Runs the suite from `cwd`, and gives back cucumber-js's exit code, or 2 when the worker count is refused. */
export async function main(argv: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  const count = workerCount(env);
  if ("error" in count) {
    process.stderr.write(`npm run bdd: ${count.error}\n`);
    return 2;
  }
  const bin = join(cwd, "node_modules", "@cucumber", "cucumber", "bin", "cucumber.js");
  const child = spawn(process.execPath, [bin, ...cucumberArgs(count.workers, argv)], { cwd, env, stdio: "inherit" });
  const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
  const handlers = (["SIGINT", "SIGTERM"] as const).map((s) => [s, forward(s)] as const);
  for (const [s, h] of handlers) process.on(s, h);
  try {
    return await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
  } finally {
    for (const [s, h] of handlers) process.off(s, h);
  }
}
