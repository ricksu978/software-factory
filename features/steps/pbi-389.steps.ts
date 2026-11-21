// Step definitions for features/pbi-389-full-suite-once-per-commit.feature.
//
// The cell scenarios run PBI 18's engine harness from Green: a real temporary git repo cloned from a bare origin, a
// recording cell API, a scripted agent and a fake repo host. The repo's `bdd.run`, `commands.test` and
// `commands.lint` are the ones the scenario names, and each reaches a fake `npm` this file puts first on PATH. The fake
// reads the commit it runs on with `git rev-parse HEAD`, logs each run with that commit, and exits with the code the
// scenario gives the command, 0 unless a step says otherwise. A `npm run bdd ...` run also writes the gate's report,
// with as many passing scenarios as the scenario says. A lint command of `node scripts/prose-lint.mjs ...` runs a
// script Green's commit adds, which logs its runs in the same way.
//
// The commits the feature names, such as "c0ffee1" and "beef002", are labels: the scripted Green agent makes the
// commit labelled as Green's implementation, and the self-review fix pass makes the one labelled as the fix. A Then
// that names a label reads the real commit it stands for, and a text that names the commit holds its first 7
// characters.
//
// What "the cell ran" reads is the fake's log. Green's gate runs `bdd.run`, `commands.test` and `commands.lint` in
// that order, so at Green's commit a run that comes after the gate's `commands.lint` run is the Definition of Done
// check's. At a commit no gate ran at, every run is the check's. "Line N's command" stands for the commands its
// shell would run when each passes: its parts split at `&&`, `;` and `|`, with what follows a `||` left out, since it
// runs only when the part before it fails, and parentheses dropped.
//
// A line's verdict and reason are the ones the cell stored through /policy-results for the commit checked. "The stage's
// findings" are the ones Green's next attempt is told its last attempt failed on. The self-reviewer's brief is the
// prompt of the factory-self-reviewer call in that round.
//
// PBI 229's steps own some of this feature's words, such as "the repo's Definition of Done line {int} is {string}" and
// "Definition of Done line {int} passes". In a @pbi-389 scenario they hand over to the functions this file exports.
//
// The last rule reuses PBI 12's poller harness and PBI 181's PRs, whose merge GitHub's merge state holds, and whose
// CI status on a commit is the fake repo host's.
import { Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { long, need, testDb } from "./pbi-8.steps.ts";
import { runTheCell, type Ctx as CellCtx } from "./pbi-18.steps.ts";
import { ctx as pollCtx, setup as pollSetup } from "./pbi-12.steps.ts";
import { editBody, holdItem, prOf } from "./pbi-181.steps.ts";

const PROSE_LINT = "node scripts/prose-lint.mjs";
const FILLER = "The change is described. `run: true`";

type Run = { cmd: string; head: string };
type PolicyCall = { file: string; stageId: string; checkedSha: string; verdicts: { index: number; criterion: string; status: string; reason: string }[] };

type Ctx = {
  /** The Definition of Done's lines, by number. A number below the highest that no step set is a filler line. */
  lines: Map<number, string>;
  bddRun: string;
  test: string;
  lint: string;
  /** Exit codes by command key, for the commands that fail. */
  fails: Record<string, number>;
  /** The scenarios the gate's report holds, all passing. */
  passed: number;
  /** Labels to the commits they stand for, once made. */
  labels: Map<string, string>;
  greenLabel: string | null;
  fixLabel: string | null;
  holdFirstRound: boolean;
  /** The commit the When checked the Definition of Done at, by its label. */
  checkedAt: string | null;
  ran: boolean;
  greenCalls: number;
  installed: boolean;
  logFile: string;
  planFile: string;
  fixture: string;
};

function cell(world: object): CellCtx {
  const w = world as { pbi18?: CellCtx };
  assert.ok(w.pbi18, "no run was set up");
  return w.pbi18;
}

function mine(world: object): Ctx {
  const w = world as { pbi389?: Ctx };
  assert.ok(w.pbi389, "this isn't a PBI 389 scenario");
  return w.pbi389;
}

Before({ tags: "@pbi-389" }, function () {
  (this as { pbi389?: Ctx }).pbi389 = {
    lines: new Map(), bddRun: "true", test: "true", lint: "true", fails: {}, passed: 12, labels: new Map(),
    greenLabel: null, fixLabel: null, holdFirstRound: false, checkedAt: null, ran: false, greenCalls: 0, installed: false,
    logFile: "", planFile: "", fixture: "",
  };
});

Before({ tags: "@pbi-389 and @ac-5", ...long }, async function () {
  const d = await testDb();
  if (d) await d.pool.query('truncate item, backlog_source, repo, "user" cascade');
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** How the log names a command: npm's arguments lose their quotes on the way in, and the prose lint its file list. */
const key = (cmd: string) => cmd.trim().startsWith(PROSE_LINT) ? PROSE_LINT : cmd.trim().replace(/["']/g, "").replace(/\s+/g, " ");

/** The commands a line's shell runs when each passes. */
function partsOf(command: string): string[] {
  const first = command.split("||")[0]!;
  return first.split(/&&|;|\|/).map((p) => p.replace(/[()]/g, "").trim()).filter((p) => p.startsWith("npm ") || p.startsWith(PROSE_LINT));
}

const runOf = (line: string) => /`run:\s*([^`]+)`/.exec(line)?.[1].trim() ?? null;

// The fake npm, in CommonJS so node runs it from a directory with no package.json. The paths are written in, since a
// command the cell runs sees only PATH, HOME and CI (Run contract 11).
function fakeNpm(planFile: string, logFile: string, fixture: string): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const args = process.argv.slice(2);
const cmd = ["npm", ...args].join(" ").replace(/["']/g, "").replace(/\\s+/g, " ").trim();
let head = "";
try { head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch {}
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ cmd, head }) + "\\n");
if (args[0] === "run" && args[1] === "bdd") {
  fs.mkdirSync("reports", { recursive: true });
  fs.copyFileSync(${JSON.stringify(fixture)}, "reports/bdd.ndjson");
}
const plan = fs.existsSync(${JSON.stringify(planFile)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(planFile)}, "utf8")) : {};
const code = plan[cmd] || 0;
console.log(cmd + (code ? " failed" : " passed"));
process.exit(code);
`;
}

function proseLint(logFile: string): string {
  return `import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ cmd: ${JSON.stringify(PROSE_LINT)}, head }) + "\\n");
`;
}

/** A Cucumber Messages report of `n` passing scenarios, in the shape classify reads. */
function passingReport(n: number): string {
  return Array.from({ length: n }, (_, i) => [
    { pickle: { id: `p${i}`, name: `Scenario ${i + 1}`, tags: [{ name: "@pbi-482" }],
      steps: [{ id: `s${i}a`, type: "Action", text: "the thing runs" }, { id: `s${i}b`, type: "Outcome", text: "it works" }] } },
    { testCase: { id: `c${i}`, pickleId: `p${i}`, testSteps: [{ id: `t${i}a`, pickleStepId: `s${i}a` }, { id: `t${i}b`, pickleStepId: `s${i}b` }] } },
    { testCaseStarted: { id: `r${i}`, testCaseId: `c${i}` } },
    { testStepFinished: { testCaseStartedId: `r${i}`, testStepId: `t${i}a`, testStepResult: { status: "PASSED" } } },
    { testStepFinished: { testCaseStartedId: `r${i}`, testStepId: `t${i}b`, testStepResult: { status: "PASSED" } } },
  ].map((m) => JSON.stringify(m)).join("\n")).join("\n") + "\n";
}

function dodText(m: Ctx): string {
  const max = Math.max(0, ...m.lines.keys());
  return Array.from({ length: max }, (_, i) => `- [ ] ${m.lines.get(i + 1) ?? FILLER}`).join("\n") + "\n";
}

function commitAs(m: Ctx, cwd: string, label: string, content: string, files: Record<string, string> = {}) {
  writeFileSync(join(cwd, "app.txt"), content);
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(cwd, p, ".."), { recursive: true });
    writeFileSync(join(cwd, p), text);
  }
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", `work for ${label}`);
  m.labels.set(label, git(cwd, "rev-parse", "HEAD"));
}

