// Step definitions for features/pbi-105-activity-log.feature. The dashboard runs as the real node:http server on a
// free port, in Azure mode, on PBI 4's shared test database, and people sign in with the headers Container Apps adds.
// Events are written through src/store where a scenario names a real move, and with plain SQL where it fixes a time.
// The console scenarios register logTransitions, as the control plane's start does, and read what reaches console.*.
//
// The page's contract these steps read: each listed event is one <tr> of <td> cells, newest first, and a row's time
// shows as HH:MM in UTC (in its text or in a <time datetime> attribute).
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { format } from "node:util";
import { fakeBacklog } from "../../src/adapters/fake.ts";
import { logTransitions } from "../../src/control/console-log.ts";
import type { ItemEvent, ItemState } from "../../src/core/states.ts";
import { createAuth } from "../../src/http/auth.ts";
import { dashboardRoutes } from "../../src/http/routes.ts";
import { startServer } from "../../src/http/server.ts";
import { withTx } from "../../src/store/db.ts";
import { appendEvent, type Actor } from "../../src/store/events.ts";
import { overrideItem, transitionItem } from "../../src/store/items.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";
import { recordResponse } from "./pbi-19.steps.ts";

const STATES: ItemState[] = ["Eligible", "NotReady", "Queued", "InProgress", "SignOff", "NeedsInput", "InReview", "Accepted", "Done", "Failed", "Abandoned"];
const DAY = "2026-11-07";
const system: Actor = { actor: "system", actorId: "pbi-105" };
const human: Actor = { actor: "human", actorId: "pbi-105-operator" };

type Ctx = {
  server?: Server;
  close?: () => Promise<void>;
  origin?: string;
  sourceId?: string;
  items: Map<string, string>;
  status?: number;
  page?: string;
  lines: string[];
  lineAt?: number;
  restoreConsole?: () => void;
  stopLogging?: () => void;
  ext?: string;
};

function ctx(world: object): Ctx {
  const w = world as { pbi105?: Ctx };
  w.pbi105 ??= { items: new Map(), lines: [] };
  return w.pbi105;
}

