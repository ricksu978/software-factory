// The worker (control plane redesign, §07, step 2 of §12). It sets up the egress proxy that cells reach the outside
// through, runs the scheduler's tick, and polls each board with the readiness judge. Today's control plane,
// src/main.ts, runs none of them, so each job runs in one process. It also works through the outbox (PBI 219): it
// mirrors every process's transitions and overrides onto the board, runs comment commands and announces decisions.
// `aspire run` starts it as the worker resource. A worker runs its jobs only while it holds the factory's worker lock, a session-level Postgres advisory lock
// on a connection of its own (PBI 157). One that can't take it stands by, and one whose lock connection closes exits.
// Each scheduler tick records the worker's heartbeat, the time it started, in worker_heartbeat (PBI 158). It builds the
// cell image from `main`'s fetched commit before the egress proxy, which runs from it, and then keeps it current with
// `main` on each poll, so a merged cell-side change reaches the next cell without a restart (PBI 210).
import { App } from "@octokit/app";
import { join } from "node:path";
import { loadAppKey } from "../adapters/github/app-key.ts";
import pg from "pg";
import { githubRepoHost } from "../adapters/github/repo-host.ts";
import { TimedOctokit } from "../adapters/github/timed.ts";
import type { BacklogAdapter, RepoHost } from "../adapters/types.ts";
import { haikuJudge, runAgent } from "../agent/run.ts";
import type { SplitDeps } from "../gate/split.ts";
import { githubSources, missing, sop, type Source } from "../main.ts";
import { dockerLauncher, ensureEgress, type Launcher } from "../scheduler/launcher.ts";
import { tick, TICK_MS, type CiMemo, type RecheckHoursMemo } from "../scheduler/scheduler.ts";
import { createPool } from "../store/db.ts";
import { recordHeartbeat } from "../store/heartbeat.ts";
import { clearRestartOnStart } from "../store/overrides.ts";
import { pollOnce, POLL_INTERVAL_MS, type PollDeps } from "../watcher/poller.ts";
import { realClock, type Clock } from "./clock.ts";
import type { Clock as SlowClock } from "../control/slow-work.ts";
import { dockerBuilder, pollCellImage, startCellImage, type CellImageDeps } from "./cell-image.ts";
import { mainDefaults } from "./main-defaults.ts";
import { OUTBOX_MS, workOutbox } from "./outbox.ts";

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
  /** How often it works through the outbox. OUTBOX_MS by default. */
  outboxMs?: number;
  /**
   * What each scheduler tick reads its time from, once, as the tick starts, in place of the clock's now(). That time is
   * the tick's `now`, and the worker's heartbeat records it (PBI 158). `clock.now` by default.
   */
  now?: () => Date;
  /**
   * The clock every timer of the worker runs on: each scheduler tick, the outbox loop, each board poll, the standby's
   * lock retry, the holder's lock check and the slow-work warnings of a tick or a poll. Each tick reads its time from
   * it too (PBI 396). realClock by default.
   */
  clock?: Clock;
  pollMs?: number;
  /** How often a standby tries for the worker lock again. LOCK_RETRY_MS by default. */
  lockRetryMs?: number;
  /** Where the worker's log lines go. The console by default. */
  log?: Pick<Console, "log" | "warn" | "error">;
  /**
   * Keeps the cell image current with `main` (PBI 210), and the default policies the poller reads are `main`'s at the
   * commit last fetched into its checkout (PBI 261). Without it, the worker leaves the image as it is and the poller
   * reads the defaults beside its code.
   */
  cellImage?: Omit<CellImageDeps, "pool" | "log">;
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
 * Runs `fn` now and then `ms` after each run ends, on `clock`, so two runs never overlap. A failure is logged and the
 * next run goes ahead. Each run is counted in `runs`. Returns the call that stops it, which waits for a run under way.
 */
