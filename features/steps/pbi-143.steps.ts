import { DataTable, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { fakeBacklog } from "../../src/adapters/fake.ts";
import type { FactoryItem } from "../../src/adapters/types.ts";
import { judgePrompt, type AgentArgs, type AgentResult } from "../../src/agent/run.ts";
import { gate, type GateResult } from "../../src/gate/readiness.ts";
import { SPLIT_HEADING, type SplitChild } from "../../src/gate/split.ts";
import { loadPolicy, type Policy } from "../../src/policy/policy.ts";

// The judge is scripted as in PBI 13, with an "oversized" key beside "flags" on its last line. The coding model is a
// scripted agent runner that records every request, so a scenario reads the prompt and model it was asked with. The
// repo's files are PBI 13's in-memory map, which the shared Background step fills. Comments live in the fake backlog:
// a readiness comment opens with the gate's own words, a split proposal with SPLIT_HEADING.
const READINESS_HEADING = "The factory can't start this item yet.";
const NO_SPLIT = "split couldn't be proposed";

type Fake = ReturnType<typeof fakeBacklog>;
export type Ctx = {
  fake: Fake;
  itemId?: string;
  title?: string;
  section?: string;
  body?: string;
  criteria: string[];
  judge?: (item: FactoryItem, dor: Policy) => Promise<string>;
  /** What the coding model answers; null means its run fails. */
  reply: string | null;
  requests: AgentArgs[];
  sop: { models: { coding: string; triage: string } };
  readinessSha: string;
  outcome?: GateResult;
  error?: unknown;
  prompt?: string;
};

export function ctx(world: object): Ctx {
  const w = world as { pbi143?: Ctx };
  w.pbi143 ??= {
    fake: fakeBacklog(), criteria: [], reply: splitReply(validSplit()), requests: [],
    sop: { models: { coding: "coding-model", triage: "triage-model" } }, readinessSha: "policy-1",
  };
  return w.pbi143;
}

// PBI 13's Background step writes ".factory/dor.md" into its own world slot.
export function files(world: object): Map<string, string> {
  const w = world as { pbi13?: { files: Map<string, string> } };
  w.pbi13 ??= { files: new Map() };
  return w.pbi13.files;
}

type ChildRow = { title?: string; body?: string; criteria: number[]; needs?: number[] };

const childBody = (c: Ctx) => `Part of "${c.title}", spec section ${c.section}.`;

function validSplit(): ChildRow[] {
  return [
    { title: "Card payments", criteria: [1, 3], needs: [] },
    { title: "Bank transfers", criteria: [2], needs: [1] },
    { title: "Payment receipts", criteria: [4], needs: [1, 2] },
  ];
}

// One JSON line holding the children, as the coding model is asked to answer.
function splitReply(children: ChildRow[], body = 'Part of "Checkout redesign", spec section §7.2.'): string {
  return JSON.stringify({ children: children.map((ch) => ({ ...ch, body: ch.body ?? body })) });
}

function setSplit(c: Ctx, children: ChildRow[]): void {
  c.reply = splitReply(children, c.title ? childBody(c) : undefined);
}

const indices = (cell: string) => cell.split(",").map((s) => s.trim()).filter(Boolean).map(Number);

function agent(c: Ctx) {
  return async (a: AgentArgs): Promise<AgentResult> => {
    c.requests.push(a);
    const ok = c.reply !== null;
    return {
      ok, text: c.reply ?? "API error: the run failed", costUsd: 0, tokensIn: 0, tokensOut: 0, model: a.model,
      limit: null, usage: null, transcript: "",
    };
  };
}

function scriptedJudge(lastLine: string, failIndex: number | null = null, reason = "") {
  return async (_item: FactoryItem, dor: Policy) =>
    [
      ...dor.criteria.map((cr) =>
        JSON.stringify({ index: cr.index, status: cr.index === failIndex ? "failed" : "passed", reason: cr.index === failIndex ? reason : "ok" })),
      lastLine,
    ].join("\n");
}

const lastLine = (flags: string[], oversized: string) => JSON.stringify({ flags, oversized: JSON.parse(oversized) as unknown });

async function seedParent(c: Ctx, updatedAt?: string): Promise<void> {
  c.itemId = await c.fake.seed({
    ...(c.itemId ? { externalId: c.itemId } : {}),
    title: c.title, body: c.body, acceptanceCriteria: c.criteria, repo: "acme/shop",
    ...(updatedAt ? { updatedAt } : {}),
  });
}

export async function runGate(world: object): Promise<void> {
  const c = ctx(world);
  c.outcome = undefined;
  c.error = undefined;
  try {
    assert.ok(c.itemId && c.judge, "the scenario set up no item or no judge");
    const dor = await loadPolicy(async (p) => files(world).get(p) ?? null, "dor");
    const item = await c.fake.adapter.getItem(c.itemId);
    assert.ok(item);
    c.outcome = await gate(item, {
      readinessSha: c.readinessSha, dor, dodExists: true, configValid: true, repoKnown: true, openDeps: [],
      judge: c.judge, adapter: c.fake.adapter, split: { sop: c.sop, agent: agent(c) },
    });
  } catch (e) {
    c.error = e;
  }
}

function checked(c: Ctx): GateResult {
  assert.equal(c.error, undefined, `the gate failed: ${String(c.error)}`);
  assert.ok(c.outcome, "the readiness gate didn't run");
  return c.outcome;
}

async function comments(c: Ctx): Promise<{ readiness: string[]; proposals: string[] }> {
  checked(c);
  const all = await c.fake.comments(c.itemId!);
  return { readiness: all.filter((b) => b.startsWith(READINESS_HEADING)), proposals: all.filter((b) => b.startsWith(SPLIT_HEADING)) };
}

async function readinessComment(c: Ctx): Promise<string> {
  const { readiness } = await comments(c);
  assert.equal(readiness.length, 1, `expected one readiness comment, found ${readiness.length}`);
  return readiness[0];
}

async function proposal(c: Ctx): Promise<string> {
  const { proposals } = await comments(c);
  assert.equal(proposals.length, 1, `expected one split proposal comment, found ${proposals.length}`);
  return proposals[0];
}

function request(c: Ctx): AgentArgs {
  checked(c);
  assert.equal(c.requests.length, 1, `the coding model was asked ${c.requests.length} times`);
  return c.requests[0];
}

// --- Background --------------------------------------------------------------------------------------------------

Given("a parent item {string} in that repo whose body cites spec section {string}", function (title: string, section: string) {
  const c = ctx(this);
  c.title = title;
  c.section = section;
  c.body = `Redesign the checkout so a shopper can pay more ways. See spec section ${section}.`;
});

Given("the parent item has these acceptance criteria:", async function (table: DataTable) {
  const c = ctx(this);
  c.criteria = table.hashes().sort((a, b) => Number(a.index) - Number(b.index)).map((r) => r.text);
  c.reply = splitReply(validSplit(), childBody(c));
  await seedParent(c);
});

// --- The judge -----------------------------------------------------------------------------------------------------

Given("a judge that passes every line, raises no flag and reports oversized {word}", function (oversized: string) {
  ctx(this).judge = scriptedJudge(lastLine([], oversized));
});

Given("a judge that fails line {int} because {string}, raises no flag and reports oversized {word}", function (index: number, reason: string, oversized: string) {
  ctx(this).judge = scriptedJudge(lastLine([], oversized), index, reason);
});

Given("a judge that passes every line, flags {string} and reports oversized {word}", function (flag: string, oversized: string) {
  ctx(this).judge = scriptedJudge(lastLine([flag], oversized));
});

Given("a judge that passes every line and answers only {string} on its last line", function (line: string) {
  ctx(this).judge = scriptedJudge(line);
});

Given("a judge that passes every line and answers {string} on its last line", function (line: string) {
  ctx(this).judge = scriptedJudge(line);
});

// --- The coding model ----------------------------------------------------------------------------------------------

Given("an SOP whose coding model is {string} and whose triage model is {string}", function (coding: string, triage: string) {
  ctx(this).sop = { models: { coding, triage } };
});

Given("a coding model that proposes a valid split", function () {
  const c = ctx(this);
  setSplit(c, validSplit());
});

Given("a coding model that proposes a split which leaves criterion {int} to no child", function (index: number) {
  const c = ctx(this);
  const children = validSplit().map((ch) => ({ ...ch, criteria: ch.criteria.filter((i) => i !== index) })).filter((ch) => ch.criteria.length > 0);
  setSplit(c, children);
});

Given("a coding model that proposes a split of {int} children that otherwise covers every criterion once", function (count: number) {
  const c = ctx(this);
  const all = c.criteria.map((_, i) => i + 1);
  const children: ChildRow[] = Array.from({ length: count }, (_, k) => ({
    title: `Part ${k + 1}`,
    // Criteria go round-robin, so each goes to exactly one child, and any child past the last criterion takes none.
    criteria: all.filter((i) => (i - 1) % count === k),
    needs: k === 0 ? [] : [k],
  }));
  setSplit(c, children);
});

Given("a coding model that proposes a split whose second child has no title", function () {
  const c = ctx(this);
  const children = validSplit();
  delete children[1].title;
  setSplit(c, children);
});

Given("a coding model that proposes this split:", function (table: DataTable) {
  const c = ctx(this);
  const rows = table.hashes().sort((a, b) => Number(a.child) - Number(b.child));
  setSplit(c, rows.map((r) => ({ title: r.title, criteria: indices(r.criteria), needs: indices(r.needs) })));
});

Given("a coding model that proposes a valid split except that child {int} gives no list of what it needs", function (child: number) {
  const c = ctx(this);
  const children = validSplit();
  delete children[child - 1].needs;
  setSplit(c, children);
});

Given("a coding model that answers {string}", function (text: string) {
  ctx(this).reply = text;
});

Given("a coding model whose run fails", function () {
  ctx(this).reply = null;
});

// --- Gating --------------------------------------------------------------------------------------------------------

When("the factory builds the readiness judge's instructions for the parent item", async function () {
  const c = ctx(this);
  const dor = await loadPolicy(async (p) => files(this).get(p) ?? null, "dor");
  assert.ok(dor && c.itemId);
  const item = await c.fake.adapter.getItem(c.itemId);
  assert.ok(item);
  c.prompt = judgePrompt(item, dor);
});

When("the readiness gate checks the parent item", async function () {
  await runGate(this);
});

Given("the readiness gate has checked the parent item once", async function () {
  await runGate(this);
  checked(ctx(this));
});

Given("the repo's dor.md has since changed", function () {
  const c = ctx(this);
  const f = files(this);
  f.set(".factory/dor.md", `${f.get(".factory/dor.md") ?? ""}\nThe team reviewed this list.\n`);
  c.readinessSha = "policy-2";
  // PBI 202 runs PBI 144's poll harness after this step, so its repo's dor.md changes too when that harness is in use.
  const w = this as { pbi144?: { dor: string } };
  if (w.pbi144) w.pbi144.dor = `${w.pbi144.dor}\nThe team reviewed this list.\n`;
});

Given("the parent item's body has since changed", async function () {
  const c = ctx(this);
  c.body = `${c.body} The order summary stays on screen while a shopper pays.`;
  // A later updatedAt than the first gate's, so the edit can't land in the same millisecond.
  await seedParent(c, new Date(Date.now() + 60_000).toISOString());
});

When("the readiness gate checks the parent item again with its text unchanged", async function () {
  await runGate(this);
});

When("the readiness gate checks the parent item again", async function () {
  await runGate(this);
});

// --- The judge's instructions --------------------------------------------------------------------------------------

Then("the instructions ask for a last line that carries both {string} and {string}", function (a: string, b: string) {
  const prompt = ctx(this).prompt;
  assert.ok(prompt, "no instructions were built");
  const lines = prompt.split("\n").filter((l) => /last line/i.test(l));
  assert.ok(lines.some((l) => l.includes(`"${a}"`) && l.includes(`"${b}"`)), `no "last line" instruction names both "${a}" and "${b}":\n${lines.join("\n")}`);
});

Then("the instructions say {string} is true or false", function (key: string) {
  const prompt = ctx(this).prompt;
  assert.ok(prompt, "no instructions were built");
  const lines = prompt.split("\n").filter((l) => l.includes(`"${key}"`));
  assert.ok(lines.some((l) => /\btrue\b/.test(l) && /\bfalse\b/.test(l)), `no line says "${key}" is true or false:\n${lines.join("\n")}`);
});

// --- Readiness -----------------------------------------------------------------------------------------------------

Then("the gate reads the parent item as oversized", function () {
  assert.equal(checked(ctx(this)).oversized, true);
});

Then("the gate reads the parent item as not oversized", function () {
  assert.equal(checked(ctx(this)).oversized, false);
});

Then("the parent item is ready", function () {
  assert.equal(checked(ctx(this)).ready, true);
});

Then("the parent item is not ready", function () {
  assert.equal(checked(ctx(this)).ready, false);
});

Then("no readiness check in the results mentions the item's size", function () {
  const { results } = checked(ctx(this));
  const sized = results.filter((r) => /oversi[sz]ed|\bsize\b|too big|sprint|split/i.test(`${r.criterion} ${r.reason}`));
  assert.deepEqual(sized, [], "a readiness check mentions the item's size");
});

Then("the only failed readiness check is {string}", function (criterion: string) {
  const failed = checked(ctx(this)).results.filter((r) => r.status !== "passed");
  assert.deepEqual(failed.map((r) => r.criterion), [criterion]);
});

Then("the only failed readiness check is the flag {string}", function (flag: string) {
  const failed = checked(ctx(this)).results.filter((r) => r.status !== "passed");
  assert.equal(failed.length, 1, `failed checks: ${JSON.stringify(failed)}`);
  assert.ok(failed[0].reason.includes(flag), `the failed check doesn't name "${flag}": ${failed[0].reason}`);
});

// --- The request for a split ---------------------------------------------------------------------------------------

Then("the coding model is not asked for a split", function () {
  checked(ctx(this));
  assert.equal(ctx(this).requests.length, 0);
});

Then("the coding model is asked once for a split of the parent item", function () {
  const c = ctx(this);
  const r = request(c);
  assert.ok(r.prompt.includes(c.title!), "the request doesn't name the parent item");
  for (const text of c.criteria) assert.ok(r.prompt.includes(text), `the request doesn't carry the criterion "${text}"`);
});

Then("the request asks for {int} to {int} child items", function (min: number, max: number) {
  const r = request(ctx(this));
  assert.ok(r.prompt.includes(`${min} to ${max}`), `the request doesn't ask for ${min} to ${max} children:\n${r.prompt}`);
});

Then("the request asks each child for a title, a body naming {string} and spec section {string}, and the indices of the parent's criteria it takes", function (title: string, section: string) {
  const r = request(ctx(this));
  for (const word of ["title", "body", "criteria", title, section]) assert.ok(r.prompt.includes(word), `the request doesn't mention "${word}":\n${r.prompt}`);
  assert.match(r.prompt, /\bind(ex|ices)\b/i, "the request doesn't ask for the criteria's indices");
});

Then("the request asks each child to name which earlier children it needs", function () {
  const r = request(ctx(this));
  assert.match(r.prompt, /"needs"/, "the request doesn't ask for a needs list");
  assert.match(r.prompt, /\bearlier\b/i, "the request doesn't say a child needs only earlier children");
});

Then("the split is asked of {string}", function (model: string) {
  assert.equal(request(ctx(this)).model, model);
});

// --- Comments and the split's outcome ------------------------------------------------------------------------------

Then("the parent item has no split proposal comment", async function () {
  assert.deepEqual((await comments(ctx(this))).proposals, []);
});

Then("the parent item has one split proposal comment", async function () {
  await proposal(ctx(this));
});

Then("the parent item has two split proposal comments", async function () {
  assert.equal((await comments(ctx(this))).proposals.length, 2);
});

Then("the parent item has one readiness comment", async function () {
  await readinessComment(ctx(this));
});

Then("the readiness comment quotes {string} word for word", async function (line: string) {
  const body = await readinessComment(ctx(this));
  assert.ok(body.includes(line), `the readiness comment doesn't quote "${line}":\n${body}`);
});

Then(/^the readiness result says a split couldn't be proposed because (.+)$/, function (reason: string) {
  const { split } = checked(ctx(this));
  assert.ok(split, "the result carries no split outcome");
  assert.equal(split.proposed, false, "the result says a split was proposed");
  assert.ok(!split.proposed && split.reason.includes(reason), `the reason doesn't say "${reason}": ${split.proposed ? "" : split.reason}`);
});

