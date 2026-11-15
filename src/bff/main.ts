// The BFF (redesign step 7a, 2026-11-07 design §04, §09, §10 and §12): the one service the browser talks to.
// It signs people in at OIDC_ISSUER with the authorization code flow and PKCE, keeps sessions in Postgres as
// factory_bff, and answers on PORT, or 7403 until the cut-over.
// Settings: FACTORY_DB_URI, OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_SCOPES, BFF_SESSION_KEY, PORT,
// BFF_ORIGIN, the address the browser reaches it on, and API_URL, the API's base address. It refuses to start without a
// usable BFF_SESSION_KEY.
// Routes: GET /auth/login, GET /auth/callback, POST /auth/logout, GET /auth/session, and, since step 7b, /bff/v1/*,
// which it forwards to the API's /v1/* (src/bff/app.ts). The webhook pass-through comes in a later step.
import { serve } from "@hono/node-server";
import { createBff } from "./app.ts";
import { pgSessions, rolePool } from "./session.ts";
import { readSettings, type BffSettings } from "./settings.ts";

export { BFF_PORT } from "./settings.ts";
export { BFF_DB_ROLE } from "./session.ts";

let settings: BffSettings;
try {
  settings = readSettings(process.env);
} catch (e) {
  console.error(`the BFF can't start: ${(e as Error).message}`);
  process.exit(1);
}

// Whatever login FACTORY_DB_URI or the managed identity carries, every connection switches to factory_bff before its
// first query. A connection that can't switch is closed, and the query that wanted it fails (rolePool).
const pool = rolePool(settings.dbUri);

const app = createBff({
  issuer: settings.issuer,
  clientId: settings.clientId,
  clientSecret: settings.clientSecret,
  scopes: settings.scopes,
  origin: settings.origin,
  key: settings.key,
  sessions: pgSessions(pool),
  apiUrl: settings.apiUrl,
});

const server = serve({ fetch: app.fetch, port: settings.port }, (info) => {
  console.log(`the BFF is listening on port ${info.port}, for ${settings.origin}, signing in at ${settings.issuer}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close();
    void pool.end().finally(() => process.exit(0));
  });
}
