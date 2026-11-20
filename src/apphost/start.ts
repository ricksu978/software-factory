// What `aspire run` does before any resource starts (PBI 205), so it is the one command that starts the factory (PBI
// 208). On `main` it runs a fast-forward-only pull, so control, the worker and migrate run the code it pulled,
// and a pull that fails stops the start with git's own message. On any other branch, or on no branch, it warns that it
// runs the checkout as it is and pulls nothing. Then, when Docker doesn't answer, it launches Docker Desktop and waits
// up to 3 minutes for it. A test run (FACTORY_FLOAT_PORTS=1, as the BDD suites start the AppHost) runs no git at all,
// so a suite run on `main` never moves the checkout or waits on a credential prompt. aspire-apphost/apphost.mts calls
// startAppHost() with the real git, Docker and clock, and passes the resources' start as startResources. The resources
// it hands over include "cell-image" (PBI 206), which builds factory-cell:local from the pulled checkout, and the
// worker waits for it.

import { buildCellImage, CELL_IMAGE_RESOURCE, type CellImageDeps, type DockerBuild } from "./cell-image.ts";

/** What one git command in the checkout returned. */
export type GitResult = { status: number; stdout: string; stderr: string };

export type StartDeps = {
  /**
   * The AppHost's environment. FACTORY_FLOAT_PORTS=1 marks a test run (PBI 208), as the BDD suites for PBIs 6, 89 and
   * 156 start the AppHost. A test run pulls nothing.
   */
  env?: { FACTORY_FLOAT_PORTS?: string };
  /** Runs git in the checkout with these arguments. */
  git(args: string[]): GitResult;
  /** Whether Docker answers, as `docker version` does. */
  dockerAnswers(): Promise<boolean>;
  /** Docker Desktop's executable, or null when it isn't installed where this looks. */
  findDockerDesktop(): string | null;
  /** Launches Docker Desktop from its executable, without waiting for it. */
  launch(exe: string): void;
  sleep(ms: number): Promise<void>;
  /** The time, in milliseconds. */
  now(): number;
  /** Shows a line on the AppHost's console. */
  say(line: string): void;
  /** Shows a warning on the AppHost's console. */
  warn(line: string): void;
  /** Runs `docker build` in the checkout, passing each line of its output to `log`. Resolves to its exit status. */
  dockerBuild(build: DockerBuild, log: (line: string) => void): Promise<number>;
  /**
   * Starts migrate, control, the worker and the rest. Called only once the checks above have passed, with the resources
   * whose order the start decides: each starts only once every resource it waits for has finished.
   */
  startResources(resources: AppHostResource[]): Promise<void>;
};

/**
 * A resource in the AppHost's dashboard. It starts once every resource in `waitsFor` has finished, and never when one
 * of them failed. `run`, when there is one, is the work the AppHost does for it: it finishes when `run` resolves, and
 * fails, with the error in its log, when `run` throws.
 */
export type AppHostResource = { name: string; waitsFor: string[]; run?: (log: (line: string) => void) => Promise<void> };

/**
 * The resources whose order the start decides, and what each waits for. aspire-apphost/apphost.mts wires the same waits
 * itself, and apphost-graph.test.ts fails when they differ. Under `aspire run` the cell-image resource is
 * cell-image-main.ts, which runs the same buildCellImage() through runCellImageResource().
 */
export function appHostResources(deps: CellImageDeps): AppHostResource[] {
  return [
    { name: "migrate", waitsFor: [] },
    // The egress proxy and every cell run factory-cell:local, so the worker waits for it to be built from this checkout
    // (PBI 206). The pull has finished by the time any resource starts, so it builds the pulled commit.
    { name: CELL_IMAGE_RESOURCE, waitsFor: [], run: (log) => buildCellImage(deps, log) },
    { name: "control", waitsFor: ["migrate"] },
    { name: "worker", waitsFor: ["migrate", CELL_IMAGE_RESOURCE] },
  ];
}

/** How long a start waits for Docker Desktop to answer once it has launched it. */
export const DOCKER_WAIT_MS = 3 * 60_000;
export const DOCKER_NOT_INSTALLED = "Docker is not running, and Docker Desktop is not installed where this looks. Start Docker first.";
export const DOCKER_TIMED_OUT = "Docker did not come up within 3 minutes.";

