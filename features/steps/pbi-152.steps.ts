// Step definitions for features/pbi-152-locked-file-restore.feature. Each scenario runs PBI 18's engine harness: a real
// temporary git repo cloned from a bare origin, a recording cell API and a fake repo host. On top of it, these steps
// lock item 482's own feature files at a fresh lock commit, record every push the origin receives, and script the agent
// call by call: the self-reviewer's rounds, the fix passes between them, open-pr's summary pass, and each attempt at
// red, green and address.
//
// The scripted self-reviewer writes a scenario it thinks is wrong as a line starting `SCENARIO NOTE:`, before its
// last line. That's the form the self-reviewer's brief asks for, and the engine carries the line into the PR body.
import { Given, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setUp, type Ctx as CellCtx } from "./pbi-18.steps.ts";

const BRANCH = "factory/pbi-482-r1";
const ORDERS = "features/pbi-482-orders.feature";
const STEPS = "features/steps/pbi-482-orders.steps.ts";
const STEPS_TEXT = 'import { Then } from "@cucumber/cucumber";\n// the step definitions red wrote\n';

type Role = "red" | "green" | "address" | "reviewer" | "fix" | "summary" | "other";
type Action = (cwd: string, n: number) => void;
/** One agent call, with the locked files as the call found them in the checkout. */
type Seen = { role: Role; n: number; prompt: string; files: Map<string, string | null> };

type Ctx = {
  lockedFiles: string[];
  locked: boolean;
  pushLog: string;
  /** Rounds in which the self-reviewer holds a finding open. Every other round approves. */
  openRounds: Set<number>;
  note: string | null;
  /** What each role does on its nth call, after the default agent ran, or instead of it when `skip` holds. */
  actions: { role: Role; n: number | "every"; act: Action }[];
  skip: { role: Role; n: number }[];
  seen: Seen[];
  openedAt: string[];
  replies: { threadId: string; body: string }[];
  that: { stage: string; attempt: number } | null;
};

function mine(world: object): Ctx {
  const w = world as { pbi152?: Ctx };
  w.pbi152 ??= {
    lockedFiles: [ORDERS], locked: false, pushLog: "", openRounds: new Set(), note: null, actions: [], skip: [], seen: [],
    openedAt: [], replies: [], that: null,
  };
  return w.pbi152;
}

