// Step definitions for features/pbi-169-keycloak-local.feature. The untagged scenarios read the AppHost source and
// the realm import it hands Keycloak through withRealmImport(). The @local scenarios talk to Keycloak on 7430.
// Given and When only record what they find. Every assertion is in a Then, so a missing Keycloak resource or realm
// import shows as a failed Then, not as a crash.
// "{string} is up" and "I stop {string} and start it again" are PBI 6's steps, which start the AppHost and stop it in
// their After hook.
import { After, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createPublicKey, verify } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const repo = process.cwd();
const APPHOST_FILE = join(repo, "aspire-apphost", "apphost.mts");
const APPHOST = "--apphost . --non-interactive --nologo";
const KEYCLOAK = "http://localhost:7430";
const long = { timeout: 600_000 };

type Json = Record<string, any>;
type Client = Json & { clientId: string };
type TokenReply = { status: number; body: Json } | null;

type Ctx = {
  source?: string | null;
  realm?: Json | null;
  realmProblem?: string;
  started?: boolean;
  answered?: boolean;
  discovery?: Json | null;
  token?: TokenReply;
  tokenAfterRestart?: TokenReply;
  signIn?: { status: number; body: string } | null;
};

function ctx(world: object): Ctx {
  const w = world as { pbi169?: Ctx };
  w.pbi169 ??= {};
  return w.pbi169;
}

function readAppHost(): string | null {
  return existsSync(APPHOST_FILE) ? readFileSync(APPHOST_FILE, "utf8") : null;
}

/** The Keycloak part of the AppHost: from addKeycloak( up to the end of that statement. */
function keycloakStatement(source: string): string | null {
  const at = source.indexOf("addKeycloak(");
  if (at < 0) return null;
  const end = source.indexOf(";", at);
  return source.slice(at, end < 0 ? undefined : end);
}

/** The path the AppHost gives withRealmImport(), resolved against the AppHost's folder as Aspire resolves it. */
function realmImportPath(source: string): string | null {
  const m = /withRealmImport\(\s*(['"`])([^'"`]+)\1/.exec(source);
  return m ? resolve(dirname(APPHOST_FILE), m[2]) : null;
}

/** The realm import: one JSON file, or the realm JSON in the folder the AppHost names. */
function readRealm(source: string | null): { realm: Json | null; problem: string } {
  if (!source) return { realm: null, problem: "the AppHost source is missing" };
  if (!keycloakStatement(source)) return { realm: null, problem: "the AppHost adds no Keycloak resource (no addKeycloak call)" };
  const path = realmImportPath(source);
  if (!path) return { realm: null, problem: "the AppHost hands Keycloak no realm import (no withRealmImport call)" };
  if (!existsSync(path)) return { realm: null, problem: `the realm import ${path} doesn't exist` };
  const files = statSync(path).isDirectory()
    ? readdirSync(path).filter((f) => f.endsWith(".json")).map((f) => join(path, f))
    : [path];
  for (const file of files) {
    try {
      const doc = JSON.parse(readFileSync(file, "utf8")) as Json;
      if (typeof doc.realm === "string") return { realm: doc, problem: "" };
    } catch {
      // Not JSON, or not a realm. Try the next file.
    }
  }
  return { realm: null, problem: `no realm JSON at ${path}` };
}

function needRealm(c: Ctx): Json {
  assert.ok(c.realm, c.realmProblem ?? "the realm import was never read");
  return c.realm;
}

function clients(realm: Json): Client[] {
  return Array.isArray(realm.clients) ? (realm.clients as Client[]) : [];
}

function client(realm: Json, id: string): Client | undefined {
  return clients(realm).find((cl) => cl.clientId === id);
}

/** The e2e client is the one whose id names e2e. */
function e2eClient(realm: Json): Client | undefined {
  return clients(realm).find((cl) => /e2e/i.test(cl.clientId));
}

/** Every protocol mapper anywhere in the realm, on a client or on a client scope. */
function mappers(value: unknown, found: Json[] = []): Json[] {
  if (Array.isArray(value)) for (const v of value) mappers(v, found);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === "protocolMappers" && Array.isArray(v)) found.push(...(v as Json[]));
      else mappers(v, found);
    }
  }
  return found;
}

