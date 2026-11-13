// Step definitions for features/pbi-18-cell-engine.feature. Each scenario runs the engine in a real temporary git
// repo, cloned from a bare origin, against a recording cell API, a scripted agent and a fake repo host.
import { After, Given, Then, When } from "@cucumber/cucumber";
import type { DataTable } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { next, type ItemEvent } from "../../src/core/states.ts";
import { runMeteredCell } from "./pbi-132.steps.ts";
import { parseCriteria, type Policy, type PolicyName } from "../../src/policy/policy.ts";

const repo = process.cwd();
const BRANCH = "factory/pbi-482-r1";
const FEATURE = "features/pbi-482.feature";

type Call = { route: string; body: Record<string, any> };
type AgentCall = { stage: string; prompt: string; agent?: string; mode: string; webTools?: string[] };
type Scenario = { name: string; tags: string[] };

export type Ctx = {
  root: string; origin: string; dir: string; fixtures: string;
  /** What the fake risk classifier answers at open-pr (PBI 16): a tier, or anything else as unreadable text. */
  riskAnswer: string;
  criteria: number; nextStage: string; decision: { kind: string; text: string } | null;
  lockSha: string | null; lockedFiles: string[]; prNumber: number | null; startHead: string;
  scenarios: Scenario[]; skipCriterion: number | null; greenAtRed: boolean; editLockAtRed: boolean;
  dod: string; dodJudged: Map<string, string>; trusted: { author: string; body: string }[]; stranger: { author: string; body: string }[];
  ciOldOnly: boolean; secrets: Record<string, string | undefined> | null;
  calls: Call[]; agentCalls: AgentCall[]; stage: string; prBodies: string[]; result: string | null; error: unknown;
  /** Replaces the default repo host, as PBI 142's steps do to hold a merged PR or to fail a call. */
  repoHost?: Record<string, unknown>;
  /** Replaces the cell API's answer about CI, as PBI 142's steps do to fail it. */
  checks?: (sha: string) => Promise<string>;
  /** Extra fields for the cell's context, as PBI 140's steps add to resume a stage a restart cut short. */
  context?: Record<string, unknown>;
  /** Wraps the scripted agent, as PBI 128's steps do to script the PR reviewer and the PR addresser. */
  wrapAgent?: (base: (a: any) => Promise<any>) => (a: any) => Promise<any>;
  /** Wraps the scripted agent, as PBI 152's steps do to script each stage's calls. `base` is the default agent. */
  agent?: (a: any, base: (a: any) => Promise<any>) => Promise<any>;
};

