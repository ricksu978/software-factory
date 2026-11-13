// Step definitions for features/pbi-132-readiness-cost.feature.
//
// The judge scenarios (@ac-1, @ac-2) run PBI 13's gate on the fake backlog through PBI 13's "the readiness gate checks
// the item", with the real haikuJudge over a scripted agent run. Each scripted run reports its model, tokens and cost
// the way runAgent does. The gate hands each call it records to `recordCheck`, which these steps keep in memory.
//
// Run detail and the Phase 0 report (@ac-3, @ac-4) run the real dashboard on a free port, on PBI 4's shared test
// database, and an operator signs in with the headers Container Apps adds. Readiness checks go in through the store's
// recordReadinessCheck, and stages, runs and merges are plain SQL.
//
// The page's contract these steps read: a section is an <h2> and what follows it up to the next <h2>. Run detail's
// "Readiness checks" section is next to its "Stages" section, with one table row per check, oldest first, each
// showing its time as an ISO date and time, its model, "<n> in" and "<n> out" tokens, and its cost to four decimal
// places. The Phase 0 report says "Stage spend" and "Readiness spend", each followed by its sum, in one paragraph,
// list or table, readiness spend to four decimal places.
//
// The cell scenarios (@ac-5) drive the engine's stageMeter, which every cell agent call goes through, with a scripted
// model that records each prompt it is asked.
import { After, Before, Given, Then, When, type DataTable } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fakeBacklog } from "../../src/adapters/fake.ts";
import type { FactoryItem } from "../../src/adapters/types.ts";
import { haikuJudge, type AgentArgs, type AgentResult } from "../../src/agent/run.ts";
import { stageMeter } from "../../src/cell/engine.ts";
import { createAuth } from "../../src/http/auth.ts";
import { dashboardRoutes } from "../../src/http/routes.ts";
import { startServer } from "../../src/http/server.ts";
import { recordReadinessCheck } from "../../src/store/readiness-checks.ts";
import { checkItem, ctx as gateCtx, item as seedItem, type Judge } from "./pbi-13.steps.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";

const MODEL = "claude-haiku-4-5";
const headers = (login: string) => ({ "x-ms-client-principal-idp": "aad", "x-ms-client-principal-id": login, "x-ms-client-principal-name": login });

type Recorded = { title: string; model: string; tokensIn: number; tokensOut: number; costUsd: number; ranAt: Date };
type DbItem = { id: string; ext: string };
type Ctx = {
  /** Every readiness check the gate recorded, in order. */
  checks: Recorded[];
  /** This scenario's database items by title, and its board. */
  items: Map<string, DbItem>;
  sourceId?: string;
  dbReady?: boolean;
  server?: Server;
  close?: () => Promise<void>;
  origin?: string;
  status?: number;
  page?: string;
  /** The cell's script and what the scripted model was asked. */
  cell?: { script: "between" | "before"; asked: string[]; error?: unknown };
};

function ctx(world: object): Ctx {
  const w = world as { pbi132?: Ctx };
  w.pbi132 ??= { checks: [], items: new Map() };
  return w.pbi132;
}

const pool = () => need().pool;
const usd = (s: string) => Number(s.replace(/^\$/, ""));
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

Before({ tags: "@pbi-132" }, function () {
  const c = ctx(this);
  gateCtx(this).recordCheck = async (fi: FactoryItem, check) => {
    c.checks.push({ title: fi.title, ...check });
  };
});

After({ tags: "@pbi-132", ...long }, async function () {
  const c = ctx(this);
  await c.close?.();
  if (c.server) {
    c.server.closeAllConnections();
    await new Promise<void>((resolve) => c.server!.close(() => resolve()));
  }
});

// ---- the judge ----

type Script = {
  model?: string; tokensIn?: number; tokensOut?: number; costUsd: number;
  /** The reply: pass every line, fail one line, or answer with this text. */
  reply?: { fail: number; reason: string } | { text: string };
  failure?: "limit" | "api" | "timeout";
};

/** A judge reply from the criteria lines in the prompt, the reply shape PBI 13 sets. */
function verdicts(prompt: string, fail: { fail: number; reason: string } | null): string {
  const lines = [...prompt.matchAll(/^\{"index":(\d+),"criterion":".*"\}$/gm)].map((m) => {
    const index = Number(m[1]);
    const failed = fail?.fail === index;
    return JSON.stringify({ index, status: failed ? "failed" : "passed", reason: failed ? fail.reason : "ok" });
  });
  return [...lines, JSON.stringify({ flags: [], oversized: false })].join("\n");
}

