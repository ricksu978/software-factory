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

  test("an empty secret refuses even a body signed with the empty key", () => {
    assert.equal(verifySignature("", body, `sha256=${createHmac("sha256", "").update(body).digest("hex")}`), false);
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

  test("a new comment delivery reaches onComment once, after it's stored, and a redelivery doesn't", async () => {
    const seen: string[] = [];
    const commentDeps = {
      pool: db.pool, secret,
      parse: () => ({ kind: "comment" as const, externalId: "11", repo: "o/r", login: "octo", body: "/approve", commentId: "c42" }),
      onComment: async (e: { commentId: string }) => {
        seen.push(`${e.commentId}:${(await count("d-comment")).events.length}`);
      },
    };
    assert.equal((await handleWebhook(commentDeps, { headers: headers("d-comment", sign("sha256", body)), rawBody: body })).status, 204);
    assert.equal((await handleWebhook(commentDeps, { headers: headers("d-comment", sign("sha256", body)), rawBody: body })).status, 200);
    // onComment runs after the 204, so it can't hold up GitHub. Wait for it.
    for (let i = 0; i < 50 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(seen, ["c42:1"]);
  });

  test("a failing onComment never turns the delivery into an error", async () => {
    const failing = {
      pool: db.pool, secret,
      parse: () => ({ kind: "comment" as const, externalId: "11", repo: "o/r", login: "octo", body: "/approve", commentId: "c43" }),
      onComment: async () => {
        throw new Error("GitHub 502");
      },
    };
    assert.equal((await handleWebhook(failing, { headers: headers("d-comment-2", sign("sha256", body)), rawBody: body })).status, 204);
    assert.equal((await count("d-comment-2")).events.length, 1);
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

  describe("PR events (plan Task 17)", () => {
    let n = 0;
    /** An InReview item whose open run holds PR 7 in o/r, with reviews counted from `seen`. */
    async function inReview(seen: string | null) {
      await db.pool.query(`insert into repo (host_adapter, url) values ('github', 'https://github.com/o/r') on conflict (url) do nothing`);
      await db.pool.query(`insert into "user" (provider, subject, github_login, role) values ('dev', 'rev', 'Reviewer', 'owner') on conflict do nothing`);
      const source = (await db.pool.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'test:' || gen_random_uuid()) returning id")).rows[0].id;
      const item = (await db.pool.query<{ id: string }>("insert into item (source_id, external_id, title, state) values ($1, gen_random_uuid()::text, 't', 'InReview') returning id", [source])).rows[0].id;
      // PR numbers are per repo, so each item gets its own.
      const pr = 100 + ++n;
      await db.pool.query("insert into run (item_id, repo_id, pr_number, reviews_seen_at) values ($1, (select id from repo where url = 'https://github.com/o/r'), $2, $3)", [item, pr, seen]);
      return { item, pr };
    }
    const send = (event: object) => handleWebhook({ pool: db.pool, secret, parse: () => event as never }, { headers: headers(`d-${++n}`, sign("sha256", body)), rawBody: body });
    const state = async (id: string) => (await db.pool.query("select state from item where id = $1", [id])).rows[0].state;
    const review = (pr: number, author: string, submittedAt: string) => ({ kind: "review", prNumber: pr, repo: "o/r", state: "changes_requested", submittedAt, author });

    test("a merge moves InReview to Accepted and records merge_sha", async () => {
      const { item, pr } = await inReview(null);
      await send({ kind: "pr_merged", prNumber: pr, repo: "O/R", mergeSha: "abc1234" });
      assert.equal(await state(item), "Accepted");
      assert.equal((await db.pool.query("select merge_sha from run where item_id = $1", [item])).rows[0].merge_sha, "abc1234");
    });

    test("a person closing the PR unmerged withdraws the item", async () => {
      const { item, pr } = await inReview(null);
      await send({ kind: "pr_closed", prNumber: pr, repo: "o/r" });
      assert.equal(await state(item), "Abandoned");
    });

    test("only an allowlisted reviewer's review newer than reviews_seen_at sends the item to address", async () => {
      const { item, pr } = await inReview("2026-11-06T10:00:00Z");
      await send(review(pr, "stranger", "2026-11-06T11:00:00Z"));
      await send(review(pr, "reviewer", "2026-11-06T09:00:00Z"));
      assert.equal(await state(item), "InReview");
      await send(review(pr, "reviewer", "2026-11-06T11:00:00Z"));
      assert.equal(await state(item), "Queued");
      assert.equal((await db.pool.query("select next_stage from run where item_id = $1", [item])).rows[0].next_stage, "address");
    });

    test("a PR no open run holds changes nothing", async () => {
      const { item } = await inReview(null);
      await send({ kind: "pr_merged", prNumber: 999, repo: "o/r", mergeSha: "abc1234" });
      assert.equal(await state(item), "InReview");
    });
  });
});
