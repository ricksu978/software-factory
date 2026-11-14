import { Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { BacklogAdapter, FactoryItem } from "../../src/adapters/types.ts";
import { putNotReady } from "./pbi-131.steps.ts";

// The repo is an in-memory file map behind `read`, the item lives in the fake backlog, and the judge is scripted.
// Modules load lazily, so while they don't exist every scenario fails on its Then instead of crashing the run.
const repo = process.cwd();

type Criterion = { index: number; text: string; run: string | null };
type Policy = { source: string; criteria: Criterion[] };
type Verdict = { index: number; criterion: string; status: string; reason: string };
type PolicyModule = { loadPolicy?: (read: (path: string) => Promise<string | null>, name: string) => Promise<Policy | null> };
type GateModule = {
  gate?: (item: FactoryItem, ctx: {
    readinessSha: string; dor: Policy | null; dodExists: boolean; configValid: boolean; repoKnown: boolean;
    judge: Judge; adapter: BacklogAdapter; recordCheck?: RecordCheck; now?: () => Date;
  }) => Promise<{ ready: boolean; results: Verdict[] }>;
};
/** PBI 132: the judge hears what each call spent, and the gate records each call as a readiness check. */
export type Spend = { model: string; tokensIn: number; tokensOut: number; costUsd: number };
export type Judge = (item: FactoryItem, dor: Policy, spent?: (s: Spend) => void) => Promise<string>;
export type RecordCheck = (item: FactoryItem, check: Spend & { ranAt: Date }) => Promise<void>;
type Fake = { adapter: BacklogAdapter; seed(item: Partial<FactoryItem>): Promise<string>; comments(id: string): Promise<string[]> };

export type Ctx = {
  files: Map<string, string>;
  fake?: Fake;
  itemId?: string;
  judge?: Judge;
  /** Set by PBI 132's steps. */
  recordCheck?: RecordCheck;
  now?: () => Date;
  outcome?: { ready: boolean; results: Verdict[] };
  policy?: Policy | null;
  error?: unknown;
};

export function ctx(world: object): Ctx {
  const w = world as { pbi13?: Ctx };
  w.pbi13 ??= { files: new Map() };
  return w.pbi13;
}

async function load<T>(path: string): Promise<T | null> {
  const file = join(repo, path);
  return existsSync(file) ? ((await import(pathToFileURL(file).href)) as T) : null;
}

const read = (c: Ctx) => async (path: string) => c.files.get(path) ?? null;

export async function item(c: Ctx, partial: Partial<FactoryItem>): Promise<void> {
  const mod = await load<{ fakeBacklog: () => Fake }>("src/adapters/fake.ts");
  if (!mod) return;
  c.fake = mod.fakeBacklog();
  c.itemId = await c.fake.seed(partial);
}

// One JSON line per criterion, then the flags line, the reply shape Run contract 11 and plan Task 9 set.
function scriptedJudge(failIndex: number | null, reason: string, flags: string[]) {
  return async (_item: FactoryItem, dor: Policy) =>
    [
      ...dor.criteria.map((cr) =>
        JSON.stringify({ index: cr.index, status: cr.index === failIndex ? "failed" : "passed", reason: cr.index === failIndex ? reason : "ok" }),
      ),
      JSON.stringify({ flags }),
    ].join("\n");
}

function checked(c: Ctx): { ready: boolean; results: Verdict[] } {
  assert.equal(c.error, undefined, `the gate failed: ${String(c.error)}`);
  assert.ok(c.outcome, "the readiness gate didn't run");
  return c.outcome;
}

function loaded(c: Ctx): Policy {
  assert.equal(c.error, undefined, `loading failed: ${String(c.error)}`);
  assert.ok(c.policy, "no policy was loaded");
  return c.policy;
}

Given("a repo whose {string} holds the single line {string}", function (path: string, line: string) {
  ctx(this).files.set(path, `- [ ] ${line}\n`);
});

Given("a repo with no {string}", function (path: string) {
  ctx(this).files.delete(path);
});

Given("an item in that repo whose readiness field {string} is {string}", async function (field: string, value: string) {
  await item(ctx(this), { fields: { [field]: value } });
});

Given("an item in that repo whose body says {string}", async function (body: string) {
  await item(ctx(this), { body });
});

Given("a judge that fails line {int} because {string}", function (index: number, reason: string) {
  ctx(this).judge = scriptedJudge(index, reason, []);
});

Given("a judge that passes every line", function () {
  ctx(this).judge = scriptedJudge(null, "", []);
});

Given("a judge that passes every line and flags {string}", function (flag: string) {
  ctx(this).judge = scriptedJudge(null, "", [flag]);
});

/** One run of the gate over the item as the fake backlog holds it now. PBI 132 runs it more than once. */
export async function checkItem(world: object): Promise<void> {
  const c = ctx(world);
  const policy = await load<PolicyModule>("src/policy/policy.ts");
  const gate = await load<GateModule>("src/gate/readiness.ts");
  if (!policy?.loadPolicy || !gate?.gate || !c.fake || !c.itemId || !c.judge) return;
  c.outcome = undefined;
  c.error = undefined;
  try {
    const dor = await policy.loadPolicy(read(c), "dor");
    const found = await c.fake.adapter.getItem(c.itemId);
    assert.ok(found);
    c.outcome = await gate.gate(found, {
      readinessSha: "scenario", dor, dodExists: true, configValid: true, repoKnown: true, judge: c.judge, adapter: c.fake.adapter,
      ...(c.recordCheck ? { recordCheck: c.recordCheck } : {}), ...(c.now ? { now: c.now } : {}),
    });
  } catch (e) {
    c.error = e;
  }
}

When("the readiness gate checks the item", async function () {
  await checkItem(this);
});

When("the factory loads the {string} policy from that repo", async function (name: string) {
  const c = ctx(this);
  const policy = await load<PolicyModule>("src/policy/policy.ts");
  if (!policy?.loadPolicy) return;
  try {
    c.policy = await policy.loadPolicy(read(c), name);
  } catch (e) {
    c.error = e;
  }
});

Then("the item is not ready", async function () {
  // PBI 131 sets an item up as not ready with the same words.
  if (await putNotReady(this)) return;
  assert.equal(checked(ctx(this)).ready, false);
});

Then("the item is ready", function () {
  assert.equal(checked(ctx(this)).ready, true);
});

Then("the item has one comment, which quotes {string} word for word", async function (line: string) {
  const c = ctx(this);
  checked(c);
  const comments = await c.fake!.comments(c.itemId!);
  assert.equal(comments.length, 1);
  assert.ok(comments[0].includes(line), `the comment doesn't quote "${line}":\n${comments[0]}`);
});

Then("the item has no comment", async function () {
  const c = ctx(this);
  checked(c);
  assert.deepEqual(await c.fake!.comments(c.itemId!), []);
});

Then("the results include the flag {string}", function (flag: string) {
  const { results } = checked(ctx(this));
  assert.ok(results.some((r) => r.status === "failed" && r.reason.includes(flag)), `no failed result names "${flag}"`);
});

Then("the policy's source is {string}", function (source: string) {
  assert.equal(loaded(ctx(this)).source, source);
});

Then("its criteria are the top-level lines of the factory's {string}", function (path: string) {
  const policy = loaded(ctx(this));
  const lines = readFileSync(join(repo, path), "utf8").split(/\r?\n/).filter((l) => l.startsWith("- [ ] ")).map((l) => l.slice(6).trim());
  assert.ok(lines.length > 0, `${path} has no criteria`);
  assert.deepEqual(policy.criteria.map((cr) => cr.text), lines);
});

Then("its only criterion is {string}", function (text: string) {
  assert.deepEqual(loaded(ctx(this)).criteria.map((cr) => cr.text), [text]);
});

Then("its only criterion runs {string}", function (command: string) {
  const policy = loaded(ctx(this));
  assert.equal(policy.criteria.length, 1);
  assert.equal(policy.criteria[0].run, command);
});

Then("loading fails with {string}", function (message: string) {
  const e = ctx(this).error as Error | undefined;
  assert.ok(e, "loading didn't fail");
  assert.equal(e.message, message);
});
