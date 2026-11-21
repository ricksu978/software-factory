// Step definitions for features/pbi-399-command-time-limit.feature.
//
// The cell scenarios run PBI 18's engine harness: a real temporary git repo cloned from a bare origin, a recording
// cell API, a scripted agent and a fake repo host. Unless a step says otherwise the run is for item 482, whose
// scenarios were signed off, and starts at the stage the When names. The repo's commands are the ones the scenario
// names, and each reaches a fake `npm` this file puts first on PATH.
//
// Each stand-in has a plan: how many minutes it runs, and how it ends, per run. A command run more than once takes the
// plan's next entry each time, and its last entry after that. Time passes on a fake clock, a file the fake adds each
// run's minutes to, which the engine's `now` reads. No scenario waits for real minutes.
//
// The time limit: the engine runs each command through the `shell` this file hands it (src/cell/engine.ts's `Shell`),
// which passes the limit the engine gives to the stand-in. A stand-in still running at its limit is stopped there: it
// writes what it had written by then, such as a BDD report cut short, and exits 1, as a command the cell kills does.
// A stand-in the engine runs some other way hears no limit, and is stopped at the 15 minutes a cell has always given
// each command (the feature's opening). "The cell stopped X after N minutes" reads the fake's log of its runs.
//
// "The attempt's findings" are the ones the stage's next attempt is told its last attempt failed on, under "## Your
// last attempt failed", so Red and Green get one retry here. An attempt that fails with no attempt after it gives its
// findings in the run's last transition.
//
// The BDD reports are Cucumber Messages, one Given (Context), When (Action) and Then (Outcome) step per scenario.
// A whole report ends with testRunFinished, the end of run cucumber-js writes last. A report cut short has none.
import { Before, Given, Then, When } from "@cucumber/cucumber";
import type { DataTable } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { setUp, runTheCell, type Ctx as CellCtx } from "./pbi-18.steps.ts";
import { loadInputs } from "../../src/cell/engine.ts";
import { parseRepoConfig, type RepoConfig } from "../../src/config/repo-config.ts";
import { loadPolicy } from "../../src/policy/policy.ts";
import { gate } from "../../src/gate/readiness.ts";
import { fakeBacklog } from "../../src/adapters/fake.ts";

const repo = process.cwd();
const long = { timeout: 180_000 };
/** The minutes a stand-in that hears no limit is given, as a cell has always given each command. */
const BUILT_IN_MINUTES = 15;
const T0 = Date.parse("2026-11-21T09:00:00Z");

type State = "passed" | "failedThen" | "given" | "when" | "listed";
type Row = { name: string; tags: string[]; state: State };
/** One run of a stand-in. `report` is the BDD report it leaves when it ends, `partial` the one when it's stopped. */
type Behaviour = { minutes: number; exit?: number; output?: string; report?: string; partial?: string };
type Entry = { cmd: string; minutes: number; stopped: boolean; limit: number; timed: boolean };

type Ctx = {
  parse: string; bddRun: string; test: string; lint: string;
  /** The raw YAML of `command_timeout_minutes`, or null when the config has no such key. */
  timeout: string | null;
  plans: Map<string, Behaviour[]>;
  /** The scenarios bdd.run's whole report holds, all passing, unless a step sets its runs. */
  scenarios: Row[];
  bin: string; planFile: string; logFile: string; clockFile: string;
  /** The stage the When ran, once it ran. */
  ran: "red" | "green" | null;
  blocked: string | null; started: boolean;
  readiness: { ready: boolean; results: { reason: string }[] } | null;
  read: { config: RepoConfig | null; error: string | null } | null;
};

function mine(world: object): Ctx {
  const w = world as { pbi399?: Ctx };
  assert.ok(w.pbi399, "this isn't a PBI 399 scenario");
  return w.pbi399;
}

function cell(world: object): CellCtx {
  const w = world as { pbi18?: CellCtx };
  assert.ok(w.pbi18, "no run was set up");
  return w.pbi18;
}

