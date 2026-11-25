import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { withTx } from "../store/db.ts";
import { requestFeatureChange } from "../store/feature-change.ts";
import { dbTest, startTestDb } from "../store/test-db.ts";
import { itemDetail } from "./items.ts";

describe("Run detail for the SPA", dbTest, () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;

  before(async () => {
    db = await startTestDb();
  });
  after(async () => {
    await db.stop();
  });

  test("carries the open feature change request only while the item waits in FeatureChangeRequest (PBI 366)", async () => {
    const files = [{ path: "features/pbi-1.feature", reason: "Held, not refused", before: "Then refused\n", after: "Then held\n" }];
    const source = (await db.pool.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'items-test') returning id")).rows[0].id;
    const id = (await db.pool.query<{ id: string }>(
      "insert into item (source_id, external_id, title, state) values ($1, '366', 'waits', 'InProgress') returning id", [source],
    )).rows[0].id;
    const run = (await db.pool.query<{ id: string }>(
      "insert into run (item_id, run_number, next_stage, started_at) values ($1, 1, 'green', now()) returning id", [id],
    )).rows[0].id;
    const detail = () => itemDetail(db.pool, id, false, new Date());

    assert.equal((await detail())!.featureChange, null, "no request while InProgress");
    await withTx(db.pool, (c) => requestFeatureChange(c, run, files));
    const waiting = (await detail())!;
    assert.equal(waiting.item.state, "FeatureChangeRequest");
    assert.deepEqual(waiting.featureChange, files);
    await db.pool.query("update item set state = 'InProgress' where id = $1", [id]);
    assert.equal((await detail())!.featureChange, null, "none once the item left FeatureChangeRequest");
  });
});