function audienceMappers(realm: Json): Json[] {
  return mappers(realm).filter((m) => m.protocolMapper === "oidc-audience-mapper");
}

function mapperAudience(m: Json): string | undefined {
  return m.config?.["included.custom.audience"] ?? m.config?.["included.client.audience"];
}

function testOwner(realm: Json): { id: string | undefined; username: string; password: string } | null {
  const users = Array.isArray(realm.users) ? (realm.users as Json[]) : [];
  for (const u of users) {
    const cred = (Array.isArray(u.credentials) ? (u.credentials as Json[]) : []).find((cr) => cr.type === "password" && typeof cr.value === "string");
    if (typeof u.username === "string" && cred) {
      return { id: typeof u.id === "string" ? u.id : undefined, username: u.username, password: cred.value };
    }
  }
  return null;
}

/** Whether a redirect URI list lets Keycloak send a browser back to url, with or without a trailing slash. */
function accepts(uris: unknown, url: string): boolean {
  if (!Array.isArray(uris)) return false;
  return [url, `${url}/`].some((target) =>
    uris.some((u) => typeof u === "string" && (u === target || (u.endsWith("*") && target.startsWith(u.slice(0, -1))))));
}

/** The literal value the AppHost gives API_AUDIENCE, following one const if it names one. */
function apiAudience(source: string | null): string | null {
  if (!source) return null;
  const m = /withEnvironment\(\s*['"]API_AUDIENCE['"]\s*,\s*([^)]+?)\s*\)/.exec(source);
  if (!m) return null;
  const literal = /^(['"`])([^'"`]+)\1$/.exec(m[1]);
  if (literal) return literal[2];
  const named = new RegExp(`const\\s+${m[1]}\\s*=\\s*(['"\`])([^'"\`]+)\\1`).exec(source);
  return named ? named[2] : null;
}

// Keycloak, live on 7430. Each call records a reply or null and never throws.

async function fetchOrNull(url: string, init?: RequestInit): Promise<Response | null> {
  try {
    return await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(10_000) });
  } catch {
    return null;
  }
}

async function answers(url: string): Promise<boolean> {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await fetchOrNull(url)) return true;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return false;
}

function realmUrl(realm: Json | null): string {
  return `${KEYCLOAK}/realms/${realm?.realm ?? "factory"}`;
}

async function directGrant(realm: Json | null, clientId: string, password?: string): Promise<TokenReply> {
  if (!realm) return null;
  const owner = testOwner(realm);
  const cl = client(realm, clientId);
  const form = new URLSearchParams({
    grant_type: "password",
    client_id: clientId,
    username: owner?.username ?? "",
    password: password ?? owner?.password ?? "",
    scope: "openid",
  });
  if (typeof cl?.secret === "string") form.set("client_secret", cl.secret);
  const r = await fetchOrNull(`${realmUrl(realm)}/protocol/openid-connect/token`, { method: "POST", body: form });
  if (!r) return null;
  try {
    return { status: r.status, body: (await r.json()) as Json };
  } catch {
    return { status: r.status, body: {} };
  }
}

async function e2eGrant(realm: Json | null, password?: string): Promise<TokenReply> {
  const id = realm ? e2eClient(realm)?.clientId : undefined;
  return id ? directGrant(realm, id, password) : null;
}

function startKeycloak(c: Ctx): void {
  c.started = true;
  const env = { ...process.env, FACTORY_FLOAT_PORTS: "1" };
  spawnSync(`aspire start --isolated ${APPHOST}`, { cwd: repo, shell: true, encoding: "utf8", env });
  spawnSync(`aspire wait keycloak --status healthy --timeout 300 ${APPHOST}`, { cwd: repo, shell: true, encoding: "utf8", env });
}

function loadRealm(c: Ctx): void {
  c.source = readAppHost();
  const { realm, problem } = readRealm(c.source);
  c.realm = realm;
  c.realmProblem = problem;
}

function base64url(part: string): Buffer {
  return Buffer.from(part, "base64url");
}

function accessToken(c: Ctx): string {
  const t = c.token;
  assert.ok(t, "Keycloak never answered the token request");
  assert.equal(t.status, 200, `the token request got ${t.status}: ${JSON.stringify(t.body)}`);
  assert.equal(typeof t.body.access_token, "string", "the reply has no access token");
  return t.body.access_token as string;
}

function claims(c: Ctx): Json {
  const parts = accessToken(c).split(".");
  assert.equal(parts.length, 3, "the access token isn't a JWT");
  return JSON.parse(base64url(parts[1]).toString("utf8")) as Json;
}

After({ tags: "@pbi-169 and @local" }, function () {
  if (ctx(this).started) spawnSync(`aspire stop ${APPHOST}`, { cwd: repo, shell: true });
});

// ---- Reading the AppHost and the realm import ----

When("I read the realm import the AppHost gives Keycloak", function () {
  loadRealm(ctx(this));
});

When("I read the AppHost", function () {
  ctx(this).source = readAppHost();
});

When("I read the AppHost and the realm import the AppHost gives Keycloak", function () {
  loadRealm(ctx(this));
});

Then("it defines a client {string}", function (id: string) {
  const realm = needRealm(ctx(this));
  assert.ok(client(realm, id), `no client "${id}" among ${JSON.stringify(clients(realm).map((cl) => cl.clientId))}`);
});

Then("it defines an e2e client", function () {
  const realm = needRealm(ctx(this));
  assert.ok(e2eClient(realm), `no e2e client among ${JSON.stringify(clients(realm).map((cl) => cl.clientId))}`);
});

Then("it defines an audience mapper that adds the API's audience to access tokens", function () {
  const realm = needRealm(ctx(this));
  const found = audienceMappers(realm).filter((m) => mapperAudience(m) && m.config?.["access.token.claim"] === "true");
  assert.ok(found.length > 0, "no audience mapper that adds an audience to access tokens");
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Then("it defines a test owner user with a password", function () {
  const owner = testOwner(needRealm(ctx(this)));
  assert.ok(owner, "no user with a password credential");
  // Migrate seeds the owner from this user, so its subject must be known before anyone signs in (redesign §07, §13).
  assert.match(owner.id ?? "", UUID, `the test owner has no fixed UUID id: ${JSON.stringify(owner.id)}`);
});

/** The token's subject is the test owner's fixed id from the realm import, so the seeding step can rely on it. */
function assertOwnerSubject(realm: Json | null | undefined, sub: unknown): void {
  const id = realm ? testOwner(realm)?.id : undefined;
  assert.ok(id, "the realm import gives the test owner no fixed id");
  assert.equal(sub, id, "the token's sub is not the test owner's fixed id from the realm import");
}

Then("it adds a Keycloak resource on port {int}", function (port: number) {
  const source = ctx(this).source;
  assert.ok(source, "the AppHost source is missing");
  const kc = keycloakStatement(source);
  assert.ok(kc, "the AppHost adds no Keycloak resource (no addKeycloak call)");
  assert.match(kc, new RegExp(`\\b${port}\\b`), `the Keycloak resource isn't pinned to ${port}`);
});

Then("it hands that resource the realm import", function () {
  const source = ctx(this).source;
  assert.ok(source, "the AppHost source is missing");
  const kc = keycloakStatement(source);
  assert.ok(kc, "the AppHost adds no Keycloak resource");
  assert.match(kc, /withRealmImport\(/, "the Keycloak resource gets no realm import");
  const path = realmImportPath(kc);
  assert.ok(path && existsSync(path), `the realm import ${path} doesn't exist`);
});

Then("the e2e client allows direct access grants", function () {
  const e2e = e2eClient(needRealm(ctx(this)));
  assert.ok(e2e, "no e2e client");
  assert.equal(e2e.directAccessGrantsEnabled, true);
});

Then("the {string} client does not allow direct access grants", function (id: string) {
  const cl = client(needRealm(ctx(this)), id);
  assert.ok(cl, `no client "${id}"`);
  assert.equal(cl.directAccessGrantsEnabled, false, `"${id}" must set directAccessGrantsEnabled to false`);
});

Then("no other client in the realm import allows direct access grants", function () {
  const realm = needRealm(ctx(this));
  const e2e = e2eClient(realm);
  assert.ok(e2e, "no e2e client");
  const others = clients(realm).filter((cl) => cl !== e2e && cl.directAccessGrantsEnabled !== false).map((cl) => cl.clientId);
  assert.deepEqual(others, [], "these clients don't turn direct access grants off");
});

Then("the AppHost sets an API_AUDIENCE value", function () {
  assert.ok(apiAudience(ctx(this).source ?? null), "the AppHost sets no literal API_AUDIENCE value");
});

Then("the realm import's audience mapper adds that same value", function () {
  const c = ctx(this);
  const audience = apiAudience(c.source ?? null);
  assert.ok(audience, "the AppHost sets no API_AUDIENCE value");
  const added = audienceMappers(needRealm(c)).map(mapperAudience);
  assert.ok(added.includes(audience), `the audience mappers add ${JSON.stringify(added)}, not "${audience}"`);
});

Then("the {string} client accepts redirects to {string}", function (id: string, url: string) {
  const cl = client(needRealm(ctx(this)), id);
  assert.ok(cl, `no client "${id}"`);
  assert.ok(accepts(cl.redirectUris, url), `"${id}" redirect URIs ${JSON.stringify(cl.redirectUris)} don't cover ${url}`);
});

// ---- Keycloak live on 7430 (@local) ----

When("I start {string} and wait until the Keycloak resource is healthy", long, async function (_cmd: string) {
  const c = ctx(this);
  loadRealm(c);
  startKeycloak(c);
  c.answered = await answers(KEYCLOAK);
  const r = await fetchOrNull(`${realmUrl(c.realm ?? null)}/.well-known/openid-configuration`);
  try {
    c.discovery = r && r.ok ? ((await r.json()) as Json) : null;
  } catch {
    c.discovery = null;
  }
});

Given("{string} has run once", long, async function (_cmd: string) {
  const c = ctx(this);
  loadRealm(c);
  startKeycloak(c);
  c.answered = await answers(KEYCLOAK);
});

When("the e2e client asks Keycloak for a token by direct grant as the test owner", long, async function () {
  const c = ctx(this);
  loadRealm(c);
  await answers(KEYCLOAK);
  c.token = await e2eGrant(c.realm ?? null);
});

When("the e2e client asks Keycloak for a token by direct grant as the test owner with a wrong password", long, async function () {
  const c = ctx(this);
  loadRealm(c);
  await answers(KEYCLOAK);
  c.token = await e2eGrant(c.realm ?? null, "not-the-password");
});

When("the {string} client asks Keycloak for a token by direct grant as the test owner", long, async function (id: string) {
  const c = ctx(this);
  loadRealm(c);
  await answers(KEYCLOAK);
  c.token = await directGrant(c.realm ?? null, id);
});

When("a browser starts sign-in for the {string} client with a redirect back to {string}", long, async function (id: string, url: string) {
  const c = ctx(this);
  loadRealm(c);
  await answers(KEYCLOAK);
  const q = new URLSearchParams({ client_id: id, response_type: "code", scope: "openid", redirect_uri: `${url}/` });
  const r = await fetchOrNull(`${realmUrl(c.realm ?? null)}/protocol/openid-connect/auth?${q}`);
  c.signIn = r ? { status: r.status, body: await r.text() } : null;
});

Then("Keycloak answers on {string}", long, async function (url: string) {
  assert.ok(await answers(url), `nothing answers on ${url}`);
});

Then("the realm's OpenID discovery document on port {int} names an issuer on port {int}", function (_on: number, port: number) {
  const d = ctx(this).discovery;
  assert.ok(d, "the realm has no discovery document on 7430");
  assert.equal(new URL(d.issuer).port, String(port), `the issuer is ${d.issuer}`);
});

Then("the discovery document has a JWKS address", function () {
  const d = ctx(this).discovery;
  assert.ok(d, "the realm has no discovery document");
  assert.equal(typeof d.jwks_uri, "string", "the discovery document has no jwks_uri");
});

Then("Keycloak issues an access token", function () {
  const c = ctx(this);
  assertOwnerSubject(c.realm, claims(c).sub);
});

Then("the e2e client can still get a token by direct grant as the test owner", long, async function () {
  const c = ctx(this);
  c.tokenAfterRestart = await e2eGrant(c.realm ?? null);
  const t = c.tokenAfterRestart;
  assert.ok(t, "Keycloak never answered the token request after the restart");
  assert.equal(t.status, 200, `the token request got ${t.status}: ${JSON.stringify(t.body)}`);
  assert.equal(typeof t.body.access_token, "string");
  const payload = JSON.parse(base64url((t.body.access_token as string).split(".")[1] ?? "").toString("utf8")) as Json;
  assertOwnerSubject(c.realm, payload.sub);
});

Then("Keycloak refuses the request as an unauthorized client", function () {
  const t = ctx(this).token;
  assert.ok(t, "Keycloak never answered the token request");
  assert.equal(t.body.error, "unauthorized_client", `Keycloak answered ${t.status}: ${JSON.stringify(t.body)}`);
});

Then("Keycloak refuses the request as invalid credentials", function () {
  const t = ctx(this).token;
  assert.ok(t, "Keycloak never answered the token request");
  assert.equal(t.body.error, "invalid_grant", `Keycloak answered ${t.status}: ${JSON.stringify(t.body)}`);
});

Then("no access token is issued", function () {
  const t = ctx(this).token;
  assert.ok(t, "Keycloak never answered the token request");
  assert.equal(t.body.access_token, undefined);
});

Then("the access token is a JWT with a header, a payload and a signature", function () {
  const parts = accessToken(ctx(this)).split(".");
  assert.equal(parts.length, 3, "the access token isn't three dot-separated parts");
  JSON.parse(base64url(parts[0]).toString("utf8"));
  JSON.parse(base64url(parts[1]).toString("utf8"));
  assert.ok(parts[2].length > 0, "the access token has no signature");
});

Then("the token's signature checks out against the realm's JWKS", long, async function () {
  const c = ctx(this);
  const [h, p, s] = accessToken(c).split(".");
  const header = JSON.parse(base64url(h).toString("utf8")) as Json;
  const r = await fetchOrNull(`${realmUrl(c.realm ?? null)}/protocol/openid-connect/certs`);
  assert.ok(r && r.ok, "the realm's JWKS didn't answer");
  const keys = ((await r.json()) as { keys: Json[] }).keys;
  const jwk = keys.find((k) => k.kid === header.kid);
  assert.ok(jwk, `no key ${header.kid} in the realm's JWKS`);
  const ok = verify("sha256", Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk as any, format: "jwk" }), base64url(s));
  assert.ok(ok, "the token's signature doesn't check out");
});

Then("the token's {string} claim holds the API_AUDIENCE value the AppHost sets", function (claim: string) {
  const c = ctx(this);
  const audience = apiAudience(readAppHost());
  assert.ok(audience, "the AppHost sets no API_AUDIENCE value");
  const value = claims(c)[claim];
  const held = Array.isArray(value) ? value : [value];
  assert.ok(held.includes(audience), `"${claim}" is ${JSON.stringify(value)}, not holding "${audience}"`);
});

Then("the token's {string} claim is the realm's issuer on port {int}", function (claim: string, port: number) {
  const c = ctx(this);
  assert.equal(claims(c)[claim], `http://localhost:${port}/realms/${c.realm?.realm ?? "factory"}`);
});

Then("Keycloak shows its sign-in page rather than an invalid redirect error", function () {
  const s = ctx(this).signIn;
  assert.ok(s, "Keycloak never answered the sign-in request");
  assert.doesNotMatch(s.body, /invalid parameter: redirect_uri/i, "Keycloak refused the redirect");
  assert.equal(s.status, 200, `Keycloak answered ${s.status}`);
  assert.match(s.body, /kc-form-login|id="kc-login"/, "Keycloak's answer isn't its sign-in page");
});

Then("Keycloak refuses with an invalid redirect error", function () {
  const s = ctx(this).signIn;
  assert.ok(s, "Keycloak never answered the sign-in request");
  assert.match(s.body, /invalid parameter: redirect_uri/i, `Keycloak answered ${s.status} without an invalid redirect error`);
});
