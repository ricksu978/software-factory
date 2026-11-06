import assert from "node:assert/strict";
import { test } from "node:test";
import type pg from "pg";
import { dbTest, startTestDb } from "./test-db.ts";

// Issue #88: pool.end() resolves once its idle clients are told to end, before their sockets close. A stop() that
// then shut Postgres down could kill a client mid-close, and its error surfaced as an uncaughtException in whatever
// suite was finishing. stop() has to wait until every client has really ended.
test("stop() waits until every client has disconnected before the database stops", dbTest, async () => {
  const db = await startTestDb();
  const opened: pg.Client[] = [];
  const ended = new Set<pg.Client>();
  db.pool.on("connect", (client) => {
    opened.push(client);
    client.on("end", () => ended.add(client));
  });
  // Several at once, so the pool opens several clients, as a busy suite does.
  await Promise.all(Array.from({ length: 5 }, () => db.pool.query("select pg_sleep(0.05)")));
  assert.ok(opened.length > 1, `expected several clients, got ${opened.length}`);
  let open = -1;
  await db.stop({
    beforeContainerStop: () => {
      open = opened.length - ended.size;
    },
  });
  assert.equal(open, 0, `${open} of ${opened.length} clients were still connected when the database began to stop`);
});
