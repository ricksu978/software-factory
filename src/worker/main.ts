// The worker (control plane redesign, §07, step 2 of §12). It sets up the egress proxy that cells reach the outside
// through, runs the scheduler's tick, and polls each board with the readiness judge. Today's control plane,
// src/main.ts, runs none of them, so each job runs in one process. Until the outbox lands (step 3), the worker mirrors
// its own transitions onto the board, as the control plane mirrors its own. `aspire run` starts it as the worker
// resource. A worker runs its jobs only while it holds the factory's worker lock, a session-level Postgres advisory lock
// on a connection of its own (PBI 157). One that can't take it stands by, and one whose lock connection closes exits.
import { App } from "@octokit/app";
import pg from "pg";
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
  /** How often a standby tries for the worker lock again. LOCK_RETRY_MS by default. */
  lockRetryMs?: number;
  /** Where the worker's log lines go. The console by default. */
  log?: Pick<Console, "log" | "warn" | "error">;
};

export type Worker = {
  /** How many times each job has run, failed runs included, keyed by its name in the log. */
  runs: Map<string, number>;
  /** Settles once the worker has stopped: it resolves after stop(), and rejects when the worker lost the worker lock. */
  done: Promise<void>;
  stop(): Promise<void>;
};

/** Runs `fn` once and logs a failure as "<what> failed:" instead of throwing. True when it succeeded. */
export async function attempt(what: string, fn: () => Promise<unknown>, log: Pick<Console, "error"> = console): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (e) {
    log.error(`${what} failed:`, e);
    return false;
  }
}

/**
 * Runs `fn` now and then `ms` after each run ends, so two runs never overlap. A failure is logged and the next run goes
 * ahead. Each run is counted in `runs`. Returns the call that stops it, which waits for a run under way.
 */
