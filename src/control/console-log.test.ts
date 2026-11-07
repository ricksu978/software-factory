import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { withTx } from "../store/db.ts";
import { overrideItem, transitionItem } from "../store/items.ts";
import { dbTest, startTestDb } from "../store/test-db.ts";
import { logTransitions, transitionLine } from "./console-log.ts";

describe("transitionLine", () => {
  test("names the item, its states and the event", () => {
    assert.equal(transitionLine("95", "Eligible", "NotReady", "readiness_failed"), "item 95: Eligible -> NotReady (readiness_failed)");
  });
});

describe("logTransitions", dbTest, () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let sourceId: string;
  const system = { actor: "system" as const, actorId: "unit" };

  before(async () => {
    db = await startTestDb();
  });
  after(async () => {
    await db?.stop();
  });
  beforeEach(async () => {
    await db.pool.query("truncate item, backlog_source cascade");
    sourceId = (await db.pool.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'unit') returning id")).rows[0].id;
  });

  const item = async (ext: string, state: string) =>
    (await db.pool.query<{ id: string }>("insert into item (source_id, external_id, title, state) values ($1, $2, 't', $3) returning id", [sourceId, ext, state])).rows[0].id;

  test("logs each committed transition and override once, nothing for a rollback, and nothing once stopped", async () => {
    const lines: string[] = [];
    const stop = logTransitions({ pool: db.pool, log: (l) => lines.push(l) });
    const a = await item("95", "Queued");
    await withTx(db.pool, (c) => transitionItem(c, a, "claimed", system));
    await withTx(db.pool, (c) => overrideItem(c, a, "Failed", system, "stopped"));
    const b = await item("96", "Queued");
    await assert.rejects(withTx(db.pool, async (c) => {
      await transitionItem(c, b, "claimed", system);
      throw new Error("boom");
    }));
    stop();
    await withTx(db.pool, (c) => transitionItem(c, b, "claimed", system));
    assert.deepEqual(lines, ["item 95: Queued -> InProgress (claimed)", "item 95: InProgress -> Failed (override)"]);
  });
});
