import { After, Given, Then, When, type DataTable } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import pg from "pg";
import { load, long, need, testDb } from "./pbi-8.steps.ts";

// PBI 117. Each scenario gets its own database inside the shared test server, so a scenario can start from today's
// schema or from nothing and migrate it itself. Roles are cluster-wide, so principal scenarios reset the memberships
// they check. Every SQL step records its error instead of throwing, so a missing table or role fails the Then.
const repo = process.cwd();
const migrationsDir = join(repo, "db", "migrations");
// Today's schema: the migrations that exist before this item's.
const TODAY = "007";
const ISSUER_ERR = "a user needs a provider or an issuer";

type Outcome = { ok: boolean; error?: { code?: string; message: string }; rows?: Record<string, unknown>[] };
type Ctx = {
  name?: string;
  url?: string;
  pool?: pg.Pool;
  setupError?: string;
  adds: Outcome[];
  steps: Record<string, Outcome>;
  attempts: { what: string; outcome: Outcome }[];
  runId?: string;
  criteria?: string[];
  seeded?: Record<string, string>[];
  heartbeat?: Outcome;
  server?: Server;
  routes?: { close(): Promise<void> };
  origin?: string;
  devToken?: string;
  auth?: { identify(path: string, headers: Record<string, string | undefined>): unknown };
  status?: number;
  page?: string;
  cookie?: string | null;
};

function ctx(world: object): Ctx {
  const w = world as { pbi117?: Ctx };
  w.pbi117 ??= { adds: [], steps: {}, attempts: [] };
  return w.pbi117;
}

async function attempt(fn: () => Promise<Record<string, unknown>[] | void>): Promise<Outcome> {
  try {
    const rows = await fn();
    return { ok: true, rows: rows ?? [] };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, error: { code: err.code, message: String(err.message ?? e) } };
  }
}

const describe = (o: Outcome | undefined) => (o ? (o.ok ? "succeeded" : `failed: ${o.error?.message} (${o.error?.code})`) : "never ran");

/** A new, empty database in the shared test server. */
async function freshDatabase(c: Ctx): Promise<pg.Pool> {
  const d = await testDb();
  assert.ok(d, "src/store/test-db.ts doesn't exist");
  const base = (d as unknown as { url?: string }).url;
  assert.ok(base, "the test database has no url");
  c.name = `pbi117_${Math.random().toString(36).slice(2, 10)}`;
  await d.pool.query(`create database ${c.name}`);
  // The url may name a socket directory in its query, which WHATWG URL can't parse, so only the database name is swapped.
  const [path, query] = base.split("?");
  c.url = `${path.slice(0, path.lastIndexOf("/"))}/${c.name}${query ? `?${query}` : ""}`;
  c.pool = new pg.Pool({ connectionString: c.url });
  // pool.end() resolves before each idle client has closed (issue #88), so After's forced drop can still reach one,
  // and the pool re-emits that admin shutdown (57P01) as its own error. Any other error still fails the scenario.
  c.pool.on("error", (e: Error & { code?: string }) => {
    if (e.code !== "57P01") throw e;
  });
  return c.pool;
}

function pool(c: Ctx): pg.Pool {
  assert.ok(c.pool, "no database was set up");
  return c.pool;
}

/** Applies the migrations from before this item, recording them as migrate does, so migrate later adds only the new ones. */
async function todaysSchema(c: Ctx): Promise<pg.Pool> {
  const p = await freshDatabase(c);
  await p.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
  for (const name of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql") && f < TODAY).sort()) {
    await p.query(readFileSync(join(migrationsDir, name), "utf8"));
    await p.query("insert into schema_migrations (name) values ($1)", [name]);
  }
  return p;
}

type MigrateCli = { main: (args: string[], env: NodeJS.ProcessEnv) => Promise<number> };

/** Runs the real migrate entry point against this scenario's database, with only the settings given. */
async function runMigrate(c: Ctx, settings: Record<string, string> = {}): Promise<void> {
  const mod = await load<MigrateCli>("src/store/migrate-cli.ts");
  assert.ok(mod, "src/store/migrate-cli.ts doesn't exist");
  const code = await mod.main([], { PATH: process.env.PATH, FACTORY_DB_URI: c.url, FACTORY_SOURCES: join(repo, "no-such-sources.yml"), ...settings });
  assert.equal(code, 0, "migrate failed");
}

