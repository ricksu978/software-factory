// The orchestrator API (redesign step 6a, 2026-11-07 design §03, §04, §05 and §12). It serves §05's /v1 routes on
// Hono on port 7402, each open only to the role §05's table names. Every caller but GitHub's webhook brings the
// issuer's access token as a bearer token: its signature is checked against the keys the issuer's discovery document
// points at, and so are its issuer, audience and expiry. The caller is looked up in "user" on every request.
//
// Red stub (PBI 284): it starts and answers every request with 501. Discovery, token checks, roles and routes are
// still to come.
import { createAdaptorServer } from "@hono/node-server";
import { Hono } from "hono";
import type { Server } from "node:http";
import type pg from "pg";

/** The API's port when PORT doesn't set one (design §10). */
export const API_PORT = 7402;

export type ApiDeps = {
  pool: pg.Pool;
  /** OIDC_ISSUER: the issuer whose discovery document names the signing keys, and every token's `iss`. */
  issuer: string;
  /** API_AUDIENCE: the `aud` every token must carry. */
  audience: string;
  /** GITHUB_WEBHOOK_SECRET, which signs GitHub's deliveries to /webhooks/github. */
  webhookSecret: string;
  /** Reads a stored transcript or report by its blob path, or null when it's missing. */
  readBlob: (path: string) => Promise<string | null>;
  /** The settings the floor reads, such as CLAUDE_TOKEN_CREATED_AT. */
  env: Record<string, string | undefined>;
};

export type Api = { server: Server; stop(): Promise<void> };

/** The API as a Hono app. */
export function apiApp(_d: ApiDeps): Hono {
  const app = new Hono();
  app.all("*", (c) => c.json({ error: "not implemented" }, 501));
  return app;
}

/** Reads the issuer's discovery document, then serves the API on `port`. */
export async function startApi(d: ApiDeps, port: number = API_PORT): Promise<Api> {
  const server = createAdaptorServer({ fetch: apiApp(d).fetch }) as Server;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "::", () => resolve());
  });
  return {
    server,
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Reads the API's settings from `env` and serves it on PORT, or 7402 when PORT isn't set. */
export async function main(_env: Record<string, string | undefined>): Promise<{ stop(): Promise<void> }> {
  throw new Error("the orchestrator API isn't built yet");
}

if (import.meta.main) {
  main(process.env).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
