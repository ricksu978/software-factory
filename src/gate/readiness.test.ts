import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fakeBacklog } from "../adapters/fake.ts";
import type { FactoryItem } from "../adapters/types.ts";
import type { AgentArgs, AgentResult } from "../agent/run.ts";
import type { ReadinessCheck } from "../store/readiness-checks.ts";
import { loadPolicy, type Policy } from "../policy/policy.ts";
import type { SplitBoard } from "./file-split.ts";
import { gate, type GateContext } from "./readiness.ts";
import type { SplitChild, SplitDeps } from "./split.ts";

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

describe("gate: an oversized item (PBI 143)", () => {
  const split = (ok: boolean, text: string) => ({
    sop: { models: { coding: "c" } },
    agent: async (a: { model: string }) => ({ ok, text, costUsd: 0, tokensIn: 0, tokensOut: 0, model: a.model, limit: null, usage: null, transcript: "" }),
  });
  const valid = JSON.stringify({ children: [{ title: "A", body: "b", criteria: [1], needs: [] }, { title: "B", body: "b", criteria: [2], needs: [1] }] });
  const judged = (oversized: unknown, status = "passed") =>
    [JSON.stringify({ index: 1, status, reason: "No title" }), JSON.stringify({ flags: [], oversized })].join("\n");

  test("only a literal true reads as oversized, and size alone never fails the item", async () => {
    for (const [v, want] of [[true, true], [false, false], ["yes", false], [undefined, false]] as const) {
      const s = await setup("- [ ] Has a title\n", { acceptanceCriteria: ["one", "two"] });
      const out = await gate(s.item, s.ctx(judged(v), { split: split(true, valid) }));
      assert.equal(out.oversized, want, String(v));
      assert.equal(out.ready, true);
      assert.equal(out.split === null, !want);
    }
  });

  test("a valid split is posted once per item text, apart from the readiness comment", async () => {
    const s = await setup("- [ ] Has a title\n", { acceptanceCriteria: ["one", "two"] });
    await gate(s.item, s.ctx(judged(true, "failed"), { split: split(true, valid) }));
    await gate(s.item, s.ctx(judged(true, "failed"), { split: split(true, valid), readinessSha: "other" }));
    const all = await s.fake.comments(s.id);
    assert.equal(all.filter((b) => b.startsWith("The factory proposes splitting")).length, 1);
    assert.equal(all.filter((b) => b.startsWith("The factory can't start")).length, 2);
    assert.ok(all.every((b) => !b.includes("couldn't be proposed")));
  });

  test("an invalid split posts nothing and the readiness comment says why", async () => {
    const s = await setup("- [ ] Has a title\n", { acceptanceCriteria: ["one", "two"] });
    const out = await gate(s.item, s.ctx(judged(true, "failed"), { split: split(true, "no") }));
    assert.deepEqual(out.split, { proposed: false, reason: "the coding model's reply couldn't be read" });
    const all = await s.fake.comments(s.id);
    assert.equal(all.length, 1);
    assert.match(all[0], /a split couldn't be proposed because the coding model's reply couldn't be read/);
  });

  test("a filed split leaves the item not ready, with no readiness comment, and the proposal says it files the children (PBI 144)", async () => {
    const s = await setup("- [ ] Has a title\n", { acceptanceCriteria: ["one", "two"], repo: "o/r" });
    let n = 0;
    const board: SplitBoard = {
      subIssues: async () => [], findIssues: async () => [], createIssue: async (_r, title) => ({ externalId: String(100 + n), title, url: `u${n++}` }),
      addSubIssue: async () => {}, boardStatus: async () => null, addToBoard: async () => {}, blockedBy: async () => [], addBlockedBy: async () => {},
      removeLabel: async () => {},
    };
    const file = { board, optInLabel: "factory", backlogStatus: "Backlog", criteriaHeading: "Acceptance criteria" };
    const out = await gate(s.item, s.ctx(judged(true, "failed"), { split: { ...split(true, valid), file } }));
    assert.equal(out.ready, false);
    assert.equal(out.filed, true);
    const all = await s.fake.comments(s.id);
    assert.equal(all.filter((b) => b.startsWith("The factory can't start")).length, 0);
    assert.match(all.find((b) => b.startsWith("The factory proposes splitting"))!, /files each child as a sub-issue/);
    assert.equal(all.filter((b) => b.startsWith("The factory filed this item's split")).length, 1);
  });

  // The reviewer's two restart traces: a filing stops partway, the process restarts (no `seen`), and the coding model
  // answers a different split. The kept split is what's finished, so no criterion is dropped and the parent leaves.
  const three = JSON.stringify({ children: [
    { title: "Card", body: "b", criteria: [1], needs: [] }, { title: "Bank", body: "b", criteria: [2], needs: [1] },
    { title: "Receipt", body: "b", criteria: [3], needs: [1, 2] },
  ] });
  const two = JSON.stringify({ children: [{ title: "Payments", body: "b", criteria: [1, 2], needs: [] }, { title: "Receipt", body: "b", criteria: [3], needs: [1] }] });
  function restartBoard(fail: Set<string>) {
    const issues: { externalId: string; title: string; url: string; body: string }[] = [];
    const subs: string[] = [];
    const labels = ["factory"];
    const strip = ({ body: _, ...i }: (typeof issues)[number]) => i;
    const board: SplitBoard = {
      subIssues: async () => subs.map((id) => strip(issues.find((i) => i.externalId === id)!)),
      findIssues: async (_r, text) => issues.filter((i) => i.body.includes(text)).map(strip),
      createIssue: async (_r, title, body) => {
        if (fail.delete(`create:${title}`)) throw new Error(`refused ${title}`);
        const i = { externalId: String(100 + issues.length), title, url: `u${issues.length}`, body };
        issues.push(i);
        return strip(i);
      },
      addSubIssue: async (_p, id) => { subs.push(id); }, boardStatus: async () => null, addToBoard: async () => {}, blockedBy: async () => [],
      addBlockedBy: async () => {}, removeLabel: async (_id, l) => { labels.splice(labels.indexOf(l), 1); },
    };
    const kept = new Map<string, SplitChild[]>();
    const splits: GateContext["splits"] = {
      get: async (i) => kept.get(i.externalId) ?? null,
      keep: async (i, children) => { if (!kept.has(i.externalId)) kept.set(i.externalId, children); return kept.get(i.externalId)!; },
    };
    return { issues, subs, labels, splits, file: { board, optInLabel: "factory", backlogStatus: "Backlog", criteriaHeading: "Acceptance criteria" } };
  }

  test("a filing that failed partway is finished after a restart with the split it started, not a new answer (PBI 144)", async () => {
    const s = await setup("- [ ] Has a title\n", { acceptanceCriteria: ["card", "bank", "receipt"], repo: "o/r" });
    const b = restartBoard(new Set(["create:Bank"]));
    await assert.rejects(gate(s.item, s.ctx(judged(true, "failed"), { splits: b.splits, split: { ...split(true, three), file: b.file } })), /refused Bank/);
    assert.deepEqual(b.issues.map((i) => i.title), ["Card"]);
    // After the restart the coding model would answer two children. It isn't asked: the kept split is filed.
    let asked = 0;
    const after = { ...split(true, two), agent: async (a: { model: string }) => { asked++; return split(true, two).agent(a); }, file: b.file };
    const out = await gate(s.item, s.ctx(judged(true, "failed"), { splits: b.splits, split: after }));
    assert.equal(asked, 0);
    assert.equal(out.filed, true);
    assert.deepEqual(b.issues.map((i) => i.title), ["Card", "Bank", "Receipt"]);
    assert.deepEqual(b.subs, ["100", "101", "102"]);
    assert.deepEqual(b.labels, []);
  });

  test("a filing whose link comment failed is finished after a restart, not taken for a split by hand (PBI 144)", async () => {
    const s = await setup("- [ ] Has a title\n", { acceptanceCriteria: ["card", "bank", "receipt"], repo: "o/r" });
    const b = restartBoard(new Set());
    const refusing = { ...s.fake.adapter, comment: async (id: string, body: string, key: string) => {
      if (key.startsWith("split-filed:")) throw new Error("comment refused");
      return s.fake.adapter.comment(id, body, key);
    } };
    await assert.rejects(gate(s.item, s.ctx(judged(true, "failed"), { adapter: refusing, splits: b.splits, split: { ...split(true, three), file: b.file } })), /comment refused/);
    assert.deepEqual(b.subs, ["100", "101", "102"]);
    const out = await gate(s.item, s.ctx(judged(true, "failed"), { splits: b.splits, split: { ...split(true, two), file: b.file } }));
    assert.equal(out.filed, true);
    assert.equal(b.issues.length, 3);
    assert.deepEqual(b.labels, []);
    const filed = (await s.fake.comments(s.id)).find((c) => c.startsWith("The factory filed this item's split"))!;
    assert.match(filed, /Card[\s\S]*Bank[\s\S]*Receipt/);
  });

  test("a parent already split another way gets a proposal that files nothing, and no child is filed (PBI 144)", async () => {
    const s = await setup("- [ ] Has a title\n", { acceptanceCriteria: ["one", "two"], repo: "o/r" });
    let created = 0;
    const board: SplitBoard = {
      subIssues: async () => [{ externalId: "50", title: "by hand", url: "u50" }], findIssues: async () => [],
      createIssue: async (_r, title) => ({ externalId: String(100 + created++), title, url: "u" }),
      addSubIssue: async () => {}, boardStatus: async () => null, addToBoard: async () => {}, blockedBy: async () => [], addBlockedBy: async () => {},
      removeLabel: async () => {},
    };
    const file = { board, optInLabel: "factory", backlogStatus: "Backlog", criteriaHeading: "Acceptance criteria" };
    const out = await gate(s.item, s.ctx(judged(true, "failed"), { split: { ...split(true, valid), file } }));
    assert.equal(out.filed, undefined);
    assert.equal(created, 0);
    const proposal = (await s.fake.comments(s.id)).find((b) => b.startsWith("The factory proposes splitting"))!;
    assert.doesNotMatch(proposal, /files each child/);
    assert.match(proposal, /hasn't changed or created any item/);
  });
});

describe("gate's readiness checks (PBI 132)", () => {
  const spend = { model: "claude-haiku-4-5", tokensIn: 1200, tokensOut: 80, costUsd: 0.0031 };
  const at = new Date("2026-11-09T10:15:00Z");

  async function recorded(judge: GateContext["judge"]) {
    const s = await setup("- [ ] Has a title\n");
    const checks: unknown[] = [];
    const run = gate(s.item, s.ctx("", { judge, now: () => at, recordCheck: async (i, c) => { checks.push({ id: i.externalId, ...c }); } }));
    return { s, checks, run };
  }

  test("records the judge call's spend and start time against the item, whatever its verdict", async () => {
    for (const reply of [passAll(1), "I am not sure"]) {
      const { s, checks, run } = await recorded(async (_i, _d, spent) => { spent?.(spend); return reply; });
      await run;
      assert.deepEqual(checks, [{ id: s.item.externalId, ...spend, kind: "judge", ranAt: at }]);
    }
  });

  test("records a failed judge call's spend, then lets the failure through", async () => {
    const { checks, run } = await recorded(async (_i, _d, spent) => { spent?.(spend); throw new Error("readiness judge failed: usage limit"); });
    await assert.rejects(run, /usage limit/);
    assert.equal(checks.length, 1);
  });

  test("records nothing when an engine rule fails and the judge is never asked", async () => {
    const s = await setup("- [ ] Has a title\n", { acceptanceCriteria: [] });
    const checks: unknown[] = [];
    await gate(s.item, s.ctx(passAll(1), { recordCheck: async (_i, c) => { checks.push(c); } }));
    assert.deepEqual(checks, []);
  });

  const oversized = [JSON.stringify({ index: 1, status: "passed", reason: "ok" }), JSON.stringify({ flags: [], oversized: true })].join("\n");
  const children = JSON.stringify({ children: [{ title: "A", body: "b", criteria: [1], needs: [] }, { title: "B", body: "b", criteria: [2], needs: [1] }] });
  const splitDeps = (agent: SplitDeps["agent"]): SplitDeps => ({ sop: { models: { coding: "claude-opus-5-5" } }, agent, seen: new Map() });
  const coded = (ok: boolean) => async (a: AgentArgs): Promise<AgentResult> =>
    ({ ok, text: children, costUsd: 0.21, tokensIn: 4000, tokensOut: 600, model: a.model, limit: null, usage: null, transcript: "" });

  test("records the split proposal's call as a split check, answered or failed, and a cached split as nothing", async () => {
    for (const ok of [true, false]) {
      const s = await setup("- [ ] Has a title\n", { acceptanceCriteria: ["one", "two"] });
      const checks: ReadinessCheck[] = [];
      const split = splitDeps(coded(ok));
      const ctx = s.ctx(oversized, { judge: async (_i, _d, spent) => { spent?.(spend); return oversized; }, split, now: () => at,
        recordCheck: async (_i, c) => { checks.push(c); } });
      await gate(s.item, ctx);
      assert.deepEqual(checks, [
        { ...spend, kind: "judge", ranAt: at },
        { model: "claude-opus-5-5", tokensIn: 4000, tokensOut: 600, costUsd: 0.21, kind: "split", ranAt: at },
      ], String(ok));
      checks.length = 0;
      await gate(s.item, ctx);
      // An answered split is cached by item text, so the re-gate asks the coding model nothing and records no split.
      assert.deepEqual(checks.map((c) => c.kind), ok ? ["judge"] : ["judge", "split"], String(ok));
    }
  });

  test("records a split run that threw as a split check of nothing", async () => {
    const s = await setup("- [ ] Has a title\n", { acceptanceCriteria: ["one", "two"] });
    const checks: ReadinessCheck[] = [];
    await gate(s.item, s.ctx(oversized, { split: splitDeps(async () => { throw new Error("never started"); }), now: () => at,
      recordCheck: async (_i, c) => { checks.push(c); } }));
    assert.deepEqual(checks, [{ model: "claude-opus-5-5", tokensIn: 0, tokensOut: 0, costUsd: 0, kind: "split", ranAt: at }]);
  });

  test("a check that can't be recorded is logged, and the judge's reply or error still comes out", async () => {
    const lines: string[] = [];
    const broken = { recordCheck: async () => { throw new Error("database unavailable"); }, log: (l: string) => { lines.push(l); } };
    const s = await setup("- [ ] Has a title\n");
    const out = await gate(s.item, s.ctx("", { ...broken, judge: async (_i, _d, spent) => { spent?.(spend); return passAll(1); } }));
    assert.equal(out.ready, true);
    const failed = gate(s.item, s.ctx("", { ...broken, judge: async (_i, _d, spent) => { spent?.(spend); throw new Error("readiness judge failed: usage limit until 1"); } }));
    await assert.rejects(failed, /usage limit/);
    assert.equal(lines.length, 2);
    for (const l of lines) assert.match(l, /couldn't record the judge call's cost .*database unavailable/);
  });
});
