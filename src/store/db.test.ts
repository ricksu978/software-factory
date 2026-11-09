import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { EventEmitter } from "node:events";
import pg from "pg";
import { createPool, withTx } from "./db.ts";
import { startTestDb } from "./test-db.ts";

describe("createPool", () => {
  test("logs a lost idle connection, with its reason, instead of throwing", async (t) => {
    const logged: string[] = [];
    t.mock.method(console, "error", (...args: unknown[]) => logged.push(args.map(String).join(" ")));
    const pool = createPool("postgresql://factory@127.0.0.1:1/factory");
    try {
      assert.equal(pool.listenerCount("error"), 1);
      const err = new Error("terminating connection due to administrator command");
      assert.doesNotThrow(() => pool.emit("error", err, {} as pg.PoolClient));
      assert.equal(logged.length, 1);
      assert.match(logged[0], /database connection lost/);
      assert.match(logged[0], /administrator command/);
    } finally {
      await pool.end();
    }
  });

  test("gives each pool its own listener, the Azure pool too", async () => {
    const azure = { PGHOST: "factory.postgres.database.azure.com", PGUSER: "id", PGDATABASE: "factory" };
    const saved = Object.keys(azure).map((k) => [k, process.env[k]] as const);
    const pools: pg.Pool[] = [];
    try {
      Object.assign(process.env, azure);
      pools.push(createPool("postgresql://factory@127.0.0.1:1/a"), createPool("postgresql://factory@127.0.0.1:1/b"), createPool());
      for (const p of pools) assert.equal(p.listenerCount("error"), 1);
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      for (const p of pools) await p.end();
    }
  });

  test("gives every client its own listener, which logs only while the client is checked out", async (t) => {
    const logged: string[] = [];
    t.mock.method(console, "error", (...args: unknown[]) => logged.push(args.map(String).join(" ")));
    const pool = createPool("postgresql://factory@127.0.0.1:1/factory");
    try {
      const c = new EventEmitter() as unknown as pg.PoolClient;
      pool.emit("connect", c);
      assert.equal(c.listenerCount("error"), 1);
      pool.emit("acquire", c);
      assert.doesNotThrow(() => c.emit("error", new Error("terminating connection due to administrator command")));
      assert.equal(logged.length, 1);
      assert.match(logged[0], /checked-out client/);
      assert.match(logged[0], /administrator command/);
      pool.emit("release", undefined, c);
      c.emit("error", new Error("idle loss, which the pool logs"));
      assert.equal(logged.length, 1);
    } finally {
      await pool.end();
    }
  });
});

describe("a connection lost while checked out", () => {
  test("rejects the transaction without crashing, and the next query runs on a fresh connection", async (t) => {
    t.mock.method(console, "error", () => {});
    const db = await startTestDb();
    try {
      const killer = new pg.Client({ connectionString: db.url });
      await killer.connect();
      try {
        await assert.rejects(
          withTx(db.pool, async (c) => {
            const pid = (await c.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid;
            await killer.query("select pg_terminate_backend($1)", [pid]);
            // Awaiting other work, as claimAndPin awaits GitHub, while Postgres ends this connection.
            await new Promise((r) => setTimeout(r, 200));
            await c.query("select 1");
          }),
        );
      } finally {
        await killer.end();
      }
      assert.equal((await db.pool.query("select 1 as one")).rows[0].one, 1);
    } finally {
      await db.stop();
    }
  });
});
