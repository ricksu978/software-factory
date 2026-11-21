// Step definitions for features/pbi-395-rule-change-approval.feature.
//
// The item is PBI 131's: "item ... is an issue in the repo ..." puts its row, Eligible, on a board that maps to
// "acme/widgets", on PBI 4's shared test database. PBI 348's "the repo has a ... with these lines:" gives the repo's
// dor.md. The readiness check is the real pollOnce, run through PBI 12's poller harness on that board's row, so PBI 12's
// "the poller runs once" and PBI 149's "the board item has a new readiness comment saying ..." read the same context:
// - The board is PBI 12's fake board, holding the item as issue "395", labelled "factory", in "acme/widgets". Its body
//   is a short lead, an acceptance criteria section, and the scenario's rules section. An edit seeds it again, which
//   bumps its updatedAt as an edit on GitHub does.
// - The repo host is PBI 12's fake one, with the repo's dor.md, a dod.md and a config.yml on its default branch.
// - The judge is PBI 12's fake judge. Its last line, beside `flags`, carries `rules`: each factory rule the judge finds
//   the item changes, a spec section as "§6" and a policy file as its path, such as "policy/dor.md". "Passes line 1"
//   fails line 2, the rules line, as the judge does today, with a reason that names no section.
//
// The contract these steps set up, which the code reads:
// - The factory's own repo is pollOnce's `factoryRepo`, read with readFile(ref, path). Its spec is the HTML file at
//   SPEC below, where section §N is the <section> whose <h2> starts with <span class="n">0N</span>. Its policy files sit
//   at their paths, such as "policy/dor.md". A branch other than main is another ref, which the check never reads.
// - An item's rule changes are its "## Changes the factory's rules" section. Each rule is a "### Spec §N" or a
//   "### <policy file path>" heading, then "**Before**" and "**After**", each followed by its text as a "> " quote.
// - What the readiness check read is ruleChangesRead in src/store/rule-changes.ts.
// - An item waits for the owner's approval while it's NotReady and its last readiness check's dor.md results (the
//   policy_result rows the poller writes, file 'dor', no run, at the newest `at`) hold one that isn't passed and is about
//   the owner's approval: its criterion or its reason says "approv". A finding on a dor.md line is its row there.
// - Each item page is the dashboard's /items/<id>, opened in UTC by a signed-in user ("user" rows by login, signed in
//   with the headers Container Apps adds). The page's "Rule changes" section (the content after its <h2> up to the next
//   <h2>) holds one element per rule with a `data-rule` attribute, the spec section ("§6") or the policy file's path,
//   holding the rule's Before in a <blockquote data-side="before"> and its After in a <blockquote data-side="after">,
//   each word that changes inside a <mark>. Owner approval is a <button> reading "Approve rule change" in a form that
//   posts to /items/<id>/rule-approval with the shown changes' hash in a hidden ruleChangesHash field. A user approves by posting that form: the owner's post answers 303, anyone
//   else's 403.
// - The approval is an event of kind "rule_change_approved" whose actor is human, its actor_id the approver's user id,
//   at the time of the approval, and the item's move to Eligible is a transition whose event is "rule_change_approved".
//   The rest of the readiness check runs on the next poll, so an approval here is the post, then one poll.
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fakeBacklog, fakeRepoHost } from "../../src/adapters/fake.ts";
import { createAuth } from "../../src/http/auth.ts";
import { dashboardRoutes } from "../../src/http/routes.ts";
import { startServer } from "../../src/http/server.ts";
import type { Policy } from "../../src/policy/policy.ts";
import { ruleChangesHash } from "../../src/gate/rule-changes.ts";
import { ruleChangesChecked, ruleChangesRead, type RuleChange } from "../../src/store/rule-changes.ts";
import type { FactoryRepo } from "../../src/watcher/poller.ts";
import { baseFiles, ctx as pollCtx, poll, polled } from "./pbi-12.steps.ts";
import { ctx as itemCtx, type Item } from "./pbi-131.steps.ts";
import { ctx as commentCtx } from "./pbi-149.steps.ts";
import { text } from "./pbi-189.steps.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";

const SPEC = "docs/superpowers/specs/2026-11-05-software-factory-design.html";
const HEAD = "w1";
const RULES_HEADING = "## Changes the factory's rules";
const LEAD = "Leases run shorter, so a stuck cell frees its slot sooner.\n";
const CRITERIA = ["A lease lasts five minutes", "The worker renews a lease every thirty seconds"];
/** Each rule's After when the scenario names none. */
const AFTERS: Record<string, string> = {
  "§5": "A NotReady item moves to Eligible when a readiness input changes or the owner approves its rule change.",
  "§6": "A lease lasts five minutes and the worker renews it every thirty seconds.",
  "§7": "Claiming. The scheduler takes a lease on the item and the cell renews it every 30 seconds.",
  "policy/dor.md": "The item fits one Sprint and has a Size of 8 or less.",
};
const OWNER = "olive";
const VIEWER = "vic";

