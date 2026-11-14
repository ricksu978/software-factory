// Step definitions for features/pbi-215-base-fails-dod.feature.
//
// The cell scenarios run PBI 18's engine harness: a real temporary git repo cloned from a bare origin, a recording cell
// API, a scripted agent and a fake repo host. A Definition of Done line's command, such as `npm test`, reaches a fake
// `npm` this file puts first on PATH. The fake reads the commit it runs on with `git rev-parse HEAD`, in whatever
// directory the cell runs it, logs each run, and fails the tests the scenario names for that commit, printing TAP:
// one `not ok <n> - <test name>` line per failing test, exit 1 when any fails. A run on the commit "origin/<base>" was
// at when the scenario began counts as a run on the base commit. Anything else counts as a run on the item's branch,
// numbered per command, so "on the first attempt only" fails only the first such run.
//
// The question the cell asks is the last transition's `question.body`. The steps read it as follows:
// - it "says the base fails in the cell" when it holds the words "base fails in the cell";
// - it names a base commit when it holds the commit's first 7 characters, and a test when it holds the test's name.
//
// The @db scenarios serve the real dashboard on PBI 4's test database, as PBI 175's steps do, and put an item in
// NeedsInput through the real cell API's /transition route. A base-failure question carries, beside its body,
// `baseFailure: { sha, tests }`: the base commit and the tests that fail on it, which the Floor shows. The Floor's base
// failure notice is the element with id="base-fails", and it says "base fails in cells".
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { delimiter, join } from "node:path";
import { fakeBacklog, fakeRepoHost } from "../../src/adapters/fake.ts";
import { cellApi, runToken } from "../../src/control/cell-api.ts";
import { decide } from "../../src/control/decisions.ts";
import { next, type ItemEvent } from "../../src/core/states.ts";
import { startServer } from "../../src/http/server.ts";
import { withTx } from "../../src/store/db.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";
import { setUp, type Ctx as CellCtx } from "./pbi-18.steps.ts";
import { ctx as dashCtx, dashboard, escapeRe, get, text } from "./pbi-175.steps.ts";

const BRANCH = "factory/pbi-482-r1";

type Plan = {
  baseSha: string | null;
  /** Per command: the tests that fail on the item's branch, and whether only on its first run there. */
  branch: Record<string, { fails: string[]; firstOnly: boolean }>;
  /** Per command: the tests that fail on the base commit. A command not named passes there. */
  base: Record<string, string[]>;
};
type NpmRun = { cmd: string; head: string; cwd: string; onBase: boolean; fails: string[] };
type AgentSeen = { stage: string; head: string; branch: string; judge: boolean; npmRuns: number };
type Ctx = {
  labels: Map<string, string>;
  plan: Plan;
  planFile: string;
  logFile: string;
  agentSeen: AgentSeen[];
};

function cell(world: object): CellCtx {
  const w = world as { pbi18?: CellCtx };
  assert.ok(w.pbi18, "no run was set up");
  return w.pbi18;
}

function mine(world: object): Ctx {
  const w = world as { pbi215?: Ctx };
  assert.ok(w.pbi215, "no run was set up");
  return w.pbi215;
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const quoted = (s: string) => [...s.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const runOf = (line: string) => /`run:\s*([^`]+)`/.exec(line)?.[1].trim() ?? null;

// The fake npm, in CommonJS so node runs it from a directory with no package.json. The paths are written in, since a
// DoD command sees only PATH, HOME and CI (Run contract 11).
function fakeNpm(planFile: string, logFile: string): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const PLAN = ${JSON.stringify(planFile)};
const LOG = ${JSON.stringify(logFile)};
const cmd = ["npm", ...process.argv.slice(2)].join(" ");
let head = "";
try { head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch {}
const plan = fs.existsSync(PLAN) ? JSON.parse(fs.readFileSync(PLAN, "utf8")) : { baseSha: null, branch: {}, base: {} };
const log = fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").split("\\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const onBase = head !== "" && head === plan.baseSha;
let fails = [];
if (onBase) fails = plan.base[cmd] || [];
else {
  const s = plan.branch[cmd];
  const before = log.filter((e) => e.cmd === cmd && !e.onBase).length;
  if (s) fails = s.firstOnly && before > 0 ? [] : s.fails;
}
fs.appendFileSync(LOG, JSON.stringify({ cmd, head, cwd: process.cwd(), onBase, fails }) + "\\n");
console.log("TAP version 13");
fails.forEach((t, i) => console.log("not ok " + (i + 1) + " - " + t));
console.log("ok " + (fails.length + 1) + " - every other test");
console.log("1.." + (fails.length + 1));
console.log("# fail " + fails.length);
process.exit(fails.length ? 1 : 0);
`;
}

