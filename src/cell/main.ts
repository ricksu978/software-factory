// The cell's entry point (plan Task 14 Step 5). The scheduler starts it with the six variables in Run contract 5.
// Run as `main.ts credential get`, it is the git credential helper, which asks the cell API for a fresh token.
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { cellRepoHost } from "../adapters/github/repo-host.ts";
import { runAgent } from "../agent/run.ts";
import { loadSop } from "../config/sop.ts";
import { httpCellApi } from "./api-client.ts";
import { loadInputs, runCell } from "./engine.ts";
import { cloneRun, shellGit } from "./git.ts";
import { resumeOnImageSop } from "./sop-move.ts";

const exec = promisify(execFile);

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

const api = () => httpCellApi({ controlUrl: env("CONTROL_URL"), runId: env("RUN_ID"), runToken: env("RUN_TOKEN"), generation: Number(env("GENERATION")) });

async function credential(action: string | undefined) {
  if (action !== "get") return; // git also calls store and erase, and the cell keeps nothing
  process.stdout.write(`username=x-access-token\npassword=${await api().githubToken()}\n`);
}

async function main() {
  const cell = api();
  const ctx = await cell.context();
  const dir = join(await mkdtemp(join(tmpdir(), "cell-")), "repo");
  const helper = `!"${process.execPath}" "${import.meta.filename}" credential`;
  await cloneRun(`https://github.com/${ctx.repo}.git`, ctx.branch, ctx.base, dir, helper);

  // Policy files at the run's pinned commit (Run contract 11). A path missing there reads as absent, but a pinned
  // commit the clone lacks is a read error, which never falls back to a default.
  if (!ctx.configSha) throw new Error("the run has no pinned config_sha yet");
  await exec("git", ["cat-file", "-e", `${ctx.configSha}^{commit}`], { cwd: dir });
  const read = async (path: string) => {
    try {
      await exec("git", ["cat-file", "-e", `${ctx.configSha}:${path}`], { cwd: dir });
    } catch {
      return null;
    }
    return (await exec("git", ["show", `${ctx.configSha}:${path}`], { cwd: dir, maxBuffer: 16 * 1024 * 1024 })).stdout;
  };
  const inputs = await loadInputs(read, ctx.configSha);
  const sop = loadSop(await readFile(join(import.meta.dirname, "..", "..", "sop", "default.yml"), "utf8"));
  if ("blocked" in inputs) {
    await cell.transition({ event: "blocked", question: { kind: "needs_input", body: inputs.blocked } });
    console.log("waiting");
    return;
  }
  // PBI 173: a run pinned to an older SOP moves to this image's SOP, unless the image's SOP lacks its next stage.
  const run = await resumeOnImageSop(cell, ctx, sop);
  if (!run) {
    console.log("waiting");
    return;
  }
  const outcome = await runCell({
    api: cell, ctx: run, agent: runAgent, git: shellGit(dir, ctx.branch), dir,
    repoHost: cellRepoHost(() => cell.githubToken()),
    sop, config: inputs.config, policies: inputs.policies, now: () => new Date(),
  });
  console.log(outcome);
}

if (import.meta.main) {
  const run = process.argv[2] === "credential" ? credential(process.argv[3]) : main();
  run.catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
