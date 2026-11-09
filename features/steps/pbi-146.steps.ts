// Step definitions for features/pbi-146-signoff-scope.feature. The dashboard runs as the real node:http server on a
// free port, in Azure mode, on PBI 4's shared test database, with a fake board and a fake repo host. The product owner
// signs in with the headers Container Apps adds.
//
// The item is seeded on the fake board as issue "146" in octo/repo, with its body and acceptance criteria, and in the
// database with a run whose scenarios_sha and locked_files name the commit and the feature files up for sign-off. A
// file "at <sha>" is the fake repo host's content of octo/repo at that ref.
//
// The page's contract these steps read:
// - The Scope section is an <h2>Scope</h2> and the content after it up to the next <h2>. Its text is that content with
//   <br> and the ends of block elements read as line breaks, the other tags dropped and entities decoded.
// - A feature file shows under a heading (<h2> to <h4>) whose text is its path. Its section runs to the next heading of
//   any level, and the file's text shows in that section as written, line for line.
// - The criteria list is the <h2>Criteria and their scenarios</h2> section. The sign-off form is the form posting to
//   /items/<id>/signoff, and a button is a <button> whose text is its label.
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fakeBacklog, fakeRepoHost } from "../../src/adapters/fake.ts";
import { createAuth } from "../../src/http/auth.ts";
import { dashboardRoutes } from "../../src/http/routes.ts";
import { startServer } from "../../src/http/server.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";

const REPO = "octo/repo";
const OWNER = "owner-146";

type Ctx = {
  server?: Server;
  close?: () => Promise<void>;
  origin?: string;
  board: ReturnType<typeof fakeBacklog>;
  host: ReturnType<typeof fakeRepoHost>;
  sourceId?: string;
  ext?: string;
  body: string;
  criteria: string[];
  itemId?: string;
  runId?: string;
  /** The last feature file a step named, for "that file". */
  lastFile?: string;
  page?: string;
  status?: number;
};

function ctx(world: object): Ctx {
  const w = world as { pbi146?: Ctx };
  w.pbi146 ??= { board: fakeBacklog(), host: fakeRepoHost(), body: "", criteria: ["The owner signs off with the scope in view"] };
  return w.pbi146;
}

const pool = () => need().pool;
const headers = (login: string) => ({ "x-ms-client-principal-idp": "aad", "x-ms-client-principal-id": login, "x-ms-client-principal-name": login });

Before({ tags: "@pbi-146 and @db", ...long }, async function () {
  const d = await testDb();
  if (d) await d.pool.query('truncate item, event, backlog_source, repo, "user", override cascade');
});

After({ tags: "@pbi-146", ...long }, async function () {
  const c = (this as { pbi146?: Ctx }).pbi146;
  if (!c) return;
  await c.close?.();
  if (c.server) {
    c.server.closeAllConnections();
    await new Promise<void>((resolve) => c.server!.close(() => resolve()));
  }
});

// ---- the feature files ----

/** A feature with a description, a rule and two scenarios, tagged for this item. */
function featureText(name: string, scenario = "The owner reads the scope", extra = "Then the owner sees the scope"): string {
  return [
    "@pbi-146",
    `Feature: ${name}`,
    "  The owner reads what the item is for before signing off.",
    "  The scenarios show in full.",
    "",
    "  Rule: The owner sees the scope",
    "",
    "    @ac-1",
    `    Scenario: ${scenario}`,
    "      Given an item waits for sign-off",
    "      When the owner opens its Run detail",
    `      ${extra}`,
    "",
    "    @ac-2",
    "    Scenario: The owner reads every file",
    "      Given an item waits for sign-off on two files",
    "      When the owner opens its Run detail",
    "      Then the owner sees both files",
    "",
  ].join("\n");
}

const key = (sha: string, path: string) => `${REPO}@${sha}:${path}`;

function putFile(c: Ctx, sha: string, path: string, text: string): void {
  c.host.files.set(key(sha, path), text);
  c.lastFile = path;
}

function fileAt(c: Ctx, sha: string, path: string): string {
  const text = c.host.files.get(key(sha, path));
  assert.ok(text !== undefined, `the test set up no "${path}" at "${sha}"`);
  return text;
}

