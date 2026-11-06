import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { dbTest, startTestDb } from "../store/test-db.ts";
import { handleWebhook, verifySignature } from "./webhook.ts";

const secret = "s3cret";
const body = Buffer.from(JSON.stringify({ action: "created" }));
const sign = (alg: string, b: Buffer) => `${alg}=${createHmac(alg, secret).update(b).digest("hex")}`;

describe("verifySignature", () => {
  test("accepts sha256= plus the HMAC-SHA256 hex digest of the body", () => {
    assert.equal(verifySignature(secret, body, sign("sha256", body)), true);
  });

  test("refuses a one-character change, a missing header and a sha1= header", () => {
    const changed = Buffer.from(body.toString().replace("created", "createe"));
    assert.equal(verifySignature(secret, changed, sign("sha256", body)), false);
    assert.equal(verifySignature(secret, body, undefined), false);
    assert.equal(verifySignature(secret, body, sign("sha1", body)), false);
    assert.equal(verifySignature(secret, body, "sha256=short"), false);
  });
});

describe("handleWebhook", dbTest, () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  before(async () => {
    db = await startTestDb();
  });
  after(async () => {
    await db.stop();
  });

  const deps = () => ({ pool: db.pool, secret, parse: () => ({ kind: "item_changed" as const, externalId: "11" }) });
  const headers = (id: string, signature?: string) => ({ "x-github-delivery": id, "x-github-event": "issues", ...(signature ? { "x-hub-signature-256": signature } : {}) });
  const count = async (id: string) => ({
    deliveries: (await db.pool.query("select 1 from webhook_delivery where id = $1", [id])).rowCount,
    events: (await db.pool.query("select payload from event where payload->>'deliveryId' = $1", [id])).rows,
  });

  test("the same delivery id twice stores one row and one event, and the second call returns 200", async () => {
    assert.deepEqual(await handleWebhook(deps(), { headers: headers("d-1", sign("sha256", body)), rawBody: body }), { status: 204 });
    assert.deepEqual(await handleWebhook(deps(), { headers: headers("d-1", sign("sha256", body)), rawBody: body }), { status: 200 });
    const c = await count("d-1");
    assert.equal(c.deliveries, 1);
    assert.deepEqual(c.events.map((r) => r.payload), [{ deliveryId: "d-1", githubEvent: "issues", event: { kind: "item_changed", externalId: "11" } }]);
  });

  test("a bad signature returns 401 and writes nothing", async () => {
    assert.deepEqual(await handleWebhook(deps(), { headers: headers("d-2", sign("sha1", body)), rawBody: body }), { status: 401 });
    assert.deepEqual(await count("d-2"), { deliveries: 0, events: [] });
  });

  test("a signed body that isn't JSON returns 400 and writes nothing", async () => {
    const junk = Buffer.from("not json");
    assert.deepEqual(await handleWebhook(deps(), { headers: headers("d-3", sign("sha256", junk)), rawBody: junk }), { status: 400 });
    assert.deepEqual(await count("d-3"), { deliveries: 0, events: [] });
  });
});
