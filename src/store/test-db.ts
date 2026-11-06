import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type pg from "pg";
import { createPool, migrate } from "./db.ts";

/** A throwaway, migrated Postgres for tests. Needs a Docker daemon. */
export async function startTestDb(): Promise<{ pool: pg.Pool; url: string; stop(): Promise<void> }> {
  const container = await new PostgreSqlContainer("postgres:17").start();
  const url = container.getConnectionUri();
  const pool = createPool(url);
  await migrate(pool);
  return {
    pool,
    url,
    async stop() {
      await pool.end();
      await container.stop();
    },
  };
}

/** Options for every describe that calls startTestDb. A cell has no Docker daemon, so FACTORY_DB_TESTS=skip skips them there. */
export const dbTest = { skip: process.env.FACTORY_DB_TESTS === "skip" && "no Docker daemon here" };