/** Adds `path` to the run's locked files, once. */
async function lockFile(c: Ctx, path: string): Promise<void> {
  assert.ok(c.runId, "no run was set up");
  await pool().query("update run set locked_files = array_append(locked_files, $2) where id = $1 and not ($2 = any(locked_files))", [c.runId, path]);
}

// ---- the item ----

async function dashboard(c: Ctx): Promise<void> {
  if (c.server) return;
  assert.ok(c.sourceId, "no board was set up");
  let handler: ReturnType<typeof dashboardRoutes> | undefined;
  c.server = await startServer([(req, res) => handler!(req, res)], { port: 0 });
  c.origin = `http://127.0.0.1:${(c.server.address() as AddressInfo).port}`;
  handler = dashboardRoutes({ pool: pool(), auth: createAuth({ mode: "azure" }), origin: c.origin, adapter: c.board.adapter, sourceId: c.sourceId, repoHost: c.host });
  c.close = handler.close;
}

/** Seeds issue `ext` on the fake board and the database, in `state`, with a run at `sha` over `files`. */
async function item(c: Ctx, ext: string, state: string, run: { scenariosSha: string; lockSha?: string; nextStage: string; files: string[] }): Promise<void> {
  c.ext = ext;
  await c.board.seed({ externalId: ext, title: "Show the scope at sign-off", body: c.body, acceptanceCriteria: c.criteria, labels: ["factory"], repo: REPO });
  c.sourceId = (await pool().query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'pbi-146:' || gen_random_uuid()) returning id")).rows[0].id;
  c.itemId = (await pool().query<{ id: string }>(
    "insert into item (source_id, external_id, title, state) values ($1, $2, 'Show the scope at sign-off', $3) returning id",
    [c.sourceId, ext, state],
  )).rows[0].id;
  c.runId = (await pool().query<{ id: string }>(
    "insert into run (item_id, run_number, next_stage, scenarios_sha, features_lock_sha, locked_files, branch) values ($1, 1, $2, $3, $4, $5, $6) returning id",
    [c.itemId, run.nextStage, run.scenariosSha, run.lockSha ?? null, [], `factory/pbi-${ext}-r1`],
  )).rows[0].id;
  for (const path of run.files) {
    putFile(c, run.scenariosSha, path, featureText(path));
    await lockFile(c, path);
  }
}

async function waitingForSignOff(c: Ctx, ext: string, sha: string, files: string[]): Promise<void> {
  await item(c, ext, "SignOff", { scenariosSha: sha, nextStage: "sign-off", files });
  await pool().query("insert into question (item_id, kind, body) values ($1, 'sign_off', 'Please sign off the scenarios')", [c.itemId]);
}

Given("item {string} is an issue whose body reads {string}", function (ext: string, body: string) {
  const c = ctx(this);
  c.ext = ext;
  c.body = body;
});

Given("item {string} is an issue whose body has the lines {string}, {string} and {string}", function (ext: string, a: string, b: string, d: string) {
  const c = ctx(this);
  c.ext = ext;
  c.body = [a, b, d].join("\n");
});

Given("item {string} is an issue with an empty body", function (ext: string) {
  const c = ctx(this);
  c.ext = ext;
  c.body = "";
});

Given("item {string} is an issue with a body of only blank lines", function (ext: string) {
  const c = ctx(this);
  c.ext = ext;
  c.body = "\n   \n\t\n\n";
});

Given("the item has the acceptance criterion {string}", function (criterion: string) {
  ctx(this).criteria = [criterion];
});

Given("the item waits for sign-off on scenarios at {string}", long, async function (sha: string) {
  const c = ctx(this);
  await waitingForSignOff(c, c.ext ?? "146", sha, []);
});

Given("the item waits for sign-off on scenarios at {string} in the file {string}", long, async function (sha: string, path: string) {
  const c = ctx(this);
  await waitingForSignOff(c, c.ext ?? "146", sha, [path]);
});

Given("item {string} waits for sign-off on scenarios at {string}", long, async function (ext: string, sha: string) {
  await waitingForSignOff(ctx(this), ext, sha, []);
});