/** Puts the fake npm on PATH and sets the cell up to run from Green with the scenario's repo. */
function install(world: object): void {
  const m = mine(world);
  const c = cell(world);
  if (m.installed) return;
  m.installed = true;
  const bin = join(c.root, "pbi389-bin");
  mkdirSync(bin);
  m.logFile = join(c.root, "pbi389-runs.jsonl");
  m.planFile = join(c.root, "pbi389-plan.json");
  m.fixture = join(c.root, "pbi389-report.ndjson");
  writeFileSync(join(bin, "npm"), fakeNpm(m.planFile, m.logFile, m.fixture));
  chmodSync(join(bin, "npm"), 0o755);
  // PBI 18's After puts PATH back.
  c.secrets = { ...(c.secrets ?? {}), PATH: process.env.PATH };
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
  // A pipe's tee leaves a log file, which no commit should carry.
  appendFileSync(join(c.dir, ".git", "info", "exclude"), "test.log\n");
  c.nextStage = "green";
  // One retry, so a failed attempt's findings reach the next attempt's brief.
  c.editSop = (sop) => { const g = sop.stages.find((s: { id: string }) => s.id === "green"); if (g) g.retries = 1; };
  c.editConfig = (config) => {
    config.bdd.run = m.bddRun;
    config.commands.test = m.test;
    config.commands.lint = m.lint;
  };
  let selfRounds = 0;
  c.agent = async (a, base) => {
    const judge = String(a.prompt).startsWith("# Definition of Done");
    if (c.stage === "green" && !judge && a.mode !== "judge" && !a.agent) {
      // Green's implementation: the first attempt makes the labelled commit, a later one a commit of its own.
      m.greenCalls++;
      const label = m.greenCalls === 1 && m.greenLabel ? m.greenLabel : `green-${m.greenCalls}`;
      commitAs(m, a.cwd, label, `green ${m.greenCalls}\n`, { "scripts/prose-lint.mjs": proseLint(m.logFile) });
      c.agentCalls.push({ stage: c.stage, prompt: a.prompt, agent: a.agent, mode: a.mode, webTools: a.webTools });
      return { ok: true, text: "done", costUsd: 0.5, tokensIn: 10, tokensOut: 5, model: a.model, limit: null, usage: null, transcript: "{}\n" };
    }
    if (a.agent === "factory-self-reviewer") {
      selfRounds++;
      const r = await base(a);
      if (selfRounds === 1 && m.holdFirstRound) return { ...r, text: r.text.replace(/APPROVED$/, "app.txt:1 needs a comment.\nOPEN: 1") };
      return r;
    }
    if (c.stage === "self-review" && String(a.prompt).startsWith("# Fix review findings")) {
      const r = await base(a);
      commitAs(m, a.cwd, m.fixLabel ?? "fix", "fixed\n");
      return r;
    }
    return base(a);
  };
}

