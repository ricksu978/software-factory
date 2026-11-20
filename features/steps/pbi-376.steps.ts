// Step definitions for features/pbi-376-standby-takeover-passes-every-time.feature.
//
// Every scenario runs the real `npm run bdd:repeat` from the repo root as a child process and reads its exit code and
// its output, stdout and stderr together. The script is expected to:
// - run cucumber-js as `npm run bdd` does (the same `--import "features/steps/**/*.ts"`), in the directory named by
//   BDD_REPEAT_CWD when that is set and in the repo root otherwise, passing its own environment on to each run;
// - name each failed run with a line holding "run <i> of <n> failed";
// - end with "<passed> of <n> runs passed";
// - say `no scenario is named "<name>"` when no scenario has the name, and that "the run count must be a whole number
//   above zero" when --times isn't one, running nothing in that case;
// - print each failed run's own output, so the reason a run failed can be read from the script's output.
//
// Practice scenarios. A Given writes a small cucumber project into a temp directory: features/practice.feature holds
// one scenario per practice scenario named, and features/steps/practice.steps.ts holds its one step. node_modules is a
// link to the repo's. The step appends "start <i>" and "end <i>" to <scenario>.runs as each run starts and ends, and
// fails on the runs <scenario>.plan.json lists. So the test sets which runs pass, and reads how many ran and in what order.
//
// PBI 157's scenarios. The @ac-2 and @ac-3 scenarios run the real takeover and second worker scenarios. The @ac-4
// scenarios break the takeover on purpose through PBI376_FAULT, which the script passes on to each run. The hooks at the
// bottom of this file read it in that inner run, for @pbi-157 scenarios only, and do nothing when it isn't set:
// - "never": a session of the test's own waits on the worker lock before the first worker's lock connection is ended,
//   so Postgres hands the lock to it and not to the standby, and it keeps the lock until the scenario ends.
// - "late": the same, but the test's session gives the lock back 45 seconds after the first worker's lock session ended.
// - "first-keeps-working": the first worker's lock connection hides its own end from the worker, so the worker keeps
//   ticking without the lock.
import { After, AfterAll, AfterStep, Before, BeforeStep, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { WORKER_LOCK_KEY } from "../../src/worker/main.ts";
import { long, need } from "./pbi-8.steps.ts";
import { ctx as p157 } from "./pbi-157.steps.ts";

const repo = process.cwd();
/** Long enough for 20 runs of the takeover scenario back to back. */
const REPEAT_TIMEOUT_MS = 90 * 60_000;
const FAULT_ENV = "PBI376_FAULT";
type Fault = "never" | "late" | "first-keeps-working";
/** How long after the first worker loses its lock the "late" fault gives the lock back. */
const LATE_MS = 45_000;

type Practice = { dir: string; scenarios: Map<string, number[]> };
type Ctx = {
  practice?: Practice;
  fault?: Fault;
  result?: { code: number | null; signal: NodeJS.Signals | null; out: string };
};

function ctx(world: object): Ctx {
  const w = world as { pbi376?: Ctx };
  w.pbi376 ??= {};
  return w.pbi376;
}

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

// ---- Practice scenarios ----

const PRACTICE_STEPS = `import { Given } from "@cucumber/cucumber";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.PBI376_PRACTICE_DIR;
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

Given("the practice scenario {string} counts", async function (name) {
  if (!dir) throw new Error("PBI376_PRACTICE_DIR isn't set in the run");
  const runs = join(dir, slug(name) + ".runs");
  const before = existsSync(runs) ? readFileSync(runs, "utf8").split("\\n").filter((l) => l.startsWith("start ")).length : 0;
  const i = before + 1;
  appendFileSync(runs, "start " + i + "\\n");
  await new Promise((r) => setTimeout(r, 150));
  appendFileSync(runs, "end " + i + "\\n");
  const plan = JSON.parse(readFileSync(join(dir, slug(name) + ".plan.json"), "utf8"));
  if (plan.includes(i)) throw new Error("practice run " + i + " of " + name + " fails, as the test planned");
});
`;

function writePractice(p: Practice): void {
  mkdirSync(join(p.dir, "features", "steps"), { recursive: true });
  const scenarios = [...p.scenarios.keys()].map((name) => `  Scenario: ${name}\n    Given the practice scenario "${name}" counts\n`);
  writeFileSync(join(p.dir, "features", "practice.feature"), `Feature: Practice scenarios for PBI 376\n\n${scenarios.join("\n")}`);
  writeFileSync(join(p.dir, "features", "steps", "practice.steps.ts"), PRACTICE_STEPS);
  for (const [name, fails] of p.scenarios) writeFileSync(join(p.dir, `${slug(name)}.plan.json`), JSON.stringify(fails));
}

function practice(world: object): Practice {
  const c = ctx(world);
  if (!c.practice) {
    const dir = mkdtempSync(join(tmpdir(), "pbi376-practice-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "pbi376-practice", private: true, type: "module" }));
    symlinkSync(join(repo, "node_modules"), join(dir, "node_modules"), "dir");
    c.practice = { dir, scenarios: new Map() };
  }
  return c.practice;
}

function addPractice(world: object, name: string, fails: number[]): void {
  const p = practice(world);
  p.scenarios.set(name, fails);
  writePractice(p);
}

/** The practice scenario's run log: "start <i>" and "end <i>" lines, in the order they were written. */
function runLog(world: object, name: string): string[] {
  const p = ctx(world).practice;
  assert.ok(p, "no practice scenario was set up");
  const file = join(p.dir, `${slug(name)}.runs`);
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
}

const starts = (log: string[]) => log.filter((l) => l.startsWith("start ")).length;

function onlyPractice(world: object): string {
  const p = ctx(world).practice;
  assert.ok(p && p.scenarios.size === 1, "the scenario names no single practice scenario");
  return [...p.scenarios.keys()][0];
}

/** "2 and 4", "1, 2 and 3" or "1" as numbers. */
function runList(text: string): number[] {
  return text.split(/,|\band\b/).map((s) => s.trim()).filter(Boolean).map(Number);
}

// ---- Running the script ----

type Result = NonNullable<Ctx["result"]>;
type Run = Promise<Result>;

/** Starts `npm run bdd:repeat -- <args>` from the repo root, with the practice project and the fault in its environment. */
function startRepeat(args: string[], opts: { practiceDir?: string; fault?: Fault }): Run {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env[FAULT_ENV];
  delete env.BDD_REPEAT_CWD;
  if (opts.practiceDir) {
    env.BDD_REPEAT_CWD = opts.practiceDir;
    env.PBI376_PRACTICE_DIR = opts.practiceDir;
  }
  if (opts.fault) env[FAULT_ENV] = opts.fault;
  const child = spawn("npm", ["run", "--silent", "bdd:repeat", "--", ...args], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
  const out: string[] = [];
  for (const s of [child.stdout, child.stderr]) s.on("data", (b: Buffer) => out.push(b.toString()));
  const promise = new Promise<Result>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, out: out.join("") }));
  });
  promise.catch(() => {});
  return promise;
}

