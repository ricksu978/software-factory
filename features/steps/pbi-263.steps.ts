// Step definitions for features/pbi-263-floor-cost-to-the-cent.feature.
//
// PBI 131's steps make each item in its GitHub repo and serve the real dashboard on PBI 4's shared test database for
// "a viewer opens Floor" and "a viewer opens the item's Run detail". PBI 189's steps cost a stage of "the item" and
// read Run detail's Stages table. These steps put each item in flight with an open run at the named stage, and that
// run holds its stage attempts, so the Floor's cost for the item is the sum of their costs.
//
// "The item" is the Background's item, even when a scenario makes another one after it.
//
// The page's contract these steps read: Floor's "Production Line" section (PBI 430) is its <h2> and what follows up to
// the next <h2>, and it holds one table, with its column headings in <th> and one <tr> of <td> cells per item. An item's row is the
// one whose "Item" cell holds its title. The "Cost" cell's text is the cost and nothing else. Hovering a Cost cell, on
// Floor or in Run detail's Stages table, shows that <td>'s title attribute.
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { ctx as itemCtx, type Item } from "./pbi-131.steps.ts";
import { attempt, section, text, useRun } from "./pbi-189.steps.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";

type Ctx = {
  /** The title of the Cost cell the viewer last hovered over, or null when it has none. */
  hovered?: string | null;
};

function ctx(world: object): Ctx {
  const w = world as { pbi263?: Ctx };
  w.pbi263 ??= {};
  return w.pbi263;
}

const pool = () => need().pool;

Before({ tags: "@pbi-263", ...long }, async function () {
  const d = await testDb();
  assert.ok(d, "src/store/test-db.ts doesn't exist");
  await d.pool.query('truncate item, event, backlog_source, repo, "user", override cascade');
});

After({ tags: "@pbi-263", ...long }, async function () {
  // PBI 131's After only closes its server for its own scenarios.
  const s = (this as { pbi131?: { server?: import("node:http").Server; close?: () => Promise<void> } }).pbi131;
  if (!s) return;
  await s.close?.();
  if (s.server) {
    s.server.closeAllConnections();
    await new Promise<void>((resolve) => s.server!.close(() => resolve()));
  }
});

function byExt(world: object, ext: string): Item {
  const it = itemCtx(world).items.find((i) => i.ext === ext);
  assert.ok(it, `no item "${ext}" was set up`);
  return it;
}

function theItem(world: object): Item {
  const c = itemCtx(world);
  const it = c.the ?? c.items.at(-1);
  assert.ok(it, "no item was set up");
  return it;
}

// ---- the items in flight and their stages' costs ----

/** The item in progress with an open run at the stage, which PBI 189's stage attempts then go on. */
async function inFlight(world: object, it: Item, stage: string): Promise<void> {
  await pool().query("update item set state = 'InProgress' where id = $1", [it.id]);
  const runId = (await pool().query<{ id: string }>(
    "insert into run (item_id, repo_id, run_number, next_stage, branch, started_at) values ($1, $2, 1, $3, $4, '2026-11-09T08:00:00Z') returning id",
    [it.id, it.repoId, stage, `factory/pbi-${it.ext}-r1`],
  )).rows[0].id;
  useRun(world, it.id, runId);
}

Given("the item is in flight in the {string} stage", long, async function (stage: string) {
  const c = itemCtx(this);
  const it = theItem(this);
  // This item stays "the item" when the scenario makes another after it.
  c.the = it;
  await inFlight(this, it, stage);
});

Given("item {string} is in flight in the {string} stage", long, async function (ext: string, stage: string) {
  await inFlight(this, byExt(this, ext), stage);
});

