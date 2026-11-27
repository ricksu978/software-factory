// Step definitions for features/pbi-366-feature-change-request-waits.feature.
//
// They build on other features' steps, on PBI 4's shared test database:
// - PBI 17's scheduler harness: its "a cell starts for item", "no cell starts", "item {string} is {string}", "item
//   {string} is queued", the sign-off and review items, and its tick, which runs src/scheduler/scheduler.ts's tick with
//   PBI 17's fake board as every item's board and a launcher that records what it starts. Every PBI 17 step here runs on
//   this scenario's clock, which is the real time when the scenario starts, so a page and the scheduler agree on it.
// - PBI 131's dashboard for "the dashboard": the SPA's own pages rendered from what its API answers, and its items in a GitHub repo, so "#482"
//   links to https://github.com/acme/widgets/issues/482. Its "a viewer opens Floor" opens the dashboard's Floor.
// - PBI 279's SPA, for "the SPA": the real pages, rendered by react-dom/server, through the real shell, whose reads of
//   /bff/v1/floor and /bff/v1/items/{id} are answered by src/api/main.ts's apiApp, the API itself, on this database.
// - PBI 145's "{string} on {string} still links to ..." and PBI 140's "Floor shows {string}", which read the page
//   through world hooks this file sets: `runDetailPath`, the Run detail path of the page last opened, and `floorShows`,
//   which opens the dashboard's Floor afresh and reads it, since a scenario reads Floor straight after a tick.
//
// The contract these steps set up, which the code reads:
// - An item in FeatureChangeRequest got there as PBI 364 moves it: an InProgress item 482 in acme/widgets, its run at
//   green with green's attempt 1 failed, whose request goes through requestFeatureChange in src/store/feature-change.ts.
//   When the item moved is the `at` of that transition event, the one whose payload's `to` is FeatureChangeRequest. These
//   steps set it back to the time the scenario names.
// - "Then the Product Owner approved the change" is decideFeatureChange in src/control/decisions.ts by a product owner,
//   an hour after the move, with its events set back to that time.
// - A reminder is a comment on the item's board whose text holds the word "reminder". One that says the item still
//   waits on the Product Owner's decision on its feature change request names "Product Owner" and "feature change
//   request". One that says the item will be abandoned holds "abandon".
// - "Got its day-2 reminder" is a scheduler tick at 2 days and a minute after the move, on the board the scenario reads.
// - Floor's "Waiting on you" row of an item is the <li> under the <h2>Waiting on you</h2> that holds the link to the
//   item's Run detail, /runs/<id>, on the dashboard and in the SPA alike. It shows the item as waiting on the Product
//   Owner when its text says "waiting on the Product Owner", and how long with "waiting <n> <unit>", where "d" also reads
//   as "days" and "h" as "hours".
// - A "Feature change request" link is an <a href> whose text is just "Feature change request". One that goes to the
//   section of Run detail is the Run detail path, or nothing on the Run detail page itself, then "#" and the id of an
//   element at which the page's text starts with "Feature change request". The section is the <h2>Feature change
//   request</h2> and what follows it up to the next <h2>.
// - Run detail's line with the item's state is the <p> whose text starts with the state, as PBI 145 reads it. It says the
//   item waits on the Product Owner when its text says "waits on the Product Owner" or "waiting on the Product Owner".
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { apiApp } from "../../src/api/main.ts";
import { decideFeatureChange } from "../../src/control/decisions.ts";
import type { FeatureChangeFile } from "../../src/core/feature-change.ts";
import { withTx } from "../../src/store/db.ts";
import { requestFeatureChange } from "../../src/store/feature-change.ts";
import type { ItemData } from "../../web/src/api.ts";
import { ctx as issueCtx, inGitHubRepo, open as openDashboard, page as dashboardPage, render, scope, placeText, type Item } from "./pbi-131.steps.ts";
import { ctx as p17, freshDb, newItem, tick, type Ctx as Ctx17 } from "./pbi-17.steps.ts";
import { recordResponse } from "./pbi-19.steps.ts";
import { ctx as p279, open as openSpa } from "./pbi-279.steps.ts";
import { load, long, need, testDb } from "./pbi-8.steps.ts";

