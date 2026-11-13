// The cell's side of the cell API (plan Task 12), over HTTP with the run token. A 409 means the lease generation
// moved on, so the cell must stop at once (Run contract 2).
import type { ItemEvent } from "../core/states.ts";
import type { FailedCheck } from "../adapters/types.ts";
import type { Verdict } from "../policy/policy.ts";
import type { CellContext } from "./engine.ts";

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
};
export type TransitionBody = {
  event: Extract<ItemEvent, "scenarios_written" | "blocked" | "pr_opened" | "retries_exhausted" | "usage_limited">;
  question?: { kind: "needs_input" | "sign_off"; body: string }; scenariosSha?: string; lockedFiles?: string[];
  prNumber?: number; prUrl?: string; resumeAt?: string; tier?: "Low" | "Medium" | "High"; tierReasons?: string[];
};
export type PolicyResults = { file: "pr-review" | "dod"; source: "repo" | "default"; stageId: string; attempt: number; checkedSha: string; verdicts: Verdict[] };

export type CellApi = {
  lease(): Promise<{ stop: boolean }>;
  stage(b: StageReport): Promise<void>;
  transition(b: TransitionBody): Promise<void>;
  policyResults(b: PolicyResults): Promise<void>;
  pr(b: { prNumber: number; prUrl: string }): Promise<void>;
  checks(sha: string): Promise<CheckAnswer>;
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

export function httpCellApi(cfg: { controlUrl: string; runId: string; runToken: string; generation: number }): HttpCellApi {
  const base = `${cfg.controlUrl.replace(/\/$/, "")}/internal/cells/${encodeURIComponent(cfg.runId)}`;
  const call = async (method: "GET" | "POST", path: string, body?: unknown): Promise<any> => {
    const res = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${cfg.runToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 409) throw new LeaseLost(`${method} ${path}: the lease generation moved on`);
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
    return res.json();
  };
  return {
    lease: async () => ({ stop: (await call("POST", "/lease", { generation: cfg.generation })).stop === true }),
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
    async upload({ kind, stageId, attempt, body }) {
      const { url } = await call("POST", "/upload-url", { kind, stageId, attempt });
      const res = await fetch(url, { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob" }, body });
      if (!res.ok) throw new Error(`upload ${kind} ${stageId}-${attempt}: ${res.status}`);
    },
  };
}
