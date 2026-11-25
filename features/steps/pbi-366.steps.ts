// Step definitions for features/pbi-366-feature-change-request-waits.feature: an item in FeatureChangeRequest waits the
// way an item in SignOff does (spec §5), and Floor and Run detail show it as waiting on the Product Owner.
//
// The scheduler scenarios run on PBI 17's steps: its fresh database, its recording launcher and its fake board, and its
// "item ... is queued", "the scheduler ticks", "a cell starts for item ..." and "item ... is ...". The pages are PBI 131's
// dashboard, the real node:http server on the test database, opened as a viewer, and read through PBI 131's place and
// link helpers, with PBI 145's "... still links to ..." for the item's issue and Run detail links. PBI 140's
// "Floor shows ..." opens Floor that way too when no control plane page is open.
//
// An item moves to FeatureChangeRequest through PBI 364's requestFeatureChange, from InProgress with an open run, as a
// cell's request moves it. The move happens when its transition event is recorded, so "moved ... ago" sets that event's
// time: the clock of the wait, its reminders and its timeout starts there. "got its day-2 reminder" ticks the scheduler
// at the time the reminder fell due, so the factory records it however it keeps it. Every scenario runs on a clock
// taken when it starts, since Floor shows how long an item has waited against the real time.
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { FeatureChangeFile } from "../../src/core/feature-change.ts";
import { withTx } from "../../src/store/db.ts";
import { featureChangeRequest, requestFeatureChange } from "../../src/store/feature-change.ts";
import { transitionItem } from "../../src/store/items.ts";
import { ctx as issueCtx, inGitHubRepo, open, page, placeText, render, scope } from "./pbi-131.steps.ts";
import { ctx as p17, freshDb, tick } from "./pbi-17.steps.ts";
import { long, need } from "./pbi-8.steps.ts";

const REPO = "acme/widgets";
const TITLES: Record<string, string> = { "482": "Hold empty orders" };
const REASON = "An empty order is held, not refused";
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WAITING = `"Waiting on you"`;
const LINK = "Feature change request";

type Ctx = { now: Date; link?: { title: string; href: string } };

function mine(world: object): Ctx {
  const w = world as { pbi366?: Ctx };
  assert.ok(w.pbi366, "PBI 366's Before hook didn't run");
  return w.pbi366;
}

const pool = () => need().pool;
const viewer = { "x-ms-client-principal-idp": "aad", "x-ms-client-principal-id": "viewer", "x-ms-client-principal-name": "viewer" };

Before({ tags: "@pbi-366 and @db", ...long }, async function () {
  await freshDb(this, 1);
  // PBI 131's dashboard reads the boards and repos its own Before clears, so they start empty here too.
  await pool().query("truncate backlog_source cascade");
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  (this as { pbi366?: Ctx }).pbi366 = { now };
  p17(this).now = now;
  issueCtx(this).now = () => new Date();
});

After({ tags: "@pbi-366", ...long }, async function () {
  const s = (this as { pbi131?: { server?: import("node:http").Server; close?: () => Promise<void> } }).pbi131;
  await s?.close?.();
  if (s?.server) {
    s.server.closeAllConnections();
    await new Promise<void>((resolve) => s.server!.close(() => resolve()));
  }
});

/** "2 days and 1 hour", "1 day and 23 hours", "6 days" or "3 hours", in milliseconds. */
function span(text: string): number {
  const m = /^(?:(\d+) days?)?(?: and )?(?:(\d+) hours?)?$/.exec(text.trim());
  assert.ok(m && (m[1] || m[2]), `can't read the time "${text}"`);
  return Number(m[1] ?? 0) * DAY_MS + Number(m[2] ?? 0) * HOUR_MS;
}

const ago = (world: object, ms: number) => new Date(mine(world).now.getTime() - ms);

/** The item by its number, made as an issue in acme/widgets the first time a step names it, InProgress with an open run. */
async function item(world: object, ext: string, title = TITLES[ext] ?? `item ${ext}`): Promise<string> {
  const c = p17(world);
  if (c.items[ext]) return c.items[ext];
  const it = await inGitHubRepo(issueCtx(world), ext, title, REPO);
  await pool().query("update item set state = 'InProgress' where id = $1", [it.id]);
  await pool().query("insert into run (item_id, repo_id, next_stage, branch) values ($1, $2, 'green', $3)", [it.id, it.repoId, `factory/pbi-${ext}-r1`]);
  c.items[ext] = it.id;
  assert.ok(c.backlog, "src/adapters/fake.ts gave no fake board");
  await c.backlog.seed({ externalId: ext, repo: REPO });
  return it.id;
}