const REPO = "acme/widgets";
const ORDERS = "features/pbi-482-orders.feature";
const REASON = "An empty order is held, not refused";
const BEFORE = "Feature: Orders\n  Scenario: An empty order\n    When a customer places an empty order\n    Then the order is refused\n";
const AFTER = BEFORE.replace("Then the order is refused", "Then the order is held for review");
const TITLES: Record<string, string> = { "482": "Hold empty orders" };
const SECTION = "Feature change request";
const LINK = "Feature change request";
const ISSUER = "https://login.pbi-366.test";
const LOCK_SHA = "1ock000000000000000000000000000000000366";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const pool = () => need().pool;

type Where = "dashboard" | "spa";
type Page = { where: Where; ok: boolean; html: string; why?: string };

type Ctx = {
  /** The scenario's clock: the real time when it started. */
  now: Date;
  /** When each item started waiting: its move to FeatureChangeRequest, or its unanswered sign-off. */
  since: Map<string, Date>;
  floor?: Page;
  details: Map<string, Page>;
  /** The "Feature change request" link the last step read on Floor, and the page it was read on. */
  link?: { href: string; where: Where };
  /** The reminders the last reminder step read. */
  reminders?: string[];
  api?: ReturnType<typeof apiApp>;
};

function mine(world: object): Ctx {
  const w = world as { pbi366?: Ctx };
  w.pbi366 ??= { now: new Date(), since: new Map(), details: new Map() };
  return w.pbi366;
}

Before({ tags: "@pbi-366 and @db", ...long }, async function () {
  const d = await testDb();
  if (!d) return;
  await d.pool.query('truncate item, event, backlog_source, repo, "user", override cascade');
  await d.pool.query("update wip_policy set mode = 'fixed', current_wip = 1, review_capacity = 3, usage_paused_until = null");
  const x = mine(this);
  x.now = new Date();
  p17(this).now = x.now;
  issueCtx(this).now = () => x.now;
  // PBI 140's "Floor shows {string}" reads the dashboard's Floor as it stands, opened afresh.
  (this as { floorShows?: (text: string) => Promise<void> }).floorShows = async (text: string) => {
    const f = await openFloor(this, "dashboard");
    assert.ok(f.ok, `Floor didn't open: ${f.why}`);
    const shown = render(f.html).text.replace(/\s+/g, " ");
    assert.ok(shown.includes(text), `Floor doesn't show "${text}": ${shown.slice(0, 400)}`);
  };
});

After({ tags: "@pbi-366", ...long }, async function () {
  const s = (this as { pbi131?: { server?: Server; close?: () => Promise<void> } }).pbi131;
  if (s) {
    await s.close?.();
    if (s.server) {
      s.server.closeAllConnections();
      await new Promise<void>((resolve) => s.server!.close(() => resolve()));
    }
  }
  await mine(this).api?.close();
});

// ---- the factory and its board ----

/** PBI 17's harness with its fake board and repo host, made without a fresh database when no factory step made them. */
async function factory(world: object): Promise<Ctx17> {
  const c = p17(world);
  if (!c.backlog || !c.repoHost) {
    const fakes = await load<{ fakeBacklog: () => NonNullable<Ctx17["backlog"]>; fakeRepoHost: () => NonNullable<Ctx17["repoHost"]> }>("src/adapters/fake.ts");
    assert.ok(fakes, "src/adapters/fake.ts doesn't exist");
    c.backlog = fakes.fakeBacklog();
    c.repoHost = fakes.fakeRepoHost();
  }
  c.repoHost.heads.set(REPO, "c0ffee0");
  c.now ??= mine(world).now;
  return c;
}

