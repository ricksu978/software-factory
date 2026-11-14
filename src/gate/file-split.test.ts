import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fakeBacklog } from "../adapters/fake.ts";
import type { FactoryItem } from "../adapters/types.ts";
import { childBody, fileSplit, splitKey, splitMarker, type ChildIssue, type SplitBoard } from "./file-split.ts";
import type { SplitChild } from "./split.ts";

const parent: FactoryItem = {
  sourceId: "s", externalId: "12", title: "Checkout", body: "b", acceptanceCriteria: ["card", "bank", "receipt"], labels: ["factory"],
  status: "Backlog", rank: 1, repo: "o/r", fields: {}, closed: false, updatedAt: "2026-11-09T00:00:00Z",
};
const children: SplitChild[] = [
  { title: "Card", body: "Card for Checkout", criteria: [1], needs: [] },
  { title: "Bank", body: "Bank for Checkout", criteria: [2], needs: [1] },
  { title: "Receipt", body: "Receipt for Checkout", criteria: [3], needs: [1, 2] },
];

type Store = { issues: (ChildIssue & { body: string })[]; subs: string[]; board: Map<string, string>; blocks: Map<string, string[]>; labels: string[]; fail: Set<string> };

function memoryBoard(s: Store): SplitBoard {
  const once = (k: string) => {
    if (s.fail.delete(k)) throw new Error(`refused ${k}`);
  };
  const strip = ({ body: _, ...i }: ChildIssue & { body: string }) => i;
  return {
    async subIssues() {
      return s.subs.map((id) => strip(s.issues.find((i) => i.externalId === id) ?? { externalId: id, title: "by hand", url: "", body: "" }));
    },
    async findIssues(_repo, text) {
      return s.issues.filter((i) => i.body.includes(text) || i.title.includes(text)).map(strip);
    },
    async createIssue(_repo, title, body) {
      once(`create:${title}`);
      const i = { externalId: String(100 + s.issues.length), title, url: `https://x/${100 + s.issues.length}`, body };
      s.issues.push(i);
      return strip(i);
    },
    async addSubIssue(_p, id) {
      once(`sub:${id}`);
      s.subs.push(id);
    },
    async boardStatus(id) {
      return s.board.get(id) ?? null;
    },
    async addToBoard(id, status) {
      once(`board:${id}`);
      s.board.set(id, status);
    },
    async blockedBy(id) {
      return s.blocks.get(id) ?? [];
    },
    async addBlockedBy(id, b) {
      once(`block:${id}:${b}`);
      s.blocks.set(id, [...(s.blocks.get(id) ?? []), b]);
    },
    async removeLabel(_id, label) {
      s.labels = s.labels.filter((l) => l !== label);
    },
  };
}

async function setup(fail: string[] = []) {
  const s: Store = { issues: [], subs: [], board: new Map(), blocks: new Map(), labels: ["factory"], fail: new Set(fail) };
  const fake = fakeBacklog();
  await fake.seed({ ...parent });
  const deps = { board: memoryBoard(s), optInLabel: "factory", backlogStatus: "Backlog", criteriaHeading: "Acceptance criteria" };
  const run = () => fileSplit(parent, children, fake.adapter, deps);
  return { s, fake, run };
}