async function migratedEmpty(c: Ctx): Promise<pg.Pool> {
  const p = await freshDatabase(c);
  await runMigrate(c);
  return p;
}

/** Runs fn as `role` in a transaction of its own, the way a service that logs in as that role would. */
async function asRole<T>(p: pg.Pool, role: string, fn: (cl: pg.PoolClient) => Promise<T>): Promise<T> {
  const cl = await p.connect();
  try {
    await cl.query("begin");
    await cl.query(`set local role ${role}`);
    const r = await fn(cl);
    await cl.query("commit");
    return r;
  } catch (e) {
    await cl.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    cl.release();
  }
}

async function anItemAndEvent(p: pg.Pool): Promise<{ itemId: string; eventId: string }> {
  const s = await p.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'test:' || gen_random_uuid()) returning id");
  const i = await p.query<{ id: string }>("insert into item (source_id, external_id, title, state) values ($1, gen_random_uuid()::text, 'an item', 'Queued') returning id", [s.rows[0].id]);
  const e = await p.query<{ id: string }>("insert into event (actor, actor_id, item_id, kind) values ('system', 'test', $1, 'test') returning id", [i.rows[0].id]);
  return { itemId: i.rows[0].id, eventId: e.rows[0].id };
}

async function aRun(p: pg.Pool): Promise<string> {
  const { itemId } = await anItemAndEvent(p);
  return (await p.query<{ id: string }>("insert into run (item_id) values ($1) returning id", [itemId])).rows[0].id;
}

/** The criteria value in whatever shape run.acceptance_criteria takes: a text array, or JSON text. */
async function criteriaParam(cl: pg.Pool | pg.PoolClient, criteria: string[]): Promise<unknown> {
  const t = await cl.query<{ data_type: string }>("select data_type from information_schema.columns where table_name = 'run' and column_name = 'acceptance_criteria'");
  return t.rows[0]?.data_type === "ARRAY" ? criteria : JSON.stringify(criteria);
}

async function storeCriteria(c: Ctx, role: string | null): Promise<void> {
  const p = pool(c);
  c.criteria = ["Postgres accepts a user row with an issuer.", "Every user row still loads."];
  const write = async (cl: pg.Pool | pg.PoolClient) => {
    await cl.query("update run set acceptance_criteria = $1 where id = $2", [await criteriaParam(cl, c.criteria!), c.runId]);
  };
  c.steps.criteria = await attempt(() => (role ? asRole(p, role, write) : write(p)));
}

After({ tags: "@pbi-117", ...long }, async function () {
  const c = ctx(this);
  if (c.server) await new Promise<void>((resolve) => c.server!.close(() => resolve()));
  await c.routes?.close().catch(() => undefined);
  await c.pool?.end().catch(() => undefined);
  if (c.name) await (await testDb())?.pool.query(`drop database if exists ${c.name} with (force)`);
});

// AC-1

async function addUser(c: Ctx, cols: Record<string, string | null>): Promise<Outcome> {
  const p = c.pool ?? (await migratedEmpty(c));
  const names = Object.keys(cols);
  const o = await attempt(async () => {
    await p.query(`insert into "user" (${names.join(", ")}, role) values (${names.map((_, i) => `$${i + 1}`).join(", ")}, 'viewer')`, Object.values(cols));
  });
  c.adds.push(o);
  return o;
}

When("someone adds the user {string} from the issuer {string}, with no provider", long, async function (subject: string, issuer: string) {
  await addUser(ctx(this), { issuer, subject });
});

When("someone adds the user {string} from the issuer {string}", long, async function (subject: string, issuer: string) {
  await addUser(ctx(this), { issuer, subject });
});

When("someone adds the user {string} from the issuer {string} twice", long, async function (subject: string, issuer: string) {
  const c = ctx(this);
  await addUser(c, { issuer, subject });
  await addUser(c, { issuer, subject });
});

