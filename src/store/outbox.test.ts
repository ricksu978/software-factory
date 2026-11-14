import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { decide } from "../control/decisions.ts";
import { withTx } from "./db.ts";
import { appendEvent } from "./events.ts";
import { overrideItem, transitionItem, upsertItem } from "./items.ts";
import { CONSUMER, writeOutboxRows } from "./outbox.ts";
import { dbTest, startTestDb } from "./test-db.ts";

const system = { actor: "system" as const, actorId: "test" };

describe("outbox", dbTest, () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let source: string;

  before(async () => {
    db = await startTestDb();
    source = (await db.pool.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'outbox') returning id")).rows[0].id;
  });
  after(async () => {
    await db?.stop();
  });

  async function item(state: string): Promise<string> {
    const id = await upsertItem(db.pool, { sourceId: source, externalId: crypto.randomUUID(), title: "t" });
    await db.pool.query("update item set state = $2 where id = $1", [id, state]);
    return id;
  }
  const rows = async (itemId: string): Promise<{ consumer: string; kind: string; attempts: number; failed_at: Date | null }[]> =>
    (await db.pool.query("select o.consumer, e.kind, o.attempts, o.failed_at from outbox o join event e on e.id = o.event_id where o.item_id = $1 order by o.seq", [itemId])).rows;

  test("appendEvent returns the id of the event it wrote", async () => {
    const id = await withTx(db.pool, (c) => appendEvent(c, { ...system, itemId: null, kind: "outbox-probe", payload: {} }));
    assert.equal((await db.pool.query("select kind from event where id = $1", [id])).rows[0]?.kind, "outbox-probe");
  });

  test("writeOutboxRows writes one pending row per item, and none for no items", async () => {
    const [a, b] = [await item("Queued"), await item("Queued")];
    await withTx(db.pool, async (c) => {
      const eventId = await appendEvent(c, { ...system, itemId: null, kind: "outbox-probe", payload: {} });
      await writeOutboxRows(c, CONSUMER.commentCommands, eventId, [a, b]);
      await writeOutboxRows(c, CONSUMER.commentCommands, eventId, []);
    });
    for (const id of [a, b]) assert.deepEqual(await rows(id), [{ consumer: CONSUMER.commentCommands, kind: "outbox-probe", attempts: 0, failed_at: null }]);
  });

  test("a transition and an override each write a board mirror row for their event", async () => {
    const id = await item("Queued");
    await withTx(db.pool, async (c) => {
      await transitionItem(c, id, "claimed", system);
      await overrideItem(c, id, "Failed", system, "stuck");
    });
    assert.deepEqual((await rows(id)).map((r) => [r.consumer, r.kind]), [[CONSUMER.boardMirror, "transition"], [CONSUMER.boardMirror, "override"]]);
  });

  test("a rolled-back transition leaves no row", async () => {
    const id = await item("Queued");
    await assert.rejects(withTx(db.pool, async (c) => {
      await transitionItem(c, id, "claimed", system);
      throw new Error("fails");
    }));
    assert.deepEqual(await rows(id), []);
  });

  test("an applied decision writes a decision announcement row, and a refused one writes none", async () => {
    const id = await item("SignOff");
    await db.pool.query("insert into run (item_id, next_stage) values ($1, 'specify')", [id]);
    await db.pool.query("insert into question (item_id, kind, body) values ($1, 'sign_off', 'Sign off?')", [id]);
    const user = async (po: boolean) => (await db.pool.query<{ id: string }>(
      `insert into "user" (provider, subject, github_login, role, product_owner) values ('dev', $1, $1, 'viewer', $2) returning id`, [crypto.randomUUID(), po],
    )).rows[0].id;
    assert.equal(await withTx(db.pool, async (c) => decide(c, { itemId: id, userId: await user(false), kind: "approve", text: "", via: "dashboard" })), "forbidden");
    assert.deepEqual(await rows(id), []);
    assert.equal(await withTx(db.pool, async (c) => decide(c, { itemId: id, userId: await user(true), kind: "approve", text: "", via: "dashboard" })), "applied");
    assert.deepEqual((await rows(id)).map((r) => [r.consumer, r.kind]), [[CONSUMER.decisionAnnouncement, "decision"]]);
  });
});
