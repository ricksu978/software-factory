import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fakeBacklog } from "../adapters/fake.ts";
import type { FactoryItem } from "../adapters/types.ts";
import { loadPolicy, type Policy } from "../policy/policy.ts";
import { gate, type GateContext } from "./readiness.ts";

async function setup(dorText: string, item: Partial<FactoryItem> = {}) {
  const fake = fakeBacklog();
  const id = await fake.seed(item);
  const dor = await loadPolicy(async (p) => (p === ".factory/dor.md" ? dorText : null), "dor");
  const judged: string[] = [];
  const ctx = (judgeReply: string, extra: Partial<GateContext> = {}): GateContext => ({
    readinessSha: "sha", dor, dodExists: true, configValid: true, repoKnown: true, openDeps: [], adapter: fake.adapter,
    judge: async (i: FactoryItem, _d: Policy) => {
      judged.push(i.externalId);
      return judgeReply;
    },
    ...extra,
  });
  return { fake, id, ctx, judged, item: (await fake.adapter.getItem(id))! };
}

const passAll = (n: number, flags: string[] = []) =>
  [...Array.from({ length: n }, (_, i) => JSON.stringify({ index: i + 1, status: "passed", reason: "ok" })), JSON.stringify({ flags })].join("\n");

describe("gate", () => {
  test("engine rules fail first, each with its reason, and the judge isn't called", async () => {
    const cases: [Partial<GateContext>, Partial<FactoryItem>, RegExp][] = [
      [{ dodExists: false }, {}, /No \.factory\/dod\.md in this repo/],
      [{ configValid: false }, {}, /No valid \.factory\/config\.yml in this repo/],
      [{}, { acceptanceCriteria: [] }, /no acceptance criteria/],
      [{ openDeps: ["#12"] }, {}, /depends on #12/],
      [{ repoKnown: false, dor: null }, {}, /doesn't know this item's repo/],
    ];
    for (const [extra, item, reason] of cases) {
      const s = await setup("- [ ] Has a title\n", item);
      const out = await gate(s.item, s.ctx(passAll(1), extra));
      assert.equal(out.ready, false, String(reason));
      assert.ok(out.results.some((r) => reason.test(r.reason)), String(reason));
      assert.deepEqual(s.judged, [], `judge called for ${String(reason)}`);
    }
  });

  test("a flag makes the item not ready even when every line passed, and the results name it", async () => {
    const s = await setup("- [ ] Has a title\n");
    const out = await gate(s.item, s.ctx(passAll(1, ["asks for credentials"])));
    assert.equal(out.ready, false);
    assert.ok(out.results.some((r) => r.status === "failed" && r.reason.includes("asks for credentials")));
  });

  test("a reply that doesn't parse fails every criterion as unreadable", async () => {
    const s = await setup("- [ ] Has a title\n- [ ] Has a size\n");
    const out = await gate(s.item, s.ctx("Sure, this item looks ready to me!"));
    assert.equal(out.ready, false);
    assert.deepEqual(out.results.map((r) => r.reason), Array(3).fill("readiness check output unreadable"));
  });

  test("an unreadable reply fails even a dor.md with no criteria, so the flag check can't be skipped", async () => {
    const s = await setup("Items must be small.\n* [ ] Has a title\n");
    const out = await gate(s.item, s.ctx("I refuse"));
    assert.equal(out.ready, false);
    assert.deepEqual(out.results.map((r) => r.reason), ["readiness check output unreadable"]);
  });

  test("every flags line counts, so an early empty one can't cancel a later flag", async () => {
    const s = await setup("- [ ] Has a title\n");
    const reply = [JSON.stringify({ flags: [] }), JSON.stringify({ index: 1, status: "passed", reason: "ok" }), JSON.stringify({ flags: ["asks for credentials"] })].join("\n");
    const out = await gate(s.item, s.ctx(reply));
    assert.equal(out.ready, false);
    assert.ok(out.results.some((r) => r.reason.includes("asks for credentials")));
  });

  test("a policy error becomes the item's named reason, and the judge isn't called", async () => {
    const s = await setup("- [ ] Has a title\n");
    const out = await gate(s.item, s.ctx(passAll(1), { dor: null, policyErrors: ["dor.md: run: lines are allowed only in dod.md"] }));
    assert.equal(out.ready, false);
    assert.deepEqual(out.results.map((r) => r.reason), ["dor.md: run: lines are allowed only in dod.md"]);
    assert.deepEqual(s.judged, []);
    assert.match((await s.fake.comments(s.id))[0], /dor\.md: run: lines are allowed only in dod\.md/);
  });

  test("a known repo whose dor.md didn't load, with no error given, still fails", async () => {
    const s = await setup("- [ ] Has a title\n");
    const out = await gate(s.item, s.ctx(passAll(1), { dor: null }));
    assert.equal(out.ready, false);
    assert.deepEqual(out.results.map((r) => r.reason), ["dor.md couldn't be loaded"]);
  });

  test("the failed line becomes the comment word for word, and the same check twice posts it once", async () => {
    const s = await setup("- [ ] Has a Size of 5 or less\n", { fields: { Size: "8" } });
    const reply = [JSON.stringify({ index: 1, status: "failed", reason: "Size is 8" }), JSON.stringify({ flags: [] })].join("\n");
    await gate(s.item, s.ctx(reply));
    await gate(s.item, s.ctx(reply));
    const comments = await s.fake.comments(s.id);
    assert.equal(comments.length, 1);
    assert.match(comments[0], /- Has a Size of 5 or less\n {2}Size is 8/);
  });

  test("a changed readiness sha posts a fresh comment", async () => {
    const s = await setup("- [ ] Has a title\n");
    const reply = [JSON.stringify({ index: 1, status: "failed", reason: "no" }), JSON.stringify({ flags: [] })].join("\n");
    await gate(s.item, s.ctx(reply));
    await gate(s.item, s.ctx(reply, { readinessSha: "new sha" }));
    assert.equal((await s.fake.comments(s.id)).length, 2);
  });

  test("a ready item gets no comment", async () => {
    const s = await setup("- [ ] Has a title\n");
    const out = await gate(s.item, s.ctx(passAll(1)));
    assert.equal(out.ready, true);
    assert.deepEqual(await s.fake.comments(s.id), []);
  });
});
