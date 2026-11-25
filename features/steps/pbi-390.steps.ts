// Step definitions for features/pbi-390-parallel-bdd-workers.feature.
//
// The worker count setting is the environment variable BDD_WORKERS. `npm run bdd` is expected to:
// - run the suite in BDD_WORKERS workers, and in a default of more than one when it isn't set, as cucumber-js's own
//   workers, so each scenario runs in a worker that CUCUMBER_WORKER_ID names and the report's testCaseStarted messages
//   carry a workerId. A count of 1 runs one such worker too;
// - refuse a BDD_WORKERS that isn't a whole number above zero, saying "the worker count must be a whole number above
//   zero", and run nothing;
// - run from the directory it's started in, as it does today, writing reports/bdd.ndjson there;
// - keep its parallel rule for @serial in the suite's own support code: a file under features/ that is neither a feature
//   file, nor under features/fixtures, nor an item's file in features/steps (one whose name starts "pbi-").
//
// Practice suites. A Given writes a small cucumber project into a temp directory. It holds the repo's package.json, its
// cucumber config files if any, a copy of scripts/, links to src/ and node_modules/, a copy of the suite's support code
// as above, and the practice features with features/steps/practice.steps.ts. Each practice scenario takes a moment, about
// PRACTICE_MS. Its hooks append a "start" and an "end" line to the file PBI390_RECORDS names, each with the time and the
// worker (CUCUMBER_WORKER_ID, or null when no worker ran it). So the test reads what ran beside what. A record with no
// worker means the run didn't go through the suite's workers, and a Then that reads the records fails on it.
// Every practice scenario also writes its name on the shared note, the file PBI390_NOTE names, as it starts and as it
// works. A guarded note scenario fails when another name lands on the note while it runs. A server scenario starts an
// HTTP server on a free port, records the port, and connects to it.
//
// "When the practice suite runs in N workers at once" runs cucumber-js's own --parallel N in the practice project, as
// the suite could before this item, so the @regression scenarios read a report from several workers today.
//
// The fixed port check is src/bdd/fixed-ports.ts's findFixedPorts.
//
// The @local scenarios run `npm run bdd` in a scratch copy of the repo, so their runs never write over this run's
// reports/bdd.ndjson. The programs that hold ports are TCP servers in this process, which count each connection.
import { After, Given, Then, When } from "@cucumber/cucumber";
import type { DataTable } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { findFixedPorts, type FixedPort } from "../../src/bdd/fixed-ports.ts";
import { classify, greenGate, redGate, type GateResult, type Results } from "../../src/bdd/messages.ts";
import { ctx as pbi5 } from "./pbi-5.steps.ts";

const repo = process.cwd();
const SETTING = "BDD_WORKERS";
const PRACTICE_MS = 750;
const RUN_TIMEOUT_MS = 5 * 60_000;
const practiceStep = { timeout: RUN_TIMEOUT_MS };
const fourRuns = { timeout: 4 * RUN_TIMEOUT_MS };
/** An earlier item's scenarios, or the whole suite four times over, run in the owner's own time. */
const ownerRun = { timeout: 6 * 60 * 60_000 };

type Ending = "with every step passed" | "failed on its Then" | "failed on its When";
type Kind = "counts" | "note" | "server";
type PracticeScenario = { name: string; tags: string[]; ends: Ending; kind: Kind; guarded?: boolean };
type PracticeFeature = { tags: string[]; scenarios: PracticeScenario[] };
type Practice = { dir: string; features: PracticeFeature[]; runs: number };

type Output = { status: number | null; out: string };
type Entry = { scenario: string; event: "start" | "end" | "server"; at: number; worker: string | null; port?: number };
type Run = Output & { report: string; records: Entry[] };

type Holder = { port: number; server: net.Server; reached: number };

type Ctx = {
  practice?: Practice;
  workers?: string | null;
  run?: Run;
  serial?: Run;
  parallel?: Run[];
  results?: Results;
  red?: GateResult;
  green?: GateResult;
  check?: { root: string; found?: FixedPort[]; error?: unknown; added?: { file: string; line: number } };
  holders: Holder[];
  earlier?: Run[];
  cleanup: string[];
};

function ctx(world: object): Ctx {
  const w = world as { pbi390?: Ctx };
  w.pbi390 ??= { holders: [], cleanup: [] };
  return w.pbi390;
}

After(async function () {
  const c = (this as { pbi390?: Ctx }).pbi390;
  if (!c) return;
  await Promise.all(c.holders.map((h) => new Promise<void>((resolve) => h.server.close(() => resolve()))));
  for (const p of c.cleanup) rmSync(p, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- running a command ----

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<Output> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const out: string[] = [];
    for (const s of [child.stdout, child.stderr]) s.on("data", (b: Buffer) => out.push(b.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, out: out.join("") });
    });
  });
}

const tail = (out: string) => out.split("\n").slice(-30).join("\n");

