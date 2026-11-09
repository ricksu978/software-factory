// The control plane's entry point (plan Task 15). One process on one port serves the cell API and the model gateway,
// GitHub's webhook and the dashboard, and runs the scheduler's tick and the board poller. `aspire run` starts it as
// the control resource. Every decision lives in the database, so a restart picks up where the last process stopped.
import { App } from "@octokit/app";
import { BlobServiceClient } from "@azure/storage-blob";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { githubBacklog, parseGitHubWebhook, type FieldMap } from "./adapters/github/backlog.ts";
import { githubRepoHost } from "./adapters/github/repo-host.ts";
import type { BacklogAdapter, RepoHost } from "./adapters/types.ts";
import { haikuJudge, runAgent } from "./agent/run.ts";
import { parseRepoConfig } from "./config/repo-config.ts";
import { loadSop, stageAfter } from "./config/sop.ts";
import { mirrorBoard } from "./control/board.ts";
import { logTransitions } from "./control/console-log.ts";
import { blobUploadUrl, cellApi } from "./control/cell-api.ts";
import { applyComment } from "./control/decisions.ts";
import { createAuth, devIdentityProblem, type Auth } from "./http/auth.ts";
import { dashboardRoutes } from "./http/routes.ts";
import { BadRequest, json, startServer, type Handler } from "./http/server.ts";
import { dockerLauncher, ensureEgress } from "./scheduler/launcher.ts";
import { tick, TICK_MS } from "./scheduler/scheduler.ts";
import { createPool } from "./store/db.ts";
import { pollOnce, POLL_INTERVAL_MS } from "./watcher/poller.ts";
import { handleWebhook } from "./watcher/webhook.ts";

export type Source = { id: string; adapter: BacklogAdapter };

export type ControlDeps = {
  pool: pg.Pool;
  local: boolean;
  auth: Auth;
  /** The dashboard's origin as a browser sees it. A dashboard POST must carry it. */
  origin: string;
  sources: Source[];
  repoHost: RepoHost;
  /** Signs each cell's run token (CELL_SECRET). */
  secret: string;
  webhookSecret: string;
  /** The owner's Claude token, which only the model gateway sends upstream. */
  claudeToken: string;
  uploadUrl: (path: string) => Promise<string>;
  readBlob: (path: string) => Promise<string | null>;
};

// GitHub caps a webhook payload at 25 MB.
const MAX_WEBHOOK = 25 * 1024 * 1024;
// The SOP this image carries. A run's first claim pins its version, and the cell API moves runs along its stages.
const sop = loadSop(readFileSync(join(import.meta.dirname, "..", "sop", "default.yml"), "utf8"));

/** Stands in for a board or repo host that isn't configured yet. It answers every call with an error naming why. */
function missing<T extends object>(why: string): T {
  return new Proxy({} as T, { get: () => async () => { throw new Error(why); } });
}

/**
 * Every HTTP handler, tried in order. The cell API and the webhook come before the dashboard and need no sign-in.
 * Locally the PBI 2 probes stay, so its scenarios keep passing against this process.
 */
export function controlHandlers(d: ControlDeps): { handlers: Handler[]; close(): Promise<void> } {
  const backlogFor = (sourceId: string) => d.sources.find((s) => s.id === sourceId)?.adapter ?? missing<BacklogAdapter>(`no backlog source ${sourceId}`);
  const cells = cellApi({
    pool: d.pool, secret: d.secret, repoHost: d.repoHost, backlogFor,
    stageAfter: (_version, stageId) => stageAfter(sop, stageId),
    uploadUrl: d.uploadUrl,
    gateway: { upstream: "https://api.anthropic.com", ownerToken: () => d.claudeToken },
    webToolsOf: (text) => parseRepoConfig(text).webTools,
  });

  const webhook: Handler = async (req, res) => {
    if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== "/webhooks/github") return false;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size <= MAX_WEBHOOK) chunks.push(chunk as Buffer);
    }
    if (size > MAX_WEBHOOK) throw new BadRequest("the payload is over 25 MB", 413);
    const { status } = await handleWebhook({
      pool: d.pool, secret: d.webhookSecret, parse: parseGitHubWebhook,
      // applyComment ignores a comment on an item another source holds, so each source can be asked in turn.
      onComment: async (e) => {
        for (const s of d.sources) await applyComment({ pool: d.pool, adapter: s.adapter, sourceId: s.id }, e);
      },
    }, { headers: req.headers as Record<string, string | undefined>, rawBody: Buffer.concat(chunks) });
    json(res, status);
    return true;
  };

  // PBI 2's platform probes, locally only: a cell's ping, an upload URL, the env's names and the migrate run count.
  const probes: Handler = async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (!d.local) return false;
    if (req.method === "POST" && path === "/internal/cells/ping") json(res, 204);
    else if (req.method === "GET" && path === "/probe/sas") json(res, 200, { url: await d.uploadUrl(`probe/${randomUUID()}`) });
    else if (req.method === "GET" && path === "/probe/env") json(res, 200, Object.keys(process.env).sort());
    else if (req.method === "GET" && path === "/probe/runs") json(res, 200, { count: Number((await d.pool.query("select count(*) from probe_runs")).rows[0].count) });
    else return false;
    return true;
  };

  // ponytail: Phase 0 has one board, so the dashboard announces decisions on the first source. Route by item.source_id when a second board arrives.
  const first = d.sources[0];
  const dashboard = dashboardRoutes({
    pool: d.pool, auth: d.auth, origin: d.origin, adapter: first?.adapter ?? missing<BacklogAdapter>("no backlog source is configured"),
    sourceId: first?.id ?? "", repoHost: d.repoHost, readBlob: d.readBlob,
  });
  return { handlers: [cells, webhook, probes, dashboard], close: dashboard.close };
}