Given("a factory with WIP {int} and a review capacity of {int}", long, async function (wip: number, capacity: number) {
  await freshDb(this, wip);
  await pool().query("update wip_policy set review_capacity = $1", [capacity]);
  await factory(this);
  p17(this).now = mine(this).now;
});

/** Item `name` in acme/widgets, on PBI 131's board and on PBI 17's, made once. */
async function itemNamed(world: object, name: string, title?: string): Promise<Item> {
  const c = await factory(world);
  const issues = issueCtx(world);
  let it = issues.items.find((i) => i.ext === name);
  if (!it) {
    it = await inGitHubRepo(issues, name, title ?? TITLES[name] ?? `Item ${name}`, REPO);
    await c.backlog!.seed({ externalId: name, repo: REPO, title: it.title } as { externalId: string; repo: string });
  }
  c.items[name] = it.id;
  return it;
}

/** "2 days and 1 hour", "1 day and 23 hours", "3 hours", "30 days" in ms. */
function duration(text: string): number {
  let ms = 0;
  for (const part of text.split(/\s+and\s+/)) {
    const m = /^(\d+)\s+(day|days|hour|hours|minute|minutes)$/.exec(part.trim());
    assert.ok(m, `"${text}" isn't a duration`);
    ms += Number(m[1]) * (m[2].startsWith("day") ? DAY : m[2].startsWith("hour") ? HOUR : MIN);
  }
  return ms;
}

/** Moves the item from InProgress to FeatureChangeRequest as PBI 364's cell API does, `ago` before the scenario's clock. */
async function moveToFeatureChangeRequest(world: object, name: string, ago: number, title?: string): Promise<Item> {
  const x = mine(world);
  const it = await itemNamed(world, name, title);
  const at = new Date(x.now.getTime() - ago);
  const runStart = new Date(at.getTime() - 2 * HOUR);
  const run = (await pool().query<{ id: string }>(
    `insert into run (item_id, repo_id, run_number, started_at, next_stage, branch, config_sha, sop_version, scenarios_sha, features_lock_sha)
     values ($1, $2, 1, $3, 'green', $4, 'c0nf1g0', 'default@1', $5, $5) returning id`,
    [it.id, it.repoId, runStart, `factory/pbi-${name}-r1`, LOCK_SHA],
  )).rows[0].id;
  await pool().query(
    `insert into stage_run (run_id, stage_id, attempt, status, started_at, ended_at) values
       ($1, 'red', 1, 'passed', $2, $3), ($1, 'green', 1, 'failed', $3, $4)`,
    [run, runStart, new Date(runStart.getTime() + HOUR), at],
  );
  await pool().query("update item set state = 'InProgress' where id = $1", [it.id]);
  const files: FeatureChangeFile[] = [{ path: ORDERS, reason: REASON, before: BEFORE, after: AFTER }];
  await withTx(pool(), (c) => requestFeatureChange(c, run, files));
  await pool().query(
    "update event set at = $2 where item_id = $1 and kind = 'transition' and payload->>'to' = 'FeatureChangeRequest'",
    [it.id, at],
  );
  x.since.set(name, at);
  return it;
}

/** The Product Owner approves the item's request an hour after it moved, so it goes back to Queued. */
async function approve(world: object, name: string, expected: string): Promise<void> {
  const x = mine(world);
  const it = await itemNamed(world, name);
  const at = new Date(x.since.get(name)!.getTime() + HOUR);
  const owner = (await pool().query<{ id: string }>(
    `insert into "user" (provider, subject, github_login, role, product_owner) values ('microsoft', 'pia', 'pia', 'viewer', true)
     on conflict (provider, subject) do update set product_owner = true returning id`,
  )).rows[0].id;
  const outcome = await decideFeatureChange(
    { pool: pool(), repoHost: { commitFiles: async () => "a9900e0000000000000000000000000000000366" } },
    { itemId: it.id, userId: owner, kind: "approve", text: "", via: "comment" },
  );
  assert.equal(outcome, "applied", `the Product Owner's approval of item ${name}'s request was ${outcome}`);
  await pool().query(
    `update event set at = $2 where item_id = $1 and (kind = 'decision' or (kind = 'transition' and payload->>'event' = 'feature_change_decided'))`,
    [it.id, at],
  );
  const state = (await pool().query<{ state: string }>("select state from item where id = $1", [it.id])).rows[0].state;
  assert.equal(state, expected, `item ${name} is ${state} after the approval`);
}

