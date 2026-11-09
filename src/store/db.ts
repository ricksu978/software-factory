import { DefaultAzureCredential } from "@azure/identity";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const migrationsDir = join(import.meta.dirname, "..", "..", "db", "migrations");

/**
 * Locally the caller passes FACTORY_DB_URI. In Azure, with no URL, it signs in as the managed identity through Entra.
 * Postgres can end an idle pool connection at any time (an administrator, a restart, the network). The pool then
 * emits `error`, which with no listener would crash the process, so every pool logs it and carries on: the pool has
 * already dropped that client, and the next query opens a fresh connection.
 * pg-pool takes that listener off a client while it is checked out, so a connection lost mid-transaction (withTx,
 * migrate, the webhook) would still emit an unhandled `error` on the client. Each client therefore gets its own
 * listener when it connects. It logs only while the client is checked out, since the pool logs idle losses. The query in
 * flight still rejects, and on release the pool drops the dead client because it is no longer queryable.
 */
export function createPool(url?: string): pg.Pool {
  const pool = url ? new pg.Pool({ connectionString: url }) : azurePool();
  pool.on("error", (e) => console.error("database connection lost, the pool will open a fresh one:", e.message));
  const checkedOut = new WeakSet<pg.PoolClient>();
  pool.on("acquire", (c) => checkedOut.add(c));
  pool.on("release", (_e, c) => checkedOut.delete(c));
  pool.on("connect", (c) =>
    c.on("error", (e) => {
      if (checkedOut.has(c)) console.error("database connection lost on a checked-out client:", e.message);
    }),
  );
  return pool;
}

function azurePool(): pg.Pool {
  const credential = new DefaultAzureCredential();
  return new pg.Pool({
    host: process.env.PGHOST,
    user: process.env.PGUSER,
    database: process.env.PGDATABASE,
    ssl: true,
    password: async () => (await credential.getToken("https://ossrdbms-aad.database.windows.net/.default")).token,
  });
}

/**
 * Applies db/migrations/*.sql in name order, each once, under a session advisory lock so two migrators can't race.
 * The connection is destroyed on release, which drops the lock, so a dropped connection can't hide the real error.
 */
export async function migrate(pool: pg.Pool): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query("select pg_advisory_lock(7400)");
    await c.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
    const done = new Set((await c.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name));
    for (const name of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
      if (done.has(name)) continue;
      await c.query("begin");
      try {
        await c.query(readFileSync(join(migrationsDir, name), "utf8"));
        await c.query("insert into schema_migrations (name) values ($1)", [name]);
        await c.query("commit");
      } catch (e) {
        await c.query("rollback");
        throw e;
      }
    }
  } finally {
    c.release(true);
  }
}

const afterCommit = new WeakMap<pg.PoolClient, (() => Promise<void>)[]>();
const poolOf = new WeakMap<pg.PoolClient, pg.Pool>();

/** True when c is a client inside withTx. */
export function inTx(c: pg.PoolClient): boolean {
  return afterCommit.has(c);
}

/** The pool a withTx client came from, so a process's hooks can tell its own transactions from another's. */
export function txPool(c: pg.PoolClient): pg.Pool | undefined {
  return poolOf.get(c);
}

/** Queues work that must run only once the surrounding withTx commits, such as onTransition hooks. */
export function runAfterCommit(c: pg.PoolClient, fn: () => Promise<void>): void {
  const queue = afterCommit.get(c);
  if (!queue) throw new Error("runAfterCommit needs a client inside withTx");
  queue.push(fn);
}

/**
 * Runs fn in one transaction. Work queued with runAfterCommit runs after COMMIT, once the connection is back in
 * the pool, and is dropped on rollback. A failing job is logged and never turns a committed transaction into an error.
 */
export async function withTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  const queue: (() => Promise<void>)[] = [];
  afterCommit.set(c, queue);
  poolOf.set(c, pool);
  let result: T;
  try {
    await c.query("begin");
    result = await fn(c);
    await c.query("commit");
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    afterCommit.delete(c);
    poolOf.delete(c);
    c.release();
  }
  for (const job of queue) {
    try {
      await job();
    } catch (e) {
      console.error("after-commit job failed:", e);
    }
  }
  return result;
}