Then(/^the readiness comment says a split couldn't be proposed because (.+)$/, async function (reason: string) {
  const body = await readinessComment(ctx(this));
  assert.ok(body.toLowerCase().includes(NO_SPLIT), `the readiness comment doesn't say a ${NO_SPLIT}:\n${body}`);
  assert.ok(body.includes(reason), `the readiness comment doesn't say "${reason}":\n${body}`);
});

Then("the readiness comment doesn't say a split couldn't be proposed", async function () {
  const body = await readinessComment(ctx(this));
  assert.ok(!body.toLowerCase().includes(NO_SPLIT), `the readiness comment says a ${NO_SPLIT}:\n${body}`);
});

// Each child's section runs from its title's first appearance to the next child's. Children are listed in order, and
// a child only needs earlier ones, so a title first appears as its own child's heading.
function sections(body: string, children: string[]): Map<string, string> {
  const starts = children.map((t) => {
    const at = body.indexOf(t);
    assert.ok(at >= 0, `the proposal doesn't list child "${t}":\n${body}`);
    return at;
  });
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] > starts[i - 1], `the proposal doesn't list its children in order:\n${body}`);
  return new Map(children.map((t, i) => [t, body.slice(starts[i] + t.length, starts[i + 1] ?? body.length)]));
}

