import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type pg from "pg";
import { createPool, migrate } from "./db.ts";

/** A throwaway, migrated Postgres for tests. Needs a Docker daemon. */
export async function startTestDb(): Promise<{ pool: pg.Pool; url: string; stop(opts?: { beforeContainerStop?: () => void }): Promise<void> }> {
  const container = await new PostgreSqlContainer("postgres:17").start();
  const url = container.getConnectionUri();
  const pool = createPool(url);
  await migrate(pool);
  return {
    pool,
    url,
    async stop(opts = {}) {
      // pool.end() resolves once each idle client is told to end, before its socket closes. The pool emits `remove`
      // only from client.end()'s callback, so waiting for one per client means none is still connected when
      // Postgres shuts down and terminates it, which surfaced as an uncaughtException (issue #88).
      const clients = pool.totalCount;
      const closed = new Promise<void>((resolve) => {
        let left = clients;
        if (left === 0) return resolve();
        pool.on("remove", () => --left === 0 && resolve());
      });
      await pool.end();
      await closed;
      opts.beforeContainerStop?.();
      await container.stop();
    },
  };
}

/** Options for every describe that calls startTestDb. A cell has no Docker daemon, so FACTORY_DB_TESTS=skip skips them there. */
export const dbTest = { skip: process.env.FACTORY_DB_TESTS === "skip" && "no Docker daemon here" };