When("someone adds the user {string} with neither a provider nor an issuer", long, async function (subject: string) {
  await addUser(ctx(this), { subject });
});

Then("the user is added", function () {
  const o = ctx(this).adds[0];
  assert.ok(o?.ok, `adding the user ${describe(o)}`);
});

Then("the first is added", function () {
  const o = ctx(this).adds[0];
  assert.ok(o?.ok, `adding the first user ${describe(o)}`);
});

Then("both users are added", function () {
  const [a, b] = ctx(this).adds;
  assert.ok(a?.ok, `adding the first user ${describe(a)}`);
  assert.ok(b?.ok, `adding the second user ${describe(b)}`);
});

Then("the user {string} loads with the issuer {string} and no provider", async function (subject: string, issuer: string) {
  // PBI 170's scenarios use it too, on the shared test database, as they have no database of their own.
  const own = ctx(this).pool;
  const r = await (own ?? need().pool).query(`select * from "user" where subject = $1`, [subject]);
  assert.equal(r.rowCount, 1, `${r.rowCount} users "${subject}" exist`);
  assert.equal(r.rows[0].issuer, issuer);
  assert.equal(r.rows[0].provider, null);
});

Then("the user is refused because a user needs a provider or an issuer", function () {
  const o = ctx(this).adds[0];
  assert.ok(o && !o.ok, `adding the user ${describe(o)}`);
  // A check constraint, rather than today's not-null on provider.
  assert.equal(o.error?.code, "23514", `the user was refused, but not because ${ISSUER_ERR}: ${o.error?.message}`);
});

// "no user {string} exists" is PBI 89's step, which reads this scenario's own database.
Then("the second is refused as a duplicate of the first", function () {
  const o = ctx(this).adds[1];
  assert.ok(o && !o.ok, `adding the second user ${describe(o)}`);
  assert.equal(o.error?.code, "23505", `the second user was refused, but not as a duplicate: ${o.error?.message}`);
});

Then("exactly one user {string} from that issuer exists", async function (subject: string) {
  const r = await pool(ctx(this)).query(`select issuer from "user" where subject = $1`, [subject]);
  assert.equal(r.rowCount, 1);
});

Then("each loads with its own issuer", async function () {
  const r = await pool(ctx(this)).query<{ issuer: string }>(`select issuer from "user" order by issuer`);
  assert.deepEqual(r.rows.map((x) => x.issuer), ["https://id.example.com/realms/factory", "https://login.example.org"]);
});

// AC-2

const blank = (v: string) => (v === "" ? null : v);

Given("a database at today's schema holding these users:", long, async function (table: DataTable) {
  const c = ctx(this);
  const p = await todaysSchema(c);
  c.seeded = table.hashes();
  for (const u of c.seeded) {
    await p.query(
      `insert into "user" (provider, subject, tenant_id, email, github_login, role, product_owner) values ($1, $2, $3, $4, $5, $6, $7)`,
      [u.provider, u.subject, blank(u.tenant), blank(u.email), blank(u["GitHub login"]), u.role, u["product owner"] === "yes"],
    );
  }
});

When("the factory migrates that database", long, async function () {
  await runMigrate(ctx(this));
});

Then("every one of those users still loads with the provider, subject, tenant, email, GitHub login, role and product owner flag it had", async function () {
  const c = ctx(this);
  const r = await pool(c).query(`select provider, subject, tenant_id, email, github_login, role, product_owner from "user" order by subject`);
  const want = [...c.seeded!]
    .sort((a, b) => (a.subject < b.subject ? -1 : 1))
    .map((u) => ({ provider: u.provider, subject: u.subject, tenant_id: blank(u.tenant), email: blank(u.email), github_login: blank(u["GitHub login"]), role: u.role, product_owner: u["product owner"] === "yes" }));
  assert.deepEqual(r.rows, want);
});

Given("a database at today's schema whose owner is {string}", long, async function (login: string) {
  const p = await todaysSchema(ctx(this));
  await p.query(`insert into "user" (provider, subject, github_login, role, product_owner) values ('dev', $1, $1, 'owner', true)`, [login]);
});

