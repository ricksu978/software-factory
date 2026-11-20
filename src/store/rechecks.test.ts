import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { failedOnMain } from "./rechecks.ts";
import { dbTest, startTestDb } from "./test-db.ts";

describe("Failed items the factory re-checks (PBI 369)", dbTest, () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  const at = (t: string) => new Date(`2026-11-20T${t}:00Z`);
  const item = async (n: string, state: string, moves: [string, string, string][], rechecks: string[] = []) => {
    const s = (await db.pool.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', gen_random_uuid()::text) returning id")).rows[0].id;
    const id = (await db.pool.query<{ id: string }>("insert into item (source_id, external_id, title, state) values ($1, $2, 't', $3) returning id", [s, n, state])).rows[0].id;
    for (const [t, to, event] of moves) {
      await db.pool.query("insert into event (at, actor, actor_id, item_id, kind, payload) values ($1, 'system', 't', $2, 'transition', $3)", [at(t), id, JSON.stringify({ to, event })]);
    }
    for (const t of rechecks) await db.pool.query("insert into event (at, actor, actor_id, item_id, kind, payload) values ($1, 'system', 't', $2, 'recheck', '{}')", [at(t), id]);
    return id;
  };

  before(async () => {
    db = await startTestDb();
  });
  after(async () => {
    await db.stop();
  });

  test("only an item whose last move to Failed was dod_failed is listed, with its newest re-check since that move", async () => {
    const charged = await item("1", "Failed", [["08:00", "Failed", "dod_failed"]], ["10:00", "12:00"]);
    const fresh = await item("2", "Failed", [["08:00", "Failed", "dod_failed"]]);
    await item("3", "Failed", [["08:00", "Failed", "retries_exhausted"]]);
    // Failed on main, re-checked back to Accepted, then failed on main again: the earlier re-check doesn't count.
    const again = await item("4", "Failed", [["06:00", "Failed", "dod_failed"], ["07:00", "Accepted", "rechecked"], ["09:00", "Failed", "dod_failed"]], ["07:00"]);
    await item("5", "Accepted", [["08:00", "Failed", "dod_failed"], ["09:00", "Accepted", "rechecked"]]);
    const rows = await failedOnMain(db.pool);
    assert.deepEqual(rows.map((r) => [r.id, r.rechecked?.toISOString() ?? null]).sort(), [
      [charged, at("12:00").toISOString()], [fresh, null], [again, null],
    ].sort());
    assert.deepEqual((await failedOnMain(db.pool, fresh)).map((r) => r.id), [fresh]);
  });
});
