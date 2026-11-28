// Step definitions for features/pbi-321-one-failing-test-reader.feature.
//
// A failing-test reader is a function named `failingTests` that takes a log and gives back the names of the tests it
// says failed. The steps find which one each caller uses by following its source's imports and re-exports from the file
// that calls it to the file that defines it:
// - the cell's CI finding: src/adapters/github/repo-host.ts, which reads a failed GitHub Actions check's log for the
//   control plane's /ci-checks, whose checks the cell turns into its CI findings;
// - the base-failure check: src/cell/engine.ts, which reads a Definition of Done command's output on the item's branch
//   and on the base commit (PBI 215);
// - the bug item for a red main: src/scheduler/scheduler.ts, which reads a failed check's log on a red merge (PBI 255).
// "The factory has exactly one failing-test reader" means one file in src (tests aside) defines `failingTests` or reads
// cucumber's "Failed scenarios:" heading in code, comments aside, and each caller's `failingTests` leads there.
//
// How each caller reads a log:
// - the CI finding: the real GitHub repo host's ciChecksOnSha, on a stub GitHub whose one check run, a GitHub Actions
//   job, failed with that log. The finding is ciFailureOf and ciFindings over those checks, as the engine writes them.
//   The tests it names are its check's `failingTests`.
// - the base-failure check: the `failingTests` engine.ts leads to, over the log.
// - the bug item: the real repo host's checkLog on the same stub GitHub, the `failingTests` scheduler.ts leads to, and
//   bugItem. The tests it names are the `- ` lines under "Failing tests the checks' logs name:" in the item's body.
// "The factory's failing-test reader" is the `failingTests` repo-host.ts leads to.
//
// The cell scenarios run PBI 18's engine harness with PBI 215's run, base commit and Thens. "The command prints" puts a
// fake `npm` first on PATH, in place of PBI 215's. On the base commit it prints what the scenario says the command
// prints there, exiting 1, or exits 0 when the scenario says it passes there. Anywhere else it prints what the scenario
// says it prints on the item's branch and exits 1.
// A Green brief is a Green agent call's prompt, the Definition of Done judge's aside. The retry brief is the second.
// Since a failed command's output goes into its line's reason whole, a brief or a question "names" a scenario only when
// it holds the name in a line that holds no line the command printed. So naming it means saying which tests failed,
// not passing the command's output along.
import { Given, Then, When } from "@cucumber/cucumber";
import type { DataTable } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { chmodSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { githubRepoHost } from "../../src/adapters/github/repo-host.ts";
import { ciFailureOf, ciFindings } from "../../src/core/ci-findings.ts";
import { bugItem } from "../../src/scheduler/main-break.ts";
import type { Ctx as CellCtx } from "./pbi-18.steps.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const SRC = join(ROOT, "src");
const NAME = "failingTests";
const CALLERS = {
  ci: "src/adapters/github/repo-host.ts",
  base: "src/cell/engine.ts",
  bug: "src/scheduler/scheduler.ts",
} as const;
type Caller = keyof typeof CALLERS;

const REPO = "acme/widgets";
const SHA = "c0ffee1c0ffee1c0ffee1c0ffee1c0ffee1c0ffe";
const JOB = 41;

type Ctx = {
  log?: string;
  check?: { name: string; url: string };
  /** What each reader named, by caller, or the factory's reader's as "reader". */
  named: Partial<Record<Caller | "reader", string[]>>;
  findings?: string[];
  look?: { readers: string[]; uses: Record<Caller, string | null> };
  prints?: { branch: string | null; base: string | null };
};

function mine(world: object): Ctx {
  const w = world as { pbi321?: Ctx };
  w.pbi321 ??= { named: {} };
  return w.pbi321;
}

function cell(world: object): CellCtx {
  const w = world as { pbi18?: CellCtx };
  assert.ok(w.pbi18, "no run was set up");
  return w.pbi18;
}

function pbi215(world: object): { planFile: string; labels: Map<string, string> } {
  const w = world as { pbi215?: { planFile: string; labels: Map<string, string> } };
  assert.ok(w.pbi215, "no PBI 215 run was set up");
  return w.pbi215;
}

// ---- following a caller to its reader ----

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return sources(p);
    return p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
  });
}

