// Step definitions for features/pbi-140-prepare-restart.feature. The @db scenarios share PBI 4's test database and
// reuse PBI 17's scheduler steps and PBI 89's control plane, through the hooks those files export. One clock, taken
// when the scenario starts, drives the scheduler, the leases and the cell API, so "N minutes ago" means the same to
// each. A cell's own actions, such as renewing or reporting a stopped attempt, go through the real cell API, so what
// the control plane does with them is what's tested. The other scenarios run the cell engine in a real temporary git
// repo against a recording cell API and a scripted agent, with the engine's 60-second renewal timer mocked, so a
// renewal can arrive while the agent is mid-stage.
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import { format } from "node:util";
import { fakeBacklog, fakeRepoHost } from "../../src/adapters/fake.ts";
import { LeaseLost } from "../../src/cell/api-client.ts";
import { runCell } from "../../src/cell/engine.ts";
import { cloneRun, shellGit } from "../../src/cell/git.ts";
import { loadSop, stageAfter } from "../../src/config/sop.ts";
import { cellApi, runToken } from "../../src/control/cell-api.ts";
import { startServer } from "../../src/http/server.ts";
import { parseCriteria, type Policy, type PolicyName } from "../../src/policy/policy.ts";
import { activeOverrides, clearRestartOnStart, setOverride } from "../../src/store/overrides.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";
import { ctx as p17, freshDb, newItem, tick } from "./pbi-17.steps.ts";
import { setUp, type Ctx as Pbi18 } from "./pbi-18.steps.ts";
import { CELL_SECRET, ctx as p89, headers, open, startControlPlane } from "./pbi-89.steps.ts";

const REPO = "ricksu978/software-factory";
const BRANCH = "factory/pbi-482-r1";
const WAIT = "FACTORY_RESTART_WAIT_MINUTES";
const SOP_TEXT = readFileSync(join(process.cwd(), "sop/default.yml"), "utf8");

type Answer = { status: number; body: Record<string, any> };
type Origin = { root: string; origin: string; branch: string; shas: Record<string, string> };
type Recorded = { route: string; body: Record<string, any> };

type Ctx = {
  clock: Date;
  logs: string[];
  restore: (() => void)[];
  /** When the restart override was prepared, on the scenario's clock. */
  preparedAt?: Date;
  renewals: { cell: string; answer: Answer }[];
  last?: Answer;
  /** What the lease said just before an operator's Resume, when a cell was running. */
  stopBeforeResume?: boolean;
  cellServer?: Server;
  origins: Map<string, Origin>;
  /** The scenario's step texts, so a step can tell what follows it. */
  steps: string[];
  engine?: Engine;
  greenRetries?: number;
};

/** A cell engine run of PBI 140's own: what the scripted agent does at green and what each renewal answers. */
type Engine = {
  c: Pbi18;
  mode: "uncommitted" | "commit" | "fail";
  /** The renewals' answers in order. The last one repeats, and none means carry on. */
  leases: ("stop" | "lost")[];
  /** A restart is being prepared, so a renewal with no scripted answer says stop. */
  restarting?: boolean;
  /** Each stage attempt the control plane holds, by "stage:attempt", across both cells of a scenario. */
  rows: Map<string, string>;
  calls: Recorded[];
  prompts: { stage: string; prompt: string }[];
  stage: string;
  written?: string;
  committed?: string;
  wip?: string;
  resume?: { stageId: string; attempt: number } | null;
  result?: string | null;
  error?: unknown;
  ran: boolean;
};

function ctx(world: object): Ctx {
  const w = world as { pbi140?: Ctx };
  w.pbi140 ??= { clock: new Date(), logs: [], restore: [], renewals: [], origins: new Map(), steps: [] };
  return w.pbi140;
}

const minutesFrom = (at: Date, n: number) => new Date(at.getTime() + n * 60_000);
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const unescape = (html: string) => html.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

Before({ tags: "@pbi-140" }, function ({ pickle }) {
  const c = ctx(this);
  c.steps = pickle.steps.map((s) => s.text);
  const originals = { log: console.log, warn: console.warn, error: console.error };
  for (const k of ["log", "warn", "error"] as const) {
    console[k] = (...args: unknown[]) => {
      c.logs.push(format(...args));
      originals[k](...args);
    };
  }
  c.restore.push(() => Object.assign(console, originals));
  const wait = process.env[WAIT];
  c.restore.push(() => (wait === undefined ? delete process.env[WAIT] : (process.env[WAIT] = wait)));
  p17(this).now = c.clock;
  // PBI 89's "the control plane starts" runs this, the part of a start that PBI 140 adds, instead of a child process.
  (this as { controlStart?: () => Promise<void> }).controlStart = () => clearRestartOnStart(need().pool);
});

Before({ tags: "@pbi-140 and @db", ...long }, async function () {
  await testDb();
  const pool = need().pool;
  await pool.query(`truncate item, "user", backlog_source, repo, webhook_delivery, override cascade`);
  // WIP 2, so a cell that doesn't start is held back by the restart, not by a full WIP limit.
  await pool.query("update wip_policy set mode = 'fixed', current_wip = 2, review_capacity = 3, usage_paused_until = null");
  await pool.query("insert into repo (host_adapter, url) values ('github', $1)", [`https://github.com/${REPO}`]);
  const s = p17(this);
  const host = fakeRepoHost();
  host.heads.set(REPO, "c0ffee0");
  s.backlog = fakeBacklog() as never;
  s.repoHost = host as never;
});