type Role = "viewer" | "operator" | "owner";
type Entry = { place: string; before?: string; after?: string };
type Ctx = {
  /** Each spec section's HTML body and each policy file's rule, by ref, then by place ("§6" or "policy/dor.md"). */
  rules: Map<string, Map<string, string>>;
  /** The item's rules section: the entries the steps built, or the scenario's own text, or none. */
  entries: Entry[];
  section?: string | null;
  lead: string;
  fake?: ReturnType<typeof fakeBacklog>;
  host?: ReturnType<typeof fakeRepoHost>;
  server?: Server;
  close?: () => Promise<void>;
  origin?: string;
  clock?: Date;
  roles: Map<string, Role>;
  page?: { status: number; html: string };
  approval?: { status: number };
  /** What the last "the readiness check read ..." step read, and the change a following "its ..." reads. */
  read?: RuleChange[];
  change?: RuleChange;
  /** The comment the last comment step found, for a following "that comment". */
  comment?: string;
  /** The dor.md result the last "failed item ... on the line" step found. */
  finding?: { reason: string | null };
};

function ctx(world: object): Ctx {
  const w = world as { pbi395?: Ctx };
  w.pbi395 ??= { rules: new Map(), entries: [], lead: LEAD, roles: new Map() };
  return w.pbi395;
}

const pool = () => need().pool;
const headers = (login: string) => ({ "x-ms-client-principal-idp": "aad", "x-ms-client-principal-id": login, "x-ms-client-principal-name": login });

Before({ tags: "@pbi-395", ...long }, async function () {
  const d = await testDb();
  assert.ok(d, "src/store/test-db.ts doesn't exist");
  await d.pool.query('truncate item, event, backlog_source, repo, "user", override cascade');
});

After({ tags: "@pbi-395", ...long }, async function () {
  // PBI 131's After only closes its own scenarios' server, and this feature opens its own.
  const c = (this as { pbi395?: Ctx }).pbi395;
  if (!c?.server) return;
  await c.close?.();
  c.server.closeAllConnections();
  await new Promise<void>((resolve) => c.server!.close(() => resolve()));
});

function item(world: object): Item {
  const it = itemCtx(world).items.at(-1);
  assert.ok(it, "no item was set up");
  return it;
}

function named(world: object, ext: string): Item {
  const it = item(world);
  assert.equal(it.ext, ext, `the scenario's item is ${it.ext}, not ${ext}`);
  return it;
}

// ---- the factory's own rules ----

function rulesAt(c: Ctx, ref: string): Map<string, string> {
  let m = c.rules.get(ref);
  if (!m) c.rules.set(ref, (m = new Map()));
  return m;
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The spec as HTML: one <section> per section, in number order, each with its body. */
function specHtml(sections: Map<string, string>): string {
  const spec = [...sections].filter(([place]) => place.startsWith("§")).sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)));
  const body = spec.map(([place, html]) => {
    const n = place.slice(1).padStart(2, "0");
    return `<section id="s${n}">\n  <h2><span class="n">${n}</span>Section ${place.slice(1)}</h2>\n  ${html}\n</section>`;
  });
  return `<!doctype html>\n<html><body>\n<h1>Software factory</h1>\n${body.join("\n\n")}\n</body></html>\n`;
}

function factoryRepo(c: Ctx): FactoryRepo {
  return {
    async readFile(ref, path) {
      const m = c.rules.get(ref);
      if (!m) return null;
      if (path === SPEC) return [...m.keys()].some((k) => k.startsWith("§")) ? specHtml(m) : null;
      const rule = m.get(path);
      return rule === undefined ? null : `# ${path}\n\n- [ ] ${rule}\n`;
    },
  };
}

/** The rule's text on main, as an item quotes it. */
function onMain(c: Ctx, place: string): string {
  const raw = rulesAt(c, "main").get(place);
  assert.ok(raw !== undefined, `main holds no rule at ${place}`);
  return place.startsWith("§") ? text(raw) : raw;
}

Given("on main, spec section {string} holds the rule {string}", function (section: string, rule: string) {
  rulesAt(ctx(this), "main").set(section, `<p>${escape(rule)}</p>`);
});

Given("on main, the policy file {string} holds the rule {string}", function (path: string, rule: string) {
  rulesAt(ctx(this), "main").set(path, rule);
});

Given("on the branch {string}, spec section {string} holds the rule {string}", function (ref: string, section: string, rule: string) {
  const c = ctx(this);
  const branch = rulesAt(c, ref);
  for (const [k, v] of rulesAt(c, "main")) if (!branch.has(k)) branch.set(k, v);
  branch.set(section, `<p>${escape(rule)}</p>`);
});

Given("on main, spec section {string} is HTML with one clause per line and reads:", function (section: string, html: string) {
  rulesAt(ctx(this), "main").set(section, html);
});

// ---- the item's body ----

function rulesSection(c: Ctx): string {
  if (c.section !== undefined) return c.section ?? "";
  if (c.entries.length === 0) return "";
  const entry = (e: Entry) => [
    e.place.startsWith("§") ? `### Spec ${e.place}` : `### ${e.place}`,
    ...(e.before !== undefined ? ["**Before**", `> ${e.before}`, ""] : []),
    ...(e.after !== undefined ? ["**After**", `> ${e.after}`, ""] : []),
  ].join("\n");
  return `${RULES_HEADING}\n\n${c.entries.map(entry).join("\n")}`;
}