/** How the log names a command: npm's arguments lose their quotes on the way in. */
const key = (cmd: string) => cmd.trim().replace(/["']/g, "").replace(/\s+/g, " ");

// ---- BDD reports ----

const STATES: Record<string, State> = {
  "ended with every step passed": "passed",
  "ended failed on its Then": "failedThen",
  "started, with its Given passed": "given",
  "started, with its When passed": "when",
  "listed, never started": "listed",
};

function rowsOf(table: DataTable): Row[] {
  return table.hashes().map((r) => {
    const state = STATES[r["in the report"]!];
    assert.ok(state, `no report state "${r["in the report"]}"`);
    return { name: r.scenario!, tags: r.tags ? r.tags.split(/\s+/).filter(Boolean) : ["@pbi-482"], state };
  });
}

/**
 * A Cucumber Messages report of `rows`. `end` adds the end of run. `dry` lists each scenario as a dry run does, with
 * every step SKIPPED. `workers` spreads the test cases over that many parallel workers, as cucumber-js's --parallel does.
 */
function report(rows: Row[], o: { end: boolean; dry?: boolean; workers?: number }): string {
  const ts = { seconds: 0, nanos: 0 };
  const kinds = [["Context", "Given"], ["Action", "When"], ["Outcome", "Then"]] as const;
  const out: object[] = [{ testRunStarted: { timestamp: ts } }];
  rows.forEach((r, i) => {
    out.push({ pickle: { id: `p${i}`, uri: "features/pbi-482.feature", name: r.name, language: "en", astNodeIds: [],
      tags: r.tags.map((name) => ({ name, astNodeId: "" })),
      steps: kinds.map(([type, word], s) => ({ id: `p${i}s${s}`, type, text: `${word} step ${s}`, astNodeIds: [] })) } });
  });
  rows.forEach((_r, i) => out.push({ testCase: { id: `c${i}`, pickleId: `p${i}`, testSteps: kinds.map((_, s) => ({ id: `c${i}t${s}`, pickleStepId: `p${i}s${s}` })) } }));
  let success = true;
  rows.forEach((r, i) => {
    if (r.state === "listed" && !o.dry) return;
    const started = { id: `r${i}`, testCaseId: `c${i}`, attempt: 0, timestamp: ts, ...(o.workers ? { workerId: `worker-${i % o.workers}` } : {}) };
    out.push({ testCaseStarted: started });
    const statuses = o.dry ? ["SKIPPED", "SKIPPED", "SKIPPED"]
      : r.state === "passed" ? ["PASSED", "PASSED", "PASSED"]
      : r.state === "failedThen" ? ["PASSED", "PASSED", "FAILED"]
      : r.state === "given" ? ["PASSED"] : ["PASSED", "PASSED"];
    statuses.forEach((status, s) => {
      out.push({ testStepStarted: { testCaseStartedId: `r${i}`, testStepId: `c${i}t${s}`, timestamp: ts } });
      out.push({ testStepFinished: { testCaseStartedId: `r${i}`, testStepId: `c${i}t${s}`, timestamp: ts,
        testStepResult: { status, duration: ts, ...(status === "FAILED" ? { message: "AssertionError: expected the total" } : {}) } } });
    });
    if (status(r, o.dry) !== "running") out.push({ testCaseFinished: { testCaseStartedId: `r${i}`, timestamp: ts, willBeRetried: false } });
    if (!o.dry && r.state === "failedThen") success = false;
  });
  if (o.end) out.push({ testRunFinished: { timestamp: ts, success } });
  return out.map((m) => JSON.stringify(m)).join("\n") + "\n";
}

const status = (r: Row, dry?: boolean) => dry || r.state === "passed" || r.state === "failedThen" ? "ended" : r.state === "listed" ? "listed" : "running";

// ---- the stand-ins ----

// The fake npm, in CommonJS so node runs it from a directory with no package.json. The paths are written in, since a
// command the cell runs sees only PATH, HOME and CI (Run contract 11). PBI399_LIMIT_MS is the limit this file's
// shell passes on.
function fakeNpm(planFile: string, logFile: string, clockFile: string): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const cmd = ["npm", ...process.argv.slice(2)].join(" ").replace(/["']/g, "").replace(/\\s+/g, " ").trim();
const plan = JSON.parse(fs.readFileSync(${JSON.stringify(planFile)}, "utf8"));
const log = fs.existsSync(${JSON.stringify(logFile)}) ? fs.readFileSync(${JSON.stringify(logFile)}, "utf8").split("\\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const list = plan[cmd] || [{ minutes: 0, exit: 0 }];
const b = list[Math.min(log.filter((e) => e.cmd === cmd).length, list.length - 1)];
const timed = process.env.PBI399_LIMIT_MS !== undefined;
const limit = timed ? Number(process.env.PBI399_LIMIT_MS) / 60000 : ${BUILT_IN_MINUTES};
const stopped = b.minutes > limit;
const ran = stopped ? limit : b.minutes;
fs.writeFileSync(${JSON.stringify(clockFile)}, String(Number(fs.readFileSync(${JSON.stringify(clockFile)}, "utf8")) + ran * 60000));
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ cmd, minutes: ran, stopped, limit, timed }) + "\\n");
const left = stopped ? b.partial : b.report;
if (left !== undefined) {
  fs.mkdirSync("reports", { recursive: true });
  fs.writeFileSync("reports/bdd.ndjson", left);
}
if (stopped) {
  process.stdout.write("working...\\n");
  process.exit(1);
}
if (b.output) process.stdout.write(b.output + "\\n");
process.exit(b.exit || 0);
`;
}

function entries(m: Ctx): Entry[] {
  return existsSync(m.logFile) ? readFileSync(m.logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Entry) : [];
}

/** The engine's `shell`: `sh -c` in the checkout, as `sh` runs a command, with the limit passed on to the stand-ins. */
function timedShell(m: Ctx) {
  return (command: string, cwd: string, limitMs: number) => new Promise<{ code: number; out: string; all: string; stopped: boolean }>((resolve) => {
    const before = entries(m).length;
    const env: Record<string, string> = { CI: "true", PATH: process.env.PATH ?? "", PBI399_LIMIT_MS: String(limitMs) };
    if (process.env.HOME) env.HOME = process.env.HOME;
    execFile("sh", ["-c", command], { cwd, env, maxBuffer: 64 * 1024 * 1024 }, (e, stdout, stderr) => {
      const code = e ? (typeof e.code === "number" ? e.code : 1) : 0;
      const all = `${stdout}${stderr}`;
      resolve({ code, out: all.slice(-2000), all, stopped: entries(m).slice(before).some((x) => x.stopped) });
    });
  });
}

function plan(m: Ctx, cmd: string): Behaviour[] {
  const k = key(cmd);
  let p = m.plans.get(k);
  if (!p) m.plans.set(k, (p = []));
  return p;
}

function writePlan(m: Ctx): void {
  const out: Record<string, Behaviour[]> = {};
  const whole = report(m.scenarios, { end: true });
  const listing = report(m.scenarios, { end: true, dry: true });
  // bdd.run's whole report, and the listing bdd.parse and bdd.run's dry run write, unless a step set their runs.
  out[key(m.bddRun)] = [{ minutes: 1, exit: 0, report: whole }];
  for (const dry of [m.parse, `${m.bddRun} --dry-run`]) out[key(dry)] = [{ minutes: 0, exit: 0, report: listing }];
  for (const [k, list] of m.plans) {
    const dry = k === key(m.parse) || k === key(`${m.bddRun} --dry-run`);
    out[k] = list.map((b) => (dry && b.report === undefined ? { ...b, report: listing } : b));
  }
  writeFileSync(m.planFile, JSON.stringify(out));
}

/** The repo's .factory/config.yml, with `command_timeout_minutes` when a step set it. */
function configYaml(m: Ctx): string {
  return [
    "reviewers:", "  - owner",
    "bdd:", `  parse: ${JSON.stringify(m.parse)}`, `  run: ${JSON.stringify(m.bddRun)}`, "  report: reports/bdd.ndjson",
    "commands:", `  test: ${JSON.stringify(m.test)}`, `  lint: ${JSON.stringify(m.lint)}`,
    ...(m.timeout === null ? [] : [`command_timeout_minutes: ${m.timeout}`]),
  ].join("\n") + "\n";
}

Before({ tags: "@pbi-399" }, function () {
  const c = setUp(this, "green", true);
  const m: Ctx = {
    parse: "npm run bdd -- --dry-run", bddRun: "npm run bdd", test: "npm test", lint: "npm run lint", timeout: null,
    plans: new Map(), scenarios: c.scenarios.map((s) => ({ name: s.name, tags: s.tags, state: "passed" as State })),
    bin: join(c.root, "pbi399-bin"), planFile: join(c.root, "pbi399-plan.json"), logFile: join(c.root, "pbi399-runs.jsonl"),
    clockFile: join(c.root, "pbi399-clock"), ran: null, blocked: null, started: false, readiness: null, read: null,
  };
  (this as { pbi399?: Ctx }).pbi399 = m;
  mkdirSync(m.bin);
  writeFileSync(join(m.bin, "npm"), fakeNpm(m.planFile, m.logFile, m.clockFile));
  chmodSync(join(m.bin, "npm"), 0o755);
  writeFileSync(m.clockFile, "0");
  // PBI 18's After puts PATH back.
  c.secrets = { ...(c.secrets ?? {}), PATH: process.env.PATH };
  process.env.PATH = `${m.bin}${delimiter}${process.env.PATH ?? ""}`;
  c.now = () => new Date(T0 + Number(readFileSync(m.clockFile, "utf8")));
  // One retry, so a failed attempt's findings reach the next attempt's brief.
  c.editSop = (sop) => { for (const s of sop.stages) if (s.id === "red" || s.id === "green") s.retries = 1; };
  // The config the cell runs with is the repo's config.yml as the factory parses it.
  c.editConfig = (config) => Object.assign(config, parseRepoConfig(configYaml(m)));
  c.deps = { shell: timedShell(m) };
});

async function runStage(world: object, stage: "red" | "green"): Promise<void> {
  const m = mine(world);
  const c = cell(world);
  assert.equal(m.ran, null, "the cell already ran in this scenario");
  m.ran = stage;
  c.nextStage = stage;
  writePlan(m);
  await runTheCell(world);
  if (stage === "red") {
    // PBI 14's "Red passes" reads its gate.
    const w = world as { pbi14?: { gate?: { ok: boolean; findings: string[] } | null } };
    w.pbi14 ??= {};
    w.pbi14.gate = outcome(c, "red", 1) === "passed" ? { ok: true, findings: [] } : { ok: false, findings: findingsOf(world, "red", 1) };
  }
}

// ---- what reads the run ----

function settled(c: CellCtx): void {
  assert.equal(c.error, null, `the cell failed: ${c.error instanceof Error ? c.error.stack : String(c.error)}`);
}

/** How the stage's attempt ended, by its /stage report, or null when it didn't end. */
function outcome(c: CellCtx, stage: string, attempt: number): string | null {
  const s = c.calls.filter((x) => x.route === "/stage" && x.body.stageId === stage && x.body.attempt === attempt && x.body.status !== "started");
  return (s.at(-1)?.body.status as string | undefined) ?? null;
}

/** The briefs of the stage's own attempts, oldest first. */
function briefs(c: CellCtx, stage: string): string[] {
  return c.agentCalls.filter((a) => a.stage === stage && !a.agent && a.mode !== "judge" && !a.prompt.startsWith("# Definition of Done")).map((a) => a.prompt);
}

/** What a brief says under "## Your last attempt failed", or null when it says nothing there. */
function lastFailed(brief: string): string | null {
  const at = brief.indexOf("## Your last attempt failed");
  return at < 0 ? null : brief.slice(at + "## Your last attempt failed".length);
}

const items = (text: string) => text.split(/\n(?=- )/).map((s) => s.replace(/^\s*-\s*/, "").trim()).filter(Boolean);

/** The findings the stage's attempt failed on. */
function findingsOf(world: object, stage: string, attempt: number): string[] {
  const c = cell(world);
  settled(c);
  assert.equal(outcome(c, stage, attempt), "failed", `${stage}'s attempt ${attempt} didn't fail: it ${outcome(c, stage, attempt) ?? "didn't end"}`);
  const next = briefs(c, stage)[attempt];
  const told = next === undefined ? null : lastFailed(next);
  if (told !== null) return items(told);
  const t = c.calls.filter((x) => x.route === "/transition").at(-1);
  const body = String(t?.body.question?.body ?? t?.body.reason ?? "");
  assert.ok(body, `${stage}'s attempt ${attempt} failed, and neither a next attempt nor the run's last transition says why`);
  return items(body.slice(body.indexOf("\n") + 1));
}

const stopRe = (n: number) => new RegExp(`\\b${n} minutes?\\b`);
/** A text that names `cmd` and the limit of `n` minutes and says the cell stopped it there. */
const saysStopped = (text: string, cmd: string, n: number) =>
  text.includes(cmd) && /\bstop(ped|s)?\b/i.test(text) && /\blimit\b/i.test(text) && stopRe(n).test(text);

function assertStopped(texts: string[], cmd: string, n: number, what: string): void {
  assert.ok(texts.some((t) => saysStopped(t, cmd, n)),
    `${what} says nothing of the cell stopping "${cmd}" at its time limit of ${n} minutes:\n${texts.map((t) => `- ${t}`).join("\n") || "(none)"}`);
}

const didntFinish = (text: string) => /\b(didn't|did not|never) finish/i.test(text) && /\b(BDD|bdd\.run)\b/i.test(text);
/** A finding that reports a scenario as failing, crashed or red, as Green's and Red's scenario findings do. */
const failingScenario = (text: string) => !didntFinish(text) && /\bscenario/i.test(text) && /\b(fail(ed|s|ing)?|crash(ed|es)?|red)\b/i.test(text);

function theDidntFinish(world: object, stage: string): string {
  const f = findingsOf(world, stage, 1).filter(didntFinish);
  assert.ok(f.length, `no finding of ${stage}'s attempt says the BDD run didn't finish:\n${findingsOf(world, stage, 1).map((t) => `- ${t}`).join("\n")}`);
  return f[0]!;
}

function namesRunning(finding: string, names: string[]): void {
  assert.match(finding, /\brunning\b/i, `the finding doesn't say which scenario was running: ${finding}`);
  for (const n of names) assert.ok(finding.includes(n), `the finding doesn't name "${n}" as running: ${finding}`);
}

/** The stage's stored Definition of Done verdict for the line that starts `text`, from the first check. */
function dodVerdict(world: object, text: string): { status: string; reason: string } {
  const c = cell(world);
  assert.equal(mine(world).ran, "green", "the cell didn't run Green");
  const stored = c.calls.filter((x) => x.route === "/policy-results" && x.body.file === "dod");
  assert.ok(stored.length, `the cell stored no Definition of Done results${c.error ? `, and failed: ${String(c.error)}` : ""}`);
  const v = (stored[0]!.body.verdicts as { criterion: string; status: string; reason: string }[]).find((x) => x.criterion.startsWith(text));
  assert.ok(v, `the stored results have no line "${text}"`);
  return v;
}

function runsOf(world: object, cmd: string): Entry[] {
  const m = mine(world);
  assert.ok(m.ran, "the cell didn't run");
  const r = entries(m).filter((e) => e.cmd === key(cmd));
  assert.ok(r.length, `the cell never ran "${cmd}"; it ran ${JSON.stringify([...new Set(entries(m).map((e) => e.cmd))])}`);
  return r;
}

// ---- the functions PBI 229's shared step hands over to ----

export const pbi399 = {
  active: (world: object) => (world as { pbi399?: Ctx }).pbi399 !== undefined,
  readConfig(world: object, path: string) {
    const m = mine(world);
    const file = join(repo, path);
    assert.ok(existsSync(file), `this repo has no ${path}`);
    try {
      m.read = { config: parseRepoConfig(readFileSync(file, "utf8")), error: null };
    } catch (e) {
      m.read = { config: null, error: (e as Error).message };
    }
  },
};

// ---- Given: the repo ----

Given("the repo's commands.lint is {string}", function (cmd: string) {
  mine(this).lint = cmd;
});

Given("the repo's bdd.parse is {string}", function (cmd: string) {
  mine(this).parse = cmd;
});

Given(/^the repo's "\.factory\/config\.yml" sets `command_timeout_minutes` to (.+)$/, function (value: string) {
  mine(this).timeout = value;
});

