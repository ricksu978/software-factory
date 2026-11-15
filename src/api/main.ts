// The orchestrator API (redesign steps 6 and 9, 2026-11-07 design §05). It serves the dashboard's JSON under /v1 and
// takes GitHub's webhook at POST /webhooks/github, which the BFF passes to it untouched. Only the BFF reaches it.
// Stub: nothing is served yet.

/** The API's port when PORT doesn't set one (design §10). */
export const API_PORT = 7402;

/**
 * Reads the API's settings from `env` (FACTORY_DB_URI, GITHUB_WEBHOOK_SECRET, OIDC_ISSUER, API_AUDIENCE and PORT) and
 * serves it on PORT, or 7402 when PORT isn't set.
 */
export async function main(_env: Record<string, string | undefined>): Promise<{ stop(): Promise<void> }> {
  return { async stop() {} };
}

if (import.meta.main) {
  main(process.env).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
