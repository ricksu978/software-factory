// PBI 265: Start now, Move up and Move down, read by the claim order that claimNext and Floor's "Next up" share.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { withTx } from "./db.ts";
import { claimNext, moveInQueue, nextUp } from "./items.ts";
import { setOverride, type OverrideKind } from "./overrides.ts";
import { dbTest, startTestDb } from "./test-db.ts";

describe("queue order", dbTest, () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let source: string;
  let operator: string;

  before(async () => {
    db = await startTestDb();
  });
  after(async () => {
    await db?.stop();
  });
  beforeEach(async () => {
    await db.pool.query(`truncate item, backlog_source, override, "user" cascade`);
    source = (await db.pool.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'unit') returning id")).rows[0].id;
    operator = (await db.pool.query<{ id: string }>(
      `insert into "user" (provider, subject, github_login, role) values ('microsoft', 'op', 'op', 'operator') returning id`,
    )).rows[0].id;
  });

  const names = new Map<string, string>();
  async function item(name: string, state: string, rank: number, set = ""): Promise<string> {
    const id = (await db.pool.query<{ id: string }>(
      "insert into item (source_id, external_id, title, state, backlog_rank) values ($1, $2, $2, $3, $4) returning id",
      [source, name, state, rank],
    )).rows[0].id;
    if (set) await db.pool.query(`update item set ${set} where id = $1`, [id]);
    names.set(id, name);
    return id;
  }
  const order = async () => (await nextUp(db.pool, 10)).map((r) => r.external_id);
  const press = (itemId: string, kind: OverrideKind) =>
    setOverride(db.pool, { scope: "item", targetId: itemId, kind, reason: "unit", createdBy: operator, expiresAt: null });

  test("a Start now item comes before the items above it and before an answered item", async () => {
    const b = await item("B", "NeedsInput", 1);
    await db.pool.query("insert into question (item_id, kind, body, answer) values ($1, 'needs_input', 'q', 'a')", [b]);
    await item("C", "Queued", 2);
    const a = await item("A", "Queued", 3);
    assert.deepEqual(await order(), ["B", "C", "A"]);
    await press(a, "start_now");
    assert.deepEqual(await order(), ["A", "B", "C"]);
    assert.equal((await withTx(db.pool, (c) => claimNext(c, "scheduler", new Date())))?.itemId, a);
  });

  test("a Start now item that is held, blocked or not Queued yet isn't claimable", async () => {
    await item("B", "Queued", 1);
    const held = await item("H", "Queued", 2, "held = true");
    const blocked = await item("X", "Queued", 3, "blocked_by = '{9}'");
    const notReady = await item("N", "NotReady", 4);
    for (const id of [held, blocked, notReady]) await press(id, "start_now");
    assert.deepEqual(await order(), ["B"]);
  });

  test("a cleared Start now gives the item back its board place", async () => {
    await item("A", "Queued", 1);
    const b = await item("B", "Queued", 2);
    await press(b, "start_now");
    assert.deepEqual(await order(), ["B", "A"]);
    await db.pool.query("update override set cleared_at = now()");
    assert.deepEqual(await order(), ["A", "B"]);
  });

  test("Move up and Move down step an item one place, and two moves step it two", async () => {
    await item("A", "Queued", 1);
    await item("B", "Queued", 2);
    const c = await item("C", "Queued", 3);
    const move = (id: string, dir: "up" | "down") => withTx(db.pool, (cl) => moveInQueue(cl, id, dir, { reason: "unit", createdBy: operator }));
    await move(c, "up");
    assert.deepEqual(await order(), ["A", "C", "B"]);
    await move(c, "up");
    assert.deepEqual(await order(), ["C", "A", "B"]);
    await move(c, "down");
    assert.deepEqual(await order(), ["A", "C", "B"]);
    await move(c, "down");
    assert.deepEqual(await order(), ["A", "B", "C"]);
    const kinds = (await db.pool.query("select kind, reason, created_by from override where target_id = $1 order by created_at", [c])).rows;
    assert.deepEqual(kinds.map((k) => k.kind), ["move_up", "move_up", "move_down", "move_down"]);
    assert.ok(kinds.every((k) => k.created_by === operator && k.reason === "unit"));
  });

  test("a held item moves among the queue it would be in, and takes its place once released", async () => {
    await item("A", "Queued", 1);
    await item("B", "Queued", 2);
    const c = await item("C", "Queued", 3, "held = true");
    await withTx(db.pool, (cl) => moveInQueue(cl, c, "up", { reason: "unit", createdBy: operator }));
    assert.deepEqual(await order(), ["A", "B"]);
    await db.pool.query("update item set held = false where id = $1", [c]);
    assert.deepEqual(await order(), ["A", "C", "B"]);
  });

  test("a move ends with its override, and the item goes back to its board place", async () => {
    await item("A", "Queued", 1);
    const b = await item("B", "Queued", 2);
    await withTx(db.pool, (cl) => moveInQueue(cl, b, "up", { reason: "unit", createdBy: operator }));
    assert.deepEqual(await order(), ["B", "A"]);
    await db.pool.query("update override set cleared_at = now()");
    assert.deepEqual(await order(), ["A", "B"]);
  });

  test("moving an item that isn't in the queue throws", async () => {
    const n = await item("N", "NotReady", 1);
    await assert.rejects(withTx(db.pool, (cl) => moveInQueue(cl, n, "up", { reason: "unit", createdBy: operator })), /isn't in the factory queue/);
  });
});
