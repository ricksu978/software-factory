// Step definitions for features/pbi-171-migrate-seeds-keycloak-owner.feature.
// The @db scenarios run src/store/migrate-cli.ts as a child process, as Aspire's `migrate` resource runs it locally
// (FACTORY_ENV=local), on PBI 4's shared test database, and read the "user" table directly. The realm's test owner is
// the realm import's user with a password, and its subject is that user's fixed id (PBI 169).
// Migrate finds Keycloak the way Aspire's withReference() tells a resource where another one answers: through
// services__keycloak__http__0. "No Keycloak is answering" points that at a port nothing listens on. "Keycloak answers
// on a port other than 7430" starts a fake Keycloak that serves the realm's OpenID discovery document, whose issuer
// names the fake's own port.
// Given and When only set up and record. Every assertion is in a Then, so missing behaviour shows as a failed Then.
// "it exits {int}" is PBI 89's step and "no user from the issuer {string} exists" is PBI 170's.
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import pg from "pg";
import { ctx as migrateCtx } from "./pbi-89.steps.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";

const repo = process.cwd();
const REALM_FILE = join(repo, "aspire-apphost", "keycloak", "factory-realm.json");
const APPHOST = "--apphost . --non-interactive --nologo";
const longer = { timeout: 600_000 };

type Json = Record<string, any>;

type Ctx = {
  keycloak?: string;
  fake?: Server;
  namedIssuer?: string;
  aspireStarted?: boolean;
  liveKeycloak?: string | null;
  liveIssuer?: string | null;
  liveDbUri?: string | null;
};

function ctx(world: object): Ctx {
  const w = world as { pbi171?: Ctx };
  w.pbi171 ??= {};
  return w.pbi171;
}

const pool = () => need().pool;

function realm(): Json {
  return JSON.parse(readFileSync(REALM_FILE, "utf8")) as Json;
}

/** The realm import's test owner: the user with a password credential. */
function testOwner(r: Json = realm()): { id: string; username: string; password: string } {
  const users = Array.isArray(r.users) ? (r.users as Json[]) : [];
  for (const u of users) {
    const cred = (Array.isArray(u.credentials) ? (u.credentials as Json[]) : []).find((c) => c.type === "password");
    if (typeof u.id === "string" && typeof u.username === "string" && cred) return { id: u.id, username: u.username, password: cred.value };
  }
  throw new Error("the realm import has no test owner with a password and a fixed id");
}

/** A localhost URL on a port nothing listens on: a port the OS just handed out and took back. */
async function deadUrl(): Promise<string> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return `http://localhost:${port}`;
}

/** A fake Keycloak on a free port. Its realm's discovery document names an issuer on that port. */
async function fakeKeycloak(c: Ctx): Promise<void> {
  const name = realm().realm as string;
  const server = createServer((req, res) => {
    const port = (server.address() as AddressInfo).port;
    const issuer = `http://localhost:${port}/realms/${name}`;
    if (req.url === `/realms/${name}/.well-known/openid-configuration`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/protocol/openid-connect/certs`, token_endpoint: `${issuer}/protocol/openid-connect/token` }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  c.fake = server;
  c.keycloak = `http://localhost:${port}`;
  c.namedIssuer = `${c.keycloak}/realms/${name}`;
}

async function runMigrate(world: object, devLogin: string | null, ports: "pinned" | "floating"): Promise<void> {
  const c = ctx(world);
  const db = (await testDb()) as unknown as { url: string };
  c.keycloak ??= await deadUrl();
  // Only PATH and SystemRoot from this process, so nothing else on the runner's environment changes the outcome.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    SystemRoot: process.env.SystemRoot ?? "",
    FACTORY_DB_URI: db.url,
    FACTORY_ENV: "local",
    // A file that doesn't exist, so migrate adds no backlog sources.
    FACTORY_SOURCES: join(repo, "features", "fixtures", "pbi-171-no-such-sources.yml"),
    services__keycloak__http__0: c.keycloak,
  };
  if (devLogin) env.FACTORY_DEV_LOGIN = devLogin;
  if (ports === "floating") env.FACTORY_FLOAT_PORTS = "1";
  // The fake Keycloak runs in this process, so the child runs asynchronously and this event loop keeps serving it.
  migrateCtx(world).started = await spawnAsync(process.execPath, ["src/store/migrate-cli.ts"], env);
}

function spawnAsync(cmd: string, args: string[], env: Record<string, string>): Promise<SpawnSyncReturns<string>> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, cwd: repo });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ pid: child.pid ?? 0, output: [null, stdout, stderr], stdout, stderr, status, signal });
    });
  });
}