const pool = () => need().pool;
const headers = (login: string) => ({ "x-ms-client-principal-idp": "aad", "x-ms-client-principal-id": login, "x-ms-client-principal-name": login });
const decode = (html: string) => html.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const text = (html: string) => decode(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");

Before({ tags: "@pbi-105 and @db", ...long }, async function () {
  const d = await testDb();
  if (d) await d.pool.query('truncate item, event, backlog_source, repo, "user", override cascade');
});

After({ tags: "@pbi-105", ...long }, async function () {
  const c = ctx(this);
  c.stopLogging?.();
  c.restoreConsole?.();
  await c.close?.();
  if (c.server) {
    c.server.closeAllConnections();
    await new Promise<void>((resolve) => c.server!.close(() => resolve()));
  }
});

async function source(c: Ctx): Promise<string> {
  c.sourceId ??= (await pool().query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'pbi-105:' || gen_random_uuid()) returning id")).rows[0].id;
  return c.sourceId;
}

/** The dashboard's handlers on a free port, started once per scenario. */
async function dashboard(c: Ctx): Promise<void> {
  if (c.server) return;
  const sourceId = await source(c);
  let handler: ReturnType<typeof dashboardRoutes> | undefined;
  c.server = await startServer([(req, res) => handler!(req, res)], { port: 0 });
  c.origin = `http://127.0.0.1:${(c.server.address() as AddressInfo).port}`;
  handler = dashboardRoutes({ pool: pool(), auth: createAuth({ mode: "azure" }), origin: c.origin, adapter: fakeBacklog().adapter, sourceId });
  c.close = handler.close;
}

/** The item with external id `ext`, made on first use. */
async function item(c: Ctx, ext: string, opts: { title?: string; state?: ItemState } = {}): Promise<string> {
  const known = c.items.get(ext);
  if (known) return known;
  const id = (await pool().query<{ id: string }>(
    "insert into item (source_id, external_id, title, state) values ($1, $2, $3, $4) returning id",
    [await source(c), ext, opts.title ?? `item ${ext}`, opts.state ?? "Queued"],
  )).rows[0].id;
  c.items.set(ext, id);
  return id;
}

async function eventAt(itemId: string, kind: string, payload: object, hhmm: string): Promise<void> {
  await pool().query("insert into event (actor, actor_id, item_id, kind, payload, at) values ('system', 'pbi-105', $1, $2, $3, $4)",
    [itemId, kind, JSON.stringify(payload), `${DAY}T${hhmm}:00Z`]);
}

async function user(login: string, role: string): Promise<void> {
  await pool().query(
    `insert into "user" (provider, subject, github_login, role) values ('microsoft', $1, $1, $2)
     on conflict (provider, subject) do update set role = excluded.role`,
    [login, role],
  );
}

async function get(world: object, path: string, login: string | null): Promise<void> {
  const c = ctx(world);
  await dashboard(c);
  const r = await fetch(`${c.origin}${path}`, { headers: login ? headers(login) : {}, redirect: "manual" });
  c.status = r.status;
  c.page = await r.text();
  recordResponse(world, c.status, c.page);
}

async function openLog(world: object, login: string): Promise<void> {
  await user(login, login === "viewer" ? "viewer" : "operator");
  await get(world, "/activity", login);
}

/** The page's event rows: every <tr> that holds a <td>, in page order. */
function rows(c: Ctx): string[] {
  assert.ok(c.page !== undefined, "no page came back");
  assert.equal(c.status, 200, `the activity log answered ${c.status}: ${c.page.slice(0, 300)}`);
  return [...c.page.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]).filter((r) => /<td\b/i.test(r));
}

const at = (hhmm: string) => new RegExp(`(?<![:\\d])${hhmm}(?!\\d)`);

/** The one row whose time is `hhmm`. */
function rowAt(c: Ctx, hhmm: string): string {
  const found = rows(c).filter((r) => at(hhmm).test(r));
  assert.equal(found.length, 1, `expected one row at ${hhmm}, found ${found.length}`);
  return found[0];
}

/** The one row whose text includes every value. */
function rowWith(c: Ctx, ...values: string[]): string {
  const found = rows(c).filter((r) => values.every((v) => text(r).includes(v)));
  assert.equal(found.length, 1, `expected one row showing ${values.join(", ")}, found ${found.length}:\n${rows(c).map(text).join("\n")}`);
  return found[0];
}

function shows(row: string, values: string[]): void {
  for (const v of values) assert.ok(text(row).includes(v), `the row doesn't show "${v}": ${text(row)}`);
}

function noStates(row: string): void {
  const t = text(row);
  const shown = STATES.filter((s) => new RegExp(`\\b${s}\\b`).test(t));
  assert.deepEqual(shown, [], `the row shows states: ${t}`);
}

/** Appends an event through the store, as the factory's own writers do. */
async function record(e: Parameters<typeof appendEvent>[1]): Promise<void> {
  await withTx(pool(), (c) => appendEvent(c, e));
}

async function move(itemId: string, event: ItemEvent, detail: Record<string, unknown> = {}): Promise<void> {
  await withTx(pool(), (c) => transitionItem(c, itemId, event, system, detail));
}

// ---- the rows ----

Given("item {string} titled {string} was claimed at {word}, moving from {string} to {string} on {string}",
  long, async function (ext: string, title: string, hhmm: string, from: string, to: string, event: string) {
    const c = ctx(this);
    await eventAt(await item(c, ext, { title }), "transition", { from, to, event }, hhmm);
  });

Given("an operator stopped item {string}'s run at {word}, moving it from {string} to {string}", long, async function (ext: string, hhmm: string, from: string, to: string) {
  const c = ctx(this);
  await eventAt(await item(c, ext), "override", { from, to, reason: "stopped from the dashboard" }, hhmm);
});

