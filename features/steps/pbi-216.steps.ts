// Step definitions for features/pbi-216-pr-body-chatter.feature. Every scenario runs the engine through PBI 18's
// harness, from PBI 142's "a run for item 482 that resumes at open-pr", whose repo host has no review methods, so no
// PR review stage runs. A scenario that names the PR reviewer installs PBI 128's fake repo host, CI and scripted PR
// reviewer and addresser instead, so the PR review stage runs and writes the body again.
//
// The open-pr agent is the open-pr stage's own call: the scripted agent's call while open-pr is the stage started
// last, in "cell" mode (the shadow risk classifier's calls are "judge" mode). It answers with the scenario's replies
// in order, the last one for every call after them. Its prompts are its briefs.
//
// The "summary part" of a PR body is what comes before the factory's own "Refs #482" line.
import { Given, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { Ctx as CellCtx } from "./pbi-18.steps.ts";
import { ctx as pr128 } from "./pbi-128.steps.ts";

type Ctx = { replies: string[]; briefs: string[] };

function cell(world: object): CellCtx {
  const w = world as { pbi18?: CellCtx };
  assert.ok(w.pbi18, "no run was set up");
  return w.pbi18;
}

function ctx(world: object): Ctx {
  const w = world as { pbi216?: Ctx };
  if (w.pbi216) return w.pbi216;
  const c: Ctx = { replies: [], briefs: [] };
  w.pbi216 = c;
  const run = cell(world);
  const outer = run.agent;
  run.agent = async (a, base) => {
    if (run.stage === "open-pr" && a.mode !== "judge" && !a.agent && c.replies.length) {
      const k = c.briefs.length;
      c.briefs.push(a.prompt);
      run.agentCalls.push({ stage: run.stage, prompt: a.prompt, agent: a.agent, mode: a.mode });
      const text = c.replies[Math.min(k, c.replies.length - 1)];
      return { ok: true, text, costUsd: 0.5, tokensIn: 10, tokensOut: 5, model: a.model, limit: null, usage: null, transcript: "{}\n" };
    }
    return outer ? outer(a, base) : base(a);
  };
  return c;
}

/** The cell ran without crashing. */
function ran(world: object): CellCtx {
  const run = cell(world);
  assert.equal(run.error, null, `the cell failed: ${run.error instanceof Error ? run.error.stack : String(run.error)}`);
  return run;
}

function summaryPart(body: string): string {
  const at = body.indexOf("Refs #482");
  assert.ok(at >= 0, `the PR body has no "Refs #482" line:\n${body}`);
  return body.slice(0, at).replace(/\s+$/, "");
}

function lastBody(world: object): string {
  const run = ran(world);
  assert.ok(run.prBodies.length > 0, "no PR was opened");
  return run.prBodies.at(-1)!;
}

function openPrReports(world: object): Record<string, any>[] {
  return ran(world).calls.filter((x) => x.route === "/stage" && x.body.stageId === "open-pr").map((x) => x.body);
}

/** The report that ended an open-pr attempt. */
function ended(world: object, attempt: number): Record<string, any> {
  const r = openPrReports(world).filter((s) => s.attempt === attempt && s.status !== "started").at(-1);
  assert.ok(r, `open-pr attempt ${attempt} never ended`);
  return r;
}

const PROBLEM_BODY = "## Problem\n\nOrders over 100 items time out.\n\n## What changes\n\nOrders are saved in batches.";
const mustStart = (text: string) =>
  text.split("\n").some((l) => /must start with/i.test(l) && l.includes("## Problem") && /heading/i.test(l));

// ---- Givens ----

Given("CI passes on every commit", function () {
  // The harness's CI passes on every commit unless a step says otherwise, as PBI 128's does too.
  cell(this);
});

Given("the open-pr agent replies with this summary:", function (text: string) {
  ctx(this).replies = [text];
});

Given("the open-pr agent replies with {string} and the body wrapped in one fenced block, with a line of chatter before it", function (heading: string) {
  assert.ok(PROBLEM_BODY.startsWith(heading));
  ctx(this).replies = [`Here is the PR body:\n\n\`\`\`markdown\n${PROBLEM_BODY}\n\`\`\`\n`];
});

Given("the open-pr agent's first reply is this summary:", function (text: string) {
  ctx(this).replies = [text];
});

Given("the open-pr agent's first reply is {string}", function (text: string) {
  ctx(this).replies = [text];
});

Given("the open-pr agent's second reply starts with {string}", function (heading: string) {
  const c = ctx(this);
  assert.equal(c.replies.length, 1, "the open-pr agent has no first reply");
  assert.ok(PROBLEM_BODY.startsWith(heading));
  c.replies.push(PROBLEM_BODY);
});

Given("the PR reviewer approves on its first review", function () {
  pr128(this).reviews.set(1, { findings: [], verdicts: new Map(), clean: true });
});

// ---- Thens: the PR body ----

Then("the summary part of the PR body is:", function (text: string) {
  assert.equal(summaryPart(lastBody(this)), text);
});

Then("the summary part of the PR body starts with {string}", function (heading: string) {
  const part = summaryPart(lastBody(this));
  assert.ok(part.startsWith(heading), `the summary part of the PR body starts:\n${part.slice(0, 200)}`);
});

Then("no PR was opened with {string} at the start of its body", function (start: string) {
  const bad = ran(this).prBodies.filter((b) => b.startsWith(start));
  assert.equal(bad.length, 0, `a PR body starts with "${start}":\n${bad[0]}`);
});

Then(/^no (?:PR body|body the factory wrote for the PR) holds "([^"]*)"$/, function (text: string) {
  const bad = ran(this).prBodies.filter((b) => b.includes(text));
  assert.equal(bad.length, 0, `a PR body the factory wrote holds "${text}":\n${bad[0]}`);
});