type AuthT = { devToken: string; identify(path: string, headers: Record<string, string | undefined>): unknown };
type RoutesModule = { dashboardRoutes: (deps: Record<string, unknown>) => ((req: unknown, res: unknown) => Promise<boolean>) & { close(): Promise<void> } };

Given("the dashboard runs locally for {string} on that database", long, async function (login: string) {
  const c = ctx(this);
  const authMod = await load<{ createAuth: (cfg: { mode: "local"; devLogin: string }) => AuthT }>("src/http/auth.ts");
  const routesMod = await load<RoutesModule>("src/http/routes.ts");
  const serverMod = await load<{ startServer: (h: unknown[], o: { port: number }) => Promise<Server> }>("src/http/server.ts");
  const fakeMod = await load<{ fakeBacklog: () => { adapter: unknown } }>("src/adapters/fake.ts");
  assert.ok(authMod && routesMod && serverMod && fakeMod, "the dashboard's modules don't exist");
  const p = pool(c);
  const sourceId = (await p.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'test:dashboard') returning id")).rows[0].id;
  const auth = authMod.createAuth({ mode: "local", devLogin: login });
  c.auth = auth;
  c.devToken = auth.devToken;
  let handler: (req: unknown, res: unknown) => Promise<boolean> = async () => false;
  c.server = await serverMod.startServer([(req: unknown, res: unknown) => handler(req, res)], { port: 0 });
  c.origin = `http://127.0.0.1:${(c.server.address() as AddressInfo).port}`;
  const routes = routesMod.dashboardRoutes({ pool: p, auth, origin: c.origin, adapter: fakeMod.fakeBacklog().adapter, sourceId, env: {} });
  c.routes = routes;
  handler = routes;
});

When("someone opens this start's sign-in link and opens Floor", long, async function () {
  const c = ctx(this);
  if (!c.origin) return;
  const login = await fetch(`${c.origin}/dev-login?token=${c.devToken}`, { redirect: "manual" });
  await login.text();
  c.cookie = login.headers.get("set-cookie");
  const sent = c.cookie ? c.cookie.split(";")[0] : undefined;
  const floor = await fetch(`${c.origin}/`, { headers: sent ? { cookie: sent } : {}, redirect: "manual" });
  c.status = floor.status;
  c.page = await floor.text();
  // Shares PBI 19's "the request is signed in as {string}" step, which reads the identity this request carried.
  const w = this as { pbi19?: { identity?: unknown; identified?: boolean } };
  w.pbi19 ??= {};
  w.pbi19.identity = c.auth?.identify("/", { cookie: sent });
  w.pbi19.identified = true;
});

Then("Floor opens for {string} rather than the no-access page", function (_login: string) {
  const c = ctx(this);
  assert.ok(c.page !== undefined, "Floor was never opened");
  assert.ok(!c.page.includes("No access"), "the no-access page opened");
  assert.equal(c.status, 200, c.page);
  assert.ok(c.page.includes("<h1>Floor</h1>"), "Floor didn't open");
});

// AC-3

When("the factory migrates an empty database", long, async function () {
  await migratedEmpty(ctx(this));
});

Given("the factory has migrated an empty database", long, async function () {
  await migratedEmpty(ctx(this));
});

Then("the table {string} exists with exactly the columns {string}", async function (table: string, columns: string) {
  const r = await pool(ctx(this)).query<{ column_name: string }>(
    "select column_name from information_schema.columns where table_schema = 'public' and table_name = $1",
    [table],
  );
  assert.ok(r.rowCount, `the table "${table}" doesn't exist`);
  assert.deepEqual(r.rows.map((x) => x.column_name).sort(), columns.split(",").map((s) => s.trim()).sort());
});

Given("a run exists", long, async function () {
  const c = ctx(this);
  c.runId = await aRun(pool(c));
});

When("the run's acceptance criteria are stored", long, async function () {
  await storeCriteria(ctx(this), null);
});

When("the app's role stores the run's acceptance criteria", long, async function () {
  await storeCriteria(ctx(this), "factory_app");
});