/** The outcome a table cell or a step gives a command on the item's branch. */
function branchSpec(text: string): { fails: string[]; firstOnly: boolean } {
  if (/^passes$/.test(text.trim())) return { fails: [], firstOnly: false };
  const m = /^fails the tests? (.+?)( on every attempt| on the first attempt only)?$/.exec(text.trim());
  assert.ok(m, `can't read "${text}"`);
  return { fails: quoted(m[1]), firstOnly: m[2] === " on the first attempt only" };
}

// The plan joins what the steps said with the DoD table's "on the item's branch" column, which PBI 18's step keeps.
function writePlan(world: object): void {
  const c = cell(world);
  const m = mine(world);
  const plan: Plan = { baseSha: m.plan.baseSha, branch: { ...m.plan.branch }, base: { ...m.plan.base } };
  for (const r of c.dodRows ?? []) {
    const cmd = runOf(r.line);
    const said = r["on the item's branch"];
    if (cmd && said !== undefined && !(cmd in m.plan.branch)) plan.branch[cmd] = branchSpec(said);
  }
  writeFileSync(m.planFile, JSON.stringify(plan));
}

/** The DoD's one run: command, which "the command" names. */
function theCommand(world: object): string {
  const cmds = cell(world).dod.split("\n").map(runOf).filter((x): x is string => x !== null);
  assert.equal(cmds.length, 1, `"the command" is ambiguous: the Definition of Done runs ${JSON.stringify(cmds)}`);
  return cmds[0];
}

function npmRuns(world: object): NpmRun[] {
  const f = mine(world).logFile;
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as NpmRun) : [];
}

function sha(world: object, label: string): string {
  const s = mine(world).labels.get(label);
  assert.ok(s, `no commit is labelled "${label}"`);
  return s;
}

function prepare(world: object, nextStage: string, base: string): void {
  assert.equal(base, "main", "PBI 18's harness builds every run on main");
  const c = setUp(world, nextStage, true);
  const bin = join(c.root, "bin");
  mkdirSync(bin);
  const m: Ctx = { labels: new Map(), plan: { baseSha: null, branch: {}, base: {} }, planFile: join(c.root, "npm-plan.json"), logFile: join(c.root, "npm-log.jsonl"), agentSeen: [] };
  (world as { pbi215?: Ctx }).pbi215 = m;
  writeFileSync(join(bin, "npm"), fakeNpm(m.planFile, m.logFile));
  chmodSync(join(bin, "npm"), 0o755);
  // PBI 18's After puts PATH back.
  c.secrets = { ...(c.secrets ?? {}), PATH: process.env.PATH };
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
  // Every agent call sees where the checkout stands, and the plan is written before any command runs.
  c.agent = async (a, baseAgent) => {
    writePlan(world);
    let head = "";
    let branch = "";
    try { head = git(a.cwd, "rev-parse", "HEAD"); } catch {}
    try { branch = git(a.cwd, "rev-parse", "--abbrev-ref", "HEAD"); } catch {}
    m.agentSeen.push({ stage: c.stage, head, branch, judge: String(a.prompt).startsWith("# Definition of Done"), npmRuns: npmRuns(world).length });
    return baseAgent(a);
  };
  writePlan(world);
}

// ---- the cell's Givens ----

Given("a run for item {int} on base {string} whose scenarios were signed off", function (_item: number, base: string) {
  prepare(this, "red", base);
});

Given("an item {int} in review on base {string} whose run resumes at address", function (_item: number, base: string) {
  prepare(this, "address", base);
});

Given("{string} is at commit {string}", function (ref: string, label: string) {
  const c = cell(this);
  const m = mine(this);
  const s = git(c.dir, "rev-parse", ref);
  m.labels.set(label, s);
  m.plan.baseSha = s;
  writePlan(this);
});

Given(/^on the item's branch the command (fails the tests? .+)$/, function (said: string) {
  mine(this).plan.branch[theCommand(this)] = branchSpec(said);
  writePlan(this);
});

Given(/^on commit "([^"]+)" the command (passes|fails the tests? .+)$/, function (label: string, said: string) {
  sha(this, label);
  mine(this).plan.base[theCommand(this)] = said === "passes" ? [] : quoted(said);
  writePlan(this);
});

Given(/^CI passes on (?:the|every) pushed fix$/, function () {
  cell(this).checks = async () => "success";
});

