// The cell API (plan Task 12). A cell reaches the control plane only here, with a run token tied to its lease
// generation. Each call checks the token under the item's row lock, in the same transaction as its writes, so a
// re-claim or the cell's own transition can't slip in between the check and the write (Review Focus 2).
import { BlobSASPermissions, BlobServiceClient } from "@azure/storage-blob";
import { createHmac, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { botKey, loginKey, type BacklogAdapter, type RepoHost, type ReviewComment } from "../adapters/types.ts";
import type { ItemEvent } from "../core/states.ts";
import { BadRequest, json, readJson, type Handler } from "../http/server.ts";
import { withTx } from "../store/db.ts";
import { renewLease, transitionItem } from "../store/items.ts";
import { repoName, runBranch } from "../store/runs.ts";
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
};

// The only events a cell may send. Everything else is the control plane's, such as merged, which a steered cell
// could otherwise use to mark its own PR accepted.
const cellEvents = new Set<ItemEvent>(["scenarios_written", "blocked", "pr_opened", "retries_exhausted", "usage_limited"]);
const NONE_AFTER_MS = 600_000;
const USAGE_PAUSE_MS = 5 * 3_600_000;
// ponytail: every Phase 0 repo builds on main. Add repo.default_branch when a target repo doesn't.
const BASE = "main";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Run = {
  run_id: string; item_id: string; generation: number; state: string; source_id: string; external_id: string; title: string;
  run_number: number; started_at: Date; next_stage: string | null; branch: string | null; pr_number: number | null; locked_files: string[] | null;
  features_lock_sha: string | null; config_sha: string | null; sop_version: string | null; repo_url: string | null; trusted_bot: string | null;
};
type Call = { c: pg.PoolClient; run: Run; body: Record<string, unknown>; query: URLSearchParams; now: Date };
type Route = (deps: CellApiDeps, call: Call) => Promise<unknown>;

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Thrown when the token is wrong or from an older generation. The route answers 409 and the transaction rolls back. */
class Fenced extends Error {}