/** The real haikuJudge, over a scripted run that reports what it spent as runAgent's result does. */
function judge(s: Script): Judge {
  const run = async (a: AgentArgs): Promise<AgentResult> => {
    const spend = { model: a.model, tokensIn: s.tokensIn ?? 1000, tokensOut: s.tokensOut ?? 50, costUsd: s.costUsd };
    const failed = { ...spend, ok: false, usage: null, transcript: "" };
    if (s.failure === "limit") return { ...failed, text: "Claude AI usage limit reached", limit: { resetsAt: Math.floor(Date.now() / 1000) + 3600 } };
    if (s.failure === "api") return { ...failed, text: "API Error: 500 Internal server error", limit: null };
    if (s.failure === "timeout") return { ...failed, text: "This operation was aborted: the readiness judge ran past its time limit", limit: null };
    const text = s.reply && "text" in s.reply ? s.reply.text : verdicts(a.prompt, s.reply ?? null);
    return { ...spend, ok: true, text, limit: null, usage: null, transcript: "" };
  };
  // PBI 13 types the policy by the fields its steps read; the gate hands the judge the whole loaded policy.
  return haikuJudge({ models: { triage: s.model ?? MODEL } }, run) as unknown as Judge;
}

Given("an item {string} in that repo", async function (title: string) {
  await seedItem(gateCtx(this), { title });
});

Given("a judge on the model {string} that passes every line, using {int} tokens in and {int} out at a cost of ${float}",
  function (model: string, tokensIn: number, tokensOut: number, cost: number) {
    gateCtx(this).judge = judge({ model, tokensIn, tokensOut, costUsd: cost });
  });

Given("the time is {string}", function (iso: string) {
  gateCtx(this).now = () => new Date(iso);
});

Given("a judge that fails line {int} because {string}, at a cost of ${float}", function (index: number, reason: string, cost: number) {
  gateCtx(this).judge = judge({ costUsd: cost, reply: { fail: index, reason } });
});

Given("a judge that answers {string} with no verdict lines, at a cost of ${float}", function (text: string, cost: number) {
  gateCtx(this).judge = judge({ costUsd: cost, reply: { text } });
});

Given("a judge that passes every line, at a cost of ${float}", function (cost: number) {
  gateCtx(this).judge = judge({ costUsd: cost });
});

Given("the item was checked once before, at a cost of ${float}", async function (cost: number) {
  const g = gateCtx(this);
  const current = g.judge;
  g.judge = judge({ costUsd: cost });
  await checkItem(this);
  assert.equal(g.error, undefined, `the first check failed: ${String(g.error)}`);
  g.judge = current;
});

When("the item is edited and the readiness gate checks it again", async function () {
  const g = gateCtx(this);
  assert.ok(g.fake && g.itemId, "no item to edit");
  const before = await g.fake.adapter.getItem(g.itemId);
  assert.ok(before);
  await g.fake.seed({ ...before, body: `${before.body}\nedited`, updatedAt: new Date(Date.now() + 1000).toISOString() });
  await checkItem(this);
});

Given("a judge that hits a usage limit after using {int} tokens in and {int} out at a cost of ${float}",
  function (tokensIn: number, tokensOut: number, cost: number) {
    gateCtx(this).judge = judge({ tokensIn, tokensOut, costUsd: cost, failure: "limit" });
  });

Given("a judge that ends in an API error after spending ${float}", function (cost: number) {
  gateCtx(this).judge = judge({ costUsd: cost, failure: "api" });
});

Given("a judge that runs past its time limit after spending ${float}", function (cost: number) {
  gateCtx(this).judge = judge({ costUsd: cost, failure: "timeout" });
});

Given("a judge that ends in an API error before using any tokens", function () {
  gateCtx(this).judge = judge({ tokensIn: 0, tokensOut: 0, costUsd: 0, failure: "api" });
});

Then("the item is still waiting for its readiness check", function () {
  const g = gateCtx(this);
  // A failed judge call is no verdict: the gate gives no result and the poller keeps the item Eligible.
  assert.equal(g.outcome, undefined, "the gate gave a verdict for a judge call that failed");
  assert.ok(g.error, "the gate didn't report the judge's failure");
});

