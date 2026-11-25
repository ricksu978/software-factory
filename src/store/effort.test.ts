import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { currentEffort, isEffort, withEffort } from "./effort.ts";
import { dbTest, startTestDb } from "./test-db.ts";

describe("isEffort", () => {
  test("takes the five efforts as written, and nothing else", () => {
    for (const e of ["low", "medium", "high", "xhigh", "max"]) assert.ok(isEffort(e), e);
    for (const e of ["", "HIGH", "minimal", "none", "3", 3, null, undefined]) assert.ok(!isEffort(e), String(e));
  });
});

describe("withEffort", () => {
  test("puts the effort after the model, and a record with none stored at medium", () => {
    assert.equal(withEffort("claude-opus-5-5", "high"), "claude-opus-5-5 (high)");
    assert.equal(withEffort("claude-haiku-4-5", null), "claude-haiku-4-5 (medium)");
  });
});

describe("currentEffort", dbTest, () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  before(async () => { db = await startTestDb(); });
  after(async () => { await db.stop(); });

  test("starts at medium and reads the setting as it is now", async () => {
    assert.equal(await currentEffort(db.pool), "medium");
    await db.pool.query("update wip_policy set effort = 'xhigh'");
    assert.equal(await currentEffort(db.pool), "xhigh");
  });

  test("throws for a value that isn't an effort, rather than guess one", async () => {
    await db.pool.query("update wip_policy set effort = 'lots'");
    await assert.rejects(currentEffort(db.pool), /effort setting holds "lots"/);
  });
});
