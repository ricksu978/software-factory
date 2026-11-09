import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { readinessChecks, readinessSpend, recordReadinessCheck } from "./readiness-checks.ts";
import { dbTest, startTestDb } from "./test-db.ts";

describe("readiness checks", dbTest, () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  const item = async (state: string) => {
    const s = (await db.pool.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', gen_random_uuid()::text) returning id")).rows[0].id;
    return (await db.pool.query<{ id: string }>("insert into item (source_id, external_id, title, state) values ($1, '132', 't', $2) returning id", [s, state])).rows[0].id;
  };

  before(async () => {
    db = await startTestDb();
  });
  after(async () => {
    await db.stop();
  });

  test("an item's checks read back oldest first, with what each spent and when it ran", async () => {
    const id = await item("NotReady");
    const later = { model: "claude-haiku-4-5", tokensIn: 1200, tokensOut: 80, costUsd: 0.0031, ranAt: new Date("2026-11-09T10:15:00Z") };
    const earlier = { model: "claude-haiku-4-5", tokensIn: 1100, tokensOut: 70, costUsd: 0.0025, ranAt: new Date("2026-11-08T09:00:00Z") };
    await recordReadinessCheck(db.pool, id, later);
    await recordReadinessCheck(db.pool, id, earlier);
    assert.deepEqual(await readinessChecks(db.pool, id), [earlier, later]);
    assert.deepEqual(await readinessChecks(db.pool, await item("Eligible")), []);
  });

  test("readiness spend sums every item's checks, a turned-away item's included", async () => {
    await db.pool.query("truncate readiness_check");
    assert.equal(await readinessSpend(db.pool), 0);
    const check = { model: "m", tokensIn: 1, tokensOut: 0, ranAt: new Date() };
    await recordReadinessCheck(db.pool, await item("NotReady"), { ...check, costUsd: 0.002 });
    await recordReadinessCheck(db.pool, await item("Done"), { ...check, costUsd: 0.003 });
    assert.ok(Math.abs((await readinessSpend(db.pool)) - 0.005) < 1e-12);
  });

  test("factory_app can record a check", async () => {
    const id = await item("Eligible");
    const c = await db.pool.connect();
    try {
      await c.query("begin");
      await c.query("set local role factory_app");
      await recordReadinessCheck(c, id, { model: "m", tokensIn: 0, tokensOut: 0, costUsd: 0, ranAt: new Date() });
    } finally {
      await c.query("rollback");
      c.release();
    }
  });
});