Then("the run loads with those acceptance criteria", async function () {
  const c = ctx(this);
  assert.ok(c.steps.criteria?.ok, `storing the criteria ${describe(c.steps.criteria)}`);
  const r = await pool(c).query("select acceptance_criteria from run where id = $1", [c.runId]);
  const v = r.rows[0]?.acceptance_criteria;
  assert.deepEqual(typeof v === "string" ? JSON.parse(v) : v, c.criteria);
});

async function addOutbox(p: pg.Pool | pg.PoolClient, ids: { itemId: string; eventId: string }): Promise<Record<string, unknown>[]> {
  return (await p.query("insert into outbox (consumer, event_id, item_id) values ('mirror', $1, $2) returning seq", [ids.eventId, ids.itemId])).rows;
}

When("two outbox rows are added one after the other", long, async function () {
  const c = ctx(this);
  const p = pool(c);
  const ids = await anItemAndEvent(p);
  c.adds.push(await attempt(() => addOutbox(p, ids)));
  c.adds.push(await attempt(() => addOutbox(p, ids)));
});

Then("the second has a higher sequence number than the first", function () {
  const [a, b] = ctx(this).adds;
  assert.ok(a?.ok, `adding the first outbox row ${describe(a)}`);
  assert.ok(b?.ok, `adding the second outbox row ${describe(b)}`);
  assert.ok(BigInt(String(b.rows![0].seq)) > BigInt(String(a.rows![0].seq)), "the second row's seq isn't higher");
});

Given("the worker heartbeat holds a tick", long, async function () {
  const c = ctx(this);
  c.heartbeat = await attempt(async () => void (await pool(c).query("insert into worker_heartbeat (ticked_at) values (now())")));
});

When("a second heartbeat row is added", long, async function () {
  const c = ctx(this);
  c.adds.push(await attempt(async () => void (await pool(c).query("insert into worker_heartbeat (ticked_at) values (now())"))));
});

Then("the second heartbeat row is refused", function () {
  const c = ctx(this);
  assert.ok(c.heartbeat?.ok, `the first heartbeat row ${describe(c.heartbeat)}`);
  const o = c.adds[0];
  assert.ok(o && !o.ok, `the second heartbeat row ${describe(o)}`);
  assert.match(o.error?.code ?? "", /^23/, `the second row was refused, but not by a constraint: ${o.error?.message}`);
});

Then("the worker heartbeat still holds exactly one row", async function () {
  const r = await pool(ctx(this)).query<{ n: number }>("select count(*)::int as n from worker_heartbeat");
  assert.equal(r.rows[0].n, 1);
});

// AC-4

When("the BFF's role adds a session, reads it, changes its last seen time and removes it", long, async function () {
  const c = ctx(this);
  const p = pool(c);
  const run = (name: string, sql: string, params: unknown[]) =>
    attempt(async () => (await asRole(p, "factory_bff", (cl) => cl.query(sql, params))).rows).then((o) => (c.steps[name] = o));
  const now = new Date();
  const later = new Date(now.getTime() + 3_600_000);
  await run(
    "add",
    `insert into session (cookie_hash, issuer, subject, refresh_token_encrypted, access_token, access_token_expires_at, created_at, last_seen_at, expires_at)
     values ('hash-1', 'https://id.example.com/realms/factory', 'alice', 'sealed', 'jwt', $1, $2, $2, $1)`,
    [later, now],
  );
  await run("read", "select * from session where cookie_hash = 'hash-1'", []);
  await run("change", "update session set last_seen_at = $1 where cookie_hash = 'hash-1'", [later]);
  await run("remove", "delete from session where cookie_hash = 'hash-1'", []);
});

Then("each of those succeeds", function () {
  const c = ctx(this);
  assert.ok(Object.keys(c.steps).length > 0, "nothing was tried");
  for (const [name, o] of Object.entries(c.steps)) assert.ok(o.ok, `${name} ${describe(o)}`);
  if (c.steps.read) assert.equal(c.steps.read.rows?.length, 1, "reading found no row");
});

Then("the session is gone", async function () {
  const r = await pool(ctx(this)).query<{ n: number }>("select count(*)::int as n from session").catch((e) => assert.fail(String(e)));
  assert.equal(r.rows[0].n, 0);
});