describe("fileSplit", () => {
  test("files each child, links it, places it, blocks it, then comments on the parent and takes its label off", async () => {
    const { s, fake, run } = await setup();
    assert.equal(await run(), true);
    assert.deepEqual(s.issues.map((i) => i.title), ["Card", "Bank", "Receipt"]);
    assert.deepEqual(s.subs, ["100", "101", "102"]);
    assert.deepEqual([...s.board.values()], ["Backlog", "Backlog", "Backlog"]);
    assert.deepEqual(s.blocks.get("101"), ["100"]);
    assert.deepEqual(s.blocks.get("102"), ["100", "101"]);
    assert.equal(s.blocks.get("100"), undefined);
    assert.deepEqual(s.labels, []);
    const comments = await fake.comments("12");
    assert.equal(comments.length, 1);
    for (const i of s.issues) assert.ok(comments[0].includes(i.url));
  });

  test("a second run files nothing more and posts no second comment", async () => {
    const { s, fake, run } = await setup();
    await run();
    assert.equal(await run(), true);
    assert.equal(s.issues.length, 3);
    assert.equal(s.subs.length, 3);
    assert.equal((await fake.comments("12")).length, 1);
  });

  test("a filing that fails partway throws, keeps the label, and the next run files only what's missing", async () => {
    const { s, fake, run } = await setup(["create:Bank"]);
    await assert.rejects(run(), /refused/);
    assert.deepEqual(s.labels, ["factory"]);
    assert.deepEqual(await fake.comments("12"), []);
    await run();
    assert.deepEqual(s.issues.map((i) => i.title), ["Card", "Bank", "Receipt"]);
    assert.deepEqual(s.subs, ["100", "101", "102"]);
  });

  test("a child filed but not linked, placed or blocked is finished, not filed again", async () => {
    for (const fail of ["sub:101", "board:102", "block:102:101"]) {
      const { s, run } = await setup([fail]);
      await assert.rejects(run());
      await run();
      assert.equal(s.issues.length, 3, fail);
      assert.deepEqual(s.subs, ["100", "101", "102"], fail);
      assert.equal(s.board.get("102"), "Backlog", fail);
      assert.deepEqual(s.blocks.get("102"), ["100", "101"], fail);
    }
  });

  test("a parent with a sub-issue the factory didn't file for this split is never split", async () => {
    const { s, fake, run } = await setup();
    s.subs.push("7");
    assert.equal(await run(), false);
    assert.equal(s.issues.length, 0);
    assert.deepEqual(s.labels, ["factory"]);
    assert.deepEqual(await fake.comments("12"), []);
  });

  test("a parent whose text changed after its children were filed gets no second set", async () => {
    const { s, run, fake } = await setup();
    await run();
    const changed = { ...parent, body: "new text" };
    const deps = { board: memoryBoard(s), optInLabel: "factory", backlogStatus: "Backlog", criteriaHeading: "Acceptance criteria" };
    assert.equal(await fileSplit(changed, children, fake.adapter, deps), false);
    assert.equal(s.issues.length, 3);
  });

  test("a child's body opens with the proposal's body and lists its criteria under the heading, with the marker", () => {
    const body = childBody(parent, children[2], 3, "Acceptance criteria");
    assert.ok(body.startsWith("Receipt for Checkout\n"));
    assert.match(body, /\n## Acceptance criteria\n\n- receipt\n/);
    assert.ok(body.includes(splitMarker(splitKey(parent), 3)));
    assert.ok(body.includes("#12"));
  });

  test("a child's body drops every section the model wrote under the criteria heading, and keeps the rest (PBI 249)", () => {
    const own = "Card for Checkout\n\n### ACCEPTANCE CRITERIA\n\n- Card works\n\n## Scope\n\nCards only.\n\n## Acceptance criteria\n\n- Errors shown\n";
    const body = childBody(parent, { ...children[0], body: own }, 1, "Acceptance criteria");
    assert.ok(body.startsWith("Card for Checkout\n\n## Scope\n\nCards only.\n\n## Acceptance criteria\n\n- card\n"), body);
    assert.ok(!body.includes("Card works") && !body.includes("Errors shown"), body);
    assert.equal(body.match(/^#+\s*acceptance criteria\s*$/gim)?.length, 1, body);
  });

  test("a child's body that is only a criteria section is filed with the parent's criteria alone (PBI 249)", () => {
    const body = childBody(parent, { ...children[0], body: "## Acceptance criteria\n\n- Card works" }, 1, "Acceptance criteria");
    assert.ok(body.startsWith("## Acceptance criteria\n\n- card\n"), body);
  });

  test("a child's body with only a near-match heading is kept whole (PBI 249)", () => {
    const own = "Card for Checkout\n\n## Acceptance criteria notes\n\nAsk first.";
    assert.ok(childBody(parent, { ...children[0], body: own }, 1, "Acceptance criteria").startsWith(`${own}\n\n## Acceptance criteria\n`));
  });

  test("the split key depends on the parent and its text", () => {
    assert.notEqual(splitKey(parent), splitKey({ ...parent, externalId: "13" }));
    assert.notEqual(splitKey(parent), splitKey({ ...parent, title: "other" }));
    assert.equal(splitKey(parent), splitKey({ ...parent, labels: [], updatedAt: "later" }));
  });
});
