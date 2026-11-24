// The cell API (plan Task 12). A cell reaches the control plane only here, with a run token tied to its lease
// generation. Each call checks the token under the item's row lock, in the same transaction as its writes, so a
// re-claim or the cell's own transition can't slip in between the check and the write (Review Focus 2).
import { BlobSASPermissions, BlobServiceClient } from "@azure/storage-blob";
import { createHmac, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { githubFailed } from "../adapters/github/errors.ts";
import { botKey, loginKey, withoutFactoryThreads, type BacklogAdapter, type RepoHost, type ReviewComment } from "../adapters/types.ts";
import type { CiFailure } from "../cell/api-client.ts";
import { SOP_MOVED } from "../cell/sop-move.ts";
import type { FeatureChangeFile } from "../core/feature-change.ts";
import type { ItemEvent } from "../core/states.ts";
import { BadRequest, json, readJson, type Handler } from "../http/server.ts";
import { withTx } from "../store/db.ts";
import { appendEvent } from "../store/events.ts";
import { requestFeatureChange } from "../store/feature-change.ts";
import { closeStartedAttempts, LEASE_RAN_OUT, renewLease, transitionItem } from "../store/items.ts";
import { readSnapshot, SnapshotMissing, storeSnapshot } from "../store/run-snapshot.ts";
import { repoName, runBranch } from "../store/runs.ts";
import { seconds, SLOW_REQUEST_MS, watch, watched, type Slow } from "./slow-work.ts";
import { GatewayUnavailable, handleModelRequest, type Grant, type WebTool } from "./model-gateway.ts";

/** HMAC-SHA256(secret, runId + ":" + generation) in hex. The scheduler hands it to the cell as RUN_TOKEN. */
export function runToken(secret: string, runId: string, generation: number): string {
  return createHmac("sha256", secret).update(`${runId}:${generation}`).digest("hex");
}

export type CellApiDeps = {
  pool: pg.Pool;
  secret: string;
  repoHost: RepoHost;
  backlogFor: (sourceId: string) => BacklogAdapter;
  /** The stage after `stageId` in the run's pinned SOP, or null after the last. Task 14's loadSop backs it. */
  stageAfter: (sopVersion: string | null, stageId: string) => string | null;
  /** A write-only URL for a blob path, valid for 15 minutes. `blobUploadUrl` makes one from Azurite. */
  uploadUrl: (path: string) => Promise<string>;
  gateway: { upstream: string; ownerToken: () => string };
  /** The web tools a repo config allows: `(text) => parseRepoConfig(text).webTools` from Task 9. Throws on a bad config. */
  webToolsOf: (configYaml: string | null) => WebTool[];
  /** True while the kill switch's env flag is on. Defaults to reading FACTORY_KILL=1. */
  killSwitch?: () => boolean;
  now?: () => Date;
  /** Where a request still open after 60 seconds warns, and the clock that times it (PBI 134). */
  slow?: Slow;
};

// The only events a cell may send. Everything else is the control plane's, such as merged, which a steered cell
// could otherwise use to mark its own PR accepted.
const cellEvents = new Set<ItemEvent>(["scenarios_written", "blocked", "pr_opened", "retries_exhausted", "usage_limited", "feature_change_requested"]);
const NONE_AFTER_MS = 600_000;
// The stages a run stays at while its item goes back to green, from their findings or CI failing on their head.
const BACK_TO_GREEN_FROM = new Set(["open-pr", "pr-review", "address"]);
const USAGE_PAUSE_MS = 5 * 3_600_000;
/** Floor shows a stage's last agent message cut to 500 characters, counted by code point so no emoji is split. */
const cut = (s: string | null) => (s === null ? null : Array.from(s).slice(0, 500).join(""));
/** Reads a failed `/stage` report's `retryCarry` (PBI 393): the tries its stage spent, and the attempt's
 * findings, at most 50 of 4,000 characters each, for the next claim's brief. */
export function retryCarryOf(v: unknown): { tried: number; findings: string[] } {
  const r = v as { tried?: unknown; findings?: unknown } | null;
  if (!r || !Number.isInteger(r.tried) || (r.tried as number) < 1 || !Array.isArray(r.findings) || !r.findings.every((f) => typeof f === "string")) {
    throw new BadRequest("retryCarry must be { tried, findings }");
  }
  return { tried: r.tried as number, findings: (r.findings as string[]).slice(0, 50).map((f) => Array.from(f).slice(0, 4000).join("")) };
}

/**
 * Reads a `/stage` report's `ciFailure` (PBI 292): the commit CI failed on and each failed check, with its URL and
 * failing tests. Each string is cut to 500 characters, and at most 20 checks and 20 tests a check are kept.
 * Floor and Run detail link each check's `url`, so it must be an https link under the run's repo on GitHub, or under
 * `https://github.com/` for a run with no repo yet. An empty `url` means GitHub gave the check none, and the views show
 * its name unlinked. Any other URL, a `javascript:` one included, gets 400, as a `prUrl` that differs from the one the
 * factory builds does.
 */
export function ciFailureOf(v: unknown, repoUrl: string | null): { sha: string; checks: { name: string; url: string; failingTests: string[] }[] } {
  const base = repoUrl ? `${repoUrl.replace(/\/$/, "")}/` : "https://github.com/";
  const f = v as { sha?: unknown; checks?: unknown } | null;
  const isStr = (x: unknown): x is string => typeof x === "string";
  if (!f || !isStr(f.sha) || !Array.isArray(f.checks)) throw new BadRequest("ciFailure must be { sha, checks }");
  const checks = f.checks.map((c: { name?: unknown; url?: unknown; failingTests?: unknown }) => {
    if (!isStr(c?.name) || !isStr(c?.url) || !(c.failingTests === undefined || (Array.isArray(c.failingTests) && c.failingTests.every(isStr)))) {
      throw new BadRequest("each ciFailure check must be { name, url, failingTests }");
    }
    if (c.url !== "" && (!c.url.startsWith(base) || !/^https:\/\//.test(c.url))) throw new BadRequest(`each ciFailure check's url must start with ${base}`);
    return { name: cut(c.name)!, url: cut(c.url)!, failingTests: ((c.failingTests ?? []) as string[]).slice(0, 20).map((t) => cut(t)!) };
  });
  return { sha: cut(f.sha)!, checks: checks.slice(0, 20) };
}
// ponytail: every Phase 0 repo builds on main. Add repo.default_branch when a target repo doesn't.
export const BASE = "main";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Run = {
  run_id: string; item_id: string; generation: number; state: string; source_id: string; external_id: string; title: string;
  run_number: number; started_at: Date; next_stage: string | null; branch: string | null; pr_number: number | null; locked_files: string[] | null;
  features_lock_sha: string | null; config_sha: string | null; sop_version: string | null; repo_url: string | null; trusted_bot: string | null;
  scenario_notes: string[];
};
type Call = { c: pg.PoolClient; run: Run; body: Record<string, unknown>; query: URLSearchParams; now: Date };
type Route = (deps: CellApiDeps, call: Call) => Promise<unknown>;

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** A run token's shape: `runToken`'s 64 lowercase hex digits. A user's sign-in token is a JWT, which never has it. */
const RUN_TOKEN = /^[0-9a-f]{64}$/;

/** Thrown when the token is wrong or from an older generation. The route answers 409 and the transaction rolls back. */
class Fenced extends Error {}

async function lockRun(c: pg.PoolClient, runId: string): Promise<Run | null> {
  const r = await c.query<Run>(
    `select r.id as run_id, i.id as item_id, i.lease_generation as generation, i.state, i.source_id, i.external_id, i.title,
       r.run_number, r.started_at, r.next_stage, r.branch, r.pr_number, r.locked_files, r.features_lock_sha, r.config_sha, r.sop_version, r.scenario_notes,
       repo.url as repo_url, repo.trusted_bot
     from run r join item i on i.id = r.item_id left join repo on repo.id = r.repo_id
     where r.id = $1 for update of i`,
    [runId],
  );
  return r.rows[0] ?? null;
}

/** True when `token` is the run token for the item's current generation and the item is still running. */
function current(secret: string, run: Run | null, token: string): run is Run {
  return run !== null && run.state === "InProgress" && same(runToken(secret, run.run_id, run.generation), token);
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || v === "") throw new BadRequest(`${name} must be a non-empty string`);
  return v;
};
const int = (v: unknown, name: string): number => {
  if (!Number.isInteger(v) || (v as number) < 1) throw new BadRequest(`${name} must be a positive integer`);
  return v as number;
};
const oneOf = <T extends string>(v: unknown, name: string, allowed: readonly T[]): T => {
  if (!allowed.includes(v as T)) throw new BadRequest(`${name} must be one of ${allowed.join(", ")}`);
  return v as T;
};
const strings = (v: unknown, name: string): string[] => {
  if (!Array.isArray(v) || v.some((s) => typeof s !== "string")) throw new BadRequest(`${name} must be a list of strings`);
  return v;
};
/**
 * PBI 364: a feature change request's files, each a file the run locked, with a reason and the proposed version.
 * The cell isn't trusted with `before`: it's read here from the lock commit, so the owner's diff runs from the text
 * they signed off. A cell's own `before` is ignored.
 */
const featureChange = async (deps: CellApiDeps, run: Run, v: unknown): Promise<FeatureChangeFile[]> => {
  const locked = run.locked_files ?? [];
  if (!Array.isArray(v) || v.length === 0) throw new BadRequest("featureChange must be a non-empty list");
  const files = v.map((f: Record<string, unknown> | null, i) => {
    if (typeof f !== "object" || f === null) throw new BadRequest(`featureChange[${i}] must be an object`);
    const path = str(f.path, `featureChange[${i}].path`);
    if (!locked.includes(path)) throw new BadRequest(`featureChange[${i}].path ${path} isn't a locked feature file`);
    if (typeof f.after !== "string") throw new BadRequest(`featureChange[${i}] needs after as a string`);
    return { path, reason: str(f.reason, `featureChange[${i}].reason`), after: f.after };
  });
  if (!run.features_lock_sha) throw new BadRequest("the run has no lock commit");
  const repo = repoOf(run);
  const out: FeatureChangeFile[] = [];
  for (const f of files) {
    const before = await deps.repoHost.readFile(repo, run.features_lock_sha, f.path);
    if (before === null) throw new BadRequest(`${f.path} isn't in the lock commit ${run.features_lock_sha}`);
    out.push({ path: f.path, reason: f.reason, before, after: f.after });
  }
  return out;
};
const optional = <T>(v: unknown, read: (v: unknown) => T): T | null => (v === undefined || v === null ? null : read(v));

function repoOf(run: Run): string {
  if (!run.repo_url) throw new BadRequest("the run has no repo yet");
  return repoName(run.repo_url);
}

function shaOf(query: URLSearchParams): string {
  const sha = query.get("sha") ?? "";
  if (!/^[0-9a-f]{7,64}$/.test(sha)) throw new BadRequest("sha must be a commit sha");
  return sha;
}

/** Why `sha` isn't one of the run's own commits, or null when it is. */
async function notOwnCommit(deps: CellApiDeps, run: Run, sha: string): Promise<string | null> {
  const repo = repoOf(run);
  const branch = runBranch({ branch: run.branch, externalId: run.external_id, runNumber: run.run_number });
  if (!(await deps.repoHost.onBranch(repo, branch, sha))) return `${sha} isn't on ${branch}`;
  // The branch starts from main, so main's commits are its ancestors too. Only the branch's own commits pass, or a
  // cell could ask about main's green head instead of its own push.
  if (await deps.repoHost.onBranch(repo, BASE, sha)) return `${sha} is on ${BASE}, not only on ${branch}`;
  return null;
}

/** The `sha` a cell asks about, which must be one of its branch's own commits, with the run's repo. */
async function ownCommit(deps: CellApiDeps, run: Run, query: URLSearchParams): Promise<{ repo: string; sha: string }> {
  const sha = shaOf(query);
  const notOwn = await notOwnCommit(deps, run, sha);
  if (notOwn) throw new BadRequest(notOwn);
  return { repo: repoOf(run), sha };
}

/**
 * The PR's URL, built from the run's repo, never taken from the cell, because the board links it from a public item.
 * A `prUrl` the cell sends must be that same URL.
 */
function prUrlFor(run: Run, prNumber: number, sent: unknown): string {
  if (!run.repo_url) throw new BadRequest("the run has no repo yet");
  const url = `${run.repo_url.replace(/\/$/, "")}/pull/${prNumber}`;
  if (sent !== undefined && sent !== null && sent !== url) throw new BadRequest(`prUrl must be ${url}`);
  return url;
}

function question(v: unknown, kind: "sign_off" | "needs_input"): string {
  const q = v as { kind?: unknown; body?: unknown } | undefined;
  oneOf(q?.kind, "question.kind", [kind]);
  return str(q?.body, "question.body");
}

/** A blocked question's base failure: the base commit, its failing tests, and the base branch, which PBI 260 re-queues on. */
function baseFailure(v: unknown): { sha: string; tests: string[]; base?: string } | null {
  const f = (v as { baseFailure?: unknown } | undefined)?.baseFailure as { sha?: unknown; tests?: unknown; base?: unknown } | undefined | null;
  return optional(f, () => {
    const base = optional(f!.base, (b) => str(b, "question.baseFailure.base"));
    return { sha: str(f!.sha, "question.baseFailure.sha"), tests: strings(f!.tests, "question.baseFailure.tests"), ...(base === null ? {} : { base }) };
  });
}

/** What's set over a running cell when it renews its lease: a pause of the factory or of its backlog, the kill switch, a restart being prepared, a drain, an operator's stop on its run. */
export type LeaseOverrides = { kill: boolean; pause: boolean; restart: boolean; stopRun: boolean;
  /** The factory drains (PBI 379). It ends the cell's claim at the next stage boundary, as a restart being prepared does. */
  drain?: boolean };

/**
 * What a lease renewal tells a running cell. `stop` cuts the cell's stage short now: a pause, the kill switch or an
 * operator's stop on its run. A restart being prepared doesn't (PBI 301): `restarting` tells the cell to finish the
 * stage it's in, start no further stage and end its claim at that stage boundary. Nor does a drain, which gives the
 * cell the same word (PBI 379). A stop outranks both.
 */
export function leaseAnswer(set: LeaseOverrides): { stop: boolean; restarting: boolean } {
  const stop = set.kill || set.pause || set.stopRun;
  return { stop, restarting: (set.restart || set.drain === true) && !stop };
}

/** The lease route's reply. It names `restarting` only while a restart is being prepared or the factory drains, so it's `{ ok, stop }` otherwise. */
const leaseReply = (a: { stop: boolean; restarting: boolean }) => ({ ok: true, stop: a.stop, ...(a.restarting ? { restarting: true } : {}) });

/**
 * Ends the claim of a cell that stopped under a restart being prepared (PBI 140), or that ended at a stage boundary
 * under a restart being prepared (PBI 301) or a drain (PBI 379): the item goes back to Queued at its run's next stage.
 * `boundary` is the latter: a stopped cell's claim ends only for a restart, since the stop came from a pause, the kill
 * switch or an operator, whose handling keeps the claim. The one lease_expired records why: `reason: "restart"` while
 * a restart is being prepared, which a later claim reads to resume a stopped attempt, and `drain: true` under a drain.
 */
async function endClaimForWrapUp(c: pg.PoolClient, run: Run, now: Date, boundary: boolean): Promise<void> {
  const set = await c.query<{ restart: boolean; drain: boolean }>(
    `with o as (select kind from override where cleared_at is null and scope = 'factory' and (expires_at is null or expires_at > $1))
     select exists (select from o where kind = 'restart') as restart, exists (select from o where kind = 'drain') as drain`,
    [now],
  );
  const { restart, drain } = set.rows[0];
  if (!restart && !(boundary && drain)) return;
  // Any attempt still started belongs to a cell that died before this one (PBI 239). The cell's own attempt is reported by now.
  await closeStartedAttempts(c, run.item_id, now);
  await transitionItem(c, run.item_id, "lease_expired", { actor: "agent", actorId: run.run_id },
    { reason: restart ? "restart" : "drain", ...(drain ? { drain: true } : {}) });
}

/** What's set over a running cell now: the overrides a lease renewal answers with, and that a release reads too. */
async function overridesOver(deps: CellApiDeps, c: pg.PoolClient, run: Run, now: Date): Promise<LeaseOverrides> {
  // The kill switch is FACTORY_KILL=1 or a kill override (Task 13).
  if ((deps.killSwitch ?? (() => process.env.FACTORY_KILL === "1"))()) return { kill: true, pause: false, restart: false, stopRun: false };
  const r = await c.query<{ pause: boolean; kill: boolean; restart: boolean; drain: boolean; stop_run: boolean }>(
    `with o as (select scope, kind, target_id from override where cleared_at is null and (expires_at is null or expires_at > $3))
     select exists (select from o where (scope = 'factory' and kind = 'pause') or (scope = 'backlog' and target_id = $2 and kind = 'pause')) as pause,
            exists (select from o where scope = 'factory' and kind = 'kill') as kill,
            exists (select from o where scope = 'factory' and kind = 'restart') as restart,
            exists (select from o where scope = 'factory' and kind = 'drain') as drain,
            exists (select from o where scope = 'item' and target_id = $1 and kind = 'stop_run') as stop_run`,
    [run.item_id, run.source_id, now],
  );
  const set = r.rows[0];
  return { kill: set.kill, pause: set.pause, restart: set.restart, drain: set.drain, stopRun: set.stop_run };
}

const routes: Record<string, Route> = {
  "POST lease": async (deps, { c, run, now }) => {
    await renewLease(c, run.item_id, run.generation, now);
    return leaseReply(leaseAnswer(await overridesOver(deps, c, run, now)));
  },

  "POST github-token": async (deps, { run }) => deps.repoHost.cellToken(repoOf(run)),

  "GET context": async (deps, { c, run }) => {
    const repo = repoOf(run);
    const item = await deps.backlogFor(run.source_id).getItem(run.external_id);
    const decision = await c.query<{ decision: "approve" | "changes" | "answer"; answer: string | null }>(
      // Only this run's questions: a run that criteria_changed started never sees the last run's decision (Run contract 7).
      `select decision, answer from question where item_id = $1 and decision is not null and asked_at >= $2
       order by answered_at desc nulls last limit 1`,
      [run.item_id, run.started_at],
    );
    const dod = await c.query<{ criterion_index: number; criterion: string; status: string; reason: string | null; checked_sha: string | null }>(
      `select criterion_index, criterion, status, reason, checked_sha from policy_result
       where run_id = $1 and file = 'dod' and at = (select max(at) from policy_result where run_id = $1 and file = 'dod')
       order by criterion_index`,
      [run.run_id],
    );
    const attempts = await c.query<{ stage_id: string; attempt: number }>(
      "select stage_id, max(attempt) as attempt from stage_run where run_id = $1 group by stage_id",
      [run.run_id],
    );
    // PBI 315: each head CI failed on in the run's earlier claims, oldest first, so the next claim neither reads CI on
    // it again nor charges an attempt for it. Any stage's row counts: open-pr, address and pr-review report the failure
    // they found on their failed attempt, which a claim ending before Green starts would otherwise lose.
    const failed = await c.query<{ ci_failure: CiFailure }>(
      `select ci_failure from stage_run where run_id = $1 and ci_failure is not null
       order by started_at, attempt`,
      [run.run_id],
    );
    const failedCiHeads: CiFailure[] = [];
    for (const r of failed.rows) if (!failedCiHeads.some((f) => f.sha === r.ci_failure.sha)) failedCiHeads.push(r.ci_failure);
    // PBI 140: when the next stage's last attempt was stopped, by a cell wrapping up for a restart or by the launcher,
    // the cell resumes it from the work in progress on the branch instead of starting the stage over. The factory also
    // closes as stopped, with LEASE_RAN_OUT, an attempt whose cell died (PBI 239). No stop cut that one short and it may
    // have pushed nothing, or a broken half-commit, so the next cell starts that stage fresh, as it did when such an
    // attempt stayed started. A lease-message attempt resumes only when the lease_expired that ended its own claim, the
    // first one at or after the attempt started, was a restart's: endClaimForWrapUp's, or that of an older factory's
    // wrap-up, which stopped the cells still running once it ran out (PBI 300 took that stop away).
    // A later claim's lease_expired says nothing about this attempt: that cell may have opened no attempt at this stage.
    // event.at and stage_run.started_at both come from the database's clock, so they compare.
    const last = await c.query<{ attempt: number; status: string; message: string | null; restarted: boolean; retry_carry: { tried: number; findings: string[] } | null }>(
      `select s.attempt, s.status, s.message, s.retry_carry,
         coalesce((select e.payload->>'reason' = 'restart' from event e
                   where e.item_id = $3 and e.kind = 'transition' and e.payload->>'event' = 'lease_expired'
                     and e.at >= s.started_at
                   order by e.at limit 1), false) as restarted
       from stage_run s where s.run_id = $1 and s.stage_id = $2 order by s.attempt desc limit 1`,
      [run.run_id, run.next_stage, run.item_id],
    );
    const l = last.rows[0];
    const stopped = l?.status === "stopped" && (l.message !== LEASE_RAN_OUT || l.restarted);
    const resume = stopped ? { stageId: run.next_stage, attempt: l.attempt } : null;
    // PBI 393: when the next stage's last attempt failed and its cell ended the claim at that attempt boundary, under a
    // drain or a restart being prepared, the next claim spends only the stage's retries left and briefs its first
    // attempt with that attempt's findings, as a retry within one claim would.
    let retry: { stageId: string | null; tried: number; findings: string[] } | null =
      l?.status === "failed" && l.retry_carry ? { stageId: run.next_stage, ...l.retry_carry } : null;
    // A pass back to green from open-pr, pr-review or address runs while the run is still at that stage, so its carry
    // is green's, or pr-review's own: the run's last attempt, at any stage but a claim's base merge, when that was green's and it failed
    // with a carry. The next claim goes back to green, through failedCiHeads or on the carry itself, and spends it there.
    if (!retry && run.next_stage !== null && BACK_TO_GREEN_FROM.has(run.next_stage)) {
      const latest = await c.query<{ stage_id: string; status: string; retry_carry: { tried: number; findings: string[] } | null }>(
        `select stage_id, status, retry_carry from stage_run where run_id = $1 and stage_id <> 'merge'
         order by started_at desc, attempt desc limit 1`,
        [run.run_id],
      );
      const g = latest.rows[0];
      if (g?.stage_id === "green" && g.status === "failed" && g.retry_carry) retry = { stageId: "green", ...g.retry_carry };
      // PBI 365: pr-review runs while the run is still at open-pr or address too, so a feature change request it raised
      // and the Product Owner turned down leaves the note on pr-review's attempt. The next claim's pr-review reads it.
      if (g?.stage_id === "pr-review" && g.status === "failed" && g.retry_carry) retry = { stageId: "pr-review", ...g.retry_carry };
    }
    let trustedComments: ReviewComment[] = [];
    // Each open thread's comment count at the claim, every author's. Before it resolves a thread it answered, address
    // reads the threads again and leaves open one that gained a comment it never read (PBI 258).
    let threadCommentCounts: Record<string, number> = {};
    // Run contract 10: only comments by allowlisted users or the App's own bot reach an address run's brief. A thread the
    // factory's own review opened belongs to the PR review stage, so none of it does, a person's reply included (PBI 130).
    if (run.next_stage === "address" && run.pr_number !== null) {
      const users = await c.query<{ github_login: string }>(`select github_login from "user" where github_login is not null`);
      const trusted = new Set(users.rows.map((u) => loginKey(u.github_login)));
      if (run.trusted_bot) trusted.add(botKey(run.trusted_bot));
      const all = await deps.repoHost.openReviewComments(repo, run.pr_number);
      for (const x of all) if (x.path !== null) threadCommentCounts[x.threadId] = (threadCommentCounts[x.threadId] ?? 0) + 1;
      trustedComments = withoutFactoryThreads(all, run.trusted_bot).filter((x) => trusted.has(loginKey(x.author)));
    }
    return {
      externalId: run.external_id, title: item?.title ?? run.title, acceptanceCriteria: item?.acceptanceCriteria ?? [],
      nextStage: run.next_stage,
      decision: decision.rows[0] ? { kind: decision.rows[0].decision, text: decision.rows[0].answer ?? "" } : null,
      lockSha: run.features_lock_sha, lockedFiles: run.locked_files ?? [], prNumber: run.pr_number, repo,
      base: BASE,
      branch: runBranch({ branch: run.branch, externalId: run.external_id, runNumber: run.run_number }),
      configSha: run.config_sha, sopVersion: run.sop_version,
      dodVerdicts: dod.rows.map((v) => ({ index: v.criterion_index, criterion: v.criterion, status: v.status, reason: v.reason ?? "" })),
      dodCheckedSha: dod.rows[0]?.checked_sha ?? null,
      scenarioNotes: run.scenario_notes ?? [],
      trustedComments,
      threadCommentCounts,
      trustedBot: run.trusted_bot,
      stageAttempts: Object.fromEntries(attempts.rows.map((r) => [r.stage_id, r.attempt])),
      failedCiHeads,
      resume,
      retry,
    };
  },

  "POST policy-results": async (_deps, { c, run, body }) => {
    const file = oneOf(body.file, "file", ["pr-review", "dod"] as const);
    const source = oneOf(body.source, "source", ["repo", "default"] as const);
    const stageId = str(body.stageId, "stageId");
    const attempt = int(body.attempt, "attempt");
    const checkedSha = str(body.checkedSha, "checkedSha");
    if (!Array.isArray(body.verdicts)) throw new BadRequest("verdicts must be a list");
    // `person` belongs to dod.md only (Run contract 11), so a cell can't turn a pr-review fail into a checklist line.
    const statuses = file === "dod" ? (["passed", "failed", "person"] as const) : (["passed", "failed"] as const);
    const verdicts = body.verdicts.map((v: { index?: unknown; criterion?: unknown; status?: unknown; reason?: unknown }) => ({
      index: int(v?.index, "verdict.index"), criterion: str(v?.criterion, "verdict.criterion"),
      status: oneOf(v?.status, "verdict.status", statuses), reason: typeof v?.reason === "string" ? v.reason : "",
    }));
    for (const v of verdicts) {
      await c.query(
        `insert into policy_result (item_id, run_id, file, source, stage_id, attempt, checked_sha, criterion_index, criterion, status, reason)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [run.item_id, run.run_id, file, source, stageId, attempt, checkedSha, v.index, v.criterion, v.status, v.reason],
      );
    }
    return { ok: true };
  },

  // Run contract 10, PBI 191: recording the PR starts the review clock, so a trusted review left while the factory's
  // PR review runs still counts once the item is InReview. A retried open-pr attempt records it again, keeping the clock.
  "POST pr": async (_deps, { c, run, body, now }) => {
    const prNumber = int(body.prNumber, "prNumber");
    await c.query("update run set pr_number = $2, pr_url = $3, reviews_seen_at = coalesce(reviews_seen_at, $4) where id = $1", [
      run.run_id, prNumber, prUrlFor(run, prNumber, body.prUrl), now,
    ]);
    return { ok: true };
  },

  "GET checks": async (deps, { c, run, query, now }) => {
    const { repo, sha } = await ownCommit(deps, run, query);
    const watch = await c.query<{ first_asked_at: Date }>(
      `insert into check_watch (run_id, sha, first_asked_at) values ($1, $2, $3)
       on conflict (run_id, sha) do update set sha = excluded.sha returning first_asked_at`,
      [run.run_id, sha, now],
    );
    const status = await deps.repoHost.checksOnSha(repo, sha);
    // Run contract 6: a sha with no checks at all is `none` only once 10 minutes have passed since it was first asked about.
    if (status === "none" && now.getTime() - watch.rows[0].first_asked_at.getTime() < NONE_AFTER_MS) return { status: "pending", failedChecks: [] };
    // PBI 232: why CI failed, read here on the control plane's token, so the cell needs no GitHub access to learn it.
    // The detail is extra: an error reading it still answers the failure, and the finding falls back to "CI failed on <sha>".
    if (status !== "failure") return { status, failedChecks: [] };
    try {
      return { status, failedChecks: await deps.repoHost.failedChecksOnSha(repo, sha) };
    } catch (e) {
      console.error(`checks: reading why CI failed on ${sha} in ${repo} failed:`, e);
      return { status, failedChecks: [] };
    }
  },

  // PBI 234: the names of the checks still pending on one of the run's own commits, for the question a cell asks when
  // CI stays pending for 60 minutes.
  "GET pending-checks": async (deps, { run, query }) => {
    const { repo, sha } = await ownCommit(deps, run, query);
    return { checks: await deps.repoHost.pendingChecksOnSha(repo, sha) };
  },

  // PBI 229: the checks CI named on one of the run's own commits, for a dod.md line's `ci:` check. A commit the cell
  // hasn't pushed, or one of main's, gets null, as a commit CI hasn't reported on does, so its line's command runs.
  // PBI 292: with `on=base`, the checks on a commit of the base instead, and null for any other commit, so a cell can
  // tell a CI failure the base shares from the item's own.
  "GET ci-checks": async (deps, { run, query }) => {
    const sha = shaOf(query);
    const on = query.get("on");
    if (on !== null && on !== "base") throw new BadRequest("on must be base");
    const refused = on === "base" ? !(await deps.repoHost.onBranch(repoOf(run), BASE, sha)) : await notOwnCommit(deps, run, sha);
    if (refused) return { checks: null };
    return { checks: await deps.repoHost.ciChecksOnSha(repoOf(run), sha) };
  },

  // PBI 233: re-runs the named checks that failed on one of the run's own commits, once, before the cell charges a red
  // CI to an attempt. A host that can't re-run, or refuses to, answers an error, and the cell charges the failure as it stands.
  // The re-run is recorded by run and sha, so a second one on the same commit is refused even from a cell that resumed
  // the run after a restart. A call the host refuses outright rolls the record back with the transaction: nothing was
  // re-run. Once any check was re-run the record stays, keeping only the checks that were, and the answer names the
  // checks the host refused, with why, so the cell charges those as they stand and waits only on the rest.
  "POST rerun-checks": async (deps, { c, run, body, now }) => {
    const { repo, sha } = await ownCommit(deps, run, new URLSearchParams({ sha: str(body.sha, "sha") }));
    const checks = strings(body.checks, "checks");
    if (!checks.length || checks.some((x) => x === "")) throw new BadRequest("checks must name at least one check");
    if (!deps.repoHost.rerunChecksOnSha) throw new BadRequest("the repo host can't re-run checks");
    const recorded = await c.query(
      "insert into ci_rerun (run_id, sha, checks, requested_at) values ($1, $2, $3, $4) on conflict (run_id, sha) do nothing",
      [run.run_id, sha, checks, now],
    );
    if (recorded.rowCount === 0) throw new BadRequest(`the checks on ${sha} were already re-run once`);
    const { rerun, refused } = await deps.repoHost.rerunChecksOnSha(repo, sha, checks).catch((e: unknown) => {
      // The host re-ran nothing. A 400 rolls the record back and hands the cell the host's reason for its note.
      // A GitHub 5xx keeps its 503.
      if (githubFailed(e)) throw e;
      throw new BadRequest(`the repo host re-ran none of the checks: ${e instanceof Error ? e.message : String(e)}`);
    });
    if (refused.length) await c.query("update ci_rerun set checks = $3 where run_id = $1 and sha = $2", [run.run_id, sha, rerun]);
    return { ok: true, rerun, refused };
  },

  "POST stage": async (deps, { c, run, body, now }) => {
    const stageId = str(body.stageId, "stageId");
    const attempt = int(body.attempt, "attempt");
    // `stopped` is an attempt a stop cut short (PBI 140). It counts against none of the stage's retries.
    const status = oneOf(body.status, "status", ["started", "passed", "failed", "stopped"] as const);
    const num = (v: unknown) => (typeof v === "number" ? v : null);
    const text = (v: unknown) => (typeof v === "string" ? v : null);
    // PBI 190: the PR reviewer's restates in this attempt, each a round and why its answer couldn't be read.
    const restates = body.restates === undefined ? null : Array.isArray(body.restates)
      && body.restates.every((r) => Number.isInteger(r?.round) && typeof r?.reason === "string")
      ? JSON.stringify(body.restates.map((r: { round: number; reason: string }) => ({ round: r.round, reason: cut(r.reason) })))
      : (() => { throw new BadRequest("restates must be a list of { round, reason }"); })();
    const ciFailure = body.ciFailure === undefined ? null : JSON.stringify(ciFailureOf(body.ciFailure, run.repo_url));
    // PBI 393: a failed attempt that ends its claim at the attempt boundary hands the next claim its tries and findings.
    const retryCarry = body.retryCarry === undefined || status !== "failed" ? null : JSON.stringify(retryCarryOf(body.retryCarry));
    const values = [run.run_id, stageId, attempt, status, text(body.model), num(body.tokensIn), num(body.tokensOut), num(body.costUsd),
      text(body.transcriptRef), text(body.reportRef), status === "started" ? null : now, cut(text(body.message)), restates, ciFailure, retryCarry];
    const updated = await c.query(
      `update stage_run set status = $4, model = coalesce($5, model), tokens_in = coalesce($6, tokens_in), tokens_out = coalesce($7, tokens_out),
         cost_usd = coalesce($8, cost_usd), transcript_ref = coalesce($9, transcript_ref), report_ref = coalesce($10, report_ref), ended_at = $11,
         message = coalesce($12, message), restates = coalesce($13::jsonb, restates), ci_failure = coalesce($14::jsonb, ci_failure),
         retry_carry = coalesce($15::jsonb, retry_carry)
       where run_id = $1 and stage_id = $2 and attempt = $3`,
      values,
    );
    if (updated.rowCount === 0) {
      await c.query(
        `insert into stage_run (run_id, stage_id, attempt, status, model, tokens_in, tokens_out, cost_usd, transcript_ref, report_ref, ended_at, message, restates, ci_failure, retry_carry)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, coalesce($13::jsonb, '[]'), $14::jsonb, $15::jsonb)`,
        values,
      );
    }
    // PBI 152: a passed self-review's scenario notes stay with the run, so an open-pr in a later claim still has them.
    if (status === "passed" && stageId === "self-review") {
      const notes = Array.isArray(body.scenarioNotes) ? body.scenarioNotes.filter((n): n is string => typeof n === "string") : [];
      await c.query("update run set scenario_notes = $2 where id = $1", [run.run_id, notes]);
    }
    if (status === "passed") {
      const next = deps.stageAfter(run.sop_version, stageId);
      if (next) await c.query("update run set next_stage = $2 where id = $1", [run.run_id, next]);
    }
    // A cell that stops while a restart is being prepared has pushed its work and is about to exit, so its claim ends
    // here. The item goes back to Queued at the stage it was in, and the restarted factory starts it again at once
    // instead of waiting out the lease. Under a pause or a stop_run the claim stays, so the scheduler's handling holds.
    if (status === "stopped") await endClaimForWrapUp(c, run, now, false);
    const usage = body.usage as { utilization?: unknown; resetsAt?: unknown } | undefined;
    if (typeof usage?.utilization === "number") {
      const resetsAt = typeof usage.resetsAt === "string" ? new Date(usage.resetsAt) : new Date(now.getTime() + USAGE_PAUSE_MS);
      if (Number.isNaN(resetsAt.getTime())) throw new BadRequest("usage.resetsAt must be a time");
      await c.query("update wip_policy set usage_paused_until = $2 where usage_reserve_at <= $1", [usage.utilization, resetsAt]);
    }
    return { ok: true };
  },

  // A cell a restart stopped between stages, with no attempt open, ends its claim here, as a stopped report would. So
  // does one that finished its stage while a restart was being prepared or the factory drains, and starts no further
  // stage (PBI 301, PBI 379). Without it the item would stay InProgress, and Floor would count it as running, until its
  // lease ran out.
  // A cell also releases when a pause, the kill switch or an operator's stop caught it between stages. The route can't
  // tell that from a boundary, so a drain ends the claim only while none of those is set: their handling keeps it.
  "POST release": async (deps, { c, run, now }) => {
    await endClaimForWrapUp(c, run, now, !leaseAnswer(await overridesOver(deps, c, run, now)).stop);
    return { ok: true };
  },

  // PBI 173: a run pinned to an older SOP moves to the SOP in the cell image, keeping its config commit and stage. The
  // move is a system event on the item. A move the run has already made is a no-op, so a retried call logs it once.
  "POST sop-move": async (_deps, { c, run, body }) => {
    const from = str(body.from, "from");
    const to = str(body.to, "to");
    if (run.sop_version === to) return { ok: true };
    if (run.sop_version !== from) throw new BadRequest(`the run is pinned to SOP ${run.sop_version ?? "none"}, not ${from}`);
    await c.query("update run set sop_version = $2 where id = $1", [run.run_id, to]);
    await appendEvent(c, { actor: "system", actorId: "cell-api", itemId: run.item_id, kind: SOP_MOVED, payload: { from, to, runId: run.run_id } });
    return { ok: true };
  },

  "POST transition": async (deps, { c, run, body, now }) => {
    const event = body.event as ItemEvent;
    if (!cellEvents.has(event)) throw new BadRequest(`a cell may not send ${String(body.event)}`);
    let detail: Record<string, unknown> = {};
    if (event === "scenarios_written") {
      const q = question(body.question, "sign_off");
      const files = strings(body.lockedFiles, "lockedFiles");
      if (files.length === 0) throw new BadRequest("lockedFiles is empty");
      const sha = str(body.scenariosSha, "scenariosSha");
      // PBI 224: Run detail's snapshot, read once here so the API never reads GitHub. It replaces the run's earlier
      // one, as a changes round can lock other files. A failed read rolls the report back, earlier snapshot and all.
      const snapshot = await readSnapshot({ repoHost: deps.repoHost, backlog: deps.backlogFor(run.source_id) },
        { repo: repoOf(run), externalId: run.external_id, sha, paths: files }).catch((e: unknown) => {
        throw e instanceof SnapshotMissing ? new BadRequest(e.message) : e;
      });
      await c.query("update run set scenarios_sha = $2, locked_files = $3 where id = $1", [run.run_id, sha, files]);
      await storeSnapshot(c, run.run_id, snapshot);
      await c.query("insert into question (item_id, kind, body) values ($1, 'sign_off', $2)", [run.item_id, q]);
      // The worker quotes the question on the board from the transition's payload (PBI 219).
      detail = { question: q };
    } else if (event === "blocked") {
      const q = question(body.question, "needs_input");
      await c.query("insert into question (item_id, kind, body, base_failure) values ($1, 'needs_input', $2, $3)",
        [run.item_id, q, baseFailure(body.question)]);
      detail = { question: q };
    } else if (event === "pr_opened") {
      const prNumber = optional(body.prNumber, (v) => int(v, "prNumber")) ?? run.pr_number;
      if (prNumber === null) throw new BadRequest("pr_opened needs a PR: send /pr first, or prNumber and prUrl");
      const tier = optional(body.tier, (v) => oneOf(v, "tier", ["Low", "Medium", "High"] as const));
      // Run contract 10: /pr starts the review clock. A pr_opened with no /pr before it starts it here instead.
      // Run contract 1: an address run hands the item back here, its work done, so the resume pointer goes back to
      // open-pr, where an InReview item's pointer stands, instead of reading as a run still headed to address.
      await c.query(
        `update run set pr_number = $2, pr_url = $3, risk_tier = coalesce($4, risk_tier),
           tier_reasons = coalesce($5, tier_reasons), reviews_seen_at = coalesce(reviews_seen_at, $6),
           next_stage = case when next_stage = 'address' then 'open-pr' else next_stage end where id = $1`,
        [run.run_id, prNumber, prUrlFor(run, prNumber, body.prUrl), tier, optional(body.tierReasons, (v) => strings(v, "tierReasons")), now],
      );
    } else if (event === "retries_exhausted") {
      const attempts = await c.query("select stage_id, attempt, status from stage_run where run_id = $1 order by started_at, attempt", [run.run_id]);
      detail = { attempts: attempts.rows };
    } else if (event === "feature_change_requested") {
      // PBI 364: the request goes on the run, and the move's payload carries it for the PBI comment.
      await requestFeatureChange(c, run.run_id, await featureChange(deps, run, body.featureChange));
      return { state: "FeatureChangeRequest" };
    } else if (event === "usage_limited") {
      const resumeAt = optional(body.resumeAt, (v) => str(v, "resumeAt"));
      if (resumeAt !== null && Number.isNaN(Date.parse(resumeAt))) throw new BadRequest("resumeAt must be a time");
      await c.query("update run set resume_at = $2 where id = $1", [run.run_id, resumeAt]);
    }
    const to = await transitionItem(c, run.item_id, event, { actor: "agent", actorId: run.run_id }, detail);
    return { state: to };
  },

  "POST upload-url": async (deps, { c, run, body }) => {
    const kind = oneOf(body.kind, "kind", ["transcript", "report"] as const);
    const stageId = str(body.stageId, "stageId");
    // The stage id lands in a blob path, so it can't carry a slash or a dot.
    if (!/^[a-z0-9-]+$/.test(stageId)) throw new BadRequest("stageId must be lowercase letters, digits and dashes");
    const attempt = int(body.attempt, "attempt");
    const path = `${kind}s/${run.run_id}/${stageId}-${attempt}.${kind === "transcript" ? "jsonl" : "ndjson"}`;
    // Run detail reads the evidence back from here. The attempt's row exists already: run contract 9 sends /stage
    // first, and a stopped attempt, which uploads before its stopped report, has its row from its `started` report.
    await c.query(`update stage_run set ${kind}_ref = $4 where run_id = $1 and stage_id = $2 and attempt = $3`, [run.run_id, stageId, attempt, path]);
    return { url: await deps.uploadUrl(path) };
  },
};

/**
 * The cell API's routes under /internal/cells/:runId and the model gateway under /internal/model. Mount it first, so
 * it works without a dashboard session. It reads no x-ms-client-principal header. A token that isn't a run token, a
 * user's sign-in token or none, gets 401 before anything else. A wrong or stale run token gets 409 next, a bad request
 * from the current generation gets 400, and either way nothing is written.
 */
export function cellApi(deps: CellApiDeps): Handler {
  const now = deps.now ?? (() => new Date());
  // A run's config_sha never changes, so each (repo, config_sha) is read once. Only successful reads are kept.
  const grants = new Map<string, Grant>();
  const verify = async (credential: string): Promise<Grant | null> => {
    const m = /^([0-9a-f-]{36})\.(\d{1,9})\.([0-9a-f]{64})$/.exec(credential);
    if (!m || !uuid.test(m[1])) return null;
    // A database outage is a check that can't run, so the cell gets 503, not the 401 of a bad credential.
    const r = await deps.pool.query<{ generation: number; state: string; config_sha: string | null; repo_url: string | null }>(
      `select i.lease_generation as generation, i.state, r.config_sha, repo.url as repo_url
       from run r join item i on i.id = r.item_id left join repo on repo.id = r.repo_id where r.id = $1`,
      [m[1]],
    ).catch((e) => {
      throw new GatewayUnavailable(`can't check the run: ${String(e)}`);
    });
    const row = r.rows[0];
    if (!row || row.state !== "InProgress" || row.generation !== Number(m[2]) || !same(runToken(deps.secret, m[1], row.generation), m[3])) return null;
    if (!row.config_sha || !row.repo_url) throw new GatewayUnavailable("the run has no pinned repo config yet");
    const repo = repoName(row.repo_url);
    const key = `${repo}@${row.config_sha}`;
    let grant = grants.get(key);
    if (!grant) {
      try {
        grant = { webTools: deps.webToolsOf(await deps.repoHost.readFile(repo, row.config_sha, ".factory/config.yml")) };
      } catch (e) {
        throw new GatewayUnavailable(`can't read ${key}:.factory/config.yml: ${String(e)}`);
      }
      grants.set(key, grant);
    }
    // The run id lets the gateway's slow line name the same run as this API's own (PBI 154).
    return { ...grant, runId: m[1] };
  };
  const gateway = { upstream: deps.gateway.upstream, ownerToken: deps.gateway.ownerToken, verify, slow: deps.slow };

  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://cell-api");
    if (url.pathname.startsWith("/internal/model/")) {
      await handleModelRequest(gateway, req, res, (req.url ?? "/").slice("/internal/model".length));
      return true;
    }
    const m = /^\/internal\/cells\/([^/]+)\/([a-z-]+)$/.exec(url.pathname);
    if (!m) return false;
    const route = routes[`${req.method} ${m[2]}`];
    if (!route) {
      json(res, 404);
      return true;
    }
    // A request still open after 60 seconds warns once, naming its route and run (PBI 134).
    const name = `${req.method} /${m[2]}`;
    const w = watch(SLOW_REQUEST_MS, null, (ms) => `slow: the cell API request ${name} for run ${m[1]} has been open for ${seconds(ms)}`, deps.slow);
    return watched(w, async () => {
      const auth = req.headers.authorization ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
      // Only a run token gets this far. A user's sign-in token, or no token, isn't from a cell, so it gets 401 before
      // anything is read or locked (redesign step 4b). 409 stays for a run token the run's generation has moved past.
      if (!RUN_TOKEN.test(token)) {
        req.resume();
        json(res, 401, { error: "the cell API takes only a run token" });
        return true;
      }
      // The body is read before the token check but judged after it, so a fenced cell always gets 409, never 400.
      const body = await readJson(req).catch((e: unknown) => e as Error);
      try {
        const result = await withTx(deps.pool, async (c) => {
          const run = uuid.test(m[1]) ? await lockRun(c, m[1]) : null;
          if (!current(deps.secret, run, token)) throw new Fenced();
          if (body instanceof Error) throw body;
          return route(deps, { c, run, body, query: url.searchParams, now: now() });
        });
        json(res, 200, result);
      } catch (e) {
        if (e instanceof Fenced) json(res, 409, { error: "this run's lease generation has moved on" });
        // GitHub failing or out of reach behind the cell API is 503, so the cell retries it, and 500 stays for the
        // cell API's own faults (PBI 259).
        else if (githubFailed(e)) {
          console.error(`the cell API request ${name} for run ${m[1]}: GitHub failed:`, e);
          json(res, 503, { error: `GitHub failed: ${e instanceof Error ? e.message : String(e)}` });
        } else throw e;
      }
      return true;
    });
  };
}

/**
 * Upload URLs signed from an Azurite connection string, with the host swapped for one a cell container can reach, as
 * plan Task 2 Step 8 proved. ponytail: shared-key signing only. Azure needs a user delegation key, which Task 19 adds.
 */
export function blobUploadUrl(connectionString: string, cellHost: string | undefined): (path: string) => Promise<string> {
  const service = BlobServiceClient.fromConnectionString(connectionString);
  const made = new Set<string>();
  return async (path) => {
    const [container, ...rest] = path.split("/");
    const client = service.getContainerClient(container);
    if (!made.has(container)) {
      await client.createIfNotExists();
      made.add(container);
    }
    const url = new URL(await client.getBlockBlobClient(rest.join("/")).generateSasUrl({
      permissions: BlobSASPermissions.parse("cw"),
      expiresOn: new Date(Date.now() + 15 * 60_000),
    }));
    if (cellHost) url.hostname = cellHost;
    return url.toString();
  };
}
