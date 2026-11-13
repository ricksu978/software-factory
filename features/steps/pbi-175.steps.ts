// Step definitions for features/pbi-175-configuration-page.feature. The dashboard runs as the real node:http server on
// a free port, on PBI 4's shared test database, and people sign in with the headers Container Apps adds, as PBI 19's
// and PBI 105's steps do. "The factory started with" builds the env the dashboard is handed as DashboardDeps.env, so
// an env-backed setting's value is the one the control plane read at start. Runtime settings are the one wip_policy
// row, set and read with plain SQL; only the page and its change requests go through src.
//
// The page's contract these steps read:
// - The Configuration page is GET /configuration, and Floor links to it with an <a> whose text is "Configuration".
//   Its <h1> is "Configuration".
// - Runtime settings sit under <h2>Runtime settings</h2>, env-backed ones under <h2>Env-backed settings</h2>; each
//   section runs to the next <h2>. A setting is one <tr>: its first <td> or <th> holds its name ("review capacity",
//   case aside, or the env name such as "GITHUB_APP_ID"). Its value is the text of another cell, or the value of an
//   <input> in the row. A setting with no value shows "not set". A row marked as needing a restart says "restart".
// - A change is POST /configuration, a form with `setting` set to the key below (an env-backed setting's key is its
//   env name) and `value` set to the new value, empty to clear it. A change that's taken answers 303 to the page or
//   200 with it, and the page then says "<setting> changed"; one that breaks a rule answers 4xx with the reason.
// - The activity log (GET /activity) shows a change as one <tr> that names who made it, the setting, and the old and
//   new values.
import { After, Before, BeforeStep, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fakeBacklog, fakeRepoHost } from "../../src/adapters/fake.ts";
import { createAuth } from "../../src/http/auth.ts";
import { dashboardRoutes } from "../../src/http/routes.ts";
import { startServer } from "../../src/http/server.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";
import { ctx as schedulerCtx, newItem, tick } from "./pbi-17.steps.ts";
import { recordResponse } from "./pbi-19.steps.ts";

type Ctx = {
  env: Record<string, string | undefined>;
  server?: Server;
  close?: () => Promise<void>;
  origin?: string;
  sourceId?: string;
  status?: number;
  page?: string;
  /** The status of the last change sent to the page, before any redirect was followed. */
  posted?: number;
  /** The type of the step running now, so a step that reads the same as a Given and a Then knows which it is. */
  stepType?: string;
};

export function ctx(world: object): Ctx {
  const w = world as { pbi175?: Ctx };
  w.pbi175 ??= { env: {} };
  return w.pbi175;
}

/** Each runtime setting as the feature names it: its wip_policy column and the key a change carries. */
const RUNTIME: Record<string, { column: string; key: string; kind: "text" | "number" | "time" }> = {
  "wip mode": { column: "mode", key: "mode", kind: "text" },
  "wip minimum": { column: "wip_min", key: "wip_min", kind: "number" },
  "wip maximum": { column: "wip_max", key: "wip_max", kind: "number" },
  "current wip": { column: "current_wip", key: "current_wip", kind: "number" },
  "review capacity": { column: "review_capacity", key: "review_capacity", kind: "number" },
  "usage reserve": { column: "usage_reserve_at", key: "usage_reserve", kind: "number" },
  "daily budget": { column: "daily_budget", key: "daily_budget", kind: "number" },
  "usage pause": { column: "usage_paused_until", key: "usage_pause", kind: "time" },
};

function runtime(name: string) {
  const s = RUNTIME[name.trim().toLowerCase()];
  assert.ok(s, `unknown runtime setting "${name}"`);
  return s;
}

/** A change's key: a runtime setting's own key, or an env-backed setting's env name. */
const keyOf = (name: string) => RUNTIME[name.trim().toLowerCase()]?.key ?? name.trim();

