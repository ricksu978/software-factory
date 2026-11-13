// Step definitions for features/pbi-189-run-detail-readable-numbers.feature.
//
// PBI 131's steps make the item in its GitHub repo ("item ... is an issue in the repo ...") and serve the real
// dashboard on PBI 4's shared test database for "a viewer opens the item's Run detail". These steps add the item's run,
// its stage attempts and its readiness checks: stage attempts as plain SQL on the item's one run, readiness checks
// through the store's recordReadinessCheck.
//
// The viewer's time zone is their browser's: the dashboard learns it from a `tz` cookie holding an IANA zone name,
// such as "Europe/Berlin", which the page's own script sets from Intl.DateTimeFormat().resolvedOptions().timeZone.
// A viewer with a zone set sends that cookie with every request. The time now is the dashboard's `now` clock.
//
// The page's contract these steps read: a section is an <h2> and what follows it up to the next <h2>. The "Stages"
// and "Readiness checks" sections each hold one table, with its column headings in <th> and one <tr> of <td> cells per
// stage attempt or check, checks oldest first. A cell's text is its text with tags dropped and spaces collapsed.
// - Stages: the "Stage" and "Attempt" columns name the attempt. "Tokens" reads "<in> in, <out> out" and "Cost" the
//   cost and nothing else. A column whose heading starts with "Started" shows when the attempt started as
//   "YYYY-MM-DD HH:MM" and nothing else. A column headed "Time spent", "Took" or "Duration" starts with how long it
//   took, such as "4m 7s" or "1h 12m", and may follow that with words, such as "so far", but no more numbers. An
//   attempt still running says "running" or "so far" somewhere in its row.
// - Readiness checks: "Tokens" and "Cost" as in Stages, and a column whose heading starts with "Ran" shows when the
//   check ran as "YYYY-MM-DD HH:MM" and nothing else.
// - No <th> anywhere on the page says "UTC".
//
// "the page doesn't show ..." is PBI 145's step, which reads the page PBI 131's open recorded.
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { recordReadinessCheck } from "../../src/store/readiness-checks.ts";
import { ctx as itemCtx, open } from "./pbi-131.steps.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";

type Ctx = {
  runId?: string;
  /** The stage attempts made so far, by "<stage>#<attempt>". */
  stages: Set<string>;
  /** How many readiness checks this scenario has recorded, so each default time is a minute after the last. */
  checks: number;
};

function ctx(world: object): Ctx {
  const w = world as { pbi189?: Ctx };
  w.pbi189 ??= { stages: new Set(), checks: 0 };
  return w.pbi189;
}

const pool = () => need().pool;

Before({ tags: "@pbi-189", ...long }, async function () {
  const d = await testDb();
  assert.ok(d, "src/store/test-db.ts doesn't exist");
  await d.pool.query('truncate item, event, backlog_source, repo, "user", override cascade');
});

After({ tags: "@pbi-189", ...long }, async function () {
  // PBI 131's After only closes its server for its own scenarios.
  const s = (this as { pbi131?: { server?: import("node:http").Server; close?: () => Promise<void> } }).pbi131;
  if (!s) return;
  await s.close?.();
  if (s.server) {
    s.server.closeAllConnections();
    await new Promise<void>((resolve) => s.server!.close(() => resolve()));
  }
});

function item(world: object) {
  const it = itemCtx(world).items.at(-1);
  assert.ok(it, "no item was set up");
  return it;
}

// ---- the item's run and its stage attempts ----

async function run(world: object): Promise<string> {
  const c = ctx(world);
  if (c.runId) return c.runId;
  const it = item(world);
  await pool().query("update item set state = 'InProgress' where id = $1", [it.id]);
  c.runId = (await pool().query<{ id: string }>(
    "insert into run (item_id, repo_id, run_number, next_stage, branch, started_at) values ($1, $2, 1, 'build', $3, '2026-11-09T08:00:00Z') returning id",
    [it.id, it.repoId, `factory/pbi-${it.ext}-r1`],
  )).rows[0].id;
  return c.runId;
}

