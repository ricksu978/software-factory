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

/** Runs the checks, then starts the resources. Throws StartStopped, having started nothing, when a check fails. */
export async function startAppHost(_deps: StartDeps): Promise<void> {
  // Red stub (PBI 205): no behaviour yet.
}