const pool = () => need().pool;
export const headers = (login: string) => ({ "x-ms-client-principal-idp": "aad", "x-ms-client-principal-id": login, "x-ms-client-principal-name": login });
export const decode = (html: string) => html.replace(/&#39;/g, "'").replace(/&#x27;/gi, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
export const text = (html: string) => decode(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
const unquote = (v: string) => v.trim().replace(/^"(.*)"$/, "$1");
export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

BeforeStep({ tags: "@pbi-175 or @pbi-176" }, function ({ pickleStep }) {
  ctx(this).stepType = pickleStep.type;
});

// PBI 176 builds on this page, so its scenarios share these hooks and steps.
Before({ tags: "(@pbi-175 or @pbi-176) and @db", ...long }, async function () {
  const d = await testDb();
  if (!d) return;
  await d.pool.query('truncate item, event, backlog_source, repo, "user", override cascade');
  await d.pool.query(
    `update wip_policy set mode = 'fixed', wip_min = 1, wip_max = 1, current_wip = 1, review_capacity = 3, usage_reserve_at = 0.7,
       usage_paused_until = null, daily_budget = null`,
  );
});

After({ tags: "@pbi-175 or @pbi-176", ...long }, async function () {
  const c = ctx(this);
  await c.close?.();
  if (c.server) {
    c.server.closeAllConnections();
    await new Promise<void>((resolve) => c.server!.close(() => resolve()));
  }
  // PBI 19's "the factory's allowlist holds only" starts its own dashboard, which its After closes only for @pbi-19.
  const other = (this as { pbi19?: { server?: Server } }).pbi19?.server;
  if (other) {
    other.closeAllConnections();
    await new Promise<void>((resolve) => other.close(() => resolve()));
  }
});

/** The dashboard, started on first use with the env the scenario says the factory started with. */
export async function dashboard(c: Ctx): Promise<void> {
  if (c.server) return;
  c.sourceId ??= (await pool().query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'pbi-175:' || gen_random_uuid()) returning id")).rows[0].id;
  let handler: ReturnType<typeof dashboardRoutes> | undefined;
  c.server = await startServer([(req, res) => handler!(req, res)], { port: 0 });
  c.origin = `http://127.0.0.1:${(c.server.address() as AddressInfo).port}`;
  handler = dashboardRoutes({
    pool: pool(), auth: createAuth({ mode: "azure" }), origin: c.origin, adapter: fakeBacklog().adapter, sourceId: c.sourceId, env: { ...c.env },
  });
  c.close = handler.close;
}

export async function user(login: string, role: string): Promise<void> {
  await pool().query(
    `insert into "user" (provider, subject, github_login, role) values ('microsoft', $1, $1, $2)
     on conflict (provider, subject) do update set role = excluded.role`,
    [login, role],
  );
}

export async function get(world: object, path: string, login: string): Promise<void> {
  const c = ctx(world);
  await dashboard(c);
  const r = await fetch(`${c.origin}${path}`, { headers: headers(login), redirect: "manual" });
  c.status = r.status;
  c.page = await r.text();
  recordResponse(world, c.status, c.page);
}

/**
 * Sends a change to the page as `login`, from the dashboard's own origin, and follows a redirect back to the page.
 * `extra` adds form fields, such as PBI 176's `reason`.
 */
export async function change(world: object, login: string, setting: string, value: string, extra: Record<string, string> = {}): Promise<void> {
  const c = ctx(world);
  await dashboard(c);
  const r = await fetch(`${c.origin}/configuration`, {
    method: "POST",
    headers: { ...headers(login), origin: c.origin!, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ setting: keyOf(setting), value, ...extra }).toString(),
    redirect: "manual",
  });
  c.posted = r.status;
  c.status = r.status;
  c.page = await r.text();
  const location = r.headers.get("location");
  if (r.status >= 300 && r.status < 400 && location) {
    const next = await fetch(new URL(location, c.origin), { headers: headers(login), redirect: "manual" });
    c.status = next.status;
    c.page = await next.text();
  }
  recordResponse(world, c.status, c.page);
}

/** The page, which must have come back as a 200. */
function okPage(c: Ctx): string {
  assert.ok(c.page !== undefined, "no page came back");
  assert.equal(c.status, 200, `the Configuration page answered ${c.status}: ${c.page.slice(0, 300)}`);
  return c.page;
}

/** The markup under the <h2> named `title`, up to the next <h2>. */
function section(html: string, title: string): string {
  const start = html.search(new RegExp(`<h2\\b[^>]*>\\s*${escapeRe(title)}\\s*</h2>`, "i"));
  assert.ok(start >= 0, `the page has no "${title}" section: ${text(html).slice(0, 300)}`);
  const rest = html.slice(start).replace(/^<h2\b[^>]*>[\s\S]*?<\/h2>/i, "");
  const end = rest.search(/<h2\b/i);
  return end < 0 ? rest : rest.slice(0, end);
}

type Row = { name: string; values: string[]; html: string };

function rows(html: string): Row[] {
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].flatMap((m) => {
    const cells = [...m[1].matchAll(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((x) => x[2]);
    if (cells.length < 2 || !/<td\b/i.test(m[1])) return [];
    const inputs = [...m[1].matchAll(/<input\b[^>]*\bvalue\s*=\s*"([^"]*)"/gi)].map((x) => decode(x[1]));
    return [{ name: text(cells[0]), values: [...cells.slice(1).map(text), ...inputs], html: m[1] }];
  });
}

const SECTIONS = { runtime: "Runtime settings", env: "Env-backed settings" } as const;

function settingRow(c: Ctx, which: keyof typeof SECTIONS, name: string): Row {
  const all = rows(section(okPage(c), SECTIONS[which]));
  const found = all.filter((r) => r.name.toLowerCase() === name.trim().toLowerCase());
  assert.equal(found.length, 1, `the ${SECTIONS[which].toLowerCase()} list "${name}" ${found.length} times; they list: ${all.map((r) => r.name).join(", ")}`);
  return found[0];
}

function hasValue(row: Row, value: string): boolean {
  return row.values.some((v) => v === value || v.split(/\s*[|·]\s*|\s{2,}/).includes(value));
}

function listsWith(c: Ctx, which: keyof typeof SECTIONS, name: string, value: string): void {
  const row = settingRow(c, which, name);
  assert.ok(hasValue(row, value), `"${name}" shows ${JSON.stringify(row.values)}, not "${value}"`);
}

function needsRestart(c: Ctx, name: string): boolean {
  const page = okPage(c);
  const which = rows(section(page, SECTIONS.env)).some((r) => r.name.toLowerCase() === name.trim().toLowerCase()) ? "env" : "runtime";
  return /restart/i.test(text(settingRow(c, which, name).html));
}

const FIELD = /<(input|select|textarea|button)\b/i;

// ---- the factory and who's signed in ----

Given("the factory runs locally for {string}", function (login: string) {
  const c = ctx(this);
  c.env.FACTORY_ENV = "local";
  c.env.FACTORY_DEV_LOGIN = login;
});

// Signing in adds a viewer, but never lowers the role of someone a scenario has already made an operator or owner.
Given("{string} is signed in to the dashboard", long, async function (login: string) {
  await pool().query(
    `insert into "user" (provider, subject, github_login, role) values ('microsoft', $1, $1, 'viewer') on conflict (provider, subject) do nothing`,
    [login],
  );
});

Given("{string} is an operator", long, async function (login: string) {
  await user(login, "operator");
});

Given("{string} is a viewer", long, async function (login: string) {
  await user(login, "viewer");
});

Given("the factory started with {word} set to {string}", function (name: string, value: string) {
  const c = ctx(this);
  assert.ok(!c.server, "the dashboard already started");
  c.env[name] = value;
});

Given("the factory started without {word}", function (name: string) {
  const c = ctx(this);
  assert.ok(!c.server, "the dashboard already started");
  delete c.env[name];
});

// ---- the WIP policy ----

/** The settings a step names, such as `WIP minimum set to 1, WIP maximum set to 3 and current WIP set to 1`. */
function settings(list: string): [string, string][] {
  return list.split(/, | and (?=[^,]* set to )/).map((part) => {
    const m = /^(.+?) set to (.+)$/.exec(part.trim());
    assert.ok(m, `can't read "${part}" as a setting and its value`);
    return [m[1], unquote(m[2])];
  });
}

async function stored(name: string): Promise<unknown> {
  const s = runtime(name);
  return (await pool().query(`select ${s.column} as v from wip_policy limit 1`)).rows[0].v;
}

async function assertStored(name: string, expected: string | null): Promise<void> {
  const s = runtime(name);
  const v = await stored(name);
  if (expected === null) return assert.equal(v, null, `the WIP policy has ${name} set to ${String(v)}`);
  assert.notEqual(v, null, `the WIP policy has no ${name}`);
  if (s.kind === "number") assert.equal(Number(v), Number(expected), `the WIP policy has ${name} set to ${String(v)}`);
  else if (s.kind === "time") assert.equal((v as Date).getTime(), new Date(expected).getTime(), `the WIP policy has ${name} set to ${String(v)}`);
  else assert.equal(v, expected);
}

async function setStored(name: string, value: string | null): Promise<void> {
  await pool().query(`update wip_policy set ${runtime(name).column} = $1`, [value]);
}

// As a Given this sets the policy; as a Then it reads it.
Given(/^the factory's WIP policy has (?!no )(.+ set to .+)$/, long, async function (list: string) {
  const outcome = ctx(this).stepType === "Outcome";
  for (const [name, value] of settings(list)) {
    if (outcome) await assertStored(name, value);
    else await setStored(name, value);
  }
});

Given(/^the factory's WIP policy has no (.+)$/, long, async function (name: string) {
  if (ctx(this).stepType === "Outcome") await assertStored(name, null);
  else await setStored(name, null);
});