type Attempt = { tokensIn?: number; tokensOut?: number; cost?: string; startedAt?: string; endedAt?: string | null };

/** Makes the stage attempt, a finished one by default, or changes what's given of the one already made. */
async function attempt(world: object, stage: string, n: number, a: Attempt): Promise<void> {
  const c = ctx(world);
  const runId = await run(world);
  const key = `${stage}#${n}`;
  if (!c.stages.has(key)) {
    // Attempts start in the order they're made, a minute apart, unless a step says when.
    const started = new Date(Date.parse("2026-11-09T09:00:00Z") + c.stages.size * 60_000);
    await pool().query(
      `insert into stage_run (run_id, stage_id, attempt, status, model, tokens_in, tokens_out, cost_usd, started_at, ended_at)
       values ($1, $2, $3, 'passed', 'claude-opus-5-5', 1000, 50, '0.10', $4, $5)`,
      [runId, stage, n, started, new Date(started.getTime() + 30_000)],
    );
    c.stages.add(key);
  }
  const sets: string[] = [];
  const values: unknown[] = [runId, stage, n];
  const set = (col: string, v: unknown) => {
    values.push(v);
    sets.push(`${col} = $${values.length}`);
  };
  if (a.tokensIn !== undefined) set("tokens_in", a.tokensIn);
  if (a.tokensOut !== undefined) set("tokens_out", a.tokensOut);
  if (a.cost !== undefined) set("cost_usd", a.cost);
  if (a.startedAt !== undefined) set("started_at", a.startedAt);
  if (a.endedAt !== undefined) {
    set("ended_at", a.endedAt);
    set("status", a.endedAt === null ? "started" : "passed");
  }
  if (sets.length) await pool().query(`update stage_run set ${sets.join(", ")} where run_id = $1 and stage_id = $2 and attempt = $3`, values);
}

Given("the item's {string} stage used {int} tokens in and {int} tokens out", long, async function (stage: string, tokensIn: number, tokensOut: number) {
  await attempt(this, stage, 1, { tokensIn, tokensOut });
});

// The cost stays as written, so the stored numeric is exactly the scenario's.
Given(/^the item's "([^"]+)" stage cost \$(\d+(?:\.\d+)?)$/, long, async function (stage: string, cost: string) {
  await attempt(this, stage, 1, { cost });
});

Given("the item's {string} stage attempt {int} started at {string} and ended at {string}", long,
  async function (stage: string, n: number, startedAt: string, endedAt: string) {
    await attempt(this, stage, n, { startedAt, endedAt });
  });

Given("the item's {string} stage attempt {int} started at {string} and has not ended", long, async function (stage: string, n: number, startedAt: string) {
  await attempt(this, stage, n, { startedAt, endedAt: null });
});

Given("the time is now {string}", function (iso: string) {
  itemCtx(this).now = () => new Date(iso);
});

// ---- readiness checks ----

type Check = { tokensIn?: number; tokensOut?: number; cost?: number; ranAt?: string };

async function check(world: object, k: Check): Promise<void> {
  const c = ctx(world);
  const ranAt = k.ranAt ? new Date(k.ranAt) : new Date(Date.parse("2026-11-09T07:00:00Z") + c.checks * 60_000);
  c.checks++;
  await recordReadinessCheck(pool(), item(world).id, {
    model: "claude-haiku-4-5", tokensIn: k.tokensIn ?? 1000, tokensOut: k.tokensOut ?? 50, costUsd: k.cost ?? 0.0031, ranAt,
  });
}

Given("the item had a readiness check that used {int} tokens in and {int} tokens out", long, async function (tokensIn: number, tokensOut: number) {
  await check(this, { tokensIn, tokensOut });
});

Given(/^the item had a readiness check that cost \$(\d+(?:\.\d+)?)$/, long, async function (cost: string) {
  await check(this, { cost: Number(cost) });
});