/** This process's environment, without what the outer run's own workers or settings would hand on to an inner run. */
function cleanEnv(workers: string | null | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CUCUMBER_WORKER_ID;
  delete env[SETTING];
  delete env.PBI390_RECORDS;
  delete env.PBI390_NOTE;
  if (workers !== null && workers !== undefined) env[SETTING] = workers;
  return env;
}

// ---- practice suites ----

const PRACTICE_STEPS = `import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import http from "node:http";

const MS = ${PRACTICE_MS};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(name + " isn't set in the run");
  return v;
}
function record(entry) {
  appendFileSync(env("PBI390_RECORDS"), JSON.stringify({ ...entry, at: Date.now(), worker: process.env.CUCUMBER_WORKER_ID ?? null }) + "\\n");
}
const note = () => (existsSync(env("PBI390_NOTE")) ? readFileSync(env("PBI390_NOTE"), "utf8").split("\\n").filter(Boolean) : []);
const touch = (name) => appendFileSync(env("PBI390_NOTE"), name + "\\n");

Before(function ({ pickle }) {
  this.practice = { name: pickle.name };
  record({ scenario: pickle.name, event: "start" });
  touch(pickle.name);
});

After(async function ({ pickle }) {
  const server = this.practice?.server;
  if (server) await new Promise((r) => server.close(() => r()));
  record({ scenario: pickle.name, event: "end" });
});

Given("the practice scenario begins", async function () {
  await sleep(MS / 3);
});

Given("the practice scenario writes its name on the shared note", async function () {
  this.practice.from = note().length;
  touch(this.practice.name);
  await sleep(MS / 3);
});

Given("the practice scenario starts a server on a free port", async function () {
  const name = this.practice.name;
  const server = http.createServer((_req, res) => res.end(name));
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r()));
  this.practice.server = server;
  this.practice.port = server.address().port;
  record({ scenario: name, event: "server", port: this.practice.port });
});

When("the practice scenario works on and {string}", async function (how) {
  await sleep(MS / 3);
  touch(this.practice.name);
  if (how === "fails") throw new Error("the practice scenario fails on its When, as the test planned");
});

When("the practice scenario connects to its server", async function () {
  this.practice.answer = await new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: this.practice.port, path: "/" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve(body));
    }).on("error", reject);
  });
  await sleep(MS / 3);
});

Then("the practice scenario comes out {string}", async function (how) {
  await sleep(MS / 3);
  if (how === "wrong") throw new Error("the practice scenario fails on its Then, as the test planned");
});

Then("nothing else touched the shared note while the practice scenario ran", async function () {
  await sleep(MS / 3);
  const others = note().slice(this.practice.from).filter((n) => n !== this.practice.name);
  if (others.length) throw new Error("the shared note was touched by " + [...new Set(others)].join(", "));
});

Then("the practice scenario's server answered it", async function () {
  await sleep(MS / 3);
  if (this.practice.answer !== this.practice.name) throw new Error("the server answered " + JSON.stringify(this.practice.answer));
});
`;

function scenarioText(s: PracticeScenario): string {
  const tags = s.tags.length ? `  ${s.tags.join(" ")}\n` : "";
  const lines =
    s.kind === "server"
      ? ["Given the practice scenario starts a server on a free port", "When the practice scenario connects to its server", "Then the practice scenario's server answered it"]
      : s.kind === "note" && s.guarded
        ? ["Given the practice scenario writes its name on the shared note", 'When the practice scenario works on and "passes"', "Then nothing else touched the shared note while the practice scenario ran"]
        : [
            "Given the practice scenario begins",
            `When the practice scenario works on and "${s.ends === "failed on its When" ? "fails" : "passes"}"`,
            `Then the practice scenario comes out "${s.ends === "failed on its Then" ? "wrong" : "right"}"`,
          ];
  return `${tags}  Scenario: ${s.name}\n${lines.map((l) => `    ${l}\n`).join("")}`;
}

/** Copies the suite's support code: what under features/ is neither a feature file, a fixture, nor an item's step file. */
function copySupport(from: string, to: string): void {
  if (!existsSync(from)) return;
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const rel = relative(join(repo, "features"), src).split(sep).join("/");
    if (rel === "fixtures") continue;
    if (entry.isDirectory()) {
      copySupport(src, join(to, entry.name));
      continue;
    }
    if (entry.name.endsWith(".feature")) continue;
    if (rel.startsWith("steps/") && entry.name.startsWith("pbi-")) continue;
    mkdirSync(to, { recursive: true });
    cpSync(src, join(to, entry.name));
  }
}