function checksFor(world: object, title: string): Recorded[] {
  return ctx(world).checks.filter((r) => r.title === title);
}

function onlyCheck(world: object): Recorded {
  const all = ctx(world).checks;
  assert.equal(all.length, 1, `${all.length} readiness checks were recorded`);
  return all[0];
}

Then("one readiness check is recorded for {string}", function (title: string) {
  assert.equal(checksFor(this, title).length, 1, `${checksFor(this, title).length} readiness checks were recorded for "${title}"`);
});

Then("one readiness check is recorded for {string} with a cost of ${float}", function (title: string, cost: number) {
  const got = checksFor(this, title);
  assert.equal(got.length, 1, `${got.length} readiness checks were recorded for "${title}"`);
  assert.ok(near(got[0].costUsd, cost), `the check cost $${got[0].costUsd}, not $${cost}`);
});

Then("that readiness check records the model {string}", function (model: string) {
  assert.equal(onlyCheck(this).model, model);
});

Then("that readiness check records {int} tokens in and {int} tokens out", function (tokensIn: number, tokensOut: number) {
  const r = onlyCheck(this);
  assert.deepEqual({ in: r.tokensIn, out: r.tokensOut }, { in: tokensIn, out: tokensOut });
});

Then("that readiness check records a cost of ${float}", function (cost: number) {
  const r = onlyCheck(this);
  assert.ok(near(r.costUsd, cost), `the check cost $${r.costUsd}, not $${cost}`);
});

Then("that readiness check records that it ran at {string}", function (iso: string) {
  const r = onlyCheck(this);
  assert.ok(r.ranAt instanceof Date, "the check has no time");
  assert.equal(r.ranAt.toISOString(), new Date(iso).toISOString());
});

Then("two readiness checks are recorded for {string}", function (title: string) {
  assert.equal(checksFor(this, title).length, 2, `${checksFor(this, title).length} readiness checks were recorded for "${title}"`);
});

Then("the readiness checks for {string} cost ${float} in all", function (title: string, cost: number) {
  const sum = checksFor(this, title).reduce((s, r) => s + r.costUsd, 0);
  assert.ok(Math.abs(sum - cost) < 1e-9, `the checks cost $${sum} in all, not $${cost}`);
});

// ---- the database: items, runs and stored readiness checks ----

async function db(c: Ctx): Promise<void> {
  if (c.dbReady) return;
  await testDb();
  await pool().query('truncate item, event, backlog_source, repo, "user", override cascade');
  c.sourceId = (await pool().query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'pbi-132:' || gen_random_uuid()) returning id")).rows[0].id;
  c.dbReady = true;
}

async function dbItem(c: Ctx, title: string, state = "Eligible"): Promise<DbItem> {
  await db(c);
  const known = c.items.get(title);
  if (known) {
    await pool().query("update item set state = $2 where id = $1", [known.id, state]);
    return known;
  }
  const ext = String(1000 + c.items.size);
  const id = (await pool().query<{ id: string }>(
    "insert into item (source_id, external_id, title, state) values ($1, $2, $3, $4) returning id", [c.sourceId, ext, title, state],
  )).rows[0].id;
  const it = { id, ext };
  c.items.set(title, it);
  return it;
}

async function check(itemId: string, cost: number, ranAt = new Date(), model = MODEL, tokensIn = 1000, tokensOut = 50): Promise<void> {
  await recordReadinessCheck(pool(), itemId, { model, tokensIn, tokensOut, costUsd: cost, ranAt });
}

/** A merged run whose stages cost `stages` in all, merged an hour ago. */
async function mergedRun(it: DbItem, stages: string): Promise<void> {
  const run = (await pool().query<{ id: string }>(
    `insert into run (item_id, run_number, pr_url, merge_sha, started_at) values ($1, 1, $2, 'sha1', now() - interval '3 hours') returning id`,
    [it.id, `https://github.com/octo/repo/pull/${it.ext}`],
  )).rows[0].id;
  await pool().query("insert into stage_run (run_id, stage_id, attempt, status, cost_usd) values ($1, 'green', 1, 'passed', $2)", [run, stages]);
  await pool().query(
    `insert into event (actor, actor_id, item_id, kind, payload, at)
     values ('system', 'github', $1, 'transition', '{"from":"InReview","to":"Accepted","event":"merged"}', now() - interval '1 hour')`,
    [it.id],
  );
}

