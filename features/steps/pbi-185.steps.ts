// Step definitions for features/pbi-185-red-expects-selected.feature. Each scenario runs the real cell engine in a
// temporary git repo cloned from a bare origin, against a recording cell API, a scripted agent that changes nothing,
// and a fake BDD runner. The fake runner stands in for cucumber-js: it reads the item's scenarios from a plan file,
// honours `--tags <expression>` as cucumber does, by leaving out every scenario the expression doesn't select, and
// writes a Cucumber Messages report. bdd.parse runs it with `--dry-run` and no filter, as this repo's bdd.parse does.
// bdd.run runs it with the repo's tag filter, which a scenario can change, so the engine sees the same commands it
// would see in a real repo and has to work out from them which scenarios the cell runs.
//
// Red's verdict is read from what the engine sent: Red passed when its last attempt was reported passed, and its
// findings are the lines of the needs_input question it blocks with. The verdict goes into PBI 14's gate, so PBI 14's
// "Red passes" and "Red fails with the finding" steps judge it, as they judge redGate's.
import { After, Given, Then, When } from "@cucumber/cucumber";
import type { DataTable } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repo = process.cwd();
const long = { timeout: 60_000 };
const STOP = "pbi-185: the scenario stops the cell once Red is judged";

type Verdict = "red" | "green";
/** One scenario as the runner sees it: a pickle, so a Scenario Outline's row is one of these. */
type Planned = { name: string; tags: string[]; verdict: Verdict; missing: boolean };
type Gate = { ok: boolean; findings: string[] };
type Call = { route: string; body: Record<string, any> };

type Ctx = {
  item: number;
  root: string | null;
  scenarios: Planned[];
  /** The repo's bdd.run tag filter, or null for none. */
  filter: string | null;
  /** The number of acceptance criteria, for Specify. */
  criteria: number;
  calls: Call[];
  error: unknown;
  startHead: string | null;
  answered: boolean;
};

function mine(world: object): Ctx {
  const w = world as { pbi185?: Ctx };
  w.pbi185 ??= { item: 482, root: null, scenarios: [], filter: "not @local", criteria: 0, calls: [], error: null, startHead: null, answered: false };
  return w.pbi185;
}

/** PBI 14's gate, which its "Red passes" and "Red fails with the finding" steps read. */
function setGate(world: object, gate: Gate) {
  const w = world as { pbi14?: { gate?: Gate | null } };
  w.pbi14 ??= {};
  w.pbi14.gate = gate;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=factory", "-c", "user.email=factory@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args],
    { cwd, encoding: "utf8" }).trim();
const fwd = (p: string) => p.replace(/\\/g, "/");
const tagsOf = (cell: string | undefined) => (cell ?? "").split(/\s+/).filter(Boolean);
const featurePath = (item: number) => `features/pbi-${item}-totals.feature`;
const branchOf = (item: number) => `factory/pbi-${item}-r1`;

// ---- the fake BDD runner ----

const RUNNER = `
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import parse from ${JSON.stringify(pathToFileURL(join(repo, "node_modules/@cucumber/tag-expressions/dist/index.js")).href)};
const here = dirname(fileURLToPath(import.meta.url));
const plan = JSON.parse(readFileSync(join(here, "plan.json"), "utf8"));
const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const at = args.indexOf("--tags");
const filter = at >= 0 ? parse(args[at + 1]) : null;
const lines = [];
let failed = false;
plan.scenarios.forEach((s, i) => {
  if (filter && !filter.evaluate(s.tags)) return;
  if (!dry && s.missing) return;
  const red = !dry && s.verdict === "red";
  if (red) failed = true;
  lines.push(
    { pickle: { id: "p" + i, uri: plan.uri, name: s.name, language: "en", astNodeIds: [], tags: s.tags.map((name) => ({ name, astNodeId: "" })),
      steps: [{ id: "s" + i + "a", type: "Action", text: "the thing runs", astNodeIds: [] }, { id: "s" + i + "b", type: "Outcome", text: "it works", astNodeIds: [] }] } },
    { testCase: { id: "c" + i, pickleId: "p" + i, testSteps: [{ id: "t" + i + "a", pickleStepId: "s" + i + "a" }, { id: "t" + i + "b", pickleStepId: "s" + i + "b" }] } },
    { testCaseStarted: { id: "r" + i, testCaseId: "c" + i, attempt: 0 } },
    { testStepFinished: { testCaseStartedId: "r" + i, testStepId: "t" + i + "a", testStepResult: { status: dry ? "SKIPPED" : "PASSED" } } },
    { testStepFinished: { testCaseStartedId: "r" + i, testStepId: "t" + i + "b", testStepResult: dry ? { status: "SKIPPED" } : red ? { status: "FAILED", message: "AssertionError" } : { status: "PASSED" } } },
  );
});
mkdirSync("reports", { recursive: true });
writeFileSync(join("reports", "bdd.ndjson"), lines.map((l) => JSON.stringify(l)).join("\\n") + "\\n");
process.exit(failed ? 1 : 0);
`;