// ---- Thens: the open-pr stage ----
// "the open-pr stage's first attempt ends failed" is PBI 152's "the {word} stage's first attempt ends failed".

Then("the open-pr stage ran {int} attempt(s)", function (n: number) {
  const started = openPrReports(this).filter((s) => s.status === "started");
  assert.equal(started.length, n, `open-pr ran ${started.length} attempts`);
});

Then("the open-pr stage passed", function () {
  const last = openPrReports(this).filter((s) => s.status !== "started").at(-1);
  assert.ok(last, "no open-pr attempt ended");
  assert.equal(last.status, "passed", `open-pr's last attempt, ${last.attempt}, ended ${last.status}: ${last.message ?? ""}`);
});

Then("that attempt's finding says the PR body must start with a {string} heading", function (heading: string) {
  assert.equal(heading, "## Problem");
  const message = String(ended(this, 1).message ?? "");
  assert.ok(mustStart(message), `open-pr's first attempt's message doesn't say the PR body must start with a "## Problem" heading: ${message}`);
});

Then("the open-pr agent's second brief says its last attempt failed because the PR body must start with a {string} heading", function (heading: string) {
  assert.equal(heading, "## Problem");
  ran(this);
  const c = ctx(this);
  assert.ok(c.briefs.length >= 2, `the open-pr agent was briefed ${c.briefs.length} time(s)`);
  const b = c.briefs[1];
  assert.match(b, /last attempt failed/i, "the second brief doesn't say the last attempt failed");
  assert.ok(mustStart(b), `the second brief doesn't say the PR body must start with a "## Problem" heading:\n${b}`);
});

Then("the open-pr agent's second brief tells it to reply with the PR body alone, with nothing before or after it", function () {
  ran(this);
  const c = ctx(this);
  assert.ok(c.briefs.length >= 2, `the open-pr agent was briefed ${c.briefs.length} time(s)`);
  const b = c.briefs[1];
  assert.match(b, /\bPR body alone\b/i, `the second brief doesn't ask for the PR body alone:\n${b}`);
  assert.match(b, /nothing before or after/i, `the second brief doesn't say nothing before or after it:\n${b}`);
});