Given("the repo's {string} runs for {int} minutes", function (cmd: string, minutes: number) {
  plan(mine(this), cmd).push({ minutes });
});

Given("the repo's {string} runs for {int} minutes and exits {int}", function (cmd: string, minutes: number, exit: number) {
  plan(mine(this), cmd).push({ minutes, exit });
});

Given("the repo's {string} runs for {int} minutes, prints {string} and exits {int}", function (cmd: string, minutes: number, output: string, exit: number) {
  plan(mine(this), cmd).push({ minutes, exit, output });
});

Given("the repo's {string} runs for {int} minutes on Green's first attempt and passes in {int} minutes after that", function (cmd: string, first: number, after: number) {
  plan(mine(this), cmd).push({ minutes: first }, { minutes: after, exit: 0 });
});

Given("the repo's {string} runs for {int} minutes, and by {int} minutes has passed {string} and is running {string}", function (cmd: string, minutes: number, _by: number, done: string, running: string) {
  const m = mine(this);
  assert.equal(key(cmd), key(m.bddRun), `"${cmd}" isn't the repo's bdd.run`);
  m.scenarios = [{ name: done, tags: ["@pbi-482"], state: "passed" }, { name: running, tags: ["@pbi-482"], state: "passed" }];
  const cut: Row[] = [{ ...m.scenarios[0]! }, { ...m.scenarios[1]!, state: "given" }];
  plan(m, cmd).push({ minutes, exit: 0, report: report(m.scenarios, { end: true }), partial: report(cut, { end: false }) });
});

