// The BFF (redesign step 7a, 2026-11-07 design §04, §09, §10 and §12): the one service the browser talks to.
// It signs people in at OIDC_ISSUER with the authorization code flow and PKCE, keeps sessions in Postgres as
// factory_bff, and answers on PORT, or 7403 until the cut-over.
// Settings: FACTORY_DB_URI, OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_SCOPES, BFF_SESSION_KEY, PORT and
// BFF_ORIGIN, the address the browser reaches it on.
// Routes: GET /auth/login, GET /auth/callback, POST /auth/logout, and GET /auth/session, which answers the signed-in
// browser's { issuer, subject } or 401.
// Not built yet: this stub only listens, and answers 404 to everything.
import { createServer } from "node:http";

/** The BFF's port when PORT doesn't set one, until the cut-over moves it to 7400 (design §10). */
export const BFF_PORT = 7403;

const server = createServer((_req, res) => res.writeHead(404).end());
server.listen(process.env.PORT ? Number(process.env.PORT) : 0);