function ctx(world: object): Ctx {
  const w = world as { pbi18?: Ctx };
  assert.ok(w.pbi18, "no run was set up");
  return w.pbi18;
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const fwd = (p: string) => p.replace(/\\/g, "/");

// A Cucumber Messages report with one Action and one Outcome step per scenario, in the shape classify reads.
function report(scenarios: Scenario[], verdict: (s: Scenario) => "red" | "green"): string {
  return scenarios.flatMap((s, i) => {
    const failed = verdict(s) === "red";
    return [
      { pickle: { id: `p${i}`, name: s.name, tags: s.tags.map((name) => ({ name })),
        steps: [{ id: `s${i}a`, type: "Action", text: "the thing runs" }, { id: `s${i}b`, type: "Outcome", text: "it works" }] } },
      { testCase: { id: `c${i}`, pickleId: `p${i}`, testSteps: [{ id: `t${i}a`, pickleStepId: `s${i}a` }, { id: `t${i}b`, pickleStepId: `s${i}b` }] } },
      { testCaseStarted: { id: `r${i}`, testCaseId: `c${i}` } },
      { testStepFinished: { testCaseStartedId: `r${i}`, testStepId: `t${i}a`, testStepResult: { status: "PASSED" } } },
      { testStepFinished: { testCaseStartedId: `r${i}`, testStepId: `t${i}b`, testStepResult: failed ? { status: "FAILED", message: "AssertionError" } : { status: "PASSED" } } },
    ].map((m) => JSON.stringify(m));
  }).join("\n") + "\n";
}

function scenariosFor(criteria: number, skip: number | null): Scenario[] {
  const out: Scenario[] = [];
  for (let n = 1; n <= criteria; n++) if (n !== skip) out.push({ name: `Criterion ${n} holds`, tags: ["@pbi-482", `@ac-${n}`] });
  return out;
}

function featureText(scenarios: Scenario[]): string {
  return ["@pbi-482", "Feature: Item 482", "",
    ...scenarios.flatMap((s) => [`  ${s.tags[1]}`, `  Scenario: ${s.name}`, "    When the thing runs", "    Then it works", ""])].join("\n");
}

// A bare origin with main, and a working clone. A signed-off run also gets its branch, holding the locked feature.
// PBI 16's steps reuse it, with runTheCell, to reach open-pr.
export function setUp(world: object, nextStage: string, signedOff: boolean): Ctx {
  const root = mkdtempSync(join(tmpdir(), "pbi18-"));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const dir = join(root, "work");
  const fixtures = join(root, "fixtures");
  mkdirSync(fixtures);
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "init", "-q", "-b", "main", seed);
  git(seed, "config", "user.email", "seed@example.com");
  git(seed, "config", "user.name", "seed");
  writeFileSync(join(seed, ".gitignore"), "reports/\ndod-env.txt\n");
  writeFileSync(join(seed, "app.txt"), "foo\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "init");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", "main");

  const scenarios = scenariosFor(3, null);
  let lockSha: string | null = null;
  if (signedOff) {
    git(seed, "checkout", "-q", "-b", BRANCH);
    mkdirSync(join(seed, "features"));
    writeFileSync(join(seed, FEATURE), featureText(scenarios));
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "specify");
    git(seed, "push", "-q", "origin", BRANCH);
    lockSha = git(seed, "rev-parse", "HEAD");
    writeFileSync(join(fixtures, "parse.ndjson"), report(scenarios, () => "red"));
  }
  git(root, "clone", "-q", "-b", signedOff ? BRANCH : "main", origin, dir);
  if (!signedOff) git(dir, "checkout", "-q", "-b", BRANCH);
  git(dir, "config", "user.email", "cell@example.com");
  git(dir, "config", "user.name", "cell");

  const c: Ctx = {
    root, origin, dir, fixtures, riskAnswer: "Low", criteria: 3, nextStage, decision: null,
    lockSha, lockedFiles: signedOff ? [FEATURE] : [], prNumber: nextStage === "address" ? 7 : null, startHead: git(dir, "rev-parse", "HEAD"),
    scenarios, skipCriterion: null, greenAtRed: false, editLockAtRed: false,
    dod: "- [ ] Typecheck passes. `run: true`\n", dodJudged: new Map(), trusted: [], stranger: [], ciOldOnly: false, secrets: null,
    calls: [], agentCalls: [], stage: "", prBodies: [], result: null, error: null,
  };
  (world as { pbi18?: Ctx }).pbi18 = c;
  return c;
}