Given("every other command of the gate passes", function () {
  const m = mine(this);
  for (const cmd of [m.test, m.lint]) if (!m.plans.has(key(cmd))) plan(m, cmd).push({ minutes: 1, exit: 0 });
});

/** bdd.run writes `cut`, a report with no end of run, as cucumber-js leaves one when it's stopped. */
function cutShort(m: Ctx, rows: Row[], workers?: number): void {
  m.scenarios = rows.map((r) => ({ ...r, state: "passed" }));
  plan(m, m.bddRun).push({ minutes: 2, exit: 1, report: report(rows, { end: false, workers }) });
}

Given("bdd.run writes a report that stops part way, with no end of run:", function (table: DataTable) {
  cutShort(mine(this), rowsOf(table));
});

Given("bdd.run writes a report from {int} workers that stops part way, with no end of run:", function (workers: number, table: DataTable) {
  cutShort(mine(this), rowsOf(table), workers);
});

Given("bdd.run writes a report with no end of run, in which these scenarios ended:", function (table: DataTable) {
  cutShort(mine(this), rowsOf(table));
});

Given("bdd.run writes a whole report, with its end of run, in which these scenarios ended:", function (table: DataTable) {
  const m = mine(this);
  const rows = rowsOf(table);
  m.scenarios = rows;
  plan(m, m.bddRun).push({ minutes: 2, exit: rows.some((r) => r.state !== "passed") ? 1 : 0, report: report(rows, { end: true }) });
});