Then(/^the factory's WIP policy still has (.+) set to (.+)$/, long, async function (name: string, value: string) {
  await assertStored(name, unquote(value));
});

When(/^the factory's WIP policy changes (.+) to (.+)$/, long, async function (name: string, value: string) {
  await setStored(name, unquote(value));
});

// ---- opening the page ----

// PBI 19's "{string} opens Floor" serves Floor and records it where recordResponse does.
function floorPage(world: object): string {
  const f = (world as { pbi19?: { status?: number; page?: string } }).pbi19;
  assert.ok(f?.page !== undefined, "Floor didn't load");
  assert.equal(f.status, 200, `Floor answered ${f.status}`);
  return f.page;
}

Then("Floor has a link named {string}", function (name: string) {
  const links = [...floorPage(this).matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => text(m[1]));
  assert.ok(links.includes(name), `Floor has no link named "${name}": ${links.join(", ")}`);
});

When("{string} follows the {string} link", long, async function (login: string, name: string) {
  const floor = (this as { pbi19?: { page?: string } }).pbi19?.page ?? "";
  const link = [...floor.matchAll(/<a\b[^>]*\bhref\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)].find((m) => text(m[2]) === name);
  // With no such link, the page that comes back is the one without it, and the heading's Then fails on that.
  if (link) await get(this, decode(link[1]), login);
});