function every(clock: Clock, ms: number, what: string, fn: () => Promise<unknown>, runs: Map<string, number>, log: Pick<Console, "error">): () => Promise<void> {
  let stopped = false;
  let timer: unknown;
  let current = Promise.resolve();
  // Returns the run, so a fake clock waits for it before it fires the next timer.
  const run = () => {
    current = (async () => {
      await attempt(what, fn, log);
      runs.set(what, (runs.get(what) ?? 0) + 1);
      if (!stopped) timer = clock.setTimeout(run, ms);
    })();
    return current;
  };
  void run();
  return async () => {
    stopped = true;
    clock.clearTimeout(timer);
    await current;
  };
}

/** The worker's clock as the slow-work warnings of a tick or a poll read it (PBI 134). */
function slowClock(clock: Clock): SlowClock {
  return { now: () => clock.now().getTime(), setTimeout: (fn, ms) => clock.setTimeout(fn, ms), clearTimeout: (h) => clock.clearTimeout(h) };
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
    /**
     * Gives the lock back, then closes the connection. Postgres frees a closed session's locks only once its backend
     * exits, a moment after end() resolves, so the explicit unlock is what lets a standby take the lock at its next try.
     */
    async close(): Promise<void> {
      if (closing) return;
      closing = true;
      if (!closed) await client.query("select pg_advisory_unlock_all()").catch(() => {});
      await client.end().catch(() => {});
    },
  };
}

/**
 * Takes the worker lock, or stands by for it, and returns at once either way. Once it holds the lock, it sets up the egress
 * proxy, then starts the outbox loop, the tick and one poll loop per board. A standby does none of that: it tries for the lock
 * again every `lockRetryMs`. Either way it first clears a restart prepared before it started. A worker whose lock connection closes stops its jobs and its `done` rejects. startWorker
 * throws if the lock connection can't be opened, or if the proxy fails for a worker that took the lock at once.
 */