/** Writes the practice project afresh, so a run reads the repo's package.json and support code as they stand. */
function writePractice(p: Practice): void {
  for (const name of readdirSync(p.dir)) if (name !== "node_modules" && name !== "src") rmSync(join(p.dir, name), { recursive: true, force: true });
  cpSync(join(repo, "package.json"), join(p.dir, "package.json"));
  for (const name of readdirSync(repo)) if (/^cucumber\.(js|cjs|mjs|json|ya?ml|ts|mts|cts)$/.test(name)) cpSync(join(repo, name), join(p.dir, name));
  cpSync(join(repo, "scripts"), join(p.dir, "scripts"), { recursive: true });
  copySupport(join(repo, "features"), join(p.dir, "features"));
  mkdirSync(join(p.dir, "features", "steps"), { recursive: true });
  mkdirSync(join(p.dir, "reports"), { recursive: true });
  writeFileSync(join(p.dir, "features", "steps", "practice.steps.ts"), PRACTICE_STEPS);
  p.features.forEach((f, i) => {
    const tags = f.tags.length ? `${f.tags.join(" ")}\n` : "";
    writeFileSync(join(p.dir, "features", `practice-${i + 1}.feature`), `${tags}Feature: Practice feature ${i + 1} for PBI 390\n\n${f.scenarios.map(scenarioText).join("\n")}`);
  });
}

function practice(world: object): Practice {
  const c = ctx(world);
  if (!c.practice) {
    const dir = mkdtempSync(join(tmpdir(), "pbi390-practice-"));
    symlinkSync(join(repo, "node_modules"), join(dir, "node_modules"), "dir");
    symlinkSync(join(repo, "src"), join(dir, "src"), "dir");
    c.practice = { dir, features: [], runs: 0 };
    c.cleanup.push(dir);
  }
  return c.practice;
}

function needPractice(world: object): Practice {
  const p = ctx(world).practice;
  assert.ok(p && p.features.length, "no practice suite was set up");
  return p;
}

const allScenarios = (p: Practice) => p.features.flatMap((f) => f.scenarios.map((s) => ({ ...s, tags: [...f.tags, ...s.tags] })));

function addFeature(world: object, feature: PracticeFeature): void {
  practice(world).features.push(feature);
}

const NUMBERS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const countsTo = (n: number) => `Counts to ${NUMBERS[n - 1] ?? n}`;

function ending(text: string | undefined): Ending {
  const e = (text ?? "").trim() || "with every step passed";
  assert.ok(["with every step passed", "failed on its Then", "failed on its When"].includes(e), `unknown ending "${e}"`);
  return e as Ending;
}

/** Runs `command args` in the practice project with its own records file, and reads back the report and records. */
async function runPractice(world: object, command: string, args: string[], workers: string | null | undefined): Promise<Run> {
  const p = needPractice(world);
  writePractice(p);
  p.runs += 1;
  const records = join(p.dir, `records-${p.runs}.ndjson`);
  const env = cleanEnv(workers);
  env.PBI390_RECORDS = records;
  env.PBI390_NOTE = join(p.dir, `note-${p.runs}.txt`);
  const out = await run(command, args, p.dir, env, RUN_TIMEOUT_MS);
  const reportFile = join(p.dir, "reports", "bdd.ndjson");
  const report = existsSync(reportFile) ? readFileSync(reportFile, "utf8") : "";
  const recs = existsSync(records) ? readFileSync(records, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Entry) : [];
  return { ...out, report, records: recs };
}

async function npmBdd(world: object, extra: string[]): Promise<void> {
  const c = ctx(world);
  const r = await runPractice(world, "npm", ["run", "bdd", ...(extra.length ? ["--", ...extra] : [])], c.workers);
  c.run = r;
  pbi5(world).result = { status: r.status, out: r.out };
}

function lastRun(world: object): Run {
  const r = ctx(world).run;
  assert.ok(r, "the practice suite never ran");
  return r;
}

// ---- what ran beside what ----

type Span = { scenario: string; start: number; end: number; worker: string };

function spans(r: Run): Span[] {
  const starts = r.records.filter((x) => x.event === "start");
  const out: Span[] = [];
  for (const s of starts) {
    assert.ok(s.worker !== null, `practice scenario "${s.scenario}" ran in no worker: the run didn't go through the suite's workers\n${tail(r.out)}`);
    const end = r.records.find((x) => x.event === "end" && x.scenario === s.scenario && x.at >= s.at);
    assert.ok(end, `practice scenario "${s.scenario}" never ended`);
    out.push({ scenario: s.scenario, start: s.at, end: end.at, worker: s.worker });
  }
  return out;
}

const overlap = (a: Span, b: Span) => a.start < b.end && b.start < a.end;

function overlappingPairs(list: Span[]): [Span, Span][] {
  const pairs: [Span, Span][] = [];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (overlap(list[i], list[j])) pairs.push([list[i], list[j]]);
  return pairs;
}

function mostAtOnce(list: Span[]): number {
  const edges = list.flatMap((s) => [{ at: s.start, d: 1 }, { at: s.end, d: -1 }]).sort((a, b) => a.at - b.at || a.d - b.d);
  let now = 0;
  let most = 0;
  for (const e of edges) most = Math.max(most, (now += e.d));
  return most;
}

const describe = (list: Span[]) => list.map((s) => `${s.scenario}: worker ${s.worker}, ${s.start}..${s.end}`).join("\n");

function span(list: Span[], name: string): Span {
  const s = list.find((x) => x.scenario === name);
  assert.ok(s, `practice scenario "${name}" never ran`);
  return s;
}

function untagged(world: object, list: Span[]): Span[] {
  const names = new Set(allScenarios(needPractice(world)).filter((s) => s.tags.length === 0).map((s) => s.name));
  return list.filter((s) => names.has(s.scenario));
}

