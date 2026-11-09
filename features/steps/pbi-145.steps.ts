// Step definitions for features/pbi-145-in-review-pr-link.feature. They build on PBI 131's steps: its Background step
// makes the item in a GitHub repo, its "a viewer opens Floor" and "a viewer opens the item's Run detail" serve the real
// dashboard on PBI 4's shared test database, and its "{string} links to {string}" and "the page has no link to
// {string}" read the page. Its hooks run only for its own scenarios, so this feature has its own.
//
// The page's contract these steps read: a PR link is an <a href> whose text is just "PR #N". On Floor, an item's row is
// the <li> under "Waiting on you", or the <tr> in the "In flight" table, that holds the link to its Run detail. On Run
// detail, the line with the item's state is the <p> whose text starts with the state.
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { ItemState } from "../../src/core/states.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";
import { ctx as issueCtx, inGitHubRepo, issueHref, open, page, placeText, render, scope, type Rendered } from "./pbi-131.steps.ts";

const pool = () => need().pool;
const REPO = "acme/widgets";

type Item = ReturnType<typeof issueCtx>["items"][number];

Before({ tags: "@pbi-145 and @db", ...long }, async function () {
  const d = await testDb();
  if (d) await d.pool.query('truncate item, event, backlog_source, repo, "user", override cascade');
});

After({ tags: "@pbi-145", ...long }, async function () {
  const s = (this as { pbi131?: { server?: Server; close?: () => Promise<void> } }).pbi131;
  if (!s) return;
  await s.close?.();
  if (s.server) {
    s.server.closeAllConnections();
    await new Promise<void>((resolve) => s.server!.close(() => resolve()));
  }
});

// ---- the items and their runs ----

/** The Background's item, which the scenarios call "the item". */
function theItem(world: object): Item {
  const it = issueCtx(world).items[0];
  assert.ok(it, "no item was set up");
  return it;
}

function byTitle(world: object, title: string): Item {
  const it = issueCtx(world).items.find((i) => i.title === title);
  assert.ok(it, `no item titled "${title}"`);
  return it;
}

async function setState(it: Item, state: ItemState): Promise<void> {
  await pool().query("update item set state = $2 where id = $1", [it.id, state]);
}

/** The item's runs so far, so a new run numbers after them. */
async function runs(it: Item): Promise<number> {
  return (await pool().query<{ n: number }>("select count(*)::int as n from run where item_id = $1", [it.id])).rows[0].n;
}

/** Moves the item to InReview, as pr_opened does, with an open run holding the PR's number and address. */
async function inReview(it: Item, prNumber: number, prUrl: string | null): Promise<void> {
  await setState(it, "InReview");
  const n = (await runs(it)) + 1;
  await pool().query(
    `insert into run (item_id, repo_id, run_number, started_at, next_stage, branch, pr_number, pr_url)
     values ($1, $2, $3, now() - interval '1 hour', 'review', $4, $5, $6)`,
    [it.id, it.repoId, n, `factory/pbi-${it.ext}-r${n}`, prNumber, prUrl],
  );
  await pool().query(
    "insert into event (actor, actor_id, item_id, kind, payload) values ('system', 'pbi-145', $1, 'transition', $2)",
    [it.id, JSON.stringify({ from: "InProgress", to: "InReview", event: "pr_opened" })],
  );
}

Given("the item is InReview", long, async function () {
  // The open run comes with "its open run holds PR number ...", which follows.
  await setState(theItem(this), "InReview");
});

Given("its open run holds PR number {int} at {string}", long, async function (n: number, url: string) {
  await inReview(theItem(this), n, url);
});

Given("the item is InReview, and its open run holds PR number {int} at {string}", long, async function (n: number, url: string) {
  await inReview(theItem(this), n, url);
});

Given("the item is InReview, and its open run holds PR number {int} but no PR address", long, async function (n: number) {
  await inReview(theItem(this), n, null);
});

Given("item {string} titled {string} is InReview, and its open run holds PR number {int} at {string}",
  long, async function (ext: string, title: string, n: number, url: string) {
    await inReview(await inGitHubRepo(issueCtx(this), ext, title, REPO), n, url);
  });

Given("item {string} titled {string} waits for sign-off", long, async function (ext: string, title: string) {
  const it = await inGitHubRepo(issueCtx(this), ext, title, REPO);
  await setState(it, "SignOff");
  await pool().query("insert into run (item_id, repo_id, next_stage, branch) values ($1, $2, 'red', $3)", [it.id, it.repoId, `factory/pbi-${ext}-r1`]);
  await pool().query("insert into question (item_id, kind, body) values ($1, 'sign_off', 'Sign off the scenarios.')", [it.id]);
});