/** Thrown when a start stops before any resource starts. Its message is what the start shows. */
export class StartStopped extends Error {
  override name = "StartStopped";
}

/** How often a start asks Docker again while it waits for Docker Desktop. */
export const DOCKER_POLL_MS = 3_000;

/** Runs the checks, then starts the resources. Throws StartStopped, having started nothing, when a check fails. */
export async function startAppHost(deps: StartDeps): Promise<void> {
  if (isTestRun(deps)) deps.say(TEST_RUN_NO_PULL);
  else pullMain(deps);
  await ensureDocker(deps);
  await deps.startResources(appHostResources(deps));
}

/** FACTORY_FLOAT_PORTS=1 marks a test run. Unset, "0" or anything else is a real start. */
export const isTestRun = (deps: Pick<StartDeps, "env">) => deps.env?.FACTORY_FLOAT_PORTS === "1";
export const TEST_RUN_NO_PULL = "A test run (FACTORY_FLOAT_PORTS=1), so it runs the checkout as it is and pulls nothing.";

/** Git's own words for a failed command, stderr first, as it printed them. */
const gitSaid = (r: GitResult) => [r.stderr, r.stdout].map((s) => s.trim()).filter(Boolean).join("\n");

/** On `main`, fast-forwards it from its upstream. On any other branch, or none, warns and touches nothing. */
function pullMain(deps: StartDeps): void {
  const current = deps.git(["branch", "--show-current"]);
  if (current.status !== 0) throw new StartStopped(`git couldn't name the checkout's branch:\n${gitSaid(current)}`);
  const branch = current.stdout.trim();
  if (branch !== "main") {
    deps.warn(branch
      ? `On branch '${branch}', not 'main', so it runs as it is and pulls nothing.`
      : "On no branch (a detached HEAD), not on 'main', so it runs as it is and pulls nothing.");
    return;
  }
  // The commit before the pull, so a pull that changes the AppHost's own files can ask for a restart.
  const before = deps.git(["rev-parse", "HEAD"]);
  // --ff-only: a main that has diverged, or local edits the pull would overwrite, fail the pull rather than merge.
  const pull = deps.git(["pull", "--ff-only"]);
  if (pull.status !== 0) {
    const said = gitSaid(pull);
    throw new StartStopped(`git pull --ff-only failed, so no resource started.${said ? `\n${said}` : ""}`);
  }
  const said = pull.stdout.trim();
  if (said) deps.say(said);
  if (before.status === 0) warnOnAppHostChange(deps, before.stdout.trim());
}

/** The AppHost's own directory, which it has already run by the time it pulls. */
export const APPHOST_DIR = "aspire-apphost/";
export const APPHOST_CHANGED =
  "The pull changed the AppHost (aspire-apphost/), but this start runs the AppHost as it was before the pull. Stop it and run `aspire run` again to pick up the change.";

/**
 * The AppHost has built its resource graph from aspire-apphost/ before it pulls, so a pull that changes that directory
 * starts the old graph while control and the worker run the pulled src/. Warns, asking for a restart, when it did.
 */
function warnOnAppHostChange(deps: StartDeps, before: string): void {
  if (!before) return;
  const diff = deps.git(["diff", "--name-only", before, "HEAD", "--", APPHOST_DIR]);
  if (diff.status !== 0) {
    deps.warn(`git couldn't say whether the pull changed ${APPHOST_DIR}, so run \`aspire run\` again if it did:\n${gitSaid(diff)}`);
    return;
  }
  if (diff.stdout.trim()) deps.warn(APPHOST_CHANGED);
}

/** When Docker doesn't answer, launches Docker Desktop and waits up to DOCKER_WAIT_MS for it. */
async function ensureDocker(deps: StartDeps): Promise<void> {
  if (await deps.dockerAnswers()) return;
  const exe = deps.findDockerDesktop();
  if (!exe) throw new StartStopped(DOCKER_NOT_INSTALLED);
  deps.say("Starting Docker Desktop...");
  deps.launch(exe);
  const deadline = deps.now() + DOCKER_WAIT_MS;
  do {
    await deps.sleep(DOCKER_POLL_MS);
    if (await deps.dockerAnswers()) return;
  } while (deps.now() < deadline);
  throw new StartStopped(DOCKER_TIMED_OUT);
}