async function openRun(itemId: string): Promise<string> {
  const r = await pool().query<{ id: string }>("select id from run where item_id = $1 and ended_at is null order by started_at desc limit 1", [itemId]);
  assert.ok(r.rows[0], "the item has no open run");
  return r.rows[0].id;
}

/** Moves the item from InProgress to FeatureChangeRequest with its request, `ms` before the scenario's clock. */
async function moveToFeatureChange(world: object, ext: string, ms: number, title?: string): Promise<string> {
  const id = await item(world, ext, title);
  const files: FeatureChangeFile[] = [{
    path: `features/pbi-${ext}-orders.feature`, reason: REASON,
    before: "  Scenario: An empty order is refused\n", after: "  Scenario: An empty order is held\n",
  }];
  const run = await openRun(id);
  await withTx(pool(), (c) => requestFeatureChange(c, run, files));
  const moved = await pool().query(
    `update event set at = $2 where id = (select id from event where item_id = $1 and kind = 'transition'
       and payload->>'to' = 'FeatureChangeRequest' order by at desc limit 1)`,
    [id, ago(world, ms)],
  );
  assert.equal(moved.rowCount, 1, `item ${ext}'s move to FeatureChangeRequest wasn't recorded`);
  assert.equal((await pool().query("select state from item where id = $1", [id])).rows[0].state, "FeatureChangeRequest");
  assert.ok(await featureChangeRequest(pool(), id), `item ${ext} has no feature change request`);
  return id;
}

/** Ticks the scheduler as it would have `ms` before the scenario's clock, then puts the clock back. */
async function tickAt(world: object, ms: number): Promise<void> {
  const c = p17(world);
  c.now = ago(world, ms);
  try {
    await tick(c);
  } finally {
    c.now = mine(world).now;
  }
  assert.ok(c.ticked, "src/scheduler/scheduler.ts didn't tick");
}

// ---- the factory and its items ----

Given("a factory with WIP {int} and a review capacity of {int}", long, async function (wip: number, capacity: number) {
  const r = await pool().query("update wip_policy set mode = 'fixed', current_wip = $1, review_capacity = $2, usage_paused_until = null", [wip, capacity]);
  assert.ok(r.rowCount, "there's no WIP policy");
});

Given(/^item "([^"]+)"(?: titled "([^"]+)")? moved to FeatureChangeRequest (.+) ago$/, long, async function (ext: string, title: string | null, when: string) {
  await moveToFeatureChange(this, ext, span(when), title ?? undefined);
});

Given(/^item "([^"]+)" moved to FeatureChangeRequest (.+) ago, then its PR was merged and it is "Accepted"$/, long, async function (ext: string, when: string) {
  const id = await moveToFeatureChange(this, ext, span(when));
  const run = await openRun(id);
  await pool().query("update run set pr_number = 48, pr_url = $2, merge_sha = 'abc1234' where id = $1", [run, `https://github.com/${REPO}/pull/48`]);
  await withTx(pool(), (c) => transitionItem(c, id, "merged", { actor: "system", actorId: "pbi-366" }));
  assert.equal((await pool().query("select state from item where id = $1", [id])).rows[0].state, "Accepted");
});

Given(/^item "([^"]+)"'s sign-off was asked (.+) ago and answered (.+) ago$/, long, async function (ext: string, asked: string, answered: string) {
  const id = await item(this, ext);
  const r = await pool().query(
    "insert into question (item_id, kind, body, asked_at, answer, answered_at) values ($1, 'sign_off', 'Sign off the scenarios.', $2, 'approve', $3)",
    [id, ago(this, span(asked)), ago(this, span(answered))],
  );
  assert.equal(r.rowCount, 1);
});

Given("item {string} got its day-2 reminder", long, async function (ext: string) {
  await tickAt(this, (await waited(this, ext)) - 2 * DAY_MS - HOUR_MS);
});

Given("item {string} got its day-2 and day-4 reminders", long, async function (ext: string) {
  const since = await waited(this, ext);
  await tickAt(this, since - 2 * DAY_MS - HOUR_MS);
  await tickAt(this, since - 4 * DAY_MS - HOUR_MS);
});

/** How long before the scenario's clock the item moved to FeatureChangeRequest. */
async function waited(world: object, ext: string): Promise<number> {
  const id = p17(world).items[ext];
  assert.ok(id, `no item ${ext}`);
  const r = await pool().query<{ at: Date }>(
    "select max(at) as at from event where item_id = $1 and kind = 'transition' and payload->>'to' = 'FeatureChangeRequest'", [id]);
  assert.ok(r.rows[0]?.at, `item ${ext} never moved to FeatureChangeRequest`);
  return mine(world).now.getTime() - r.rows[0].at.getTime();
}