function body(c: Ctx): string {
  const criteria = `## Acceptance criteria\n\n${CRITERIA.map((a) => `- ${a}`).join("\n")}\n`;
  const rules = rulesSection(c);
  return `${c.lead}\n${criteria}${rules ? `\n${rules}\n` : ""}`;
}

function setSection(world: object, ext: string, section: string | null): void {
  named(world, ext);
  ctx(world).section = section;
}

function addEntry(world: object, place: string, before?: string): void {
  const c = ctx(world);
  c.section = undefined;
  c.entries.push({ place, before: before ?? onMain(c, place), after: AFTERS[place] ?? `${onMain(c, place)} Changed.` });
}

Given("item {string}'s body has this section:", function (ext: string, section: string) {
  setSection(this, ext, section);
});

Given("item {string}'s body has no {string} section", function (ext: string, heading: string) {
  assert.equal(heading, RULES_HEADING);
  setSection(this, ext, null);
});

Given("item {string}'s rules section changes spec section {string} with the Before {string}", function (ext: string, section: string, before: string) {
  named(this, ext);
  addEntry(this, section, before);
});

Given("it changes the policy file {string} with the Before {string}", function (path: string, before: string) {
  addEntry(this, path, before);
});

Given("item {string}'s rules section changes spec section {string} with a Before that matches main word for word", function (ext: string, section: string) {
  named(this, ext);
  addEntry(this, section);
});

Given("item {string}'s rules section changes spec section {string} and the policy file {string}, each with a Before that matches main word for word",
  function (ext: string, section: string, path: string) {
    named(this, ext);
    addEntry(this, section);
    addEntry(this, path);
  });

Given("item {string}'s rules section changes spec sections {string} and {string}, each with a Before that matches main word for word",
  function (ext: string, a: string, b: string) {
    named(this, ext);
    addEntry(this, a);
    addEntry(this, b);
  });

// ---- the readiness judge ----

function judge(world: object, rules: string[], fail?: { index: number; reason: string }): void {
  const p = pollCtx(world);
  p.judge = fail ? "fail" : "pass";
  p.failLine = fail;
  p.failText = undefined;
  p.lastLine = { rules };
}

/** What the judge says of the rules line when it fails it, as today: that the item changes the rules, naming no section. */
const RULES_LINE_REASON = "The item rewrites how the factory works but doesn't say which of its rules it changes.";

Given("the readiness judge passes every line and finds the item changes spec section {string}", function (a: string) {
  judge(this, [a]);
});

Given("the readiness judge passes every line and finds the item changes spec section {string} and the policy file {string}", function (a: string, b: string) {
  judge(this, [a, b]);
});

Given("the readiness judge passes every line and finds the item changes spec sections {string} and {string}", function (a: string, b: string) {
  judge(this, [a, b]);
});

Given("the readiness judge passes every line and finds the item changes no factory rule", function () {
  judge(this, []);
});

Given("the readiness judge fails line {int} because {string} and finds the item changes spec section {string}", function (n: number, reason: string, a: string) {
  judge(this, [a], { index: n, reason });
});

Given("the readiness judge fails line {int} because {string} and finds the item changes no factory rule", function (n: number, reason: string) {
  judge(this, [], { index: n, reason });
});

Given("the readiness judge passes line {int} and finds the item changes spec section {string}", function (n: number, a: string) {
  assert.equal(n, 1, "the rules line is line 2");
  judge(this, [a], { index: 2, reason: RULES_LINE_REASON });
});

Given("the readiness judge passes line {int} and finds the item changes spec sections {string} and {string}", function (n: number, a: string, b: string) {
  assert.equal(n, 1, "the rules line is line 2");
  judge(this, [a, b], { index: 2, reason: RULES_LINE_REASON });
});

// ---- the board, the repo and the poll ----

async function board(world: object): Promise<void> {
  const c = ctx(world);
  const p = pollCtx(world);
  const it = item(world);
  if (!c.fake) {
    c.fake = fakeBacklog();
    c.host = fakeRepoHost();
    const dor = (world as { pbi348?: { dor?: Policy } }).pbi348?.dor;
    assert.ok(dor, "the repo's dor.md wasn't set up");
    for (const [path, t] of Object.entries({ ...baseFiles, ".factory/dor.md": dor.text })) c.host.files.set(`acme/widgets@${HEAD}:${path}`, t);
    c.host.heads.set("acme/widgets", HEAD);
    p.fake = c.fake;
    p.host = c.host;
    p.sourceId = it.sourceId;
    p.extIds = [it.ext];
    p.deps = { factoryRepo: factoryRepo(c) };
    p.lastLine ??= { rules: [] };
  }
  await c.fake.seed({
    externalId: it.ext, title: it.title, body: body(c), acceptanceCriteria: CRITERIA, labels: ["factory"], status: "Backlog", rank: 1,
    repo: "acme/widgets", fields: {}, closed: false,
  });
}

