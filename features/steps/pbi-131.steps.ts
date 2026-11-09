// Step definitions for features/pbi-131-issue-links.feature. The dashboard runs as the real node:http server on a
// free port, in Azure mode, on PBI 4's shared test database, and a viewer signs in with the headers Container Apps adds.
//
// An item's repo is set up the way migrate-cli seeds it: a `repo` row whose url is https://github.com/<owner>/<repo>,
// and a board (backlog_source) whose repo_map names that repo. An item with a run also points its run at the repo.
// A board mapping to no repo has an empty repo_map; a repo not on GitHub has another host_adapter and url.
//
// "a viewer opens the activity log" is PBI 105's step. It records its page through PBI 19's recordResponse, which
// these steps read back, and its server is closed here, since PBI 105's After only runs for its own scenarios.
//
// The page's contract these steps read: a place is a Floor section (the content after its <h2> up to the next <h2>),
// the Run detail <h1>, or <main> for the Phase 0 report and the activity log. The issue number shows in the page's
// text as "#N", with only spaces, markup and punctuation characters between it and the title, and a link is an <a href>.
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fakeBacklog } from "../../src/adapters/fake.ts";
import { createAuth } from "../../src/http/auth.ts";
import { dashboardRoutes } from "../../src/http/routes.ts";
import { startServer } from "../../src/http/server.ts";
import type { ItemState } from "../../src/core/states.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";
import { recordResponse } from "./pbi-19.steps.ts";

export type Item = { id: string; ext: string; title: string; sourceId: string; repoId: string | null };
export type Ctx = {
  server?: Server;
  close?: () => Promise<void>;
  origin?: string;
  items: Item[];
  /** Boards by the repos they map to, so two items in one repo share a board. */
  boards: Map<string, string>;
  status?: number;
  page?: string;
  /** The place and title the last "shows ... before ..." step checked, for a following "is not a link". */
  last?: { scope: string; n: string; title: string };
};

export function ctx(world: object): Ctx {
  const w = world as { pbi131?: Ctx };
  w.pbi131 ??= { items: [], boards: new Map() };
  return w.pbi131;
}

const pool = () => need().pool;
const headers = (login: string) => ({ "x-ms-client-principal-idp": "aad", "x-ms-client-principal-id": login, "x-ms-client-principal-name": login });
const GITHUB_ISSUE = /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\//;

Before({ tags: "@pbi-131 and @db", ...long }, async function () {
  const d = await testDb();
  if (d) await d.pool.query('truncate item, event, backlog_source, repo, "user", override cascade');
});

After({ tags: "@pbi-131", ...long }, async function () {
  // This feature's own server, and PBI 105's when its activity log step opened one.
  const w = this as { pbi131?: Ctx; pbi105?: { server?: Server; close?: () => Promise<void> } };
  for (const s of [w.pbi131, w.pbi105]) {
    if (!s) continue;
    await s.close?.();
    if (s.server) {
      s.server.closeAllConnections();
      await new Promise<void>((resolve) => s.server!.close(() => resolve()));
    }
  }
});

// ---- the boards, repos and items ----

async function repoRow(url: string, host = "github"): Promise<string> {
  return (await pool().query<{ id: string }>(
    "insert into repo (host_adapter, url) values ($1, $2) on conflict (url) do update set host_adapter = excluded.host_adapter returning id",
    [host, url],
  )).rows[0].id;
}

/** A board mapping each of `repos` (owner/name to repo id), made once per set of repos. */
async function board(c: Ctx, repos: [name: string, id: string][]): Promise<string> {
  const key = repos.map(([n]) => n).sort().join(",");
  const known = c.boards.get(key);
  if (known) return known;
  const id = (await pool().query<{ id: string }>(
    "insert into backlog_source (adapter, url, repo_map) values ('github', 'pbi-131:' || gen_random_uuid(), $1) returning id",
    [JSON.stringify(Object.fromEntries(repos))],
  )).rows[0].id;
  c.boards.set(key, id);
  return id;
}