async function firstColumn(p: pg.Pool, table: string): Promise<string> {
  const r = await p.query<{ column_name: string }>(
    "select column_name from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position limit 1",
    [table],
  );
  return r.rows[0]?.column_name ?? "id";
}

const q = (name: string) => `"${name.replaceAll('"', '""')}"`;

async function sqlFor(p: pg.Pool, action: string, table: string): Promise<string> {
  switch (action) {
    case "read": return `select * from ${q(table)} limit 1`;
    case "add to": return `insert into ${q(table)} default values`;
    case "change": {
      const col = q(await firstColumn(p, table));
      return `update ${q(table)} set ${col} = ${col} where false`;
    }
    case "remove from": return `delete from ${q(table)} where false`;
    default: throw new Error(`unknown action ${action}`);
  }
}

async function bffTries(c: Ctx, action: string, table: string): Promise<void> {
  const p = pool(c);
  const sql = await sqlFor(p, action, table);
  c.attempts.push({ what: `${action} ${table}`, outcome: await attempt(async () => void (await asRole(p, "factory_bff", (cl) => cl.query(sql)))) });
}

When("the BFF's role tries to read the {string} table", long, async function (table: string) {
  await bffTries(ctx(this), "read", table);
});

When("the BFF's role tries to change the {string} table", long, async function (table: string) {
  await bffTries(ctx(this), "change", table);
});

When("the BFF's role tries to add to the {string} table", long, async function (table: string) {
  await bffTries(ctx(this), "add to", table);
});

When("the BFF's role tries to read, add to, change and remove from every table except {string}", long, async function (except: string) {
  const c = ctx(this);
  const tables = await pool(c).query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' and table_name <> $1 order by table_name",
    [except],
  );
  for (const { table_name } of tables.rows) for (const action of ["read", "add to", "change", "remove from"]) await bffTries(c, action, table_name);
});

function allRefused(c: Ctx): void {
  assert.ok(c.attempts.length > 0, "nothing was tried");
  for (const a of c.attempts) {
    assert.ok(!a.outcome.ok, `${a.what} succeeded`);
    assert.equal(a.outcome.error?.code, "42501", `${a.what} wasn't refused for lack of permission: ${a.outcome.error?.message}`);
  }
}

Then("it is refused for lack of permission", function () {
  allRefused(ctx(this));
});

Then("every one of those attempts is refused for lack of permission", function () {
  allRefused(ctx(this));
});

// AC-5

When("the app's role adds an outbox row", long, async function () {
  const c = ctx(this);
  const p = pool(c);
  const ids = await anItemAndEvent(p);
  c.adds.push(await attempt(() => asRole(p, "factory_app", (cl) => addOutbox(cl, ids))));
});

Then("the outbox row is added with a sequence number", function () {
  const o = ctx(this).adds[0];
  assert.ok(o?.ok, `adding the outbox row ${describe(o)}`);
  assert.ok(o.rows?.[0]?.seq != null, "the row came back without a seq");
});

type Crud = { add: string; read: string; change: string; remove: string };

async function crudFor(p: pg.Pool, table: string): Promise<{ sql: Crud; params: unknown[] }> {
  switch (table) {
    case "outbox": {
      const ids = await anItemAndEvent(p);
      return {
        params: [ids.eventId, ids.itemId],
        sql: {
          add: "insert into outbox (consumer, event_id, item_id) values ('mirror', $1, $2)",
          read: "select * from outbox where event_id = $1 and item_id = $2",
          change: "update outbox set attempts = attempts + 1, next_attempt_at = now() where event_id = $1 and item_id = $2",
          remove: "delete from outbox where event_id = $1 and item_id = $2",
        },
      };
    }
    case "worker_heartbeat":
      return {
        params: [],
        sql: {
          add: "insert into worker_heartbeat (ticked_at) values (now())",
          read: "select * from worker_heartbeat",
          change: "update worker_heartbeat set ticked_at = now()",
          remove: "delete from worker_heartbeat",
        },
      };
    case "run_file":
      return {
        params: [await aRun(p)],
        sql: {
          add: "insert into run_file (run_id, sha, path, text) values ($1, 'abc123', 'features/x.feature', 'Feature: x')",
          read: "select * from run_file where run_id = $1",
          change: "update run_file set text = 'Feature: y' where run_id = $1",
          remove: "delete from run_file where run_id = $1",
        },
      };
    default:
      throw new Error(`no rows for ${table}`);
  }
}