/** Counts the board item's comments so far, so the comment steps read only the ones that come after. */
async function markComments(world: object): Promise<void> {
  const c = ctx(world);
  const it = item(world);
  commentCtx(world).commentsBefore.set(it.ext, c.fake ? (await c.fake.comments(it.ext)).length : 0);
}

async function check(world: object): Promise<void> {
  await board(world);
  await markComments(world);
  // A poll that fails is kept in the harness, and the Thens that read it say so.
  await poll(pollCtx(world));
}

When("the readiness check checks item {string}", long, async function (ext: string) {
  named(this, ext);
  await check(this);
});

Given("the readiness check has checked item {string}", long, async function (ext: string) {
  named(this, ext);
  await check(this);
});

// ---- the item page and the approval ----
//
// "<login>, a viewer, is signed in" and "<login>, a operator, is signed in" are PBI 105's step, which makes the user
// with that role. "an operator" and "the owner" are this feature's.

async function dashboard(world: object): Promise<Ctx> {
  const c = ctx(world);
  if (c.server) return c;
  let handler: ReturnType<typeof dashboardRoutes> | undefined;
  c.server = await startServer([(req, res) => handler!(req, res)], { port: 0 });
  c.origin = `http://127.0.0.1:${(c.server.address() as AddressInfo).port}`;
  handler = dashboardRoutes({
    pool: pool(), auth: createAuth({ mode: "azure" }), origin: c.origin, adapter: (c.fake ?? fakeBacklog()).adapter, sourceId: item(world).sourceId,
    now: () => c.clock ?? new Date(),
  });
  c.close = handler.close;
  return c;
}

/** The user `login`, made with `role` unless a step made them already, such as PBI 105's "..., a viewer, is signed in". */
async function user(login: string, role: Role, set = false): Promise<string> {
  await pool().query(
    `insert into "user" (provider, subject, github_login, role) values ('microsoft', $1, $1, $2)
     on conflict (provider, subject) do ${set ? "update set role = excluded.role" : "nothing"}`,
    [login, role],
  );
  return (await pool().query<{ id: string }>(`select id from "user" where provider = 'microsoft' and subject = $1`, [login])).rows[0].id;
}

function roleOf(c: Ctx, login: string): Role {
  return c.roles.get(login) ?? (login === OWNER ? "owner" : "viewer");
}

async function openPage(world: object, login: string): Promise<void> {
  const c = await dashboard(world);
  await user(login, roleOf(c, login));
  const r = await fetch(`${c.origin}/items/${item(world).id}`, { headers: { ...headers(login), cookie: "tz=UTC" }, redirect: "manual" });
  c.page = { status: r.status, html: await r.text() };
}

/** Posts the item page's approval form as `login`, at `at` when it names a time. */
async function postApproval(world: object, login: string, at?: string): Promise<number> {
  const c = await dashboard(world);
  await user(login, roleOf(c, login));
  c.clock = at ? new Date(at) : undefined;
  // The form carries the hash of the rule changes the page shows, which are those the last readiness check stored.
  const shown = ruleChangesHash((await ruleChangesChecked(pool(), item(world).id)) ?? []);
  const r = await fetch(`${c.origin}/items/${item(world).id}/rule-approval`, {
    method: "POST", redirect: "manual",
    headers: { ...headers(login), origin: c.origin!, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ruleChangesHash: shown }).toString(),
  });
  await r.text();
  c.approval = { status: r.status };
  return r.status;
}

/** The approval, then the next poll, which runs the rest of the readiness check. */
async function approve(world: object, login: string, at?: string): Promise<void> {
  await markComments(world);
  await postApproval(world, login, at);
  await poll(pollCtx(world));
}

/** An item checked with a rules section that changes `section` and a judge that finds it does, as waiting leaves it. */
async function waiting(world: object, ext: string, section: string): Promise<void> {
  named(world, ext);
  const c = ctx(world);
  if (!c.entries.some((e) => e.place === section)) addEntry(world, section);
  judge(world, [section]);
  await check(world);
}

Given("item {string} is waiting for the owner's approval of its change to spec section {string}", long, async function (ext: string, section: string) {
  await waiting(this, ext, section);
});

Given(new RegExp(`^"([^"]+)", (?:an|the) (operator|owner), is signed in$`), long, async function (login: string, role: Role) {
  ctx(this).roles.set(login, role);
  await user(login, role, true);
});

Given("{string}, the owner, approved item {string}'s change to spec section {string} at {string}", long, async function (login: string, ext: string, section: string, at: string) {
  ctx(this).roles.set(login, "owner");
  await waiting(this, ext, section);
  await approve(this, login, at);
});

Given("the owner approved item {string}'s change to spec section {string} and the factory holds it in state {string}", long, async function (ext: string, section: string, state: string) {
  assert.equal(state, "Queued", "an approved item that passes goes on to Queued");
  await waiting(this, ext, section);
  await approve(this, OWNER);
});

When("the owner opens item {string}'s item page", long, async function (ext: string) {
  named(this, ext);
  await openPage(this, OWNER);
});