Given("bdd.run writes a report with no end of run on Green's first attempt, while {string} was running", function (running: string) {
  cutShort(mine(this), [{ name: "Totals add up", tags: ["@pbi-482"], state: "passed" }, { name: running, tags: ["@pbi-482"], state: "given" }]);
});

Given("bdd.run writes a whole report with every scenario passed after that", function () {
  const m = mine(this);
  assert.ok(m.plans.get(key(m.bddRun))?.length, "no step set bdd.run's first run");
  plan(m, m.bddRun).push({ minutes: 2, exit: 0, report: report(m.scenarios.map((r) => ({ ...r, state: "passed" })), { end: true }) });
});

// ---- When ----

When(/^the cell (?:runs Green|checks the Definition of Done in Green)$/, long, async function () {
  await runStage(this, "green");
});

When("the cell runs Red", long, async function () {
  await runStage(this, "red");
});

// src/cell/main.ts loads the run's config and policies with loadInputs before it starts the engine, and blocks the
// run with loadInputs's reason when one is wrong. A run that isn't blocked starts the engine at Green.
When("the cell starts the run", long, async function () {
  const m = mine(this);
  const c = cell(this);
  m.started = true;
  const files: Record<string, string> = { ".factory/config.yml": configYaml(m), ".factory/dod.md": c.dod };
  const inputs = await loadInputs(async (p) => files[p] ?? null, "c0ffee");
  if ("blocked" in inputs) {
    m.blocked = inputs.blocked;
    m.ran = "green";
    return;
  }
  await runStage(this, "green");
});