When("the app's role adds a row to {string}, reads it, changes it and removes it", long, async function (table: string) {
  const c = ctx(this);
  const p = pool(c);
  const { sql, params } = await crudFor(p, table);
  for (const step of ["add", "read", "change", "remove"] as const) {
    // Postgres binds only the parameters a statement uses, so each gets as many as it names.
    const used = params.slice(0, Math.max(0, ...[...sql[step].matchAll(/\$(\d+)/g)].map((m) => Number(m[1]))));
    c.steps[step] = await attempt(async () => (await asRole(p, "factory_app", (cl) => cl.query(sql[step], used))).rows);
  }
});

// AC-6

const FACTORY_ROLES = ["factory_app", "factory_bff"];

/** Creates each principal as a plain role, as pgaadauth_create_principal would in Azure, with no factory role yet. */
async function principals(names: string[]): Promise<void> {
  const d = await testDb();
  assert.ok(d, "src/store/test-db.ts doesn't exist");
  for (const n of names) {
    const exists = await d.pool.query("select 1 from pg_roles where rolname = $1", [n]);
    if (exists.rowCount === 0) await d.pool.query(`create role ${q(n)} nologin`);
    for (const r of FACTORY_ROLES) {
      const has = await d.pool.query("select 1 from pg_roles where rolname = $1", [r]);
      if (has.rowCount) await d.pool.query(`revoke ${r} from ${q(n)}`);
    }
  }
}

Given("the principals {string}, {string}, {string} and {string} exist in the database", long, async function (a: string, b: string, c: string, d: string) {
  await principals([a, b, c, d]);
});

Given("the principals {string} and {string} exist in the database", long, async function (a: string, b: string) {
  await principals([a, b]);
});

Given("the principal {string} exists in the database", long, async function (a: string) {
  await principals([a]);
});

async function migrateWith(world: object, settings: Record<string, string>): Promise<void> {
  const c = ctx(world);
  await freshDatabase(c);
  await runMigrate(c, settings);
}

When("the factory migrates with these settings:", long, async function (table: DataTable) {
  await migrateWith(this, Object.fromEntries(table.hashes().map((r) => [r.setting, r.value])));
});

When("the factory migrates with FACTORY_BFF_PRINCIPAL set to {string}", long, async function (v: string) {
  await migrateWith(this, { FACTORY_BFF_PRINCIPAL: v });
});

When("the factory migrates with FACTORY_API_PRINCIPAL set to {string} and no other principal setting", long, async function (v: string) {
  await migrateWith(this, { FACTORY_API_PRINCIPAL: v });
});

When("the factory migrates with FACTORY_APP_PRINCIPAL set to {string} and no service's principal setting", long, async function (v: string) {
  await migrateWith(this, { FACTORY_APP_PRINCIPAL: v });
});

async function memberOf(member: string): Promise<string[]> {
  const d = await testDb();
  assert.ok(d, "src/store/test-db.ts doesn't exist");
  const r = await d.pool.query<{ rolname: string }>(
    `select g.rolname from pg_auth_members m join pg_roles g on g.oid = m.roleid join pg_roles u on u.oid = m.member
     where u.rolname = $1 and g.rolname = any($2)`,
    [member, FACTORY_ROLES],
  );
  return r.rows.map((x) => x.rolname);
}

Then("{string} is a member of {string}", async function (member: string, role: string) {
  assert.ok((await memberOf(member)).includes(role), `"${member}" isn't a member of ${role}`);
});

Then("{string} is not a member of {string}", async function (member: string, role: string) {
  assert.ok(!(await memberOf(member)).includes(role), `"${member}" is a member of ${role}`);
});

Then("{string} is a member of no factory role", async function (member: string) {
  assert.deepEqual(await memberOf(member), []);
});