When("a viewer opens item {string}'s item page", long, async function (ext: string) {
  named(this, ext);
  await openPage(this, VIEWER);
});

When("{string} opens item {string}'s item page", long, async function (login: string, ext: string) {
  named(this, ext);
  await openPage(this, login);
});

When("{string} approves the rule change on item {string}'s item page at {string}", long, async function (login: string, ext: string, at: string) {
  named(this, ext);
  await approve(this, login, at);
});

When("the owner approves the rule change on item {string}'s item page", long, async function (ext: string) {
  named(this, ext);
  await approve(this, OWNER);
});

When("{string} sends an approval of the rule change on item {string}", long, async function (login: string, ext: string) {
  named(this, ext);
  await markComments(this);
  await postApproval(this, login);
});

// ---- edits after the approval ----

When("someone edits the After for spec section {string} in item {string}'s rules section to {string}", long, async function (section: string, ext: string, after: string) {
  named(this, ext);
  const e = ctx(this).entries.find((x) => x.place === section);
  assert.ok(e, `the item's rules section has no entry for ${section}`);
  e.after = after;
  await board(this);
});

When("someone adds a change to spec section {string} with a Before that matches main to item {string}'s rules section", long, async function (section: string, ext: string) {
  named(this, ext);
  addEntry(this, section);
  await board(this);
});

When("someone edits item {string}'s body outside its rules section", long, async function (ext: string) {
  named(this, ext);
  ctx(this).lead = `${LEAD}A stuck cell holds its slot for ten minutes today.\n`;
  await board(this);
});

// ---- what the readiness check read ----

async function read(world: object, ext: string): Promise<RuleChange[]> {
  polled(pollCtx(world));
  const got = await ruleChangesRead(pool(), named(world, ext).id);
  assert.ok(got !== null, `the readiness check recorded no reading of item ${ext}'s rules section`);
  const c = ctx(world);
  c.read = got;
  c.change = got.length === 1 ? got[0] : undefined;
  return got;
}

const placeOf = (r: RuleChange) => (r.place.kind === "spec" ? r.place.section : r.place.path);
const showRead = (rs: RuleChange[]) => JSON.stringify(rs, null, 1);

Then("the readiness check read one rule change on item {string}", long, async function (ext: string) {
  const got = await read(this, ext);
  assert.equal(got.length, 1, `the readiness check read ${got.length} rule changes: ${showRead(got)}`);
});

Then("the readiness check read two rule changes on item {string}", long, async function (ext: string) {
  const got = await read(this, ext);
  assert.equal(got.length, 2, `the readiness check read ${got.length} rule changes: ${showRead(got)}`);
});

Then("the readiness check read no rule change on item {string}", long, async function (ext: string) {
  const got = await read(this, ext);
  assert.equal(got.length, 0, `the readiness check read ${got.length} rule changes: ${showRead(got)}`);
});

function change(world: object): RuleChange {
  const ch = ctx(world).change;
  assert.ok(ch, "no one rule change was read");
  return ch;
}

Then("that rule change names spec section {string}", function (section: string) {
  assert.deepEqual(change(this).place, { kind: "spec", section });
});

Then("its Before is {string}", function (before: string) {
  assert.equal(change(this).before, before);
});

// "its After is" is a Given in one scenario, setting the After of the change the item waits on, and a Then in another.
Given("its After is {string}", long, async function (after: string) {
  const c = ctx(this);
  if (c.read) {
    assert.equal(change(this).after, after);
    return;
  }
  const e = c.entries.at(-1);
  assert.ok(e, "the item's rules section has no entry");
  if (e.after === after) return;
  e.after = after;
  await check(this);
});

function readAt(world: object, place: RuleChange["place"], after: string): void {
  const rs = ctx(world).read ?? [];
  const found = rs.find((r) => JSON.stringify(r.place) === JSON.stringify(place));
  assert.ok(found, `no rule change read names ${JSON.stringify(place)}: ${showRead(rs)}`);
  assert.equal(found.after, after);
}

Then("one names spec section {string} with the After {string}", function (section: string, after: string) {
  readAt(this, { kind: "spec", section }, after);
});

Then("the other names the policy file {string} with the After {string}", function (path: string, after: string) {
  readAt(this, { kind: "policy", path }, after);
});

// ---- the factory's state, history and events ----

async function stateOf(world: object, ext: string): Promise<string> {
  const r = await pool().query<{ state: string }>("select state from item where id = $1", [named(world, ext).id]);
  return r.rows[0]?.state ?? "(none)";
}

Then("the factory holds item {string} in state {string}", long, async function (ext: string, state: string) {
  polled(pollCtx(this));
  assert.equal(await stateOf(this, ext), state);
});

type Result = { criterion: string; status: string; reason: string | null };

/** The dor.md results of the item's last readiness check. */
async function lastResults(world: object, ext: string): Promise<Result[]> {
  return (await pool().query<Result>(
    `select criterion, status, reason from policy_result
     where item_id = $1 and file = 'dor' and run_id is null
       and at = (select max(at) from policy_result where item_id = $1 and file = 'dor' and run_id is null)
     order by criterion_index`,
    [named(world, ext).id],
  )).rows;
}