// The @ac-4 scenarios each run the takeover scenario 3 times under one fault, and each of those runs waits out the
// whole 30 seconds before it fails, so the three one after another would take over 5 minutes of the 15 a cell gives
// `npm run bdd`. The faults don't touch each other: every inner run starts its own Postgres and its own workers. So
// the first of them starts the script for every fault with the same arguments, and each scenario reads the run made
// with its own fault. Each script still runs its scenario back to back; only the three scripts overlap. A run no
// scenario reads, as when only one of them is selected, is waited for once the suite ends. It isn't killed, because
// the Postgres server each inner run starts outlives a killed run.
const FAULTS: Fault[] = ["never", "late", "first-keeps-working"];
/** The runs started ahead that no scenario has read yet, by fault and arguments. */
const ahead = new Map<string, Run>();
/** The arguments the runs for every fault have been started with, so a later scenario doesn't start them again. */
const startedAhead = new Set<string>();
const aheadKey = (fault: Fault, args: string[]) => JSON.stringify([fault, args]);

function faultRun(fault: Fault, args: string[]): Run {
  const argsKey = JSON.stringify(args);
  if (!startedAhead.has(argsKey)) {
    startedAhead.add(argsKey);
    for (const f of FAULTS) ahead.set(aheadKey(f, args), startRepeat(args, { fault: f }));
  }
  const key = aheadKey(fault, args);
  const run = ahead.get(key) ?? startRepeat(args, { fault });
  ahead.delete(key);
  return run;
}

AfterAll({ timeout: REPEAT_TIMEOUT_MS }, async function () {
  const left = [...ahead.values()];
  ahead.clear();
  await Promise.allSettled(left);
});

async function repeat(world: object, args: string[]): Promise<void> {
  const c = ctx(world);
  const run = c.fault && !c.practice ? faultRun(c.fault, args) : startRepeat(args, { practiceDir: c.practice?.dir, fault: c.fault });
  c.result = await run;
  process.stdout.write(c.result.out);
}

function result(world: object): NonNullable<Ctx["result"]> {
  const r = ctx(world).result;
  assert.ok(r, "the script never ran");
  return r;
}

/** The runs the script named as failed. */
function failedRuns(out: string): number[] {
  return [...new Set([...out.matchAll(/\brun (\d+) of \d+ failed\b/gi)].map((m) => Number(m[1])))].sort((a, b) => a - b);
}

