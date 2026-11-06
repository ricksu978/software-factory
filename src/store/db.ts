import { DefaultAzureCredential } from "@azure/identity";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const migrationsDir = join(import.meta.dirname, "..", "..", "db", "migrations");

/** Locally the caller passes FACTORY_DB_URI. In Azure, with no URL, it signs in as the managed identity through Entra. */
export function createPool(url?: string): pg.Pool {
  if (url) return new pg.Pool({ connectionString: url });
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

/** True when c is a client inside withTx. */
export function inTx(c: pg.PoolClient): boolean {
  return afterCommit.has(c);
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