const showResults = (rs: Result[]) => rs.map((r) => `${r.status}: ${r.criterion} (${r.reason ?? ""})`).join("\n") || "(no results)";

async function isWaiting(world: object, ext: string): Promise<{ waiting: boolean; why: string }> {
  const state = await stateOf(world, ext);
  const rs = await lastResults(world, ext);
  const about = rs.filter((r) => r.status !== "passed" && /approv/i.test(`${r.criterion} ${r.reason ?? ""}`));
  return { waiting: state === "NotReady" && about.length > 0, why: `the item is ${state}, and its last readiness check's results are:\n${showResults(rs)}` };
}

Then("item {string} isn't waiting for the owner's approval", long, async function (ext: string) {
  polled(pollCtx(this));
  const w = await isWaiting(this, ext);
  assert.ok(!w.waiting, `item ${ext} waits for the owner's approval: ${w.why}`);
});

for (const step of ["item {string} is waiting for the owner's approval", "item {string} is still waiting for the owner's approval"]) {
  Then(step, long, async function (ext: string) {
    polled(pollCtx(this));
    const w = await isWaiting(this, ext);
    assert.ok(w.waiting, `item ${ext} isn't waiting for the owner's approval: ${w.why}`);
  });
}

async function resultOn(world: object, ext: string, line: string): Promise<Result> {
  polled(pollCtx(world));
  const rs = await lastResults(world, ext);
  const r = rs.find((x) => x.criterion === line);
  assert.ok(r, `the last readiness check has no result on "${line}":\n${showResults(rs)}`);
  return r;
}

Then("the readiness check passed item {string} on the line {string}", long, async function (ext: string, line: string) {
  const r = await resultOn(this, ext, line);
  assert.equal(r.status, "passed", `the line "${line}" ${r.status}: ${r.reason ?? ""}`);
});

Then("the readiness check failed item {string} on the line {string}", long, async function (ext: string, line: string) {
  const r = await resultOn(this, ext, line);
  assert.equal(r.status, "failed", `the line "${line}" ${r.status}: ${r.reason ?? ""}`);
  ctx(this).finding = { reason: r.reason };
});

Then("that finding names spec section {string}", function (section: string) {
  const f = ctx(this).finding;
  assert.ok(f, "no finding was read");
  assert.ok((f.reason ?? "").includes(section), `the finding "${f.reason ?? ""}" doesn't name ${section}`);
});

type Ev = { actor: string; actor_id: string; at: Date; payload: Record<string, unknown> };

async function approvals(world: object, ext: string): Promise<Ev[]> {
  return (await pool().query<Ev>(
    "select actor, actor_id, at, payload from event where item_id = $1 and kind = 'rule_change_approved' order by at",
    [named(world, ext).id],
  )).rows;
}

Then("item {string} has an event recording the rule change approval by {string} at {string}", long, async function (ext: string, login: string, at: string) {
  const id = await user(login, roleOf(ctx(this), login));
  const evs = await approvals(this, ext);
  const mine = evs.filter((e) => e.actor === "human" && e.actor_id === id && e.at.getTime() === Date.parse(at));
  assert.equal(mine.length, 1, `item ${ext} has ${mine.length} rule change approvals by ${login} at ${at}, of: ${JSON.stringify(evs)}`);
});

Then("item {string} has no event recording a rule change approval", long, async function (ext: string) {
  const evs = await approvals(this, ext);
  assert.equal(evs.length, 0, `item ${ext} has rule change approvals: ${JSON.stringify(evs)}`);
});

Then("item {string}'s history shows a move from {string} to {string} for the approval", long, async function (ext: string, from: string, to: string) {
  const r = await pool().query(
    `select 1 from event where item_id = $1 and kind = 'transition'
       and payload->>'from' = $2 and payload->>'to' = $3 and payload->>'event' = 'rule_change_approved'`,
    [named(this, ext).id, from, to],
  );
  assert.ok((r.rowCount ?? 0) > 0, `item ${ext}'s history shows no move from ${from} to ${to} for the approval`);
});

Then("the approval is refused", function () {
  const a = ctx(this).approval;
  assert.ok(a, "no approval was sent");
  assert.equal(a.status, 403, `the approval answered ${a.status}`);
});

Then("item {string} still holds the owner's approval of its change to spec section {string}", long, async function (ext: string, section: string) {
  polled(pollCtx(this));
  const evs = await approvals(this, ext);
  assert.ok(evs.length > 0, `item ${ext} has no rule change approval`);
  assert.equal(await stateOf(this, ext), "Queued", "the approved item didn't stay Queued");
  const changes = await ruleChangesRead(pool(), named(this, ext).id);
  assert.ok(changes?.some((r) => placeOf(r) === section), `the approval's rule changes don't include ${section}: ${showRead(changes ?? [])}`);
});

// ---- the readiness comments ----