// ---- the cell's Thens ----

function settled(c: CellCtx): void {
  assert.equal(c.error, null, `the cell failed: ${c.error instanceof Error ? c.error.stack : String(c.error)}`);
}

function started(c: CellCtx, stage: string): number {
  settled(c);
  return c.calls.filter((x) => x.route === "/stage" && x.body.status === "started" && x.body.stageId === stage).length;
}

function questions(c: CellCtx): string[] {
  settled(c);
  return c.calls.filter((x) => x.route === "/transition" && x.body.question).map((x) => String(x.body.question.body ?? ""));
}

function theQuestion(c: CellCtx): string {
  const t = c.calls.filter((x) => x.route === "/transition").at(-1);
  settled(c);
  assert.ok(t, "the cell sent no transition");
  assert.ok(t.body.question, `the last transition, ${t.body.event}, asks no question`);
  return String(t.body.question.body ?? "");
}

const SAYS_BASE = /base fails in the cell/i;

Then("the cell ran {string} on commit {string}", function (cmd: string, label: string) {
  const s = sha(this, label);
  settled(cell(this));
  const runs = npmRuns(this);
  assert.ok(runs.some((r) => r.cmd === cmd && r.head === s), `"${cmd}" never ran on ${label} (${s.slice(0, 7)}); it ran on: ${JSON.stringify(runs.map((r) => [r.cmd, r.head.slice(0, 7)]))}`);
});

Then("the cell ran {string} on commit {string} exactly once", function (cmd: string, label: string) {
  const s = sha(this, label);
  settled(cell(this));
  assert.equal(npmRuns(this).filter((r) => r.cmd === cmd && r.head === s).length, 1, `"${cmd}" didn't run exactly once on ${label}`);
});

Then("the cell didn't run {string} on commit {string}", function (cmd: string, label: string) {
  const s = sha(this, label);
  settled(cell(this));
  assert.ok(!npmRuns(this).some((r) => r.cmd === cmd && r.head === s), `"${cmd}" ran on ${label}`);
});

Then("it ran there after {string} had failed on the item's branch", function (cmd: string) {
  const m = mine(this);
  const runs = npmRuns(this);
  const onBase = runs.findIndex((r) => r.cmd === cmd && r.head === m.plan.baseSha);
  const failed = runs.findIndex((r) => r.cmd === cmd && r.head !== m.plan.baseSha && r.fails.length > 0);
  assert.ok(onBase >= 0, `"${cmd}" never ran on the base commit`);
  assert.ok(failed >= 0 && failed < onBase, `"${cmd}" ran on the base commit before it had failed on the item's branch`);
});

Then("every Green attempt after the first starts from the item's branch, not from commit {string}", function (label: string) {
  const s = sha(this, label);
  settled(cell(this));
  const greens = mine(this).agentSeen.filter((a) => a.stage === "green" && !a.judge);
  assert.ok(greens.length >= 2, `Green ran ${greens.length} time(s), so no attempt came after the first`);
  for (const [i, g] of greens.entries()) {
    if (i === 0) continue;
    assert.equal(g.branch, BRANCH, `Green attempt ${i + 1} started on ${g.branch}, not the item's branch`);
    assert.notEqual(g.head, s, `Green attempt ${i + 1} started from ${label}`);
  }
});

Then("no commit pushed for the item is commit {string}", function (label: string) {
  const s = sha(this, label);
  const c = cell(this);
  settled(c);
  assert.notEqual(git(c.root, "--git-dir", c.origin, "rev-parse", BRANCH), s, `the item's branch was pushed at ${label}`);
});

Then(/^(Green|address) ran 1 time$/, function (stage: string) {
  assert.equal(started(cell(this), stage.toLowerCase()), 1);
});

Then("address ran more than 1 time", function () {
  const n = started(cell(this), "address");
  assert.ok(n > 1, `address ran ${n} time(s)`);
});

Then("the owner is asked exactly 1 question", function () {
  const qs = questions(cell(this));
  assert.equal(qs.length, 1, `the owner was asked ${qs.length} questions: ${JSON.stringify(qs)}`);
});

Then("the question says the base fails in the cell", function () {
  const q = theQuestion(cell(this));
  assert.match(q, SAYS_BASE, `the question doesn't say the base fails in the cell: ${q}`);
});

Then("the question doesn't say the base fails in the cell", function () {
  const q = theQuestion(cell(this));
  assert.doesNotMatch(q, SAYS_BASE);
});

