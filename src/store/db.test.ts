import assert from "node:assert/strict";
import { describe, test } from "node:test";
import pg from "pg";
import { createPool } from "./db.ts";

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
});
