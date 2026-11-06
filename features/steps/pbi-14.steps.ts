import { After, Given, Then, When } from "@cucumber/cucumber";
import type { DataTable } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repo = process.cwd();

type Verdict = { name: string; tags: string[]; verdict: "red" | "green" | "crash"; reason: string };
type Results = Map<string, Verdict>;
type Gate = { ok: boolean; findings: string[] };
type Messages = { classify(ndjson: string): Results; redGate(results: Results, pbiTag: string, expected: string[]): Gate };
type Lock = { matchesLock(repoDir: string, lockSha: string, files: string[]): Promise<boolean> };

type Ctx = { report?: string; results?: Results | null; expected?: string[]; gate?: Gate | null; dir?: string; lockSha?: string; locked?: boolean | null };

function ctx(world: object): Ctx {
  const w = world as { pbi14?: Ctx };
  w.pbi14 ??= {};
  return w.pbi14;
}

// Loaded lazily, so a missing module turns into a red Then instead of a crash of the whole run.
async function load<T>(rel: string): Promise<T | null> {
  const file = join(repo, rel);
  return existsSync(file) ? ((await import(pathToFileURL(file).href)) as T) : null;
}

// A Cucumber Messages stream, one scenario per entry, each with a Given, a When and a Then.
// A real run also reports hook steps, which have no pickle step, so each scenario gets one.
type Scenario = { name: string; tag: string; statuses: [string, string, string] };

function report(scenarios: Scenario[]): string {
  const kinds = [["Context", "Given"], ["Action", "When"], ["Outcome", "Then"]] as const;
  const lines: object[] = [];
  scenarios.forEach((s, n) => {
    const p = `p${n}`;
    lines.push({ pickle: { id: p, uri: "features/x.feature", name: s.name, language: "en", astNodeIds: [], tags: [{ name: s.tag, astNodeId: "" }],
      steps: kinds.map(([type, word], i) => ({ id: `${p}s${i}`, type, text: `${word} step ${i}`, astNodeIds: [] })) } });
    lines.push({ testCase: { id: `tc${n}`, pickleId: p, testSteps: [{ id: `tc${n}h`, hookId: "h1" }, ...kinds.map((_, i) => ({ id: `tc${n}t${i}`, pickleStepId: `${p}s${i}` }))] } });
    lines.push({ testCaseStarted: { id: `tcs${n}`, testCaseId: `tc${n}`, attempt: 0, timestamp: { seconds: 0, nanos: 0 } } });
    const finished = (id: string, status: string) => ({ testStepFinished: { testCaseStartedId: `tcs${n}`, testStepId: id, timestamp: { seconds: 0, nanos: 0 }, testStepResult: { status, duration: { seconds: 0, nanos: 0 } } } });
    lines.push(finished(`tc${n}h`, "PASSED"));
    s.statuses.forEach((status, i) => lines.push(finished(`tc${n}t${i}`, status.toUpperCase())));
  });
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

const endings: Record<string, [string, string, string]> = {
  "with every step passed": ["passed", "passed", "passed"],
  "failed on its Then": ["passed", "passed", "failed"],
};

Given("a runner report with one scenario whose Given {string}, whose When {string} and whose Then {string}", function (g: string, w: string, t: string) {
  ctx(this).report = report([{ name: "The one scenario", tag: "@pbi-482", statuses: [g, w, t] }]);
});

Given("a runner report with these scenarios:", function (table: DataTable) {
  ctx(this).report = report(table.hashes().map((r) => {
    const statuses = endings[r.ended];
    assert.ok(statuses, `unknown ending "${r.ended}"`);
    return { name: r.scenario, tag: r.item, statuses };
  }));
});

Given("an empty runner report", function () {
  ctx(this).report = "";
});

Given("item {string} has the scenario {string}", function (_tag: string, name: string) {
  ctx(this).expected = [name];
});

Given("item {string} has the scenarios {string} and {string}", function (_tag: string, a: string, b: string) {
  ctx(this).expected = [a, b];
});

When("the factory reads the report", async function () {
  const c = ctx(this);
  const m = await load<Messages>("src/bdd/messages.ts");
  c.results = m ? m.classify(c.report ?? "") : null;
});

When("Red is judged for {string}", async function (tag: string) {
  const c = ctx(this);
  const m = await load<Messages>("src/bdd/messages.ts");
  c.gate = m ? m.redGate(m.classify(c.report ?? ""), tag, c.expected ?? []) : null;
});

Then("that scenario counts as {string}", function (verdict: string) {
  const c = ctx(this);
  assert.ok(c.results, "src/bdd/messages.ts doesn't exist");
  const all = [...c.results.values()];
  assert.equal(all.length, 1, `expected one scenario, got ${all.length}`);
  assert.equal(all[0].verdict, verdict, all[0].reason);
});

Then("Red passes", function () {
  const c = ctx(this);
  assert.ok(c.gate, "src/bdd/messages.ts doesn't exist");
  assert.deepEqual(c.gate, { ok: true, findings: [] });
});

Then("Red fails with the finding {string}", function (finding: string) {
  const c = ctx(this);
  assert.ok(c.gate, "src/bdd/messages.ts doesn't exist");
  assert.equal(c.gate.ok, false);
  assert.ok(c.gate.findings.includes(finding), `findings were ${JSON.stringify(c.gate.findings)}`);
});

// The lock scenarios run against a throwaway git repo, so they need git and nothing else.
const lockedFile = "features/pbi-482-totals.feature";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=factory", "-c", "user.email=factory@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], { cwd: dir, encoding: "utf8" }).trim();
}