/** `stored` is the repo intake took from the item's issue, as owner/name (PBI 137). */
async function addItem(c: Ctx, ext: string, title: string, sourceId: string, repoId: string | null, stored: string | null = null): Promise<Item> {
  const id = (await pool().query<{ id: string }>(
    "insert into item (source_id, external_id, title, state, repo) values ($1, $2, $3, 'Eligible', $4) returning id",
    [sourceId, ext, title, stored],
  )).rows[0].id;
  const it = { id, ext, title, sourceId, repoId };
  c.items.push(it);
  return it;
}

async function inGitHubRepo(c: Ctx, ext: string, title: string, fullName: string): Promise<Item> {
  const repoId = await repoRow(`https://github.com/${fullName}`);
  // An issue in a repo has that repo stored at intake, so "#N" links to it even before a run names it.
  return addItem(c, ext, title, await board(c, [[fullName, repoId]]), repoId, fullName);
}

function lastItem(c: Ctx): Item {
  const it = c.items.at(-1);
  assert.ok(it, "no item was set up");
  return it;
}

async function setState(it: Item, state: ItemState): Promise<void> {
  await pool().query("update item set state = $2 where id = $1", [it.id, state]);
}

/** An open run, pointing at the item's repo when it has one. */
async function openRun(it: Item): Promise<string> {
  return (await pool().query<{ id: string }>(
    "insert into run (item_id, repo_id, next_stage, branch) values ($1, $2, 'implement', $3) returning id",
    [it.id, it.repoId, `factory/pbi-${it.ext}-r1`],
  )).rows[0].id;
}

async function event(it: Item, kind: string, payload: object, at: string): Promise<void> {
  await pool().query("insert into event (actor, actor_id, item_id, kind, payload, at) values ('system', 'pbi-131', $1, $2, $3, $4)",
    [it.id, kind, JSON.stringify(payload), at]);
}

const STATES = ["waiting for sign-off", "queued", "not ready", "in flight", "done, with its PR merged", "just claimed"] as const;
type Setup = (typeof STATES)[number];

async function putIn(it: Item, setup: Setup): Promise<void> {
  switch (setup) {
    case "waiting for sign-off": {
      await setState(it, "SignOff");
      await openRun(it);
      await pool().query("insert into question (item_id, kind, body) values ($1, 'sign_off', 'Sign off the scenarios.')", [it.id]);
      return;
    }
    case "queued":
      return setState(it, "Queued");
    case "not ready": {
      await setState(it, "NotReady");
      await pool().query(
        "insert into policy_result (item_id, file, source, criterion_index, criterion, status, reason) values ($1, 'dor', 'default', 1, 'The item has acceptance criteria.', 'failed', 'none listed')",
        [it.id],
      );
      return;
    }
    case "in flight": {
      await setState(it, "InProgress");
      await openRun(it);
      return;
    }
    case "done, with its PR merged": {
      await setState(it, "Done");
      const run = (await pool().query<{ id: string }>(
        `insert into run (item_id, repo_id, started_at, ended_at, outcome, pr_url, pr_number, merge_sha)
         values ($1, $2, '2026-11-07T09:00:00Z', '2026-11-07T11:00:00Z', 'merged', 'https://github.com/acme/widgets/pull/7', 7, 'abc123') returning id`,
        [it.id, it.repoId],
      )).rows[0].id;
      await event(it, "transition", { from: "InReview", to: "Accepted", event: "pr_merged", runId: run }, "2026-11-07T10:00:00Z");
      return;
    }
    case "just claimed": {
      await setState(it, "InProgress");
      await openRun(it);
      await event(it, "transition", { from: "Queued", to: "InProgress", event: "claimed" }, "2026-11-07T09:00:00Z");
      return;
    }
  }
}

Given("item {string} titled {string} is an issue in the repo {string}", long, async function (ext: string, title: string, repo: string) {
  await inGitHubRepo(ctx(this), ext, title, repo);
});

Given("item {string} titled {string} and item {string} titled {string} are issues in the repo {string}",
  long, async function (ext1: string, title1: string, ext2: string, title2: string, repo: string) {
    const c = ctx(this);
    await inGitHubRepo(c, ext1, title1, repo);
    await inGitHubRepo(c, ext2, title2, repo);
  });