function runnerCommand(c: Ctx, which: "parse" | "run"): string {
  const runner = `node "${fwd(join(c.root!, "fake", "bdd.mjs"))}"`;
  if (which === "parse") return `${runner} --dry-run`;
  return c.filter === null ? runner : `${runner} --tags "${c.filter}"`;
}

function writePlan(c: Ctx) {
  mkdirSync(join(c.root!, "fake"), { recursive: true });
  writeFileSync(join(c.root!, "fake", "bdd.mjs"), RUNNER);
  writeFileSync(join(c.root!, "fake", "plan.json"), JSON.stringify({ uri: featurePath(c.item), scenarios: c.scenarios }));
}

// ---- the item's feature file ----

/** The feature file the scenarios come from: plain scenarios, and outlines whose rows sit in tagged Examples blocks. */
function featureText(c: Ctx): string {
  const tag = `@pbi-${c.item}`;
  const lines = [tag, `Feature: Item ${c.item}`, ""];
  const outlines = new Map<string, Planned[]>();
  for (const s of c.scenarios) {
    const own = s.tags.filter((t) => t !== tag);
    const outline = /^(.*) for (\w+)$/.exec(s.name);
    if (outline && c.scenarios.filter((x) => x.name.startsWith(`${outline[1]} for `)).length > 1) {
      const key = outline[1]!;
      outlines.set(key, [...(outlines.get(key) ?? []), s]);
      continue;
    }
    if (own.length) lines.push(`  ${own.join(" ")}`);
    lines.push(`  Scenario: ${s.name}`, "    When the thing runs", "    Then it works", "");
  }
  for (const [key, rows] of outlines) {
    lines.push(`  Scenario Outline: ${key} for <currency>`, "    When the thing runs for <currency>", "    Then it works", "");
    const blocks = new Map<string, Planned[]>();
    for (const r of rows) {
      const own = r.tags.filter((t) => t !== tag).join(" ");
      blocks.set(own, [...(blocks.get(own) ?? []), r]);
    }
    for (const [own, block] of blocks) {
      if (own) lines.push(`    ${own}`);
      lines.push("    Examples:", "      | currency |", ...block.map((r) => `      | ${/ for (\w+)$/.exec(r.name)![1]} |`), "");
    }
  }
  return lines.join("\n");
}

// A bare origin with main, and a working clone of the item's branch. With `signedOff`, the branch holds the locked
// feature file and the step definitions Red wrote, and the clone starts at that lock commit.
function setUp(c: Ctx, signedOff: boolean): { dir: string; origin: string; lockSha: string | null } {
  const root = c.root!;
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const dir = join(root, "work");
  const branch = branchOf(c.item);
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "init", "-q", "-b", "main", seed);
  writeFileSync(join(seed, ".gitignore"), "reports/\n");
  writeFileSync(join(seed, "app.txt"), "foo\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "init");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", "main");
  let lockSha: string | null = null;
  git(seed, "checkout", "-q", "-b", branch);
  if (signedOff) {
    mkdirSync(join(seed, "features", "steps"), { recursive: true });
    writeFileSync(join(seed, featurePath(c.item)), featureText(c));
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "specify");
    lockSha = git(seed, "rev-parse", "HEAD");
    writeFileSync(join(seed, "features", "steps", `pbi-${c.item}.steps.ts`), "// the step definitions Red wrote\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "red: step definitions");
  }
  git(seed, "push", "-q", "origin", branch);
  git(root, "clone", "-q", "-b", branch, origin, dir);
  git(dir, "config", "user.email", "cell@example.com");
  git(dir, "config", "user.name", "cell");
  return { dir, origin, lockSha };
}