Given("the owner approved item {string}'s sign-off at {word}, recorded as a {string} event", long, async function (ext: string, hhmm: string, kind: string) {
  const c = ctx(this);
  await eventAt(await item(c, ext), kind, { kind: "approve", via: "dashboard", text: "" }, hhmm);
});

When("a viewer opens the activity log", long, async function () {
  await openLog(this, "viewer");
});

Then("the log lists {int} events, the {word} one first, then the {word} one, then the {word} one", function (n: number, a: string, b: string, d: string) {
  const c = ctx(this);
  const all = rows(c);
  assert.equal(all.length, n, `the log lists ${all.length} events`);
  assert.deepEqual([a, b, d].map((t) => all.findIndex((r) => at(t).test(r))), [0, 1, 2]);
});

Then("the {word} row shows its time, {string}, {string}, {string}, {string}, {string} and {string}",
  function (hhmm: string, v1: string, v2: string, v3: string, v4: string, v5: string, v6: string) {
    shows(rowAt(ctx(this), hhmm), [v1, v2, v3, v4, v5, v6]);
  });

Then("the {word} row shows its time, {string}, {string}, {string}, {string} and {string}", function (hhmm: string, v1: string, v2: string, v3: string, v4: string, v5: string) {
  shows(rowAt(ctx(this), hhmm), [v1, v2, v3, v4, v5]);
});

Then("the {word} row shows its time, {string}, {string} and {string}, and no states", function (hhmm: string, v1: string, v2: string, v3: string) {
  const row = rowAt(ctx(this), hhmm);
  shows(row, [v1, v2, v3]);
  noStates(row);
});

Given("the factory has recorded {int} events, one a minute", long, async function (n: number) {
  const c = ctx(this);
  // Each event has its own item, titled by its place in time, so a row names the event it is.
  for (let i = 1; i <= n; i++) {
    const id = await item(c, `e${i}`, { title: `event-${String(i).padStart(3, "0")}` });
    const minutes = 8 * 60 + i;
    await eventAt(id, "transition", { from: "Eligible", to: "NotReady", event: "readiness_failed" },
      `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`);
  }
  ctx(this).ext = String(n);
});

Then("the log lists {int} events", function (n: number) {
  assert.equal(rows(ctx(this)).length, n);
});

Then("the first row is the newest event", function () {
  const c = ctx(this);
  const newest = `event-${c.ext!.padStart(3, "0")}`;
  assert.ok(text(rows(c)[0] ?? "").includes(newest), `the first row isn't ${newest}`);
});

Then("the {int} oldest events are not listed", function (n: number) {
  const c = ctx(this);
  const page = text(rows(c).join(""));
  for (let i = 1; i <= n; i++) assert.ok(!page.includes(`event-${String(i).padStart(3, "0")}`), `event ${i} is listed`);
});

Given("item {string} has a {string} event that carries a {string} of {string} and a {string} of {string}",
  long, async function (ext: string, kind: string, k1: string, v1: string, k2: string, v2: string) {
    const c = ctx(this);
    await record({ ...system, itemId: await item(c, ext, { title: "Export a month" }), kind, payload: { [k1]: v1, [k2]: v2 } });
  });

Then("the {string} row shows no states", function (kind: string) {
  const row = rowWith(ctx(this), kind);
  noStates(row);
});

Given("the factory has recorded no events", async function () {
  assert.equal(Number((await pool().query("select count(*) from event")).rows[0].count), 0);
});

Then("the page is the activity log", function () {
  const c = ctx(this);
  assert.equal(c.status, 200, `/activity answered ${c.status}`);
  assert.match(c.page ?? "", /<title>[^<]*activity[^<]*<\/title>/i, "the page's title doesn't name the activity log");
});

Then("the log lists no events", function () {
  assert.equal(rows(ctx(this)).length, 0);
});

