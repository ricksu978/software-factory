import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { dbTest, startTestDb } from "../store/test-db.ts";
import { pgSessions, type SessionStore } from "./session.ts";

describe("sessions in Postgres", dbTest, () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let store: SessionStore;
  before(async () => {
    db = await startTestDb();
    store = pgSessions(db.pool);
  });
  after(async () => db?.stop());
  beforeEach(async () => {
    await db.pool.query("truncate session");
    await store.create({
      cookieHash: "h", issuer: "https://idp", subject: "alice", accessToken: "at-1", accessTokenExpiresAt: new Date(Date.now() + 300_000),
      refreshTokenEncrypted: "sealed-1", expiresAt: new Date(Date.now() + 30 * 86400_000),
    });
  });

  test("find answers the session's tokens and marks it seen", async () => {
    await db.pool.query("update session set last_seen_at = now() - interval '6 days'");
    const s = await store.find("h");
    assert.equal(s?.subject, "alice");
    assert.equal(s?.accessToken, "at-1");
    assert.equal(s?.refreshTokenEncrypted, "sealed-1");
    assert.ok(s!.accessTokenExpiresAt instanceof Date);
    const r = await db.pool.query("select last_seen_at > now() - interval '1 minute' as fresh from session");
    assert.equal(r.rows[0].fresh, true);
  });

  test("a session idle for more than seven days, or past its end, counts as none", async () => {
    await db.pool.query("update session set last_seen_at = now() - interval '8 days'");
    assert.equal(await store.find("h"), null);
    await db.pool.query("update session set last_seen_at = now(), expires_at = now() - interval '1 second'");
    assert.equal(await store.find("h"), null);
    assert.equal(await store.find("other"), null);
  });

  test("updateTokens replaces the access token, its expiry and the sealed refresh token", async () => {
    const at = new Date(Date.now() + 600_000);
    await store.updateTokens("h", { accessToken: "at-2", accessTokenExpiresAt: at, refreshTokenEncrypted: "sealed-2" });
    const s = await store.find("h");
    assert.equal(s?.accessToken, "at-2");
    assert.equal(s?.accessTokenExpiresAt.getTime(), at.getTime());
    assert.equal(s?.refreshTokenEncrypted, "sealed-2");
  });
});