/** The workers a report's scenarios ran in, from its testCaseStarted messages; "none" for a scenario run in no worker. */
function reportWorkers(report: string): Set<string> {
  const workers = new Set<string>();
  for (const line of report.split("\n")) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      if (m.testCaseStarted) workers.add(m.testCaseStarted.workerId ?? "none");
    } catch {
      // a cut-short line
    }
  }
  return workers;
}

function assertSeveralWorkers(report: string, label: string): void {
  const workers = reportWorkers(report);
  assert.ok(workers.size > 0, `${label} ran no scenario`);
  assert.ok(!workers.has("none"), `${label} ran its scenarios in no worker`);
  assert.ok(workers.size > 1, `${label} ran in ${workers.size} worker: ${[...workers].join(", ")}`);
}

// ---- Givens ----

Given("a practice suite of {int} scenarios that each pass", function (n: number) {
  addFeature(this, { tags: [], scenarios: Array.from({ length: n }, (_, i) => ({ name: countsTo(i + 1), tags: [], ends: "with every step passed" as Ending, kind: "counts" as Kind })) });
});

Given("a practice suite with these scenarios:", function (table: DataTable) {
  addFeature(this, {
    tags: [],
    scenarios: table.hashes().map((row) => ({
      name: row.scenario,
      tags: (row.tags ?? "").split(/\s+/).filter(Boolean),
      ends: ending(row.ends),
      kind: /shared note/.test(row.scenario) ? "note" : "counts",
    })),
  });
});

Given("a practice feature tagged @serial with the scenarios {string} and {string}", function (a: string, b: string) {
  addFeature(this, { tags: ["@serial"], scenarios: [a, b].map((name) => ({ name, tags: [], ends: "with every step passed" as Ending, kind: "counts" as Kind })) });
});

Given("a practice feature with no tag with the scenarios {string}, {string}, {string} and {string}", function (a: string, b: string, cc: string, d: string) {
  addFeature(this, { tags: [], scenarios: [a, b, cc, d].map((name) => ({ name, tags: [], ends: "with every step passed" as Ending, kind: "counts" as Kind })) });
});

Given("each of the two note scenarios fails if anything else touches the shared note while it runs", function () {
  const notes = needPractice(this).features.flatMap((f) => f.scenarios).filter((s) => s.kind === "note");
  assert.equal(notes.length, 2, "the practice suite holds no two note scenarios");
  for (const s of notes) s.guarded = true;
});

Given("a practice suite of {int} scenarios that each start a server the way the suite's steps do, and connect to it", function (n: number) {
  addFeature(this, { tags: [], scenarios: Array.from({ length: n }, (_, i) => ({ name: `Serves ${NUMBERS[i] ?? i + 1}`, tags: [], ends: "with every step passed" as Ending, kind: "server" as Kind })) });
});

Given("the worker count setting is not set", function () {
  ctx(this).workers = null;
});

Given("the worker count setting is {int}", function (n: number) {
  ctx(this).workers = String(n);
});

Given("the worker count setting is {string}", function (text: string) {
  ctx(this).workers = text;
});

/**
 * Holds `port` with a TCP server that counts every connection. Waits while something else holds it already, which in a
 * parallel run is often another of these scenarios, holding it for an earlier item's whole run.
 */
const HOLD_WAIT_MS = 30 * 60_000;
async function hold(world: object, port: number): Promise<void> {
  const c = ctx(world);
  const deadline = Date.now() + HOLD_WAIT_MS;
  for (;;) {
    const holder: Holder = { port, server: net.createServer(), reached: 0 };
    holder.server.on("connection", (socket) => {
      holder.reached += 1;
      socket.destroy();
    });
    const err = await new Promise<Error | null>((resolve) => {
      holder.server.once("error", resolve);
      holder.server.listen(port, () => resolve(null));
    });
    if (!err) {
      c.holders.push(holder);
      return;
    }
    assert.ok((err as NodeJS.ErrnoException).code === "EADDRINUSE" && Date.now() < deadline, `couldn't listen on port ${port}: ${err.message}`);
    await sleep(500);
  }
}

Given("another program on this machine already listens on port {int}", { timeout: HOLD_WAIT_MS + 30_000 }, async function (port: number) {
  await hold(this, port);
});

Given("other programs on this machine already listen on ports {int}, {int} and {int}", { timeout: 3 * HOLD_WAIT_MS + 30_000 }, async function (a: number, b: number, d: number) {
  for (const port of [a, b, d]) await hold(this, port);
});

// ---- Whens ----

When("`npm run bdd` runs the practice suite", practiceStep, async function () {
  await npmBdd(this, []);
});

When("`npm run bdd -- --tags \"not @local\"` runs the practice suite", practiceStep, async function () {
  await npmBdd(this, ["--tags", "not @local"]);
});

