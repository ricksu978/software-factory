// What the AppHost does before any resource starts (PBI 205), whether `npm run factory` or a plain `aspire run`
// launched it. On `main` it runs a fast-forward-only pull, so control, the worker and migrate run the code it pulled,
// and a pull that fails stops the start with git's own message. On any other branch, or on no branch, it warns that it
// runs the checkout as it is and pulls nothing. Then, when Docker doesn't answer, it launches Docker Desktop and waits
// up to 3 minutes for it. aspire-apphost/apphost.mts calls startAppHost() with the real git, Docker and clock, and
// passes the resources' start as startResources.

/** What one git command in the checkout returned. */
export type GitResult = { status: number; stdout: string; stderr: string };

export type StartDeps = {
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
  /** Starts migrate, control, the worker and the rest. Called only once the checks above have passed. */
  startResources(): Promise<void>;
};

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
  pullMain(deps);
  await ensureDocker(deps);
  await deps.startResources();
}

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
  // --ff-only: a main that has diverged, or local edits the pull would overwrite, fail the pull rather than merge.
  const pull = deps.git(["pull", "--ff-only"]);
  if (pull.status !== 0) {
    const said = gitSaid(pull);
    throw new StartStopped(`git pull --ff-only failed, so no resource started.${said ? `\n${said}` : ""}`);
  }
  const said = pull.stdout.trim();
  if (said) deps.say(said);
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
