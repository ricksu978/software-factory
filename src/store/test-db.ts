import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type pg from "pg";
import { createPool, migrate } from "./db.ts";

const run = promisify(execFile);

/**
 * A throwaway, migrated Postgres for tests, one server per call. With FACTORY_PG_BIN set, as in a cell (PBI 22), it
 * starts its own server from those binaries in a temp directory, listening on a Unix socket only. Otherwise it needs a
 * Docker daemon and starts a Testcontainers Postgres, as CI does.
 */
export async function startTestDb(): Promise<{ pool: pg.Pool; url: string; stop(): Promise<void> }> {
  const bin = process.env.FACTORY_PG_BIN;
  if (bin) return localServer(bin);
  // Loaded only here, so a cell image without dev dependencies can still import this file.
  const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
  const container = await new PostgreSqlContainer("postgres:17").start();
  const url = container.getConnectionUri();
  return started(url, () => container.stop().then(() => undefined));
}

async function localServer(bin: string) {
  const dir = await mkdtemp(join(tmpdir(), "pg-"));
  const data = join(dir, "data");
  const user = userInfo().username;
  try {
    await run(join(bin, "initdb"), ["-D", data, "--auth=trust", "-U", user, "--no-sync"]);
    await run(join(bin, "pg_ctl"), ["-D", data, "-l", join(dir, "log"), "-w", "-o", `-c listen_addresses='' -c unix_socket_directories='${dir}' -c fsync=off`, "start"]);
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
  // pg reads a host that is a path as the socket's directory.
  const url = `postgresql://${encodeURIComponent(user)}@/postgres?host=${encodeURIComponent(dir)}`;
  return started(url, async () => {
    await run(join(bin, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]);
    await rm(dir, { recursive: true, force: true });
  });
}

async function started(url: string, shutdown: () => Promise<void>) {
  const pool = createPool(url);
  await migrate(pool);
  return {
    pool,
    url,
    async stop() {
      await pool.end();
      await shutdown();
    },
  };
}

/** Options for every describe that calls startTestDb. Set FACTORY_DB_TESTS=skip on a machine with neither Docker nor FACTORY_PG_BIN. */
export const dbTest = { skip: process.env.FACTORY_DB_TESTS === "skip" && "no Docker daemon here" };