Given("{string} had these readiness checks:", long, async function (title: string, table: DataTable) {
  const it = await dbItem(ctx(this), title, "Queued");
  for (const r of table.hashes()) {
    await check(it.id, usd(r["cost"]), new Date(r["ran at"]), r["model"], Number(r["tokens in"]), Number(r["tokens out"]));
  }
});

Given("{string} has run its {string} stage at a cost of ${float}", long, async function (title: string, stage: string, cost: number) {
  const it = await dbItem(ctx(this), title, "InProgress");
  const run = (await pool().query<{ id: string }>(
    "insert into run (item_id, run_number, next_stage, branch) values ($1, 1, 'red', $2) returning id", [it.id, `factory/pbi-${it.ext}-r1`],
  )).rows[0].id;
  await pool().query(
    "insert into stage_run (run_id, stage_id, attempt, status, model, tokens_in, tokens_out, cost_usd) values ($1, $2, 1, 'passed', 'claude-opus-5-5', 5000, 900, $3)",
    [run, stage, cost.toFixed(2)],
  );
});

Given("{string} was turned away by a readiness check that cost ${float}", long, async function (title: string, cost: number) {
  await check((await dbItem(ctx(this), title, "NotReady")).id, cost);
});

Given("{string} has no run", long, async function (title: string) {
  const it = await dbItem(ctx(this), title, "NotReady");
  const runs = (await pool().query("select 1 from run where item_id = $1", [it.id])).rowCount;
  assert.equal(runs, 0, `"${title}" has a run`);
});

Given("{string} had a readiness check that hit a usage limit at a cost of ${float}", long, async function (title: string, cost: number) {
  // Still Eligible: a judge call on a usage limit gives no verdict.
  await check((await dbItem(ctx(this), title, "Eligible")).id, cost, new Date(), MODEL, 900, 0);
});

Given("{string} has had no readiness check", long, async function (title: string) {
  await dbItem(ctx(this), title, "Eligible");
});

Given("a merged item {string} whose stages cost ${float} and whose readiness checks cost ${float}", long, async function (title: string, stages: number, readiness: number) {
  const it = await dbItem(ctx(this), title, "Done");
  await mergedRun(it, stages.toFixed(2));
  await check(it.id, readiness);
});

Given("a merged item {string} whose stages cost ${float}", long, async function (title: string, stages: number) {
  await mergedRun(await dbItem(ctx(this), title, "Done"), stages.toFixed(2));
});

Given("an item {string} that the gate turned away, whose readiness checks cost ${float}", long, async function (title: string, cost: number) {
  // Two checks, so the sum is over every check, not the last one.
  const it = await dbItem(ctx(this), title, "NotReady");
  await check(it.id, cost * 0.4, new Date(Date.now() - 3_600_000));
  await check(it.id, cost * 0.6);
});

Given("an item {string} still waiting for its readiness check, whose failed check cost ${float}", long, async function (title: string, cost: number) {
  await check((await dbItem(ctx(this), title, "Eligible")).id, cost, new Date(), MODEL, 900, 0);
});

Given("no factory PR has merged yet", long, async function () {
  await db(ctx(this));
  assert.equal((await pool().query("select 1 from run where merge_sha is not null")).rowCount, 0, "a run has merged");
});

Given("no readiness check has run for any item", long, async function () {
  // Nothing in this scenario recorded one; the report's sum must come out as nothing.
  await db(ctx(this));
  assert.equal((await pool().query("select 1 from readiness_check")).rowCount, 0, "a readiness check has run");
});

// ---- the dashboard ----

async function open(world: object, path: string): Promise<void> {
  const c = ctx(world);
  await db(c);
  await pool().query(`insert into "user" (provider, subject, github_login, role) values ('microsoft', 'operator', 'operator', 'operator') on conflict (provider, subject) do nothing`);
  if (!c.server) {
    let handler: ReturnType<typeof dashboardRoutes> | undefined;
    c.server = await startServer([(req, res) => handler!(req, res)], { port: 0 });
    c.origin = `http://127.0.0.1:${(c.server.address() as AddressInfo).port}`;
    handler = dashboardRoutes({ pool: pool(), auth: createAuth({ mode: "azure" }), origin: c.origin, adapter: fakeBacklog().adapter, sourceId: c.sourceId! });
    c.close = handler.close;
  }
  const r = await fetch(`${c.origin}${path}`, { headers: headers("operator"), redirect: "manual" });
  c.status = r.status;
  c.page = await r.text();
}

