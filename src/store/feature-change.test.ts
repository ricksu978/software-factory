import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { withTx } from "./db.ts";
import { featureChangeRequest, requestFeatureChange } from "./feature-change.ts";
import { dbTest, startTestDb } from "./test-db.ts";

describe("a feature change request (PBI 364)", dbTest, () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  const files = [{ path: "features/a.feature", reason: "Held, not refused", before: "Then refused\n", after: "Then held\n" }];
  const run = async (state: string) => {
    const s = (await db.pool.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', gen_random_uuid()::text) returning id")).rows[0].id;
    const item = (await db.pool.query<{ id: string }>("insert into item (source_id, external_id, title, state) values ($1, '1', 't', $2) returning id", [s, state])).rows[0].id;
    const r = (await db.pool.query<{ id: string }>("insert into run (item_id, run_number, next_stage) values ($1, 1, 'green') returning id", [item])).rows[0].id;
    return { item, run: r };
  };

  before(async () => {
    db = await startTestDb();
  });
  after(async () => {
    await db.stop();
  });

  test("records the request on the run and moves the item to FeatureChangeRequest, the request in the move's payload", async () => {
    const x = await run("InProgress");
    assert.equal(await featureChangeRequest(db.pool, x.item), null);
    await withTx(db.pool, (c) => requestFeatureChange(c, x.run, files));
    assert.equal((await db.pool.query("select state from item where id = $1", [x.item])).rows[0].state, "FeatureChangeRequest");
    assert.deepEqual(await featureChangeRequest(db.pool, x.item), files);
    const e = (await db.pool.query("select payload from event where item_id = $1 and kind = 'transition'", [x.item])).rows[0].payload;
    assert.equal(e.event, "feature_change_requested");
    assert.deepEqual(e.featureChange, files);
  });

  test("an item that isn't InProgress can't move, and an item that left FeatureChangeRequest has no open request", async () => {
    const x = await run("Queued");
    await assert.rejects(withTx(db.pool, (c) => requestFeatureChange(c, x.run, files)));
    const y = await run("InProgress");
    await withTx(db.pool, (c) => requestFeatureChange(c, y.run, files));
    await db.pool.query("update item set state = 'Queued' where id = $1", [y.item]);
    assert.equal(await featureChangeRequest(db.pool, y.item), null);
  });
});