async function lockRun(c: pg.PoolClient, runId: string): Promise<Run | null> {
  const r = await c.query<Run>(
    `select r.id as run_id, i.id as item_id, i.lease_generation as generation, i.state, i.source_id, i.external_id, i.title,
       r.run_number, r.started_at, r.next_stage, r.branch, r.pr_number, r.locked_files, r.features_lock_sha, r.config_sha, r.sop_version,
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
const optional = <T>(v: unknown, read: (v: unknown) => T): T | null => (v === undefined || v === null ? null : read(v));

function repoOf(run: Run): string {
  if (!run.repo_url) throw new BadRequest("the run has no repo yet");
  return repoName(run.repo_url);
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

const routes: Record<string, Route> = {
  "POST lease": async (deps, { c, run, now }) => {
    await renewLease(c, run.item_id, run.generation, now);
    // The kill switch is FACTORY_KILL=1 or a kill override (Task 13). Either one tells every cell to stop.
    if ((deps.killSwitch ?? (() => process.env.FACTORY_KILL === "1"))()) return { ok: true, stop: true };
    const r = await c.query<{ stop: boolean }>(
      `select exists (select from override o
         where o.cleared_at is null and (o.expires_at is null or o.expires_at > $3)
           and ((o.scope = 'factory' and o.kind in ('pause', 'kill'))
             or (o.scope = 'backlog' and o.target_id = $2 and o.kind = 'pause')
             or (o.scope = 'item' and o.target_id = $1 and o.kind = 'stop_run'))) as stop`,
      [run.item_id, run.source_id, now],
    );
    return { ok: true, stop: r.rows[0].stop };
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
    let trustedComments: ReviewComment[] = [];
    // Run contract 10: only comments by allowlisted users or the App's own bot reach an address run's brief.
    if (run.next_stage === "address" && run.pr_number !== null) {
      const users = await c.query<{ github_login: string }>(`select github_login from "user" where github_login is not null`);
      const trusted = new Set(users.rows.map((u) => loginKey(u.github_login)));
      if (run.trusted_bot) trusted.add(botKey(run.trusted_bot));
      trustedComments = (await deps.repoHost.openReviewComments(repo, run.pr_number)).filter((x) => trusted.has(loginKey(x.author)));
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
      trustedComments,
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

  "POST pr": async (_deps, { c, run, body }) => {
    const prNumber = int(body.prNumber, "prNumber");
    await c.query("update run set pr_number = $2, pr_url = $3 where id = $1", [run.run_id, prNumber, prUrlFor(run, prNumber, body.prUrl)]);
    return { ok: true };
  },

  "GET checks": async (deps, { c, run, query, now }) => {
    const sha = query.get("sha") ?? "";
    if (!/^[0-9a-f]{7,64}$/.test(sha)) throw new BadRequest("sha must be a commit sha");
    const repo = repoOf(run);
    const branch = runBranch({ branch: run.branch, externalId: run.external_id, runNumber: run.run_number });
    if (!(await deps.repoHost.onBranch(repo, branch, sha))) throw new BadRequest(`${sha} isn't on ${branch}`);
    // The branch starts from main, so main's commits are its ancestors too. Only the branch's own commits pass, or a
    // cell could ask about main's green head instead of its own push.
    if (await deps.repoHost.onBranch(repo, BASE, sha)) throw new BadRequest(`${sha} is on ${BASE}, not only on ${branch}`);
    const watch = await c.query<{ first_asked_at: Date }>(
      `insert into check_watch (run_id, sha, first_asked_at) values ($1, $2, $3)
       on conflict (run_id, sha) do update set sha = excluded.sha returning first_asked_at`,
      [run.run_id, sha, now],
    );
    const status = await deps.repoHost.checksOnSha(repo, sha);
    // Run contract 6: a sha with no checks at all is `none` only once 10 minutes have passed since it was first asked about.
    if (status === "none" && now.getTime() - watch.rows[0].first_asked_at.getTime() < NONE_AFTER_MS) return { status: "pending" };
    return { status };
  },

  "POST stage": async (deps, { c, run, body, now }) => {
    const stageId = str(body.stageId, "stageId");
    const attempt = int(body.attempt, "attempt");
    const status = oneOf(body.status, "status", ["started", "passed", "failed"] as const);
    const num = (v: unknown) => (typeof v === "number" ? v : null);
    const text = (v: unknown) => (typeof v === "string" ? v : null);
    const values = [run.run_id, stageId, attempt, status, text(body.model), num(body.tokensIn), num(body.tokensOut), num(body.costUsd),
      text(body.transcriptRef), text(body.reportRef), status === "started" ? null : now];
    const updated = await c.query(
      `update stage_run set status = $4, model = coalesce($5, model), tokens_in = coalesce($6, tokens_in), tokens_out = coalesce($7, tokens_out),
         cost_usd = coalesce($8, cost_usd), transcript_ref = coalesce($9, transcript_ref), report_ref = coalesce($10, report_ref), ended_at = $11
       where run_id = $1 and stage_id = $2 and attempt = $3`,
      values,
    );
    if (updated.rowCount === 0) {
      await c.query(
        `insert into stage_run (run_id, stage_id, attempt, status, model, tokens_in, tokens_out, cost_usd, transcript_ref, report_ref, ended_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        values,
      );
    }
    if (status === "passed") {
      const next = deps.stageAfter(run.sop_version, stageId);
      if (next) await c.query("update run set next_stage = $2 where id = $1", [run.run_id, next]);
    }
    const usage = body.usage as { utilization?: unknown; resetsAt?: unknown } | undefined;
    if (typeof usage?.utilization === "number") {
      const resetsAt = typeof usage.resetsAt === "string" ? new Date(usage.resetsAt) : new Date(now.getTime() + USAGE_PAUSE_MS);
      if (Number.isNaN(resetsAt.getTime())) throw new BadRequest("usage.resetsAt must be a time");
      await c.query("update wip_policy set usage_paused_until = $2 where usage_reserve_at <= $1", [usage.utilization, resetsAt]);
    }
    return { ok: true };
  },

  "POST transition": async (_deps, { c, run, body, now }) => {
    const event = body.event as ItemEvent;
    if (!cellEvents.has(event)) throw new BadRequest(`a cell may not send ${String(body.event)}`);
    let detail: Record<string, unknown> = {};
    if (event === "scenarios_written") {
      const q = question(body.question, "sign_off");
      const files = strings(body.lockedFiles, "lockedFiles");
      if (files.length === 0) throw new BadRequest("lockedFiles is empty");
      await c.query("update run set scenarios_sha = $2, locked_files = $3 where id = $1", [run.run_id, str(body.scenariosSha, "scenariosSha"), files]);
      await c.query("insert into question (item_id, kind, body) values ($1, 'sign_off', $2)", [run.item_id, q]);
    } else if (event === "blocked") {
      await c.query("insert into question (item_id, kind, body) values ($1, 'needs_input', $2)", [run.item_id, question(body.question, "needs_input")]);
    } else if (event === "pr_opened") {
      const prNumber = optional(body.prNumber, (v) => int(v, "prNumber")) ?? run.pr_number;
      if (prNumber === null) throw new BadRequest("pr_opened needs a PR: send /pr first, or prNumber and prUrl");
      const tier = optional(body.tier, (v) => oneOf(v, "tier", ["Low", "Medium", "High"] as const));
      // Run contract 10: the first pr_opened starts the review clock.
      await c.query(
        `update run set pr_number = $2, pr_url = $3, risk_tier = coalesce($4, risk_tier),
           tier_reasons = coalesce($5, tier_reasons), reviews_seen_at = coalesce(reviews_seen_at, $6) where id = $1`,
        [run.run_id, prNumber, prUrlFor(run, prNumber, body.prUrl), tier, optional(body.tierReasons, (v) => strings(v, "tierReasons")), now],
      );
    } else if (event === "retries_exhausted") {
      const attempts = await c.query("select stage_id, attempt, status from stage_run where run_id = $1 order by started_at, attempt", [run.run_id]);
      detail = { attempts: attempts.rows };
    } else if (event === "usage_limited") {
      const resumeAt = optional(body.resumeAt, (v) => str(v, "resumeAt"));
      if (resumeAt !== null && Number.isNaN(Date.parse(resumeAt))) throw new BadRequest("resumeAt must be a time");
      await c.query("update run set resume_at = $2 where id = $1", [run.run_id, resumeAt]);
    }
    const to = await transitionItem(c, run.item_id, event, { actor: "agent", actorId: run.run_id }, detail);
    return { state: to };
  },

  "POST upload-url": async (deps, { run, body }) => {
    const kind = oneOf(body.kind, "kind", ["transcript", "report"] as const);
    const stageId = str(body.stageId, "stageId");
    // The stage id lands in a blob path, so it can't carry a slash or a dot.
    if (!/^[a-z0-9-]+$/.test(stageId)) throw new BadRequest("stageId must be lowercase letters, digits and dashes");
    const attempt = int(body.attempt, "attempt");
    return { url: await deps.uploadUrl(`${kind}s/${run.run_id}/${stageId}-${attempt}.${kind === "transcript" ? "jsonl" : "ndjson"}`) };
  },
};

/**
 * The cell API's routes under /internal/cells/:runId and the model gateway under /internal/model. Mount it first, so
 * it works without a dashboard session. It reads no x-ms-client-principal header. A wrong or stale token gets 409
 * before anything else, a bad request from the current generation gets 400, and either way nothing is written.
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
    return grant;
  };
  const gateway = { upstream: deps.gateway.upstream, ownerToken: deps.gateway.ownerToken, verify };

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
    // The body is read before the token check but judged after it, so a fenced cell always gets 409, never 400.
    const body = await readJson(req).catch((e: unknown) => e as Error);
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
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
      else throw e;
    }
    return true;
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