When("the practice suite runs in {int} workers at once", practiceStep, async function (n: number) {
  const c = ctx(this);
  const cucumber = join(repo, "node_modules", "@cucumber", "cucumber", "bin", "cucumber.js");
  c.run = await runPractice(this, process.execPath, [cucumber, "--import", "features/steps/**/*.ts", "--format", "message:reports/bdd.ndjson", "--parallel", String(n)], null);
  assert.ok(c.run.report.trim(), `the practice run wrote no report:\n${tail(c.run.out)}`);
});

When("the practice suite runs serially once, and then with the worker count setting {int}, {int} times in a row", fourRuns, async function (n: number, times: number) {
  const c = ctx(this);
  c.serial = await runPractice(this, "npm", ["run", "bdd"], "1");
  c.parallel = [];
  for (let i = 0; i < times; i++) c.parallel.push(await runPractice(this, "npm", ["run", "bdd"], String(n)));
});

When("the factory reads the report at {string}", function (path: string) {
  const p = needPractice(this);
  const file = join(p.dir, path);
  assert.ok(existsSync(file), `the run wrote no ${path}`);
  ctx(this).results = classify(readFileSync(file, "utf8"));
});

/** PBI 14's gate, which its "Red passes" step and PBI 185's "Red reports no finding about" step read. */
function setPbi14Gate(world: object, gate: GateResult): void {
  const w = world as { pbi14?: { gate?: GateResult | null } };
  w.pbi14 ??= {};
  w.pbi14.gate = gate;
}

When("Red is judged for {string} on that run's report", function (tag: string) {
  const c = ctx(this);
  const r = lastRun(this);
  const expected = allScenarios(needPractice(this)).filter((s) => s.tags.includes(tag)).map((s) => s.name);
  c.red = redGate(classify(r.report), tag, expected);
  setPbi14Gate(this, c.red);
});

When("Green is judged on that run's report", function () {
  const c = ctx(this);
  c.green = greenGate(classify(lastRun(this).report));
});

When("the step definitions are checked for fixed ports", function () {
  const c = ctx(this);
  c.check ??= { root: repo };
  try {
    c.check.found = findFixedPorts(c.check.root);
  } catch (e) {
    c.check.error = e;
  }
});

const SCRATCH_STEP = "features/steps/pbi-9390-scratch.steps.ts";

Given("a scratch copy of the step definitions with a step added that connects to port {int}", function (port: number) {
  const c = ctx(this);
  const root = mkdtempSync(join(tmpdir(), "pbi390-steps-"));
  c.cleanup.push(root);
  cpSync(join(repo, "features", "steps"), join(root, "features", "steps"), { recursive: true });
  const lines = [
    'import { When } from "@cucumber/cucumber";',
    'import http from "node:http";',
    "",
    'When("the scratch step reads the floor", async function () {',
    `  await new Promise((resolve) => http.get({ host: "127.0.0.1", port: ${port}, path: "/v1/floor" }, resolve));`,
    "});",
    "",
  ];
  writeFileSync(join(root, SCRATCH_STEP), lines.join("\n"));
  c.check = { root, added: { file: SCRATCH_STEP, line: 5 } };
});

// ---- the @local runs ----

/** A copy of the repo as it stands, without .git, reports or node_modules, which is a link to the repo's. */
function scratchRepo(world: object): string {
  const dir = mkdtempSync(join(tmpdir(), "pbi390-repo-"));
  ctx(world).cleanup.push(dir);
  const skip = new Set(["node_modules", ".git", "reports", "wt", ".aspire"]);
  cpSync(repo, dir, {
    recursive: true,
    filter: (src) => {
      const parts = relative(repo, src).split(sep);
      return !skip.has(parts[0]) && !parts.includes("node_modules");
    },
  });
  symlinkSync(join(repo, "node_modules"), join(dir, "node_modules"), "dir");
  return dir;
}

async function runInScratch(world: object, args: string[], workers: string | null): Promise<Run> {
  const dir = scratchRepo(world);
  const out = await run("npm", ["run", "bdd", "--", ...args], dir, cleanEnv(workers), ownerRun.timeout);
  process.stdout.write(tail(out.out) + "\n");
  const file = join(dir, "reports", "bdd.ndjson");
  return { ...out, report: existsSync(file) ? readFileSync(file, "utf8") : "", records: [] };
}

When("the scenarios of PBI {int} run", ownerRun, async function (item: number) {
  ctx(this).earlier = [await runInScratch(this, ["--tags", `@pbi-${item} and not @local`], null)];
});

When("the scenarios of PBI {int} run twice at the same moment, in two separate runs", ownerRun, async function (item: number) {
  ctx(this).earlier = await Promise.all([1, 2].map(() => runInScratch(this, ["--tags", `@pbi-${item} and not @local`], null)));
});

When(
  "the owner runs `npm run bdd -- --tags \"not @local\"` once with the worker count setting {int}, and then {int} times in a row with the default worker count",
  ownerRun,
  async function (n: number, times: number) {
    const c = ctx(this);
    c.serial = await runInScratch(this, ["--tags", "not @local"], String(n));
    c.parallel = [];
    for (let i = 0; i < times; i++) c.parallel.push(await runInScratch(this, ["--tags", "not @local"], null));
  },
);