const defines = (src: string, name: string) =>
  new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:(?:async\\s+)?function\\s*\\*?\\s*${name}\\b|(?:const|let|var)\\s+${name}\\s*[=:])`).test(src);

const codeOf = (src: string) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

function moduleFile(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const p = resolve(dirname(from), spec);
  return extname(p) ? p : `${p}.ts`;
}

/** The file that defines what `name` is in `file`, following imports and re-exports, or null. */
function definedIn(file: string, name: string, seen = new Set<string>()): string | null {
  const key = `${file}#${name}`;
  if (seen.has(key)) return null;
  seen.add(key);
  let src: string;
  try { src = readFileSync(file, "utf8"); } catch { return null; }
  if (defines(src, name)) return file;
  for (const m of src.matchAll(/(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    for (const spec of m[1].split(",").map((s) => s.trim().replace(/^type\s+/, "")).filter(Boolean)) {
      const [orig, local] = spec.split(/\s+as\s+/).map((s) => s.trim());
      if ((local ?? orig) !== name) continue;
      const target = moduleFile(file, m[2]);
      if (target) return definedIn(target, orig, seen);
    }
  }
  for (const m of src.matchAll(/export\s+\*\s+from\s*["']([^"']+)["']/g)) {
    const target = moduleFile(file, m[1]);
    const found = target ? definedIn(target, name, seen) : null;
    if (found) return found;
  }
  return null;
}

const rel = (p: string) => relative(ROOT, p).split("\\").join("/");

async function readerOf(caller: Caller): Promise<(log: string | null) => string[]> {
  const file = definedIn(join(ROOT, CALLERS[caller]), NAME);
  assert.ok(file, `${CALLERS[caller]} uses no ${NAME} the steps can follow`);
  const mod = await import(pathToFileURL(file).href);
  assert.equal(typeof mod[NAME], "function", `${rel(file)} exports no ${NAME}`);
  return mod[NAME];
}

// ---- a stub GitHub with one failed Actions check ----

function stubHost(log: string, check: { name: string; url: string }) {
  const run = { id: JOB, name: check.name, status: "completed", conclusion: "failure", html_url: check.url, completed_at: "2026-11-27T10:15:03Z", app: { slug: "github-actions" } };
  const request = async (route: string, params: Record<string, any> = {}) => {
    if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") return { data: { total_count: 1, check_runs: [run] } };
    if (route === "GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs" && params.job_id === JOB) return { data: log };
    throw Object.assign(new Error(`404 ${route}`), { status: 404 });
  };
  const client = { request, graphql: async () => ({}) };
  return githubRepoHost({ octokit: { request }, getInstallationOctokit: async () => client } as never, 7);
}

const DEFAULT_CHECK = { name: "ci", url: "https://github.com/acme/widgets/actions/runs/7001" };

async function ciFinding(log: string, check = DEFAULT_CHECK): Promise<{ tests: string[]; findings: string[] }> {
  const checks = await stubHost(log, check).ciChecksOnSha(REPO, SHA);
  const f = ciFailureOf(SHA, checks);
  const c = f.checks.find((x) => x.name === check.name);
  assert.ok(c, `CI named no failed check "${check.name}": ${JSON.stringify(checks)}`);
  return { tests: c.failingTests, findings: ciFindings(f) };
}

async function baseCheck(log: string): Promise<string[]> {
  return (await readerOf("base"))(log);
}

async function bugItemTests(log: string): Promise<string[]> {
  const check = DEFAULT_CHECK;
  const read = await stubHost(log, check).checkLog(REPO, SHA, check.name);
  const tests = (await readerOf("bug"))(read);
  const { body } = bugItem({ sha: SHA, branch: "main", prNumber: 57, prUrl: null, itemExternalId: "482", checks: [{ name: check.name, url: check.url, tests }] });
  const lines = body.split("\n");
  const at = lines.indexOf("Failing tests the checks' logs name:");
  if (at < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (!l.startsWith("- ")) break;
    out.push(l.slice(2));
  }
  return out;
}

function theLog(world: object): string {
  const l = mine(world).log;
  assert.ok(l !== undefined, "no log was given");
  return l;
}

function named(world: object, who: Caller | "reader"): string[] {
  const n = mine(world).named[who];
  assert.ok(n, `the log wasn't read for ${who}`);
  return n;
}

/** Who the last When read the log for. */
function readers(world: object): (Caller | "reader")[] {
  return (Object.keys(mine(world).named) as (Caller | "reader")[]);
}

// ---- Givens ----

Given("a log that reads:", function (log: string) {
  mine(this).log = log;
});

Given("CI reports the check {string} failed at {string}, with a log that reads:", function (name: string, url: string, log: string) {
  const m = mine(this);
  m.log = log;
  m.check = { name, url };
});

// The fake npm, in CommonJS so node runs it from a directory with no package.json. Paths are written in, since a DoD
// command sees only PATH, HOME and CI.
function fakeNpm(planFile: string, printsFile: string): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
let head = "";
try { head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch {}
const plan = fs.existsSync(${JSON.stringify(planFile)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(planFile)}, "utf8")) : {};
const prints = JSON.parse(fs.readFileSync(${JSON.stringify(printsFile)}, "utf8"));
const out = head !== "" && head === plan.baseSha ? prints.base : prints.branch;
if (out === null || out === undefined) process.exit(0);
process.stdout.write(out + "\\n");
process.exit(1);
`;
}

function writePrints(world: object): void {
  const c = cell(world);
  const m = mine(world);
  const printsFile = join(c.root, "pbi-321-prints.json");
  writeFileSync(printsFile, JSON.stringify(m.prints));
  const npm = join(c.root, "bin", "npm");
  writeFileSync(npm, fakeNpm(pbi215(world).planFile, printsFile));
  chmodSync(npm, 0o755);
}

Given("on the item's branch the command prints:", function (out: string) {
  const m = mine(this);
  m.prints = { branch: out, base: m.prints?.base ?? null };
  writePrints(this);
});

Given("on commit {string} the command prints the same", function (label: string) {
  assert.ok(pbi215(this).labels.has(label), `no commit is labelled "${label}"`);
  const m = mine(this);
  assert.ok(m.prints?.branch, "nothing was printed on the item's branch");
  m.prints = { branch: m.prints.branch, base: m.prints.branch };
  writePrints(this);
});

// ---- Whens ----

When("I look at how the factory reads failing tests from a log", function () {
  const files = sources(SRC);
  const readers = files.filter((f) => {
    const src = readFileSync(f, "utf8");
    return defines(src, NAME) || /Failed\b[^\n]*scenarios:/.test(codeOf(src));
  }).map(rel);
  const uses = Object.fromEntries((Object.keys(CALLERS) as Caller[]).map((k) => {
    const f = definedIn(join(ROOT, CALLERS[k]), NAME);
    return [k, f ? rel(f) : null];
  })) as Record<Caller, string | null>;
  mine(this).look = { readers, uses };
});

When("the factory reads that log for the cell's CI finding, for the base-failure check and for a red main's bug item", async function () {
  const m = mine(this);
  const log = theLog(this);
  m.named = { ci: (await ciFinding(log)).tests, base: await baseCheck(log), bug: await bugItemTests(log) };
});

When("the cell's CI finding reads the log", async function () {
  const m = mine(this);
  const r = await ciFinding(theLog(this));
  m.named = { ci: r.tests };
  m.findings = r.findings;
});

When("the base-failure check reads the log", async function () {
  mine(this).named = { base: await baseCheck(theLog(this)) };
});

When("the factory's failing-test reader reads the log", async function () {
  mine(this).named = { reader: (await readerOf("ci"))(theLog(this)) };
});

When("the cell reads CI on its commit", async function () {
  cell(this);
  const m = mine(this);
  assert.ok(m.check, "CI reported no check");
  const r = await ciFinding(theLog(this), m.check);
  m.named = { ci: r.tests };
  m.findings = r.findings;
});

// ---- Thens: the one reader ----

function look(world: object) {
  const l = mine(world).look;
  assert.ok(l, "nobody looked at how the factory reads failing tests");
  return l;
}

Then("the factory has exactly one failing-test reader", function () {
  const { readers } = look(this);
  assert.equal(readers.length, 1, `the factory reads failing tests from a log in ${readers.length} places: ${readers.join(", ")}`);
});

function usesTheReader(world: object, caller: Caller): void {
  const { readers, uses } = look(world);
  assert.equal(uses[caller], readers[0], `${CALLERS[caller]} reads failing tests with ${uses[caller] ?? "no reader the steps can follow"}, not ${readers[0]}`);
}

Then("the cell's CI finding reads failing tests with it", function () { usesTheReader(this, "ci"); });
Then("the base-failure check reads failing tests with it", function () { usesTheReader(this, "base"); });
Then("the bug item for a red main reads failing tests with it", function () { usesTheReader(this, "bug"); });

// ---- Thens: what a log names ----

Then("all three name the same failing tests", function () {
  const ci = named(this, "ci");
  assert.deepEqual(named(this, "base"), ci, "the base-failure check names other tests than the cell's CI finding");
  assert.deepEqual(named(this, "bug"), ci, "the bug item names other tests than the cell's CI finding");
});

Then(/^the failing tests include the (?:scenario|test) "([^"]+)"$/, function (name: string) {
  for (const who of readers(this)) {
    const n = named(this, who);
    assert.ok(n.includes(name), `${who} doesn't name "${name}": ${JSON.stringify(n)}`);
  }
});