function writePlan(m: Ctx) {
  writeFileSync(m.fixture, passingReport(m.passed));
  writeFileSync(m.planFile, JSON.stringify(m.fails));
}

async function runIt(world: object): Promise<void> {
  const m = mine(world);
  const c = cell(world);
  install(world);
  assert.ok(!m.ran, "the cell already ran in this scenario");
  m.ran = true;
  c.dod = dodText(m);
  writePlan(m);
  await runTheCell(world);
}

// ---- what reads the run ----

function settled(c: CellCtx): void {
  assert.equal(c.error, null, `the cell failed: ${c.error instanceof Error ? c.error.stack : String(c.error)}`);
}

function sha(m: Ctx, label: string): string {
  const s = m.labels.get(label);
  assert.ok(s, `no commit was made as "${label}"; the commits made were ${JSON.stringify([...m.labels.keys()])}`);
  return s;
}

function runs(m: Ctx): Run[] {
  return existsSync(m.logFile) ? readFileSync(m.logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Run) : [];
}

/** The runs at `at` that the Definition of Done check made: those after the gate's lint run there, or all of them. */
function checkRuns(m: Ctx, at: string): Run[] {
  const all = runs(m).filter((r) => r.head === at);
  const gated = m.greenLabel !== null && m.labels.get(m.greenLabel) === at;
  if (!gated) return all;
  const end = all.findIndex((r) => r.cmd === key(m.lint));
  assert.ok(end >= 0, `Green's gate didn't run "${m.lint}" at ${at.slice(0, 7)}`);
  return all.slice(end + 1);
}

