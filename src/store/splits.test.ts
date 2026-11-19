import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { keepSplit, keepSplitChildren, keptSplit, splitChildren } from "./splits.ts";
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

describe("a Split parent's filed children (PBI 227)", dbTest, () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  const source = async () => (await db.pool.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', gen_random_uuid()::text) returning id")).rows[0].id;
  const item = async (sourceId: string, externalId: string, state: string) =>
    (await db.pool.query<{ id: string }>("insert into item (source_id, external_id, title, state) values ($1, $2, 't ' || $2, $3) returning id", [sourceId, externalId, state])).rows[0].id;
  const kids = [
    { externalId: "41", title: "Card", url: "https://github.com/o/r/issues/41" },
    { externalId: "42", title: "Bank", url: "https://github.com/o/r/issues/42" },
    { externalId: "43", title: "Receipt", url: "https://github.com/o/r/issues/43" },
  ];

  before(async () => {
    db = await startTestDb();
  });
  after(async () => {
    await db.stop();
  });

  test("are read in the order of the split, each with the state the factory holds it in, or null", async () => {
    const s = await source();
    const parent = await item(s, "40", "Split");
    await item(s, "41", "Queued");
    // The same number on another board is another issue.
    await item(await source(), "42", "Done");
    await keepSplitChildren(db.pool, parent, kids);
    const got = await splitChildren(db.pool, [parent]);
    assert.deepEqual(got.get(parent), [
      { ...kids[0], state: "Queued" }, { ...kids[1], state: null }, { ...kids[2], state: null },
    ]);
  });

  test("are kept once: a second keep changes nothing", async () => {
    const s = await source();
    const parent = await item(s, "40", "Split");
    await keepSplitChildren(db.pool, parent, kids);
    await keepSplitChildren(db.pool, parent, [{ externalId: "99", title: "Other", url: "u" }]);
    assert.deepEqual((await splitChildren(db.pool, [parent])).get(parent)?.map((k) => k.externalId), ["41", "42", "43"]);
  });

  test("an item with none filed has none, and each parent reads only its own", async () => {
    const s = await source();
    const a = await item(s, "40", "Split");
    const b = await item(s, "50", "Split");
    const none = await item(s, "60", "Queued");
    await keepSplitChildren(db.pool, a, kids.slice(0, 2));
    await keepSplitChildren(db.pool, b, kids.slice(2));
    const got = await splitChildren(db.pool, [a, b, none]);
    assert.deepEqual(got.get(a)?.map((k) => k.externalId), ["41", "42"]);
    assert.deepEqual(got.get(b)?.map((k) => k.externalId), ["43"]);
    assert.equal(got.get(none), undefined);
    assert.equal((await splitChildren(db.pool, [])).size, 0);
  });

  test("factory_app can keep and read them", async () => {
    const parent = await item(await source(), "40", "Split");
    const c = await db.pool.connect();
    try {
      await c.query("begin");
      await c.query("set local role factory_app");
      await keepSplitChildren(c, parent, kids);
      assert.equal((await splitChildren(c, [parent])).get(parent)?.length, 3);
    } finally {
      await c.query("rollback");
      c.release();
    }
  });
});
