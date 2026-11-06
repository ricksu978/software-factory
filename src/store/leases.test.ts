import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { withTx } from "./db.ts";
import { claimNext, expireLeases, LEASE_EXPIRY_MS, releaseLease, renewLease } from "./items.ts";
import { dbTest, startTestDb } from "./test-db.ts";

const t0 = new Date("2026-11-06T10:00:00Z");

describe("leases", dbTest, () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let source: string;

  before(async () => {
    db = await startTestDb();
  });
  after(async () => {
    await db?.stop();
  });
  // claimNext and expireLeases look at every item, so each test starts with none.
  beforeEach(async () => {
    await db.pool.query("truncate item, backlog_source cascade");
    source = (await db.pool.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'unit') returning id")).rows[0].id;
  });

  async function item(state: string, set = ""): Promise<string> {
    const r = await db.pool.query<{ id: string }>(
      "insert into item (source_id, external_id, title, state) values ($1, gen_random_uuid()::text, 't', $2) returning id",
      [source, state],
    );
    if (set) await db.pool.query(`update item set ${set} where id = $1`, [r.rows[0].id]);
    return r.rows[0].id;
  }
  const question = (itemId: string, kind: string, answered: boolean) =>
    db.pool.query("insert into question (item_id, kind, body, answer) values ($1, $2, 'q', $3)", [itemId, kind, answered ? "a" : null]);
  const claim = (owner = "cell-a", now = t0) => withTx(db.pool, (c) => claimNext(c, owner, now));
  const row = async (id: string) =>
    (await db.pool.query("select state, lease_generation, lease_owner, lease_expires from item where id = $1", [id])).rows[0];

  test("an answered SignOff or NeedsInput item comes before any Queued item", async () => {
    await item("Queued", "priority = 9");
    const signOff = await item("SignOff");
    await question(signOff, "sign_off", true);
    assert.equal((await claim())?.itemId, signOff);
  });

  test("an unanswered NeedsInput item, or one with a newer open question, is skipped", async () => {
    const unanswered = await item("NeedsInput");
    await question(unanswered, "needs_input", false);
    const reasked = await item("NeedsInput");
    await question(reasked, "needs_input", true);
    await question(reasked, "needs_input", false);
    const queued = await item("Queued");
    assert.equal((await claim())?.itemId, queued);
  });

  test("Queued items go by highest priority, then lowest backlog rank", async () => {
    await item("Queued", "priority = 0, backlog_rank = 1");
    await item("Queued", "priority = 1, backlog_rank = 10");
    const first = await item("Queued", "priority = 1, backlog_rank = 2");
    assert.equal((await claim())?.itemId, first);
  });

  test("held items and items with an open dependency are skipped", async () => {
    await item("Queued", "held = true, priority = 2");
    await item("Queued", "blocked_by = '{12}', priority = 1");
    const free = await item("Queued");
    assert.equal((await claim())?.itemId, free);
    assert.equal(await claim(), null);
  });

  test("a claim with no open run starts run 1 at understand, and the next one after it ends starts run 2", async () => {
    const id = await item("Queued");
    const first = await claim();
    const runs = async () => (await db.pool.query("select id, run_number, next_stage from run where item_id = $1 order by run_number", [id])).rows;
    assert.deepEqual(await runs(), [{ id: first?.runId, run_number: 1, next_stage: "understand" }]);
    await db.pool.query("update run set ended_at = now() where item_id = $1", [id]);
    await db.pool.query("update item set state = 'Queued' where id = $1", [id]);
    const second = await claim();
    assert.equal((await runs())[1].id, second?.runId);
    assert.equal((await runs())[1].run_number, 2);
  });

  test("a claim reuses the open run, and one that starts an address run sets reviews_seen_at to the claim's time", async () => {
    const id = await item("Queued");
    const run = (await db.pool.query<{ id: string }>("insert into run (item_id, next_stage) values ($1, 'address') returning id", [id])).rows[0].id;
    assert.equal((await claim())?.runId, run);
    const r = (await db.pool.query("select next_stage, reviews_seen_at from run where id = $1", [run])).rows[0];
    assert.equal(r.next_stage, "address");
    assert.equal(r.reviews_seen_at.toISOString(), t0.toISOString());
  });

  test("a claim that doesn't start an address run leaves reviews_seen_at alone", async () => {
    const id = await item("Queued");
    await db.pool.query("insert into run (item_id, next_stage) values ($1, 'green')", [id]);
    await claim();
    assert.equal((await db.pool.query("select reviews_seen_at from run where item_id = $1", [id])).rows[0].reviews_seen_at, null);
  });

  test("renewLease checks the generation and the state", async () => {
    const id = await item("InProgress", "lease_generation = 3, lease_owner = 'cell-a'");
    const renew = (gen: number) => withTx(db.pool, (c) => renewLease(c, id, gen, t0));
    assert.equal(await renew(3), "ok");
    assert.equal((await row(id)).lease_expires.getTime(), t0.getTime() + LEASE_EXPIRY_MS);
    assert.equal(await renew(2), "lost");
    await db.pool.query("update item set state = 'SignOff' where id = $1", [id]);
    assert.equal(await renew(3), "lost");
  });

  test("expireLeases returns every expired InProgress item and nothing else", async () => {
    const a = await item("InProgress", `lease_generation = 1, lease_owner = 'a', lease_expires = '2026-11-06T09:00:00Z'`);
    const b = await item("InProgress", `lease_generation = 1, lease_owner = 'b', lease_expires = '2026-11-06T09:30:00Z'`);
    await item("InProgress", `lease_generation = 1, lease_owner = 'c', lease_expires = '2026-11-06T11:00:00Z'`);
    assert.deepEqual(await withTx(db.pool, (c) => expireLeases(c, t0)), [a, b]);
    assert.equal((await row(a)).state, "Queued");
    assert.equal((await row(b)).lease_generation, 2);
  });

  test("releaseLease clears the lease for the current generation only, and keeps the generation", async () => {
    const id = await item("InProgress", "lease_generation = 5, lease_owner = 'cell-a', lease_expires = now()");
    await withTx(db.pool, (c) => releaseLease(c, id, 4));
    assert.equal((await row(id)).lease_owner, "cell-a");
    await withTx(db.pool, (c) => releaseLease(c, id, 5));
    const r = await row(id);
    assert.equal(r.lease_owner, null);
    assert.equal(r.lease_expires, null);
    assert.equal(r.lease_generation, 5);
  });
});
