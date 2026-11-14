// The cell API as its own service (redesign step 4a, 2026-11-07 design §06 and §12). It answers cells on port 7401:
// today's cell routes under /internal/cells and the model gateway under /internal/model. Today's control plane,
// src/main.ts, stops serving them.
import type { Server } from "node:http";
import type pg from "pg";
import type { RepoHost } from "../adapters/types.ts";
import type { Source } from "../main.ts";

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

/** The cell API's handlers on `port`, once its settings are read. */
export async function serveCellApi(_d: CellApiDeps, _port: number): Promise<{ server: Server; stop(): Promise<void> }> {
  throw new Error("serveCellApi isn't implemented yet");
}

/** Reads the cell API's settings from `env` and serves it on 7401. */
export async function main(_env: Record<string, string | undefined>): Promise<{ stop(): Promise<void> }> {
  throw new Error("the cell API service isn't implemented yet");
}

if (import.meta.main) {
  main(process.env).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
