import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { recordHeartbeat } from "./heartbeat.ts";
import { dbTest, startTestDb } from "./test-db.ts";

// Redesign §07 "Worker health", step 2c of §12 (PBI 158).
describe("the worker heartbeat", dbTest, () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  before(async () => {
    db = await startTestDb();
  });
  after(async () => {
    await db.stop();
  });
  const rows = async () => (await db.pool.query<{ ticked_at: Date }>("select ticked_at from worker_heartbeat")).rows.map((r) => r.ticked_at.getTime());

  test("records the tick's time on a fresh database, then replaces it, keeping one row", async () => {
    await db.pool.query("delete from worker_heartbeat");
    const first = new Date("2026-11-13T10:00:00.000Z");
    await recordHeartbeat(db.pool, first);
    assert.deepEqual(await rows(), [first.getTime()]);
    const later = new Date("2026-11-13T10:00:15.123Z");
    await recordHeartbeat(db.pool, later);
    assert.deepEqual(await rows(), [later.getTime()]);
  });
});
