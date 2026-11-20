// The cell's side of the cell API (plan Task 12), over HTTP with the run token. A 409 means the lease generation
// moved on, so the cell must stop at once (Run contract 2).
import type { ItemEvent } from "../core/states.ts";
import type { CiCheck, FailedCheck } from "../adapters/types.ts";
import type { Verdict } from "../policy/policy.ts";
import type { CellContext } from "./engine.ts";
import { realSleep, Transient, withRetries } from "./retry.ts";

/** How long the cell waits for the cell API to answer one try before it counts as a timeout (PBI 259). */
export const CALL_TIMEOUT_MS = 90_000;

export class LeaseLost extends Error {
  override name = "LeaseLost";
}

export type CheckStatus = "pending" | "success" | "failure" | "none";
/**
 * The cell API's answer about CI on a commit. On failure it names each failed check with its URL and the last 100
 * lines of its log, or a null log when the repo host couldn't give it (PBI 232). Otherwise `failedChecks` is empty.
 */
export type CheckAnswer = { status: CheckStatus; failedChecks: FailedCheck[] };
export type StageReport = {
  stageId: string; attempt: number; status: "started" | "passed" | "failed" | "stopped"; model: string;
  tokensIn: number; tokensOut: number; costUsd: number; usage?: { utilization: number; resetsAt: string | null };
  /** The text of the stage's own prompted agent call, for Floor. The cell API keeps the first 500 characters. */
  message?: string;
  /** A passed self-review's `SCENARIO NOTE:` lines, kept with the run for a later claim's PR body (PBI 152). */
  scenarioNotes?: string[];
  /** PBI 190: each time in this attempt the PR reviewer was asked to restate an answer, by round, with why it couldn't be read. */
  restates?: { round: number; reason: string }[];
  /**
   * PBI 292: set on a Green attempt that fixes a CI failure on one of the run's own commits: the commit CI failed on
   * and each failed check, with its URL and the tests it names as failing. Floor and the item's page show it.
   */
  ciFailure?: CiFailure;
};
/** PBI 292: a CI failure on a commit a stage pushed, as Green gets it back to fix. */
export type CiFailure = { sha: string; checks: { name: string; url: string; failingTests: string[] }[] };
export type TransitionBody = {
  event: Extract<ItemEvent, "scenarios_written" | "blocked" | "pr_opened" | "retries_exhausted" | "usage_limited">;
  /** `baseFailure` marks a question that blames the base commit, with the tests that fail on it, for Floor (PBI 215), and the base branch it names, which PBI 260 re-queues on. */
  question?: { kind: "needs_input" | "sign_off"; body: string; baseFailure?: { sha: string; tests: string[]; base?: string } }; scenariosSha?: string; lockedFiles?: string[];
  prNumber?: number; prUrl?: string; resumeAt?: string; tier?: "Low" | "Medium" | "High"; tierReasons?: string[];
};
export type PolicyResults = { file: "pr-review" | "dod"; source: "repo" | "default"; stageId: string; attempt: number; checkedSha: string; verdicts: Verdict[] };

/**
 * A lease renewal's answer. `stop` cuts the stage short now (PBI 140). `restarting` says a restart is being prepared, so
 * the cell finishes the stage it's in, starts no further stage and ends its claim at that stage boundary (PBI 301).
 */
export type LeaseAnswer = { stop: boolean; restarting?: boolean };

export type CellApi = {
  /**
   * Renews the lease. `once` tries it a single time, for the renewal loop, which keeps its own tolerance of 3 minutes
   * of failed renewals (PBI 259). Every other call is retried on a 5xx, a connection fault or a timeout.
   */
  lease(opts?: { once?: boolean }): Promise<LeaseAnswer>;
  stage(b: StageReport): Promise<void>;
  transition(b: TransitionBody): Promise<void>;
  policyResults(b: PolicyResults): Promise<void>;
  pr(b: { prNumber: number; prUrl: string }): Promise<void>;
  checks(sha: string): Promise<CheckAnswer>;
  /** PBI 234: the names of the checks still pending on `sha`, for the question when CI stays pending for 60 minutes. */
  pendingChecks?(sha: string): Promise<string[]>;
  /**
   * The checks CI named on one of the run's own commits, or null when none has reported there (PBI 229). A cell API
   * without it judges every dod.md line by its command or the judge, as before. With `on: "base"` it reads a commit on
   * the base branch instead, as PBI 292 does to tell a CI failure the base shares from the item's own.
   */
  ciChecks?(sha: string, on?: "base"): Promise<CiCheck[] | null>;
  /**
   * PBI 233: asks the repo host to re-run the named checks that failed on `sha`, one of the run's own commits. It
   * rejects when the repo host refuses to start the re-run. The checks' new results come from `checks` as before.
   */
  rerunFailedChecks?(sha: string, checks: string[]): Promise<void>;
  /**
   * Ends the claim of a cell a restart stopped with no attempt open (PBI 140), or of one that ended at a stage boundary
   * while a restart was being prepared (PBI 301). Outside a restart it changes nothing.
   */
  release(): Promise<void>;
  /** Gets a write-only URL from /upload-url and puts `body` there. */
  upload(b: { kind: "transcript" | "report"; stageId: string; attempt: number; body: string }): Promise<void>;
};