// ---- the scheduler ----

When("the scheduler ticks three times", long, async function () {
  for (let i = 0; i < 3; i++) {
    await tick(p17(this));
    assert.ok(p17(this).ticked, "src/scheduler/scheduler.ts didn't tick");
  }
});

When("the scheduler ticks and a viewer opens Floor", long, async function () {
  await tick(p17(this));
  assert.ok(p17(this).ticked, "src/scheduler/scheduler.ts didn't tick");
  await opened(this, "/");
});

When("a viewer opens item {string}'s Run detail", long, async function (ext: string) {
  await opened(this, `/items/${p17(this).items[ext]}`);
});

When("the scheduler ticks and a viewer opens item {string}'s Run detail", long, async function (ext: string) {
  await tick(p17(this));
  assert.ok(p17(this).ticked, "src/scheduler/scheduler.ts didn't tick");
  await opened(this, `/items/${p17(this).items[ext]}`);
});

/** Opens `path` on PBI 131's dashboard as a viewer, and checks the page came back. */
async function opened(world: object, path: string): Promise<void> {
  await open(world, path);
  const c = issueCtx(world);
  assert.equal(c.status, 200, `${path} answered ${c.status}: ${(c.page ?? "").slice(0, 300)}`);
}

// ---- the reminders on the board ----

/** The item's comments on the fake board that remind the owner it still waits on them. */
async function reminders(world: object, ext: string): Promise<string[]> {
  const c = p17(world);
  assert.ok(c.ticked, "src/scheduler/scheduler.ts didn't tick");
  assert.ok(c.backlog, "no fake board");
  // PBI 17 types its fake board by the two calls it makes. The fake also keeps each item's comments.
  const all = await (c.backlog as unknown as { comments(id: string): Promise<string[]> }).comments(ext);
  return all.filter((b) => /\breminder\b/i.test(b));
}

function stillWaits(bodies: string[]) {
  for (const b of bodies) assert.match(b, /still wait/i, `the reminder doesn't say the item still waits on the owner: ${b}`);
}

Then(/^item "([^"]+)" on the board has (one|two|exactly one) reminder comments? that it still waits on the owner$/, long, async function (ext: string, n: string) {
  const got = await reminders(this, ext);
  assert.equal(got.length, n === "two" ? 2 : 1, `item ${ext} has ${got.length} reminder comments: ${JSON.stringify(got)}`);
  stillWaits(got);
});

Then("item {string} on the board has no reminder comment", long, async function (ext: string) {
  const got = await reminders(this, ext);
  assert.deepEqual(got, [], `item ${ext} has reminder comments`);
});

Then("item {string}'s move to Abandoned is recorded as timed out", long, async function (ext: string) {
  const r = await pool().query<{ event: string; from: string }>(
    "select payload->>'event' as event, payload->>'from' as from from event where item_id = $1 and kind = 'transition' and payload->>'to' = 'Abandoned'",
    [p17(this).items[ext]],
  );
  assert.deepEqual(r.rows, [{ event: "timed_out", from: "FeatureChangeRequest" }], `item ${ext}'s moves to Abandoned: ${JSON.stringify(r.rows)}`);
});

// ---- Floor's "Waiting on you" ----

/** The html of the item's row under "Waiting on you": the <li> that holds its title. */
function waitingRow(world: object, title: string): string {
  const html = scope(page(world), WAITING);
  const rows = [...html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => m[1]).filter((row) => render(row).text.includes(title));
  assert.equal(rows.length, 1, `"Waiting on you" has ${rows.length} rows for "${title}": ${placeText(render(html))}`);
  return rows[0];
}

const rowText = (row: string) => render(row).text.replace(/\s+/g, " ").trim();
const onTheOwner = /\b(?:waits|waiting) on the Product Owner\b/;

Then("{string} lists {string}", function (place: string, title: string) {
  const r = render(scope(page(this), `"${place}"`));
  assert.ok(r.text.includes(title), `"${place}" doesn't list "${title}": ${placeText(r)}`);
});

Then("{string} doesn't list {string}", function (place: string, title: string) {
  const r = render(scope(page(this), `"${place}"`));
  assert.ok(!r.text.includes(title), `"${place}" lists "${title}": ${placeText(r)}`);
});

