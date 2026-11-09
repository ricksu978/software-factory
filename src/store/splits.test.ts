import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { keepSplit, keptSplit } from "./splits.ts";
import { dbTest, startTestDb } from "./test-db.ts";

describe("kept splits (PBI 144)", dbTest, () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  const item = async () => {
    const s = (await db.pool.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', gen_random_uuid()::text) returning id")).rows[0].id;
    return (await db.pool.query<{ id: string }>("insert into item (source_id, external_id, title, state) values ($1, '144', 't', 'Eligible') returning id", [s])).rows[0].id;
  };
  const first = [{ title: "Card", body: "b", criteria: [1], needs: [] }, { title: "Bank", body: "b", criteria: [2], needs: [1] }];
  const second = [{ title: "Payments", body: "b", criteria: [1, 2], needs: [] }, { title: "Receipt", body: "b", criteria: [3], needs: [1] }];

  before(async () => {
    db = await startTestDb();
  });
  after(async () => {
    await db.stop();
  });

  test("the first split kept for an item's text stays, and a new text keeps its own", async () => {
    const id = await item();
    assert.equal(await keptSplit(db.pool, id, "h1"), null);
    assert.deepEqual(await keepSplit(db.pool, id, "h1", first), first);
    assert.deepEqual(await keepSplit(db.pool, id, "h1", second), first);
    assert.deepEqual(await keptSplit(db.pool, id, "h1"), first);
    assert.deepEqual(await keepSplit(db.pool, id, "h2", second), second);
  });

  test("factory_app can keep and read a split", async () => {
    const id = await item();
    const c = await db.pool.connect();
    try {
      await c.query("begin");
      await c.query("set local role factory_app");
      assert.deepEqual(await keepSplit(c, id, "h", first), first);
    } finally {
      await c.query("rollback");
      c.release();
    }
  });
});