Then("no question says the base fails in the cell", function () {
  const qs = questions(cell(this));
  assert.ok(!qs.some((q) => SAYS_BASE.test(q)), `a question says the base fails in the cell: ${JSON.stringify(qs)}`);
});

Then(/^the question names the tests? (".+")$/, function (names: string) {
  const q = theQuestion(cell(this));
  for (const n of quoted(names)) assert.ok(q.includes(n), `the question doesn't name the test "${n}": ${q}`);
});

Then("the question names the base commit {string}", function (label: string) {
  const s = sha(this, label);
  const q = theQuestion(cell(this));
  assert.ok(q.includes(s.slice(0, 7)), `the question doesn't name the base commit ${s.slice(0, 7)}: ${q}`);
});

Then("the item doesn't move to Failed", function () {
  const c = cell(this);
  settled(c);
  const t = c.calls.filter((x) => x.route === "/transition").at(-1);
  assert.ok(t, "the cell sent no transition");
  assert.notEqual(next("InProgress", t.body.event as ItemEvent), "Failed");
});

Then("the question doesn't say Green failed after its attempts", function () {
  const q = theQuestion(cell(this));
  assert.doesNotMatch(q, /Green failed after/i);
});

Then("the question says address failed", function () {
  const q = theQuestion(cell(this));
  assert.match(q, /Address failed/i);
});

Then("no agent call was made on commit {string}", function (label: string) {
  const s = sha(this, label);
  settled(cell(this));
  assert.ok(!mine(this).agentSeen.some((a) => a.head === s), `an agent call was made on ${label}`);
});

Then("the agent judged the Definition of Done once, on the item's branch", function () {
  settled(cell(this));
  const m = mine(this);
  const judged = m.agentSeen.filter((a) => a.judge);
  assert.equal(judged.length, 1, `the agent judged the Definition of Done ${judged.length} times`);
  assert.equal(judged[0].branch, BRANCH);
  assert.notEqual(judged[0].head, m.plan.baseSha);
});

Then("that base run came after the first attempt's failure and before the second attempt began", function () {
  const m = mine(this);
  const runs = npmRuns(this);
  const firstFail = runs.findIndex((r) => r.head !== m.plan.baseSha && r.fails.length > 0);
  const onBase = runs.findIndex((r) => r.head === m.plan.baseSha);
  assert.ok(onBase >= 0, "nothing ran on the base commit");
  assert.ok(firstFail >= 0 && firstFail < onBase, "the base run came before the first attempt's failure");
  const greens = m.agentSeen.filter((a) => a.stage === "green" && !a.judge);
  assert.ok(greens.length >= 2, "Green's second attempt never began");
  assert.ok(greens[1].npmRuns > onBase, "the second attempt began before the base run");
});

// ---- the Floor ----

type Db = { server?: Server; origin?: string; secret: string; items: Map<number, string> };

function db(world: object): Db {
  const w = world as { pbi215db?: Db };
  w.pbi215db ??= { secret: "pbi-215-secret", items: new Map() };
  return w.pbi215db;
}

const pool = () => need().pool;

Before({ tags: "@pbi-215 and @db", ...long }, async function () {
  const d = await testDb();
  if (d) await d.pool.query('truncate item, event, backlog_source, repo, "user" cascade');
});