async function fresh(world: object): Promise<string[]> {
  const p = pollCtx(world);
  polled(p);
  const ext = item(world).ext;
  const all = await p.fake!.comments(ext);
  return all.slice(commentCtx(world).commentsBefore.get(ext) ?? 0);
}

const READINESS = /can't start this item|readiness/i;
const MISMATCH = /doesn['’]t match|does not match|isn['’]t what|differs/i;
const linesOf = (comment: string) => comment.split("\n");

/** Finds a new readiness comment with a line that holds every one of `parts`, and keeps it for a following "that comment". */
async function commentWith(world: object, what: string, test: (line: string) => boolean): Promise<void> {
  const all = await fresh(world);
  const found = all.find((b) => READINESS.test(b) && linesOf(b).some(test)) ?? all.find((b) => linesOf(b).some(test));
  assert.ok(found, `no new readiness comment says ${what}:\n${all.join("\n---\n") || "(no new comment)"}`);
  ctx(world).comment = found;
}

Then("the board item has a new readiness comment saying the entry for spec section {string} gives no After", long, async function (section: string) {
  await commentWith(this, `the entry for ${section} gives no After`, (l) => l.includes(section) && /\bno\s+(\*\*)?After\b/i.test(l));
});

Then("the board item has a new readiness comment saying the entry for spec section {string} gives no Before", long, async function (section: string) {
  await commentWith(this, `the entry for ${section} gives no Before`, (l) => l.includes(section) && /\bno\s+(\*\*)?Before\b/i.test(l));
});

const mismatchLine = (place: string) => (l: string) => l.includes(place) && /Before/i.test(l) && MISMATCH.test(l) && /\bmain\b/.test(l);

Then("the board item has a new readiness comment saying the Before quoted for spec section {string} doesn't match main", long, async function (section: string) {
  await commentWith(this, `the Before quoted for ${section} doesn't match main`, mismatchLine(section));
});

Then("the board item has a new readiness comment saying the Before quoted for {string} doesn't match main", long, async function (path: string) {
  await commentWith(this, `the Before quoted for ${path} doesn't match main`, mismatchLine(path));
});

const offLine = (place: string) => (l: string) => l.includes(place) && MISMATCH.test(l);

Then("that comment doesn't say the Before quoted for spec section {string} is off", function (section: string) {
  const comment = ctx(this).comment;
  assert.ok(comment, "no comment was found");
  assert.ok(!linesOf(comment).some(offLine(section)), `the comment says the Before for ${section} is off:\n${comment}`);
});

Then("the board item's new readiness comment doesn't say the Before quoted for spec section {string} is off", long, async function (section: string) {
  const all = (await fresh(this)).filter((b) => READINESS.test(b));
  assert.ok(all.length > 0, "the board item has no new readiness comment");
  for (const b of all) assert.ok(!linesOf(b).some(offLine(section)), `the comment says the Before for ${section} is off:\n${b}`);
});

const WAITS = /wait(s|ing)? for the owner|owner['’]s approval|owner (to )?approves?/i;

Then("the board item has a new readiness comment saying the item waits for the owner to approve its change to spec section {string}", long, async function (section: string) {
  await commentWith(this, `the item waits for the owner to approve its change to ${section}`, (l) => l.includes(section) && WAITS.test(l));
});

Then("the board item has a new readiness comment naming spec sections {string} and {string}", long, async function (a: string, b: string) {
  const all = await fresh(this);
  assert.ok(all.some((c) => READINESS.test(c) && WAITS.test(c) && c.includes(a) && c.includes(b)),
    `no new readiness comment that says the item waits for the owner names both ${a} and ${b}:\n${all.join("\n---\n") || "(no new comment)"}`);
});

Then("that comment doesn't mention the owner's approval", long, async function () {
  const all = (await fresh(this)).filter((b) => READINESS.test(b));
  assert.ok(all.length > 0, "the board item has no new readiness comment");
  for (const b of all) assert.doesNotMatch(b, /approv/i, `the readiness comment mentions an approval:\n${b}`);
});

// ---- reading the item page ----

function html(world: object): string {
  const p = ctx(world).page;
  assert.ok(p, "no item page was opened");
  assert.equal(p.status, 200, `the item page answered ${p.status}: ${p.html.slice(0, 300)}`);
  return p.html;
}

function rulesPart(world: object): string {
  const page = html(world);
  for (const part of page.split(/<h2\b[^>]*>/i).slice(1)) {
    const end = part.search(/<\/h2>/i);
    if (text(part.slice(0, end)) === "Rule changes") return part.slice(end + 5).split(/<h2\b/i)[0];
  }
  assert.fail(`the item page has no "Rule changes" section: ${text(page).slice(0, 600)}`);
}

/** The HTML of the page's entry for `place`, from its data-rule element up to the next one. */
function ruleEntry(world: object, place: string): string {
  const part = rulesPart(world);
  const starts = [...part.matchAll(/<[a-z][a-z0-9]*\b[^>]*\bdata-rule="([^"]*)"[^>]*>/gi)];
  const decode = (s: string) => text(s);
  const i = starts.findIndex((m) => decode(m[1]) === place);
  assert.ok(i >= 0, `the Rule changes section has no entry for ${place}; it names: ${starts.map((m) => decode(m[1])).join(", ") || "none"}`);
  return part.slice(starts[i].index, starts[i + 1]?.index ?? part.length);
}

function side(entry: string, which: "before" | "after"): string {
  const m = new RegExp(`<blockquote\\b[^>]*\\bdata-side="${which}"[^>]*>([\\s\\S]*?)</blockquote>`, "i").exec(entry);
  assert.ok(m, `the entry shows no ${which === "before" ? "Before" : "After"}: ${text(entry)}`);
  return m[1];
}

const marked = (h: string) => [...h.matchAll(/<mark\b[^>]*>([\s\S]*?)<\/mark>/gi)].map((m) => text(m[1])).join(" ")
  .split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")).filter(Boolean);

Then("the item page says the Before quoted for spec section {string} doesn't match main", function (section: string) {
  const entry = text(ruleEntry(this, section));
  assert.ok(/Before/i.test(entry) && MISMATCH.test(entry) && /\bmain\b/.test(entry), `the entry for ${section} doesn't say its Before doesn't match main: ${entry}`);
});

function control(world: object, name: string): boolean {
  const buttons = [...html(world).matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi)].map((m) => text(m[1]));
  return buttons.includes(name);
}

