import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type pg from "pg";
import { dbTest, startTestDb } from "./test-db.ts";

// Redesign §08, step 1 of §12: the additive schema. Nothing reads it yet.
describe("additive schema", dbTest, () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;

  before(async () => {
    db = await startTestDb();
  });
  after(async () => {
    await db.stop();
  });

  async function as<T>(role: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await db.pool.connect();
    try {
      await c.query("begin");
      await c.query(`set local role ${role}`);
      return await fn(c);
    } finally {
      await c.query("rollback");
      c.release();
    }
  }

  test("a user needs a provider or an issuer, and an issuer holds a subject once", async () => {
    await db.pool.query(`insert into "user" (issuer, subject, role) values ('https://id.test', 'u-1', 'viewer')`);
    await assert.rejects(db.pool.query(`insert into "user" (issuer, subject, role) values ('https://id.test', 'u-1', 'viewer')`), { code: "23505" });
    await assert.rejects(db.pool.query(`insert into "user" (subject, role) values ('u-2', 'viewer')`), { code: "23514" });
    await db.pool.query(`delete from "user" where subject = 'u-1'`);
  });

  test("the worker heartbeat holds one row at most", async () => {
    await db.pool.query("insert into worker_heartbeat (ticked_at) values (now())");
    await assert.rejects(db.pool.query("insert into worker_heartbeat (ticked_at) values (now())"), { code: "23505" });
    await db.pool.query("delete from worker_heartbeat");
  });

  test("factory_app can add an outbox row, which takes the outbox's sequence", async () => {
    const e = (await db.pool.query<{ id: string }>("insert into event (actor, actor_id, kind) values ('system', 't', 'probe') returning id")).rows[0].id;
    const seq = await as("factory_app", async (c) => (await c.query("insert into outbox (consumer, event_id) values ('mirror', $1) returning seq", [e])).rows[0].seq);
    assert.ok(seq != null);
  });

  test("factory_bff reaches session and nothing else, and factory_app doesn't reach session", async () => {
    await as("factory_bff", (c) =>
      c.query(
        `insert into session (cookie_hash, issuer, subject, refresh_token_encrypted, access_token, access_token_expires_at, expires_at)
         values ('h', 'https://id.test', 's', 'sealed', 'jwt', now(), now() + interval '30 days')`,
      ),
    );
    await assert.rejects(as("factory_bff", (c) => c.query(`select * from "user"`)), { code: "42501" });
    await assert.rejects(as("factory_bff", (c) => c.query("select * from outbox")), { code: "42501" });
    await assert.rejects(as("factory_app", (c) => c.query("select * from session")), { code: "42501" });
  });

  test("a run keeps its acceptance criteria", async () => {
    const s = (await db.pool.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'schema-test') returning id")).rows[0].id;
    const i = (await db.pool.query<{ id: string }>("insert into item (source_id, external_id, title, state) values ($1, '1', 't', 'Queued') returning id", [s])).rows[0].id;
    const r = (await db.pool.query<{ id: string }>("insert into run (item_id, acceptance_criteria) values ($1, $2) returning id", [i, ["a", "b"]])).rows[0].id;
    await as("factory_app", (c) => c.query("insert into run_file (run_id, sha, path, text) values ($1, 'abc', 'f.feature', 'Feature: f')", [r]));
    assert.deepEqual((await db.pool.query("select acceptance_criteria from run where id = $1", [r])).rows[0].acceptance_criteria, ["a", "b"]);
  });
});