// ---- Hooks ----

After({ tags: "@pbi-376" }, function () {
  const p = ctx(this).practice;
  if (p) rmSync(p.dir, { recursive: true, force: true });
});

// ---- Given ----

Given("a practice scenario {string} that passes on every run", function (name: string) {
  addPractice(this, name, []);
});

Given("a practice scenario {string} that fails on runs {int} and {int} and passes on the others", function (name: string, a: number, b: number) {
  addPractice(this, name, [a, b]);
});

Given("a practice scenario {string} that fails on run {int} and passes on the others", function (name: string, a: number) {
  addPractice(this, name, [a]);
});

Given("the standby is kept from ever taking the worker lock", function () {
  ctx(this).fault = "never";
});

Given("the standby takes the worker lock only {int} seconds after the first worker loses it", function (s: number) {
  assert.equal(s * 1_000, LATE_MS, `the "late" fault gives the lock back ${LATE_MS / 1_000} seconds after, not ${s}`);
  ctx(this).fault = "late";
});

Given("the first worker keeps working after it loses its lock connection", function () {
  ctx(this).fault = "first-keeps-working";
});

// ---- When ----

When(/^the owner runs `npm run bdd:repeat -- --times (\d+) --name "(.*)"`$/, { timeout: REPEAT_TIMEOUT_MS }, async function (times: string, name: string) {
  await repeat(this, ["--times", times, "--name", name]);
});

When("the owner runs bdd:repeat {int} times on {string}", { timeout: REPEAT_TIMEOUT_MS }, async function (times: number, name: string) {
  await repeat(this, ["--times", String(times), "--name", name]);
});

When("the owner runs bdd:repeat for {string} with the run count {string}", long, async function (name: string, times: string) {
  await repeat(this, ["--times", times, "--name", name]);
});

When("the owner runs bdd:repeat for {string} with the run count missing", long, async function (name: string) {
  await repeat(this, ["--name", name]);
});

// ---- Then ----

Then("the script exits with code {int}", function (code: number) {
  const r = result(this);
  assert.equal(r.code, code, `the script exited with code ${r.code}, signal ${r.signal}:\n${r.out}`);
});

Then("the script exits with a non-zero code", function () {
  const r = result(this);
  assert.ok(r.code !== null && r.code !== 0, `the script exited with code ${r.code}, signal ${r.signal}:\n${r.out}`);
});

Then("the script reports that {int} of {int} runs passed", function (passed: number, n: number) {
  const r = result(this);
  const m = [...r.out.matchAll(/\b(\d+) of (\d+) runs passed\b/gi)].at(-1);
  assert.ok(m, `the script reports no count of runs passed:\n${r.out}`);
  assert.deepEqual([Number(m[1]), Number(m[2])], [passed, n], `the script reports ${m[0]}`);
});

Then(/^the script names runs? ([\d, and]+) as failed$/, function (list: string) {
  const r = result(this);
  const named = failedRuns(r.out);
  for (const i of runList(list)) assert.ok(named.includes(i), `the script doesn't name run ${i} as failed, only ${JSON.stringify(named)}:\n${r.out}`);
});

Then("the script names no other run as failed", function () {
  const r = result(this);
  // The scenario's own list: the practice scenario's planned failures.
  const p = ctx(this).practice!;
  const planned = [...p.scenarios.values()].flat().sort((a, b) => a - b);
  assert.deepEqual(failedRuns(r.out), planned, `the script names other runs as failed:\n${r.out}`);
});

Then("the practice scenario ran {int} times, one run after another", function (n: number) {
  const log = runLog(this, onlyPractice(this));
  assert.equal(starts(log), n, `the practice scenario ran ${starts(log)} times`);
  const inOrder = Array.from({ length: n }, (_, i) => [`start ${i + 1}`, `end ${i + 1}`]).flat();
  assert.deepEqual(log, inOrder, "the runs overlapped or ran out of order");
});

Then("the practice scenario ran {int} times", function (n: number) {
  const log = runLog(this, onlyPractice(this));
  assert.equal(starts(log), n, `the practice scenario ran ${starts(log)} times`);
});

Then("the practice scenario {string} ran {int} times", function (name: string, n: number) {
  const log = runLog(this, name);
  assert.equal(starts(log), n, `the practice scenario "${name}" ran ${starts(log)} times`);
});

Then("the practice scenario {string} never ran", function (name: string) {
  const log = runLog(this, name);
  assert.equal(starts(log), 0, `the practice scenario "${name}" ran ${starts(log)} times`);
});

Then("the script says no scenario is named {string}", function (name: string) {
  const r = result(this);
  assert.ok(r.out.includes(`no scenario is named "${name}"`), `the script doesn't say no scenario is named "${name}":\n${r.out}`);
});

