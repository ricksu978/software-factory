// The cell API as its own service (redesign step 4a, 2026-11-07 design §06 and §12). It answers cells on port 7401:
// today's cell routes under /internal/cells and the model gateway under /internal/model. Today's control plane,
// src/main.ts, no longer serves them. Until the outbox lands (step 3), it registers mirrorBoard and the console log
// for the transitions its routes commit, as the control plane did for them.
import { App } from "@octokit/app";
import type { Server } from "node:http";
import type pg from "pg";
import { githubRepoHost } from "../adapters/github/repo-host.ts";
import type { BacklogAdapter, RepoHost } from "../adapters/types.ts";
import { parseRepoConfig } from "../config/repo-config.ts";
import { stageAfter } from "../config/sop.ts";
import { mirrorBoard } from "../control/board.ts";
import { blobUploadUrl, cellApi } from "../control/cell-api.ts";
import { logTransitions } from "../control/console-log.ts";
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

/** The cell API's handlers on `port`, once its settings are read, with board mirroring for the transitions it commits. */
export async function serveCellApi(d: CellApiDeps, port: number): Promise<{ server: Server; stop(): Promise<void> }> {
  const backlogFor = (id: string) => d.sources.find((s) => s.id === id)?.adapter ?? missing<BacklogAdapter>(`no backlog source ${id}`);
  const hooks = [mirrorBoard({ pool: d.pool, backlogFor, repoHost: d.repoHost }), logTransitions({ pool: d.pool })];
  // Bound on every interface, as the control plane is, so a cell reaches it over IPv4 or IPv6.
  const server = await startServer([cellApiHandler(d)], { port, host: "::" });
  return {
    server,
    async stop() {
      for (const off of hooks) off();
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
  const names = ["FACTORY_DB_URI", "FACTORY_BLOB", "CELL_SECRET", "GITHUB_APP_ID", "GITHUB_APP_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];
  const unset = names.filter((name) => !env[name]);
  if (unset.length) throw new Error(`refusing to start the cell API: ${unset.join(", ")} ${unset.length === 1 ? "is" : "are"} not set`);
  const [dbUri, blob, secret, appId, appKey, claudeToken] = names.map((name) => env[name]!);
  const port = env.PORT ? Number(env.PORT) : CELL_API_PORT;
  if (!Number.isInteger(port) || port <= 0) throw new Error(`refusing to start the cell API: PORT ${env.PORT} isn't a port`);

  const pool = createPool(dbUri);
  try {
    const app = new App({ appId, privateKey: appKey });
    const { sources, installationId } = await githubSources(pool, app, env.GITHUB_PROJECT_TOKEN || null);
    const repoHost = installationId === null ? missing<RepoHost>("no repo is configured") : githubRepoHost(app, installationId);
    const served = await serveCellApi({
      pool, sources, repoHost, secret, claudeToken, modelUpstream: "https://api.anthropic.com",
      uploadUrl: blobUploadUrl(blob, env.CELL_BLOB_HOST),
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
