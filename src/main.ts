// The control plane's entry point (plan Task 15). One process on the port PORT names serves GitHub's webhook and the
// dashboard. `aspire run` starts it as the control resource. The scheduler's tick, the board poller and the egress
// proxy run in the worker, src/worker/main.ts (redesign step 2). The cell API and the model gateway run in their own
// service, src/cell-api/main.ts, on 7401 (redesign step 4a). Every decision lives in the database, so a restart picks
// up where the last process stopped.
import { App } from "@octokit/app";
import { BlobServiceClient } from "@azure/storage-blob";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import type pg from "pg";
import { githubBacklog, parseGitHubWebhook, splitFiling, type FieldMap } from "./adapters/github/backlog.ts";
import { githubRepoHost } from "./adapters/github/repo-host.ts";
import type { BacklogAdapter, RepoHost } from "./adapters/types.ts";
import { loadSop } from "./config/sop.ts";
import { mirrorBoard } from "./control/board.ts";
import { logTransitions } from "./control/console-log.ts";
import { blobUploadUrl } from "./control/cell-api.ts";
import { applyComment } from "./control/decisions.ts";
import type { FileSplitDeps } from "./gate/file-split.ts";
import { createAuth, devIdentityProblem, type Auth } from "./http/auth.ts";
import { dashboardRoutes } from "./http/routes.ts";
import { BadRequest, json, startServer, type Handler } from "./http/server.ts";
import { createPool } from "./store/db.ts";
import { clearRestartOnStart } from "./store/overrides.ts";
import { handleWebhook } from "./watcher/webhook.ts";

/** `file`, when set, files each valid split on this board as child issues (PBI 144). */
export type Source = { id: string; adapter: BacklogAdapter; file?: FileSplitDeps };

export type ControlDeps = {
  pool: pg.Pool;
  local: boolean;
  auth: Auth;
  /** The dashboard's origin as a browser sees it. A dashboard POST must carry it. */
  origin: string;
  sources: Source[];
  repoHost: RepoHost;
  webhookSecret: string;
  /** Signs PBI 2's upload-URL probe. */
  uploadUrl: (path: string) => Promise<string>;
  readBlob: (path: string) => Promise<string | null>;
};

// GitHub caps a webhook payload at 25 MB.
const MAX_WEBHOOK = 25 * 1024 * 1024;
// The SOP this image carries. A run's first claim pins its version, and the cell API (src/cell-api/main.ts) moves
// runs along its stages.
export const sop = loadSop(readFileSync(join(import.meta.dirname, "..", "sop", "default.yml"), "utf8"));

/** Stands in for a board or repo host that isn't configured yet. It answers every call with an error naming why. */
export function missing<T extends object>(why: string): T {
  return new Proxy({} as T, { get: () => async () => { throw new Error(why); } });
}

/**
 * Every HTTP handler, tried in order. The webhook comes before the dashboard and needs no sign-in. Locally the PBI 2
 * probes stay, so its scenarios keep passing against this process. The cell routes and the model gateway are the cell
 * API's (src/cell-api/main.ts), so a cell's call here gets 404.
 */