Then("\"Waiting on you\" shows {string} as waiting on the Product Owner", function (title: string) {
  const text = rowText(waitingRow(this, title));
  assert.match(text, onTheOwner, `"${title}" on "Waiting on you" reads: ${text}`);
});

Then("\"Waiting on you\" shows {string} as waiting {string}", function (title: string, age: string) {
  const text = rowText(waitingRow(this, title));
  assert.ok(new RegExp(`\\bwaiting ${age.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text), `"${title}" on "Waiting on you" reads: ${text}`);
});

Then("\"Waiting on you\" shows a {string} link for {string}", function (label: string, title: string) {
  const links = render(waitingRow(this, title)).links.filter((l) => l.text === label);
  assert.equal(links.length, 1, `"${title}" on "Waiting on you" has ${links.length} "${label}" links`);
  mine(this).link = { title, href: links[0].href };
});

Then("\"Waiting on you\" shows no {string} link for {string}", function (label: string, title: string) {
  const links = render(waitingRow(this, title)).links.filter((l) => l.text === label);
  assert.deepEqual(links, [], `"${title}" on "Waiting on you" has a "${label}" link`);
});

/** Whether the element `id="<fragment>"` on the page starts the "Feature change request" section. */
function isSection(html: string, fragment: string): boolean {
  const at = html.search(new RegExp(`\\bid="${fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  if (at < 0 || !fragment) return false;
  const start = html.lastIndexOf("<", at);
  const h2 = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(html.slice(start));
  return !!h2 && h2.index < 200 && render(h2[1]).text.trim() === LINK;
}

Then("the link goes to the \"Feature change request\" section of item {string}'s Run detail", long, async function (ext: string) {
  const link = mine(this).link;
  assert.ok(link, "no \"Feature change request\" link was read");
  const id = p17(this).items[ext];
  const url = new URL(link.href, "http://floor.test/");
  assert.equal(url.pathname, `/items/${id}`, `the link goes to ${link.href}`);
  const origin = issueCtx(this).origin;
  assert.ok(origin, "the dashboard isn't running");
  const r = await fetch(`${origin}${url.pathname}`, { headers: viewer });
  assert.equal(r.status, 200, "Run detail didn't open");
  assert.ok(isSection(await r.text(), url.hash.slice(1)), `${link.href} doesn't go to Run detail's "Feature change request" section`);
});

// ---- Run detail ----

/** The line under Run detail's heading, which holds the item's state. */
function stateLine(world: object): string {
  const line = /<\/h1>\s*<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(page(world));
  assert.ok(line, "Run detail has no line under its heading");
  return line[1];
}

Then("the line with the item's state {string} says it waits on the Product Owner", function (state: string) {
  const text = rowText(stateLine(this));
  assert.ok(text.includes(state), `the state line reads: ${text}`);
  assert.match(text, onTheOwner, `the state line reads: ${text}`);
});

Then("the line with the item's state doesn't say it waits on the Product Owner", function () {
  const text = rowText(stateLine(this));
  assert.doesNotMatch(text, onTheOwner, `the state line reads: ${text}`);
});

Then("that line shows a \"Feature change request\" link to the page's \"Feature change request\" section", function () {
  const links = render(stateLine(this)).links.filter((l) => l.text === LINK);
  assert.equal(links.length, 1, `the state line has ${links.length} "${LINK}" links`);
  const url = new URL(links[0].href, "http://detail.test/");
  if (!links[0].href.startsWith("#")) assert.equal(url.pathname, `/items/${issueCtx(this).items.at(-1)?.id}`, `the link goes to ${links[0].href}`);
  assert.ok(isSection(page(this), url.hash.slice(1)), `${links[0].href} doesn't go to the page's "${LINK}" section`);
});

Then("the page's \"Feature change request\" section shows {string}", function (text: string) {
  const html = page(this);
  const start = html.search(/<h2\b[^>]*>\s*Feature change request\s*<\/h2>/i);
  assert.ok(start >= 0, `the page has no "${LINK}" section`);
  const rest = html.slice(start).replace(/^<h2\b[^>]*>[\s\S]*?<\/h2>/i, "");
  const end = rest.search(/<h2\b/i);
  const section = render(end < 0 ? rest : rest.slice(0, end)).text;
  assert.ok(section.includes(text), `the "${LINK}" section doesn't show "${text}"`);
});

Then("the page has no {string} link", function (label: string) {
  const links = render(scope(page(this), "the page")).links.filter((l) => l.text === label);
  assert.deepEqual(links, [], `the page has a "${label}" link`);
});
