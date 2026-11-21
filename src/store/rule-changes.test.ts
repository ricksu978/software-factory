import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { withTx } from "./db.ts";
import { APPROVAL_CRITERION, approveRuleChange, approvedRulesHash, latestApproval, ruleChangesRead, waitsForApproval } from "./rule-changes.ts";
import { ruleChangesHash } from "../gate/rule-changes.ts";
import { dbTest, startTestDb } from "./test-db.ts";

describe("an owner's approval of an item's rule changes (PBI 395)", dbTest, () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  const change = { place: { kind: "spec", section: "§6" }, before: "A.", after: "B.", problem: undefined };
  const item = async (state: string, results: [string, string][], changes: unknown = [change]) => {
    const s = (await db.pool.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', gen_random_uuid()::text) returning id")).rows[0].id;
    const id = (await db.pool.query<{ id: string }>("insert into item (source_id, external_id, title, state, rule_changes) values ($1, '1', 't', $2, $3) returning id",
      [s, state, changes === null ? null : JSON.stringify(changes)])).rows[0].id;
    for (const [i, [criterion, status]] of results.entries()) {
      await db.pool.query("insert into policy_result (item_id, file, source, criterion_index, criterion, status, reason) values ($1, 'dor', 'repo', $2, $3, $4, 'r')", [id, i, criterion, status]);
    }
    return id;
  };
  const owner = async () => (await db.pool.query<{ id: string }>(`insert into "user" (provider, subject, github_login, role) values ('dev', gen_random_uuid()::text, 'olive-' || gen_random_uuid()::text, 'owner') returning id`)).rows[0].id;

  before(async () => {
    db = await startTestDb();
  });
  after(async () => {
    await db.stop();
  });

  test("an item that read no section has read nothing, and one never read reads as null", async () => {
    assert.deepEqual(await ruleChangesRead(db.pool, await item("Eligible", [], [])), []);
    assert.equal(await ruleChangesRead(db.pool, await item("Eligible", [], null)), null);
  });

  test("a waiting item is approved: the approval is logged with who and when, and the item moves to Eligible", async () => {
    const id = await item("NotReady", [["one", "passed"], [APPROVAL_CRITERION, "failed"]]);
    assert.equal(await waitsForApproval(db.pool, id), true);
    const user = await owner();
    const at = new Date("2026-11-21T10:00:00Z");
    assert.equal(await withTx(db.pool, (c) => approveRuleChange(c, { itemId: id, userId: user, at })), "approved");
    assert.equal((await db.pool.query("select state from item where id = $1", [id])).rows[0].state, "Eligible");
    const plain = [{ place: change.place, before: change.before, after: change.after }];
    assert.equal(await approvedRulesHash(db.pool, id), ruleChangesHash(plain as never));
    const a = await latestApproval(db.pool, id);
    assert.equal(a?.at.toISOString(), at.toISOString());
    assert.match(a?.by ?? "", /^olive-/);
    const moved = (await db.pool.query("select actor, actor_id from event where item_id = $1 and kind = 'transition' and payload->>'event' = 'rule_change_approved'", [id])).rows;
    assert.deepEqual(moved, [{ actor: "human", actor_id: user }]);
  });

  test("an item that doesn't wait for the approval isn't approved and nothing is logged", async () => {
    const user = await owner();
    const at = new Date();
    for (const id of [await item("NotReady", [["one", "failed"]]), await item("Queued", [[APPROVAL_CRITERION, "failed"]]), await item("NotReady", [[APPROVAL_CRITERION, "failed"]], [])]) {
      assert.equal(await withTx(db.pool, (c) => approveRuleChange(c, { itemId: id, userId: user, at })), "not_waiting");
      assert.equal(await latestApproval(db.pool, id), null);
    }
    assert.equal(await withTx(db.pool, (c) => approveRuleChange(c, { itemId: "00000000-0000-0000-0000-000000000000", userId: user, at })), "unknown");
  });
});