Then(/^it names the (?:scenario|test) "([^"]+)"$/, function (name: string) {
  for (const who of readers(this)) {
    const n = named(this, who);
    assert.ok(n.includes(name), `${who} doesn't name "${name}": ${JSON.stringify(n)}`);
  }
});

Then("it doesn't name the test {string}", function (name: string) {
  for (const who of readers(this)) {
    const n = named(this, who);
    assert.ok(!n.includes(name), `${who} names "${name}": ${JSON.stringify(n)}`);
  }
});

Then(/^it (?:names|gives back) exactly these scenarios, in order:$/, function (table: DataTable) {
  const want = table.hashes().map((r) => r.scenario);
  for (const who of readers(this)) assert.deepEqual(named(this, who), want, `${who} names other tests`);
});

Then("the cell's CI finding, the base-failure check and a red main's bug item each name both scenarios", async function () {
  const log = theLog(this);
  const want = ["Two steps match the total", "Two steps match the refund"];
  const each: Record<string, string[]> = { "the cell's CI finding": (await ciFinding(log)).tests, "the base-failure check": await baseCheck(log), "the bug item": await bugItemTests(log) };
  for (const [who, n] of Object.entries(each)) {
    for (const s of want) assert.ok(n.includes(s), `${who} doesn't name "${s}": ${JSON.stringify(n)}`);
  }
});