Given("the item had a readiness check that ended in an API error before using any tokens", long, async function () {
  await check(this, { tokensIn: 0, tokensOut: 0, cost: 0 });
});

Given("the item had a readiness check that ran at {string}", long, async function (iso: string) {
  await check(this, { ranAt: iso });
});

// ---- the viewer ----

Given("the viewer's time zone is UTC", function () {
  itemCtx(this).viewerZone = "UTC";
});

Given("the viewer's time zone is {string}", function (zone: string) {
  itemCtx(this).viewerZone = zone;
});

When("a viewer in {string} opens the item's Run detail", long, async function (zone: string) {
  const c = itemCtx(this);
  c.viewerZone = zone;
  await open(this, `/items/${item(this).id}`);
});

// ---- reading the page ----

function html(world: object): string {
  const c = itemCtx(world);
  assert.ok(c.page !== undefined, "no page came back");
  assert.equal(c.status, 200, `the page answered ${c.status}: ${c.page.slice(0, 300)}`);
  return c.page;
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
const decode = (e: string) => {
  if (ENTITIES[e]) return ENTITIES[e];
  const n = /^&#(x?)([0-9a-f]+);$/i.exec(e);
  return n ? String.fromCodePoint(parseInt(n[2], n[1] ? 16 : 10)) : e;
};
const text = (h: string) => h
  .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
  .replace(/<[^>]*>/g, " ")
  .replace(/&[#\w]+;/g, decode)
  .replace(/\s+/g, " ")
  .trim();

function section(world: object, name: string): string | null {
  for (const part of html(world).split(/<h2\b[^>]*>/i).slice(1)) {
    const end = part.search(/<\/h2>/i);
    if (text(part.slice(0, end)) === name) return part.slice(end + 5);
  }
  return null;
}

type Table = { headings: string[]; rows: string[][] };

function table(world: object, name: "Stages" | "Readiness checks"): Table {
  const body = section(world, name);
  assert.ok(body !== null, `the page has no "${name}" section`);
  const t = /<table\b[^>]*>([\s\S]*?)<\/table>/i.exec(body);
  assert.ok(t, `the "${name}" section has no table: ${text(body)}`);
  const headings = [...t[1].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => text(m[1]));
  const rows = [...t[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((m) => m[1])
    .filter((r) => !/<th\b/i.test(r))
    .map((r) => [...r.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => text(m[1])));
  return { headings, rows };
}

function column(t: Table, name: string, heading: RegExp): number {
  const i = t.headings.findIndex((h) => heading.test(h));
  assert.ok(i >= 0, `the ${name} table has no ${heading} column; its headings are: ${t.headings.join(" | ")}`);
  return i;
}

const show = (t: Table) => [t.headings.join(" | "), ...t.rows.map((r) => r.join(" | "))].join("\n");

const STAGE = /^Stage$/i;
const ATTEMPT = /^Attempt$/i;
const TOKENS = /^Tokens$/i;
const COST = /^Cost$/i;
const STARTED = /^Started\b/i;
const TOOK = /^(Time spent|Took|Duration)\b/i;
const RAN = /^Ran\b/i;

/** The Stages table's row for the stage's attempt, or its only attempt when none is named. */
function stageRow(world: object, stage: string, n?: number): { t: Table; row: string[] } {
  const t = table(world, "Stages");
  const s = column(t, "Stages", STAGE);
  let rows = t.rows.filter((r) => r[s] === stage);
  if (n !== undefined) rows = rows.filter((r) => r[column(t, "Stages", ATTEMPT)] === String(n));
  assert.equal(rows.length, 1, `the Stages table has ${rows.length} rows for "${stage}"${n === undefined ? "" : ` attempt ${n}`}:\n${show(t)}`);
  return { t, row: rows[0] };
}

/** The Readiness checks table's only row. */
function checkRow(world: object): { t: Table; row: string[] } {
  const t = table(world, "Readiness checks");
  assert.equal(t.rows.length, 1, `the Readiness checks table has ${t.rows.length} rows:\n${show(t)}`);
  return { t, row: t.rows[0] };
}

function cell(world: object, where: { t: Table; row: string[] }, name: string, heading: RegExp): string {
  return where.row[column(where.t, name, heading)] ?? "";
}

Then("the Stages table shows {string} for the {string} stage", function (tokens: string, stage: string) {
  const r = stageRow(this, stage);
  assert.equal(cell(this, r, "Stages", TOKENS), tokens, `the "${stage}" row:\n${show(r.t)}`);
});

Then("the Readiness checks table shows {string} for that check", function (tokens: string) {
  const r = checkRow(this);
  assert.equal(cell(this, r, "Readiness checks", TOKENS), tokens, `the check's row:\n${show(r.t)}`);
});

Then("the Stages table shows a cost of exactly {string} for the {string} stage", function (cost: string, stage: string) {
  const r = stageRow(this, stage);
  assert.equal(cell(this, r, "Stages", COST), cost, `the "${stage}" row:\n${show(r.t)}`);
});

Then("the Readiness checks table shows a cost of exactly {string} for that check", function (cost: string) {
  const r = checkRow(this);
  assert.equal(cell(this, r, "Readiness checks", COST), cost, `the check's row:\n${show(r.t)}`);
});

Then("the Readiness checks table doesn't show a cost of {string} for that check", function (cost: string) {
  const r = checkRow(this);
  assert.notEqual(cell(this, r, "Readiness checks", COST), cost, `the check's row:\n${show(r.t)}`);
});

Then("the Stages table shows the {string} attempt {int} started at {string}", function (stage: string, n: number, at: string) {
  const r = stageRow(this, stage, n);
  assert.equal(cell(this, r, "Stages", STARTED), at, `the "${stage}" attempt ${n} row:\n${show(r.t)}`);
});

Then("the Stages table shows the {string} attempt {int} took {string}", function (stage: string, n: number, took: string) {
  const r = stageRow(this, stage, n);
  const got = cell(this, r, "Stages", TOOK);
  // The time it took, then words at most, such as "so far": never more numbers, so "1h 12m" isn't "1h 12m 20s".
  assert.ok(got === took || (got.startsWith(took) && !/^\s*\d/.test(got.slice(took.length))), `the "${stage}" attempt ${n} took "${got}", not "${took}":\n${show(r.t)}`);
});

Then("the Stages table shows the {string} attempt {int} is still running", function (stage: string, n: number) {
  const r = stageRow(this, stage, n);
  assert.ok(r.row.some((c) => /\brunning\b|\bso far\b/i.test(c)), `the "${stage}" attempt ${n} row doesn't say it's still running:\n${show(r.t)}`);
});

Then("the Readiness checks table shows that check ran at {string}", function (at: string) {
  const r = checkRow(this);
  assert.equal(cell(this, r, "Readiness checks", RAN), at, `the check's row:\n${show(r.t)}`);
});

Then("the Readiness checks table shows a check ran at {string}", function (at: string) {
  const t = table(this, "Readiness checks");
  const i = column(t, "Readiness checks", RAN);
  assert.ok(t.rows.some((r) => r[i] === at), `no check ran at "${at}":\n${show(t)}`);
});

Then("the Readiness checks table doesn't show {string}", function (words: string) {
  const t = table(this, "Readiness checks");
  assert.ok(!show(t).includes(words), `the Readiness checks table shows "${words}":\n${show(t)}`);
});

Then("the page has a Stages table and a Readiness checks table", function () {
  assert.ok(table(this, "Stages").rows.length > 0, "the Stages table has no rows");
  assert.ok(table(this, "Readiness checks").rows.length > 0, "the Readiness checks table has no rows");
});

Then("no column heading on the page says {string}", function (words: string) {
  const headings = [...html(this).matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => text(m[1]));
  const saying = headings.filter((h) => h.includes(words));
  assert.deepEqual(saying, [], `these column headings say "${words}": ${saying.join(", ")}`);
});
