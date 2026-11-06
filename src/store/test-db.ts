import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type pg from "pg";
import { createPool, migrate } from "./db.ts";

/** A throwaway, migrated Postgres for tests. Needs a Docker daemon. */
export async function startTestDb(): Promise<{ pool: pg.Pool; url: string; stop(opts?: { beforeContainerStop?: () => void }): Promise<void> }> {
  const container = await new PostgreSqlContainer("postgres:17").start();
  const url = container.getConnectionUri();
  const pool = createPool(url);
  // Every client that connected and hasn't yet closed its socket (issue #88). pool.end() resolves once each idle
  // client is told to end, before its socket closes, and the pool emits `remove` only from client.end()'s callback.
  // Tracked by identity from the start, so a client still closing from earlier counts, a client that emits `remove`
  // twice does no harm, and one whose connect failed, which never emits `connect`, is never waited for.
  const live = new Set<pg.PoolClient>();
  let drained: (() => void) | null = null;
  pool.on("connect", (c) => live.add(c));
  pool.on("remove", (c) => {
    live.delete(c);
    if (live.size === 0) drained?.();
  });
  await migrate(pool);
  return {
    pool,
    url,
    async stop(opts = {}) {
      const closed = new Promise<void>((resolve) => (drained = resolve));
      await pool.end();
      if (live.size > 0) await closed;
      opts.beforeContainerStop?.();
      await container.stop();
    },
  };
}

/** Options for every describe that calls startTestDb. A cell has no Docker daemon, so FACTORY_DB_TESTS=skip skips them there. */
export const dbTest = { skip: process.env.FACTORY_DB_TESTS === "skip" && "no Docker daemon here" };