When("an operator opens Run detail for {string}", long, async function (title: string) {
  const c = ctx(this);
  const it = c.items.get(title) ?? (await dbItem(c, title));
  await open(this, `/items/${it.id}`);
});

When("an operator opens the Phase 0 report", long, async function () {
  await open(this, "/phase0");
});

function html(world: object): string {
  const c = ctx(world);
  assert.ok(c.page !== undefined, "no page came back");
  assert.equal(c.status, 200, `the page answered ${c.status}: ${c.page.slice(0, 300)}`);
  return c.page;
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
const text = (h: string) => h.replace(/<[^>]*>/g, " ").replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e] ?? e).replace(/\s+/g, " ").trim();

/** Every <h2> section of the page, in order: its heading's text and its HTML up to the next <h2>. */
function sections(h: string): { name: string; body: string }[] {
  const parts = h.split(/<h2\b[^>]*>/i).slice(1);
  return parts.map((p) => {
    const end = p.search(/<\/h2>/i);
    return { name: text(p.slice(0, end)), body: p.slice(end + 5) };
  });
}

function section(world: object, name: string): string {
  const s = sections(html(world)).find((x) => x.name === name);
  assert.ok(s, `the page has no "${name}" section; it has: ${sections(html(world)).map((x) => x.name).join(", ")}`);
  return s.body;
}

/** The section's table body rows, as text. */
function rows(body: string): string[] {
  return [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]).filter((r) => !/<th\b/i.test(r)).map(text);
}

Then("the page has a {string} section beside its {string} section", function (a: string, b: string) {
  const names = sections(html(this)).map((x) => x.name);
  const i = names.indexOf(a);
  const j = names.indexOf(b);
  assert.ok(i >= 0, `the page has no "${a}" section; it has: ${names.join(", ")}`);
  assert.ok(j >= 0, `the page has no "${b}" section; it has: ${names.join(", ")}`);
  assert.equal(Math.abs(i - j), 1, `"${a}" isn't next to "${b}": ${names.join(", ")}`);
});

Then("the {string} section lists {int} checks, oldest first", function (name: string, n: number) {
  const got = rows(section(this, name));
  assert.equal(got.length, n, `the section lists ${got.length} checks:\n${got.join("\n")}`);
  const times = got.map((r) => /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.exec(r)?.[0].replace(" ", "T"));
  assert.ok(times.every(Boolean), `a check shows no time:\n${got.join("\n")}`);
  assert.deepEqual([...times].sort(), times, `the checks aren't oldest first:\n${got.join("\n")}`);
});

Then("each listed check shows when it ran, its model, its tokens in and out, and its cost", function () {
  const got = rows(section(this, "Readiness checks"));
  const want = [
    // Run detail shows tokens in thousands and cost to the cent, a cost under half a cent as "<$0.01" (PBI 189).
    { at: /2026-11-08[T ]09:00/, tokensIn: "1.1k in", tokensOut: "70 out", cost: "<$0.01" },
    { at: /2026-11-09[T ]10:15/, tokensIn: "1.2k in", tokensOut: "80 out", cost: "<$0.01" },
  ];
  assert.equal(got.length, want.length, `the section lists ${got.length} checks`);
  for (const [i, w] of want.entries()) {
    assert.match(got[i], w.at, `check ${i + 1} doesn't show when it ran: ${got[i]}`);
    for (const s of [MODEL, w.tokensIn, w.tokensOut, w.cost]) assert.ok(got[i].includes(s), `check ${i + 1} doesn't show ${s}: ${got[i]}`);
  }
});

Then("the {string} section still lists the {string} stage at a cost of ${float}", function (name: string, stage: string, cost: number) {
  const got = rows(section(this, name));
  assert.ok(got.some((r) => r.split(" ").includes(stage) && r.includes(`$${cost.toFixed(2)}`)), `no ${stage} row at $${cost.toFixed(2)}:\n${got.join("\n")}`);
});