Given(
  /^item "([^"]+)"(?: titled "([^"]+)")? moved to FeatureChangeRequest (\d+ (?:days?|hours?)(?: and \d+ (?:days?|hours?))?) ago(?:, then the Product Owner approved the change and it is "([^"]+)")?$/,
  long,
  async function (name: string, title: string | undefined, ago: string, approved: string | undefined) {
    await moveToFeatureChangeRequest(this, name, duration(ago), title);
    if (approved) await approve(this, name, approved);
  },
);

Given(/^item "([^"]+)" waited for an unanswered sign-off asked (\d+ (?:days?|hours?)(?: and \d+ (?:days?|hours?))?) ago$/, long, async function (name: string, ago: string) {
  const c = await factory(this);
  const x = mine(this);
  const asked = new Date(x.now.getTime() - duration(ago));
  const id = await newItem(c, name, "SignOff");
  await pool().query("insert into run (item_id, next_stage, branch) values ($1, 'sign-off', $2)", [id, `factory/pbi-${name}-r1`]);
  await pool().query("insert into question (item_id, kind, body, asked_at) values ($1, 'sign_off', 'Sign off the scenarios.', $2)", [id, asked]);
  x.since.set(name, asked);
});

Given(/^item "([^"]+)"'s sign-off was asked (\d+ (?:days?|hours?)(?: and \d+ (?:days?|hours?))?) ago and answered (\d+ (?:days?|hours?)(?: and \d+ (?:days?|hours?))?) ago$/,
  long, async function (name: string, asked: string, answered: string) {
    const it = await itemNamed(this, name);
    const now = mine(this).now.getTime();
    await pool().query(
      "insert into question (item_id, kind, body, asked_at, answer, answered_at) values ($1, 'sign_off', 'Sign off the scenarios.', $2, 'approve', $3)",
      [it.id, new Date(now - duration(asked)), new Date(now - duration(answered))],
    );
  });

Given("item {string} is queued with priority {int}", long, async function (name: string, priority: number) {
  const id = await newItem(await factory(this), name, "Queued");
  await pool().query("update item set board_priority = $2 where id = $1", [id, priority]);
});

/** Ticks the scheduler at each day mark after the named items started waiting, then puts the clock back. */
async function remindersAt(world: object, names: string[], days: number[]): Promise<void> {
  const c = await factory(world);
  const x = mine(world);
  const marks = new Set<number>();
  for (const name of names) {
    const since = x.since.get(name);
    assert.ok(since, `item ${name} isn't waiting`);
    for (const d of days) marks.add(since.getTime() + d * DAY + MIN);
  }
  const back = c.now;
  for (const at of [...marks].sort((a, b) => a - b)) {
    c.now = new Date(at);
    await tick(c);
  }
  c.now = back;
}

Given("item {string} got its day-{int} reminder", long, async function (name: string, day: number) {
  await remindersAt(this, [name], [day]);
});

Given("item {string} got its day-{int} and day-{int} reminders", long, async function (name: string, a: number, b: number) {
  await remindersAt(this, [name], [a, b]);
});

Given("both items got their day-{int} and day-{int} reminders", long, async function (a: number, b: number) {
  await remindersAt(this, [...mine(this).since.keys()], [a, b]);
});

// ---- the scheduler ----

When("the scheduler ticks three times", long, async function () {
  const c = await factory(this);
  for (let i = 0; i < 3; i++) await tick(c);
});

When("{int} more days pass and the scheduler ticks again", long, async function (days: number) {
  const c = await factory(this);
  c.now = new Date((c.now ?? mine(this).now).getTime() + days * DAY);
  await tick(c);
});

