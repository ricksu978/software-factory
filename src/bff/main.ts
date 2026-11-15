// The BFF (redesign steps 7 and 9, 2026-11-07 design §04 and §10). It serves the dashboard on 7400, signs people in
// through the configured OIDC provider, holds their sessions, forwards /bff/v1/* to the API's /v1/*, and passes
// GitHub's POST /webhooks/github to the API with its bytes and headers untouched.
// Stub: nothing is served yet.

/** The BFF's port when PORT doesn't set one: the address today's dashboard has always had (design §10). */
export const BFF_PORT = 7400;

/**
 * Reads the BFF's settings from `env` (FACTORY_DB_URI, API_URL, OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET,
 * OIDC_SCOPES, BFF_SESSION_KEY, and optionally BFF_ORIGIN and PORT) and serves it on PORT, or 7400 when PORT isn't
 * set.
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
