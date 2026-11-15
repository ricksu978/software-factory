import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startTestDb } from "../store/test-db.ts";
import { BFF_DB_ROLE, rolePool } from "./session.ts";

let db: Awaited<ReturnType<typeof startTestDb>>;
before(async () => {
  db = await startTestDb();
});
after(async () => db.stop());

test("every connection from the BFF's pool works as factory_bff", async () => {
  const pool = rolePool(db.url);
  try {
    const r = await pool.query<{ current_user: string }>("select current_user");
    assert.equal(r.rows[0].current_user, BFF_DB_ROLE);
  } finally {
    await pool.end();
  }
});

test("a connection that can't switch role is closed and its query fails, so nothing runs as the login", async () => {
  const pool = rolePool(db.url, "no_such_role");
  try {
    await assert.rejects(pool.query("select current_user"), /couldn't work as no_such_role/);
    await assert.rejects(pool.query("select current_user"), /couldn't work as no_such_role/);
    assert.equal(pool.totalCount, 0);
  } finally {
    await pool.end();
  }
});