function root(c: Ctx): string {
  c.root ??= mkdtempSync(join(tmpdir(), "pbi185-"));
  return c.root;
}

/** Runs the engine from `nextStage`. It stops the cell once Green starts, since only Red, or Specify, is judged. */
async function runCell(c: Ctx, nextStage: "red" | "specify", decision: { kind: string; text: string } | null): Promise<string> {
  root(c);
  const { dir, origin, lockSha } = setUp(c, nextStage === "red");
  writePlan(c);
  c.startHead = git(root(c), "--git-dir", origin, "rev-parse", branchOf(c.item));
  c.calls = [];
  c.error = null;
  const record = (route: string, body: Record<string, any> = {}) => c.calls.push({ route, body });
  const api = {
    async lease() { record("/lease"); return { stop: false }; },
    async stage(b: Record<string, any>) {
      record("/stage", b);
      if (b.stageId === "green" && b.status === "started") throw new Error(STOP);
    },
    async transition(b: Record<string, any>) { record("/transition", b); },
    async policyResults(b: Record<string, any>) { record("/policy-results", b); },
    async pr(b: Record<string, any>) { record("/pr", b); },
    async checks() { return { status: "success", failedChecks: [] }; },
    async upload(b: Record<string, any>) { record("/upload-url", { kind: b.kind, stageId: b.stageId, attempt: b.attempt }); },
    async release() { record("/release"); },
  };
  let stage = "";
  const agent = async (a: { prompt: string; cwd: string; model: string }) => {
    stage = [...c.calls].reverse().find((x) => x.route === "/stage" && x.body.status === "started")?.body.stageId ?? "";
    let text = "done";
    if (stage === "understand") text = Array.from({ length: c.criteria }, (_, i) => `@ac-${i + 1}: criterion ${i + 1}`).join("\n");
    if (stage === "specify") {
      mkdirSync(join(a.cwd, "features"), { recursive: true });
      writeFileSync(join(a.cwd, featurePath(c.item)), featureText(c));
    }
    // Red's agent changes nothing: the step definitions are already on the branch.
    return { ok: true, text, costUsd: 0.5, tokensIn: 10, tokensOut: 5, model: a.model, limit: null, usage: null, transcript: "{}\n" };
  };
  const file = join(repo, "src/cell/engine.ts");
  const engine = await import(pathToFileURL(file).href);
  const { shellGit } = await import(pathToFileURL(join(repo, "src/cell/git.ts")).href);
  const { loadSop } = await import(pathToFileURL(join(repo, "src/config/sop.ts")).href);
  const { parseCriteria } = await import(pathToFileURL(join(repo, "src/policy/policy.ts")).href);
  const policy = (name: string, text: string) => ({ name, source: "repo", sha: name, text, criteria: name === "scenarios" || name === "risk" ? [] : parseCriteria(text) });
  const criteria = nextStage === "specify" ? c.criteria : Math.max(c.criteria, 1);
  try {
    return await engine.runCell({
      api,
      ctx: {
        externalId: String(c.item), title: `Item ${c.item}`, acceptanceCriteria: Array.from({ length: criteria }, (_, i) => `Criterion ${i + 1} holds`),
        nextStage, decision, lockSha, lockedFiles: lockSha ? [featurePath(c.item)] : [], prNumber: null,
        repo: "acme/app", base: "main", branch: branchOf(c.item), configSha: "c0ffee", sopVersion: "0.1.0",
        dodVerdicts: [], dodCheckedSha: null, trustedComments: [], stageAttempts: {},
      },
      agent,
      git: shellGit(dir, branchOf(c.item)),
      dir,
      repoHost: { async openOrUpdatePr() { throw new Error(STOP); }, async requestReviewers() { return []; }, async openReviewComments() { return []; } },
      sop: loadSop(readFileSync(join(repo, "sop/default.yml"), "utf8")),
      config: { sensitivePaths: [], reviewers: ["owner"], webTools: [],
        bdd: { parse: runnerCommand(c, "parse"), run: runnerCommand(c, "run"), report: "reports/bdd.ndjson" }, commands: { test: "true", lint: "true" } },
      policies: { scenarios: policy("scenarios", "Write in business language.\n"), prReview: policy("pr-review", "- [ ] Code is readable.\n"),
        risk: policy("risk", "Low by default.\n"), dod: policy("dod", "- [ ] Typecheck passes. `run: true`\n") },
      now: () => new Date(),
      sleep: async () => {},
    });
  } catch (e) {
    if (!(e instanceof Error && e.message === STOP)) c.error = e;
    return "stopped";
  }
}