export async function startWorker(d: WorkerDeps): Promise<Worker> {
  const log = d.log ?? console;
  const clock = d.clock ?? realClock;
  const runs = new Map<string, number>();
  let settle!: { resolve: () => void; reject: (e: unknown) => void };
  const done = new Promise<void>((resolve, reject) => void (settle = { resolve, reject }));
  // runProcess and the caller read done. Marked handled here, so a worker nobody watches can't crash its process.
  done.catch(() => {});
  let state: "standby" | "holding" | "stopped" = "standby";
  let stopJobs: (() => Promise<void>) | undefined;
  let retry: unknown;
  let check: unknown;
  let pending = Promise.resolve();
  let lock: Awaited<ReturnType<typeof lockConnection>> | undefined;

  // A prepared restart holds back the tick, which runs here, so a worker restarted on its own clears it too (PBI 140).
  // A standby clears it as well: the restart was meant to end once the worker process came back.
  await clearRestartOnStart(d.pool);
  // A takeover under way finishes first, so the timers it sets are cleared after it.
  const halt = async () => {
    clock.clearTimeout(retry);
    await pending;
    clock.clearTimeout(retry);
    clock.clearTimeout(check);
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
    // A failed build is logged and leaves the image there was, so the worker still starts on it. A later poll tries again.
    if (d.cellImage) await attempt("building the cell image from main", () => startCellImage({ ...d.cellImage!, pool: d.pool, log }), log);
    // Cells reach nothing but GitHub, npm, the cell API and the blobs, through the egress proxy (Task 13).
    try {
      await d.egress({ image: d.image, controlUrl: d.controlUrl, blob: d.blob });
    } catch (e) {
      throw new Error(`the egress proxy couldn't be set up, so the worker starts no cell: ${e instanceof Error ? e.message : e}`, { cause: e });
    }
    if (state !== "holding") return;
    stopJobs = jobs(d, clock, runs, log);
    checkLater();
  };
  // Each check is set once the one before it has answered, so a fake clock waits for its query.
  const checkLater = () => {
    check = clock.setTimeout(() => held.check().then(() => {
      if (state === "holding") checkLater();
    }, (e: Error) => lost(e.message)), LOCK_CHECK_MS);
  };
  const tryAgain = () => {
    retry = clock.setTimeout(() => {
      return pending = (async () => {
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

/** Starts the outbox loop, the tick and one poll loop per board. Returns the call that stops them all. */
function jobs(d: WorkerDeps, clock: Clock, runs: Map<string, number>, log: Pick<Console, "log" | "error">): () => Promise<void> {
  const backlogFor = (id: string) => d.sources.find((s) => s.id === id)?.adapter ?? missing<BacklogAdapter>(`no backlog source ${id}`);
  let ticked = false;
  const ciMemo: CiMemo = new Map();
  const recheckHours: RecheckHoursMemo = new Map();
  const slow = { clock: slowClock(clock) };
  const loops = [every(clock, d.tickMs ?? TICK_MS, "scheduler tick", async () => {
    const now = d.now ? d.now() : clock.now();
    try {
      await tick({
        pool: d.pool, launcher: d.launcher, now, killFlag: d.killFlag, repoHost: d.repoHost, backlogFor,
        secret: d.secret, controlUrl: d.controlUrl, sopVersion: d.sopVersion, ciMemo, recheckHours,
        slow,
      });
    } finally {
      // Every tick records the heartbeat, one with nothing to do, one under the kill switch and one that failed too,
      // because each shows the worker is alive (PBI 158). A heartbeat that can't be written is logged, not thrown, so
      // the tick's own outcome is what the log reports for it.
      try {
        await recordHeartbeat(d.pool, now);
      } catch (e) {
        log.error("The worker heartbeat couldn't be written:", e);
      }
    }
    if (!ticked) log.log("The worker ran its first scheduler tick.");
    ticked = true;
  }, runs, log)];
  loops.push(every(clock, d.outboxMs ?? OUTBOX_MS, "working through the outbox", () => workOutbox({ pool: d.pool, backlogFor, repoHost: d.repoHost }), runs, log));
  // The default policies come from the commit of `main` the cell image loop last fetched into the checkout, so a merged
  // change to one re-checks NotReady items on the next poll with no restart (PBI 261).
  const defaults = d.cellImage && mainDefaults(d.cellImage);
  // Each board files its splits as child issues on itself (PBI 144).
  for (const s of d.sources) {
    const split = d.split && { ...d.split, file: s.file };
    loops.push(every(clock, d.pollMs ?? POLL_INTERVAL_MS, `polling source ${s.id}`,
      () => pollOnce({ pool: d.pool, adapter: s.adapter, repoHost: d.repoHost, judge: d.judge, sourceId: s.id, split, slow, ...(defaults ? { defaults } : {}) }), runs, log));
  }
  if (d.cellImage) {
    const cellImage = { ...d.cellImage, pool: d.pool, log };
    loops.push(every(clock, d.pollMs ?? POLL_INTERVAL_MS, "polling main for the cell image", () => pollCellImage(cellImage), runs, log));
  }
  return async () => {
    await Promise.all(loops.map((stop) => stop()));
  };
}

/** Reads the worker's settings from `env` and starts it with the real board, repo host, launcher and judge. */
export async function main(env: NodeJS.ProcessEnv, egress: Egress = ensureEgress): Promise<Worker> {
  loadAppKey(env);
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
  const app = new App({ appId, privateKey: appKey, Octokit: TimedOctokit });
  const { sources, installationId } = await githubSources(pool, app, env.GITHUB_PROJECT_TOKEN || null);
  if (!sources.length) console.warn("No backlog source is configured yet, so the factory takes no item. Add config/sources.yml and restart aspire run.");
  const repoHost = installationId === null ? missing<RepoHost>("no repo is configured") : githubRepoHost(app, installationId);
  return startWorker({
    pool, sources, repoHost, launcher: dockerLauncher({ image }), egress, image, controlUrl, blob,
    judge: haikuJudge(sop),
    // One split cache for every poll, so a re-gate of item text already split doesn't ask the coding model again.
    split: { sop, agent: runAgent, seen: new Map() },
    killFlag: env.FACTORY_KILL === "1", secret, sopVersion: sop.version,
    // The worker runs from the operator's checkout, which `main` is fetched into. Its working tree is never touched.
    cellImage: { checkout: join(import.meta.dirname, "..", ".."), builder: dockerBuilder(), tag: image },
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