// The poller reads a repo's config as valid when parseRepoConfig takes it (src/watcher/poller.ts's readiness), and
// hands that to the readiness gate.
When("the factory checks the repo's readiness for item {int}", async function (item: number) {
  const m = mine(this);
  let configValid = true;
  try {
    parseRepoConfig(configYaml(m));
  } catch {
    configValid = false;
  }
  const backlog = fakeBacklog();
  const id = await backlog.seed({ externalId: String(item), title: `Item ${item}`, acceptanceCriteria: ["Totals add up"] });
  const found = await backlog.adapter.getItem(id);
  assert.ok(found, `the fake backlog has no item ${item}`);
  const dor = await loadPolicy(async () => null, "dor");
  const judge = async (_i: unknown, d: { criteria: { index: number }[] }) =>
    [...d.criteria.map((cr) => JSON.stringify({ index: cr.index, status: "passed", reason: "ok" })), JSON.stringify({ flags: [] })].join("\n");
  m.readiness = await gate(found, { readinessSha: "pbi-399", dor, dodExists: true, configValid, repoKnown: true, judge, adapter: backlog.adapter });
});

// ---- Then: the stage ----

Then(/^(Green|Red)'s (?:first )?attempt fails$/, function (stage: string) {
  const c = cell(this);
  settled(c);
  const s = stage.toLowerCase();
  assert.equal(outcome(c, s, 1), "failed", `${stage}'s first attempt didn't fail: it ${outcome(c, s, 1) ?? "didn't end"}`);
});

