import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CellApi } from "./api-client.ts";
import { PENDING_CI_CAP_MS, pendingCiQuestion } from "./ci-cap.ts";

const SHA = "abc1234";

function api(pending?: string[]): { api: CellApi; asked: string[] } {
  const asked: string[] = [];
  const base = {} as CellApi;
  return {
    asked,
    api: pending === undefined ? base : { ...base, pendingChecks: async (sha: string) => { asked.push(sha); return pending; } },
  };
}

describe("pendingCiQuestion", () => {
  test("is null while CI has been pending for less than 60 minutes, and asks nothing", async () => {
    const a = api(["ci"]);
    assert.equal(await pendingCiQuestion(a.api, SHA, 0), null);
    assert.equal(await pendingCiQuestion(a.api, SHA, PENDING_CI_CAP_MS - 1), null);
    assert.deepEqual(a.asked, []);
  });

  test("at 60 minutes names each check still pending on the commit", async () => {
    const a = api(["ci", "e2e"]);
    const q = await pendingCiQuestion(a.api, SHA, PENDING_CI_CAP_MS);
    assert.ok(q);
    assert.match(q, /60 minutes/);
    assert.match(q, /abc1234/);
    assert.match(q, /"ci"/);
    assert.match(q, /"e2e"/);
    assert.deepEqual(a.asked, [SHA]);
  });

  test("still asks a person when the cell API can't name the checks, or names none", async () => {
    for (const a of [api(), api([])]) {
      const q = await pendingCiQuestion(a.api, SHA, PENDING_CI_CAP_MS + 1);
      assert.ok(q);
      assert.match(q, /abc1234/);
    }
  });
});