function write(dir: string, path: string, text: string) {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), text);
}

Given("a repo where item {string}'s feature file was locked at sign-off", function (tag: string) {
  const c = ctx(this);
  const dir = mkdtempSync(join(tmpdir(), "pbi-14-"));
  c.dir = dir;
  git(dir, "init", "-q", "-b", "main");
  write(dir, lockedFile, `${tag}\nFeature: Totals\n  Scenario: Totals add up\n    Then the total is 3\n`);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "specify");
  c.lockSha = git(dir, "rev-parse", "HEAD");
});

When("a later commit edits that feature file", function () {
  const dir = ctx(this).dir!;
  write(dir, lockedFile, "@pbi-482\nFeature: Totals\n  Scenario: Totals add up\n    Then the total is 4\n");
  git(dir, "commit", "-q", "-am", "edit a locked scenario");
});

When("a later commit adds a step definition", function () {
  const dir = ctx(this).dir!;
  write(dir, "features/steps/pbi-482.steps.ts", "// Then the total is {int}\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "red");
});

When("another item's feature file is merged in", function () {
  const dir = ctx(this).dir!;
  git(dir, "checkout", "-q", "-b", "other", ctx(this).lockSha!);
  write(dir, "features/pbi-483-refunds.feature", "@pbi-483\nFeature: Refunds\n  Scenario: Refunds show negative\n    Then the refund is -3\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "another item");
  git(dir, "checkout", "-q", "main");
  write(dir, "features/steps/pbi-482.steps.ts", "// Then the total is {int}\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "red");
  git(dir, "merge", "-q", "--no-ff", "-m", "merge main into the branch", "other");
});

async function lockCheck(c: Ctx): Promise<boolean | null> {
  const m = await load<Lock>("src/bdd/lock.ts");
  return m ? m.matchesLock(c.dir!, c.lockSha!, [lockedFile]) : null;
}

Then("the lock check fails", async function () {
  const locked = await lockCheck(ctx(this));
  assert.notEqual(locked, null, "src/bdd/lock.ts doesn't exist");
  assert.equal(locked, false);
});

Then("the lock check passes", async function () {
  const locked = await lockCheck(ctx(this));
  assert.notEqual(locked, null, "src/bdd/lock.ts doesn't exist");
  assert.equal(locked, true);
});

After({ tags: "@pbi-14" }, function () {
  const dir = ctx(this).dir;
  if (dir) rmSync(dir, { recursive: true, force: true });
});
