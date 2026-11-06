import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type pg from "pg";
import { createPool, migrate } from "./db.ts";

const run = promisify(execFile);

type TestDb = { pool: pg.Pool; url: string; stop(opts?: { beforeContainerStop?: () => void }): Promise<void> };

/**
 * A throwaway, migrated Postgres for tests, one server per call. With FACTORY_PG_BIN set, as in a cell (PBI 22), it
 * starts its own server from those binaries in a temp directory, listening on a Unix socket only. Otherwise it needs a
 * Docker daemon and starts a Testcontainers Postgres, as CI does.
 */
export async function startTestDb(): Promise<TestDb> {
  const bin = process.env.FACTORY_PG_BIN;
  if (bin) return localServer(bin);
  // Loaded only here, so a cell image without dev dependencies can still import this file.
  const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
  const container = await new PostgreSqlContainer("postgres:17").start();
  return started(container.getConnectionUri(), () => container.stop().then(() => undefined));
}

async function localServer(bin: string): Promise<TestDb> {
  const dir = await mkdtemp(join(tmpdir(), "pg-"));
  const data = join(dir, "data");
  const user = userInfo().username;
  const stop = async () => {
    await run(join(bin, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]);
    await rm(dir, { recursive: true, force: true });
  };
  try {
    await run(join(bin, "initdb"), ["-D", data, "--auth=trust", "-U", user, "--no-sync"]);
    await run(join(bin, "pg_ctl"), ["-D", data, "-l", join(dir, "log"), "-w", "-o", `-c listen_addresses='' -c unix_socket_directories='${dir}' -c fsync=off`, "start"]);
  } catch (e) {
    // pg_ctl -w can time out after the server started, so stop it, if it runs, before deleting its directory.
    await stop().catch(() => rm(dir, { recursive: true, force: true }));
    throw e;
  }
  // pg reads a host that is a path as the socket's directory.
  const url = `postgresql://${encodeURIComponent(user)}@/postgres?host=${encodeURIComponent(dir)}`;
  return started(url, stop);
}

async function started(url: string, shutdown: () => Promise<void>): Promise<TestDb> {
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
  try {
    await migrate(pool);
  } catch (e) {
    // No reaper cleans up after a local server, so a failed start shuts down what it began.
    await pool.end().catch(() => undefined);
    await shutdown().catch(() => undefined);
    throw e;
  }
  return {
    pool,
    url,
    async stop(opts = {}) {
      const closed = new Promise<void>((resolve) => (drained = resolve));
      await pool.end();
      if (live.size > 0) await closed;
      opts.beforeContainerStop?.();
      await shutdown();
    },
  };
}

/** Options for every describe that calls startTestDb. Set FACTORY_DB_TESTS=skip on a machine with neither Docker nor FACTORY_PG_BIN. */
export const dbTest = { skip: process.env.FACTORY_DB_TESTS === "skip" && "no Docker daemon here" };
