// The local Keycloak realm's test owner, which migrate seeds as an owner under `aspire run` (redesign §08, step 5).
// A user is keyed by issuer and subject. The subject is the fixed id the realm import gives the test owner. The issuer
// holds Keycloak's port: 7430 when pinned, and under FACTORY_FLOAT_PORTS=1 whatever the running Keycloak names.
import { readFileSync } from "node:fs";

type Json = Record<string, any>;

/** Where Keycloak answers when its port is pinned (aspire-apphost/apphost.mts). */
export const PINNED_KEYCLOAK = "http://localhost:7430";

const REALM_FILE = new URL("../../aspire-apphost/keycloak/factory-realm.json", import.meta.url);

/** The realm import the AppHost hands Keycloak. */
export function readRealm(): Json {
  return JSON.parse(readFileSync(REALM_FILE, "utf8")) as Json;
}

/** The realm's name and its test owner's subject: the fixed id of the user with a password credential. */
export function realmTestOwner(realm: Json): { realm: string; subject: string } {
  if (typeof realm.realm !== "string" || realm.realm === "") throw new Error("the Keycloak realm import names no realm");
  for (const u of Array.isArray(realm.users) ? (realm.users as Json[]) : []) {
    const creds = Array.isArray(u.credentials) ? (u.credentials as Json[]) : [];
    if (typeof u.id === "string" && u.id !== "" && creds.some((c) => c.type === "password")) return { realm: realm.realm, subject: u.id };
  }
  throw new Error("the Keycloak realm import has no test owner: no user with a password and a fixed id");
}

/**
 * The realm's issuer. With pinned ports it is the realm on 7430. Under FACTORY_FLOAT_PORTS=1 it is the issuer the
 * running Keycloak's discovery document names, found through services__keycloak__http__0, which Aspire's
 * withReference() sets. Any failure there throws, naming Keycloak, rather than guess an issuer.
 */
export async function localIssuer(env: NodeJS.ProcessEnv, realm: string, fetchFn: typeof fetch = fetch): Promise<string> {
  if (env.FACTORY_FLOAT_PORTS !== "1") return `${PINNED_KEYCLOAK}/realms/${realm}`;
  const base = env.services__keycloak__http__0?.replace(/\/+$/, "");
  if (!base) throw new Error("migrate can't ask Keycloak for its issuer under FACTORY_FLOAT_PORTS=1: services__keycloak__http__0 is unset");
  const url = `${base}/realms/${realm}/.well-known/openid-configuration`;
  let body: Json;
  try {
    const r = await fetchFn(url, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    body = (await r.json()) as Json;
  } catch (e) {
    throw new Error(`Keycloak didn't answer ${url}: ${(e as Error).message}`);
  }
  if (typeof body.issuer !== "string" || body.issuer === "") throw new Error(`Keycloak's discovery document at ${url} names no issuer`);
  return body.issuer;
}
