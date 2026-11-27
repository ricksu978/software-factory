import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LeaseLost, type CellApi } from "./api-client.ts";
import { cancelledCiQuestion, PENDING_CI_CAP_MS, pendingCiQuestion } from "./ci-cap.ts";

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

  test("still asks a person when the cell API names no pending check, and says so", async () => {
    const q = await pendingCiQuestion(api([]).api, SHA, PENDING_CI_CAP_MS + 1);
    assert.ok(q);
    assert.match(q, /abc1234/);
    assert.match(q, /No check named itself as pending/);
  });

  test("still asks a person when the cell API has no pendingChecks, saying it couldn't read the checks", async () => {
    const q = await pendingCiQuestion(api().api, SHA, PENDING_CI_CAP_MS + 1);
    assert.ok(q);
    assert.match(q, /abc1234/);
    assert.match(q, /couldn't read which checks are pending/);
  });

  test("still asks a person when pendingChecks fails, saying the factory couldn't read the checks, and logs the error", async (t) => {
    const logged = t.mock.method(console, "error", () => {});
    const failing = { pendingChecks: async () => { throw new Error("GET pending-checks 500"); } } as unknown as CellApi;
    const q = await pendingCiQuestion(failing, SHA, PENDING_CI_CAP_MS);
    assert.ok(q);
    assert.match(q, /abc1234/);
    assert.match(q, /The factory couldn't read which checks are pending/);
    assert.doesNotMatch(q, /No check named itself as pending/);
    assert.doesNotMatch(q, /500/);
    assert.equal(logged.mock.callCount(), 1);
    assert.ok(logged.mock.calls[0].arguments.some((a) => a instanceof Error && a.message === "GET pending-checks 500"));
  });

  test("lets LeaseLost through, so a fenced cell ends its run", async () => {
    const fenced = { pendingChecks: async () => { throw new LeaseLost("lease moved"); } } as unknown as CellApi;
    await assert.rejects(pendingCiQuestion(fenced, SHA, PENDING_CI_CAP_MS), LeaseLost);
  });
});

describe("cancelledCiQuestion", () => {
  test("is null under the cap, and then asks about the cancelled run, saying it neither failed nor passed (PBI 423)", () => {
    assert.equal(cancelledCiQuestion(SHA, PENDING_CI_CAP_MS - 1), null);
    const q = cancelledCiQuestion(SHA, PENDING_CI_CAP_MS);
    assert.ok(q);
    assert.match(q, /abc1234 was cancelled/);
    assert.match(q, /neither failed nor passed/);
    assert.match(q, /60 minutes/);
  });
});