Then("Green's gate passes", function () {
  const c = cell(this);
  settled(c);
  const ended = outcome(c, "green", 1);
  assert.equal(ended, "passed", `Green's first attempt ${ended ?? "didn't end"}${ended === "failed" ? `:\n${findingsOf(this, "green", 1).map((f) => `- ${f}`).join("\n")}` : ""}`);
});

Then("the attempt's finding names the command {string}", function (cmd: string) {
  const f = findingsOf(this, mine(this).ran!, 1);
  assert.ok(f.some((x) => x.includes(cmd)), `no finding names "${cmd}":\n${f.map((x) => `- ${x}`).join("\n")}`);
});

Then("the attempt's finding says the cell stopped the command at its time limit of {int} minutes", function (n: number) {
  assertStopped(findingsOf(this, mine(this).ran!, 1), mine(this).test, n, "the attempt's findings");
});

Then("the attempt's finding says the cell stopped {string} at its time limit of {int} minutes", function (cmd: string, n: number) {
  assertStopped(findingsOf(this, mine(this).ran!, 1), cmd, n, "the attempt's findings");
});

Then("the attempt has no finding that says {string} exited {int}", function (cmd: string, code: number) {
  const m = mine(this);
  const which = Object.entries({ test: m.test, lint: m.lint }).find(([, v]) => v === cmd)?.[0];
  const exited = new RegExp(`\\bexit(ed)?:?\\s+${code}\\b`, "i");
  const said = findingsOf(this, m.ran!, 1).filter((f) => exited.test(f) && (f.includes(cmd) || (which !== undefined && f.includes(`commands.${which}`))));
  assert.deepEqual(said, [], `a finding says "${cmd}" exited ${code}`);
});

Then(/^Green's second attempt's brief, under "Your last attempt failed", says the cell stopped "([^"]+)" at its time limit of (\d+) minutes$/, function (cmd: string, n: string) {
  const c = cell(this);
  settled(c);
  const second = briefs(c, "green")[1];
  assert.ok(second, "Green had no second attempt");
  const told = lastFailed(second);
  assert.ok(told, "Green's second attempt's brief has no \"Your last attempt failed\"");
  assertStopped(items(told), cmd, Number(n), "Green's second attempt's brief");
});

Then(/^Green's second attempt's brief, under "Your last attempt failed", says the BDD run didn't finish while "([^"]+)" was running$/, function (running: string) {
  const c = cell(this);
  settled(c);
  const second = briefs(c, "green")[1];
  assert.ok(second, "Green had no second attempt");
  const told = lastFailed(second);
  assert.ok(told, "Green's second attempt's brief has no \"Your last attempt failed\"");
  const f = items(told).find(didntFinish);
  assert.ok(f, `Green's second attempt's brief doesn't say the BDD run didn't finish:\n${told}`);
  namesRunning(f, [running]);
});

Then("the attempt's finding says the BDD run didn't finish", function () {
  theDidntFinish(this, mine(this).ran!);
});

Then("that finding names {string} as the scenario that was running", function (name: string) {
  namesRunning(theDidntFinish(this, mine(this).ran!), [name]);
});

Then("that finding names {string} and {string} as the scenarios that were running", function (a: string, b: string) {
  namesRunning(theDidntFinish(this, mine(this).ran!), [a, b]);
});

function noneReports(world: object, names: string[]): void {
  const f = findingsOf(world, mine(world).ran!, 1);
  const bad = f.filter((x) => failingScenario(x) && (names.length === 0 || names.some((n) => x.includes(n))));
  assert.deepEqual(bad, [], `a finding reports ${names.length ? names.map((n) => `"${n}"`).join(" or ") : "a scenario"} as a failing scenario`);
}

Then("no finding of the attempt reports {string} as a failing scenario", function (a: string) {
  noneReports(this, [a]);
});

Then("no finding of the attempt reports {string} or {string} as a failing scenario", function (a: string, b: string) {
  noneReports(this, [a, b]);
});

Then("no finding of the attempt reports {string}, {string} or {string} as a failing scenario", function (a: string, b: string, d: string) {
  noneReports(this, [a, b, d]);
});

Then("no finding of the attempt reports a failing scenario", function () {
  noneReports(this, []);
});

Then("no finding of the attempt says {string} or {string} crashed", function (a: string, b: string) {
  const bad = findingsOf(this, mine(this).ran!, 1).filter((x) => /\bcrash(ed|es)?\b/i.test(x) && (x.includes(a) || x.includes(b)));
  assert.deepEqual(bad, [], `a finding says "${a}" or "${b}" crashed`);
});