function line(m: Ctx, n: number): string {
  const l = m.lines.get(n);
  assert.ok(l, `the scenario set no Definition of Done line ${n}`);
  return l;
}

function partsOfLine(m: Ctx, n: number): string[] {
  const cmd = runOf(line(m, n));
  assert.ok(cmd, `line ${n} isn't a run: line`);
  const parts = partsOf(cmd);
  assert.ok(parts.length, `line ${n}'s command runs nothing the steps can see: ${cmd}`);
  return parts;
}

function policyCalls(c: CellCtx): PolicyCall[] {
  return c.calls.filter((x) => x.route === "/policy-results" && x.body.file === "dod").map((x) => x.body as PolicyCall);
}

/** The verdict the cell stored for line `n` at the commit the When checked. */
function verdict(world: object, n: number) {
  const m = mine(world);
  const c = cell(world);
  assert.ok(m.ran, "the cell didn't run");
  assert.ok(m.checkedAt, "no step said which commit the check was at");
  const at = sha(m, m.checkedAt);
  const stored = policyCalls(c).filter((p) => p.checkedSha === at);
  assert.ok(stored.length, `the cell stored no Definition of Done results for ${m.checkedAt} (${at.slice(0, 7)}): it stored them for ${policyCalls(c).map((p) => p.checkedSha.slice(0, 7)).join(", ") || "no commit"}${c.error ? `, and failed: ${String(c.error)}` : ""}`);
  const v = stored.at(-1)!.verdicts.find((x) => x.index === n);
  assert.ok(v, `the stored results for ${m.checkedAt} have no line ${n}`);
  return v;
}

const sentences = (text: string) => text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
const escapeRe = (s: string) => s.replace(/[-.*+?^${}()|[\]\\]/g, "\\$&");
const namesCount = (text: string, n: number, word: string) => new RegExp(`(^|[^\\d])${n}\\s+(scenarios?\\s+)?${word}`, "i").test(text) || new RegExp(`${word}:?\\s+${n}([^\\d]|$)`, "i").test(text);

// ---- the functions PBI 229's shared steps hand over to ----

