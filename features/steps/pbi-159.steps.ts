// Step definitions for features/pbi-159-split-prompt-change.feature. The @ac-1 scenarios compare readinessSha over the
// same repo files with readiness logic that differs only in its split prompt. The @db scenarios reuse PBI 12's poller
// harness and PBI 149's re-check steps. A restart is a new process: new readiness logic in PBI 12's context, a new
// split cache, and, for a new split prompt, a split deps whose prompt carries one word more. The coding model is a
// scripted agent runner that records every request, so a scenario reads the prompt it was asked with.
import { Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { FactoryItem } from "../../src/adapters/types.ts";
import type { AgentArgs, AgentResult } from "../../src/agent/run.ts";
import { SPLIT_HEADING, splitPrompt } from "../../src/gate/split.ts";
import { readinessSha, type ReadinessLogic, type ReadinessTexts } from "../../src/policy/policy.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";
import { baseline, ctx as pollCtx, poll, polled, REPO, setup, stateOf, type Ctx as PollCtx } from "./pbi-12.steps.ts";
import { ctx as ctx149, first, moves, oneWordOff, running } from "./pbi-149.steps.ts";

/** The one word a new split prompt adds, at its end, so it differs by exactly one word whatever the prompt holds. */
const WORD = " Briefly.";

type ChildRow = { title: string; criteria: number[]; needs: number[] };

type Ctx = {
  /** What the coding model answers to any split prompt. */
  reply: string;
  /** What it answers instead when the request carries the new split prompt's wording. */
  replyUnderNew?: string;
  requests: AgentArgs[];
  /** How many requests had been made at the latest restart. */
  requestsAtRestart?: number;
  /** How often the judge had been asked about each item at the first restart. */
  askedAtFirstRestart?: Map<string, number>;
  /** Items by title, for the scenarios that name them. */
  names: Map<string, string>;
  /** Each item's transition count when the setup finished. */
  movesBefore: Map<string, number>;
  /** The item's text when the setup finished. */
  text?: string;
  /** How many times the repo's head has moved. */
  commits: number;
};

function ctx(world: object): Ctx {
  const w = world as { pbi159?: Ctx };
  w.pbi159 ??= { reply: splitReply(validSplit()), requests: [], names: new Map(), movesBefore: new Map(), commits: 0 };
  return w.pbi159;
}

// ---- the fingerprint ----

/** The fingerprint PBI 149 gave: the six repo files, then the judge's prompt and the readiness version, length-prefixed. */
function pbi149Sha(texts: ReadinessTexts, logic: ReadinessLogic): string {
  const hash = createHash("sha256");
  const add = (text: string) => hash.update(`${Buffer.byteLength(text, "utf8")}:`).update(text, "utf8");
  for (const key of ["dor", "scenarios", "pr-review", "risk", "dod", "config"] as const) {
    const text = texts[key];
    if (text === null) hash.update("-;");
    else add(text);
  }
  add(logic.judgePrompt);
  add(String(logic.version));
  return hash.digest("hex");
}

const splitOff = (logic: ReadinessLogic): ReadinessLogic => ({ ...logic, splitPrompt: `${logic.splitPrompt}${WORD}` });

function addSplitOff(world: object): void {
  const base = first(world);
  ctx149(world).checks.push({ texts: { ...base.texts }, logic: splitOff(base.logic) });
}

Given("another that reads the same files with the same judge prompt and readiness version and a split prompt that differs by one word", function () {
  addSplitOff(this);
});

Given("another that reads the same files with the same logic and a split prompt that differs by one word", function () {
  addSplitOff(this);
});

Given("a third that reads the same files with the same logic and that same changed split prompt", function () {
  const checks = ctx149(this).checks;
  assert.equal(checks.length, 2, "the third check needs a first and a second");
  checks.push({ texts: { ...checks[0].texts }, logic: { ...checks[1].logic } });
});

const shaOf = (world: object, n: number): string => {
  const checks = ctx149(world).checks;
  assert.ok(checks.length > n, `no check ${n + 1} was set up`);
  return readinessSha(checks[n].texts, checks[n].logic);
};

Then("its fingerprint differs from the fingerprint of the same files with the judge prompt and readiness version alone", function () {
  const check = first(this);
  const now = readinessSha(check.texts, check.logic);
  assert.notEqual(now, pbi149Sha(check.texts, check.logic), `the check hashes to ${now}, the same as PBI 149's fingerprint`);
});

Then("the second and third checks have the same fingerprint", function () {
  assert.equal(shaOf(this, 1), shaOf(this, 2));
});

Then("the first and second checks have different fingerprints", function () {
  const a = shaOf(this, 0);
  assert.notEqual(a, shaOf(this, 1), `both checks hash to ${a}`);
});

// ---- the coding model ----

function validSplit(): ChildRow[] {
  return [
    { title: "Card payments", criteria: [1, 3], needs: [] },
    { title: "Bank transfers", criteria: [2], needs: [1] },
    { title: "Payment receipts", criteria: [4], needs: [1, 2] },
  ];
}

const splitReply = (children: ChildRow[]): string =>
  JSON.stringify({ children: children.map((ch) => ({ ...ch, body: 'Part of "Checkout redesign", spec section §7.2.' })) });

function agent(c: Ctx) {
  return async (a: AgentArgs): Promise<AgentResult> => {
    c.requests.push(a);
    const text = c.replyUnderNew !== undefined && a.prompt.endsWith(WORD) ? c.replyUnderNew : c.reply;
    return { ok: true, text, costUsd: 0, tokensIn: 0, tokensOut: 0, model: a.model, limit: null, usage: null, transcript: "" };
  };
}

Given("the coding model proposes a valid split", function () {
  ctx(this).reply = splitReply(validSplit());
});

Given("under that prompt the coding model proposes children {string} and {string}", function (a: string, b: string) {
  ctx(this).replyUnderNew = splitReply([{ title: a, criteria: [1, 3], needs: [] }, { title: b, criteria: [2, 4], needs: [1] }]);
});

Given("under that prompt the coding model proposes a split which leaves criterion {int} to no child", function (index: number) {
  const children = validSplit().map((ch) => ({ ...ch, criteria: ch.criteria.filter((i) => i !== index) })).filter((ch) => ch.criteria.length > 0);
  ctx(this).replyUnderNew = splitReply(children);
});

// ---- the setups ----

Before({ tags: "@pbi-159 and @db", ...long }, async function () {
  const d = await testDb();
  if (d) await d.pool.query('truncate item, backlog_source, repo, "user" cascade');
});

const itemText = (fi: FactoryItem) => JSON.stringify([fi.title, fi.body, fi.acceptanceCriteria]);

async function transitions(c: PollCtx, ext: string): Promise<number> {
  const r = await need().pool.query<{ n: number }>(
    `select count(*)::int as n from event e join item i on i.id = e.item_id
     where i.source_id = $1 and i.external_id = $2 and e.kind = 'transition'`,
    [c.sourceId, ext],
  );
  return r.rows[0].n;
}

/** Counts every later Then from here: the judge's asks, each item's comments and moves, the repo and the item's text. */
async function settle(world: object, c: PollCtx): Promise<void> {
  const k = ctx(world);
  c.asked.clear();
  for (const ext of c.extIds) {
    ctx149(world).commentsBefore.set(ext, (await c.fake!.comments(ext)).length);
    k.movesBefore.set(ext, await transitions(c, ext));
  }
  c.baseline = await baseline(c);
  const item = await c.fake!.adapter.getItem(c.extIds[0]);
  k.text = item ? itemText(item) : undefined;
}

/** Polls the items in `exts` into `state`. False when the harness has no poller or database. */
async function gateInto(c: PollCtx, exts: string[], state: string): Promise<boolean> {
  await poll(c);
  if (c.polls === 0) return false;
  polled(c);
  for (const ext of exts) assert.equal(await stateOf(c, ext), state, "setup didn't reach the expected state");
  return true;
}

async function proposals(c: PollCtx, ext: string): Promise<string[]> {
  return (await c.fake!.comments(ext)).filter((b) => b.startsWith(SPLIT_HEADING));
}

Given("the factory holds an oversized item in state {string} that already has one split proposal comment", long, async function (state: string) {
  const c = pollCtx(this);
  if (!(await setup(c))) return;
  const k = ctx(this);
  c.extIds = [await c.fake!.seed({
    title: "Checkout redesign", body: "Redesign the checkout so a shopper can pay more ways. See spec section §7.2.",
    acceptanceCriteria: ["A shopper can pay by card", "A shopper can pay by bank transfer", "A card payment shows its last four digits", "Every payment sends a receipt"],
    labels: ["factory"], repo: REPO,
  })];
  c.judge = "fail";
  c.failLine = undefined;
  c.oversized = true;
  c.split = { sop: { models: { coding: "coding-model" } }, agent: agent(k), seen: new Map() };
  if (!(await gateInto(c, c.extIds, state))) return;
  assert.equal((await proposals(c, c.extIds[0])).length, 1, "setup didn't post one split proposal");
  await settle(this, c);
});

Given("the factory holds an item {string} in state {string}, checked against the repo's current readiness files", long, async function (name: string, state: string) {
  const c = pollCtx(this);
  if (!(await setup(c))) return;
  const ext = await c.fake!.seed({ title: name, labels: ["factory"], repo: REPO });
  ctx(this).names.set(name, ext);
  c.extIds = [...c.extIds, ext];
  c.judge = "fail";
  if (await gateInto(c, [ext], state)) await settle(this, c);
});

Given("the factory holds an item {string} in state {string}", long, async function (name: string, state: string) {
  const c = pollCtx(this);
  if (!(await setup(c))) return;
  const ext = await c.fake!.seed({ title: name, labels: ["factory"], repo: REPO });
  ctx(this).names.set(name, ext);
  c.extIds = [...c.extIds, ext];
  const was = c.judge;
  c.judge = "pass";
  const ok = await gateInto(c, [ext], state);
  c.judge = was;
  if (ok) await settle(this, c);
});

async function nothingChanged(world: object): Promise<void> {
  const c = pollCtx(world);
  polled(c);
  assert.ok(c.baseline, "the setup recorded no baseline to compare against");
  assert.deepEqual(await baseline(c), c.baseline, "an item or a repo's readiness files changed after the setup");
}

Given("neither the item nor the repo's readiness files change", long, async function () {
  await nothingChanged(this);
});

Given("neither the items nor either repo's readiness files change", long, async function () {
  await nothingChanged(this);
});

Given("the item's text doesn't change", long, async function () {
  const c = pollCtx(this);
  polled(c);
  const item = await c.fake!.adapter.getItem(c.extIds[0]);
  assert.ok(item, "the item isn't on the board");
  assert.equal(itemText(item), ctx(this).text, "the item's text changed after the setup");
});

Given("the readiness judge still fails line {int} because {string} and still reports the item oversized", function (index: number, reason: string) {
  const c = pollCtx(this);
  Object.assign(c, { judge: "fail", failLine: { index, reason }, oversized: true });
});

Given("the readiness judge still fails every line and still reports the item oversized", function () {
  const c = pollCtx(this);
  Object.assign(c, { judge: "fail", failLine: undefined, oversized: true });
});

Given("the readiness judge still fails every line but now reports the item not oversized", function () {
  const c = pollCtx(this);
  Object.assign(c, { judge: "fail", failLine: undefined, oversized: false });
});

/** A new commit on the repo's default branch whose dor.md has one more line of text and no new criterion. */
When("the repo's dor.md changes", function () {
  const c = pollCtx(this);
  if (!c.host) return;
  const k = ctx(this);
  const head = c.host.heads.get(REPO);
  const next = `dor-${++k.commits}`;
  const prefix = `${REPO}@${head}:`;
  for (const [key, text] of [...c.host.files]) {
    if (!key.startsWith(prefix)) continue;
    const path = key.slice(prefix.length);
    c.host.files.set(`${REPO}@${next}:${path}`, path === ".factory/dor.md" ? `${text}\nEdited by the team, round ${k.commits}.\n` : text);
  }
  c.host.heads.set(REPO, next);
});

// ---- restarts ----

/** A restart is a new process: it keeps the board and the database, and starts with no split cache. */
function restart(world: object, logic: ReadinessLogic, prompt?: (item: FactoryItem) => string): void {
  const c = pollCtx(world);
  const k = ctx(world);
  c.logic = logic;
  if (c.split) c.split = { ...c.split, seen: new Map(), ...(prompt ? { prompt } : {}) };
  k.requestsAtRestart = k.requests.length;
  k.askedAtFirstRestart ??= new Map(c.asked);
}

Given("the factory restarts with a split prompt that differs by one word", function () {
  restart(this, splitOff(running(pollCtx(this))), (item) => `${splitPrompt(item)}${WORD}`);
});

Given("the factory restarts with a judge prompt that differs by one word and the same split prompt", function () {
  restart(this, oneWordOff(running(pollCtx(this))));
});

When("the factory restarts again with the same split prompt, judge prompt and readiness version", function () {
  restart(this, { ...running(pollCtx(this)) });
});

// ---- Thens ----

function one(world: object): { c: PollCtx; ext: string } {
  const c = pollCtx(world);
  polled(c);
  assert.equal(c.extIds.length, 1, `the scenario holds ${c.extIds.length} items`);
  return { c, ext: c.extIds[0] };
}

function named(world: object, name: string): { c: PollCtx; ext: string } {
  const c = pollCtx(world);
  polled(c);
  const ext = ctx(world).names.get(name);
  assert.ok(ext, `no item "${name}" was set up`);
  return { c, ext };
}

Then("the history of {string} shows one move {string}", long, async function (name: string, event: string) {
  const { c, ext } = named(this, name);
  assert.equal(await moves(c, ext, event), 1);
});

Then("the history of {string} shows no new move", long, async function (name: string) {
  const { c, ext } = named(this, name);
  assert.equal(await transitions(c, ext), ctx(this).movesBefore.get(ext));
});

Then("the readiness judge was not asked about {string}", function (name: string) {
  const { c, ext } = named(this, name);
  assert.equal(c.asked.get(ext) ?? 0, 0);
});

Then("the readiness judge was asked about the item once since the first restart", function () {
  const { c, ext } = one(this);
  const before = ctx(this).askedAtFirstRestart;
  assert.ok(before, "the factory never restarted");
  assert.equal((c.asked.get(ext) ?? 0) - (before.get(ext) ?? 0), 1);
});

Then("the board item has one split proposal comment", async function () {
  const { c, ext } = one(this);
  assert.equal((await proposals(c, ext)).length, 1);
});

Then("the board item has two split proposal comments", async function () {
  const { c, ext } = one(this);
  assert.equal((await proposals(c, ext)).length, 2);
});

function sinceRestart(world: object): AgentArgs[] {
  one(world);
  const k = ctx(world);
  assert.ok(k.requestsAtRestart !== undefined, "the factory never restarted");
  return k.requests.slice(k.requestsAtRestart);
}

Then("the coding model was asked for a split of the item once since the restart", function () {
  assert.equal(sinceRestart(this).length, 1);
});

Then("the coding model was not asked for a split since the restart", function () {
  assert.equal(sinceRestart(this).length, 0);
});

Then("that request carries the new split prompt's wording", async function () {
  const [request] = sinceRestart(this);
  assert.ok(request, "the coding model wasn't asked since the restart");
  const { c, ext } = one(this);
  const item = await c.fake!.adapter.getItem(ext);
  assert.ok(item);
  assert.equal(request.prompt, `${splitPrompt(item)}${WORD}`);
});

Then("the newest split proposal comment lists children {string} and {string}", async function (a: string, b: string) {
  const { c, ext } = one(this);
  const newest = (await proposals(c, ext)).at(-1);
  assert.ok(newest, "the item has no split proposal comment");
  const titles = [...newest.matchAll(/^### \d+\. (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(titles, [a, b], `the newest proposal lists ${JSON.stringify(titles)}:\n${newest}`);
});

Then("the board item has a new readiness comment saying a split couldn't be proposed because criterion {int} goes to no child", async function (index: number) {
  const { c, ext } = one(this);
  const fresh = (await c.fake!.comments(ext)).slice(ctx149(this).commentsBefore.get(ext) ?? 0);
  const text = `a split couldn't be proposed because criterion ${index} goes to no child`;
  assert.ok(fresh.some((body) => body.includes(text)), `no new comment says "${text}":\n${fresh.join("\n---\n")}`);
});