Then("the page's heading is {string}", function (heading: string) {
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(okPage(ctx(this)));
  assert.ok(h1, "the page has no <h1> heading");
  assert.equal(text(h1[1]), heading);
});

When(/^"([^"]*)" (?:opens|has opened) the Configuration page(?: once| again)?$/, long, async function (login: string) {
  await get(this, "/configuration", login);
});

When("{string} signs in and opens the Configuration page", long, async function (login: string) {
  await get(this, "/configuration", login);
});

Then("the page shows no setting", long, async function () {
  const c = ctx(this);
  const refused = c.page ?? "";
  // "No setting" means something only once the page shows settings to someone allowed to see them.
  const allowed = (await pool().query<{ subject: string }>(`select subject from "user" where provider = 'microsoft' order by subject limit 1`)).rows[0]?.subject;
  assert.ok(allowed, "no one is allowlisted to compare with");
  await get(this, "/configuration", allowed);
  const shown = [...rows(section(okPage(c), SECTIONS.runtime)), ...rows(section(okPage(c), SECTIONS.env))].map((r) => r.name);
  assert.ok(shown.length > 0, "the Configuration page shows no setting even to an allowlisted user");
  const leaked = shown.filter((n) => text(refused).toLowerCase().includes(n.toLowerCase()));
  assert.deepEqual(leaked, [], "the refused page shows settings");
  assert.ok(!/<h2\b[^>]*>\s*(Runtime|Env-backed) settings/i.test(refused), "the refused page has a settings section");
});