Then("the CI finding for the check {string} names the scenario {string}", function (check: string, name: string) {
  const findings = mine(this).findings ?? [];
  const f = findings.find((x) => x.includes(`the check "${check}"`));
  assert.ok(f, `no CI finding names the check "${check}": ${JSON.stringify(findings)}`);
  assert.ok(f.includes(`"${name}"`), `the CI finding for "${check}" doesn't name "${name}": ${f}`);
});

// ---- Thens: the cell ----

function settled(c: CellCtx): void {
  assert.equal(c.error, null, `the cell failed: ${c.error instanceof Error ? c.error.stack : String(c.error)}`);
}

/** The lines of `text` that hold no line the command printed. */
function ownLines(world: object, text: string): string[] {
  const p = mine(world).prints;
  const printed = [p?.branch, p?.base].filter((x): x is string => !!x).flatMap((x) => x.split("\n")).map((l) => l.trim()).filter(Boolean);
  return text.split("\n").filter((l) => !printed.some((o) => l.includes(o)));
}

const namesIn = (world: object, text: string, name: string) => ownLines(world, text).some((l) => l.includes(name));

Then("the factory asks one question that names the scenario {string} and the base commit {string}", function (name: string, label: string) {
  const c = cell(this);
  settled(c);
  const sha = pbi215(this).labels.get(label);
  assert.ok(sha, `no commit is labelled "${label}"`);
  const qs = [...(c.earlierCalls ?? []), ...c.calls].filter((x) => x.route === "/transition" && x.body.question).map((x) => String(x.body.question.body ?? ""));
  assert.equal(qs.length, 1, `the factory asked ${qs.length} questions: ${JSON.stringify(qs)}`);
  assert.ok(namesIn(this, qs[0], name), `the question doesn't name the scenario "${name}": ${qs[0]}`);
  assert.ok(qs[0].includes(sha.slice(0, 7)), `the question doesn't name the base commit ${sha.slice(0, 7)}: ${qs[0]}`);
});

Then("Green's retry brief names the scenario {string}", function (name: string) {
  const c = cell(this);
  settled(c);
  const briefs = c.agentCalls.filter((a) => a.stage === "green" && !String(a.prompt).startsWith("# Definition of Done")).map((a) => String(a.prompt));
  assert.ok(briefs.length >= 2, `Green ran ${briefs.length} time(s), so it had no retry brief`);
  assert.ok(namesIn(this, briefs[1], name), `Green's retry brief doesn't name the scenario "${name}" outside the command's output:\n${briefs[1]}`);
});

Then("the factory asks no question about the base", function () {
  const c = cell(this);
  settled(c);
  const qs = [...(c.earlierCalls ?? []), ...c.calls].filter((x) => x.route === "/transition" && x.body.question).map((x) => String(x.body.question.body ?? ""));
  assert.ok(!qs.some((q) => /base fails in the cell/i.test(q)), `a question is about the base: ${JSON.stringify(qs)}`);
});