// ---- who can open it ----

Given("{string}, a {word}, is signed in", long, async function (login: string, role: string) {
  await user(login, role);
});

Given("item {string} titled {string} was claimed", long, async function (ext: string, title: string) {
  const id = await item(ctx(this), ext, { title, state: "Queued" });
  await move(id, "claimed");
});

When("{string} opens the activity log", long, async function (login: string) {
  await get(this, "/activity", login);
});

Then("the log lists the claim of item {string}", function (ext: string) {
  shows(rowWith(ctx(this), ext, "claimed"), ["Export a month", "transition", "Queued", "InProgress"]);
});

Given("{string}, a viewer, is not signed in", long, async function (login: string) {
  await user(login, "viewer");
});

When("a request without a sign-in opens the activity log", long, async function () {
  await get(this, "/activity", null);
});

Then("the response is the same sign-in page a signed-out request for Floor gets", async function () {
  const c = ctx(this);
  const floor = await fetch(`${c.origin}/`, { redirect: "manual" });
  assert.equal(c.status, floor.status);
  assert.equal(c.page, await floor.text());
});

When("{string} signs in and opens the activity log again", long, async function (login: string) {
  await get(this, "/activity", login);
});

// ---- what reaches the page ----

Given("item {string} failed readiness with the dor.md line {string} and a detail {string}", long, async function (ext: string, line: string, detail: string) {
  const id = await item(ctx(this), ext, { state: "Eligible" });
  await pool().query(
    "insert into policy_result (item_id, file, source, criterion_index, criterion, status, reason) values ($1, 'dor', 'repo', 1, $2, 'failed', $3)",
    [id, line, detail],
  );
  await move(id, "readiness_failed", { criterion: line, detail });
});

Then("the item's row shows {string}, {string} and {string}", function (a: string, b: string, d: string) {
  const all = rows(ctx(this));
  assert.equal(all.length, 1, `the log lists ${all.length} events`);
  shows(all[0], [a, b, d]);
});

Then("the page doesn't contain {string}", function (s: string) {
  const c = ctx(this);
  assert.equal(c.status, 200, `/activity answered ${c.status}`);
  assert.ok(!decode(c.page ?? "").includes(s), `the page contains "${s}"`);
});

Given("an operator stopped item {string}'s run with the reason {string}", long, async function (ext: string, reason: string) {
  const id = await item(ctx(this), ext, { state: "InProgress" });
  await withTx(pool(), (c) => overrideItem(c, id, "Failed", human, reason));
});

Then("the item's row shows {string} and {string}", function (a: string, b: string) {
  const all = rows(ctx(this));
  assert.equal(all.length, 1, `the log lists ${all.length} events`);
  shows(all[0], [a, b]);
});

Given("the owner approved item {string}'s sign-off with the text {string}", long, async function (ext: string, t: string) {
  const id = await item(ctx(this), ext, { state: "SignOff" });
  // The payload decideAndAnnounce records for a sign-off.
  await record({ ...human, itemId: id, kind: "decision", payload: { kind: "approve", via: "dashboard", text: t } });
});

Then("the log lists the {string} event", function (kind: string) {
  rowWith(ctx(this), kind);
});

Then("the item's row shows the title {string} as plain text", function (title: string) {
  const c = ctx(this);
  const row = rowWith(c, title);
  const escaped = title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  assert.ok(row.includes(escaped), `the row doesn't carry the escaped title: ${row}`);
});

Then("the page has no script or bold element from the title", function () {
  const c = ctx(this);
  assert.equal(c.status, 200, `/activity answered ${c.status}`);
  assert.ok(!/<script>alert\(1\)/i.test(c.page ?? ""), "the title's script element reached the page");
  assert.ok(!/<b>bold<\/b>/i.test(c.page ?? ""), "the title's bold element reached the page");
});

// ---- Floor's link ----