function every(ms: number, what: string, fn: () => Promise<unknown>, runs: Map<string, number>, log: Pick<Console, "error">): () => Promise<void> {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let current = Promise.resolve();
  const run = () => {
    current = (async () => {
      await attempt(what, fn, log);
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

/**
 * The key of the factory's worker lock, a session-level advisory lock. Migrations lock 7400 (src/store/db.ts), so the
 * worker takes the one beside it.
 */
export const WORKER_LOCK_KEY = 7401;
/** How often a standby tries for the worker lock again. A takeover therefore starts within this of the holder stopping. */
export const LOCK_RETRY_MS = 15_000;
/** How often the holder checks its lock connection with a query, so a connection that died silently is caught too. */
export const LOCK_CHECK_MS = 5_000;

/**
 * Opens the worker's lock connection, a client of its own with its pool's settings, outside the pool, so the pool never
 * hands it out or drops it. `onClose` is called once if the connection errors or ends before close() is called.
 */
async function lockConnection(pool: pg.Pool, onClose: (why: string) => void) {
  const client = new pg.Client({ ...(pool.options as pg.ClientConfig), keepAlive: true, query_timeout: LOCK_CHECK_MS * 2 });
  let closing = false;
  let closed = false;
  const lost = (why: string) => {
    if (closing || closed) return;
    closed = true;
    onClose(why);
  };
  client.on("error", (e) => lost(e.message));
  client.on("end", () => lost("the connection ended"));
  await client.connect();
  return {
    /** Takes the worker lock if no other session holds it. True when this connection now holds it. */
    async tryLock(): Promise<boolean> {
      const r = await client.query<{ locked: boolean }>("select pg_try_advisory_lock($1) as locked", [WORKER_LOCK_KEY]);
      return r.rows[0].locked;
    },
    async check(): Promise<void> {
      await client.query("select 1");
    },
    /** Closes the connection, which gives the lock back if it holds it. */
    async close(): Promise<void> {
      if (closing) return;
      closing = true;
      await client.end().catch(() => {});
    },
  };
}

/**
 * Takes the worker lock, or stands by for it, and returns at once either way. Once it holds the lock, it sets up the egress
 * proxy, then starts mirroring, the tick and one poll loop per board. A standby does none of that: it tries for the lock
 * again every `lockRetryMs`. A worker whose lock connection closes stops its jobs and its `done` rejects. startWorker
 * throws if the lock connection can't be opened, or if the proxy fails for a worker that took the lock at once.
 */
export async function startWorker(d: WorkerDeps): Promise<Worker> {
  const log = d.log ?? console;
  const runs = new Map<string, number>();
  let settle!: { resolve: () => void; reject: (e: unknown) => void };
  const done = new Promise<void>((resolve, reject) => void (settle = { resolve, reject }));
  // runProcess and the caller read done. Marked handled here, so a worker nobody watches can't crash its process.
  done.catch(() => {});
  let state: "standby" | "holding" | "stopped" = "standby";
  let stopJobs: (() => Promise<void>) | undefined;
  let retry: NodeJS.Timeout | undefined;
  let check: NodeJS.Timeout | undefined;
  let pending = Promise.resolve();
  let lock: Awaited<ReturnType<typeof lockConnection>> | undefined;

  // A takeover under way finishes first, so the timers it sets are cleared after it.
  const halt = async () => {
    clearTimeout(retry);
    await pending;
    clearTimeout(retry);
    clearInterval(check);
    await stopJobs?.();
    stopJobs = undefined;
    await lock?.close();
  };
  const fail = (e: Error) => {
    if (state === "stopped") return;
    state = "stopped";
    log.error(e.message);
    void halt().then(() => settle.reject(e), () => settle.reject(e));
  };
  const lost = (why: string) => fail(state === "holding"
    ? new Error(`the worker lost the worker lock: its lock connection closed (${why}), so it stops ticking and exits`)
    : new Error(`the worker's lock connection closed while it stood by (${why}), so it exits`));
  lock = await lockConnection(d.pool, lost);
  const held = lock;

  /** Sets up the egress proxy, then starts the jobs. Called once the worker holds the lock. */
  const work = async () => {
    // Cells reach nothing but GitHub, npm, the cell API and the blobs, through the egress proxy (Task 13).
    try {
      await d.egress({ image: d.image, controlUrl: d.controlUrl, blob: d.blob });
    } catch (e) {
      throw new Error(`the egress proxy couldn't be set up, so the worker starts no cell: ${e instanceof Error ? e.message : e}`, { cause: e });
    }
    if (state !== "holding") return;
    stopJobs = jobs(d, runs, log);
    check = setInterval(() => void held.check().catch((e: Error) => lost(e.message)), LOCK_CHECK_MS);
  };
  const tryAgain = () => {
    retry = setTimeout(() => {
      pending = (async () => {
        if (state !== "standby") return;
        let got: boolean;
        try {
          got = await held.tryLock();
        } catch (e) {
          return lost(e instanceof Error ? e.message : String(e));
        }
        if (state !== "standby") return;
        if (!got) return tryAgain();
        state = "holding";
        log.log("The worker took the worker lock, so it starts work.");
        await work().catch((e: Error) => fail(e));
      })();
    }, d.lockRetryMs ?? LOCK_RETRY_MS);
  };

  try {
    if (await held.tryLock()) {
      state = "holding";
      log.log("The worker took the worker lock, so it starts work.");
      await work();
    } else {
      log.log(`Another worker holds the worker lock, so this worker is standing by. It tries again every ${(d.lockRetryMs ?? LOCK_RETRY_MS) / 1000} seconds.`);
      tryAgain();
    }
  } catch (e) {
    state = "stopped";
    await halt();
    throw e;
  }
  return {
    runs,
    done,
    async stop() {
      if (state === "stopped") return void (await done.catch(() => {}));
      state = "stopped";
      await halt();
      settle.resolve();
    },
  };
}

/** Starts mirroring, the tick and one poll loop per board. Returns the call that stops them all. */
function jobs(d: WorkerDeps, runs: Map<string, number>, log: Pick<Console, "log" | "error">): () => Promise<void> {
  const backlogFor = (id: string) => d.sources.find((s) => s.id === id)?.adapter ?? missing<BacklogAdapter>(`no backlog source ${id}`);
  const hooks = [mirrorBoard({ pool: d.pool, backlogFor, repoHost: d.repoHost }), logTransitions({ pool: d.pool })];
  let ticked = false;
  const loops = [every(d.tickMs ?? TICK_MS, "scheduler tick", async () => {
    await tick({
      pool: d.pool, launcher: d.launcher, now: new Date(), killFlag: d.killFlag, repoHost: d.repoHost, backlogFor,
      secret: d.secret, controlUrl: d.controlUrl, sopVersion: d.sopVersion,
    });
    if (!ticked) log.log("The worker ran its first scheduler tick.");
    ticked = true;
  }, runs, log)];
  // Each board files its splits as child issues on itself (PBI 144).
  for (const s of d.sources) {
    const split = d.split && { ...d.split, file: s.file };
    loops.push(every(d.pollMs ?? POLL_INTERVAL_MS, `polling source ${s.id}`,
      () => pollOnce({ pool: d.pool, adapter: s.adapter, repoHost: d.repoHost, judge: d.judge, sourceId: s.id, split }), runs, log));
  }
  return async () => {
    await Promise.all(loops.map((stop) => stop()));
    for (const off of hooks) off();
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

/**
 * Runs the worker as this process: a worker that fails to start, or that stops with an error, as one that lost the worker
 * lock does, exits it with code 1, and the platform restarts it.
 */
export function runProcess(start: () => Promise<Worker>): void {
  start().then((w) => w.done).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}

if (import.meta.main) runProcess(() => main(process.env));
