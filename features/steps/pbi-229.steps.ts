// Step definitions for features/pbi-229-dod-ci-check.feature. A scenario that judges a Definition of Done line runs
// the cell's own check, checkDefinitionOfDone from src/cell/engine.ts, in a temporary checkout whose package.json
// `test` script leaves a mark file when it runs and exits with the code the scenario gives it. So "the cell ran line
// 1's command" reads the mark, and a reason of "exit 0" or "exit 1" comes from the command itself.
//
// CI is a map from commit to the checks reported on it. The check reads it through the lookup the engine hands it:
// none when no PR exists, and null for a commit CI hasn't reported on. The commit being judged is the check's `head`,
// and its stored results are what it hands to `store`, as the engine hands them to the cell API's /policy-results.
//
// The addresser's scenarios set up the address stage's agent run through agentOptions, as the engine does, and read
// what the run's factory-pr-addresser definition and the address stage's prompt tell it. The last rule reads this
// repo's own .factory/dod.md through loadPolicy and its CI workflow.
import { After, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { agentOptions, type AgentArgs } from "../../src/agent/run.ts";
import { checkDefinitionOfDone, type CiCheck } from "../../src/cell/engine.ts";
import { loadPolicy, parseCriteria, type Policy, type Verdict } from "../../src/policy/policy.ts";

const repo = process.cwd();
const long = { timeout: 60_000 };
const MARK = "dod-line-1-ran.mark";
const ADDRESSER = "factory-pr-addresser";

type Ctx = {
  dir: string | null;
  lineText: string | null;
  /** The exit code line 1's command leaves with. */
  exitCode: number;
  /** The PR's commits, oldest first, or null when no PR exists. */
  pr: string[] | null;
  /** The checks CI reported, by commit. A commit absent here has no CI report. */
  ci: Map<string, CiCheck[]>;
  /** The commits whose checks the cell asked for. */
  asked: string[];
  result: { verdicts: Verdict[]; findings: string[] } | null;
  stored: { checkedSha: string; verdicts: Verdict[] }[];
  error: unknown;
  /** What the addresser's run is told: its definition's instructions and the address stage's prompt. */
  told: string | null;
  policy: Policy | null;
};

function mine(world: object): Ctx {
  const w = world as { pbi229?: Ctx };
  w.pbi229 ??= { dir: null, lineText: null, exitCode: 0, pr: null, ci: new Map(), asked: [], result: null, stored: [], error: null, told: null, policy: null };
  return w.pbi229;
}

After(function () {
  const c = (this as { pbi229?: Ctx }).pbi229;
  if (c?.dir) rmSync(c.dir, { recursive: true, force: true });
});

function checkout(c: Ctx): string {
  c.dir ??= mkdtempSync(join(tmpdir(), "pbi229-"));
  return c.dir;
}

/** package.json's `test` script writes the mark, then exits with the scenario's code. */
function writeCommand(c: Ctx) {
  const script = `node -e "require('fs').writeFileSync('${MARK}', 'ran'); process.exit(${c.exitCode})"`;
  writeFileSync(join(checkout(c), "package.json"), JSON.stringify({ name: "item-482", private: true, scripts: { test: script } }, null, 2));
}

function report(c: Ctx, sha: string, check: CiCheck) {
  const on = c.ci.get(sha) ?? [];
  on.push(check);
  c.ci.set(sha, on);
}

// ---- Given ----

// "a run for item {int} whose scenarios were signed off" is PBI 18's step, which sets up a run of its own. This
// feature's checkout is set up here, with line 1's command passing until a scenario says otherwise.
Given("the repo's Definition of Done line 1 is {string}", function (line: string) {
  const c = mine(this);
  c.lineText = line;
  writeCommand(c);
  writeFileSync(join(checkout(c), "dod.md"), `# Definition of Done\n\n- [ ] ${line}\n`);
});

Given("line 1's command fails in the checkout", function () {
  const c = mine(this);
  c.exitCode = 1;
  writeCommand(c);
});

Given("line 1's command fails in the checkout with exit code {int}", function (code: number) {
  const c = mine(this);
  c.exitCode = code;
  writeCommand(c);
});

Given("line 1's command passes in the checkout", function () {
  const c = mine(this);
  c.exitCode = 0;
  writeCommand(c);
});

Given("the item's PR is open at commit {string}", function (sha: string) {
  mine(this).pr = [sha];
});

Given("the item's PR was at commit {string} and is now at commit {string}", function (before: string, now: string) {
  mine(this).pr = [before, now];
});

Given("no PR exists for the item", function () {
  mine(this).pr = null;
});

Given("CI reports the check {string} passed on {string} at {string}", function (name: string, sha: string, url: string) {
  report(mine(this), sha, { name, conclusion: "success", url });
});

Given("CI reports the check {string} failed on {string} at {string}", function (name: string, sha: string, url: string) {
  report(mine(this), sha, { name, conclusion: "failure", url });
});

Given("no CI run has reported on {string}", function (sha: string) {
  mine(this).ci.delete(sha);
});

Given("CI reports no check named {string} on {string}", function (name: string, sha: string) {
  const c = mine(this);
  const on = c.ci.get(sha);
  if (on) c.ci.set(sha, on.filter((x) => x.name !== name));
});

// ---- When ----

async function checkAt(c: Ctx, head: string) {
  assert.ok(c.lineText, "the repo has no Definition of Done");
  const dir = checkout(c);
  rmSync(join(dir, MARK), { force: true });
  const text = readFileSync(join(dir, "dod.md"), "utf8");
  const dod: Policy = { name: "dod", source: "repo", sha: "dod-sha", text, criteria: parseCriteria(text) };
  c.asked = [];
  c.stored = [];
  c.error = null;
  c.result = null;
  const ciChecks = c.pr === null ? null : async (sha: string) => {
    c.asked.push(sha);
    return c.pr!.includes(sha) ? c.ci.get(sha) ?? null : null;
  };
  try {
    c.result = await checkDefinitionOfDone({
      dir, head, dod, ciChecks,
      judge: async (judged) => { throw new Error(`no line but line 1 should go to the judge, but these did: ${judged.map((j) => j.index).join(", ")}`); },
      store: async (checkedSha, verdicts) => { c.stored.push({ checkedSha, verdicts }); },
    });
  } catch (e) {
    c.error = e;
  }
}

When("the cell checks the Definition of Done at {string}", long, async function (sha: string) {
  await checkAt(mine(this), sha);
});

When("the cell checks the Definition of Done at Green", long, async function () {
  // Green runs before any PR exists, so the commit it judges is the branch's head, which no CI has seen.
  await checkAt(mine(this), "green-head");
});

// ---- Then: the line's verdict ----

function result(c: Ctx) {
  assert.equal(c.error, null, `the Definition of Done check threw: ${c.error instanceof Error ? c.error.stack : String(c.error)}`);
  assert.ok(c.result, "the cell didn't check the Definition of Done");
  return c.result;
}

function line1(c: Ctx): Verdict {
  const v = result(c).verdicts.find((x) => x.index === 1);
  assert.ok(v, "the check gave no verdict for line 1");
  return v;
}

Then("Definition of Done line 1 passes", function () {
  const v = line1(mine(this));
  assert.equal(v.status, "passed", `line 1 ${v.status}: ${v.reason}`);
});

Then("Definition of Done line 1 fails", function () {
  const v = line1(mine(this));
  assert.equal(v.status, "failed", `line 1 ${v.status}: ${v.reason}`);
});

Then("Definition of Done line 1 passes with the reason {string}", function (reason: string) {
  const v = line1(mine(this));
  assert.equal(v.status, "passed", `line 1 ${v.status}: ${v.reason}`);
  assert.equal(v.reason, reason);
});

Then("Definition of Done line 1 fails with a reason that starts {string}", function (start: string) {
  const v = line1(mine(this));
  assert.equal(v.status, "failed", `line 1 ${v.status}: ${v.reason}`);
  assert.ok(v.reason.startsWith(start), `line 1's reason doesn't start "${start}": ${v.reason}`);
});

Then("line 1's reason names the check {string} and {string}", function (name: string, url: string) {
  const v = line1(mine(this));
  assert.ok(new RegExp(`(^|[^\\w-])${name.replace(/[-.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w-]|$)`).test(v.reason), `line 1's reason doesn't name the check "${name}": ${v.reason}`);
  assert.ok(v.reason.includes(url), `line 1's reason doesn't give ${url}: ${v.reason}`);
});

Then("line 1's reason doesn't name the check {string}", function (name: string) {
  const v = line1(mine(this));
  assert.ok(!v.reason.includes(name), `line 1's reason names the check "${name}": ${v.reason}`);
});

Then("the cell ran line 1's command", function () {
  const c = mine(this);
  result(c);
  assert.ok(existsSync(join(checkout(c), MARK)), "line 1's command didn't run in the checkout");
});

Then("the cell didn't run line 1's command", function () {
  const c = mine(this);
  result(c);
  assert.ok(!existsSync(join(checkout(c), MARK)), "line 1's command ran in the checkout");
});

// ---- Then: the stage's findings ----

Then("the stage's findings don't name Definition of Done line 1", function () {
  const f = result(mine(this)).findings;
  assert.deepEqual(f.filter((x) => /Definition of Done line 1\b/.test(x)), [], `the findings name line 1:\n${f.join("\n")}`);
});

Then("the stage's findings say Definition of Done line 1 failed, naming the check {string} and {string}", function (name: string, url: string) {
  const f = result(mine(this)).findings;
  const hit = f.find((x) => /Definition of Done line 1 failed/.test(x));
  assert.ok(hit, `no finding says line 1 failed:\n${f.join("\n")}`);
  assert.ok(hit.includes(`"${name}"`) || new RegExp(`check ${name}\\b|\\b${name} check`).test(hit), `the finding doesn't name the check "${name}": ${hit}`);
  assert.ok(hit.includes(url), `the finding doesn't give ${url}: ${hit}`);
});

Then("the stage's findings say the check {string} was missing on {string}", function (name: string, sha: string) {
  const f = result(mine(this)).findings;
  const hit = f.find((x) => x.includes(name) && x.includes(sha) && /missing|no check|didn't report|not reported|never ran/i.test(x));
  assert.ok(hit, `no finding says the check "${name}" was missing on ${sha}:\n${f.join("\n") || "(no findings)"}`);
});

Then("the stage's findings don't say any check was missing", function () {
  const f = result(mine(this)).findings;
  assert.deepEqual(f.filter((x) => /missing|no check|didn't report|not reported|never ran/i.test(x)), [], `the findings say a check was missing:\n${f.join("\n")}`);
});

// ---- Then: what's stored ----

Then("the stored Definition of Done results for {string} show line 1 passed", function (sha: string) {
  const c = mine(this);
  result(c);
  const at = c.stored.filter((s) => s.checkedSha === sha);
  assert.equal(at.length, 1, `expected one stored result for ${sha}, got ${c.stored.map((s) => s.checkedSha).join(", ") || "none"}`);
  const v = at[0]!.verdicts.find((x) => x.index === 1);
  assert.ok(v, `the stored results for ${sha} have no line 1`);
  assert.equal(v.status, "passed", `the stored line 1 ${v.status}: ${v.reason}`);
});

Then("the stored reason for line 1 names the check {string} and {string}", function (name: string, url: string) {
  const c = mine(this);
  const v = c.stored.at(-1)?.verdicts.find((x) => x.index === 1);
  assert.ok(v, "no stored verdict for line 1");
  assert.ok(new RegExp(`(^|[^\\w-])${name}([^\\w-]|$)`).test(v.reason), `the stored reason doesn't name the check "${name}": ${v.reason}`);
  assert.ok(v.reason.includes(url), `the stored reason doesn't give ${url}: ${v.reason}`);
});

// ---- The PR addresser ----

When("the address stage sets up its agent run", function () {
  const c = mine(this);
  const dir = checkout(c);
  const args: AgentArgs = { prompt: "# Address brief", model: "claude-sonnet-4-5", cwd: dir, agent: ADDRESSER, mode: "cell", webTools: [], signal: new AbortController().signal };
  const def = agentOptions(args).agents?.[ADDRESSER];
  assert.ok(def, `the address stage's run gets no factory definition of ${ADDRESSER}`);
  // The engine's address brief starts with the stage's prompt.
  const stagePrompt = readFileSync(join(repo, "sop/prompts/address.md"), "utf8");
  c.told = `${def.prompt}\n\n${stagePrompt}`;
});

const sentences = (text: string) => text.replace(/\s+/g, " ").split(/(?<=[.!?])\s+|\n/);

Then("the addresser the run gets is told to run only the tests for the code it changed", function () {
  const told = mine(this).told!;
  const hit = sentences(told).find((s) => /\bonly\b/i.test(s) && /\btests?\b/i.test(s) && /\b(changed?|touched|edited)\b/i.test(s) && /\brun\b/i.test(s));
  assert.ok(hit, "the addresser isn't told to run only the tests for the code it changed");
});

Then("the addresser the run gets is told to leave the full test suite to CI and the Definition of Done check", function () {
  const told = mine(this).told!;
  const hit = sentences(told).find((s) => /\b(full|whole|entire)\b[^.]*\bsuite\b/i.test(s) && /\bCI\b/.test(s) && /Definition of Done|\bDoD\b/.test(s));
  assert.ok(hit, "the addresser isn't told to leave the full test suite to CI and the Definition of Done check");
});

// ---- This repo's Definition of Done ----

When("the factory reads this repo's {string}", async function (path: string) {
  const c = mine(this);
  c.policy = await loadPolicy(async (p) => (p === path && existsSync(join(repo, p)) ? readFileSync(join(repo, p), "utf8") : null), "dod");
  assert.ok(c.policy, `this repo has no ${path}`);
});

Then("Definition of Done line 1 names the CI check {string}", function (name: string) {
  const l = mine(this).policy!.criteria.find((x) => x.index === 1);
  assert.ok(l, "the Definition of Done has no line 1");
  assert.equal(l.ci ?? null, name, `line 1 doesn't name the CI check "${name}": ${l.text}`);
});

Then("Definition of Done line 1 still has the command {string}", function (command: string) {
  const l = mine(this).policy!.criteria.find((x) => x.index === 1);
  assert.ok(l, "the Definition of Done has no line 1");
  assert.equal(l.run, command);
});

Then("this repo's CI has a check named {string}", function (name: string) {
  const dir = join(repo, ".github/workflows");
  const names: string[] = [];
  for (const f of readdirSync(dir).filter((x) => /\.ya?ml$/.test(x))) {
    const wf = (parse(readFileSync(join(dir, f), "utf8")) ?? {}) as { on?: unknown; jobs?: Record<string, { name?: string }> };
    // A push workflow reports a check on a PR's commits as well as a pull_request one does. This repo's ci.yml runs
    // on push alone (see the comment there), so both count.
    const on = wf.on;
    const has = (t: string) => on === t || (Array.isArray(on) && on.includes(t)) || (typeof on === "object" && on !== null && t in on);
    if (!has("push") && !has("pull_request")) continue;
    for (const [id, job] of Object.entries(wf.jobs ?? {})) names.push(job?.name ?? id);
  }
  assert.ok(names.includes(name), `no workflow that runs on push or pull requests has a job named "${name}": ${names.join(", ")}`);
});