export const pbi389 = {
  active: (world: object) => (world as { pbi389?: Ctx }).pbi389 !== undefined,
  setLine(world: object, n: number, text: string) {
    mine(world).lines.set(n, text);
  },
  lineFails(world: object, n: number, code: number) {
    const m = mine(world);
    for (const p of partsOfLine(m, n)) m.fails[key(p)] = code;
  },
  async checkAt(world: object, label: string) {
    const m = mine(world);
    m.checkedAt = label;
    await runIt(world);
  },
  passes(world: object, n: number, reason?: string) {
    const v = verdict(world, n);
    assert.equal(v.status, "passed", `line ${n} ${v.status}: ${v.reason}`);
    if (reason !== undefined) assert.equal(v.reason, reason);
  },
  failsWith(world: object, n: number, start: string) {
    const v = verdict(world, n);
    assert.equal(v.status, "failed", `line ${n} ${v.status}: ${v.reason}`);
    assert.ok(v.reason.startsWith(start), `line ${n}'s reason doesn't start "${start}": ${v.reason}`);
  },
  didntRun(world: object, n: number, label?: string) {
    const m = mine(world);
    settledRun(world);
    const at = sha(m, label ?? m.checkedAt ?? m.greenLabel ?? "");
    const ran = checkRuns(m, at).filter((r) => partsOfLine(m, n).map(key).includes(r.cmd));
    assert.deepEqual(ran.map((r) => r.cmd), [], `the Definition of Done check ran line ${n}'s command at ${at.slice(0, 7)}`);
  },
  storedPassed(world: object, label: string, n: number) {
    const m = mine(world);
    const at = sha(m, label);
    const stored = policyCalls(cell(world)).filter((p) => p.checkedSha === at);
    assert.ok(stored.length, `no Definition of Done results were stored for ${label}`);
    for (const s of stored) {
      const v = s.verdicts.find((x) => x.index === n);
      assert.ok(v, `the stored results for ${label} have no line ${n}`);
      assert.equal(v.status, "passed", `the stored line ${n} ${v.status}: ${v.reason}`);
    }
  },
};

function settledRun(world: object) {
  assert.ok(mine(world).ran, "the cell didn't run");
}

// ---- Given: the repo ----

Given(/^the repo's "(bdd\.run|commands\.test|commands\.lint)" is "(.*)"$/, function (name: string, value: string) {
  const m = mine(this);
  const v = value.replace(/\\"/g, '"');
  if (name === "bdd.run") m.bddRun = v;
  else if (name === "commands.test") m.test = v;
  else m.lint = v;
});

Given("{string} fails in the checkout with exit code {int}", function (cmd: string, code: number) {
  mine(this).fails[key(cmd)] = code;
});

// ---- Given: Green ----

Given("Green's implementation is at commit {string}", function (label: string) {
  mine(this).greenLabel = label;
});

Given(/^Green's gate (?:passes|passed) at "([^"]+)" with (\d+) scenarios passed and none failed$/, function (label: string, n: string) {
  const m = mine(this);
  m.greenLabel = label;
  m.passed = Number(n);
});

// ---- Given: self-review ----

Given("the self-reviewer approves in its first round without a new commit", function () {
  mine(this).holdFirstRound = false;
});

Given("the self-reviewer holds a finding open in its first round", function () {
  mine(this).holdFirstRound = true;
});

Given("the fix for that finding is committed as {string}", function (label: string) {
  mine(this).fixLabel = label;
});

Given("the self-reviewer approves in its second round", function () {
  assert.ok(mine(this).holdFirstRound, "the self-reviewer held no finding open in its first round");
});

Given("the branch has since moved to commit {string}", function (label: string) {
  // Self-review's fix moves the branch on from Green's commit, and open-pr checks the Definition of Done there.
  const m = mine(this);
  m.holdFirstRound = true;
  m.fixLabel = label;
});

// ---- When ----

When("Green checks the Definition of Done at {string}", long, async function (label: string) {
  await pbi389.checkAt(this, label);
});

When(/^the cell runs (?:Green, self-review and open-pr|self-review and open-pr)$/, long, async function () {
  await runIt(this);
});

When(/^self-review runs its (first|second) round$/, long, async function (_round: string) {
  await runIt(this);
});

// ---- Then: what the cell ran ----

Then("the cell ran {string} once at {string}", function (cmd: string, label: string) {
  const m = mine(this);
  settledRun(this);
  const at = sha(m, label);
  const n = runs(m).filter((r) => r.cmd === key(cmd) && r.head === at).length;
  assert.equal(n, 1, `"${cmd}" ran ${n} times at ${label} (${at.slice(0, 7)})`);
});

Then("the cell ran line {int}'s command at {string}", function (n: number, label: string) {
  const m = mine(this);
  settledRun(this);
  const at = sha(m, label);
  const ran = checkRuns(m, at).map((r) => r.cmd);
  for (const p of partsOfLine(m, n)) assert.ok(ran.includes(key(p)), `the Definition of Done check didn't run "${p}" of line ${n} at ${label}; it ran ${JSON.stringify(ran)}`);
});