When("the scheduler ticks and a viewer opens Floor", long, async function () {
  await tick(await factory(this));
  await openFloor(this, "dashboard");
});

// ---- opening the pages ----

const whereOf = (text: string): Where => (text === "the SPA" ? "spa" : "dashboard");
// PBI 131's dashboard renders the SPA's own pages too, so both link an item's Run detail at /runs/<id>.
const detailPath = (_where: Where, id: string) => `/runs/${encodeURIComponent(id)}`;

/** The id of item `name`, made by these steps or another feature's. */
function idOf(world: object, name: string): string {
  const it = issueCtx(world).items.find((i) => i.ext === name);
  const id = it?.id ?? p17(world).items[name];
  assert.ok(id, `no item "${name}"`);
  return id;
}

function idByTitle(world: object, title: string): string {
  const it = issueCtx(world).items.find((i) => i.title === title);
  assert.ok(it, `no item titled "${title}"`);
  return it.id;
}

/** The API on this database, answering the SPA's shell as the BFF passes its reads through. */
async function spaApi(world: object): Promise<ReturnType<typeof apiApp>> {
  const x = mine(world);
  if (x.api) return x.api;
  await pool().query(
    `insert into "user" (issuer, subject, github_login, role) values ($1, 'spa-viewer', 'spa-viewer', 'viewer') on conflict do nothing`, [ISSUER]);
  x.api = apiApp({
    pool: pool(), issuer: ISSUER, audience: "factory-api", webhookSecret: "pbi-366-webhook", readBlob: async () => null, env: {},
    now: () => x.now, verify: async () => ({ issuer: ISSUER, subject: "spa-viewer" }),
  });
  const app = x.api.app;
  const c = p279(world);
  c.now = x.now;
  c.fetchHook = (method, path) => {
    if (method !== "GET" || !(path === "/bff/v1/floor" || /^\/bff\/v1\/items\/[^/]+$/.test(path))) return undefined;
    // The shell awaits what the hook gives back, so the API's answer stands in for the stub's.
    return app.request(path.slice("/bff".length), { headers: { authorization: "Bearer pbi-366" } }) as unknown as Response;
  };
  return x.api;
}

/** Sets the Run detail path PBI 145's steps read Floor's rows by, for the page last opened. */
function pointRunDetail(world: object, where: Where): void {
  (world as { runDetailPath?: (id: string) => string }).runDetailPath = (id) => detailPath(where, id);
}

async function openFloor(world: object, where: Where): Promise<Page> {
  const x = mine(world);
  if (where === "dashboard") {
    await openDashboard(world, "/");
    const status = issueCtx(world).status;
    const html = issueCtx(world).page ?? "";
    x.floor = { where, ok: status === 200, html, why: `the dashboard answered ${status}: ${html.slice(0, 300)}` };
  } else {
    await spaApi(world);
    await openSpa(world, "floor");
    const c = p279(world);
    x.floor = { where, ok: !!c.tree, html: c.html, why: c.error ?? "nothing rendered" };
  }
  pointRunDetail(world, where);
  return x.floor;
}

async function openDetail(world: object, name: string, where: Where): Promise<Page> {
  const x = mine(world);
  const id = idOf(world, name);
  let p: Page;
  if (where === "dashboard") {
    await openDashboard(world, `/items/${id}`);
    const status = issueCtx(world).status;
    const html = issueCtx(world).page ?? "";
    p = { where, ok: status === 200, html, why: `the dashboard answered ${status}: ${html.slice(0, 300)}` };
  } else {
    await spaApi(world);
    const c = p279(world);
    c.ext = name;
    c.items.set(name, { item: { id } } as ItemData);
    await openSpa(world, "item");
    p = { where, ok: !!c.tree, html: c.html, why: c.error ?? "nothing rendered" };
  }
  x.details.set(name, p);
  return p;
}

When(/^a viewer opens Floor on (the dashboard|the SPA)$/, long, async function (where: string) {
  await openFloor(this, whereOf(where));
});