Before({ tags: "@pbi-171 and @db", ...long }, async function () {
  const d = await testDb();
  if (!d) return;
  await d.pool.query(`truncate "user" cascade`);
});

After({ tags: "@pbi-171" }, async function () {
  const c = ctx(this);
  if (c.fake) {
    c.fake.closeAllConnections();
    await new Promise<void>((resolve) => c.fake!.close(() => resolve()));
  }
  if (c.aspireStarted) spawnSync(`aspire stop ${APPHOST}`, { cwd: repo, shell: true });
});

// ---- Given ----

Given("no Keycloak is answering", async function () {
  ctx(this).keycloak = await deadUrl();
});

Given("Keycloak answers on a port other than 7430, and its realm names its issuer on that port", async function () {
  await fakeKeycloak(ctx(this));
});

Given("migrate has run locally with the dev login {string} and pinned ports", long, async function (login: string) {
  await runMigrate(this, login, "pinned");
});

Given("the realm's test owner from the issuer {string} is a viewer", async function (issuer: string) {
  await pool().query(`insert into "user" (issuer, subject, role) values ($1, $2, 'viewer')`, [issuer, testOwner().id]);
});

// ---- When ----

When("migrate runs locally with the dev login {string} and pinned ports", long, async function (login: string) {
  await runMigrate(this, login, "pinned");
});

When("migrate runs locally with no dev login and pinned ports", long, async function () {
  await runMigrate(this, null, "pinned");
});

When("migrate runs locally with the dev login {string} and floating ports", long, async function (login: string) {
  await runMigrate(this, login, "floating");
});

// ---- Then ----

async function assertTestOwner(issuer: string): Promise<void> {
  const rows = (await pool().query(`select role from "user" where issuer = $1 and subject = $2`, [issuer, testOwner().id])).rows;
  assert.deepEqual(rows, [{ role: "owner" }], `the realm's test owner from ${issuer} is ${JSON.stringify(rows)}`);
}

Then("the realm's test owner is an owner from the issuer {string}", async function (issuer: string) {
  await assertTestOwner(issuer);
});

Then("the realm's test owner is an owner from the issuer Keycloak named", async function () {
  const issuer = ctx(this).namedIssuer;
  assert.ok(issuer, "no Keycloak named an issuer");
  await assertTestOwner(issuer);
});

Then("the realm's test owner has the subject the realm import gives it, and no provider", async function () {
  const rows = (await pool().query(`select subject, provider from "user" where issuer is not null`)).rows;
  assert.deepEqual(rows, [{ subject: testOwner().id, provider: null }]);
});

Then("the realm's test owner has no GitHub login", async function () {
  const rows = (await pool().query(`select github_login from "user" where issuer is not null and subject = $1`, [testOwner().id])).rows;
  assert.deepEqual(rows, [{ github_login: null }]);
});

Then("the dev login {string} is still an owner and a product owner", async function (login: string) {
  const rows = (await pool().query(`select github_login, role, product_owner from "user" where provider = 'dev' and subject = $1`, [login])).rows;
  assert.deepEqual(rows, [{ github_login: login, role: "owner", product_owner: true }]);
});

Then("exactly one user from the issuer {string} exists", async function (issuer: string) {
  const r = await pool().query(`select subject from "user" where issuer = $1`, [issuer]);
  assert.equal(r.rowCount, 1, `users from ${issuer}: ${JSON.stringify(r.rows)}`);
});