Then("a finding of the attempt names {string}", function (name: string) {
  const f = findingsOf(this, mine(this).ran!, 1);
  assert.ok(f.some((x) => x.includes(name)), `no finding names "${name}":\n${f.map((x) => `- ${x}`).join("\n")}`);
});

Then("no finding of the attempt names {string}", function (name: string) {
  const bad = findingsOf(this, mine(this).ran!, 1).filter((x) => x.includes(name));
  assert.deepEqual(bad, [], `a finding names "${name}"`);
});

Then("the attempt's finding says {string} and holds {string}", function (says: string, holds: string) {
  const f = findingsOf(this, mine(this).ran!, 1);
  assert.ok(f.some((x) => x.includes(says) && x.includes(holds)), `no finding says "${says}" and holds "${holds}":\n${f.map((x) => `- ${x}`).join("\n")}`);
});

// ---- Then: the time limit ----

Then("the cell didn't stop {string}", function (cmd: string) {
  const stopped = runsOf(this, cmd).filter((e) => e.stopped);
  assert.deepEqual(stopped, [], `the cell stopped "${cmd}"`);
});

Then("the cell stopped {string} after {int} minutes", function (cmd: string, n: number) {
  const r = runsOf(this, cmd);
  assert.ok(r.some((e) => e.stopped && e.minutes === n), `the cell didn't stop "${cmd}" after ${n} minutes: its runs were ${JSON.stringify(r)}`);
});

// ---- Then: the Definition of Done ----

Then("the Definition of Done line {string} fails", function (text: string) {
  const v = dodVerdict(this, text);
  assert.equal(v.status, "failed", `the line ${v.status}: ${v.reason}`);
});

Then("the Definition of Done line {string} passes", function (text: string) {
  const v = dodVerdict(this, text);
  assert.equal(v.status, "passed", `the line ${v.status}: ${v.reason}`);
});

/** The reason of the line the scenario's Then before named. */
function lastLineReason(world: object): string {
  const m = mine(world);
  const c = cell(world);
  const line = /^- \[ \] (.*?)\s*`run:/m.exec(c.dod)?.[1];
  assert.ok(line, "the scenario set no Definition of Done run: line");
  assert.ok(m.ran, "the cell didn't run");
  return dodVerdict(world, line).reason;
}

Then("its reason says the cell stopped {string} at its time limit of {int} minutes", function (cmd: string, n: number) {
  assertStopped([lastLineReason(this)], cmd, n, "the line's reason");
});

Then("its reason says {string} and holds {string}", function (says: string, holds: string) {
  const r = lastLineReason(this);
  assert.ok(r.includes(says) && r.includes(holds), `the line's reason doesn't say "${says}" and hold "${holds}": ${r}`);
});

// ---- Then: the config ----

Then(/^the run is blocked with a reason that says "\.factory\/config\.yml" has a missing or invalid `command_timeout_minutes`$/, function () {
  const m = mine(this);
  const c = cell(this);
  assert.ok(m.started, "the cell didn't start the run");
  assert.ok(m.blocked !== null, `the run wasn't blocked${c.error ? `: the cell failed: ${String(c.error)}` : ""}`);
  assert.ok(m.blocked.includes(".factory/config.yml") && /missing or invalid/.test(m.blocked) && m.blocked.includes("command_timeout_minutes"),
    `the reason doesn't say .factory/config.yml has a missing or invalid command_timeout_minutes: ${m.blocked}`);
});

Then("the cell ran none of the repo's commands", function () {
  assert.deepEqual(entries(mine(this)).map((e) => e.cmd), [], "the cell ran the repo's commands");
});

Then("the readiness check reports the repo's config as invalid", function () {
  const r = mine(this).readiness;
  assert.ok(r, "the readiness check didn't run");
  assert.equal(r.ready, false, "the readiness check passed the item");
  assert.ok(r.results.some((v) => /\.factory\/config\.yml/.test(v.reason) && /valid/i.test(v.reason)),
    `the readiness check doesn't report the repo's config as invalid: ${JSON.stringify(r.results.map((v) => v.reason))}`);
});

Then("the config is valid", function () {
  const r = mine(this).read;
  assert.ok(r, "the factory didn't read the config");
  assert.equal(r.error, null, `the config is invalid: ${r.error}`);
});

Then("its time limit for each command a cell runs is {int} minutes", function (n: number) {
  const r = mine(this).read;
  assert.ok(r?.config, "the factory didn't read a valid config");
  assert.equal(r.config.commandTimeoutMinutes, n, `the config's time limit is ${r.config.commandTimeoutMinutes ?? "not set"}`);
});