// ---- Thens ----

Then("the command exits with a non-zero code", function () {
  const r = lastRun(this);
  assert.ok(r.status !== 0 && r.status !== null, `the command exited ${r.status}:\n${tail(r.out)}`);
});

Then("the output says the worker count must be a whole number above zero", function () {
  const r = lastRun(this);
  assert.match(r.out, /the worker count must be a whole number above zero/i, tail(r.out));
});

Then("no practice scenario ran", function () {
  const started = lastRun(this).records.filter((x) => x.event === "start").map((x) => x.scenario);
  assert.deepEqual(started, [], "practice scenarios ran");
});

Then("the practice scenarios ran in more than one worker", function () {
  const list = spans(lastRun(this));
  const workers = new Set(list.map((s) => s.worker));
  assert.ok(workers.size > 1, `the practice scenarios ran in ${workers.size} worker:\n${describe(list)}`);
});

Then("the practice scenarios ran in exactly {int} workers", function (n: number) {
  const list = spans(lastRun(this));
  const workers = new Set(list.map((s) => s.worker));
  assert.equal(workers.size, n, `the practice scenarios ran in ${workers.size} workers:\n${describe(list)}`);
});

Then("some practice scenarios ran at the same time as one another", function () {
  const list = spans(lastRun(this));
  assert.ok(overlappingPairs(list).length > 0, `no two practice scenarios ran at the same time:\n${describe(list)}`);
});

Then("no more than {int} practice scenarios ever ran at the same time", function (n: number) {
  const list = spans(lastRun(this));
  assert.ok(mostAtOnce(list) <= n, `${mostAtOnce(list)} practice scenarios ran at once:\n${describe(list)}`);
});

Then("no two practice scenarios ran at the same time", function () {
  const list = spans(lastRun(this));
  assert.deepEqual(overlappingPairs(list).map(([a, b]) => `${a.scenario} with ${b.scenario}`), [], describe(list));
});

Then("all {int} practice scenarios passed", function (n: number) {
  const r = lastRun(this);
  const results = [...classify(r.report).values()];
  assert.equal(results.length, n, `the report holds ${results.length} scenarios:\n${tail(r.out)}`);
  const notGreen = results.filter((x) => x.verdict !== "green");
  assert.deepEqual(notGreen.map((x) => `${x.name}: ${x.verdict}: ${x.reason}`), []);
});

Then("both practice scenarios passed", function () {
  const r = lastRun(this);
  const results = [...classify(r.report).values()];
  assert.equal(results.length, 2, `the report holds ${results.length} scenarios:\n${tail(r.out)}`);
  assert.deepEqual(results.filter((x) => x.verdict !== "green").map((x) => `${x.name}: ${x.verdict}: ${x.reason}`), []);
});

Then("{string} and {string} never ran at the same time", function (a: string, b: string) {
  const list = spans(lastRun(this));
  assert.ok(!overlap(span(list, a), span(list, b)), `"${a}" and "${b}" ran at the same time:\n${describe(list)}`);
});

Then("some of the untagged practice scenarios ran at the same time as one another", function () {
  const list = spans(lastRun(this));
  assert.ok(overlappingPairs(untagged(this, list)).length > 0, `no two untagged practice scenarios ran at the same time:\n${describe(list)}`);
});

Then("the untagged practice scenarios ran at the same time as one another", function () {
  const list = spans(lastRun(this));
  const mine = untagged(this, list);
  assert.ok(mine.length >= 2, `${mine.length} untagged practice scenarios ran`);
  assert.equal(overlappingPairs(mine).length, (mine.length * (mine.length - 1)) / 2, `the untagged practice scenarios didn't all run at the same time:\n${describe(list)}`);
});

Then("the {int} practice scenarios ran at the same time as one another", function (n: number) {
  const list = spans(lastRun(this));
  assert.equal(list.length, n, `${list.length} practice scenarios ran:\n${describe(list)}`);
  assert.equal(overlappingPairs(list).length, (n * (n - 1)) / 2, `the practice scenarios didn't all run at the same time:\n${describe(list)}`);
});

Then("no practice scenario ran at any moment while {string} ran", function (name: string) {
  const list = spans(lastRun(this));
  const it = span(list, name);
  const beside = list.filter((s) => s !== it && overlap(s, it)).map((s) => s.scenario);
  assert.deepEqual(beside, [], `these ran while "${name}" ran:\n${describe(list)}`);
});

Then("each practice scenario's server listened on a port of its own, and neither was {int}", function (port: number) {
  const r = lastRun(this);
  spans(r);
  const ports = r.records.filter((x) => x.event === "server").map((x) => x.port);
  assert.equal(ports.length, 2, `the practice scenarios started ${ports.length} servers`);
  assert.notEqual(ports[0], ports[1], `both servers listened on port ${ports[0]}`);
  assert.ok(!ports.includes(port), `a server listened on port ${port}`);
});

function holder(world: object, port: number): Holder {
  const h = ctx(world).holders.find((x) => x.port === port);
  assert.ok(h, `nothing of this test listens on port ${port}`);
  return h;
}