Then("it exits with an error naming Keycloak", function () {
  const r = migrateCtx(this).started!;
  assert.notEqual(r.status, 0, "migrate exited 0");
  assert.match(r.stderr, /keycloak/i);
});

// ---- @local: the owner runs these, and the PR records the run ----

function sh(command: string): { status: number | null; stdout: string } {
  const r = spawnSync(command, { cwd: repo, shell: true, encoding: "utf8", env: { ...process.env, FACTORY_FLOAT_PORTS: "1" } });
  return { status: r.status, stdout: r.stdout ?? "" };
}

/** One resource from `aspire describe`. Never printed: it shows environment values such as FACTORY_DB_URI. */
function describe(resource: string): Json | null {
  const r = sh(`aspire describe ${resource} --format Json ${APPHOST}`);
  try {
    return (JSON.parse(r.stdout.slice(r.stdout.indexOf("{"))) as { resources: Json[] }).resources[0] ?? null;
  } catch {
    return null;
  }
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: Json } | null> {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    return { status: r.status, body: (await r.json()) as Json };
  } catch {
    return null;
  }
}

Given("{string} is up with FACTORY_FLOAT_PORTS=1", longer, async function (_cmd: string) {
  const c = ctx(this);
  c.aspireStarted = true;
  sh(`aspire start --isolated ${APPHOST}`);
  sh(`aspire wait keycloak --status healthy --timeout 300 ${APPHOST}`);
  sh(`aspire wait migrate --status down --timeout 300 ${APPHOST}`);
  const url = describe("keycloak")?.urls?.find((u: Json) => typeof u.url === "string" && u.url.startsWith("http"))?.url;
  c.liveKeycloak = typeof url === "string" ? url.replace(/\/$/, "") : null;
  const uri = describe("migrate")?.environment?.FACTORY_DB_URI;
  c.liveDbUri = typeof uri === "string" ? uri : null;
});

When("I read the issuer from the live realm's OpenID discovery document", longer, async function () {
  const c = ctx(this);
  const r = c.liveKeycloak ? await fetchJson(`${c.liveKeycloak}/realms/${realm().realm}/.well-known/openid-configuration`) : null;
  c.liveIssuer = typeof r?.body.issuer === "string" ? r.body.issuer : null;
});

Then("the database holds the realm's test owner as an owner from that issuer", async function () {
  const c = ctx(this);
  assert.ok(c.liveIssuer, "the live realm named no issuer");
  assert.ok(c.liveDbUri, "aspire describe gave migrate no FACTORY_DB_URI");
  const live = new pg.Pool({ connectionString: c.liveDbUri });
  try {
    const rows = (await live.query(`select role from "user" where issuer = $1 and subject = $2`, [c.liveIssuer, testOwner().id])).rows;
    assert.deepEqual(rows, [{ role: "owner" }], `the realm's test owner from ${c.liveIssuer} is ${JSON.stringify(rows)}`);
  } finally {
    await live.end();
  }
});

Then("the e2e client's token for the test owner carries that issuer and the test owner's subject", async function () {
  const c = ctx(this);
  assert.ok(c.liveIssuer, "the live realm named no issuer");
  const r = realm();
  const e2e = ((r.clients ?? []) as Json[]).find((cl) => /e2e/i.test(cl.clientId));
  assert.ok(e2e, "the realm import has no e2e client");
  const owner = testOwner(r);
  const form = new URLSearchParams({ grant_type: "password", client_id: e2e.clientId, username: owner.username, password: owner.password, scope: "openid" });
  if (typeof e2e.secret === "string") form.set("client_secret", e2e.secret);
  const reply = await fetchJson(`${c.liveIssuer}/protocol/openid-connect/token`, { method: "POST", body: form });
  assert.ok(reply, "Keycloak never answered the token request");
  assert.equal(reply.status, 200, `the token request got ${reply.status}`);
  const claims = JSON.parse(Buffer.from(String(reply.body.access_token).split(".")[1] ?? "", "base64url").toString("utf8")) as Json;
  assert.equal(claims.iss, c.liveIssuer);
  assert.equal(claims.sub, owner.id);
});