After({ tags: "@pbi-215 and @db", ...long }, async function () {
  for (const s of [(this as { pbi215db?: Db }).pbi215db?.server, (this as { pbi175?: { server?: Server } }).pbi175?.server]) {
    if (!s) continue;
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  await (this as { pbi175?: { close?: () => Promise<void> } }).pbi175?.close?.();
});

/** The real cell API, served on a free port for this scenario. */
async function cellApiServer(d: Db): Promise<string> {
  if (d.origin) return d.origin;
  const handler = cellApi({
    pool: pool(), secret: d.secret, repoHost: fakeRepoHost(), backlogFor: () => fakeBacklog().adapter, stageAfter: () => null,
    uploadUrl: async (p) => `http://blob.invalid/${p}`, gateway: { upstream: "http://model.invalid", ownerToken: () => "none" }, webToolsOf: () => [],
  });
  d.server = await startServer([handler], { port: 0 });
  d.origin = `http://127.0.0.1:${(d.server.address() as AddressInfo).port}`;
  return d.origin;
}

/** An item whose cell holds its lease, then asks a question through POST /transition, so the item waits in NeedsInput. */
async function waitsOn(world: object, n: number, question: Record<string, unknown>): Promise<void> {
  const d = db(world);
  const dc = dashCtx(world);
  await dashboard(dc);
  const item = (await pool().query<{ id: string }>(
    `insert into item (source_id, external_id, title, state, lease_generation, lease_owner, lease_expires)
     values ($1, $2, $3, 'InProgress', 1, 'cell-a', now() + interval '5 minutes') returning id`,
    [dc.sourceId, String(n), `Item ${n}`],
  )).rows[0].id;
  const run = (await pool().query<{ id: string }>(
    "insert into run (item_id, run_number, next_stage, branch) values ($1, 1, 'green', $2) returning id", [item, `factory/pbi-${n}-r1`],
  )).rows[0].id;
  d.items.set(n, item);
  const r = await fetch(`${await cellApiServer(d)}/internal/cells/${run}/transition`, {
    method: "POST",
    headers: { authorization: `Bearer ${runToken(d.secret, run, 1)}`, "content-type": "application/json" },
    body: JSON.stringify({ event: "blocked", question: { kind: "needs_input", ...question } }),
  });
  assert.equal(r.status, 200, `the cell API answered ${r.status}: ${await r.text()}`);
}

Given(/^item (\d+) waits on a question saying the base fails in the cell at commit "([^"]+)", failing the test "([^"]+)"$/, long, async function (n: string, commit: string, test: string) {
  await waitsOn(this, Number(n), {
    body: `The base fails in the cell. The Definition of Done line "Unit tests pass." fails on the base commit ${commit}, origin/main, as it does on this item's branch, so the item isn't at fault. Failing tests:\n- ${test}`,
    baseFailure: { sha: commit, tests: [test] },
  });
});

Given(/^item (\d+) waits on a question "([^"]+)"$/, long, async function (n: string, body: string) {
  await waitsOn(this, Number(n), { body });
});

When("{string} opens the Floor", long, async function (login: string) {
  await get(this, "/", login);
});

When("the owner answers item {int}'s question", long, async function (n: number) {
  const item = db(this).items.get(n);
  assert.ok(item, `no item ${n} was set up`);
  const owner = (await pool().query<{ id: string }>(
    `insert into "user" (provider, subject, github_login, role, product_owner) values ('microsoft', 'pbi-215-owner', 'pbi-215-owner', 'owner', true)
     on conflict (provider, subject) do update set role = excluded.role returning id`,
  )).rows[0].id;
  const outcome = await withTx(pool(), (c) => decide(c, { itemId: item, userId: owner, kind: "answer", text: "I've fixed main.", via: "dashboard" }));
  assert.equal(outcome, "applied");
});

/** The markup of the first element with the given id, up to its matching close tag. */
function elementById(html: string, id: string): string | null {
  const open = new RegExp(`<([a-zA-Z][\\w-]*)\\b[^>]*\\bid\\s*=\\s*["']${escapeRe(id)}["'][^>]*>`, "i").exec(html);
  if (!open) return null;
  const tag = open[1].toLowerCase();
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  re.lastIndex = open.index + open[0].length;
  let depth = 1;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(open.index, m.index + m[0].length);
  }
  return html.slice(open.index);
}

function floorPage(world: object): string {
  const c = dashCtx(world);
  assert.equal(c.status, 200, `the Floor answered ${c.status}: ${String(c.page).slice(0, 300)}`);
  return c.page!;
}

function notice(world: object): string {
  const page = floorPage(world);
  const el = elementById(page, "base-fails");
  assert.ok(el, `the Floor has no base failure notice: ${text(page).slice(0, 500)}`);
  return text(el);
}

const SAYS_CELLS = /base fails in cells/i;

Then("the Floor says the base fails in cells", function () {
  assert.match(notice(this), SAYS_CELLS);
});

Then("the Floor doesn't say the base fails in cells", function () {
  const page = floorPage(this);
  assert.equal(elementById(page, "base-fails"), null, "the Floor still has a base failure notice");
  assert.doesNotMatch(text(page), SAYS_CELLS);
});

Then("that notice names the test {string}", function (test: string) {
  const n = notice(this);
  assert.ok(n.includes(test), `the notice doesn't name the test "${test}": ${n}`);
});

const namesItem = (t: string, n: number) => new RegExp(`(?<![\\w.])#?${n}(?!\\d)`).test(t);

Then("that notice names item {int}", function (n: number) {
  const t = notice(this);
  assert.ok(namesItem(t, n), `the notice doesn't name item ${n}: ${t}`);
});

Then("that notice doesn't name item {int}", function (n: number) {
  const t = notice(this);
  assert.ok(!namesItem(t, n), `the notice names item ${n}: ${t}`);
});
