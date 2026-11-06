import { Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Steps record and Thens assert. src/risk/shadow.ts loads lazily, so while it doesn't exist every scenario fails on
// its Then. The fake agent answers the classifier's two passes: the first with {"tier","reason"} when the scenario's
// answer is a tier and with the raw answer otherwise, the second with {"needsPerson":false}.
const repo = process.cwd();
const TIERS = ["Low", "Medium", "High"];

type Verdict = { index: number; criterion: string; status: "passed" | "failed" | "person"; reason: string };
type Result = { tier: string; reasons: string[] };
type Shadow = { classifyRisk: (diff: string, files: string[], ctx: Record<string, unknown>) => Promise<Result> };
type Ctx = { risk: string; answer: string; sensitive: string[]; dod: Verdict[]; result?: Result; ran: boolean; prBody?: string };

function ctx(world: object): Ctx {
  const w = world as { pbi20?: Ctx };
  w.pbi20 ??= { risk: "Low: docs and tests only.\nMedium: ordinary code.\nHigh: payments and auth.", answer: "Low", sensitive: [], dod: [], ran: false };
  return w.pbi20;
}

async function load<T>(path: string): Promise<T | null> {
  const file = join(repo, path);
  return existsSync(file) ? ((await import(pathToFileURL(file).href)) as T) : null;
}

function fakeAgent(answer: string) {
  let calls = 0;
  return async (a: { prompt: string; model: string }) => {
    calls++;
    const text = calls > 1 ? JSON.stringify({ needsPerson: false }) : TIERS.includes(answer) ? JSON.stringify({ tier: answer, reason: "the fake classifier's call" }) : answer;
    return { ok: true, text, costUsd: 0, tokensIn: 0, tokensOut: 0, model: a.model, limit: null, usage: null, transcript: "" };
  };
}

Given("the repo's risk.md says {string}", function (text: string) {
  ctx(this).risk = text;
});

Given("the classifier answers {string}", function (answer: string) {
  ctx(this).answer = answer;
});

Given("the repo config lists {string} as a sensitive path", function (glob: string) {
  ctx(this).sensitive.push(glob);
});

Given("the DoD check left {string} for a person", function (line: string) {
  const c = ctx(this);
  c.dod.push({ index: c.dod.length + 1, criterion: line, status: "person", reason: "only a person can check this" });
});

Given("the DoD check passed {string}", function (line: string) {
  const c = ctx(this);
  c.dod.push({ index: c.dod.length + 1, criterion: line, status: "passed", reason: "checked by the cell" });
});

When("a PR that changes {string} is classified", async function (file: string) {
  const c = ctx(this);
  const mod = await load<Shadow>("src/risk/shadow.ts");
  if (!mod) return;
  c.ran = true;
  c.result = await mod.classifyRisk(`diff --git a/${file} b/${file}\n+changed\n`, [file], {
    sop: { sop: "default", version: "0.1.0", models: { coding: "claude-sonnet-5-5", triage: "claude-haiku-5-5" }, stages: [] },
    config: { sensitivePaths: c.sensitive, reviewers: [], webTools: [], bdd: { parse: "", run: "", report: "" }, commands: { test: "", lint: "" } },
    risk: { name: "risk", source: "repo", sha: "test", text: c.risk, criteria: [] },
    dodVerdicts: c.dod,
    agent: fakeAgent(c.answer),
  });
});

function result(c: Ctx): Result {
  assert.ok(c.ran, "src/risk/shadow.ts doesn't exist");
  assert.ok(c.result, "classifyRisk returned nothing");
  return c.result;
}

Then("its tier is {string}", function (tier: string) {
  const r = result(ctx(this));
  assert.equal(r.tier, tier, `reasons: ${JSON.stringify(r.reasons)}`);
});

Then("its reasons name {string}", function (file: string) {
  const r = result(ctx(this));
  assert.ok(r.reasons.some((x) => x.includes(file)), `no reason names ${file}: ${JSON.stringify(r.reasons)}`);
});

Then("its reasons include {string}", function (text: string) {
  const r = result(ctx(this));
  assert.ok(r.reasons.some((x) => x.includes(text)), `no reason says ${text}: ${JSON.stringify(r.reasons)}`);
});

// AC-3 goes through the cell engine's open-pr stage, which PBI 14 (#18) builds. Until it merges these steps find no
// engine, so the scenario fails on its Then; Green rewrites the When against the engine's open-pr.
When("the cell opens the PR for an item whose change touches {string}", async function (_file: string) {
  const c = ctx(this);
  c.ran = (await load<object>("src/cell/engine.ts")) !== null;
});

Then("the PR body has a {string} section saying {string}", function (heading: string, tier: string) {
  const c = ctx(this);
  assert.ok(c.ran, "src/cell/engine.ts doesn't exist yet: it comes with PBI 14 (#18)");
  assert.match(c.prBody ?? "", new RegExp(`#+ ${heading}[\\s\\S]*${tier}`), `no ${heading} section saying ${tier}`);
});

Then("that section lists the reason naming {string}", function (file: string) {
  assert.ok((ctx(this).prBody ?? "").includes(file), `the PR body doesn't name ${file}`);
});