/** Reads a stored transcript or report from the blob account, or null when it isn't there. */
function blobReader(connectionString: string): (path: string) => Promise<string | null> {
  const service = BlobServiceClient.fromConnectionString(connectionString);
  return async (path) => {
    const [container, ...rest] = path.split("/");
    try {
      return (await service.getContainerClient(container).getBlobClient(rest.join("/")).downloadToBuffer()).toString("utf8");
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) return null;
      throw e;
    }
  };
}

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

/** Runs `fn` now and then `ms` after each run ends, so two runs never overlap. A failure is logged and the next run goes ahead. */
function every(ms: number, what: string, fn: () => Promise<unknown>): void {
  const run = async () => {
    await attempt(what, fn);
    setTimeout(run, ms);
  };
  void run();
}

/** The GitHub boards migrate-cli seeded from config/sources.yml, each with the installation of the first repo it maps. */
async function githubSources(pool: pg.Pool, app: App, projectToken: string | null): Promise<{ sources: Source[]; installationId: number | null }> {
  const rows = (await pool.query<{ id: string; owner_type: "user" | "org"; owner_login: string; project_number: number; field_map: FieldMap; installation_id: string | null }>(
    `select s.id, s.owner_type, s.owner_login, s.project_number, s.field_map,
       (select r.installation_id from repo r where r.id::text in (select value from jsonb_each_text(s.repo_map)) and r.installation_id is not null limit 1) as installation_id
     from backlog_source s where s.adapter = 'github' order by s.url`,
  )).rows;
  const sources = rows.filter((r) => r.installation_id !== null).map((r) => ({
    id: r.id,
    adapter: githubBacklog({ app, installationId: Number(r.installation_id), owner: { type: r.owner_type, login: r.owner_login }, projectToken, projectNumber: r.project_number, fieldMap: r.field_map }),
  }));
  // ponytail: one GitHub App installation serves every repo in Phase 0. Key the repo host by installation when that changes.
  const installationId = rows.find((r) => r.installation_id !== null)?.installation_id;
  return { sources, installationId: installationId ? Number(installationId) : null };
}

export async function start(env: NodeJS.ProcessEnv): Promise<void> {
  const problem = devIdentityProblem(env);
  if (problem) throw new Error(`refusing to start: ${problem}`);
  if (env.FACTORY_ENV !== "local") {
    throw new Error("Azure mode isn't wired yet: main.ts has no Entra-signed blob access for transcripts and reports, and no settings for the cell job. Run it under `aspire run`.");
  }
  // Aspire's proxy answers on the endpoint port that cells get in CELL_CONTROL_URL, so the browser uses that port too.
  const dashboardPort = new URL(env.CELL_CONTROL_URL ?? "http://localhost:7400").port || "80";
  const origin = `http://localhost:${dashboardPort}`;
  const auth = createAuth({ mode: "local", devLogin: env.FACTORY_DEV_LOGIN });
  console.log(`Sign in to the factory dashboard: ${origin}/dev-login?token=${auth.devToken}`);

  const need = (name: string) => {
    const v = env[name];
    if (!v) throw new Error(`${name} is not set`);
    return v;
  };
  const [dbUri, blob, secret, webhookSecret, appId, appKey, claudeToken, image, controlUrl] =
    ["FACTORY_DB_URI", "FACTORY_BLOB", "CELL_SECRET", "GITHUB_WEBHOOK_SECRET", "GITHUB_APP_ID", "GITHUB_APP_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CELL_IMAGE", "CELL_CONTROL_URL"].map(need);

  const pool = createPool(dbUri);
  const app = new App({ appId, privateKey: appKey });
  const { sources, installationId } = await githubSources(pool, app, env.GITHUB_PROJECT_TOKEN || null);
  if (!sources.length) console.warn("No backlog source is configured yet, so the factory takes no item. Add config/sources.yml and restart aspire run.");
  const repoHost = installationId === null ? missing<RepoHost>("no repo is configured") : githubRepoHost(app, installationId);
  const backlogFor = (id: string) => sources.find((s) => s.id === id)?.adapter ?? missing<BacklogAdapter>(`no backlog source ${id}`);

  // Cells reach nothing but GitHub, npm and this process, through the egress proxy (Task 13).
  await ensureEgress({ image, controlUrl, blob });
  const launcher = dockerLauncher({ image });

  const control = controlHandlers({
    pool, local: true, auth, origin, sources, repoHost, secret, webhookSecret, claudeToken,
    uploadUrl: blobUploadUrl(blob, env.CELL_BLOB_HOST), readBlob: blobReader(blob),
  });
  mirrorBoard({ pool, backlogFor, repoHost });
  logTransitions({ pool });
  // Bound on every interface, as the spike was, so Aspire's proxy reaches it over IPv4 or IPv6.
  await startServer(control.handlers, { port: Number(env.PORT ?? dashboardPort), host: "::" });
  console.log(`The control plane answers on port ${env.PORT ?? dashboardPort}.`);

  every(TICK_MS, "scheduler tick", () => tick({
    pool, launcher, now: new Date(), killFlag: env.FACTORY_KILL === "1", repoHost, backlogFor, secret, controlUrl, sopVersion: sop.version,
  }));
  const judge = haikuJudge(sop);
  for (const s of sources) every(POLL_INTERVAL_MS, `polling source ${s.id}`, () => pollOnce({ pool, adapter: s.adapter, repoHost, judge, sourceId: s.id, split: { sop, agent: runAgent } }));
}

if (import.meta.main) {
  start(process.env).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