After(function () {
  const c = (this as { pbi18?: Ctx }).pbi18;
  if (!c) return;
  if (c.secrets) for (const [k, v] of Object.entries(c.secrets)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  rmSync(c.root, { recursive: true, force: true });
});

Given("a fresh run for item {int} with {int} acceptance criteria", function (_item: number, n: number) {
  const c = setUp(this, "understand", false);
  c.criteria = n;
  c.scenarios = scenariosFor(n, null);
});

Given("a run for item {int} sent back from sign-off with the note {string}", function (_item: number, note: string) {
  const c = setUp(this, "specify", false);
  c.decision = { kind: "changes", text: note };
});

Given("Specify writes no scenario for criterion {int}, on every try", function (n: number) {
  ctx(this).skipCriterion = n;
});

Given("a run for item {int} whose scenarios were signed off", function (_item: number) {
  setUp(this, "red", true);
});

Given("a run for item {int} whose scenarios were signed off, in a real repo", function (_item: number) {
  setUp(this, "red", true);
});

Given("one of the item's scenarios passes at Red, on every try", function () {
  ctx(this).greenAtRed = true;
});

Given("the Red agent edits the signed-off feature file, on every try", function () {
  ctx(this).editLockAtRed = true;
});

Given("the repo's Definition of Done has the line {string}", function (line: string) {
  ctx(this).dod = `- [ ] ${line}\n`;
});

Given("the repo's Definition of Done has these lines:", function (table: DataTable) {
  const c = ctx(this);
  c.dod = table.hashes().map((r) => `- [ ] ${r.line}`).join("\n") + "\n";
  for (const r of table.hashes()) c.dodJudged.set(r.line, r["judged as"]);
});

Given("the cell itself holds a Claude token and a run token", function () {
  const c = ctx(this);
  c.secrets = { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN, RUN_TOKEN: process.env.RUN_TOKEN };
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-secret";
  process.env.RUN_TOKEN = "run-token-secret";
});

Given("an item {int} in review whose run resumes at address", function (_item: number) {
  setUp(this, "address", true);
});

Given("a trusted reviewer commented {string} on the PR", function (body: string) {
  ctx(this).trusted.push({ author: "owner", body });
});

Given("a stranger commented {string} on the PR", function (body: string) {
  ctx(this).stranger.push({ author: "stranger", body });
});

Given("CI passed on the PR's previous commit and fails on every fix", function () {
  ctx(this).ciOldOnly = true;
});

// The scripted agent. It acts on the stage the engine last reported as started.
function agent(c: Ctx) {
  return async (a: { prompt: string; agent?: string; mode: string; webTools?: string[]; cwd: string; model: string }) => {
    c.agentCalls.push({ stage: c.stage, prompt: a.prompt, agent: a.agent, mode: a.mode, webTools: a.webTools });
    let text = "done";
    const judged = [...a.prompt.matchAll(/^\{"index":(\d+),"criterion":"(.*)"\}$/gm)];
    if (a.agent === "factory-self-reviewer") {
      text = judged.map((m) => JSON.stringify({ index: Number(m[1]), status: "passed", reason: "ok" })).join("\n") + "\nAPPROVED";
    } else if (judged.length > 0) {
      text = judged.map((m) => {
        const line = JSON.parse(`"${m[2]}"`) as string;
        return JSON.stringify({ index: Number(m[1]), status: c.dodJudged.get(line) ?? "passed", reason: "judged" });
      }).join("\n");
    } else if (c.stage === "understand") {
      text = Array.from({ length: c.criteria }, (_, i) => `@ac-${i + 1}: criterion ${i + 1}`).join("\n");
    } else if (c.stage === "specify") {
      c.scenarios = scenariosFor(c.criteria, c.skipCriterion);
      mkdirSync(join(a.cwd, "features"), { recursive: true });
      writeFileSync(join(a.cwd, FEATURE), featureText(c.scenarios));
      writeFileSync(join(c.fixtures, "parse.ndjson"), report(c.scenarios, () => "red"));
    } else if (c.stage === "red") {
      writeFileSync(join(c.fixtures, "run.ndjson"), report(c.scenarios, (s) => (c.greenAtRed && s === c.scenarios[0] ? "green" : "red")));
      if (c.editLockAtRed) appendFileSync(join(a.cwd, FEATURE), "  # edited at red\n");
    } else if (c.stage === "green") {
      writeFileSync(join(c.fixtures, "run.ndjson"), report(c.scenarios, () => "green"));
      writeFileSync(join(a.cwd, "app.txt"), "bar\n");
    } else if (c.stage === "address") {
      writeFileSync(join(a.cwd, "app.txt"), `fix ${c.agentCalls.length}\n`);
    }
    // The shadow risk classifier's two passes at open-pr (PBI 16).
    if (a.mode === "judge" && a.prompt.includes('{"tier":')) {
      text = ["Low", "Medium", "High"].includes(c.riskAnswer) ? JSON.stringify({ tier: c.riskAnswer, reason: "the fake classifier's call" }) : c.riskAnswer;
    } else if (a.mode === "judge" && a.prompt.includes('{"needsPerson":')) {
      text = JSON.stringify({ needsPerson: false, reason: "the fake classifier's call" });
    }
    return { ok: true, text, costUsd: 0.5, tokensIn: 10, tokensOut: 5, model: a.model, limit: null, usage: null, transcript: "{}\n" };
  };
}

function cellApi(c: Ctx) {
  const record = (route: string, body: Record<string, any> = {}) => c.calls.push({ route, body });
  return {
    async lease() { record("/lease"); return { stop: false }; },
    async stage(b: Record<string, any>) { record("/stage", b); if (b.status === "started") c.stage = b.stageId; },
    async transition(b: Record<string, any>) { record("/transition", b); },
    async policyResults(b: Record<string, any>) { record("/policy-results", b); },
    async pr(b: Record<string, any>) { record("/pr", b); },
    async checks(sha: string) {
      record("/checks", { sha });
      if (c.checks) return c.checks(sha);
      if (c.ciOldOnly) return sha === c.startHead ? "success" : "failure";
      return "success";
    },
    async upload(b: Record<string, any>) { record("/upload-url", { kind: b.kind, stageId: b.stageId, attempt: b.attempt }); },
  };
}

function policy(name: PolicyName, text: string): Policy {
  return { name, source: "repo", sha: name, text, criteria: name === "scenarios" || name === "risk" ? [] : parseCriteria(text) };
}

// Real git and sh across up to four attempts outlast cucumber's 5-second default on a busy machine.
When("the cell runs", { timeout: 60_000 }, async function () {
  // PBI 132 runs a cell's agent calls through the engine's stage meter, with the same words.
  if (await runMeteredCell(this)) return;
  await runTheCell(this);
});

/** Runs the engine against the run setUp built. A failure lands in ctx.error, so Thens can assert on it. */
export async function runTheCell(world: object): Promise<void> {
  const c = ctx(world);
  // bdd.run is wrapped in `sh -c` (PBI 185), so the `--dry-run` Red adds lands in $0, and its dry run copies the run's
  // report with every step SKIPPED, as cucumber-js reports a dry run, which Red checks.
  const dryOrRun = (name: string) => `sh -c 'mkdir -p reports && if [ "$0" = --dry-run ]; then sed -E "s/\\"status\\":\\"[A-Z]+\\"/\\"status\\":\\"SKIPPED\\"/g" "${fwd(join(c.fixtures, name))}" > reports/bdd.ndjson; else cp "${fwd(join(c.fixtures, name))}" reports/bdd.ndjson; fi'`;
  const run = (cmd: string) => `mkdir -p reports && cp "${fwd(join(c.fixtures, cmd))}" reports/bdd.ndjson`;
  try {
    const file = join(repo, "src/cell/engine.ts");
    const gitFile = join(repo, "src/cell/git.ts");
    const sopFile = join(repo, "sop/default.yml");
    if (!existsSync(file) || !existsSync(gitFile) || !existsSync(sopFile)) throw new Error("the cell engine doesn't exist yet");
    const engine = await import(pathToFileURL(file).href);
    const { shellGit } = await import(pathToFileURL(gitFile).href);
    const { loadSop } = await import(pathToFileURL(join(repo, "src/config/sop.ts")).href);
    const comments = [...c.trusted, ...c.stranger].map((x, i) => ({ threadId: `t${i}`, path: "app.txt", line: 1, ...x }));
    c.result = await engine.runCell({
      api: cellApi(c),
      ctx: {
        externalId: "482", title: "Item 482", acceptanceCriteria: Array.from({ length: c.criteria }, (_, i) => `Criterion ${i + 1} holds`),
        nextStage: c.nextStage, decision: c.decision, lockSha: c.lockSha, lockedFiles: c.lockedFiles, prNumber: c.prNumber,
        repo: "acme/app", base: "main", branch: BRANCH, configSha: "c0ffee", sopVersion: "0.1.0",
        dodVerdicts: [], dodCheckedSha: null,
        // The control plane's filter (Run contract 10): only trusted authors reach the cell's context.
        trustedComments: comments.filter((x) => x.author === "owner"),
        stageAttempts: {},
        ...c.context,
      },
      agent: ((base) => c.agent ? (a: any) => c.agent!(a, base) : base)(c.wrapAgent ? c.wrapAgent(agent(c)) : agent(c)),
      git: shellGit(c.dir, BRANCH),
      dir: c.dir,
      repoHost: c.repoHost ?? {
        async openOrUpdatePr(p: { body: string }) { c.prBodies.push(p.body); return { number: 7, url: "https://github.com/acme/app/pull/7" }; },
        async requestReviewers() { return []; },
        async openReviewComments() { return comments; },
        // The run's PR is still open, so address has something to address (PBI 194).
        async prState() { return { open: true, merged: false, mergeSha: null, mergeable: true, lastChangesRequestedAt: null }; },
      },
      sop: loadSop(readFileSync(sopFile, "utf8")),
      config: { sensitivePaths: [], reviewers: ["owner"], webTools: [],
        bdd: { parse: run("parse.ndjson"), run: dryOrRun("run.ndjson"), report: "reports/bdd.ndjson" }, commands: { test: "true", lint: "true" } },
      policies: { scenarios: policy("scenarios", "Write in business language.\n"), prReview: policy("pr-review", "- [ ] Code is readable.\n"),
        risk: policy("risk", "Low by default.\n"), dod: policy("dod", c.dod) },
      now: () => new Date(),
      sleep: async () => {},
    });
  } catch (e) {
    c.error = e;
  }
}

function ran(c: Ctx): string[] {
  assert.equal(c.error, null, `the cell failed: ${String(c.error)}`);
  return c.calls.filter((x) => x.route === "/stage" && x.body.status === "started").map((x) => x.body.stageId as string);
}

function lastTransition(c: Ctx): Record<string, any> {
  assert.equal(c.error, null, `the cell failed: ${String(c.error)}`);
  const t = c.calls.filter((x) => x.route === "/transition").at(-1);
  assert.ok(t, "the cell sent no transition");
  return t.body;
}

// A stage's retries collapse into one row, so a stage the run comes back to, as after "back to green", shows again.
Then("the cell ran these stages, in order:", function (table: DataTable) {
  const stages = ran(ctx(this)).filter((s, i, all) => s !== all[i - 1]);
  assert.deepEqual(stages, table.hashes().map((r) => r.stage));
});

Then("the item's scenarios are posted on item {int} for sign-off", function (_item: number) {
  const t = lastTransition(ctx(this));
  assert.equal(t.event, "scenarios_written");
  assert.equal(t.question?.kind, "sign_off");
  assert.match(t.question.body, /Feature: Item 482/);
  assert.match(t.question.body, /@pbi-482/);
  assert.ok(t.scenariosSha, "no scenariosSha");
  assert.deepEqual(t.lockedFiles, [FEATURE]);
});

Then("the item moves to {word}", function (state: string) {
  assert.equal(next("InProgress", lastTransition(ctx(this)).event as ItemEvent), state);
});

Then("the item moves to {word}, with a question that names {string}", function (state: string, text: string) {
  const t = lastTransition(ctx(this));
  assert.equal(next("InProgress", t.event as ItemEvent), state);
  assert.ok(String(t.question?.body ?? "").includes(text), `the question doesn't name "${text}": ${t.question?.body}`);
});

Then("the cell ends {word}", function (result: string) {
  const c = ctx(this);
  assert.equal(c.error, null, `the cell failed: ${String(c.error)}`);
  assert.equal(c.result, result);
});

Then("the Specify brief holds {string}", function (text: string) {
  const c = ctx(this);
  ran(c);
  const briefs = c.agentCalls.filter((a) => a.stage === "specify");
  assert.ok(briefs.length > 0, "Specify never ran");
  assert.ok(briefs.every((a) => a.prompt.includes(text)), `a Specify brief lacks "${text}"`);
});

Then("no scenarios are posted for sign-off", function () {
  const c = ctx(this);
  ran(c);
  assert.ok(!c.calls.some((x) => x.route === "/transition" && x.body.event === "scenarios_written"));
});

Then("the PR body holds {string}", function (text: string) {
  const c = ctx(this);
  ran(c);
  assert.ok(c.prBodies.length > 0, "no PR was opened");
  assert.ok(c.prBodies.at(-1)!.includes(text), `the PR body lacks "${text}"`);
});

Then("the PR body doesn't hold {string}", function (text: string) {
  const c = ctx(this);
  ran(c);
  assert.ok(c.prBodies.length > 0, "no PR was opened");
  assert.ok(!c.prBodies.at(-1)!.includes(text), `the PR body holds "${text}"`);
});

Then("Red ran {int} times", function (n: number) {
  assert.equal(ran(ctx(this)).filter((s) => s === "red").length, n);
});

Then("Green ran {int} times", function (n: number) {
  assert.equal(ran(ctx(this)).filter((s) => s === "green").length, n);
});

Then("address ran {int} times", function (n: number) {
  assert.equal(ran(ctx(this)).filter((s) => s === "address").length, n);
});

Then("no PR is opened", function () {
  const c = ctx(this);
  ran(c);
  assert.equal(c.prBodies.length, 0);
  assert.ok(!c.calls.some((x) => x.route === "/transition" && x.body.event === "pr_opened"));
});

Then("nothing is pushed", function () {
  const c = ctx(this);
  ran(c);
  assert.equal(git(c.root, "--git-dir", c.origin, "rev-parse", BRANCH), c.lockSha);
});

Then("the PR checklist shows {string} ticked", function (text: string) {
  const c = ctx(this);
  ran(c);
  const body = c.prBodies.at(-1) ?? "";
  assert.ok(body.split("\n").some((l) => l.startsWith("- [x] ") && l.includes(text)), `no ticked line for "${text}" in:\n${body}`);
});

Then("the PR checklist shows {string} unticked, for the person who merges", function (text: string) {
  const c = ctx(this);
  ran(c);
  const body = c.prBodies.at(-1) ?? "";
  const line = body.split("\n").find((l) => l.startsWith("- [ ] ") && l.includes(text));
  assert.ok(line, `no unticked line for "${text}" in:\n${body}`);
  assert.match(line, /person who merges/);
});

Then("the command's environment, in {string}, holds no {string} and no {string}", function (file: string, a: string, b: string) {
  const c = ctx(this);
  ran(c);
  const path = join(c.dir, file);
  assert.ok(existsSync(path), "the Definition of Done command never ran");
  const env = readFileSync(path, "utf8");
  assert.ok(env.includes("PATH="), "the command's environment wasn't captured");
  for (const name of [a, b]) assert.ok(!env.split("\n").some((l) => l.startsWith(`${name}=`)), `the command saw ${name}`);
});

Then("the addresser's brief holds {string}", function (text: string) {
  const c = ctx(this);
  ran(c);
  const briefs = c.agentCalls.filter((a) => a.agent === "factory-pr-addresser");
  assert.ok(briefs.length > 0, "the addresser never ran");
  assert.ok(briefs.every((a) => a.prompt.includes(text)), `the addresser's brief lacks "${text}"`);
});

Then("the addresser's brief doesn't hold {string}", function (text: string) {
  const c = ctx(this);
  ran(c);
  const briefs = c.agentCalls.filter((a) => a.agent === "factory-pr-addresser");
  assert.ok(briefs.length > 0, "the addresser never ran");
  assert.ok(briefs.every((a) => !a.prompt.includes(text)), `the addresser's brief holds "${text}"`);
});

Then("the fix is pushed", function () {
  const c = ctx(this);
  ran(c);
  const pushed = git(c.root, "--git-dir", c.origin, "rev-parse", BRANCH);
  assert.notEqual(pushed, c.lockSha, "nothing was pushed");
  assert.equal(pushed, git(c.dir, "rev-parse", "HEAD"));
});

Then("the cell asked CI about the pushed commit before handing the PR back", function () {
  const c = ctx(this);
  ran(c);
  const pushed = git(c.root, "--git-dir", c.origin, "rev-parse", BRANCH);
  const asked = c.calls.findIndex((x) => x.route === "/checks" && x.body.sha === pushed);
  const back = c.calls.findIndex((x) => x.route === "/transition" && x.body.event === "pr_opened");
  assert.ok(asked >= 0, "the cell never asked CI about the pushed commit");
  assert.ok(back > asked, "the cell handed the PR back before asking CI about the pushed commit");
});