Given("item {string} waits for sign-off on scenarios at {string} in the files {string} and {string}", long, async function (ext: string, sha: string, a: string, b: string) {
  await waitingForSignOff(ctx(this), ext, sha, [a, b]);
});

Given("at {string} the file {string} holds a feature with a description, a rule and two scenarios", long, async function (sha: string, path: string) {
  const c = ctx(this);
  putFile(c, sha, path, featureText(path));
  await lockFile(c, path);
});

Given("at {string} the file {string} holds the scenario {string}", long, async function (sha: string, path: string, scenario: string) {
  const c = ctx(this);
  putFile(c, sha, path, featureText(path, scenario));
  await lockFile(c, path);
});

Given("at {string} that file holds the scenario {string}", function (sha: string, scenario: string) {
  const c = ctx(this);
  assert.ok(c.lastFile, "no feature file was named");
  putFile(c, sha, c.lastFile, featureText(c.lastFile, scenario));
});

Given("a later commit {string} renames that scenario to {string}", function (sha: string, scenario: string) {
  const c = ctx(this);
  assert.ok(c.lastFile, "no feature file was named");
  putFile(c, sha, c.lastFile, featureText(c.lastFile, scenario));
  c.host.heads.set(REPO, sha);
});

Given("at {string} the file {string} has a step that reads {string}", long, async function (sha: string, path: string, step: string) {
  const c = ctx(this);
  putFile(c, sha, path, featureText(path, "The owner reads the scope", step));
  await lockFile(c, path);
});

Given("at {string} there is no file {string}", function (sha: string, path: string) {
  ctx(this).host.files.delete(key(sha, path));
});

Given("the item waited for sign-off on scenarios at {string} in the file {string}", long, async function (sha: string, path: string) {
  const c = ctx(this);
  await waitingForSignOff(c, c.ext ?? "146", sha, [path]);
});

Given("the item was abandoned when its sign-off timed out, and its sign-off can still be given", long, async function () {
  const c = ctx(this);
  await pool().query("update item set state = 'Abandoned' where id = $1", [c.itemId]);
  await pool().query(
    "insert into event (actor, actor_id, item_id, kind, payload) values ('system', 'pbi-146', $1, 'transition', $2)",
    [c.itemId, JSON.stringify({ from: "SignOff", to: "Abandoned", event: "timed_out" })],
  );
});

Given("item {string} signed off its scenarios in the file {string}, locked at {string}", long, async function (ext: string, path: string, sha: string) {
  const c = ctx(this);
  await item(c, ext, "InProgress", { scenariosSha: sha, lockSha: sha, nextStage: "red", files: [path] });
  await pool().query(
    "insert into question (item_id, kind, body, answer, decision, answered_at) values ($1, 'sign_off', 'Please sign off the scenarios', 'approved', 'approve', now())",
    [c.itemId],
  );
});

Given("the item is in flight at green", long, async function () {
  const c = ctx(this);
  await pool().query("update item set state = 'InProgress' where id = $1", [c.itemId]);
  await pool().query("update run set next_stage = 'green' where id = $1", [c.runId]);
});

When("the owner opens the item's Run detail", long, async function () {
  const c = ctx(this);
  assert.ok(c.itemId, "no item was set up");
  await pool().query(
    `insert into "user" (provider, subject, github_login, role, product_owner) values ('microsoft', $1, $1, 'operator', true) on conflict (provider, subject) do nothing`,
    [OWNER],
  );
  await dashboard(c);
  const r = await fetch(`${c.origin}/items/${c.itemId}`, { headers: headers(OWNER), redirect: "manual" });
  c.status = r.status;
  c.page = await r.text();
});

// ---- reading the page ----

function page(c: Ctx): string {
  assert.ok(c.page !== undefined, "Run detail didn't load");
  assert.equal(c.status, 200, `Run detail answered ${c.status}: ${c.page.slice(0, 300)}`);
  return c.page;
}

const decodeEntity = (e: string): string => {
  const named: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
  if (named[e]) return named[e];
  const n = /^&#(x?)([0-9a-f]+);$/i.exec(e);
  return n ? String.fromCodePoint(parseInt(n[2], n[1] ? 16 : 10)) : e;
};