// ---- runtime settings ----

Then("the runtime settings list {string} with the value {string}", function (name: string, value: string) {
  listsWith(ctx(this), "runtime", name, value);
});

Then("the runtime settings list {string} as {string}", function (name: string, value: string) {
  listsWith(ctx(this), "runtime", name, value);
});

Then("the runtime settings list {string}", function (name: string) {
  settingRow(ctx(this), "runtime", name);
});

Then("the runtime settings don't show {string} with the value {string}", function (name: string, value: string) {
  const row = settingRow(ctx(this), "runtime", name);
  assert.ok(!hasValue(row, value), `"${name}" still shows "${value}": ${JSON.stringify(row.values)}`);
});

Then("{string} isn't marked as needing a restart", long, async function (name: string) {
  const c = ctx(this);
  // After a change the page on hand may be the scheduler's; read the Configuration page as it is now.
  if (!/<h2\b[^>]*>\s*Runtime settings/i.test(c.page ?? "")) {
    const login = (await pool().query<{ subject: string }>(`select subject from "user" where role in ('operator', 'owner') order by subject limit 1`)).rows[0]?.subject ?? "octo";
    await get(this, "/configuration", login);
  }
  assert.ok(!needsRestart(c, name), `"${name}" is marked as needing a restart`);
});

Then("{string} is marked as needing a restart", function (name: string) {
  assert.ok(needsRestart(ctx(this), name), `"${name}" isn't marked as needing a restart`);
});

// ---- changing a runtime setting ----

When(/^"([^"]*)" changes (.+) to "([^"]*)" on the Configuration page$/, long, async function (login: string, name: string, value: string) {
  await change(this, login, name, value);
});

When(/^"([^"]*)" clears (.+) on the Configuration page$/, long, async function (login: string, name: string) {
  await change(this, login, name, "");
});