export type HttpCellApi = CellApi & {
  context(): Promise<CellContext>; githubToken(): Promise<string>;
  /** Moves the run to SOP `to` from SOP `from` (PBI 173). */
  moveSop(b: { from: string; to: string }): Promise<void>;
};

/**
 * What the HTTP client runs on, for tests: the fetch it calls and the clock it waits on between tries (PBI 259).
 * Each defaults to the real one.
 */
export type HttpDeps = {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

export function httpCellApi(cfg: { controlUrl: string; runId: string; runToken: string; generation: number }, deps: HttpDeps = {}): HttpCellApi {
  const fetch = deps.fetch ?? globalThis.fetch;
  const base = `${cfg.controlUrl.replace(/\/$/, "")}/internal/cells/${encodeURIComponent(cfg.runId)}`;
  // One try: a 409 is LeaseLost, a 5xx or a fetch that rejects (refused, reset, timed out) is Transient, and any other
  // answer that isn't ok fails as it is. Each try sends the same request.
  const once = async (method: "GET" | "POST", path: string, body?: unknown): Promise<any> => {
    let res: Response;
    try {
      res = await fetch(base + path, {
        method,
        headers: { authorization: `Bearer ${cfg.runToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (e) {
      throw new Transient(`${method} ${path}: ${describe(e)}`, { cause: e });
    }
    if (res.status === 409) throw new LeaseLost(`${method} ${path}: the lease generation moved on`);
    if (res.status >= 500) throw new Transient(`${method} ${path}: ${res.status} ${await res.text().catch(() => "")}`);
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
    return res.json();
  };
  const sleep = deps.sleep ?? realSleep;
  const call = (method: "GET" | "POST", path: string, body?: unknown, opts: { once?: boolean } = {}): Promise<any> =>
    opts.once ? once(method, path, body) : withRetries(`${method} ${path.split("?")[0]}`, () => once(method, path, body), { transient: (e) => e instanceof Transient, sleep });
  return {
    lease: async (opts) => {
      const a = await call("POST", "/lease", { generation: cfg.generation }, opts);
      return { stop: a.stop === true, ...(a.restarting === true ? { restarting: true } : {}) };
    },
    context: () => call("GET", "/context"),
    githubToken: async () => (await call("POST", "/github-token", {})).token,
    stage: async (b) => void (await call("POST", "/stage", b)),
    transition: async (b) => void (await call("POST", "/transition", b)),
    policyResults: async (b) => void (await call("POST", "/policy-results", b)),
    pr: async (b) => void (await call("POST", "/pr", b)),
    release: async () => void (await call("POST", "/release", {})),
    moveSop: async (b) => void (await call("POST", "/sop-move", b)),
    checks: async (sha) => {
      const a = await call("GET", `/checks?sha=${encodeURIComponent(sha)}`);
      return { status: a.status, failedChecks: Array.isArray(a.failedChecks) ? a.failedChecks : [] };
    },
    pendingChecks: async (sha) => (await call("GET", `/pending-checks?sha=${encodeURIComponent(sha)}`)).checks,
    // Sent once: a retry could start a second re-run of the same checks, and a commit's checks are re-run once at most.
    rerunFailedChecks: async (sha, checks) => void (await call("POST", "/rerun-checks", { sha, checks }, { once: true })),
    ciChecks: async (sha, on) => (await call("GET", `/ci-checks?sha=${encodeURIComponent(sha)}${on ? `&on=${on}` : ""}`)).checks,
    async upload({ kind, stageId, attempt, body }) {
      const { url } = await call("POST", "/upload-url", { kind, stageId, attempt });
      const res = await fetch(url, { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob" }, body });
      if (!res.ok) throw new Error(`upload ${kind} ${stageId}-${attempt}: ${res.status}`);
    },
  };
}

/** A fetch failure's own words: undici's "fetch failed" hides them in its cause. */
function describe(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = e.cause instanceof Error ? `: ${e.cause.message}` : "";
  return `${e.name === "TimeoutError" ? "no answer in time" : e.message}${cause}`;
}
