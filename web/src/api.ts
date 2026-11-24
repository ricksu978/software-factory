// What the SPA's Floor, Run detail, Phase 0 and Activity pages read and send (redesign step 8b, 2026-11-07 design §05
// and §12 step 8). Every call goes through the shell's call (web/src/shell.ts), so only to /bff/v1/*, which the BFF
// forwards one for one to the API's /v1/*:
//   GET  /bff/v1/floor                 FloorData: /v1/floor, today's Floor's data as JSON, with canOperate and claudeToken
//   GET  /bff/v1/items/{id}            ItemData: /v1/items/{id}, everything today's Run detail shows, as JSON
//   GET  /bff/v1/phase0                Phase0Data: /v1/phase0
//   GET  /bff/v1/activity              ActivityData: /v1/activity
//   POST /bff/v1/overrides             OverrideSent, answered 201 { ok: true }, or 4xx { error }
//   POST /bff/v1/items/{id}/decisions  DecisionSent, answered 200 { outcome }, or 4xx { error }
// The shapes follow src/http/views.ts's inputs, with each time as an ISO string and each Map as an object.
// Run detail's address in the SPA is /runs/{id}, Activity's /activity and the Phase 0 report's /phase0. Floor is /.
// This file is free of React and of the "@/" alias, so the BFF's and the tests' Node code can import its types.
import type { Shell } from "./shell.ts";

export type Call = Shell["call"];

/** The issue an item is: its number, and its GitHub repo as owner/name, or null when the factory can't tell. */
export type Issue = { external_id: string; repo: string | null };
export type Named = Issue & { id: string; title: string };
/** The PR an item's open run holds. A row with no open run, or a run with no PR yet, leaves these null. */
export type OpenPr = { pr_number?: number | null; pr_url?: string | null };

/** An item's claim key (PBI 320, PBI 378). */
export type ClaimKey = {
  own: number;
  priority: number;
  priorityFrom: { id: string; externalId: string } | null;
  finalStage: boolean;
  finalStageFrom: { id: string; externalId: string } | null;
  bug: boolean;
};

/** A CI failure Green is fixing (PBI 292). */
export type CiFailure = { sha: string; checks: { name: string; url: string; failingTests: string[] }[] };
/** A Split parent's child (PBI 227), with the state the factory holds it in, or null when it holds none. */
export type SplitChild = { externalId: string; title: string; url: string; state: string | null };

export type MainBreak = {
  branch: string; sha: string; repo: string; pr_number: number | null; charged: string | null;
  bug_external_id: string | null; bug_id: string | null; bug_title: string | null; bug_state?: string | null;
};

export type FloorData = {
  active: (Named & OpenPr & { state: string; stage: string | null; since: string | null; cost: string; badges: string[]; message: string | null; ci_failure?: CiFailure | null })[];
  /** `featureChange`: the item waits in FeatureChangeRequest on the Product Owner (PBI 366). */
  waiting: (Named & OpenPr & { state: string; since: string | null; featureChange?: boolean })[];
  waitingCount: number;
  capacity: number;
  next: Named[];
  notReady: (Named & { failed: string[] })[];
  blocked: (Named & { blocked_by: string[] })[];
  /** The factory-wide overrides in force. */
  factory: { kind: string; reason: string }[];
  /** Every item's claim key, by item id. */
  keys: Record<string, ClaimKey>;
  finalStage: (Named & { state: string })[];
  baseFails: (Named & { sha: string; tests: string[] })[];
  mainBreaks: MainBreak[];
  split: (Named & { children: SplitChild[] })[];
  failed: (Named & { rechecked: string | null })[];
  restart: { running: number; reason?: string } | null;
  /** The cells still running, while a drain or a restart is in force. Absent when the factory gives no count. */
  running?: number;
  cellImage: { started?: string; built: string | null; restart: string | null } | null;
  canOperate: boolean;
  claudeToken: { createdAt: string; ageDays: number; banner: string | null } | null;
  workerHeartbeat?: string | null;
};

export type Stage = {
  stage_id: string; attempt: number; model: string | null; tokens_in: number | null; tokens_out: number | null; cost_usd: string | null;
  status: string; transcript_ref: string | null; started_at?: string; ended_at?: string | null;
  restates?: { round: number; reason: string }[]; message?: string | null;
};

export type CheckVerdict =
  | { outcome: "passed" }
  | { outcome: "failed"; lines: { criterion: string; reason: string }[]; flags: string[] }
  | { outcome: "unreadable" }
  | { outcome: "error" };

export type ReadinessCheck = {
  kind?: "judge" | "split"; model: string; tokensIn: number; tokensOut: number; costUsd: number; ranAt: string; verdict?: CheckVerdict; child?: string;
};

export type ItemDurations = {
  totalMs: number | null;
  queuedMs: number;
  waiting: { signOffMs: number; needsInputMs: number; inReviewMs: number; totalMs: number };
  stages: { stageId: string; ms: number; attempts: number }[];
};