Then("the cell ran line {int}'s command once at {string}", function (n: number, label: string) {
  const m = mine(this);
  settledRun(this);
  const at = sha(m, label);
  const ran = checkRuns(m, at).map((r) => r.cmd);
  for (const p of partsOfLine(m, n)) {
    const times = ran.filter((r) => r === key(p)).length;
    assert.equal(times, 1, `"${p}" of line ${n} ran ${times} times at ${label} in the Definition of Done check`);
  }
});

Then("the cell didn't run line {int}'s command at {string}", function (n: number, label: string) {
  pbi389.didntRun(this, n, label);
});

// ---- Then: the line's verdict ----

Then("line {int}'s reason says Green's gate passed it", function (n: number) {
  const v = verdict(this, n);
  assert.ok(sentences(v.reason).some((s) => /Green's gate/i.test(s) && /\bpass/i.test(s)), `line ${n}'s reason doesn't say Green's gate passed it: ${v.reason}`);
});

Then("line {int}'s reason names the commit {string}", function (n: number, label: string) {
  const v = verdict(this, n);
  const s = sha(mine(this), label);
  assert.ok(v.reason.includes(s.slice(0, 7)), `line ${n}'s reason doesn't name ${label} (${s.slice(0, 7)}): ${v.reason}`);
});

Then("line {int}'s reason names {int} scenarios passed and {int} failed", function (n: number, passed: number, failed: number) {
  const v = verdict(this, n);
  assert.ok(namesCount(v.reason, passed, "passed"), `line ${n}'s reason doesn't name ${passed} scenarios passed: ${v.reason}`);
  assert.ok(namesCount(v.reason, failed, "failed"), `line ${n}'s reason doesn't name ${failed} failed: ${v.reason}`);
});

Then("line {int}'s reason says {string} exited {int}", function (n: number, cmd: string, code: number) {
  const v = verdict(this, n);
  assert.ok(sentences(v.reason).some((s) => s.includes(cmd) && new RegExp(`\\bexit(ed)?:?\\s+${code}\\b`, "i").test(s)), `line ${n}'s reason doesn't say "${cmd}" exited ${code}: ${v.reason}`);
});

Then("the stored reason for line {int} names Green's gate, {string} and {int} scenarios passed", function (n: number, label: string, passed: number) {
  const m = mine(this);
  const at = sha(m, label);
  const stored = policyCalls(cell(this)).filter((p) => p.checkedSha === at).at(-1);
  assert.ok(stored, `no Definition of Done results were stored for ${label}`);
  const v = stored.verdicts.find((x) => x.index === n);
  assert.ok(v, `the stored results for ${label} have no line ${n}`);
  assert.match(v.reason, /Green's gate/i, `the stored reason doesn't name Green's gate: ${v.reason}`);
  assert.ok(v.reason.includes(at.slice(0, 7)), `the stored reason doesn't name ${label} (${at.slice(0, 7)}): ${v.reason}`);
  assert.ok(namesCount(v.reason, passed, "passed"), `the stored reason doesn't name ${passed} scenarios passed: ${v.reason}`);
});

Then("the stage's findings say Definition of Done line {int} failed", function (n: number) {
  const c = cell(this);
  settledRun(this);
  const retries = c.agentCalls.filter((a) => a.stage === "green" && !a.agent && a.mode !== "judge" && !a.prompt.startsWith("# Definition of Done"));
  assert.ok(retries.length >= 2, `Green ran ${retries.length} attempt(s), so no attempt was told what the first failed on`);
  const told = retries[1]!.prompt.split("## Your last attempt failed")[1] ?? "";
  assert.match(told, new RegExp(`Definition of Done line ${n} failed`), `Green's second attempt wasn't told Definition of Done line ${n} failed:\n${told || "(no findings)"}`);
});

Then("Definition of Done line {int} was sent to the judge", function (n: number) {
  const c = cell(this);
  settledRun(this);
  const judged = c.agentCalls.filter((a) => a.prompt.startsWith("# Definition of Done"));
  assert.ok(judged.some((a) => a.prompt.includes(`{"index":${n},`)), `no judge was asked about line ${n}`);
});

// ---- Then: the PR ----

Then("the PR body shows Definition of Done line {int} passed at {string}", function (n: number, label: string) {
  const m = mine(this);
  const c = cell(this);
  settled(c);
  const at = sha(m, label);
  const body = c.prBodies.at(-1);
  assert.ok(body, "no PR was opened");
  const dod = body.split("## Definition of Done")[1] ?? "";
  assert.ok(dod.includes(at) || dod.includes(at.slice(0, 7)), `the PR body's Definition of Done doesn't name ${label} (${at.slice(0, 7)}):\n${dod}`);
  assert.ok(dod.split("\n").some((l) => l.startsWith("- [x] ") && l.includes(line(m, n))), `the PR body doesn't show line ${n} ticked:\n${dod}`);
});

Then("the PR's head is {string}", function (label: string) {
  const m = mine(this);
  const c = cell(this);
  settled(c);
  assert.ok(c.prBodies.length, "no PR was opened");
  assert.equal(git(c.root, "--git-dir", c.origin, "rev-parse", "factory/pbi-482-r1"), sha(m, label));
});

Then("the factory waits for CI on {string}", function (label: string) {
  const m = mine(this);
  const c = cell(this);
  settled(c);
  const at = sha(m, label);
  assert.ok(c.calls.some((x) => x.route === "/checks" && x.body.sha === at), `the cell never asked CI about ${label}: it asked about ${c.calls.filter((x) => x.route === "/checks").map((x) => String(x.body.sha).slice(0, 7)).join(", ") || "nothing"}`);
});

// ---- Then: the self-reviewer's brief ----

function reviewBrief(world: object, round: number): string {
  const c = cell(world);
  settled(c);
  const briefs = c.agentCalls.filter((a) => a.agent === "factory-self-reviewer");
  assert.ok(briefs.length >= round, `the self-reviewer ran ${briefs.length} round(s)`);
  return briefs[round - 1]!.prompt;
}

/** The brief of the round the last "self-review runs its ... round" step named: the second when a finding was held. */
function theBrief(world: object): string {
  return reviewBrief(world, mine(world).holdFirstRound ? 2 : 1);
}

const fullSuite = /\bfull (test )?suite\b/i;

Then("the self-reviewer's brief says the full suite passed in Green's gate at {string}", function (label: string) {
  const short = sha(mine(this), label).slice(0, 7);
  const b = theBrief(this);
  assert.ok(sentences(b).some((s) => fullSuite.test(s) && /\bpassed\b/i.test(s) && /Green's gate/i.test(s) && s.includes(short)), `the brief doesn't say the full suite passed in Green's gate at ${label} (${short}):\n${b}`);
});

Then("the self-reviewer's brief doesn't say the full suite passed at {string}", function (label: string) {
  const short = sha(mine(this), label).slice(0, 7);
  const b = theBrief(this);
  const said = sentences(b).filter((s) => fullSuite.test(s) && /\bpassed\b/i.test(s) && s.includes(short));
  assert.deepEqual(said, [], `the brief says the full suite passed at ${label}`);
});

Then("the self-reviewer's brief names the command {string}", function (cmd: string) {
  const b = theBrief(this);
  assert.ok(b.includes(cmd.replace(/\\"/g, '"')), `the brief doesn't name the command ${cmd}:\n${b}`);
});

Then("the self-reviewer's brief names {int} scenarios passed and {int} failed", function (passed: number, failed: number) {
  const b = theBrief(this);
  assert.ok(sentences(b).some((s) => namesCount(s, passed, "passed") && namesCount(s, failed, "failed")), `the brief doesn't name ${passed} scenarios passed and ${failed} failed:\n${b}`);
});

Then("the self-reviewer's brief says not to run the full suite", function () {
  const b = theBrief(this);
  assert.ok(sentences(b).some((s) => fullSuite.test(s) && /\brun\b/i.test(s) && /\b(don't|do not|never|no)\b/i.test(s)), `the brief doesn't say not to run the full suite:\n${b}`);
});

Then("the self-reviewer's brief says a single scenario can be run with {string} and a {string} filter", function (cmd: string, flag: string) {
  const b = theBrief(this);
  const hit = sentences(b).find((s) => s.includes(cmd) && s.includes(flag) && /\b(single|one|individual)\b[^.]*\bscenarios?\b/i.test(s));
  assert.ok(hit, `the brief doesn't say a single scenario can be run with "${cmd}" and a "${flag}" filter:\n${b}`);
});

Then("the self-reviewer's brief says single test files may be run to check a finding", function () {
  const b = theBrief(this);
  const hit = sentences(b).find((s) => /\b(single|one|individual)\b[^.]*\btest files?\b/i.test(s) && /\bfinding\b/i.test(s));
  assert.ok(hit, `the brief doesn't say single test files may be run to check a finding:\n${b}`);
});

// ---- the merge gate: PBI 12's poller and PBI 181's PRs ----

const REPO = "acme/widgets";

Given("the factory holds an item in state {string} whose open run has PR {int} in {string} at head {string}", long, async function (state: string, n: number, repo: string, head: string) {
  assert.equal(repo, REPO);
  const c = pollCtx(this);
  assert.ok(await pollSetup(c), "the poller's fakes or database aren't available");
  await need().pool.query("insert into repo (host_adapter, url) values ('fake', $1) on conflict do nothing", [`https://github.com/${REPO}`]);
  c.extIds = [await holdItem(this, c, state, n, [])];
  c.pr = n;
  const p = prOf(this, n);
  c.host!.checks.delete(`${REPO}@${p.headSha}`);
  p.headSha = head;
  // An approval here is a person's the factory trusts: whoever approved the PR is an allowlisted user by the poll.
  c.beforePoll = async () => {
    for (const r of prOf(this, n).reviews.filter((x) => x.state === "approved")) {
      await need().pool.query(`insert into "user" (provider, subject, role, github_login) select 'dev', $1::text, 'owner', $1::text where not exists (select 1 from "user" where github_login = $1::text)`, [r.author]);
    }
  };
});

Given("PR {int}'s Definition of Done shows line {int} passed on Green's gate run", function (n: number, index: number) {
  editBody(this, n, (b) => {
    const l = b.dod[index - 1];
    assert.ok(l, `PR ${n}'s body has no Definition of Done line ${index}`);
    l.text = "Tests and scenarios pass.";
    l.ticked = true;
    l.person = false;
  });
});

// A check CI reports finished a few minutes ago, as GitHub's carry a finish time. So a failed one's re-run (PBI 233),
// which the poll asks for once, reads as still to come on that poll, and the item stays in review while it runs.
function reportCi(world: object, name: string, sha: string, conclusion: "success" | "failure") {
  const host = pollCtx(world).host!;
  host.checks.set(`${REPO}@${sha}`, conclusion);
  const completedAt = new Date(Date.now() - 5 * 60_000).toISOString();
  host.ciChecks.set(`${REPO}@${sha}`, [{ name, conclusion, url: `https://github.com/${REPO}/actions/runs/${sha}`, completedAt }]);
}

Given("CI reports the check {string} passed on {string}", function (name: string, sha: string) {
  reportCi(this, name, sha, "success");
});

Given("CI reports the check {string} failed on {string}", function (name: string, sha: string) {
  reportCi(this, name, sha, "failure");
});

Given("CI hasn't reported the check {string} on {string}", function (_name: string, sha: string) {
  const host = pollCtx(this).host!;
  host.checks.delete(`${REPO}@${sha}`);
  host.ciChecks.delete(`${REPO}@${sha}`);
});
