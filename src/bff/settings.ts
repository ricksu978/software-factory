// The BFF's settings (redesign step 7a, 2026-11-07 design §04 and §10), read from the environment once at start.
import { readSessionKey } from "./session.ts";

/** The BFF's port when PORT doesn't set one, until the cut-over moves it to 7400 (design §10). */
export const BFF_PORT = 7403;

export type BffSettings = {
  port: number;
  origin: string;
  dbUri?: string;
  issuer: string;
  clientId: string;
  clientSecret?: string;
  scopes: string;
  key: Buffer;
  /** The API's base address, which /bff/v1/* goes to as /v1/*. Without it the BFF answers those calls 502. */
  apiUrl?: string;
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

/** Reads the settings, and throws naming the first one that is missing or malformed. */
export function readSettings(env: NodeJS.ProcessEnv): BffSettings {
  const key = readSessionKey(env.BFF_SESSION_KEY);
  const port = env.PORT ? Number(env.PORT) : BFF_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`PORT ${env.PORT} isn't a port`);
  let apiUrl: string | undefined;
  if (env.API_URL) {
    if (!URL.canParse(env.API_URL)) throw new Error(`API_URL ${env.API_URL} isn't an address`);
    apiUrl = env.API_URL.replace(/\/+$/, "");
  }
  return {
    port,
    origin: new URL(env.BFF_ORIGIN || `http://localhost:${port}`).origin,
    dbUri: env.FACTORY_DB_URI || undefined,
    issuer: required(env, "OIDC_ISSUER"),
    clientId: required(env, "OIDC_CLIENT_ID"),
    clientSecret: env.OIDC_CLIENT_SECRET || undefined,
    scopes: env.OIDC_SCOPES || "openid",
    key,
    apiUrl,
  };
}