Then("the program on port {int} was never reached by them", function (port: number) {
  assert.equal(holder(this, port).reached, 0, `the program on port ${port} was reached`);
});

Then("the programs on ports {int}, {int} and {int} were never reached by them", function (a: number, b: number, d: number) {
  const reached = [a, b, d].map((p) => holder(this, p)).filter((h) => h.reached > 0).map((h) => `${h.port}: ${h.reached} times`);
  assert.deepEqual(reached, [], "the programs on these ports were reached");
});

function check(world: object): FixedPort[] {
  const c = ctx(world).check;
  assert.ok(c, "the step definitions were never checked");
  assert.ok(!c.error, `the fixed port check failed: ${c.error instanceof Error ? c.error.message : String(c.error)}`);
  assert.ok(c.found, "the fixed port check found nothing to report on");
  return c.found;
}

const where = (f: FixedPort) => `${f.file}:${f.line} ${f.use}s port ${f.port}`;

Then("no step starts a server on a port fixed in its code", function () {
  assert.deepEqual(check(this).filter((f) => f.use === "listen").map(where), []);
});

Then("no step connects to a port fixed in its code", function () {
  assert.deepEqual(check(this).filter((f) => f.use === "connect").map(where), []);
});

Then("the check names the added step's file and line as connecting to port {int}", function (port: number) {
  const found = check(this);
  const added = ctx(this).check?.added;
  assert.ok(added, "no step was added");
  assert.ok(found.some((f) => f.file === added.file && f.line === added.line && f.use === "connect" && f.port === port), `the check named:\n${found.map(where).join("\n")}`);
});

Then("the check names no other step", function () {
  const found = check(this);
  const added = ctx(this).check?.added;
  assert.ok(added, "no step was added");
  assert.deepEqual(found.filter((f) => f.file !== added.file || f.line !== added.line).map(where), []);
});

Then("every scenario of PBI {int} passes", function (item: number) {
  const [r] = ctx(this).earlier ?? [];
  assert.ok(r, `PBI ${item}'s scenarios never ran`);
  assertAllPass(r, item, "the run");
});

function assertAllPass(r: Run, item: number, label: string): void {
  const mine = [...classify(r.report).values()].filter((x) => x.tags.includes(`@pbi-${item}`));
  assert.ok(mine.length > 0, `${label} ran no scenario of PBI ${item}:\n${tail(r.out)}`);
  assert.deepEqual(mine.filter((x) => x.verdict !== "green").map((x) => `${x.name}: ${x.verdict}: ${x.reason}`), [], `${label} failed scenarios of PBI ${item}`);
}

Then("every scenario of PBI {int} passes in both runs", function (item: number) {
  const runs = ctx(this).earlier ?? [];
  assert.equal(runs.length, 2, `PBI ${item}'s scenarios ran ${runs.length} times`);
  runs.forEach((r, i) => assertAllPass(r, item, `run ${i + 1}`));
});

function serialAndParallel(world: object, n: number): { serial: Run; parallel: Run[] } {
  const c = ctx(world);
  assert.ok(c.serial && c.parallel, "the suite never ran serially and then in parallel");
  assert.equal(c.parallel.length, n, `the suite ran ${c.parallel.length} times in parallel`);
  return { serial: c.serial, parallel: c.parallel };
}

/** Each scenario's verdict by feature file and name, as a list since an outline's rows share a name. */
function verdicts(report: string): Map<string, string[]> {
  const byPickle = new Map<string, string>();
  for (const line of report.split("\n")) {
    try {
      const m = JSON.parse(line);
      if (m.pickle) byPickle.set(m.pickle.id, m.pickle.uri);
    } catch {
      // a blank or cut-short line
    }
  }
  const out = new Map<string, string[]>();
  for (const [id, r] of classify(report)) {
    const key = `${byPickle.get(id) ?? "?"}: ${r.name}`;
    out.set(key, [...(out.get(key) ?? []), r.verdict].sort());
  }
  return out;
}

Then("each of the {int} parallel runs ran in more than one worker", function (n: number) {
  const { parallel } = serialAndParallel(this, n);
  parallel.forEach((r, i) => assertSeveralWorkers(r.report, `parallel run ${i + 1}`));
});

function passedEverySerialPass(world: object, n: number): void {
  const { serial, parallel } = serialAndParallel(world, n);
  const before = verdicts(serial.report);
  assert.ok(before.size > 0, `the serial run reported no scenario:\n${tail(serial.out)}`);
  parallel.forEach((r, i) => {
    const after = verdicts(r.report);
    const lost: string[] = [];
    for (const [key, list] of before) {
      const greens = list.filter((v) => v === "green").length;
      const now = (after.get(key) ?? []).filter((v) => v === "green").length;
      if (now < greens) lost.push(key);
    }
    assert.deepEqual(lost, [], `parallel run ${i + 1} didn't pass these, which the serial run passed`);
  });
}

Then("each of the {int} parallel runs passed every practice scenario the serial run passed", function (n: number) {
  passedEverySerialPass(this, n);
});