After({ tags: "@pbi-140", ...long }, async function () {
  const c = ctx(this);
  mock.timers.reset();
  for (const r of c.restore.reverse()) r();
  const control = p89(this);
  await control.close?.();
  for (const s of [control.server, c.cellServer]) {
    if (!s) continue;
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  for (const o of c.origins.values()) rmSync(o.root, { recursive: true, force: true });
});

// ---- the cell API, as a running cell reaches it ----

/** The control plane's cell API: PBI 89's server when it runs, otherwise one of the scenario's own on the same database. */
async function cellBase(world: object): Promise<string> {
  const control = p89(world);
  if (control.origin) return control.origin;
  const c = ctx(world);
  if (!c.cellServer) {
    const s = p17(world);
    const sop = loadSop(SOP_TEXT);
    c.cellServer = await startServer([cellApi({
      pool: need().pool, secret: CELL_SECRET, repoHost: s.repoHost as never, backlogFor: () => s.backlog!.adapter as never,
      stageAfter: (_version, stageId) => stageAfter(sop, stageId), uploadUrl: async (path) => `http://blob.test/${path}`,
      gateway: { upstream: "http://model.test", ownerToken: () => "unused" }, webToolsOf: () => [],
      now: () => s.now ?? new Date(),
    })], { port: 0 });
  }
  return `http://127.0.0.1:${(c.cellServer.address() as AddressInfo).port}`;
}

/** The run and generation of the cell with this execution name. Its run's repo is pinned, as the claim that started it did. */
async function cellRun(cell: string): Promise<{ runId: string; generation: number }> {
  const pool = need().pool;
  const r = await pool.query<{ run_id: string; generation: number }>(
    `select r.id as run_id, i.lease_generation as generation from run r join item i on i.id = r.item_id
     where r.execution_name = $1 order by r.started_at desc limit 1`, [cell]);
  assert.ok(r.rowCount, `no run has the cell ${cell}`);
  await pool.query(
    "update run set repo_id = coalesce(repo_id, (select id from repo order by url limit 1)), config_sha = coalesce(config_sha, 'c0ffee0') where id = $1",
    [r.rows[0].run_id]);
  return { runId: r.rows[0].run_id, generation: r.rows[0].generation };
}

async function call(world: object, run: { runId: string; generation: number }, method: "GET" | "POST", route: string, body?: unknown): Promise<Answer> {
  const res = await fetch(`${await cellBase(world)}/internal/cells/${run.runId}/${route}`, {
    method,
    headers: { authorization: `Bearer ${runToken(CELL_SECRET, run.runId, run.generation)}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Record<string, any> = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { text };
  }
  return { status: res.status, body: parsed };
}

async function cellCall(world: object, cell: string, method: "GET" | "POST", route: string, body?: unknown): Promise<Answer> {
  const run = await cellRun(cell);
  return call(world, run, method, route, body ?? (method === "POST" ? {} : undefined));
}

async function renew(world: object, cell: string): Promise<Answer> {
  const run = await cellRun(cell);
  const answer = await call(world, run, "POST", "lease", { generation: run.generation });
  ctx(world).renewals.push({ cell, answer });
  return answer;
}

/** A cell reports one of its attempts, as the engine's /stage does. A cell that is wrapping up reports its open attempt stopped. */
const report = (world: object, cell: string, stageId: string, attempt: number, status: string) =>
  cellCall(world, cell, "POST", "stage", { stageId, attempt, status, model: "claude-opus-5-5", tokensIn: 0, tokensOut: 0, costUsd: 0 });

// ---- overrides ----

async function operatorId(world: object): Promise<string | null> {
  const s = p17(world);
  if (s.operator) return s.operator;
  const login = p89(world).login;
  if (!login) return null;
  return (await need().pool.query<{ id: string }>(`select id from "user" where subject = $1`, [login])).rows[0]?.id ?? null;
}

async function prepare(world: object, reason: string, minutesAgo: number) {
  const c = ctx(world);
  const pool = need().pool;
  await setOverride(pool, { scope: "factory", targetId: null, kind: "restart", reason, createdBy: (await operatorId(world)) as string, expiresAt: null });
  c.preparedAt = minutesFrom(c.clock, -minutesAgo);
  await pool.query("update override set created_at = $1 where kind = 'restart' and cleared_at is null", [c.preparedAt]);
}

async function postOverride(world: object, form: Record<string, string>) {
  const control = p89(world);
  assert.ok(control.origin && control.login, "the control plane isn't running, or no one is signed in");
  const r = await fetch(`${control.origin}/overrides`, {
    method: "POST", redirect: "manual", body: new URLSearchParams(form).toString(),
    headers: { ...headers(control.login), origin: control.origin, "content-type": "application/x-www-form-urlencoded" },
  });
  control.status = r.status;
}

const restartRows = async () =>
  (await need().pool.query<{ cleared_at: Date | null; cleared_by: string | null; created_by: string | null; reason: string }>(
    "select cleared_at, cleared_by, created_by, reason from override where scope = 'factory' and kind = 'restart' order by created_at")).rows;

Given("a fresh factory database with WIP 2 and a review capacity of 3", long, async function () {
  await freshDb(this, 2);
});

Given("the control plane is running with a fake board and FACTORY_RESTART_WAIT_MINUTES unset", long, async function () {
  delete process.env[WAIT];
  await startControlPlane(this);
});

Given("FACTORY_RESTART_WAIT_MINUTES is {word}", function (setting: string) {
  if (setting === "unset") delete process.env[WAIT];
  else process.env[WAIT] = setting;
});

Given("an operator prepared a restart {int} minute(s) ago", long, async function (n: number) {
  await prepare(this, "scenario: restart", n);
});

Given("the operator prepared a restart {int} minute(s) ago", long, async function (n: number) {
  await prepare(this, "scenario: restart", n);
});

Given("an operator prepared a restart {int} minutes ago, and no cell is running", long, async function (n: number) {
  await prepare(this, "scenario: restart", n);
});

Given("an operator prepared a restart {int} hours ago, and no cell is running", long, async function (n: number) {
  await prepare(this, "scenario: restart", n * 60);
});

Given("an operator paused the factory with the reason {string}", long, async function (reason: string) {
  await setOverride(need().pool, { scope: "factory", targetId: null, kind: "pause", reason, createdBy: (await operatorId(this)) as string, expiresAt: null });
});

Given("no cell is running", long, async function () {
  // A cell is running while its item is InProgress under a lease that hasn't run out.
  const live = await need().pool.query("select id from item where state = 'InProgress' and lease_expires > $1", [ctx(this).clock]);
  assert.equal(live.rowCount, 0, `items ${live.rows.map((r) => r.id).join(", ")} have a cell running`);
});

When("an operator prepares a restart with the reason {string}", long, async function (reason: string) {
  await prepare(this, reason, 0);
});

When("the operator prepares a restart with the reason {string}", long, async function (reason: string) {
  await postOverride(this, { kind: "restart", reason });
});

When("the operator resumes the factory with the reason {string}", long, async function (reason: string) {
  // A running cell's renewal just before the Resume shows the restart was telling it to stop, so a carry-on after the
  // Resume is the Resume's doing.
  const running = await need().pool.query<{ execution_name: string }>(
    "select r.execution_name from item i join run r on r.item_id = i.id and r.ended_at is null where i.state = 'InProgress' and r.execution_name is not null limit 1");
  if (running.rowCount) {
    const run = await cellRun(running.rows[0].execution_name);
    const probe = await call(this, run, "POST", "lease", { generation: run.generation });
    ctx(this).stopBeforeResume = probe.status === 200 && probe.body.stop === true;
  }
  await postOverride(this, { kind: "resume", reason });
});

Then("the factory holds an active factory override {string} with the reason {string}", long, async function (kind: string, reason: string) {
  const active = (await activeOverrides(need().pool, new Date())).filter((o) => o.scope === "factory" && o.kind === kind);
  assert.deepEqual(active.map((o) => o.reason), [reason], `the factory's active ${kind} overrides`);
});

Then("the override records the operator who set it", long, async function () {
  const id = await operatorId(this);
  assert.ok(id, "no operator is signed in");
  const rows = (await restartRows()).filter((r) => r.cleared_at === null);
  assert.equal(rows.length, 1, "no active restart override");
  assert.equal(rows[0].created_by, id);
});

Then("the log records the factory override {string}", function (kind: string) {
  const logs = ctx(this).logs;
  assert.ok(logs.some((l) => /override/i.test(l) && l.includes(kind)), `no log line names the factory override "${kind}":\n${logs.join("\n")}`);
});

Then("the restart override left from before is cleared", long, async function () {
  const rows = await restartRows();
  assert.ok(rows.length > 0, "no restart override was ever set");
  assert.ok(rows.every((r) => r.cleared_at !== null), "a restart override from before is still active");
});

Then("the restart override is cleared, recording the operator who cleared it", long, async function () {
  const id = await operatorId(this);
  const rows = await restartRows();
  assert.ok(rows.length > 0, "no restart override was ever set");
  for (const r of rows) {
    assert.notEqual(r.cleared_at, null, "the restart override is still active");
    assert.equal(r.cleared_by, id, "the restart override doesn't record the operator who cleared it");
  }
});

Then("the pause is still active", long, async function () {
  const active = (await activeOverrides(need().pool, new Date())).filter((o) => o.scope === "factory" && o.kind === "pause");
  assert.equal(active.length, 1, "the pause isn't active");
});

// ---- the cell API ----

When("cell {string} renews its lease", long, async function (cell: string) {
  await renew(this, cell);
});

When("cell {string} asks for what it needs to push its branch", long, async function (cell: string) {
  ctx(this).last = await cellCall(this, cell, "POST", "github-token");
});

When("cell {string} reports that its green attempt stopped", long, async function (cell: string) {
  // The cell started its green attempt before the restart was prepared, as every attempt starts.
  await report(this, cell, "green", 1, "started");
  ctx(this).last = await report(this, cell, "green", 1, "stopped");
});

Given("cell {string} wrapped up and exited during the wrap-up", long, async function (cell: string) {
  // A cell that wraps up reports its open attempt stopped, then exits. The answer isn't judged here.
  await report(this, cell, "green", 1, "started");
  await report(this, cell, "green", 1, "stopped");
});

function lastRenewal(c: Ctx): Answer {
  const r = c.renewals.at(-1);
  assert.ok(r, "no cell renewed its lease");
  assert.equal(r.answer.status, 200, `the renewal wasn't answered: ${JSON.stringify(r.answer)}`);
  return r.answer;
}

Then("both renewals are answered and tell the cell to stop", function () {
  const rs = ctx(this).renewals.slice(-2);
  assert.equal(rs.length, 2, "two cells didn't renew");
  for (const r of rs) {
    assert.equal(r.answer.status, 200, `${r.cell}'s renewal wasn't answered`);
    assert.equal(r.answer.body.stop, true, `${r.cell}'s renewal didn't tell it to stop`);
  }
});

Then("the renewal tells the cell to carry on", function () {
  const c = ctx(this);
  if (c.stopBeforeResume !== undefined) assert.equal(c.stopBeforeResume, true, "the restart never told the cell to stop, so carrying on after Resume proves nothing");
  assert.equal(lastRenewal(c).body.stop, false);
});

Then("the renewal tells the cell to stop", function () {
  assert.equal(lastRenewal(ctx(this)).body.stop, true, "the renewal didn't tell the cell to stop");
});

Then("the cell API answers the renewal and tells the cell to stop", function () {
  assert.equal(lastRenewal(ctx(this)).body.stop, true, "the renewal didn't tell the cell to stop");
});

Then("the cell API answers it", function () {
  const a = ctx(this).last;
  assert.equal(a?.status, 200, `the cell API answered ${JSON.stringify(a)}`);
});

Then("the cell API accepts the report", function () {
  const a = ctx(this).last;
  assert.equal(a?.status, 200, `the cell API answered ${JSON.stringify(a)}`);
});

Then("item {string}'s run records that green attempt as stopped", long, async function (name: string) {
  assert.equal(await attemptStatus(p17(this).items[name], "green", 1), "stopped");
});

Then("cell {string}'s next renewal tells it to stop", long, async function (cell: string) {
  const a = await renew(this, cell);
  assert.equal(a.status, 200, `the renewal wasn't answered: ${JSON.stringify(a)}`);
  assert.equal(a.body.stop, true, "the renewal didn't tell the cell to stop");
});

async function attemptStatus(itemId: string, stageId: string, attempt: number): Promise<string | undefined> {
  return (await need().pool.query<{ status: string }>(
    "select s.status from stage_run s join run r on r.id = s.run_id where r.item_id = $1 and s.stage_id = $2 and s.attempt = $3",
    [itemId, stageId, attempt])).rows[0]?.status;
}

// ---- the scheduler ----

When("{int} minutes have passed since the restart was prepared and the scheduler ticks", long, async function (n: number) {
  const c = ctx(this);
  assert.ok(c.preparedAt, "no restart was prepared");
  const s = p17(this);
  s.now = minutesFrom(c.preparedAt, n);
  await tick(s);
});

Given("the launcher fails to stop cell {string}", function (cell: string) {
  const s = p17(this);
  (s.failStop ??= new Set()).add(cell);
});

function ticked(world: object) {
  const s = p17(world);
  assert.ok(s.ticked, "the scheduler never ticked");
  return s;
}

Then("no cell is stopped", function () {
  assert.deepEqual(ticked(this).stopped, []);
});

Then("cells {string} and {string} are stopped with the launcher's stop", function (a: string, b: string) {
  assert.deepEqual([...ticked(this).stopped].sort(), [a, b].sort());
});

Then("cell {string} is stopped with the launcher's stop", function (cell: string) {
  assert.ok(ticked(this).stopped.includes(cell), `${cell} wasn't stopped; stopped: ${JSON.stringify(p17(this).stopped)}`);
});

Then("cell {string} is not stopped", function (cell: string) {
  assert.ok(!ticked(this).stopped.includes(cell), `${cell} was stopped`);
});

Then("the log records that stopping cell {string} failed", function (cell: string) {
  const logs = ctx(this).logs;
  assert.ok(logs.some((l) => l.includes(cell) && /fail/i.test(l)), `no log line says stopping ${cell} failed:\n${logs.join("\n")}`);
});

// ---- Floor and Run detail ----

When("the operator opens Floor", long, async function () {
  await open(p89(this), "/");
});

When("the operator opens item {string}'s Run detail", long, async function (name: string) {
  await open(p89(this), `/items/${p17(this).items[name]}`);
});

function floorHtml(world: object): string {
  const control = p89(world);
  assert.equal(control.status, 200, "Floor didn't open");
  return control.html!;
}

Then("the Controls offer Prepare restart beside Pause, Drain, Resume and the kill switch", function () {
  const html = floorHtml(this);
  const at = html.indexOf("<h2>Controls</h2>");
  assert.ok(at >= 0, "Floor has no Controls");
  const form = html.slice(at, html.indexOf("</form>", at));
  for (const kind of ["pause", "drain", "resume", "kill"]) assert.ok(form.includes(`value="${kind}"`), `the Controls lack ${kind}`);
  assert.match(form, /<button name="kind" value="restart">Prepare restart<\/button>/, "the Controls don't offer Prepare restart");
});

Then("Floor shows {string} with {int} minutes left in the wrap-up", function (text: string, n: number) {
  const html = unescape(floorHtml(this));
  const line = html.split(/<\/p>|\n/).find((l) => l.includes(text));
  assert.ok(line, `Floor doesn't show "${text}"`);
  assert.match(line, new RegExp(`\\b${n} minutes?\\b`), `"${text}" doesn't say ${n} minutes are left: ${line}`);
});

Then("Floor shows {string}", function (text: string) {
  assert.ok(unescape(floorHtml(this)).includes(text), `Floor doesn't show "${text}"`);
});

Then("Floor doesn't show {string}", long, async function (text: string) {
  // Opened afresh, since a scenario can reach this step straight after a POST, with no Floor page to read yet.
  await open(p89(this), "/");
  assert.ok(!unescape(floorHtml(this)).includes(text), `Floor shows "${text}"`);
});

const stageRows = (html: string) => [...html.matchAll(/<tr><td>([^<]*)<\/td><td>(\d+)<\/td><td>([^<]*)<\/td>/g)].map((m) => ({ stage: m[1], attempt: Number(m[2]), status: m[3] }));

Then("green's attempt {int} shows as stopped", function (attempt: number) {
  const control = p89(this);
  assert.equal(control.status, 200, "Run detail didn't open");
  const row = stageRows(control.html!).find((r) => r.stage === "green" && r.attempt === attempt);
  assert.ok(row, `Run detail has no green attempt ${attempt}`);
  assert.equal(row.status, "stopped");
});

Then("no green attempt shows as failed", function () {
  const rows = stageRows(p89(this).html!).filter((r) => r.stage === "green" && r.status === "failed");
  assert.deepEqual(rows, []);
});

// ---- items a restart stopped, and the factory after it ----

/** A bare origin with main and the run's branch, which holds one commit per name, in order. */
function makeOrigin(c: Ctx, name: string, branch: string, commits: string[]): Origin {
  const root = mkdtempSync(join(tmpdir(), "pbi140-"));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "init", "-q", "-b", "main", seed);
  git(seed, "config", "user.email", "seed@example.com");
  git(seed, "config", "user.name", "seed");
  writeFileSync(join(seed, "app.txt"), "foo\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "init");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", "main");
  git(seed, "checkout", "-q", "-b", branch);
  const shas: Record<string, string> = {};
  for (const commit of commits) {
    writeFileSync(join(seed, "app.txt"), `${commit}\n`);
    git(seed, "commit", "-q", "-am", commit === "wip" ? "work in progress, stopped" : `${commit}(@pbi-${name})`);
    shas[commit] = git(seed, "rev-parse", "HEAD");
  }
  git(seed, "push", "-q", "origin", branch);
  const o = { root, origin, branch, shas };
  c.origins.set(name, o);
  return o;
}

const STAGES = ["understand", "specify", "red", "green", "self-review"];

/** Item `name` running in `cell` at `stage`, with a live lease, its earlier stages passed and `stage`'s attempt 1 open. */
async function runningAt(world: object, name: string, cell: string, stage: string, commits: string[]): Promise<void> {
  const c = ctx(world);
  const s = p17(world);
  const pool = need().pool;
  const branch = `factory/pbi-${name}-r1`;
  makeOrigin(c, name, branch, commits);
  const id = await newItem(s, name, "InProgress", { owner: cell, expires: minutesFrom(c.clock, 4) });
  const run = (await pool.query<{ id: string }>(
    `insert into run (item_id, next_stage, execution_name, branch, repo_id, config_sha, sop_version)
     values ($1, $2, $3, $4, (select id from repo order by url limit 1), 'c0ffee0', '0.1.0') returning id`,
    [id, stage, cell, branch])).rows[0].id;
  for (const earlier of STAGES.slice(0, STAGES.indexOf(stage))) {
    await pool.query("insert into stage_run (run_id, stage_id, attempt, status) values ($1, $2, 1, 'passed')", [run, earlier]);
  }
  await pool.query("insert into stage_run (run_id, stage_id, attempt, status) values ($1, $2, 1, 'started')", [run, stage]);
}

const pushedFor: Record<string, string[]> = { red: ["red-wip", "wip"], green: ["red", "wip"], "self-review": ["red", "green", "wip"] };

Given("item {string} was at {word} in cell {string} when the wrap-up stopped it, and the cell pushed its work in progress", long,
  async function (name: string, stage: string, cell: string) {
    await runningAt(this, name, cell, stage, pushedFor[stage]);
    await prepare(this, "scenario: restart", 5);
    // The cell pushed its work in progress, then reported its open attempt stopped, and exited.
    await report(this, cell, stage, 1, "stopped");
    ctx(this).origins.get(name)!.shas.expected = ctx(this).origins.get(name)!.shas.wip;
  });

Given("item {string} was at green in cell {string} when the restart was prepared", long, async function (name: string, cell: string) {
  await runningAt(this, name, cell, "green", ["red", "green"]);
  await prepare(this, "scenario: restart", 5);
});

Given("cell {string} reported green passed and pushed before it stopped", long, async function (cell: string) {
  // Green's commit is on the branch already. The cell passed green, started self-review, and was stopped in it.
  await report(this, cell, "green", 1, "passed");
  await report(this, cell, "self-review", 1, "started");
  await report(this, cell, "self-review", 1, "stopped");
});

Given("item {string} was at green in cell {string}, and its last pushed commit is red's", long, async function (name: string, cell: string) {
  const o = (await runningAt(this, name, cell, "green", ["red"]), ctx(this).origins.get(name)!);
  o.shas.expected = o.shas.red;
});

Given("item {string} was at green in cell {string}, and its last pushed commit is a work-in-progress commit", long, async function (name: string, cell: string) {
  const o = (await runningAt(this, name, cell, "green", ["red", "wip"]), ctx(this).origins.get(name)!);
  o.shas.expected = o.shas.wip;
});

Then("item {string}'s open green attempt is recorded as stopped", long, async function (name: string) {
  assert.equal(await attemptStatus(p17(this).items[name], "green", 1), "stopped");
});

When("the factory restarts and a cell starts for item {string}", long, async function (_name: string) {
  // The restart: the control plane starts, and a minute later, inside the stopped cells' last leases, its scheduler ticks.
  await clearRestartOnStart(need().pool);
  const s = p17(this);
  s.now = minutesFrom(ctx(this).clock, 1);
  await tick(s);
});

/** The env of the cell the restarted factory started for the item. */
function startedFor(world: object, name: string): Record<string, string> {
  const s = ticked(world);
  const env = s.started.find((e) => e.ITEM_ID === s.items[name]);
  assert.ok(env, `no cell started for item ${name}`);
  return env;
}

async function newCellContext(world: object, name: string): Promise<Record<string, any>> {
  const env = startedFor(world, name);
  const a = await call(world, { runId: env.RUN_ID, generation: Number(env.GENERATION) }, "GET", "context");
  assert.equal(a.status, 200, `the new cell's context: ${JSON.stringify(a)}`);
  return a.body;
}

Then("item {string}'s run resumes at {word}", long, async function (name: string, stage: string) {
  const env = startedFor(this, name);
  assert.equal(env.RESUME_FROM, stage);
  const context = await newCellContext(this, name);
  assert.equal(context.nextStage, stage);
  assert.equal(context.resume?.stageId, stage, `the new cell isn't told it resumes ${stage}'s stopped attempt: ${JSON.stringify(context.resume)}`);
});

Then("green's attempt is recorded as passed", long, async function () {
  assert.equal(await attemptStatus(p17(this).items.A, "green", 1), "passed");
});

async function checkoutAt(world: object, name: string, sha: string) {
  const o = ctx(world).origins.get(name)!;
  const context = await newCellContext(world, name);
  const dir = join(o.root, `cell-${Date.now()}`);
  await cloneRun(o.origin, context.branch, context.base, dir, "!true");
  assert.equal(git(dir, "rev-parse", "HEAD"), sha, `the new cell's checkout of ${context.branch} isn't at the pushed commit`);
}

Then("the new cell's checkout of the run's branch is at the work-in-progress commit the stopped cell pushed", long, async function () {
  await checkoutAt(this, "A", ctx(this).origins.get("A")!.shas.wip);
});

Then("the new cell's checkout of the run's branch is at red's commit", long, async function () {
  await checkoutAt(this, "A", ctx(this).origins.get("A")!.shas.red);
});

Then("the new cell's checkout of the run's branch is at that work-in-progress commit", long, async function () {
  await checkoutAt(this, "A", ctx(this).origins.get("A")!.shas.wip);
});

Given("item {string}'s green attempt 1 was stopped by a restart", long, async function (name: string) {
  const cell = `cell-${name.toLowerCase()}`;
  await runningAt(this, name, cell, "green", ["red", "wip"]);
  await prepare(this, "scenario: restart", 5);
  await report(this, cell, "green", 1, "stopped");
});

// ---- the cell engine ----

function engine(world: object): Engine {
  const e = ctx(world).engine;
  assert.ok(e, "no run was set up");
  return e;
}

function newEngine(world: object, mode: Engine["mode"]): Engine {
  const c = setUp(world, "green", true);
  const e: Engine = { c, mode, leases: [], rows: new Map(), calls: [], prompts: [], stage: "", ran: false };
  ctx(world).engine = e;
  return e;
}

function policy(name: PolicyName, text: string): Policy {
  return { name, source: "repo", sha: name, text, criteria: name === "scenarios" || name === "risk" ? [] : parseCriteria(text) };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
};

/** Runs one cell over the scenario's checkout, as the control plane's context describes the run. */
async function runEngine(world: object): Promise<void> {
  const e = engine(world);
  const c = e.c;
  const attempts: Record<string, number> = {};
  for (const key of e.rows.keys()) {
    const [stage, n] = key.split(":");
    attempts[stage] = Math.max(attempts[stage] ?? 0, Number(n));
  }
  let leaseCalls = 0;
  const api = {
    async lease() {
      e.calls.push({ route: "/lease", body: {} });
      const answer = e.leases.length ? e.leases[Math.min(leaseCalls++, e.leases.length - 1)] : e.restarting ? "stop" : null;
      if (answer === "lost") throw new LeaseLost("the lease generation moved on");
      return { stop: answer === "stop" };
    },
    async stage(b: Record<string, any>) {
      e.calls.push({ route: "/stage", body: b });
      e.rows.set(`${b.stageId}:${b.attempt}`, b.status);
      if (b.status === "started") e.stage = b.stageId;
    },
    async transition(b: Record<string, any>) { e.calls.push({ route: "/transition", body: b }); },
    async policyResults(b: Record<string, any>) { e.calls.push({ route: "/policy-results", body: b }); },
    async pr(b: Record<string, any>) { e.calls.push({ route: "/pr", body: b }); },
    async checks() { return { status: "success", failedChecks: [] }; },
    async upload() {},
  };
  const agent = async (a: { prompt: string; cwd: string; model: string }) => {
    e.prompts.push({ stage: e.stage, prompt: a.prompt });
    if (e.stage === "green" && e.mode !== "fail") {
      e.written = `work in progress ${e.prompts.length}\n`;
      writeFileSync(join(a.cwd, "app.txt"), e.written);
      if (e.mode === "commit") {
        git(a.cwd, "commit", "-q", "-am", "green: part of the implementation");
        e.committed = git(a.cwd, "rev-parse", "HEAD");
      }
      // The next renewal arrives while the agent is mid-stage.
      if (e.leases.length || e.restarting) {
        mock.timers.tick(60_000);
        await flush();
      }
    }
    return { ok: true, text: "done", costUsd: 0.5, tokensIn: 10, tokensOut: 5, model: a.model, limit: null, usage: null, transcript: "{}\n" };
  };
  const sop = loadSop(SOP_TEXT);
  const greenRetries = ctx(world).greenRetries;
  if (greenRetries !== undefined) for (const s of sop.stages) if (s.id === "green") (s as { retries?: unknown }).retries = greenRetries;
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    e.result = await runCell({
      api: api as never,
      ctx: {
        externalId: "482", title: "Item 482", acceptanceCriteria: ["Criterion 1 holds", "Criterion 2 holds", "Criterion 3 holds"],
        nextStage: "green", decision: null, lockSha: c.lockSha, lockedFiles: c.lockedFiles, prNumber: null,
        repo: "acme/app", base: "main", branch: BRANCH, configSha: "c0ffee", sopVersion: "0.1.0",
        dodVerdicts: [], dodCheckedSha: null, trustedComments: [], stageAttempts: attempts, resume: e.resume ?? null,
      },
      agent: agent as never,
      git: shellGit(c.dir, BRANCH),
      dir: c.dir,
      repoHost: {} as never,
      sop,
      config: { sensitivePaths: [], reviewers: ["owner"], webTools: [],
        bdd: { parse: "true", run: "true", report: "reports/bdd.ndjson" }, commands: { test: e.mode === "fail" ? "false" : "true", lint: "true" } } as never,
      policies: { scenarios: policy("scenarios", "Write in business language.\n"), prReview: policy("pr-review", "- [ ] Code is readable.\n"),
        risk: policy("risk", "Low by default.\n"), dod: policy("dod", "- [ ] Typecheck passes. `run: true`\n") },
      now: () => new Date(),
      sleep: async () => {},
    });
    e.error = null;
  } catch (err) {
    e.error = err;
  } finally {
    mock.timers.reset();
  }
  e.ran = true;
}

const pushed = (e: Engine) => git(e.c.root, "--git-dir", e.c.origin, "rev-parse", BRANCH);
const onBranch = (e: Engine, sha: string) => {
  try {
    execFileSync("git", ["--git-dir", e.c.origin, "merge-base", "--is-ancestor", sha, BRANCH], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
function finished(world: object): Engine {
  const e = engine(world);
  assert.ok(e.ran, "the cell never ran");
  return e;
}

Given("a run for item {int} that is at green with uncommitted changes", function (_item: number) {
  newEngine(this, "uncommitted");
});

Given("a run for item {int} that is at green with a commit it hasn't pushed and no uncommitted changes", function (_item: number) {
  newEngine(this, "commit");
});

Given("a run for item {int} that is at green's first attempt", function (_item: number) {
  newEngine(this, "uncommitted");
});

Given("the factory is preparing to restart", function () {
  // The cell learns of it only through its lease renewals: from now on each one says stop, unless a later step
  // scripts another answer, such as a lost lease, which the control plane's 409 gives ahead of the stop.
  const e = engine(this);
  assert.equal(e.ran, false, "the cell already ran");
  e.restarting = true;
});

// A Given in one scenario and the When in others. It runs the cell unless a later step scripts another renewal first.
Given("the cell's lease renewal tells it to stop for a restart", long, async function () {
  const e = engine(this);
  e.leases.push("stop");
  if (!ctx(this).steps.includes("the cell checks its lease before pushing and finds it lost")) await runEngine(this);
});

When("the cell's lease renewal says its lease was lost", long, async function () {
  engine(this).leases.push("lost");
  await runEngine(this);
});

When("the cell checks its lease before pushing and finds it lost", long, async function () {
  engine(this).leases.push("lost");
  await runEngine(this);
});

Then("the cell commits its changes as work in progress", function () {
  const e = finished(this);
  assert.equal(e.error, null, `the cell failed: ${String(e.error)}`);
  assert.match(git(e.c.dir, "log", "-1", "--format=%s"), /work in progress/i);
  assert.equal(git(e.c.dir, "show", "HEAD:app.txt") + "\n", e.written);
  assert.equal(git(e.c.dir, "status", "--porcelain", "--untracked-files=no"), "", "changes are left uncommitted");
});

Then("the cell pushes that commit to the run's branch before it exits", function () {
  const e = finished(this);
  assert.equal(pushed(e), git(e.c.dir, "rev-parse", "HEAD"), "the work-in-progress commit isn't on the run's branch");
});

Then("the run's branch holds that commit before the cell exits", function () {
  const e = finished(this);
  assert.ok(e.committed, "the agent made no commit");
  assert.ok(onBranch(e, e.committed), "the run's branch doesn't hold the cell's commit");
});

Then("the cell exits as stopped", function () {
  const e = finished(this);
  assert.equal(e.error, null, `the cell failed: ${String(e.error)}`);
  assert.equal(e.result, "stopped");
});

Then("the cell pushes nothing", function () {
  const e = finished(this);
  assert.equal(pushed(e), e.c.lockSha, "the cell pushed");
});

const greenReports = (e: Engine, status: string) => e.calls.filter((x) => x.route === "/stage" && x.body.stageId === "green" && x.body.status === status);

Then("the cell reports green's first attempt as stopped", function () {
  const e = finished(this);
  assert.deepEqual(greenReports(e, "stopped").map((x) => x.body.attempt), [1], "the cell didn't report green's attempt 1 as stopped");
});

Then("the cell reports no green attempt as failed", function () {
  assert.deepEqual(greenReports(finished(this), "failed").map((x) => x.body.attempt), []);
});

Given("a run for item {int} that resumes at green after a restart, on a branch holding a work-in-progress commit", function (_item: number) {
  // PBI 18's "the cell runs" runs this one, with the context a resumed run gets.
  const c = setUp(this, "green", true);
  writeFileSync(join(c.dir, "app.txt"), "work in progress from the stopped cell\n");
  git(c.dir, "commit", "-q", "-am", "work in progress, stopped");
  git(c.dir, "push", "-q", "origin", `HEAD:refs/heads/${BRANCH}`);
  const wip = git(c.dir, "rev-parse", "HEAD");
  c.context = { stageAttempts: { green: 1 }, resume: { stageId: "green", attempt: 1 } };
  (c as Pbi18 & { wip?: string }).wip = wip;
});

Then("green's brief tells the agent its earlier work is already on the branch and to carry on from it", function () {
  const c = (this as { pbi18?: Pbi18 }).pbi18!;
  assert.equal(c.error, null, `the cell failed: ${String(c.error)}`);
  const briefs = c.agentCalls.filter((a) => a.stage === "green");
  assert.ok(briefs.length > 0, "green never ran");
  for (const b of briefs) {
    assert.match(b.prompt, /already on the branch/i, "green's brief doesn't say the earlier work is already on the branch");
    assert.match(b.prompt, /carry on/i, "green's brief doesn't tell the agent to carry on from it");
  }
});

Then("the cell doesn't reset or discard the work-in-progress commit", function () {
  const c = (this as { pbi18?: Pbi18 }).pbi18! as Pbi18 & { wip: string };
  const ancestor = (args: string[]) => {
    try {
      execFileSync("git", args, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  assert.ok(ancestor(["-C", c.dir, "merge-base", "--is-ancestor", c.wip, "HEAD"]), "the cell's checkout lost the work-in-progress commit");
  assert.ok(ancestor(["--git-dir", c.origin, "merge-base", "--is-ancestor", c.wip, BRANCH]), "the run's branch lost the work-in-progress commit");
});

Given("green allows {int} retry", function (n: number) {
  ctx(this).greenRetries = n;
});

Given("a run for item {int} whose green attempt 1 was stopped by a restart", long, async function (_item: number) {
  // The first cell: a restart's renewal stops it in green's attempt 1. What it reports is judged later, not here.
  const e = newEngine(this, "uncommitted");
  e.leases = ["stop"];
  await runEngine(this);
});

When("the run resumes at green and every green attempt fails", long, async function () {
  // The second cell, after the restart, with the attempts the control plane holds and no renewal telling it to stop.
  const e = engine(this);
  e.mode = "fail";
  e.leases = [];
  e.calls = [];
  e.resume = { stageId: "green", attempt: 1 };
  await runEngine(this);
});

Then("the cell makes {int} green attempts after the stopped one before it reports green's retries used up", function (n: number) {
  const e = finished(this);
  assert.equal(e.error, null, `the cell failed: ${String(e.error)}`);
  assert.deepEqual(greenReports(e, "started").map((x) => x.body.attempt), Array.from({ length: n }, (_, i) => i + 2));
  assert.equal(e.calls.filter((x) => x.route === "/transition").at(-1)?.body.event, "retries_exhausted");
});

Then("green's attempt {int} is still recorded as stopped", function (attempt: number) {
  assert.equal(finished(this).rows.get(`green:${attempt}`), "stopped");
});