Then("the item page doesn't show the {string} control", function (name: string) {
  assert.ok(!control(this, name), `the item page shows the "${name}" control`);
});

Then("the item page shows the {string} control", function (name: string) {
  const page = html(this);
  assert.ok(control(this, name), `the item page shows no "${name}" control: ${text(page).slice(0, 600)}`);
  const form = [...page.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].find((m) => text(m[2]).includes(name));
  assert.ok(form && form[1].includes(`/items/${item(this).id}/rule-approval`), `the "${name}" control doesn't post to /items/${item(this).id}/rule-approval`);
});

Then("the owner sees the {string} control on item {string}'s item page", long, async function (name: string, ext: string) {
  named(this, ext);
  await openPage(this, OWNER);
  assert.ok(control(this, name), `the owner's item page shows no "${name}" control: ${text(html(this)).slice(0, 600)}`);
});

Then("the item page says item {string} waits for the owner to approve its rule changes", function (ext: string) {
  named(this, ext);
  const part = text(rulesPart(this));
  assert.match(part, WAITS, `the Rule changes section doesn't say the item waits for the owner's approval: ${part}`);
});

Then("the item page names spec section {string} and the policy file {string} as the rules it changes", function (section: string, path: string) {
  ruleEntry(this, section);
  ruleEntry(this, path);
});

Then("the item page shows spec section {string}'s Before beside its After", function (section: string) {
  const entry = ruleEntry(this, section);
  const before = text(side(entry, "before"));
  const after = text(side(entry, "after"));
  const c = ctx(this);
  assert.equal(before, onMain(c, section), `the Before shown for ${section}`);
  const want = c.entries.find((e) => e.place === section)?.after;
  assert.equal(after, want, `the After shown for ${section}`);
  (this as { pbi395Entry?: string }).pbi395Entry = entry;
});

function shownEntry(world: object): string {
  const e = (world as { pbi395Entry?: string }).pbi395Entry;
  assert.ok(e, "no rule's Before and After were read");
  return e;
}

function marks(world: object, which: "before" | "after", phrases: string[]): void {
  const words = marked(side(shownEntry(world), which));
  for (const phrase of phrases) {
    for (const w of phrase.split(/\s+/)) assert.ok(words.includes(w), `the ${which === "before" ? "Before" : "After"} doesn't mark "${w}"; it marks: ${words.join(", ") || "nothing"}`);
  }
}

Then("the Before marks {string} and {string} as words that change", function (a: string, b: string) {
  marks(this, "before", [a, b]);
  // "minute" changes and "minutes" doesn't, so a mark on "minutes" is a mark on a word that stays.
  const words = marked(side(shownEntry(this), "before"));
  assert.ok(!words.includes("minutes"), `the Before marks "minutes", which doesn't change: ${words.join(", ")}`);
});

Then("the After marks {string} and {string} as words that change", function (a: string, b: string) {
  marks(this, "after", [a, b]);
  const words = marked(side(shownEntry(this), "after"));
  assert.ok(!words.includes("minutes"), `the After marks "minutes", which doesn't change: ${words.join(", ")}`);
});

Then("neither marks {string} as words that change", function (phrase: string) {
  for (const which of ["before", "after"] as const) {
    const words = marked(side(shownEntry(this), which));
    for (const w of phrase.split(/\s+/)) assert.ok(!words.includes(w), `the ${which === "before" ? "Before" : "After"} marks "${w}", which doesn't change`);
  }
});

Then("the item page says {string} approved the rule change at {string}", function (login: string, at: string) {
  const part = text(rulesPart(this));
  const shown = new Date(at).toISOString().slice(0, 16).replace("T", " ");
  assert.ok(part.includes(login) && /approved/i.test(part) && part.includes(shown),
    `the Rule changes section doesn't say ${login} approved the rule change at ${shown}: ${part}`);
});