// The cost stays as written, so the stored numeric is exactly the scenario's.
Given(/^item "([^"]+)"'s "([^"]+)" stage cost \$(\d+(?:\.\d+)?)$/, long, async function (ext: string, stage: string, cost: string) {
  await attempt(this, stage, 1, { cost }, byExt(this, ext));
});

// A stage attempt under way that has no cost recorded yet.
Given("the item has no stage cost recorded", long, async function () {
  await attempt(this, "build", 1, { cost: null, endedAt: null });
});

// ---- reading the page ----

type Cell = { text: string; title: string | null };
type Table = { headings: string[]; rows: Cell[][] };

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? text(m[1] ?? m[2] ?? "") : null;
};

function table(world: object, name: string): Table {
  const body = section(world, name);
  assert.ok(body !== null, `the page has no "${name}" section`);
  const t = /<table\b[^>]*>([\s\S]*?)<\/table>/i.exec(body);
  assert.ok(t, `the "${name}" section has no table: ${text(body)}`);
  const headings = [...t[1].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => text(m[1]));
  const rows = [...t[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((m) => m[1])
    .filter((r) => !/<th\b/i.test(r))
    .map((r) => [...r.matchAll(/(<td\b[^>]*>)([\s\S]*?)<\/td>/gi)].map((m) => ({ text: text(m[2]), title: attr(m[1], "title") })));
  return { headings, rows };
}

const show = (t: Table) => [t.headings.join(" | "), ...t.rows.map((r) => r.map((c) => c.text).join(" | "))].join("\n");

function column(t: Table, name: string, heading: RegExp): number {
  const i = t.headings.findIndex((h) => heading.test(h));
  assert.ok(i >= 0, `the ${name} table has no ${heading} column; its headings are: ${t.headings.join(" | ")}`);
  return i;
}

/** The Cost cell of the one row in the table whose `key` column matches. */
function costCell(world: object, name: string, key: RegExp, match: (cell: string) => boolean, what: string): { t: Table; cell: Cell } {
  const t = table(world, name);
  const k = column(t, name, key);
  const rows = t.rows.filter((r) => match(r[k]?.text ?? ""));
  assert.equal(rows.length, 1, `the "${name}" table has ${rows.length} rows for ${what}:\n${show(t)}`);
  return { t, cell: rows[0][column(t, name, /^Cost$/i)] ?? { text: "", title: null } };
}

const itemCost = (world: object, name: string, title: string) =>
  costCell(world, name, /^Item$/i, (c) => c.includes(title), `"${title}"`);

Then("the {string} table shows a cost of exactly {string} for the item", function (name: string, cost: string) {
  const { t, cell } = itemCost(this, name, theItem(this).title);
  assert.equal(cell.text, cost, `the item's row:\n${show(t)}`);
});

Then("the {string} table shows a cost of exactly {string} for {string}", function (name: string, cost: string, title: string) {
  const { t, cell } = itemCost(this, name, title);
  assert.equal(cell.text, cost, `the "${title}" row:\n${show(t)}`);
});

Then("the {string} table doesn't show a cost of {string} for the item", function (name: string, cost: string) {
  const { t, cell } = itemCost(this, name, theItem(this).title);
  assert.notEqual(cell.text, cost, `the item's row:\n${show(t)}`);
});

Then("the {string} table doesn't show {string}", function (name: string, words: string) {
  const t = table(this, name);
  assert.ok(!show(t).includes(words), `the "${name}" table shows "${words}":\n${show(t)}`);
});

// ---- hovering ----

When("the viewer hovers over the item's cost in the {string} table", function (name: string) {
  ctx(this).hovered = itemCost(this, name, theItem(this).title).cell.title;
});

When("the viewer hovers over the {string} stage's cost in the Stages table", function (stage: string) {
  ctx(this).hovered = costCell(this, "Stages", /^Stage$/i, (c) => c === stage, `"${stage}"`).cell.title;
});

Then("the viewer sees the exact cost {string}", function (cost: string) {
  const { hovered } = ctx(this);
  assert.ok(hovered !== undefined, "the viewer hasn't hovered over a cost");
  assert.equal(hovered, cost, hovered === null ? "the Cost cell shows nothing on hover" : `hovering shows "${hovered}"`);
});