/** The text a reader sees in `html`: <br> and block ends break lines, other tags drop, entities decode. */
function text(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|pre|h[1-6]|tr|section|blockquote)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&#?[0-9a-z]+;/gi, decodeEntity);
}

/** Where the Scope section starts and ends in the page, or null when there's none. */
function scopeAt(html: string): { start: number; end: number } | null {
  const m = /<h2[^>]*>\s*Scope\s*<\/h2>/i.exec(html);
  if (!m) return null;
  const next = html.indexOf("<h2", m.index + m[0].length);
  return { start: m.index, end: next < 0 ? html.length : next };
}

function scope(c: Ctx): string {
  const html = page(c);
  const at = scopeAt(html);
  assert.ok(at, "Run detail has no Scope section");
  return html.slice(at.start, at.end).replace(/^<h2[^>]*>[\s\S]*?<\/h2>/i, "");
}

/** Where the section under the heading reading `title` starts and ends, up to the next heading of any level. */
function sectionAt(html: string, title: string): { start: number; end: number } | null {
  const re = /<(h[2-4])[^>]*>([\s\S]*?)<\/\1>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (text(m[2]).trim() !== title) continue;
    const rest = html.slice(m.index + m[0].length);
    const next = rest.search(/<h[1-6][\s>]/i);
    return { start: m.index, end: m.index + m[0].length + (next < 0 ? rest.length : next) };
  }
  return null;
}

function section(c: Ctx, title: string): string {
  const html = page(c);
  const at = sectionAt(html, title);
  assert.ok(at, `Run detail has no heading "${title}"`);
  return html.slice(at.start, at.end);
}

const lf = (s: string) => s.replace(/\r\n/g, "\n").replace(/\n+$/, "");

function showsWholeFile(c: Ctx, path: string, sha: string): void {
  const want = lf(fileAt(c, sha, path));
  const got = text(section(c, path));
  assert.ok(lf(got).includes(want), `under "${path}" Run detail doesn't show the file as it stands at "${sha}", line for line:\n${got}`);
}

function buttonAt(html: string, label: string): number {
  const m = new RegExp(`<button[^>]*>\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*</button>`, "i").exec(html);
  assert.ok(m, `Run detail has no "${label}" button`);
  return m.index;
}

function scopeBefore(c: Ctx, label: string): void {
  const html = page(c);
  const at = scopeAt(html);
  assert.ok(at, "Run detail has no Scope section");
  assert.ok(at.end <= buttonAt(html, label), `the Scope section ends after the "${label}" button`);
}

function criteriaBefore(c: Ctx, label: string): void {
  const html = page(c);
  const at = sectionAt(html, "Criteria and their scenarios");
  assert.ok(at, "Run detail has no criteria list");
  assert.ok(at.end <= buttonAt(html, label), `the criteria list ends after the "${label}" button`);
}

function fileBefore(c: Ctx, path: string, label: string): void {
  const html = page(c);
  const at = sectionAt(html, path);
  assert.ok(at, `Run detail has no heading "${path}"`);
  assert.ok(at.end <= buttonAt(html, label), `the text of "${path}" ends after the "${label}" button`);
}

Then("Run detail has a Scope section", function () {
  assert.ok(scopeAt(page(ctx(this))), "Run detail has no Scope section");
});

Then("Run detail has no Scope section", function () {
  assert.equal(scopeAt(page(ctx(this))), null, "Run detail has a Scope section");
});

Then("the Scope section shows {string}", function (want: string) {
  const got = text(scope(ctx(this)));
  assert.ok(got.includes(want), `the Scope section doesn't show "${want}": ${got}`);
});

Then("the Scope section shows the text {string}", function (want: string) {
  const got = text(scope(ctx(this)));
  assert.ok(got.includes(want), `the Scope section doesn't show the text "${want}": ${got}`);
});