Then("the script says the run count must be a whole number above zero", function () {
  const r = result(this);
  assert.match(r.out, /run count must be a whole number above zero/i);
});

Then("each run failed because the second worker launched no cell for item {string} within {int} seconds", function (name: string, _s: number) {
  const r = result(this);
  // PBI 157's takeover Then times out with this, once its 30 seconds from the lock loss are up.
  const because = `timed out waiting until the second worker launches item ${name}'s cell`;
  const n = failedRuns(r.out).length;
  assert.ok(n > 0, `the script names no run as failed:\n${r.out}`);
  const seen = r.out.split(because).length - 1;
  assert.ok(seen >= n, `${seen} of the ${n} failed runs failed because the second worker launched no cell for item ${name} in time:\n${r.out}`);
});

// ---- PBI 157's faults, read in the inner run ----

const fault = () => process.env[FAULT_ENV] as Fault | undefined;
const LOSS_STEP = "the first worker's lock connection is ended by Postgres";

type Holder = { client: pg.PoolClient; granted: Promise<unknown>; timer?: NodeJS.Timeout; released?: boolean };
const holders = new WeakMap<object, Holder>();

// "never" and "late": a session of the test's own queues on the worker lock while the first worker still holds it.
// Postgres grants a waiter as soon as the holder's session ends, and a standby's pg_try_advisory_lock fails while one waits.
BeforeStep({ tags: "@pbi-157", ...long }, async function ({ pickleStep }) {
  const f = fault();
  if ((f !== "never" && f !== "late") || pickleStep.text !== LOSS_STEP) return;
  const client = await need().pool.connect();
  const pid = (await client.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid;
  const granted = client.query("select pg_advisory_lock($1)", [WORKER_LOCK_KEY]);
  granted.catch(() => {});
  holders.set(this, { client, granted });
  const end = Date.now() + 10_000;
  for (;;) {
    const r = await need().pool.query("select 1 from pg_locks where locktype = 'advisory' and not granted and pid = $1", [pid]);
    if (r.rowCount) break;
    assert.ok(Date.now() < end, "the test's session never queued on the worker lock");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
});

AfterStep({ tags: "@pbi-157", ...long }, async function ({ pickleStep }) {
  if (fault() !== "late" || pickleStep.text !== LOSS_STEP) return;
  const h = holders.get(this);
  if (!h) return;
  await h.granted;
  const lostAt = p157(this).stoppedAt ?? Date.now();
  h.timer = setTimeout(() => {
    h.released = true;
    void h.client.query("select pg_advisory_unlock($1)", [WORKER_LOCK_KEY]).catch(() => {});
  }, Math.max(lostAt + LATE_MS - Date.now(), 0));
});

After({ tags: "@pbi-157" }, async function () {
  const h = holders.get(this);
  if (!h) return;
  clearTimeout(h.timer);
  // Destroyed, not returned to the pool, so its session ends and gives the lock back.
  h.client.release(true);
});

// "first-keeps-working": the first worker's lock client swallows its own error and end, and answers queries once dead.
type Patched = { query: pg.Client["query"]; emit: pg.Client["emit"] };
let patched: Patched | undefined;

Before({ tags: "@pbi-157" }, function () {
  if (fault() !== "first-keeps-working") return;
  const world = this;
  const proto = pg.Client.prototype as unknown as Patched;
  patched = { query: proto.query, emit: proto.emit };
  const original = patched;
  const lockClients = new WeakSet<object>();
  const dead = new WeakSet<object>();
  const firstApp = () => p157(world).workers.find((w) => w.name === "first")?.app;
  proto.query = function (this: pg.Client, ...args: unknown[]) {
    const text = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string } | undefined)?.text ?? "";
    const app = (this as unknown as { connectionParameters?: { application_name?: string } }).connectionParameters?.application_name;
    if (app && app === firstApp() && text.includes("pg_try_advisory_lock")) lockClients.add(this);
    if (dead.has(this)) return Promise.resolve({ rows: [{ locked: false }], rowCount: 1 });
    return (original.query as (...a: unknown[]) => unknown).apply(this, args);
  } as pg.Client["query"];
  proto.emit = function (this: pg.Client, event: string | symbol, ...args: unknown[]) {
    if (lockClients.has(this) && (event === "error" || event === "end")) {
      dead.add(this);
      return true;
    }
    return (original.emit as (...a: unknown[]) => boolean).call(this, event, ...args);
  } as pg.Client["emit"];
});

After({ tags: "@pbi-157" }, function () {
  if (!patched) return;
  const proto = pg.Client.prototype as unknown as Patched;
  proto.query = patched.query;
  proto.emit = patched.emit;
  patched = undefined;
});