/** Red's verdict, from what the engine sent: its last attempt's status and the findings it blocked with. */
function redVerdict(c: Ctx): Gate {
  assert.equal(c.error, null, `the cell failed: ${c.error instanceof Error ? c.error.stack : String(c.error)}`);
  const reds = c.calls.filter((x) => x.route === "/stage" && x.body.stageId === "red" && x.body.status !== "started");
  assert.ok(reds.length > 0, "Red never ended");
  if (reds.at(-1)!.body.status === "passed") return { ok: true, findings: [] };
  const blocked = c.calls.filter((x) => x.route === "/transition" && x.body.event === "blocked").at(-1);
  const body = String(blocked?.body.question?.body ?? "");
  return { ok: false, findings: body.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2)) };
}

After({ tags: "@pbi-185" }, function () {
  const c = (this as { pbi185?: Ctx }).pbi185;
  if (c?.root && existsSync(c.root)) rmSync(c.root, { recursive: true, force: true });
});

// ---- Given ----

function scenariosFrom(item: number, table: DataTable, verdict: Verdict = "red"): Planned[] {
  return table.hashes().map((r) => ({ name: r.scenario!, tags: [`@pbi-${item}`, ...tagsOf(r.tags)], verdict, missing: false }));
}

function scenario(c: Ctx, name: string): Planned {
  const s = c.scenarios.find((x) => x.name === name);
  assert.ok(s, `item ${c.item} has no scenario "${name}"`);
  return s;
}

Given("item {int} has these scenarios:", function (item: number, table: DataTable) {
  const c = mine(this);
  c.item = item;
  c.scenarios = scenariosFrom(item, table);
});

Given("item {int} has a scenario outline {string} with these rows:", function (item: number, outline: string, table: DataTable) {
  const c = mine(this);
  c.item = item;
  c.scenarios = table.hashes().map((r) => ({
    name: outline.replace("<currency>", r.currency!), tags: [`@pbi-${item}`, ...tagsOf(r["examples block tags"])], verdict: "red" as Verdict, missing: false,
  }));
});

Given("the repo's bdd.run leaves out scenarios tagged @slow instead", function () {
  mine(this).filter = "not @slow";
});

Given("the repo's bdd.run has no tag filter", function () {
  mine(this).filter = null;
});

Given("at Red, every scenario the cell runs fails on its Then", function () {
  for (const s of mine(this).scenarios) s.verdict = "red";
});

Given("at Red, {string} fails on its Then", function (name: string) {
  scenario(mine(this), name).verdict = "red";
});

Given("{string} would pass if it ran", function (name: string) {
  scenario(mine(this), name).verdict = "green";
});

Given("at Red, {string} passes and {string} fails on its Then", function (passes: string, fails: string) {
  const c = mine(this);
  scenario(c, passes).verdict = "green";
  scenario(c, fails).verdict = "red";
});

Given("at Red, {string} fails on its Then and {string} is missing from the run's report", function (fails: string, missing: string) {
  const c = mine(this);
  scenario(c, fails).verdict = "red";
  scenario(c, missing).missing = true;
});

Given("item {int} has {int} acceptance criteria", function (item: number, n: number) {
  const c = mine(this);
  c.item = item;
  c.criteria = n;
});

Given("Specify writes these scenarios:", function (table: DataTable) {
  const c = mine(this);
  c.scenarios = scenariosFrom(c.item, table);
});