async function listsChild(world: object, title: string, criteria: string[], needs: string[]): Promise<void> {
  const c = ctx(world);
  const body = await proposal(c);
  const reply = JSON.parse(c.reply!) as { children: SplitChild[] };
  const titles = reply.children.map((ch) => ch.title);
  const section = sections(body, titles).get(title);
  assert.ok(section !== undefined, `no child "${title}" in the scripted split`);
  for (const text of criteria) assert.ok(section.includes(text), `child "${title}" doesn't list "${text}" word for word:\n${section}`);
  for (const text of c.criteria.filter((t) => !criteria.includes(t))) assert.ok(!section.includes(text), `child "${title}" lists "${text}", which isn't its own`);
  for (const other of titles.filter((t) => t !== title)) {
    assert.equal(section.includes(other), needs.includes(other), `child "${title}" ${needs.includes(other) ? "doesn't say it needs" : "says it needs"} "${other}":\n${section}`);
  }
}

Then("the proposal lists child {string} with criteria {string} and {string}, needing nothing", async function (title: string, a: string, b: string) {
  await listsChild(this, title, [a, b], []);
});

Then("the proposal lists child {string} with criterion {string}, needing {string}", async function (title: string, a: string, need: string) {
  await listsChild(this, title, [a], [need]);
});

Then("the proposal lists child {string} with criterion {string}, needing {string} and {string}", async function (title: string, a: string, n1: string, n2: string) {
  await listsChild(this, title, [a], [n1, n2]);
});
