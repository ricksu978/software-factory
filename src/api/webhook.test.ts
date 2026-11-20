import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { CONSUMER } from "../store/outbox.ts";
import { dbTest, startTestDb } from "../store/test-db.ts";
import { webhookIntake } from "./webhook.ts";

const secret = "s3cret";
const sign = (b: Buffer, key = secret) => `sha256=${createHmac("sha256", key).update(b).digest("hex")}`;
const comment = (issue: number, text: string) => Buffer.from(JSON.stringify({
  action: "created", repository: { full_name: "o/r" }, issue: { number: issue },
  comment: { id: 9, body: text, user: { login: "olive", type: "User" } }, sender: { login: "olive", type: "User" },
}));
const headers = (id: string, b: Buffer, key = secret) => ({ "x-github-delivery": id, "x-github-event": "issue_comment", "x-hub-signature-256": sign(b, key) });

describe("webhookIntake", dbTest, () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  before(async () => {
    db = await startTestDb();
  });
  after(async () => {
    await db.stop();
  });

  test("records a signed comment as one parsed webhook event with an outbox row per item it names, once per delivery id", async () => {
    const source = (await db.pool.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'api-webhook-test') returning id")).rows[0].id;
    const item = (await db.pool.query<{ id: string }>(
      "insert into item (source_id, external_id, title, state) values ($1, '4287', 't', 'InProgress') returning id", [source])).rows[0].id;
    const b = comment(4287, "/approve");
    assert.equal((await webhookIntake({ pool: db.pool, secret }, { headers: headers("api-d-1", b, "wrong"), rawBody: b })).status, 401);
    assert.equal((await webhookIntake({ pool: db.pool, secret }, { headers: headers("api-d-1", b), rawBody: b })).status, 204);
    assert.equal((await webhookIntake({ pool: db.pool, secret }, { headers: headers("api-d-1", b), rawBody: b })).status, 200);

    const events = (await db.pool.query<{ id: string; payload: { githubEvent: string; event: Record<string, unknown> } }>(
      "select id, payload from event where kind = 'webhook' and payload->>'deliveryId' = 'api-d-1'")).rows;
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.githubEvent, "issue_comment");
    assert.deepEqual([events[0].payload.event.kind, events[0].payload.event.externalId, events[0].payload.event.body], ["comment", "4287", "/approve"]);
    const rows = (await db.pool.query("select event_id, item_id from outbox where consumer = $1 and item_id = $2", [CONSUMER.commentCommands, item])).rows;
    assert.deepEqual(rows, [{ event_id: events[0].id, item_id: item }]);
  });
});