// Item 169 as it sat in NeedsInput: its in-cell scenarios and its @local ones, signed off, with Red's step definitions
// already on its branch. The repo's bdd.run is this repo's own, which leaves @local out.
Given("item {int} waits for input because Red failed with {string} for its @local scenarios", function (item: number, _finding: string) {
  const c = mine(this);
  c.item = item;
  c.filter = "not @local";
  c.scenarios = [
    { name: "The run moves on", tags: [`@pbi-${item}`, "@ac-1"], verdict: "red", missing: false },
    { name: "The owner's machine shows the run", tags: [`@pbi-${item}`, "@ac-2", "@local"], verdict: "red", missing: false },
  ];
});

Given("item {int}'s branch holds its signed-off feature file and step definitions, unchanged", function (item: number) {
  assert.equal(mine(this).item, item);
});

Given("at Red, every scenario of item {int} the cell runs fails on its Then", function (item: number) {
  const c = mine(this);
  assert.equal(c.item, item);
  for (const s of c.scenarios) s.verdict = "red";
});

// ---- When ----

When("Red is judged for item {int}", long, async function (item: number) {
  const c = mine(this);
  assert.equal(c.item, item);
  await runCell(c, "red", null);
  setGate(this, redVerdict(c));
});

When("Specify checks that every acceptance criterion has a scenario", long, async function () {
  await runCell(mine(this), "specify", null);
});

When("the owner answers item {int} once and Red runs again", long, async function (item: number) {
  const c = mine(this);
  assert.equal(c.item, item);
  c.answered = true;
  await runCell(c, "red", { kind: "answer", text: "The @local scenarios need my machine; the cell can't run them." });
});

// ---- Then ----

function gate(world: object): Gate {
  const g = (world as { pbi14?: { gate?: Gate | null } }).pbi14?.gate;
  assert.ok(g, "Red was never judged");
  return g;
}

Then("Red reports no finding about {string}", function (name: string) {
  const findings = gate(this).findings.filter((f) => f.includes(name));
  assert.deepEqual(findings, [], `Red reported findings about "${name}"`);
});

Then("Red fails with only the finding {string}", function (finding: string) {
  const g = gate(this);
  assert.equal(g.ok, false, "Red passed");
  assert.deepEqual(g.findings, [finding]);
});

Then("Red fails with a finding that no scenario carrying {string} runs in the cell", function (tag: string) {
  const g = gate(this);
  assert.equal(g.ok, false, "Red passed");
  assert.ok(g.findings.some((f) => f.includes(tag) && /\bno scenario\b/i.test(f) && /\bin the cell\b/.test(f) && !f.startsWith("not run in the cell")),
    `no finding says no scenario carrying ${tag} runs in the cell: ${JSON.stringify(g.findings)}`);
});

Then("Red reports no {string} finding for {string}", function (kind: string, name: string) {
  const findings = gate(this).findings.filter((f) => f.includes(kind) && f.includes(name));
  assert.deepEqual(findings, [], `Red reported "${kind}" for "${name}"`);
});

Then("Specify reports no criterion without a scenario", function () {
  const c = mine(this);
  assert.equal(c.error, null, `the cell failed: ${c.error instanceof Error ? c.error.stack : String(c.error)}`);
  const said = c.calls.flatMap((x) => [String(x.body.message ?? ""), String(x.body.question?.body ?? "")]).filter((t) => /no scenario carries @ac-/.test(t));
  assert.deepEqual(said, [], "Specify reported a criterion without a scenario");
  const t = c.calls.filter((x) => x.route === "/transition").at(-1);
  assert.equal(t?.body.event, "scenarios_written", `Specify didn't post the scenarios for sign-off: ${JSON.stringify(t?.body)}`);
});

Then("Red passes for item {int}", function (item: number) {
  const c = mine(this);
  assert.equal(c.item, item);
  assert.deepEqual(redVerdict(c), { ok: true, findings: [] });
});

Then("no commit was added to item {int}'s branch for Red to pass", function (item: number) {
  const c = mine(this);
  assert.equal(c.item, item);
  const head = git(c.root!, "--git-dir", join(c.root!, "origin.git"), "rev-parse", branchOf(item));
  assert.equal(head, c.startHead, "a commit was pushed to the branch");
  const local = git(join(c.root!, "work"), "rev-parse", "HEAD");
  assert.equal(local, c.startHead, "the cell committed to the branch");
});
