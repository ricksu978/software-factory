import { Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { runTheCell, setUp } from "./pbi-18.steps.ts";

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

// AC-3 runs the real cell engine through open-pr, on PBI 14's harness: a temporary git repo, a scripted agent and a
// recording repo host. The scripted agent gives the classifier this scenario's answer.
When("the cell opens the PR for an item whose change touches {string}", { timeout: 60_000 }, async function (file: string) {
  const c = ctx(this);
  const run = setUp(this, "open-pr", true);
  run.riskAnswer = c.answer;
  mkdirSync(dirname(join(run.dir, file)), { recursive: true });
  writeFileSync(join(run.dir, file), "changed: true\n");
  execFileSync("git", ["add", "-A"], { cwd: run.dir });
  execFileSync("git", ["commit", "-q", "-m", `change ${file}`], { cwd: run.dir });
  await runTheCell(this);
  c.ran = true;
  assert.equal(run.error, null, `the cell failed: ${String(run.error)}`);
  c.prBody = run.prBodies.at(-1);
});

// The tier section runs from its heading to the next heading or the end of the body.
function tierSection(c: Ctx, heading: string): string {
  assert.ok(c.ran && c.prBody !== undefined, "the cell opened no PR");
  const at = c.prBody.indexOf(`## ${heading}`);
  assert.ok(at >= 0, `the PR body has no "${heading}" section:\n${c.prBody}`);
  const rest = c.prBody.slice(at + 3);
  const end = rest.search(/\n## /);
  return end === -1 ? rest : rest.slice(0, end);
}

Then("the PR body has a {string} section saying {string}", function (heading: string, tier: string) {
  assert.match(tierSection(ctx(this), heading), new RegExp(`\\*\\*${tier}\\*\\*`));
});

Then("that section lists the reason naming {string}", function (file: string) {
  const section = tierSection(ctx(this), "Shadow risk tier");
  assert.ok(section.split("\n").some((l) => l.startsWith("- ") && l.includes(file)), `no reason names ${file}:\n${section}`);
});