Given("item {string} titled {string} comes from a board that maps to no repo", long, async function (ext: string, title: string) {
  const c = ctx(this);
  await addItem(c, ext, title, await board(c, []), null);
});

Given("item {string} titled {string} comes from a board that maps to no repo, and has no run", long, async function (ext: string, title: string) {
  const c = ctx(this);
  await addItem(c, ext, title, await board(c, []), null);
});

Given("item {string} titled {string} comes from a board that maps to the repos {string} and {string}",
  long, async function (ext: string, title: string, a: string, b: string) {
    const c = ctx(this);
    const repos: [string, string][] = [[a, await repoRow(`https://github.com/${a}`)], [b, await repoRow(`https://github.com/${b}`)]];
    await addItem(c, ext, title, await board(c, repos), null);
  });

Given("item {string} titled {string} has a run in a repo that isn't hosted on GitHub", long, async function (ext: string, title: string) {
  const c = ctx(this);
  const name = "acme/widgets";
  const repoId = await repoRow(`https://gitlab.example.com/${name}`, "gitlab");
  // The run that names the repo comes with "the item is in flight".
  await addItem(c, ext, title, await board(c, [[name, repoId]]), repoId);
});

Given("the item has no run in any repo", function () {
  // The item's runs, made with its state, point at no repo, since its board maps to none or to several.
  const it = lastItem(ctx(this));
  assert.equal(it.repoId, null, "the item has a repo");
});

// "the item is not ready" is also PBI 13's Then, and Cucumber matches a step whatever its keyword, so that one
// definition calls putNotReady below and the other states match here.
Given(new RegExp(`^the item is (${STATES.filter((s) => s !== "not ready").join("|")})$`), long, async function (setup: Setup) {
  await putIn(lastItem(ctx(this)), setup);
});

/** Puts this feature's item in NotReady, for PBI 13's "the item is not ready". False when the scenario isn't this feature's. */
export async function putNotReady(world: object): Promise<boolean> {
  const c = (world as { pbi131?: Ctx }).pbi131;
  if (!c?.items.length) return false;
  await putIn(lastItem(c), "not ready");
  return true;
}

Given("both items are queued", long, async function () {
  const c = ctx(this);
  assert.equal(c.items.length, 2, `expected two items, found ${c.items.length}`);
  for (const it of c.items) await putIn(it, "queued");
});

Given("the item was claimed, then its run was stopped by an operator", long, async function () {
  const it = lastItem(ctx(this));
  await setState(it, "Failed");
  await event(it, "transition", { from: "Queued", to: "InProgress", event: "claimed" }, "2026-11-07T09:00:00Z");
  await pool().query(
    "insert into event (actor, actor_id, item_id, kind, payload, at) values ('human', 'pbi-131-operator', $1, 'override', $2, '2026-11-07T09:30:00Z')",
    [it.id, JSON.stringify({ from: "InProgress", to: "Failed", kind: "stop_run", reason: "stopped from the dashboard" })],
  );
});

Given("an item whose issue number is {string} and whose title is {string}", long, async function (ext: string, title: string) {
  const c = ctx(this);
  await putIn(await inGitHubRepo(c, ext, title, "acme/widgets"), "queued");
});

// ---- opening the pages ----

async function dashboard(c: Ctx): Promise<void> {
  if (c.server) return;
  const sourceId = c.items[0]?.sourceId ?? (await pool().query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'pbi-131:' || gen_random_uuid()) returning id")).rows[0].id;
  let handler: ReturnType<typeof dashboardRoutes> | undefined;
  c.server = await startServer([(req, res) => handler!(req, res)], { port: 0 });
  c.origin = `http://127.0.0.1:${(c.server.address() as AddressInfo).port}`;
  handler = dashboardRoutes({ pool: pool(), auth: createAuth({ mode: "azure" }), origin: c.origin, adapter: fakeBacklog().adapter, sourceId });
  c.close = handler.close;
}

async function open(world: object, path: string): Promise<void> {
  const c = ctx(world);
  await pool().query(`insert into "user" (provider, subject, github_login, role) values ('microsoft', 'viewer', 'viewer', 'viewer') on conflict (provider, subject) do nothing`);
  await dashboard(c);
  const r = await fetch(`${c.origin}${path}`, { headers: headers("viewer"), redirect: "manual" });
  c.status = r.status;
  c.page = await r.text();
  recordResponse(world, c.status, c.page);
}