/** Everything today's Run detail shows (src/http/views.ts's RunDetail), as GET /v1/items/{id} answers it. */
export type ItemData = {
  item: Named & { state: string; held?: boolean };
  run: {
    sop_version: string | null; config_sha: string | null; scenarios_sha: string | null; features_lock_sha: string | null;
    risk_tier: string | null; tier_reasons: string[] | null; next_stage: string | null;
    pr_number?: number | null; pr_url?: string | null; open?: boolean;
  } | null;
  policies: { file: string; source: string; criterion: string; status: string; reason: string | null }[];
  stages: Stage[];
  readiness: ReadinessCheck[];
  /** The open question: kind "sign_off" shows the Sign off form, and "needs_input" the Answer form. */
  question: { kind: string; body: string } | null;
  criteria: { criterion: string; scenarios: { name: string; regression: boolean }[] }[] | null;
  scope: string | null;
  pending: { path: string; text: string }[];
  features: { path: string; text: string }[];
  verdicts: { name: string; red: string; green: string }[];
  /** True when the stored transcripts can be served, each from /bff/v1/blobs/{transcript_ref}. */
  linkBlobs: boolean;
  fixingCi?: CiFailure | null;
  /** An operator's override buttons for this item, or null for anyone else. */
  controls: { held: boolean; stoppable: boolean; requeueable: boolean; startable?: boolean; movable?: boolean } | null;
  startNow?: { reason: string; by: string | null } | null;
  moveEnded?: { control: "Move up" | "Move down"; at: string } | null;
  claim?: ClaimKey | null;
  durations?: ItemDurations;
  splitInto?: SplitChild[];
  recheck?: { last: string | null } | null;
};

export type Phase0Data = {
  runs: (Issue & { item_id: string; title: string; pr_url: string | null; merged_at: string | null; cost: number; risk_tier: string | null; tier_reasons: string[] | null })[];
  readinessSpend: number;
};

export type ActivityData = {
  events: { at: string; external_id: string | null; repo: string | null; title: string | null; kind: string; from: string | null; to: string | null; event: string | null;
    actor?: string | null; setting?: string | null; reason?: string | null }[];
};

/** What POST /bff/v1/overrides takes: a factory-wide override has no itemId. */
export type OverrideSent = { kind: string; reason: string; itemId?: string };
/** What POST /bff/v1/items/{id}/decisions takes: the sign-off note or the answer is its text. */
export type DecisionSent = { kind: "approve" | "changes" | "answer"; text: string };

/**
 * What a form's submit handler did:
 *   refused   it sent nothing, since the named field was empty or held only spaces
 *   failed    the factory refused it, or accepted it but the page's data couldn't be read again after, and the page
 *             shows `message`, such as "That item isn't waiting for this decision."
 *   accepted  the factory accepted it, and `data` is the page's data read again from the factory after
 */
export type Submitted<T> =
  | { outcome: "refused"; field: string }
  | { outcome: "failed"; message: string }
  | { outcome: "accepted"; data: T };

/** What each page draws with. `zone` is the viewer's IANA time zone, and `now` the time ages and running attempts count to. */
/** `onSubmit` takes a form's submit, with the button pressed by its text and the form's field as typed. Without it, as
 * when react-dom/server renders the page, a submit does nothing. */
export type FormName = "Controls" | "Sign off" | "Answer";
export type OnSubmit = (form: FormName, button: string, value: string) => void;
export type FloorProps = { data: FloorData; zone: string; now: Date; message?: string | null; onSubmit?: OnSubmit };
export type RunDetailProps = { data: ItemData; zone: string; now: Date; message?: string | null; onSubmit?: OnSubmit };
export type Phase0Props = { data: Phase0Data };
export type ActivityProps = { data: ActivityData };

/**
 * The pages' modules, web/src/pages/*.tsx, export these beside their components. A submit handler takes the button
 * pressed, by its text, and the form's field as typed.
 */
export type FloorModule = {
  submitFloorControls(call: Call, button: string, reason: string): Promise<Submitted<FloorData>>;
};
export type RunDetailModule = {
  submitItemControls(call: Call, item: ItemData, button: string, reason: string): Promise<Submitted<ItemData>>;
  submitSignOff(call: Call, item: ItemData, button: string, note: string): Promise<Submitted<ItemData>>;
  submitAnswer(call: Call, item: ItemData, button: string, answer: string): Promise<Submitted<ItemData>>;
};

/** Reads `path` from the BFF as JSON. Any answer but a 2xx rejects, naming the status and the API's error. */
async function read<T>(call: Call, path: string): Promise<T> {
  const r = await call(path);
  if (!r.ok) {
    const error = ((await r.json().catch(() => null)) as { error?: string } | null)?.error;
    throw new Error(`${path} answered ${r.status}${error ? `: ${error}` : ""}`);
  }
  return (await r.json()) as T;
}

/** Floor's one read of the factory. */
export const readFloor = (call: Call) => read<FloorData>(call, "/bff/v1/floor");

/** Run detail's one read of the factory. */
export const readItem = (call: Call, id: string) => read<ItemData>(call, `/bff/v1/items/${encodeURIComponent(id)}`);

/** The Phase 0 report's one read of the factory. */
export const readPhase0 = (call: Call) => read<Phase0Data>(call, "/bff/v1/phase0");

/** Activity's one read of the factory. */
export const readActivity = (call: Call) => read<ActivityData>(call, "/bff/v1/activity");