When(/^a viewer opens item "([^"]+)"'s Run detail on (the dashboard|the SPA)$/, long, async function (name: string, where: string) {
  await openDetail(this, name, whereOf(where));
});

// ---- reading Floor ----

/** The Floor page last opened: by these steps, or by PBI 131's "a viewer opens Floor". */
function floorPage(world: object): Page {
  const x = mine(world);
  if (x.floor) return x.floor;
  return { where: "dashboard", ok: true, html: dashboardPage(world) };
}

function opened(p: Page, what: string): string {
  assert.ok(p.ok, `${what} didn't open: ${p.why}`);
  return p.html;
}

/** The rows of the "Waiting on you" section, each the html inside its <li>. */
function waitingRows(world: object, place: string): { html: string; where: Where } {
  assert.equal(place, "Waiting on you", `unknown Floor place "${place}"`);
  const p = floorPage(world);
  return { html: scope(opened(p, "Floor"), `"${place}"`), where: p.where };
}

function rowOf(world: object, place: string, title: string): string | null {
  const { html, where } = waitingRows(world, place);
  const href = `href="${detailPath(where, idByTitle(world, title))}"`;
  const rows = [...html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => m[1]).filter((r) => r.includes(href));
  assert.ok(rows.length <= 1, `"${place}" has ${rows.length} rows for "${title}"`);
  return rows[0] ?? null;
}

function row(world: object, place: string, title: string): string {
  const r = rowOf(world, place, title);
  assert.ok(r !== null, `"${place}" doesn't list "${title}": ${placeText(render(waitingRows(world, place).html))}`);
  return r;
}

const rowText = (html: string) => render(html).text.replace(/\s+/g, " ").trim();

Then("{string} lists {string}", function (place: string, title: string) {
  row(this, place, title);
});

Then("{string} doesn't list {string}", function (place: string, title: string) {
  const r = rowOf(this, place, title);
  assert.equal(r, null, `"${place}" lists "${title}": ${r === null ? "" : rowText(r)}`);
});

Then("{string} shows {string} as waiting {string}", function (place: string, title: string, howLong: string) {
  const m = /^(\d+) (d|h|min)$/.exec(howLong);
  assert.ok(m, `"${howLong}" isn't an age such as "3 h" or "7 d"`);
  const unit = { d: "d(?:ays?)?", h: "h(?:ours?)?", min: "min(?:utes?)?" }[m[2] as "d" | "h" | "min"];
  const text = rowText(row(this, place, title));
  assert.match(text, new RegExp(`waiting ${m[1]} ?${unit}(?![\\p{L}])`, "u"), `"${title}" on "${place}" doesn't show it as waiting ${howLong}: ${text}`);
});

Then("{string} shows {string} as waiting on the Product Owner", function (place: string, title: string) {
  const text = rowText(row(this, place, title));
  assert.match(text, /waiting on the Product Owner/i, `"${title}" on "${place}" isn't shown as waiting on the Product Owner: ${text}`);
});

Then("{string} doesn't show {string} as waiting on the Product Owner's decision on a feature change request", function (place: string, title: string) {
  const text = rowText(row(this, place, title));
  assert.doesNotMatch(text, /feature change request/i, `"${title}" on "${place}" is shown as waiting on a feature change request: ${text}`);
});

function linksIn(html: string, text: string): string[] {
  return render(html).links.filter((l) => l.text === text).map((l) => l.href);
}

Then("{string} shows a {string} link for {string}", function (place: string, text: string, title: string) {
  const r = row(this, place, title);
  const hrefs = linksIn(r, text);
  assert.equal(hrefs.length, 1, `"${place}" has ${hrefs.length} "${text}" links for "${title}": ${JSON.stringify(render(r).links)}`);
  mine(this).link = { href: hrefs[0], where: floorPage(this).where };
});