export function controlHandlers(d: ControlDeps): { handlers: Handler[]; close(): Promise<void> } {

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
  return { handlers: [webhook, probes, dashboard], close: dashboard.close };
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

/** The GitHub boards migrate-cli seeded from config/sources.yml, each with the installation of the first repo it maps. */
export async function githubSources(pool: pg.Pool, app: App, projectToken: string | null): Promise<{ sources: Source[]; installationId: number | null }> {
  const rows = (await pool.query<{ id: string; owner_type: "user" | "org"; owner_login: string; project_number: number; field_map: FieldMap; installation_id: string | null }>(
    `select s.id, s.owner_type, s.owner_login, s.project_number, s.field_map,
       (select r.installation_id from repo r where r.id::text in (select value from jsonb_each_text(s.repo_map)) and r.installation_id is not null limit 1) as installation_id
     from backlog_source s where s.adapter = 'github' order by s.url`,
  )).rows;
  const sources = rows.filter((r) => r.installation_id !== null).map((r) => {
    const adapter = githubBacklog({ app, installationId: Number(r.installation_id), owner: { type: r.owner_type, login: r.owner_login }, projectToken, projectNumber: r.project_number, fieldMap: r.field_map });
    return { id: r.id, adapter, file: splitFiling(adapter.splitBoard, r.field_map) };
  });
  // ponytail: one GitHub App installation serves every repo in Phase 0. Key the repo host by installation when that changes.
  const installationId = rows.find((r) => r.installation_id !== null)?.installation_id;
  return { sources, installationId: installationId ? Number(installationId) : null };
}

/**
 * The control plane once its settings are read: its handlers on `port`, and board mirroring and the console log for
 * the transitions it commits. It runs no background job. Those are the worker's.
 */
export async function serveControl(d: ControlDeps, port: number): Promise<{ server: Server; stop(): Promise<void> }> {
  const backlogFor = (id: string) => d.sources.find((s) => s.id === id)?.adapter ?? missing<BacklogAdapter>(`no backlog source ${id}`);
  const control = controlHandlers(d);
  const hooks = [mirrorBoard({ pool: d.pool, backlogFor, repoHost: d.repoHost }), logTransitions({ pool: d.pool })];
  // Bound on every interface, as the spike was, so Aspire's proxy reaches it over IPv4 or IPv6.
  const server = await startServer(control.handlers, { port, host: "::" });
  return {
    server,
    async stop() {
      for (const off of hooks) off();
      await control.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export async function start(env: NodeJS.ProcessEnv): Promise<void> {
  const problem = devIdentityProblem(env);
  if (problem) throw new Error(`refusing to start: ${problem}`);
  if (env.FACTORY_ENV !== "local") {
    throw new Error("Azure mode isn't wired yet: main.ts has no Entra-signed blob access for transcripts and reports, and no settings for the cell job. Run it under `aspire run`.");
  }
  // The control plane listens only on PORT, which Aspire sets from the control resource's endpoint. CELL_CONTROL_URL
  // names the cell API's port, another service's since redesign step 4a, so it never picks the port this listens on.
  // ponytail: PBI 89's locked scenario still expects the link from CELL_CONTROL_URL alone, so the link falls back to
  // its port and is logged before the PORT check. Drop the fallback once that scenario sets PORT.
  const linkPort = env.PORT || new URL(env.CELL_CONTROL_URL ?? "http://localhost:7400").port || "80";
  const origin = `http://localhost:${linkPort}`;
  const auth = createAuth({ mode: "local", devLogin: env.FACTORY_DEV_LOGIN });
  console.log(`Sign in to the factory dashboard: ${origin}/dev-login?token=${auth.devToken}`);
  if (!env.PORT) throw new Error("PORT is not set: the control plane takes its own port from PORT, not from CELL_CONTROL_URL");
  const port = Number(env.PORT);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`PORT ${env.PORT} isn't a port`);

  const need = (name: string) => {
    const v = env[name];
    if (!v) throw new Error(`${name} is not set`);
    return v;
  };
  const [dbUri, blob, webhookSecret, appId, appKey] =
    ["FACTORY_DB_URI", "FACTORY_BLOB", "GITHUB_WEBHOOK_SECRET", "GITHUB_APP_ID", "GITHUB_APP_KEY"].map(need);

  const pool = createPool(dbUri);
  // A restart prepared before this start has done its job, so the restarted factory runs again (PBI 140).
  await clearRestartOnStart(pool);
  const app = new App({ appId, privateKey: appKey });
  const { sources, installationId } = await githubSources(pool, app, env.GITHUB_PROJECT_TOKEN || null);
  const repoHost = installationId === null ? missing<RepoHost>("no repo is configured") : githubRepoHost(app, installationId);

  await serveControl({
    pool, local: true, auth, origin, sources, repoHost, webhookSecret,
    uploadUrl: blobUploadUrl(blob, env.CELL_BLOB_HOST), readBlob: blobReader(blob),
  }, port);
  console.log(`The control plane answers on port ${port}.`);
}

if (import.meta.main) {
  start(process.env).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
