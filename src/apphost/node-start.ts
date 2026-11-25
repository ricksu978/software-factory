// The real git, Docker and clock for the AppHost's start (PBI 205), and the entry aspire-apphost/apphost.mts calls.
// The checks themselves live in start.ts, which the scenarios run against fakes.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DockerBuild } from "./cell-image.ts";
import { StartStopped, startAppHost, type StartDeps } from "./start.ts";

/** Where Docker Desktop installs on Windows, per user and machine-wide. */
export function dockerDesktopPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const paths: string[] = [];
  if (env.LOCALAPPDATA) paths.push(join(env.LOCALAPPDATA, "Programs", "DockerDesktop", "Docker Desktop.exe"));
  if (env.ProgramFiles) paths.push(join(env.ProgramFiles, "Docker", "Docker", "Docker Desktop.exe"));
  return paths;
}

/** Whether `docker version` succeeds. A missing docker CLI, or one that hangs past 30 seconds, counts as no answer. */
function dockerAnswers(): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn("docker", ["version"], { stdio: "ignore", timeout: 30_000 });
    p.on("error", () => resolve(false));
    p.on("exit", (code) => resolve(code === 0));
  });
}

/** The arguments of `docker build` for one build, after `build`. Plain progress, so its log reads line by line. */
export function dockerBuildArgs(build: DockerBuild): string[] {
  const args = ["build", "--progress=plain", "-f", build.dockerfile, "-t", build.tag];
  for (const [k, v] of Object.entries(build.labels)) args.push("--label", `${k}=${v}`);
  return [...args, build.context];
}

/**
 * Runs `docker build` in `repo`, passing each line it prints, stdout and stderr alike, to `log`, and resolves to its
 * exit status. A docker CLI that can't be run logs why and resolves to 1. `docker` is the command, for tests.
 */
export function dockerBuild(repo: string, build: DockerBuild, log: (line: string) => void, docker = "docker"): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(docker, dockerBuildArgs(build), { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [p.stdout, p.stderr]) {
      let rest = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        const lines = (rest + chunk).split(/\r?\n/);
        rest = lines.pop() ?? "";
        for (const l of lines) log(l);
      });
      stream.on("end", () => {
        if (rest) log(rest);
        rest = "";
      });
    }
    p.on("error", (e) => {
      log(`Couldn't run ${docker}: ${e.message}`);
      resolve(1);
    });
    p.on("close", (code) => resolve(code ?? 1));
  });
}

/** The start's deps for the checkout at `repo`, apart from starting the resources. `env` is the AppHost's environment. */
export function nodeStartDeps(repo: string, env: NodeJS.ProcessEnv = process.env): Omit<StartDeps, "startResources"> {
  return {
    env: { FACTORY_FLOAT_PORTS: env.FACTORY_FLOAT_PORTS },
    git(args) {
      // stdin stays the console's, so a credential prompt can still ask.
      const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["inherit", "pipe", "pipe"] });
      return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr || (r.error ? String(r.error.message) : "") };
    },
    dockerAnswers,
    findDockerDesktop: () => dockerDesktopPaths().find((p) => existsSync(p)) ?? null,
    launch(exe) {
      spawn(exe, [], { detached: true, stdio: "ignore" }).unref();
    },
    dockerBuild: (build, log) => dockerBuild(repo, build, log),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    say: (line) => console.log(line),
    warn: (line) => console.warn(`Warning: ${line}`),
  };
}

/** Runs the start's checks in `repo`, then `startResources`. A check that fails shows why and exits the AppHost with 1. */
export async function runAppHostStart(repo: string, startResources: StartDeps["startResources"]): Promise<void> {
  try {
    await startAppHost({ ...nodeStartDeps(repo), startResources });
  } catch (e) {
    if (!(e instanceof StartStopped)) throw e;
    console.error(e.message);
    process.exit(1);
  }
}
