// The cell API as its own service (redesign step 4a, 2026-11-07 design §06 and §12). It answers cells on port 7401:
// today's cell routes under /internal/cells and the model gateway under /internal/model, and on the local platform
// PBI 2's probes. Today's control plane, src/main.ts, no longer serves the cell routes or the gateway. A cell reaches
// this service through the egress proxy, and nothing else of the factory's (step 4b). The worker mirrors the
// transitions its routes commit from their outbox rows (PBI 219).
import { App } from "@octokit/app";
import { loadAppKey } from "../adapters/github/app-key.ts";
import { TimedOctokit } from "../adapters/github/timed.ts";
import type { Server } from "node:http";
import type pg from "pg";
import { githubRepoHost } from "../adapters/github/repo-host.ts";
import type { BacklogAdapter, RepoHost } from "../adapters/types.ts";
import { parseRepoConfig } from "../config/repo-config.ts";
import { stageAfter } from "../config/sop.ts";
import { blobUploadUrl, cellApi } from "../control/cell-api.ts";
import { platformProbes } from "../control/probes.ts";
import { startServer, type Handler } from "../http/server.ts";
import { githubSources, missing, sop, type Source } from "../main.ts";
import { createPool } from "../store/db.ts";

/** The cell API's port when PORT doesn't set one (design §10). */
export const CELL_API_PORT = 7401;

export type CellApiDeps = {
  pool: pg.Pool;
  sources: Source[];
  repoHost: RepoHost;
  /** Signs each cell's run token (CELL_SECRET). */
  secret: string;
  /** The owner's Claude token, which only the model gateway sends upstream. */
  claudeToken: string;
  /** Where the model gateway sends a cell's model request: https://api.anthropic.com outside a test. */
  modelUpstream: string;
  uploadUrl: (path: string) => Promise<string>;
  /** On the local platform, the cell API serves PBI 2's probes as well (redesign step 4b). Off by default. */
  local?: boolean;
};

/** The cell routes and the model gateway as one handler. Anything else falls through, so the server answers 404. */
export function cellApiHandler(d: CellApiDeps): Handler {
  return cellApi({
    pool: d.pool, secret: d.secret, repoHost: d.repoHost,
    backlogFor: (id) => d.sources.find((s) => s.id === id)?.adapter ?? missing<BacklogAdapter>(`no backlog source ${id}`),
    stageAfter: (_version, stageId) => stageAfter(sop, stageId),
    uploadUrl: d.uploadUrl,
    gateway: { upstream: d.modelUpstream, ownerToken: () => d.claudeToken },
    webToolsOf: (text) => parseRepoConfig(text).webTools,
  });
}

/** The cell API's handlers on `port`, once its settings are read. */
export async function serveCellApi(d: CellApiDeps, port: number): Promise<{ server: Server; stop(): Promise<void> }> {
  // PBI 2's probes come first, so the ping is answered before the cell routes ask for a run token.
  const handlers = d.local ? [platformProbes(d), cellApiHandler(d)] : [cellApiHandler(d)];
  // Bound on every interface, as the control plane is, so a cell reaches it over IPv4 or IPv6.
  const server = await startServer(handlers, { port, host: "::" });
  return {
    server,
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Reads the cell API's settings from `env` and serves it on PORT, or 7401 when PORT isn't set. Every setting is
 * checked before anything connects or listens, so a missing one stops it with nothing started.
 */
export async function main(env: Record<string, string | undefined>): Promise<{ stop(): Promise<void> }> {
  loadAppKey(env);
  const names = ["FACTORY_DB_URI", "FACTORY_BLOB", "CELL_SECRET", "GITHUB_APP_ID", "GITHUB_APP_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];
  const unset = names.filter((name) => !env[name]);
  if (unset.length) throw new Error(`refusing to start the cell API: ${unset.join(", ")} ${unset.length === 1 ? "is" : "are"} not set`);
  const [dbUri, blob, secret, appId, appKey, claudeToken] = names.map((name) => env[name]!);
  const port = env.PORT ? Number(env.PORT) : CELL_API_PORT;
  if (!Number.isInteger(port) || port <= 0) throw new Error(`refusing to start the cell API: PORT ${env.PORT} isn't a port`);

  const pool = createPool(dbUri);
  try {
    const app = new App({ appId, privateKey: appKey, Octokit: TimedOctokit });
    const { sources, installationId } = await githubSources(pool, app, env.GITHUB_PROJECT_TOKEN || null);
    const repoHost = installationId === null ? missing<RepoHost>("no repo is configured") : githubRepoHost(app, installationId);
    const served = await serveCellApi({
      pool, sources, repoHost, secret, claudeToken, modelUpstream: "https://api.anthropic.com",
      uploadUrl: blobUploadUrl(blob, env.CELL_BLOB_HOST), local: env.FACTORY_ENV === "local",
    }, port);
    console.log(`The cell API answers on port ${port}.`);
    return {
      async stop() {
        await served.stop();
        await pool.end();
      },
    };
  } catch (e) {
    await pool.end();
    throw e;
  }
}

if (import.meta.main) {
  main(process.env).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