Then("{string} shows no {string} link for {string}", function (place: string, text: string, title: string) {
  const r = row(this, place, title);
  assert.deepEqual(linksIn(r, text), [], `"${place}" shows a "${text}" link for "${title}"`);
});

/** Fails unless `fragment` names an element of `html` at which the page's text starts with `section`. */
function sectionAt(html: string, fragment: string, section: string): void {
  assert.ok(fragment, "the link names no section of the page");
  const id = decodeURIComponent(fragment);
  const at = [...html.matchAll(/<[a-z][\w-]*\b[^>]*\bid="([^"]*)"[^>]*>/gi)].find((m) => m[1] === id);
  assert.ok(at, `the page has no element with the id "${id}"`);
  const text = render(html.slice(at.index)).text.replace(/\s+/g, " ").trim();
  assert.ok(text.startsWith(section), `the element "#${id}" isn't the "${section}" section: it starts "${text.slice(0, 80)}"`);
}

Then("the link goes to the {string} section of item {string}'s Run detail", long, async function (section: string, name: string) {
  const x = mine(this);
  assert.ok(x.link, "no link was read yet");
  const { href, where } = x.link;
  const hash = href.indexOf("#");
  const path = hash < 0 ? href : href.slice(0, hash);
  assert.equal(path, detailPath(where, idOf(this, name)), `the "${LINK}" link goes to ${href}, not item ${name}'s Run detail`);
  const floor = x.floor;
  const detail = await openDetail(this, name, where);
  sectionAt(opened(detail, "Run detail"), hash < 0 ? "" : href.slice(hash + 1), section);
  // The steps that follow read Floor again, through PBI 131's and PBI 145's page.
  if (floor) {
    x.floor = floor;
    recordResponse(this, floor.ok ? 200 : 500, floor.html);
    pointRunDetail(this, floor.where);
  }
});

// ---- reading Run detail ----

function lastDetail(world: object): Page {
  const all = [...mine(world).details.values()];
  const p = all.at(-1);
  assert.ok(p, "no Run detail was opened");
  return p;
}

function stateLine(html: string, state: string): string {
  const lines = [...scope(html, "the page").matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => m[1]).filter((l) => rowText(l).startsWith(state));
  assert.equal(lines.length, 1, `Run detail has ${lines.length} lines that start with "${state}"`);
  return lines[0];
}

Then("the line with the item's state {string} says it waits on the Product Owner", function (state: string) {
  const text = rowText(stateLine(opened(lastDetail(this), "Run detail"), state));
  assert.match(text, /wait(?:s|ing) on the Product Owner/i, `the line with the item's state doesn't say it waits on the Product Owner: ${text}`);
});

Then("that line shows a {string} link to the page's {string} section", function (text: string, section: string) {
  const html = opened(lastDetail(this), "Run detail");
  const line = stateLine(html, "FeatureChangeRequest");
  const hrefs = linksIn(line, text);
  assert.equal(hrefs.length, 1, `the line with the item's state has ${hrefs.length} "${text}" links: ${JSON.stringify(render(line).links)}`);
  const href = hrefs[0];
  const hash = href.indexOf("#");
  assert.ok(hash >= 0, `the "${text}" link goes to ${href}, not a section of the page`);
  const path = href.slice(0, hash);
  const p = lastDetail(this);
  const self = [...mine(this).details.entries()].find(([, v]) => v === p)![0];
  assert.ok(path === "" || path === detailPath(p.where, idOf(this, self)), `the "${text}" link goes to ${href}, another page`);
  sectionAt(html, href.slice(hash + 1), section);
});

/** The page's section under the <h2> that reads `name`, up to the next <h2>. */
function sectionOf(html: string, name: string): string {
  const heads = [...html.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)];
  const at = heads.findIndex((h) => rowText(h[1]) === name);
  assert.ok(at >= 0, `the page has no "${name}" section: its sections are ${heads.map((h) => `"${rowText(h[1])}"`).join(", ") || "none"}`);
  const start = heads[at].index! + heads[at][0].length;
  const end = heads[at + 1]?.index ?? html.length;
  return html.slice(start, end);
}