When("the viewer opens Floor", long, async function () {
  // PBI 89's "a viewer is signed in" adds the user "viewer".
  await get(this, "/", "viewer");
});

Then("Floor has a link to {string}", function (href: string) {
  const c = ctx(this);
  assert.equal(c.status, 200, `Floor answered ${c.status}`);
  assert.ok(new RegExp(`<a\\b[^>]*\\bhref="${href.replace(/[/]/g, "\\/")}"`).test(c.page ?? ""), `Floor has no link to ${href}`);
});

// ---- the console ----

/** Starts logging transitions, as the control plane does, and keeps every line console.* writes. */
function watchConsole(c: Ctx): void {
  if (c.restoreConsole) return;
  const methods = ["log", "info", "warn", "error"] as const;
  const saved = methods.map((m) => console[m]);
  for (const m of methods) {
    console[m] = (...args: unknown[]) => {
      c.lines.push(...format(...args).split("\n"));
    };
  }
  c.restoreConsole = () => methods.forEach((m, i) => (console[m] = saved[i]));
  c.stopLogging = logTransitions({ pool: pool() });
}

// A bare, capitalised state, so PBI 17's `item "B" is queued` and `item "B" is "Queued"` stay theirs alone.
Given(/^item "([^"]*)" is ([A-Z][A-Za-z]*)$/, long, async function (ext: string, state: string) {
  const c = ctx(this);
  await item(c, ext, { state: state as ItemState });
  c.ext = ext;
  watchConsole(c);
});

When("the item fails readiness and the transition commits", long, async function () {
  const c = ctx(this);
  await move(c.items.get(c.ext!)!, "readiness_failed");
});

When("the item is claimed and the transition commits", long, async function () {
  const c = ctx(this);
  await move(c.items.get(c.ext!)!, "claimed");
});

When("the item's lease expires and the transition commits", long, async function () {
  const c = ctx(this);
  await move(c.items.get(c.ext!)!, "lease_expired");
});

When("the item is claimed, but the work around the transition fails and is rolled back", long, async function () {
  const c = ctx(this);
  await assert.rejects(withTx(pool(), async (tx) => {
    await transitionItem(tx, c.items.get(c.ext!)!, "claimed", system);
    throw new Error("the work around the transition failed");
  }), /the work around the transition failed/);
});

Then("the item is still {word}", async function (state: string) {
  const c = ctx(this);
  assert.equal((await pool().query("select state from item where id = $1", [c.items.get(c.ext!)])).rows[0].state, state);
});

Then("the control plane's console has exactly one line {string}", function (line: string) {
  const c = ctx(this);
  assert.equal(c.lines.filter((l) => l.trim() === line).length, 1, `console lines:\n${c.lines.join("\n")}`);
});

Then("the control plane's console has the line {string}", function (line: string) {
  const c = ctx(this);
  c.lineAt = c.lines.findIndex((l) => l.trim() === line);
  assert.ok(c.lineAt >= 0, `console lines:\n${c.lines.join("\n")}`);
});

Then("after it the line {string}", function (line: string) {
  const c = ctx(this);
  assert.ok(c.lineAt !== undefined && c.lineAt >= 0, "the line before it isn't on the console");
  assert.ok(c.lines.slice(c.lineAt + 1).some((l) => l.trim() === line), `"${line}" doesn't follow the line before it:\n${c.lines.join("\n")}`);
});

Then("the control plane's console has no line starting {string}", long, async function (prefix: string) {
  const c = ctx(this);
  // A console that logs nothing at all would pass this vacuously, so a probe item's committed move must show first.
  const probe = await item(c, "probe-105", { state: "Eligible" });
  await move(probe, "readiness_failed");
  assert.ok(c.lines.some((l) => l.trim() === "item probe-105: Eligible -> NotReady (readiness_failed)"), "the console logs no committed transition at all");
  assert.deepEqual(c.lines.filter((l) => l.trim().startsWith(prefix)), []);
});