function cell(world: object): CellCtx {
  const w = world as { pbi18?: CellCtx };
  assert.ok(w.pbi18, "no run was set up");
  return w.pbi18;
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function featureText(path: string): string {
  const name = path.includes("refunds") ? "Refunds" : "Orders";
  const noun = name === "Refunds" ? "refund" : "order";
  return [
    "@pbi-482",
    `Feature: ${name}`,
    "",
    "  @ac-1",
    `  Scenario: An ${noun} with no lines is refused`,
    `    When a customer places an ${noun} with no lines`,
    `    Then the ${noun} is refused`,
    "",
    "  @ac-2",
    `  Scenario: An ${noun} with lines is accepted`,
    `    When a customer places an ${noun} with two lines`,
    `    Then the ${noun} is accepted`,
    "",
  ].join("\n");
}

/** Changes the first scenario's outcome, differently on every call, so the file always differs from the lock. */
function editScenario(cwd: string, path: string, n: number) {
  const file = join(cwd, path);
  const text = existsSync(file) ? readFileSync(file, "utf8") : featureText(path);
  writeFileSync(file, text.replace(/^( {4}Then ).*$/m, `$1the order is saved as a draft, edit ${n}`));
}

function commit(cwd: string, msg: string) {
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", msg);
}

/** Text of `path` at `rev`, or null when the commit doesn't hold it. */
function at(cwd: string, rev: string, path: string): string | null {
  try {
    return execFileSync("git", ["show", `${rev}:${path}`], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

function lockText(c: CellCtx, path: string): string {
  const text = at(c.dir, c.lockSha!, path);
  assert.notEqual(text, null, `the lock commit holds no ${path}`);
  return text!;
}

function pushedHead(c: CellCtx): string {
  return git(c.root, "--git-dir", c.origin, "rev-parse", BRANCH);
}

function roleOf(stage: string, a: { prompt: string; agent?: string; mode: string }): Role {
  if (a.agent === "factory-self-reviewer") return "reviewer";
  if (a.agent === "factory-pr-addresser") return "address";
  if (a.mode !== "cell" || a.agent) return "other";
  // A Definition of Done judge's brief lists its criteria as JSON lines. It's no stage's own call.
  if (/^\{"index":\d+,"criterion":/m.test(a.prompt)) return "other";
  if (stage === "self-review") return "fix";
  if (stage === "open-pr") return "summary";
  if (stage === "red" || stage === "green") return stage;
  return "other";
}

/**
 * Locks item 482's feature files at a new lock commit on the run's branch, in place of PBI 18's own feature file, and
 * pushes it. From then on the origin logs every push, and the scripted agent and recording repo host are in place.
 * PBI 142's open-pr step sets the run up, so every Given here calls this first, and it runs once.
 */
function ensure(world: object): { c: CellCtx; m: Ctx } {
  const c = cell(world);
  const m = mine(world);
  if (m.locked) return { c, m };
  m.locked = true;
  rmSync(join(c.dir, "features/pbi-482.feature"), { force: true });
  for (const p of m.lockedFiles) {
    mkdirSync(dirname(join(c.dir, p)), { recursive: true });
    writeFileSync(join(c.dir, p), featureText(p));
  }
  commit(c.dir, "specify(@pbi-482): scenarios");
  git(c.dir, "push", "-q", "origin", `HEAD:refs/heads/${BRANCH}`);
  c.lockSha = git(c.dir, "rev-parse", "HEAD");
  c.lockedFiles = [...m.lockedFiles];
  c.startHead = c.lockSha;

  m.pushLog = join(c.root, "pushes.log");
  writeFileSync(m.pushLog, "");
  const hook = join(c.origin, "hooks", "post-receive");
  writeFileSync(hook, `#!/bin/sh\nwhile read old new ref; do echo "$ref $new" >> "${m.pushLog}"; done\n`);
  chmodSync(hook, 0o755);

  const host = c.repoHost ?? {
    async openOrUpdatePr(p: { body: string }) { c.prBodies.push(p.body); return { number: 7, url: "https://github.com/acme/app/pull/7" }; },
    async requestReviewers() { return []; },
    async openReviewComments() { return []; },
    async prState() { return { open: true, merged: false, mergeSha: null }; },
    async replyToThread(_repo: string, threadId: string, body: string) { m.replies.push({ threadId, body }); },
    async commentOnPr() {},
  };
  c.repoHost = {
    ...host,
    async openOrUpdatePr(p: unknown) {
      m.openedAt.push(pushedHead(c));
      return (host.openOrUpdatePr as (p: unknown) => Promise<unknown>)(p);
    },
  };

  const counts = new Map<Role, number>();
  c.agent = async (a, base) => {
    const role = roleOf(c.stage, a);
    const n = (counts.get(role) ?? 0) + 1;
    counts.set(role, n);
    const files = new Map(c.lockedFiles.map((p) => [p, existsSync(join(a.cwd, p)) ? readFileSync(join(a.cwd, p), "utf8") : null]));
    m.seen.push({ role, n, prompt: a.prompt, files });
    const skip = m.skip.some((s) => s.role === role && s.n === n);
    const r = skip ? { ok: true, text: "done", costUsd: 0.5, tokensIn: 10, tokensOut: 5, model: a.model, limit: null, usage: null, transcript: "{}\n" } : await base(a);
    if (role === "reviewer") {
      const verdicts = [...a.prompt.matchAll(/^\{"index":(\d+),"criterion":".*"\}$/gm)]
        .map((x) => JSON.stringify({ index: Number(x[1]), status: "passed", reason: "ok" }));
      const body = m.openRounds.has(n)
        ? ["1. app.txt: `foo` says nothing about what it holds. Rename it.", "OPEN: 1"]
        : [...(m.note ? [`SCENARIO NOTE: The scenario "${m.note}" looks wrong: an order with no lines should be kept as a draft, not refused.`] : []), "APPROVED"];
      r.text = [...verdicts, ...body].join("\n");
    }
    for (const x of m.actions) if (x.role === role && (x.n === "every" || x.n === n)) x.act(a.cwd, n);
    return r;
  };
  return { c, m };
}

function seenOf(m: Ctx, role: Role): Seen[] {
  return m.seen.filter((s) => s.role === role);
}

function nth(m: Ctx, role: Role, n: number, what: string): Seen {
  const s = seenOf(m, role).find((x) => x.n === n);
  assert.ok(s, `${what} never ran`);
  return s;
}

function stageReports(c: CellCtx, stage: string): Record<string, any>[] {
  return c.calls.filter((x) => x.route === "/stage" && x.body.stageId === stage && x.body.status !== "started").map((x) => x.body);
}

function ranClean(c: CellCtx) {
  assert.equal(c.error, null, `the cell failed: ${String(c.error)}`);
}

const roleFor = (stage: string): Role => {
  const r = ({ red: "red", green: "green", address: "address", "open-pr": "summary" } as Record<string, Role>)[stage];
  assert.ok(r, `no agent role for the ${stage} stage`);
  return r;
};

const UNDONE = /\b(undo|undoes|undone|undid|restore|restores|restored|revert|reverts|reverted|puts? back)\b/i;
const WHY = /\block(ed)?\b|sign(ed)?[- ]off/i;
const NEGATION = /\b(no|never|not|don't|doesn't|mustn't|may not|cannot|can't)\b/i;
const sentences = (text: string) => text.split(/(?<=[.!?])\s+|\n+/);

function namesLocked(prompt: string, path: string, what: string) {
  const i = prompt.indexOf(path);
  assert.ok(i >= 0, `${what} doesn't name ${path}`);
  // "The locked feature files: <path>." or "<path> is locked": the word sits on the path's line or just before it.
  const near = prompt.slice(Math.max(0, i - 300), i + path.length + 100);
  assert.match(near, /\blocked\b/i, `${what} doesn't say ${path} is locked`);
}

function saysUndone(prompt: string, what: string) {
  assert.ok(sentences(prompt).some((s) => UNDONE.test(s) && /\blocked\b/i.test(s)), `${what} doesn't say the factory undoes a change to a locked feature file`);
}

// The standing "## The locked feature files" section names every locked file and says a change is undone, so it
// would satisfy these checks on its own. Only what's outside it can say this edit was undone.
const withoutLockedSection = (prompt: string) => prompt.replace(/^## The locked feature files\n[\s\S]*?(?=^## |(?![\s\S]))/m, "");

function saysEditUndone(prompt: string, path: string, what: string) {
  const rest = sentences(withoutLockedSection(prompt)).filter((s) => s.includes(path));
  assert.ok(rest.length, `${what} doesn't name ${path} outside its standing note on the locked files`);
  const undone = rest.filter((s) => UNDONE.test(s));
  assert.ok(undone.length, `${what} doesn't say the edit to ${path} was undone`);
  assert.ok(undone.some((s) => WHY.test(s)), `${what} doesn't say why: that the file is locked since sign-off`);
}

// ---- the run ----

Given(/^a run for item (\d+) that resumes at (red|green|self-review|address)$/, function (_item: string, stage: string) {
  const c = setUp(this, stage, true);
  if (stage === "address") c.trusted.push({ author: "owner", body: "Rename foo to something that says what it holds." });
  ensure(this);
});

Given("a run for item {int} that resumes at address with one trusted review comment", function (_item: number) {
  const c = setUp(this, "address", true);
  c.trusted.push({ author: "owner", body: "Rename foo to something that says what it holds." });
  ensure(this);
});

Given("item {int}'s feature files {string} and {string} were locked at sign-off", function (_item: number, a: string, b: string) {
  mine(this).lockedFiles = [a, b];
});

// ---- the self-reviewer ----

Given("the self-reviewer holds one finding open in its first round", function () {
  ensure(this).m.openRounds = new Set([1]);
});

Given("the self-reviewer holds one finding open in each of its first two rounds", function () {
  ensure(this).m.openRounds = new Set([1, 2]);
});

Given("the self-reviewer holds one finding open in its first round and approves in its second", function () {
  ensure(this).m.openRounds = new Set([1]);
});

Given("the self-reviewer approves in its first round", function () {
  ensure(this).m.openRounds = new Set();
});

Given("the self-reviewer approves, noting that the scenario {string} looks wrong", function (name: string) {
  const { m } = ensure(this);
  m.openRounds = new Set();
  m.note = name;
});

Given("an edit to {string} is left uncommitted when it approves", function (path: string) {
  ensure(this).m.actions.push({ role: "reviewer", n: 1, act: (cwd, n) => editScenario(cwd, path, n) });
});

// ---- the stages' agents ----

Given("the first fix pass edits a scenario in {string}", function (path: string) {
  ensure(this).m.actions.push({ role: "fix", n: 1, act: (cwd, n) => { editScenario(cwd, path, n); commit(cwd, "fix: the scenario was wrong"); } });
});

Given("the first fix pass deletes {string}", function (path: string) {
  ensure(this).m.actions.push({ role: "fix", n: 1, act: (cwd) => { rmSync(join(cwd, path)); commit(cwd, "fix: drop the scenarios"); } });
});

Given("the first fix pass edits {string} and {string} in one commit", function (feature: string, code: string) {
  ensure(this).m.actions.push({ role: "fix", n: 1, act: (cwd, n) => {
    editScenario(cwd, feature, n);
    mkdirSync(dirname(join(cwd, code)), { recursive: true });
    writeFileSync(join(cwd, code), "export const refuseEmptyOrders = true;\n");
    commit(cwd, "fix: the finding, and the scenario");
  } });
});

Given("the summary pass edits a scenario in {string}", function (path: string) {
  ensure(this).m.actions.push({ role: "summary", n: "every", act: (cwd, n) => editScenario(cwd, path, n) });
});

Given("the summary pass edits both {string} and {string}", function (a: string, b: string) {
  ensure(this).m.actions.push({ role: "summary", n: "every", act: (cwd, n) => { editScenario(cwd, a, n); editScenario(cwd, b, n); } });
});

Given("the {word} agent's first attempt edits a scenario in {string}", function (stage: string, path: string) {
  ensure(this).m.actions.push({ role: roleFor(stage), n: 1, act: (cwd, n) => editScenario(cwd, path, n) });
});

Given("the {word} agent's second attempt changes no locked feature file and does the stage's work", function (stage: string) {
  // The default agent does the stage's work on every call, and only the first call edits, so nothing more to script.
  roleFor(stage);
  ensure(this);
});

Given("red's first attempt writes the step definitions and edits a scenario in {string}", function (path: string) {
  ensure(this).m.actions.push({ role: "red", n: 1, act: (cwd, n) => {
    mkdirSync(dirname(join(cwd, STEPS)), { recursive: true });
    writeFileSync(join(cwd, STEPS), STEPS_TEXT);
    editScenario(cwd, path, n);
  } });
});

Given("red's second attempt changes nothing", function () {
  // The first attempt's run report stays in the harness's fixtures, so red's gate reads it again.
  ensure(this).m.skip.push({ role: "red", n: 2 });
});

Given("the address agent's second attempt changes no locked feature file and writes a reply to the comment", function () {
  ensure(this).m.actions.push({ role: "address", n: 2, act: () => {
    const prompt = nth(mine(this), "address", 2, "the address agent's second attempt").prompt;
    const file = /The reply file is `([^`]+)`/.exec(prompt)?.[1];
    assert.ok(file, "the address brief names no reply file");
    writeFileSync(file, JSON.stringify({ threadId: "t0", body: "Renamed it." }) + "\n");
  } });
});

Given("every {word} attempt edits a scenario in {string}", function (stage: string, path: string) {
  const { m } = ensure(this);
  const roles: Role[] = stage === "self-review" ? ["reviewer", "fix"] : [roleFor(stage)];
  for (const role of roles) m.actions.push({ role, n: "every", act: (cwd, n) => editScenario(cwd, path, n) });
});

// ---- briefs ----

function fixBrief(world: object, round: number): string {
  return nth(mine(world), "fix", round, `the fix pass in round ${round}`).prompt;
}

Then("the fix pass's brief names {string} as locked", function (path: string) {
  namesLocked(fixBrief(this, 1), path, "the fix pass's brief");
});

Then("the fix pass's brief says the factory undoes any change to a locked feature file", function () {
  saysUndone(fixBrief(this, 1), "the fix pass's brief");
});

Then("the fix pass's brief in round {int} names {string} as locked", function (round: number, path: string) {
  namesLocked(fixBrief(this, round), path, `the fix pass's brief in round ${round}`);
});

Then("the fix pass's brief in round {int} says the factory undoes any change to a locked feature file", function (round: number) {
  saysUndone(fixBrief(this, round), `the fix pass's brief in round ${round}`);
});

function reviewerBrief(world: object, round = 1): string {
  return nth(mine(world), "reviewer", round, `the self-reviewer's round ${round}`).prompt;
}

Then("the self-reviewer's brief names {string} as locked", function (path: string) {
  namesLocked(reviewerBrief(this), path, "the self-reviewer's brief");
});

Then("the self-reviewer's brief says no finding it holds open may ask for a change to a scenario", function () {
  const said = sentences(reviewerBrief(this)).some((s) => /\bfindings?\b/i.test(s) && /\bscenarios?\b/i.test(s) && NEGATION.test(s));
  assert.ok(said, "the self-reviewer's brief doesn't say a finding may not ask for a scenario change");
});

Then("the self-reviewer's brief says a scenario it thinks is wrong goes in the PR body as a note for the person who merges", function () {
  const prompt = reviewerBrief(this);
  const said = sentences(prompt).some((s) => /\bscenario\b/i.test(s) && /\b(PR|pull request)('s)? body\b/i.test(s));
  assert.ok(said, "the self-reviewer's brief doesn't say a doubted scenario goes in the PR body");
  assert.match(prompt, /person who merges/i, "the self-reviewer's brief doesn't name the person who merges");
  assert.ok(prompt.includes("SCENARIO NOTE:"), "the self-reviewer's brief doesn't give the `SCENARIO NOTE:` line to write");
});

Then("the self-reviewer's second round brief says the fix pass's edit to {string} was undone, and why", function (path: string) {
  saysEditUndone(reviewerBrief(this, 2), path, "the self-reviewer's second round brief");
});

Then("the second fix pass's brief says the earlier edit to {string} was undone, and why", function (path: string) {
  saysEditUndone(fixBrief(this, 2), path, "the second fix pass's brief");
});

Then("the {word} agent's second brief says its edit to {string} was undone, and why", function (stage: string, path: string) {
  saysEditUndone(nth(mine(this), roleFor(stage), 2, `the ${stage} agent's second attempt`).prompt, path, `the ${stage} agent's second brief`);
});

// ---- what the agent saw ----

Then("the self-reviewer's second round sees {string} as it was at the lock commit", function (path: string) {
  const c = cell(this);
  const seen = nth(mine(this), "reviewer", 2, "the self-reviewer's second round");
  assert.equal(seen.files.get(path), lockText(c, path), `the second round saw ${path} other than at the lock commit`);
});

Then("the {word} agent's second attempt starts from {string} as it was at the lock commit", function (stage: string, path: string) {
  const c = cell(this);
  const seen = nth(mine(this), roleFor(stage), 2, `the ${stage} agent's second attempt`);
  assert.equal(seen.files.get(path), lockText(c, path), `the ${stage} agent's second attempt found ${path} other than at the lock commit`);
});

// ---- the branch ----

Then("{string} on the branch matches the lock commit", function (path: string) {
  const c = cell(this);
  ranClean(c);
  const lock = lockText(c, path);
  assert.equal(at(c.dir, pushedHead(c), path), lock, `${path} as pushed differs from the lock commit`);
  assert.equal(at(c.dir, "HEAD", path), lock, `${path} at the cell's HEAD differs from the lock commit`);
});

Then("the branch has a commit that restores {string} to the lock commit", function (path: string) {
  const c = cell(this);
  ranClean(c);
  const lock = lockText(c, path);
  const head = pushedHead(c);
  const commits = git(c.dir, "rev-list", `${c.lockSha}..${head}`).split("\n").filter(Boolean);
  const restores = commits.filter((sha) => at(c.dir, sha, path) === lock && at(c.dir, `${sha}^`, path) !== lock);
  assert.ok(restores.length > 0, `no pushed commit since the lock restores ${path}`);
});

Then("the fix pass's change to {string} is still on the branch", function (path: string) {
  const c = cell(this);
  ranClean(c);
  assert.equal(at(c.dir, pushedHead(c), path), "export const refuseEmptyOrders = true;\n", `${path} as pushed doesn't hold the fix pass's change`);
});

Then("the step definitions the first attempt wrote are still on the branch", function () {
  const c = cell(this);
  ranClean(c);
  assert.equal(at(c.dir, pushedHead(c), STEPS), STEPS_TEXT, `${STEPS} as pushed doesn't hold red's first step definitions`);
});

function pushes(world: object): string[] {
  const m = mine(world);
  return readFileSync(m.pushLog, "utf8").split("\n").filter((l) => l.startsWith(`refs/heads/${BRANCH} `)).map((l) => l.split(" ")[1]);
}

Then("the branch is pushed at least once", function () {
  ranClean(cell(this));
  assert.ok(pushes(this).length > 0, "the branch was never pushed");
});

Then("every push of the branch has {string} as it was at the lock commit", function (path: string) {
  const c = cell(this);
  const lock = lockText(c, path);
  for (const sha of pushes(this)) assert.equal(at(c.dir, sha, path), lock, `push ${sha} carried ${path} in its edited form`);
});

// ---- the PR ----

Then("the PR is opened", function () {
  const c = cell(this);
  ranClean(c);
  assert.ok(c.prBodies.length > 0, "no PR was opened");
  assert.ok(c.calls.some((x) => x.route === "/transition" && x.body.event === "pr_opened"), "the item didn't move to InReview");
});

Then("the PR is opened at a head where {string} matches the lock commit", function (path: string) {
  const c = cell(this);
  ranClean(c);
  const opened = mine(this).openedAt;
  assert.ok(opened.length > 0, "no PR was opened");
  const lock = lockText(c, path);
  for (const sha of opened) assert.equal(at(c.dir, sha, path), lock, `the PR was opened at ${sha}, where ${path} differs from the lock commit`);
});

Then("the PR's body holds the note about the scenario {string} for the person who merges", function (name: string) {
  const c = cell(this);
  ranClean(c);
  const body = c.prBodies.at(-1);
  assert.ok(body, "no PR was opened");
  const sections = body.split(/\n(?=#)/);
  const note = sections.find((s) => s.includes(name));
  assert.ok(note, `the PR body doesn't name the scenario "${name}":\n${body}`);
  assert.match(note, /person who merges/i, `the PR body's note on "${name}" isn't for the person who merges:\n${note}`);
});

// ---- stage reports ----

Then("the self-review stage passes", function () {
  const c = cell(this);
  ranClean(c);
  const reports = stageReports(c, "self-review");
  assert.ok(reports.some((r) => r.status === "passed"), `self-review never passed: ${reports.map((r) => r.status).join(", ") || "it never ended"}`);
});

Then("the {word} stage's first attempt ends failed", function (stage: string) {
  const c = cell(this);
  ranClean(c);
  const first = stageReports(c, stage).find((r) => r.attempt === 1);
  assert.ok(first, `the ${stage} stage's first attempt never ended`);
  assert.equal(first.status, "failed", `the ${stage} stage's first attempt ended ${first.status}`);
  mine(this).that = { stage, attempt: 1 };
});

Then("the {word} stage's second attempt passes", function (stage: string) {
  const c = cell(this);
  ranClean(c);
  const second = stageReports(c, stage).find((r) => r.attempt === 2);
  assert.ok(second, `the ${stage} stage's second attempt never ended`);
  assert.equal(second.status, "passed", `the ${stage} stage's second attempt ended ${second.status}: ${second.message ?? ""}`);
});

function thatMessage(world: object): string {
  const that = mine(world).that;
  assert.ok(that, "no attempt was named");
  const r = stageReports(cell(world), that.stage).find((x) => x.attempt === that.attempt);
  return String(r?.message ?? "");
}

function saysRestored(message: string, path: string, what: string) {
  assert.ok(message.includes(path), `${what} doesn't name ${path}: ${message}`);
  assert.ok(UNDONE.test(message), `${what} doesn't say ${path} was restored: ${message}`);
  assert.match(message, /\block(ed)?\b/i, `${what} doesn't say it was restored to the lock commit: ${message}`);
}

Then("that attempt's message says {string} was restored to the lock commit", function (path: string) {
  saysRestored(thatMessage(this), path, "that attempt's message");
});

Then("that attempt's message says the file is locked since the owner signed off", function () {
  const message = thatMessage(this);
  assert.match(message, /\blocked\b/i, `that attempt's message doesn't say the file is locked: ${message}`);
  assert.match(message, /sign(ed)?[- ]off/i, `that attempt's message doesn't say the owner signed it off: ${message}`);
});

Then("the open-pr stage's last attempt's message says {string} was restored to the lock commit", function (path: string) {
  const c = cell(this);
  ranClean(c);
  const last = stageReports(c, "open-pr").at(-1);
  assert.ok(last, "open-pr never ended");
  saysRestored(String(last.message ?? ""), path, "open-pr's last message");
});

// ---- the owner and the review ----

function questions(c: CellCtx): string[] {
  return c.calls.filter((x) => x.route === "/transition" && x.body.question).map((x) => String(x.body.question.body ?? ""));
}

Then("the owner is asked no question", function () {
  const c = cell(this);
  ranClean(c);
  assert.deepEqual(questions(c), [], "the owner was asked a question");
});

Then("the owner is asked no question that says a locked feature file changed since sign-off", function () {
  const c = cell(this);
  ranClean(c);
  const asked = questions(c).filter((q) => /locked feature file changed|changed since sign-off/i.test(q));
  assert.deepEqual(asked, [], "the owner was asked about a locked feature file that changed since sign-off");
});

Then("the reply is posted on the comment's thread", function () {
  const c = cell(this);
  ranClean(c);
  assert.deepEqual(mine(this).replies, [{ threadId: "t0", body: "Renamed it." }], "the reply wasn't posted on the comment's thread");
});