When(/^"([^"]*)" sends a change of (.+) to "([^"]*)" to the Configuration page$/, long, async function (login: string, name: string, value: string) {
  await change(this, login, name, value);
});

Then("the change is turned down with the message {string}", function (message: string) {
  const c = ctx(this);
  assert.ok(c.posted !== undefined, "no change was sent");
  assert.ok(c.posted >= 400 && c.posted < 500, `the change answered ${c.posted}, not a 4xx: ${(c.page ?? "").slice(0, 300)}`);
  assert.ok(text(c.page ?? "").includes(message), `the page doesn't say "${message}": ${text(c.page ?? "").slice(0, 300)}`);
});

Then("the page has no field, form or button to change a setting", function () {
  const page = okPage(ctx(this));
  assert.ok(!/<form\b/i.test(page), "the page has a form");
  assert.ok(!FIELD.test(page), "the page has a field or button");
});

Then("the page has no field to change {string}", function (name: string) {
  const row = settingRow(ctx(this), "runtime", name);
  assert.ok(!FIELD.test(row.html), `"${name}" has a field`);
  const key = keyOf(name);
  assert.ok(!new RegExp(`\\bname\\s*=\\s*"${escapeRe(key)}"`, "i").test(okPage(ctx(this))), `the page has a field named ${key}`);
  assert.ok(!new RegExp(`\\bvalue\\s*=\\s*"${escapeRe(key)}"`, "i").test(okPage(ctx(this))), `the page offers ${key} as a setting to change`);
});

Then("the page has no field, form or button to change an env-backed setting", function () {
  const env = section(okPage(ctx(this)), SECTIONS.env);
  assert.ok(!/<form\b/i.test(env), "the env-backed settings have a form");
  assert.ok(!FIELD.test(env), "the env-backed settings have a field or button");
});

// ---- the scheduler ----

Given("one item is in progress and another is queued", long, async function () {
  const s = schedulerCtx(this);
  s.backlog = fakeBacklog();
  s.repoHost = fakeRepoHost();
  s.repoHost.heads.set("ricksu978/software-factory", "c0ffee0");
  await pool().query("insert into repo (host_adapter, url) values ('github', 'https://github.com/ricksu978/software-factory')");
  await newItem(s, "running", "InProgress", { owner: "cell-1", expires: new Date(Date.now() + 3_600_000) });
  await newItem(s, "queued", "Queued");
});

When("the scheduler takes its next turn, with no restart", long, async function () {
  const s = schedulerCtx(this);
  s.now = new Date();
  await tick(s);
});

Then("the queued item is in progress", long, async function () {
  const s = schedulerCtx(this);
  assert.ok(s.ticked, "the scheduler never ticked");
  const state = (await pool().query<{ state: string }>("select state from item where id = $1", [s.items.queued])).rows[0].state;
  assert.equal(state, "InProgress");
});

// ---- the activity log ----

export async function activityRows(world: object, login: string): Promise<string[]> {
  const c = ctx(world);
  await dashboard(c);
  const r = await fetch(`${c.origin}/activity`, { headers: headers(login), redirect: "manual" });
  const page = await r.text();
  assert.equal(r.status, 200, `the activity log answered ${r.status}`);
  return [...page.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]).filter((r) => /<td\b/i.test(r)).map(text);
}

Then(/^the activity log shows that "([^"]*)" changed (.+) from "([^"]*)" to "([^"]*)"$/, long, async function (login: string, name: string, from: string, to: string) {
  const all = await activityRows(this, login);
  const word = (s: string) => new RegExp(`(?<![\\w.])${escapeRe(s)}(?![\\w]|\\.\\d)`, "i");
  const found = all.filter((r) => [login, name, from, to].every((v) => word(v).test(r)));
  assert.equal(found.length, 1, `the activity log has ${found.length} rows of ${login} changing ${name} from ${from} to ${to}:\n${all.join("\n")}`);
});

Then(/^the activity log shows no change to (.+)$/, long, async function (name: string) {
  const login = (await pool().query<{ subject: string }>(`select subject from "user" order by subject limit 1`)).rows[0]?.subject;
  assert.ok(login, "no one is allowlisted to open the activity log");
  const all = await activityRows(this, login);
  const shown = all.filter((r) => r.toLowerCase().includes(name.trim().toLowerCase()));
  assert.deepEqual(shown, [], `the activity log shows a change to ${name}`);
});

// ---- env-backed settings ----

Then("the env-backed settings list {string} with the value {string}", function (name: string, value: string) {
  listsWith(ctx(this), "env", name, value);
});

Then("the env-backed settings list {string} as {string}", function (name: string, value: string) {
  listsWith(ctx(this), "env", name, value);
});

Then("the page has no bold element from the value", function () {
  const page = okPage(ctx(this));
  assert.ok(!/<b>x<\/b>/i.test(page), "the value's bold element reached the page");
});

Then("the page doesn't show {string} anywhere, in its text or its markup", function (value: string) {
  const page = okPage(ctx(this));
  assert.ok(!page.includes(value), `the page's markup holds "${value}"`);
  assert.ok(!decode(page).includes(value), `the page's text shows "${value}"`);
});