When("a viewer opens Floor", long, async function () {
  await open(this, "/");
});

When("a viewer opens the item's Run detail", long, async function () {
  await open(this, `/items/${lastItem(ctx(this)).id}`);
});

When("a viewer opens the Phase 0 report", long, async function () {
  await open(this, "/phase0");
});

// ---- reading the page ----

/** The last page any of these steps or PBI 105's opened. */
function page(world: object): string {
  const w = world as { pbi131?: Ctx; pbi19?: { status?: number; page?: string } };
  const got = w.pbi19?.page !== undefined ? w.pbi19 : w.pbi131;
  assert.ok(got?.page !== undefined, "no page came back");
  assert.equal(got.status, 200, `the page answered ${got.status}: ${got.page.slice(0, 300)}`);
  return got.page;
}

const decodeEntity = (e: string): string => {
  const named: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
  if (named[e]) return named[e];
  const n = /^&#(x?)([0-9a-f]+);$/i.exec(e);
  return n ? String.fromCodePoint(parseInt(n[2], n[1] ? 16 : 10)) : e;
};

/** A place's text, character by character, with the href of the link each character sits in (or null). */
type Rendered = { text: string; hrefs: (string | null)[]; links: { href: string; text: string }[] };

function render(html: string): Rendered {
  let text = "";
  const hrefs: (string | null)[] = [];
  const links: { href: string; text: string }[] = [];
  const open: { href: string; start: number }[] = [];
  let skip = 0;
  for (const m of html.matchAll(/<[^>]*>|&[#\w]+;|[^<&]+|[<&]/g)) {
    const t = m[0];
    if (t.startsWith("<") && t.length > 1) {
      if (/^<(script|style|title)\b/i.test(t)) skip++;
      else if (/^<\/(script|style|title)>/i.test(t)) skip = Math.max(0, skip - 1);
      else if (/^<a\b/i.test(t)) {
        const href = /\bhref\s*=\s*"([^"]*)"/i.exec(t)?.[1];
        open.push({ href: href === undefined ? "" : href.replace(/&[#\w]+;/g, decodeEntity), start: text.length });
      } else if (/^<\/a\s*>/i.test(t)) {
        const a = open.pop();
        if (a && a.href) links.push({ href: a.href, text: text.slice(a.start).replace(/\s+/g, " ").trim() });
      } else if (!skip) {
        // A tag reads as a space, as a browser lays out cells and list items apart.
        text += " ";
        hrefs.push(open.at(-1)?.href || null);
      }
      continue;
    }
    if (skip) continue;
    const s = t.startsWith("&") ? decodeEntity(t) : t;
    for (const ch of s) {
      text += ch;
      hrefs.push(open.at(-1)?.href || null);
    }
  }
  return { text, hrefs, links };
}

const SECTIONS = ["Waiting on you", "Next up", "Not ready", "In flight"];

/** The html of a place on the page. */
function scope(html: string, place: string): string {
  const floor = /^(?:Floor's )?"([^"]+)"$/.exec(place)?.[1];
  if (floor) {
    assert.ok(SECTIONS.includes(floor), `unknown Floor section "${floor}"`);
    const start = html.search(new RegExp(`<h2\\b[^>]*>\\s*${floor}\\s*</h2>`, "i"));
    assert.ok(start >= 0, `the page has no "${floor}" section`);
    const rest = html.slice(start).replace(/^<h2\b[^>]*>[\s\S]*?<\/h2>/i, "");
    const end = rest.search(/<h2\b/i);
    return end < 0 ? rest : rest.slice(0, end);
  }
  if (place === "the Run detail heading") {
    const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
    assert.ok(h1, "Run detail has no <h1> heading");
    return h1[1];
  }
  if (place === "the Phase 0 report" || place === "the activity log" || place === "the page") {
    return /<main\b[^>]*>([\s\S]*)<\/main>/i.exec(html)?.[1] ?? html;
  }
  throw new Error(`unknown place ${place}`);
}

/**
 * Where "#N" shows just before `title` in the rendered place: the index of its "#", or -1. Only spaces, markup and
 * punctuation may sit between them, so the number belongs to that title and not to another item's.
 */
function numberBefore(r: Rendered, n: string, title: string, from = 0): number {
  const at = r.text.indexOf(title, from);
  if (at < 0) return -1;
  const before = r.text.slice(0, at);
  const hash = before.lastIndexOf(n);
  if (hash >= 0 && /^[\s\p{P}\p{S}]{0,12}$/u.test(before.slice(hash + n.length)) && !/[\p{L}\p{N}]/u.test(r.text[hash - 1] ?? "")) return hash;
  return numberBefore(r, n, title, at + 1);
}

/** Every occurrence of `title` in the place, each with the "#N" before it or -1. */
function occurrences(r: Rendered, n: string, title: string): number[] {
  const out: number[] = [];
  for (let at = r.text.indexOf(title); at >= 0; at = r.text.indexOf(title, at + 1)) {
    const before = r.text.slice(0, at);
    const hash = before.lastIndexOf(n);
    out.push(hash >= 0 && /^[\s\p{P}\p{S}]{0,12}$/u.test(before.slice(hash + n.length)) && !/[\p{L}\p{N}]/u.test(r.text[hash - 1] ?? "") ? hash : -1);
  }
  return out;
}

/** The single link the "#N" characters at `hash` sit in, or null when they're plain text. */
function hrefAt(r: Rendered, hash: number, n: string): string | null {
  const hs = new Set(r.hrefs.slice(hash, hash + n.length));
  assert.equal(hs.size, 1, `"${n}" is split across links: ${[...hs].join(", ")}`);
  return [...hs][0];
}

function placeText(r: Rendered): string {
  return r.text.replace(/\s+/g, " ").trim().slice(0, 600);
}

function showsBefore(world: object, place: string, n: string, title: string): number {
  const c = ctx(world);
  const r = render(scope(page(world), place));
  assert.ok(r.text.includes(title), `${place} doesn't show "${title}": ${placeText(r)}`);
  const hash = numberBefore(r, n, title);
  assert.ok(hash >= 0, `${place} doesn't show "${n}" before "${title}": ${placeText(r)}`);
  c.last = { scope: place, n, title };
  return hash;
}

export function issueHref(world: object, place: string, n: string, title: string): string | null {
  const r = render(scope(page(world), place));
  const hash = showsBefore(world, place, n, title);
  return hrefAt(r, hash, n);
}

const PLACE = `(Floor's "[^"]+"|"[^"]+"|the Run detail heading|the Phase 0 report|the activity log)`;

Then(new RegExp(`^${PLACE} shows "([^"]*)" for the item$`), function (place: string, n: string) {
  showsBefore(this, place, n, lastItem(ctx(this)).title);
});

Then("{string} comes before {string}", function (n: string, title: string) {
  const last = ctx(this).last;
  assert.ok(last, "no place was read yet");
  showsBefore(this, last.scope, n, title);
});

Then(new RegExp(`^${PLACE} shows "([^"]*)" before "([^"]*)"$`), function (place: string, n: string, title: string) {
  showsBefore(this, place, n, title);
});

Then("both of the item's rows show {string} before {string}", function (n: string, title: string) {
  const html = scope(page(this), "the activity log");
  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]).filter((row) => /<td\b/i.test(row) && render(row).text.includes(title));
  assert.equal(rows.length, 2, `expected two rows for "${title}", found ${rows.length}`);
  for (const row of rows) {
    const r = render(row);
    assert.ok(numberBefore(r, n, title) >= 0, `a row doesn't show "${n}" before "${title}": ${placeText(r)}`);
  }
});

Then("the item shows {string} as plain text", function (n: string) {
  const title = lastItem(ctx(this)).title;
  const r = render(scope(page(this), "the page"));
  const at = occurrences(r, n, title);
  assert.ok(at.some((h) => h >= 0), `the page doesn't show "${n}" before "${title}": ${placeText(r)}`);
});

Then("the page has no bold element from the issue number", function () {
  assert.doesNotMatch(scope(page(this), "the page"), /<b\b/i, "the page holds a <b> element");
});

Then(new RegExp(`^"([^"]*)" on ${PLACE} links to "([^"]*)"$`), function (n: string, place: string, url: string) {
  assert.equal(issueHref(this, place, n, lastItem(ctx(this)).title), url, `"${n}" on ${place} doesn't link to ${url}`);
});

Then("the {string} before {string} links to {string}", function (n: string, title: string, url: string) {
  assert.equal(issueHref(this, "the page", n, title), url, `the "${n}" before "${title}" doesn't link to ${url}`);
});

Then(new RegExp(`^"([^"]*)" on ${PLACE} links to the item's Run detail$`), function (title: string, place: string) {
  const it = lastItem(ctx(this));
  const r = render(scope(page(this), place));
  const at = r.text.indexOf(title);
  assert.ok(at >= 0, `${place} doesn't show "${title}": ${placeText(r)}`);
  const hs = new Set(r.hrefs.slice(at, at + title.length));
  assert.deepEqual([...hs], [`/items/${it.id}`], `"${title}" on ${place} doesn't link to /items/${it.id}`);
});

Then("{string} in {string} is its own link, to the issue on GitHub", function (n: string, section: string) {
  const r = render(scope(page(this), `"${section}"`));
  const own = r.links.filter((l) => l.text === n);
  assert.equal(own.length, 1, `"${section}" has ${own.length} links that hold just "${n}": ${JSON.stringify(r.links)}`);
  assert.match(own[0].href, GITHUB_ISSUE, `"${n}" links to ${own[0].href}`);
  assert.ok(own[0].href.endsWith(`/issues/${n.replace(/^#/, "")}`), `"${n}" links to ${own[0].href}`);
});

Then("the link to the item's Run detail holds {string} and not {string}", function (title: string, n: string) {
  const it = lastItem(ctx(this));
  const r = render(scope(page(this), "the page"));
  const detail = r.links.filter((l) => l.href === `/items/${it.id}`);
  assert.ok(detail.length > 0, `the page has no link to /items/${it.id}`);
  for (const l of detail) {
    assert.ok(l.text.includes(title), `the Run detail link holds "${l.text}"`);
    assert.ok(!l.text.includes(n), `the Run detail link holds "${n}": "${l.text}"`);
  }
});

Then("{string} is not a link", function (n: string) {
  const c = ctx(this);
  // Without a place read just before, as in PBI 137, the number is read before its item's title anywhere on the page.
  const held = c.items.find((i) => `#${i.ext}` === n);
  const last = c.last?.n === n ? c.last : held && { scope: "the page", n, title: held.title };
  assert.ok(last, `no place showed "${n}" yet`);
  assert.equal(issueHref(this, last.scope, n, last.title), null, `"${n}" before "${last.title}" is a link`);
  const r = render(scope(page(this), "the page"));
  const linked = r.links.filter((l) => l.text.includes(n));
  assert.deepEqual(linked, [], `the page links "${n}"`);
});

Then("the page has no link to an issue on GitHub", function () {
  const links = render(scope(page(this), "the page")).links.filter((l) => GITHUB_ISSUE.test(l.href));
  assert.deepEqual(links, [], "the page links to an issue on GitHub");
});

Then("the page has no link to {string}", function (url: string) {
  const links = render(scope(page(this), "the page")).links.filter((l) => l.href === url);
  assert.deepEqual(links, [], `the page links to ${url}`);
});

Then("{string} links to {string}", function (n: string, url: string) {
  const r = render(scope(page(this), "the page"));
  const own = r.links.filter((l) => l.text === n);
  assert.ok(own.length > 0, `the page has no link that holds just "${n}": ${JSON.stringify(r.links)}`);
  for (const l of own) assert.equal(l.href, url, `"${n}" links to ${l.href}`);
});

Then("{string} shows before {string} and is not a link", function (n: string, title: string) {
  const href = issueHref(this, "the page", n, title);
  assert.equal(href, null, `"${n}" before "${title}" links to ${href}`);
  const linked = render(scope(page(this), "the page")).links.filter((l) => l.text.includes(n));
  assert.deepEqual(linked, [], `the page links "${n}"`);
});