Then("each of the {int} parallel runs passed every scenario the serial run passed", function (n: number) {
  passedEverySerialPass(this, n);
});

Then("each of the {int} parallel runs ran every scenario the serial run ran", function (n: number) {
  const { serial, parallel } = serialAndParallel(this, n);
  const before = verdicts(serial.report);
  parallel.forEach((r, i) => {
    const after = verdicts(r.report);
    const missing = [...before].filter(([key, list]) => (after.get(key) ?? []).length < list.length).map(([key]) => key);
    assert.deepEqual(missing, [], `parallel run ${i + 1} didn't run these, which the serial run ran`);
  });
});

Then("each of the {int} parallel runs failed {string} on its Then, as the serial run did", function (n: number, name: string) {
  const { serial, parallel } = serialAndParallel(this, n);
  for (const [label, r] of [["the serial run", serial] as const, ...parallel.map((p, i) => [`parallel run ${i + 1}`, p] as const)]) {
    const found = [...classify(r.report).values()].filter((x) => x.name === name);
    assert.equal(found.length, 1, `${label} reported "${name}" ${found.length} times`);
    assert.equal(found[0].verdict, "red", `${label} reported "${name}" as ${found[0].verdict}: ${found[0].reason}`);
  }
});

type Counts = { passed: number; failed: number; skipped: number };

function counts(report: string): Counts {
  const c: Counts = { passed: 0, failed: 0, skipped: 0 };
  for (const r of classify(report).values()) {
    if (r.verdict === "green") c.passed += 1;
    else if (r.verdict === "crash" && /^(SKIPPED|PENDING)\b/.test(r.reason)) c.skipped += 1;
    else c.failed += 1;
  }
  return c;
}

Then("the serial run and each parallel run report {int} passed and {int} failed", function (passed: number, failed: number) {
  const c = ctx(this);
  assert.ok(c.serial && c.parallel, "the suite never ran serially and then in parallel");
  for (const [label, r] of [["the serial run", c.serial] as const, ...c.parallel.map((p, i) => [`parallel run ${i + 1}`, p] as const)]) {
    const n = counts(r.report);
    assert.deepEqual({ passed: n.passed, failed: n.failed + n.skipped }, { passed, failed }, `${label}'s report`);
  }
});

Then("the owner is told, for the serial run and for each parallel run, how many scenarios passed, failed and were skipped", function () {
  const c = ctx(this);
  assert.ok(c.serial && c.parallel, "the suite never ran serially and then in parallel");
  const lines: string[] = [];
  for (const [label, r] of [["serial run", c.serial] as const, ...c.parallel.map((p, i) => [`parallel run ${i + 1}`, p] as const)]) {
    const n = counts(r.report);
    assert.ok(n.passed + n.failed + n.skipped > 0, `the ${label} reported no scenario:\n${tail(r.out)}`);
    lines.push(`${label}: ${n.passed} passed, ${n.failed} failed, ${n.skipped} skipped`);
  }
  this.log(lines.join("\n"));
  process.stdout.write(`${lines.join("\n")}\n`);
});

Then("the report shows the scenarios ran in more than one worker", function () {
  assertSeveralWorkers(lastRun(this).report, "the run");
});

Then("the factory reads {string} as {string}", function (name: string, verdict: string) {
  const results = ctx(this).results;
  assert.ok(results, "the factory read no report");
  const found = [...results.values()].filter((r) => r.name === name);
  assert.equal(found.length, 1, `the factory read "${name}" ${found.length} times`);
  assert.equal(found[0].verdict, verdict, found[0].reason);
});

Then("the factory reads no other scenario", function () {
  const results = ctx(this).results;
  assert.ok(results, "the factory read no report");
  const names = new Set(allScenarios(needPractice(this)).map((s) => s.name));
  assert.deepEqual([...results.values()].map((r) => r.name).filter((n) => !names.has(n)), []);
  assert.equal(results.size, names.size, `the factory read ${results.size} scenarios`);
});

Then("Red fails with a finding that names {string}", function (name: string) {
  const g = ctx(this).red;
  assert.ok(g, "Red was never judged");
  assert.equal(g.ok, false, "Red passed");
  assert.ok(g.findings.some((f) => f.includes(name)), `findings were ${JSON.stringify(g.findings)}`);
});

function green(world: object): GateResult {
  const g = ctx(world).green;
  assert.ok(g, "Green was never judged");
  return g;
}

Then("Green passes", function () {
  assert.deepEqual(green(this), { ok: true, findings: [] });
});

Then("Green fails with a finding that names {string}", function (name: string) {
  const g = green(this);
  assert.equal(g.ok, false, "Green passed");
  assert.ok(g.findings.some((f) => f.includes(name)), `findings were ${JSON.stringify(g.findings)}`);
});

Then("Green reports no finding about {string}, {string} or {string}", function (a: string, b: string, d: string) {
  const about = green(this).findings.filter((f) => [a, b, d].some((n) => f.includes(`: ${n}:`)));
  assert.deepEqual(about, [], "Green reported findings about these");
});
