import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { withTx } from "./db.ts";
import { acceptRewrite, keepRewrite, markRechecked, proposedRewrites, rechecksOwed, REWRITE_WITHDRAWN, rewriteAsked, withdrawRewrites } from "./rewrites.ts";
import { approvedRulesHash } from "./rule-changes.ts";
import { parseRuleChanges, ruleChangesHash } from "../gate/rule-changes.ts";
import { dbTest, startTestDb } from "./test-db.ts";

describe("the rewrites proposed for an item a person wrote (PBI 439)", dbTest, () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  const item = async () => {
    const s = (await db.pool.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', gen_random_uuid()::text) returning id")).rows[0].id;
    return (await db.pool.query<{ id: string }>("insert into item (source_id, external_id, title, state) values ($1, '1', 't', 'NotReady') returning id", [s])).rows[0].id;
  };
  const owner = async () => (await db.pool.query<{ id: string }>(`insert into "user" (provider, subject, github_login, role) values ('dev', gen_random_uuid()::text, 'olive-' || gen_random_uuid()::text, 'owner') returning id`)).rows[0].id;
  const at = new Date("2026-11-27T10:00:00Z");
  const rules = (after: string) => `\n\n## Changes the factory's rules\n\n### Spec §6\n\n**Before**\n> A lease lasts ten minutes.\n\n**After**\n> ${after}\n`;

  before(async () => {
    db = await startTestDb();
  });
  after(async () => {
    await db.stop();
  });

  test("one proposal per text: a second keep for the same text changes nothing, and what was asked reads back", async () => {
    const id = await item();
    assert.equal(await rewriteAsked(db.pool, id, "h1", "old"), null);
    await keepRewrite(db.pool, { itemId: id, textHash: "h1", body: "new", current: "old" });
    await keepRewrite(db.pool, { itemId: id, textHash: "h1", body: "other", current: "old" });
    assert.deepEqual((await proposedRewrites(db.pool, id)).map((p) => [p.body, p.current]), [["new", "old"]]);
    assert.equal(await rewriteAsked(db.pool, id, "h1", "old"), "standing");
    await keepRewrite(db.pool, { itemId: id, textHash: "h2", body: null, current: "older" });
    assert.equal(await rewriteAsked(db.pool, id, "h2", "older"), "spent");
    assert.equal((await proposedRewrites(db.pool, id)).length, 1, "a reply with no body is no proposal");
  });

  test("an edit withdraws each proposal for another text and logs why; an acceptance of it is refused", async () => {
    const id = await item();
    await keepRewrite(db.pool, { itemId: id, textHash: "h1", body: "new", current: "old" });
    const [p] = await proposedRewrites(db.pool, id);
    assert.equal(await withTx(db.pool, (c) => withdrawRewrites(c, id, "h1")), 0);
    assert.equal(await withTx(db.pool, (c) => withdrawRewrites(c, id, "h2")), 1);
    assert.deepEqual(await proposedRewrites(db.pool, id), []);
    const ev = await db.pool.query("select payload from event where item_id = $1 and kind = $2", [id, REWRITE_WITHDRAWN]);
    assert.deepEqual(ev.rows.map((r) => r.payload.cause), ["item_edited"]);
    const user = await owner();
    assert.equal((await withTx(db.pool, (c) => acceptRewrite(c, { itemId: id, rewriteId: p.id, userId: user, at, issueBody: "old" }))).outcome, "withdrawn");
  });

  test("an item that left NotReady takes no rewrite", async () => {
    const id = await item();
    await keepRewrite(db.pool, { itemId: id, textHash: "h1", body: "new", current: "old" });
    await db.pool.query("update item set state = 'Abandoned' where id = $1", [id]);
    const [p] = await proposedRewrites(db.pool, id);
    const out = await withTx(db.pool, async (c) => acceptRewrite(c, { itemId: id, rewriteId: p.id, userId: await owner(), at, issueBody: "old" }));
    assert.equal(out.outcome, "not_waiting");
  });

  test("an acceptance of a body that changed since is refused and withdraws the proposal", async () => {
    const id = await item();
    await keepRewrite(db.pool, { itemId: id, textHash: "h1", body: "new", current: "old" });
    const [p] = await proposedRewrites(db.pool, id);
    const out = await withTx(db.pool, async (c) => acceptRewrite(c, { itemId: id, rewriteId: p.id, userId: await owner(), at, issueBody: "edited" }));
    assert.equal(out.outcome, "edited");
    assert.deepEqual(await proposedRewrites(db.pool, id), []);
  });

  test("accepting takes the proposal off, owes a recheck, and approves a rules section it adds or changes", async () => {
    for (const [current, body, approves] of [
      ["Old.", `New.${rules("Five minutes.")}`, true],
      [`Old.${rules("Five minutes.")}`, `New.${rules("Six minutes.")}`, true],
      [`Old.${rules("Five minutes.")}`, `New.${rules("Five minutes.")}`, false],
      ["Old.", "New.", false],
    ] as const) {
      const id = await item();
      await keepRewrite(db.pool, { itemId: id, textHash: "h1", body, current });
      const [p] = await proposedRewrites(db.pool, id);
      const out = await withTx(db.pool, async (c) => acceptRewrite(c, { itemId: id, rewriteId: p.id, userId: await owner(), at, issueBody: current }));
      assert.equal(out.outcome, "accepted");
      assert.deepEqual(await proposedRewrites(db.pool, id), []);
      assert.equal(await approvedRulesHash(db.pool, id), approves ? ruleChangesHash(parseRuleChanges(body)) : null, body);
      assert.equal(await rewriteAsked(db.pool, id, "h-new", body), "spent", "a text the owner accepted is never rewritten again");
      const second = await withTx(db.pool, async (c) => acceptRewrite(c, { itemId: id, rewriteId: p.id, userId: await owner(), at, issueBody: current }));
      assert.equal(second.outcome, "accepted_already");
    }
    const owed = [...(await rechecksOwed(db.pool)).values()].flat();
    assert.ok(owed.length >= 4);
    await markRechecked(db.pool, owed);
    assert.equal((await rechecksOwed(db.pool)).size, 0);
  });
});
