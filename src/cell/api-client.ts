// The cell's side of the cell API (plan Task 12), over HTTP with the run token. A 409 means the lease generation
// moved on, so the cell must stop at once (Run contract 2).
import type { ItemEvent } from "../core/states.ts";
import type { CiCheck } from "../adapters/types.ts";
import type { Verdict } from "../policy/policy.ts";
import type { CellContext } from "./engine.ts";
import { realSleep, Transient, withRetries } from "./retry.ts";

/** How long the cell waits for the cell API to answer one try before it counts as a timeout (PBI 259). */
export const CALL_TIMEOUT_MS = 90_000;

export class LeaseLost extends Error {
  override name = "LeaseLost";
}

export type CheckStatus = "pending" | "success" | "failure" | "none";
export type StageReport = {
  stageId: string; attempt: number; status: "started" | "passed" | "failed" | "stopped"; model: string;
  tokensIn: number; tokensOut: number; costUsd: number; usage?: { utilization: number; resetsAt: string | null };
  /** The text of the stage's own prompted agent call, for Floor. The cell API keeps the first 500 characters. */
  message?: string;
  /** A passed self-review's `SCENARIO NOTE:` lines, kept with the run for a later claim's PR body (PBI 152). */
  scenarioNotes?: string[];
  /** PBI 190: each time in this attempt the PR reviewer was asked to restate an answer, by round, with why it couldn't be read. */
  restates?: { round: number; reason: string }[];
};
export type TransitionBody = {
  event: Extract<ItemEvent, "scenarios_written" | "blocked" | "pr_opened" | "retries_exhausted" | "usage_limited">;
  /** `baseFailure` marks a question that blames the base commit, with the tests that fail on it, for Floor (PBI 215). */
  question?: { kind: "needs_input" | "sign_off"; body: string; baseFailure?: { sha: string; tests: string[] } }; scenariosSha?: string; lockedFiles?: string[];
  prNumber?: number; prUrl?: string; resumeAt?: string; tier?: "Low" | "Medium" | "High"; tierReasons?: string[];
};
export type PolicyResults = { file: "pr-review" | "dod"; source: "repo" | "default"; stageId: string; attempt: number; checkedSha: string; verdicts: Verdict[] };

export type CellApi = {
  /**
   * Renews the lease. `once` tries it a single time, for the renewal loop, which keeps its own tolerance of 3 minutes
   * of failed renewals (PBI 259). Every other call is retried on a 5xx, a connection fault or a timeout.
   */
  lease(opts?: { once?: boolean }): Promise<{ stop: boolean }>;
  stage(b: StageReport): Promise<void>;
  transition(b: TransitionBody): Promise<void>;
  policyResults(b: PolicyResults): Promise<void>;
  pr(b: { prNumber: number; prUrl: string }): Promise<void>;
  checks(sha: string): Promise<CheckStatus>;
  /**
   * The checks CI named on one of the run's own commits, or null when none has reported there (PBI 229). A cell API
   * without it judges every dod.md line by its command or the judge, as before.
   */
  ciChecks?(sha: string): Promise<CiCheck[] | null>;
  /** Ends the claim of a cell a restart stopped with no attempt open (PBI 140). Outside a restart it changes nothing. */
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
  now?: () => Date;
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
    lease: async (opts) => ({ stop: (await call("POST", "/lease", { generation: cfg.generation }, opts)).stop === true }),
    context: () => call("GET", "/context"),
    githubToken: async () => (await call("POST", "/github-token", {})).token,
    stage: async (b) => void (await call("POST", "/stage", b)),
    transition: async (b) => void (await call("POST", "/transition", b)),
    policyResults: async (b) => void (await call("POST", "/policy-results", b)),
    pr: async (b) => void (await call("POST", "/pr", b)),
    release: async () => void (await call("POST", "/release", {})),
    moveSop: async (b) => void (await call("POST", "/sop-move", b)),
    checks: async (sha) => (await call("GET", `/checks?sha=${encodeURIComponent(sha)}`)).status,
    ciChecks: async (sha) => (await call("GET", `/ci-checks?sha=${encodeURIComponent(sha)}`)).checks,
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