Given("the item had an earlier run, now ended, that held PR number {int} at {string}", long, async function (n: number, url: string) {
  const it = theItem(this);
  await pool().query(
    `insert into run (item_id, repo_id, run_number, started_at, ended_at, outcome, branch, pr_number, pr_url)
     values ($1, $2, $3, now() - interval '3 days', now() - interval '2 days', 'failed', $4, $5, $6)`,
    [it.id, it.repoId, (await runs(it)) + 1, `factory/pbi-${it.ext}-r0`, n, url],
  );
});

// ---- opening Run detail by title, through PBI 131's dashboard ----

When("a viewer opens the Run detail of {string}", long, async function (title: string) {
  await open(this, `/items/${byTitle(this, title).id}`);
});

// ---- reading the page ----

const FLOOR_PLACE = `(Floor's "Waiting on you"|"Waiting on you"|Floor's "In flight" table|the "In flight" table)`;

/** The Floor section a place names, as PBI 131's scope reads it. */
function section(place: string): string {
  return /In flight/.test(place) ? `"In flight"` : `"Waiting on you"`;
}

/** The html of the item's row in a Floor section: the <li> or <tr> holding the link to its Run detail. */
function row(world: object, place: string, it: Item): string {
  const html = scope(page(world), section(place));
  const tag = /In flight/.test(place) ? "tr" : "li";
  const rows = [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi"))].map((m) => m[1]);
  const mine = rows.filter((r) => r.includes(`href="/items/${it.id}"`));
  assert.equal(mine.length, 1, `${place} has ${mine.length} rows for "${it.title}": ${placeText(render(html))}`);
  return mine[0];
}

/** The links in a piece of html whose text is just a PR number, "PR #N". */
function prLinks(r: Rendered): { href: string; text: string }[] {
  return r.links.filter((l) => /^PR #\d+$/.test(l.text));
}

/** The href of the "PR #N" link in the item's row on a Floor place, failing when there's none or several. */
function prHref(world: object, place: string, it: Item, n: string): string {
  const r = render(row(world, place, it));
  assert.ok(r.text.includes(n), `${place} doesn't show "${n}" for "${it.title}": ${placeText(r)}`);
  const own = r.links.filter((l) => l.text === n);
  assert.equal(own.length, 1, `${place} has ${own.length} links that hold just "${n}" for "${it.title}": ${JSON.stringify(r.links)}`);
  return own[0].href;
}

Then(new RegExp(`^${FLOOR_PLACE} shows "(PR #\\d+)" for the item$`), function (place: string, n: string) {
  prHref(this, place, theItem(this), n);
});

Then(new RegExp(`^${FLOOR_PLACE} shows "(PR #\\d+)" for the item as its own link$`), function (place: string, n: string) {
  const it = theItem(this);
  prHref(this, place, it, n);
  // Its own link: no other text, the issue number or the title, sits in the PR's link.
  const r = render(row(this, place, it));
  const pr = r.links.find((l) => l.text === n)!;
  for (const l of r.links.filter((l) => l.href === pr.href)) assert.equal(l.text, n, `the PR link holds "${l.text}"`);
});

Then(new RegExp(`^${FLOOR_PLACE} shows "(PR #\\d+)" for "([^"]*)"$`), function (place: string, n: string, title: string) {
  prHref(this, place, byTitle(this, title), n);
});

Then(new RegExp(`^${FLOOR_PLACE} shows "(PR #\\d+)" for the item, linked to "([^"]*)"$`), function (place: string, n: string, url: string) {
  assert.equal(prHref(this, place, theItem(this), n), url, `"${n}" on ${place} doesn't link to ${url}`);
});

Then(new RegExp(`^${FLOOR_PLACE} shows "(PR #\\d+)" for "([^"]*)", linked to "([^"]*)"$`), function (place: string, n: string, title: string, url: string) {
  assert.equal(prHref(this, place, byTitle(this, title), n), url, `"${n}" for "${title}" on ${place} doesn't link to ${url}`);
});

Then(new RegExp(`^${FLOOR_PLACE} shows no PR link for "([^"]*)"$`), function (place: string, title: string) {
  const r = render(row(this, place, byTitle(this, title)));
  assert.deepEqual(prLinks(r), [], `${place} shows a PR link for "${title}"`);
  assert.ok(!/PR #\d+/.test(r.text), `${place} shows a PR number for "${title}": ${placeText(r)}`);
});

Then("on {string}, the {string} link for {string} goes to {string}", function (place: string, n: string, title: string, url: string) {
  assert.equal(prHref(this, `"${place}"`, byTitle(this, title), n), url, `"${n}" for "${title}" doesn't link to ${url}`);
});

Then("{string} in the {string} table links to {string}", function (n: string, place: string, url: string) {
  assert.equal(prHref(this, `the "${place}" table`, theItem(this), n), url, `"${n}" in the "${place}" table doesn't link to ${url}`);
});

Then("{string} and the {string} table each show {string} for the item", function (a: string, b: string, n: string) {
  const it = theItem(this);
  const hrefs = [prHref(this, `"${a}"`, it, n), prHref(this, `the "${b}" table`, it, n)];
  (this as { pbi145?: { hrefs?: string[] } }).pbi145 = { hrefs };
});

Then("both links go to {string}", function (url: string) {
  const hrefs = (this as { pbi145?: { hrefs?: string[] } }).pbi145?.hrefs;
  assert.ok(hrefs?.length === 2, "no two links were read yet");
  for (const h of hrefs) assert.equal(h, url, `a "PR #N" link goes to ${h}`);
});

Then("{string} on {string} still links to {string}", function (n: string, place: string, url: string) {
  assert.equal(issueHref(this, `"${place}"`, n, theItem(this).title), url, `"${n}" on "${place}" doesn't link to ${url}`);
});

Then("{string} on {string} still links to the item's Run detail", function (title: string, place: string) {
  const it = theItem(this);
  const r = render(row(this, `"${place}"`, it));
  const own = r.links.filter((l) => l.text === title);
  assert.equal(own.length, 1, `"${place}" has ${own.length} links that hold just "${title}": ${JSON.stringify(r.links)}`);
  assert.equal(own[0].href, `/items/${it.id}`, `"${title}" links to ${own[0].href}`);
});

/** Run detail's line with the item's state: the <p> whose text starts with it. */
function stateLine(world: object, state = "InReview"): Rendered {
  const html = scope(page(world), "the page");
  const lines = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => render(m[1])).filter((r) => r.text.trim().startsWith(state));
  assert.equal(lines.length, 1, `Run detail has ${lines.length} lines that start with "${state}"`);
  return lines[0];
}

function stateLineLink(world: object, n: string): string {
  const r = stateLine(world);
  assert.ok(r.text.includes(n), `the line with the item's state doesn't show "${n}": ${placeText(r)}`);
  const own = r.links.filter((l) => l.text === n);
  assert.equal(own.length, 1, `the line with the item's state has ${own.length} links that hold just "${n}": ${JSON.stringify(r.links)}`);
  return own[0].href;
}

Then("the line with the item's state {string} shows {string}", function (state: string, n: string) {
  const r = stateLine(this, state);
  assert.ok(r.text.includes(n), `the line with "${state}" doesn't show "${n}": ${placeText(r)}`);
  stateLineLink(this, n);
});

Then(/^the line with (?:the item's|its) state shows "(PR #\d+)" linked to "([^"]*)"$/, function (n: string, url: string) {
  assert.equal(stateLineLink(this, n), url, `"${n}" on the line with the state doesn't link to ${url}`);
});

Then("the line with its state shows {string} and no PR link", function (state: string) {
  const r = stateLine(this, state);
  assert.deepEqual(prLinks(r), [], "the line with the state shows a PR link");
  assert.ok(!/PR #\d+/.test(r.text), `the line with the state shows a PR number: ${placeText(r)}`);
});

Then("the heading still shows {string} linked to {string}", function (n: string, url: string) {
  assert.equal(issueHref(this, "the Run detail heading", n, theItem(this).title), url, `the heading's "${n}" doesn't link to ${url}`);
});

Then("the page doesn't show {string}", function (text: string) {
  const r = render(scope(page(this), "the page"));
  assert.ok(!r.text.includes(text), `the page shows "${text}"`);
});

Then("{string} links to exactly {string}", function (n: string, url: string) {
  const r = render(scope(page(this), "the page"));
  const own = r.links.filter((l) => l.text === n);
  assert.ok(own.length > 0, `the page has no link that holds just "${n}": ${JSON.stringify(r.links)}`);
  for (const l of own) assert.equal(l.href, url, `"${n}" links to ${l.href}`);
});

Then("the page has no bold element from the PR address", function () {
  assert.doesNotMatch(scope(page(this), "the page"), /<b\b/i, "the page holds a <b> element");
});
