// The worker (control plane redesign, §07, step 2 of §12). It sets up the egress proxy that cells reach the outside
// through, runs the scheduler's tick, and polls each board with the readiness judge. Today's control plane,
// src/main.ts, runs none of them, so each job runs in one process. Until the outbox lands (step 3), the worker mirrors
// its own transitions onto the board, as the control plane mirrors its own. `aspire run` starts it as the worker
// resource. Keeping a second worker idle with an advisory lock is a later step.
import { App } from "@octokit/app";
import type pg from "pg";
import { githubRepoHost } from "../adapters/github/repo-host.ts";
import type { BacklogAdapter, RepoHost } from "../adapters/types.ts";
import { haikuJudge, runAgent } from "../agent/run.ts";
import { mirrorBoard } from "../control/board.ts";
import { logTransitions } from "../control/console-log.ts";
import type { SplitDeps } from "../gate/split.ts";
import { githubSources, missing, sop, type Source } from "../main.ts";
import { dockerLauncher, ensureEgress, type Launcher } from "../scheduler/launcher.ts";
import { tick, TICK_MS } from "../scheduler/scheduler.ts";
import { createPool } from "../store/db.ts";
import { clearRestartOnStart } from "../store/overrides.ts";
import { pollOnce, POLL_INTERVAL_MS, type PollDeps } from "../watcher/poller.ts";

type Egress = (cfg: { image: string; controlUrl: string; blob: string }) => Promise<void>;

export type WorkerDeps = {
  pool: pg.Pool;
  /** The boards it polls. An item's board is the source it came from. */
  sources: Source[];
  repoHost: RepoHost;
  launcher: Launcher;
  /** Sets up the egress proxy, once, before the first tick. */
  egress: Egress;
  /** CELL_IMAGE, which the proxy runs from. */
  image: string;
  /** CELL_CONTROL_URL: the cell API as a cell reaches it, passed to each cell and let through the proxy. */
  controlUrl: string;
  /** FACTORY_BLOB, whose port the proxy lets through. */
  blob: string;
  judge: PollDeps["judge"];
  split?: SplitDeps;
  /** FACTORY_KILL=1 at start. */
  killFlag: boolean;
  /** CELL_SECRET, which signs each cell's run token. */
  secret: string;
  sopVersion: string;
  tickMs?: number;
  pollMs?: number;
};

export type Worker = {
  /** How many times each job has run, failed runs included, keyed by its name in the log. */
  runs: Map<string, number>;
  stop(): Promise<void>;
};

/** Runs `fn` once and logs a failure as "<what> failed:" instead of throwing. True when it succeeded. */
export async function attempt(what: string, fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (e) {
    console.error(`${what} failed:`, e);
    return false;
  }
}

/**
 * Runs `fn` now and then `ms` after each run ends, so two runs never overlap. A failure is logged and the next run goes
 * ahead. Each run is counted in `runs`. Returns the call that stops it, which waits for a run under way.
 */
function every(ms: number, what: string, fn: () => Promise<unknown>, runs: Map<string, number>): () => Promise<void> {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let current = Promise.resolve();
  const run = () => {
    current = (async () => {
      await attempt(what, fn);
      runs.set(what, (runs.get(what) ?? 0) + 1);
      if (!stopped) timer = setTimeout(run, ms);
    })();
  };
  run();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await current;
  };
}

/** Sets up the egress proxy, then starts mirroring, the tick and one poll loop per board. It throws if the proxy fails. */
export async function startWorker(d: WorkerDeps): Promise<Worker> {
  // Cells reach nothing but GitHub, npm, the cell API and the blobs, through the egress proxy (Task 13).
  try {
    await d.egress({ image: d.image, controlUrl: d.controlUrl, blob: d.blob });
  } catch (e) {
    throw new Error(`the egress proxy couldn't be set up, so the worker starts no cell: ${e instanceof Error ? e.message : e}`, { cause: e });
  }
  const backlogFor = (id: string) => d.sources.find((s) => s.id === id)?.adapter ?? missing<BacklogAdapter>(`no backlog source ${id}`);
  const hooks = [mirrorBoard({ pool: d.pool, backlogFor, repoHost: d.repoHost }), logTransitions({ pool: d.pool })];
  const runs = new Map<string, number>();
  let ticked = false;
  const loops = [every(d.tickMs ?? TICK_MS, "scheduler tick", async () => {
    await tick({
      pool: d.pool, launcher: d.launcher, now: new Date(), killFlag: d.killFlag, repoHost: d.repoHost, backlogFor,
      secret: d.secret, controlUrl: d.controlUrl, sopVersion: d.sopVersion,
    });
    if (!ticked) console.log("The worker ran its first scheduler tick.");
    ticked = true;
  }, runs)];
  // Each board files its splits as child issues on itself (PBI 144).
  for (const s of d.sources) {
    const split = d.split && { ...d.split, file: s.file };
    loops.push(every(d.pollMs ?? POLL_INTERVAL_MS, `polling source ${s.id}`,
      () => pollOnce({ pool: d.pool, adapter: s.adapter, repoHost: d.repoHost, judge: d.judge, sourceId: s.id, split }), runs));
  }
  return {
    runs,
    async stop() {
      await Promise.all(loops.map((stop) => stop()));
      for (const off of hooks) off();
    },
  };
}

/** Reads the worker's settings from `env` and starts it with the real board, repo host, launcher and judge. */
export async function main(env: NodeJS.ProcessEnv, egress: Egress = ensureEgress): Promise<Worker> {
  if (env.FACTORY_ENV !== "local") throw new Error("Azure mode isn't wired yet: the worker launches cells with Docker only. Run it under `aspire run`.");
  const need = (name: string) => {
    const v = env[name];
    if (!v) throw new Error(`${name} is not set`);
    return v;
  };
  // The readiness judge's Agent SDK reads CLAUDE_CODE_OAUTH_TOKEN from the environment, so it's checked here too.
  const [dbUri, blob, secret, appId, appKey, , image, controlUrl] =
    ["FACTORY_DB_URI", "FACTORY_BLOB", "CELL_SECRET", "GITHUB_APP_ID", "GITHUB_APP_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CELL_IMAGE", "CELL_CONTROL_URL"].map(need);

  const pool = createPool(dbUri);
  // A prepared restart holds back the tick, which runs here, so a worker restarted on its own clears it too (PBI 140).
  await clearRestartOnStart(pool);
  const app = new App({ appId, privateKey: appKey });
  const { sources, installationId } = await githubSources(pool, app, env.GITHUB_PROJECT_TOKEN || null);
  if (!sources.length) console.warn("No backlog source is configured yet, so the factory takes no item. Add config/sources.yml and restart aspire run.");
  const repoHost = installationId === null ? missing<RepoHost>("no repo is configured") : githubRepoHost(app, installationId);
  return startWorker({
    pool, sources, repoHost, launcher: dockerLauncher({ image }), egress, image, controlUrl, blob,
    judge: haikuJudge(sop),
    // One split cache for every poll, so a re-gate of item text already split doesn't ask the coding model again.
    split: { sop, agent: runAgent, seen: new Map() },
    killFlag: env.FACTORY_KILL === "1", secret, sopVersion: sop.version,
  });
}

if (import.meta.main) {
  main(process.env).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