Then("the {string} section lists {int} check with a cost of ${float}", function (name: string, n: number, cost: number) {
  const got = rows(section(this, name));
  assert.equal(got.length, n, `the section lists ${got.length} checks:\n${got.join("\n")}`);
  // Run detail shows a check's cost to the cent, and one above zero under half a cent as "<$0.01" (PBI 189).
  const shown = cost > 0 && cost < 0.005 ? "<$0.01" : `$${cost.toFixed(2)}`;
  for (const r of got) assert.ok(r.includes(shown), `the check doesn't show ${shown}: ${r}`);
});

Then("the {string} section says {string}", function (name: string, words: string) {
  const body = text(section(this, name));
  assert.ok(body.includes(words), `the section says: ${body}`);
});

const STAGE_SPEND = (cost: number) => new RegExp(`stage spend\\W*\\$${cost.toFixed(2).replace(".", "\\.")}(?!\\d)`, "i");
const READINESS_SPEND = (cost: number) => new RegExp(`readiness spend\\W*\\$${cost.toFixed(4).replace(".", "\\.")}(?!\\d)`, "i");

function main(world: object): string {
  const h = html(world);
  const m = /<main\b[^>]*>([\s\S]*)<\/main>/i.exec(h);
  return m ? m[1] : h;
}

Then("the report shows stage spend of ${float}", function (cost: number) {
  assert.match(text(main(this)), STAGE_SPEND(cost));
});

Then("the report shows readiness spend of ${float}", function (cost: number) {
  assert.match(text(main(this)), READINESS_SPEND(cost));
});

Then("beside it the report shows readiness spend of ${float}", function (cost: number) {
  // Beside: in the same paragraph, list or table as the stage spend.
  const blocks = [...main(this).matchAll(/<(p|dl|ul|table)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => text(m[2]));
  const withStage = blocks.filter((b) => /stage spend\W*\$\d/i.test(b));
  assert.ok(withStage.length > 0, `no paragraph, list or table shows the stage spend:\n${text(main(this))}`);
  assert.ok(withStage.some((b) => READINESS_SPEND(cost).test(b)), `the readiness spend of $${cost.toFixed(4)} isn't beside the stage spend:\n${withStage.join("\n")}`);
});

// ---- a cell's AI call outside a stage ----

Given("a run for item {int} whose cell makes an AI call after one stage ended and before the next began", function (_n: number) {
  ctx(this).cell = { script: "between", asked: [] };
});

Given("a run for item {int} whose cell makes an AI call before any stage began", function (_n: number) {
  ctx(this).cell = { script: "before", asked: [] };
});

const OUTSIDE = "the call made while no stage is open";

/** PBI 18's "the cell runs" calls this, so the words have one definition. False when the scenario isn't this feature's. */
export async function runMeteredCell(world: object): Promise<boolean> {
  const cell = (world as { pbi132?: Ctx }).pbi132?.cell;
  if (!cell) return false;
  const model = async (a: AgentArgs): Promise<AgentResult> => {
    cell.asked.push(a.prompt);
    return { ok: true, text: "done", costUsd: 0.01, tokensIn: 10, tokensOut: 5, model: a.model, limit: null, usage: null, transcript: "{}\n" };
  };
  const args = (prompt: string): AgentArgs => ({ prompt, model: "claude-opus-5-5", cwd: process.cwd(), mode: "cell", signal: new AbortController().signal });
  try {
    const meter = stageMeter(model);
    if (cell.script === "between") {
      meter.open("specify", 1);
      await meter.ask(args("the specify stage's own call"));
      meter.close();
    }
    await meter.ask(args(OUTSIDE));
    meter.open("red", 1);
    await meter.ask(args("the red stage's own call"));
    meter.close();
  } catch (e) {
    cell.error = e;
  }
  return true;
}

Then("the cell run fails with an error that says an AI call was made while no stage was open", function () {
  const e = ctx(this).cell!.error;
  assert.ok(e instanceof Error, "the cell run didn't fail");
  assert.match(e.message, /AI call was made while no stage was open/i);
});

Then("the model is never asked for that call", function () {
  assert.ok(!ctx(this).cell!.asked.includes(OUTSIDE), "the model was asked for the call made while no stage was open");
});

// PBI 168 asks this judge alongside PBI 12's fake one, so its polls record readiness checks.
export { judge as scriptedJudge };
