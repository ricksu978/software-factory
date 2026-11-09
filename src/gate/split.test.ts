import assert from "node:assert/strict";
import { test } from "node:test";
import type { FactoryItem } from "../adapters/types.ts";
import type { AgentArgs, AgentResult } from "../agent/run.ts";
import { checkSplit, itemTextHash, proposeSplit, SPLIT_HEADING, splitComment, splitPrompt } from "./split.ts";

const item: FactoryItem = {
  externalId: "1", sourceId: "fake", title: "Checkout redesign", body: "See spec section §7.2.",
  acceptanceCriteria: ["Pay by card", "Pay by transfer", "Show the reason"], labels: [], status: "Backlog", rank: 1,
  repo: "o/r", fields: {}, closed: false, updatedAt: "2026-11-09T00:00:00Z",
};
type Row = { title?: string; body?: string; criteria?: unknown; needs?: unknown };
const reply = (children: Row[]) => JSON.stringify({ children: children.map((c) => ({ body: "Part of Checkout redesign, §7.2.", ...c })) });
const valid: Row[] = [{ title: "A", criteria: [1, 3], needs: [] }, { title: "B", criteria: [2], needs: [1] }];
const reason = (r: string) => {
  const out = checkSplit(r, 3);
  assert.equal(out.proposed, false);
  return out.proposed ? "" : out.reason;
};

test("a split giving every criterion to one child, needing only earlier children, is valid", () => {
  const out = checkSplit(`Here it is:\n${reply(valid)}`, 3);
  assert.ok(out.proposed);
  assert.deepEqual(out.children.map((c) => [c.title, c.criteria, c.needs]), [["A", [1, 3], []], ["B", [2], [1]]]);
});

test("each broken split says why", () => {
  const cases: [string, string][] = [
    ["no JSON", "the coding model's reply couldn't be read"],
    [reply([valid[0]]), "it must have 2 to 4 children"],
    [reply([...valid, ...valid, valid[0]]), "it must have 2 to 4 children"],
    [reply([valid[0], { ...valid[1], title: " " }]), "child 2 has no title"],
    [reply([valid[0], { ...valid[1], criteria: [] }]), "child 2 takes no criterion"],
    [reply([valid[0], { ...valid[1], needs: undefined }]), "child 2 doesn't say which earlier children it needs"],
    [reply([valid[0], { ...valid[1], needs: [2] }]), "child 2 needs itself"],
    [reply([valid[0], { ...valid[1], needs: [7] }]), "child 2 needs child 7, which doesn't exist"],
    [reply([{ ...valid[0], needs: [2] }, valid[1]]), "child 1 needs child 2, which comes after it"],
    [reply([valid[0], { ...valid[1], criteria: [2, 5] }]), "the parent has no criterion 5"],
    [reply([{ ...valid[0], criteria: [1] }, valid[1]]), "criterion 3 goes to no child"],
    [reply([valid[0], { ...valid[1], criteria: [2, 3] }]), "criterion 3 goes to more than one child"],
  ];
  for (const [r, why] of cases) assert.ok(reason(r).includes(why), `${why}: got ${reason(r)}`);
});

test("the split is asked of the SOP's coding model, with no tool, and a failed run is no answer", async () => {
  const asked: AgentArgs[] = [];
  const run = (ok: boolean, text: string) => async (a: AgentArgs): Promise<AgentResult> => {
    asked.push(a);
    return { ok, text, costUsd: 0, tokensIn: 0, tokensOut: 0, model: a.model, limit: null, usage: null, transcript: "" };
  };
  const sop = { models: { coding: "model-c" } };
  assert.ok((await proposeSplit(item, { sop, agent: run(true, reply(valid)) })).proposed);
  assert.equal(asked[0].model, "model-c");
  assert.equal(asked[0].mode, "judge");
  assert.deepEqual(await proposeSplit(item, { sop, agent: run(false, "API error") }), { proposed: false, reason: "the coding model gave no answer" });
  const thrown = await proposeSplit(item, { sop, agent: async () => { throw new Error("boom"); } });
  assert.deepEqual(thrown, { proposed: false, reason: "the coding model gave no answer" });
});

test("the prompt fences the item and asks for 2 to 4 children with criteria indices and earlier needs", () => {
  const p = splitPrompt(item);
  for (const s of ["2 to 4", '"title"', '"body"', '"criteria"', '"needs"', "earlier", "Checkout redesign", "§7.2", "```json"]) assert.ok(p.includes(s), s);
  assert.match(p, /\{"index":3,"criterion":"Show the reason"\}/);
});

test("the proposal lists each child's title, criteria word for word and needs by title", () => {
  const out = checkSplit(reply(valid), 3);
  assert.ok(out.proposed);
  const body = splitComment(item, out.children);
  assert.ok(body.startsWith(SPLIT_HEADING));
  assert.match(body, /### 1\. A[\s\S]*- Pay by card\n- Show the reason\n\nNeeds: nothing[\s\S]*### 2\. B[\s\S]*- Pay by transfer\n\nNeeds: A/);
});

test("the text hash follows the item's text, not its other fields", () => {
  assert.equal(itemTextHash(item), itemTextHash({ ...item, updatedAt: "later", labels: ["x"] }));
  assert.notEqual(itemTextHash(item), itemTextHash({ ...item, body: "changed" }));
});