Then("the Scope section shows {string}, {string} and {string} on separate lines, in that order", function (a: string, b: string, d: string) {
  const lines = text(scope(ctx(this))).split("\n").map((l) => l.trim()).filter(Boolean);
  const at = [a, b, d].map((want) => lines.indexOf(want));
  for (const [i, want] of [a, b, d].entries()) assert.ok(at[i] >= 0, `"${want}" isn't a line of its own in the Scope section: ${JSON.stringify(lines)}`);
  assert.ok(at[0] < at[1] && at[1] < at[2], `the Scope section's lines are out of order: ${JSON.stringify(lines)}`);
});

Then("the page holds no script or bold text from the body", function () {
  const html = page(ctx(this));
  assert.ok(!/<script>alert\(1\)<\/script>/i.test(html), "the body's <script> is part of the page");
  assert.ok(!/<b>bold<\/b>/i.test(html), "the body's <b> is part of the page");
});

Then("the page holds no bold text from the feature file", function () {
  assert.ok(!/<b>Approve<\/b>/i.test(page(ctx(this))), "the feature file's <b> is part of the page");
});

Then("Run detail shows the heading {string}", function (title: string) {
  assert.ok(sectionAt(page(ctx(this)), title), `Run detail has no heading "${title}"`);
});

Then("under it Run detail shows the whole text of {string} at {string}, line for line", function (path: string, sha: string) {
  showsWholeFile(ctx(this), path, sha);
});

Then("Run detail shows the whole text of {string} at {string} under the heading {string}", function (path: string, sha: string, heading: string) {
  assert.equal(heading, path, "the scenario names a heading other than the file's path");
  showsWholeFile(ctx(this), path, sha);
});

Then("Run detail shows {string} in {string}", function (want: string, path: string) {
  const got = text(section(ctx(this), path));
  assert.ok(got.includes(want), `"${path}" doesn't show "${want}":\n${got}`);
});

Then("Run detail shows the text {string} in {string}", function (want: string, path: string) {
  const got = text(section(ctx(this), path));
  assert.ok(got.includes(want), `"${path}" doesn't show the text "${want}":\n${got}`);
});

Then("Run detail does not show {string}", function (unwanted: string) {
  const got = text(page(ctx(this)));
  assert.ok(!got.includes(unwanted), `Run detail shows "${unwanted}"`);
});

Then("Run detail shows {string}", function (want: string) {
  const got = text(page(ctx(this)));
  assert.ok(got.includes(want), `Run detail doesn't show "${want}"`);
});

Then("Run detail shows {string} under {string}", function (want: string, heading: string) {
  const html = page(ctx(this));
  const m = new RegExp(`<h2[^>]*>\\s*${heading}\\s*</h2>`, "i").exec(html);
  assert.ok(m, `Run detail has no "${heading}" section`);
  const next = html.indexOf("<h2", m.index + m[0].length);
  const got = text(html.slice(m.index, next < 0 ? undefined : next));
  assert.ok(got.includes(want), `the "${heading}" section doesn't show "${want}":\n${got}`);
});

Then("Run detail shows {string} under the heading {string}", function (want: string, heading: string) {
  const got = text(section(ctx(this), heading));
  assert.ok(got.includes(want), `under "${heading}" Run detail doesn't show "${want}":\n${got}`);
});

Then("Run detail shows the sign-off form", function () {
  const c = ctx(this);
  assert.ok(page(c).includes(`action="/items/${c.itemId}/signoff"`), "Run detail doesn't show the sign-off form");
});

Then("Run detail shows the {string} button", function (label: string) {
  buttonAt(page(ctx(this)), label);
});

Then("the Scope section comes before the {string} button", function (label: string) {
  scopeBefore(ctx(this), label);
});

Then("the criteria list comes before the {string} button", function (label: string) {
  criteriaBefore(ctx(this), label);
});

Then("the text of {string} comes before the {string} button", function (path: string, label: string) {
  fileBefore(ctx(this), path, label);
});

Then("the Scope section, the criteria list and the text of {string} all come before the {string} button", function (path: string, label: string) {
  const c = ctx(this);
  scopeBefore(c, label);
  criteriaBefore(c, label);
  fileBefore(c, path, label);
});

Then("the Scope section and the text of {string} come before the {string} button", function (path: string, label: string) {
  const c = ctx(this);
  scopeBefore(c, label);
  fileBefore(c, path, label);
});