Then("the page's {string} section shows {string}", function (name: string, want: string) {
  const text = rowText(sectionOf(opened(lastDetail(this), "Run detail"), name));
  assert.ok(text.includes(want), `the "${name}" section doesn't show "${want}": ${text.slice(0, 400)}`);
});

function detailOf(world: object, name: string): string {
  const p = mine(world).details.get(name);
  assert.ok(p, `item ${name}'s Run detail wasn't opened`);
  return opened(p, `item ${name}'s Run detail`);
}

Then("item {string}'s Run detail has no {string} link", function (name: string, text: string) {
  assert.deepEqual(linksIn(scope(detailOf(this, name), "the page"), text), [], `item ${name}'s Run detail has a "${text}" link`);
});

Then("item {string}'s Run detail has a {string} link", function (name: string, text: string) {
  const html = scope(detailOf(this, name), "the page");
  assert.ok(linksIn(html, text).length > 0, `item ${name}'s Run detail has no "${text}" link: ${JSON.stringify(render(html).links)}`);
});

// ---- reading the board ----

async function remindersOn(world: object, name: string): Promise<string[]> {
  const c = await factory(world);
  const id = idOf(world, name);
  const ext = (await pool().query<{ external_id: string }>("select external_id from item where id = $1", [id])).rows[0].external_id;
  const board = c.backlog as unknown as { comments(id: string): Promise<string[]> };
  const all = await board.comments(ext);
  const reminders = all.filter((b) => /\breminder\b/i.test(b));
  mine(world).reminders = reminders;
  return reminders;
}

async function hasReminders(world: object, name: string, n: number): Promise<void> {
  const reminders = await remindersOn(world, name);
  assert.equal(reminders.length, n, `item ${name} has ${reminders.length} reminder comments, not ${n}: ${JSON.stringify(reminders)}`);
  for (const r of reminders) {
    assert.match(r, /Product Owner/, `a reminder on item ${name} doesn't say it waits on the Product Owner: ${r}`);
    assert.match(r, /feature change request/i, `a reminder on item ${name} doesn't say it waits on its feature change request: ${r}`);
  }
}

const WAITS = "that it still waits on the Product Owner's decision on its feature change request";

Then(`item {string} on the board has one reminder comment ${WAITS}`, long, async function (name: string) {
  await hasReminders(this, name, 1);
});

Then(`item {string} on the board has exactly one reminder comment ${WAITS}`, long, async function (name: string) {
  await hasReminders(this, name, 1);
});

Then(`item {string} on the board has two reminder comments ${WAITS}`, long, async function (name: string) {
  await hasReminders(this, name, 2);
});

Then(`item {string} on the board has exactly two reminder comments ${WAITS}`, long, async function (name: string) {
  await hasReminders(this, name, 2);
});

Then("item {string} on the board has no reminder comment", long, async function (name: string) {
  const reminders = await remindersOn(this, name);
  assert.deepEqual(reminders, [], `item ${name} has reminder comments`);
});

function noneSaysAbandoned(world: object, n: number): void {
  const reminders = mine(world).reminders;
  assert.ok(reminders && reminders.length === n, `${n} reminders weren't read yet`);
  for (const r of reminders) assert.doesNotMatch(r, /abandon/i, `a reminder says the item will be abandoned: ${r}`);
}

Then("that reminder doesn't say the item will be abandoned", function () {
  noneSaysAbandoned(this, 1);
});

Then("neither reminder says the item will be abandoned", function () {
  noneSaysAbandoned(this, 2);
});

// ---- the item's history ----

Then("item {string} has never been moved to Abandoned", long, async function (name: string) {
  const moves = await pool().query(
    "select 1 from event where item_id = $1 and kind in ('transition', 'override') and payload->>'to' = 'Abandoned'", [idOf(this, name)]);
  assert.equal(moves.rowCount, 0, `item ${name} was moved to Abandoned`);
});
