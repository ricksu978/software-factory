// Step definitions for features/pbi-175-configuration-page.feature. The settings are read and changed through the
// orchestrator API, src/api/main.ts's apiApp, built in-process on PBI 4's shared test database with
// features/support/split-services.ts and called as the person a step names. What a person sees is the SPA's own
// Configuration page, web/src/pages/Configuration.tsx, rendered from what the API answered, as the browser renders it
// (PBI 283). "The factory started with" builds the env the API is handed as ApiDeps.env, so an env-backed setting's
// value is the one the API read at start. Runtime settings are the one wip_policy row, set and read with plain SQL;
// only the page and its change requests go through src.
//
// The page's contract these steps read:
// - The Configuration page is the SPA's /configuration, drawn from GET /v1/configuration, and Floor links to it with an
//   <a> whose text is "Configuration". Its <h1> is "Configuration".
// - Runtime settings sit under <h2>Runtime settings</h2>, env-backed ones under <h2>Env-backed settings</h2>; each
//   section runs to the next <h2>. A setting is one <tr>: its first <td> or <th> holds its name ("review capacity",
//   case aside, or the env name such as "GITHUB_APP_ID"). Its value is the text of another cell, or the value of an
//   <input> in the row. A setting with no value shows "not set". A row marked as needing a restart says "restart".
// - A change is POST /v1/configuration, a JSON body with `setting` set to the key below (an env-backed setting's key is
//   its env name) and `value` set to the new value, empty to clear it. A change that's taken answers 200, and the page,
//   read again, then says "<setting> changed"; one that breaks a rule answers 4xx with the reason, which the page says.
// - The activity log (GET /v1/activity, drawn by the SPA's Activity page) shows a change as one <tr> that names who
//   made it, the setting, and the old and new values.
import { After, Before, BeforeStep, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { apiApp } from "../../src/api/main.ts";
import { fakeBacklog, fakeRepoHost } from "../../src/adapters/fake.ts";
import { NO_ACCESS_TEXT } from "../../web/src/shell.ts";
import { callApi, renderNoAccess, renderPage, TEST_AUDIENCE, TEST_ISSUER, testBearer, type Page } from "../support/split-services.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";
import { ctx as schedulerCtx, newItem, tick } from "./pbi-17.steps.ts";
import { browserOf, ctx as pbi19, openSpa, recordResponse } from "./pbi-19.steps.ts";

type Ctx = {
  env: Record<string, string | undefined>;
  /** The orchestrator API, built on first use with the env the scenario says the factory started with. */
  api$?: ReturnType<typeof apiApp>;
  /** Ends the API's event feed. Other features' hooks call it too, so it ends it once. */
  close?: () => Promise<void>;
  sourceId?: string;
  status?: number;
  page?: string;
  /** The status of the last change sent to the page. */
  posted?: number;
  /** The type of the step running now, so a step that reads the same as a Given and a Then knows which it is. */
  stepType?: string;
  /** Who the Background signed in to the dashboard, the person whose Floor the link steps read. */
  signedIn?: string;
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
  // PBI 319: the effort every agent call names.
  effort: { column: "effort", key: "effort", kind: "text" },
};

function runtime(name: string) {
  const s = RUNTIME[name.trim().toLowerCase()];
  assert.ok(s, `unknown runtime setting "${name}"`);
  return s;
}

/** A change's key: a runtime setting's own key, or an env-backed setting's env name. */
const keyOf = (name: string) => RUNTIME[name.trim().toLowerCase()]?.key ?? name.trim();

const pool = () => need().pool;
export const decode = (html: string) => html.replace(/&#39;/g, "'").replace(/&#x27;/gi, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
export const text = (html: string) => decode(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
const unquote = (v: string) => v.trim().replace(/^"(.*)"$/, "$1");
export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

BeforeStep({ tags: "@pbi-175 or @pbi-176 or @pbi-178 or @pbi-284 or @pbi-287 or @pbi-319" }, function ({ pickleStep }) {
  ctx(this).stepType = pickleStep.type;
});

// PBI 176, PBI 178 and PBI 319 build on this page, so their scenarios share these hooks and steps. Every PBI 319
// scenario signs people in, its one without @db included, so each gets the database.
Before({ tags: "((@pbi-175 or @pbi-176 or @pbi-178) and @db) or @pbi-319", ...long }, async function () {
  const d = await testDb();
  if (!d) return;
  await d.pool.query('truncate item, event, backlog_source, repo, "user", override cascade');
  await d.pool.query(
    `update wip_policy set mode = 'fixed', wip_min = 1, wip_max = 1, current_wip = 1, review_capacity = 3, usage_reserve_at = 0.7,
       usage_paused_until = null, daily_budget = null`,
  );
});

After({ tags: "@pbi-175 or @pbi-176 or @pbi-178 or @pbi-319", ...long }, async function () {
  await ctx(this).close?.();
});

/**
 * The orchestrator API and a fresh backlog source, made on first use, with the env the scenario says the factory
 * started with. Other features' steps call it for the source their items go in.
 */
export async function dashboard(c: Ctx): Promise<ReturnType<typeof apiApp>> {
  c.sourceId ??= (await pool().query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'pbi-175:' || gen_random_uuid()) returning id")).rows[0].id;
  if (c.api$) return c.api$;
  const api = apiApp({
    pool: pool(), issuer: TEST_ISSUER, audience: TEST_AUDIENCE, webhookSecret: "pbi-175", readBlob: async () => null, env: { ...c.env }, verify: testBearer,
  });
  c.api$ = api;
  c.close = async () => {
    c.close = undefined;
    if (c.api$ === api) c.api$ = undefined;
    await api.close();
  };
  return api;
}

export async function user(login: string, role: string): Promise<void> {
  // Keyed by a provider as the steps that share these users key them. callApi puts them under the test issuer.
  await pool().query(
    `insert into "user" (provider, subject, github_login, role) values ('microsoft', $1, $1, $2)
     on conflict (provider, subject) do update set role = excluded.role`,
    [login, role],
  );
}

/** The SPA's page at `path`, a page's address as today's dashboard or the SPA names it, and the API route it reads. */
function pageAt(path: string): { page: Page; route: string } {
  const p = path.split("?")[0];
  const fixed: Record<string, { page: Page; route: string }> = {
    "/": { page: "floor", route: "/v1/floor" },
    "/configuration": { page: "configuration", route: "/v1/configuration" },
    "/activity": { page: "activity", route: "/v1/activity" },
    "/phase0": { page: "phase0", route: "/v1/phase0" },
  };
  if (fixed[p]) return fixed[p];
  const item = /^\/(?:items|runs)\/([^/]+)$/.exec(p);
  assert.ok(item, `no SPA page is at ${path}`);
  return { page: "item", route: `/v1/items/${item[1]}` };
}

/**
 * What the SPA shows for a read the API answered: the page, the no-access page on a 403, or the API's own answer. The
 * empty comments React puts between adjacent text, which a browser never shows, are left out, so "#<!-- -->482" reads
 * "#482" as it does on screen.
 */
async function shown(page: Page, r: { status: number; text: string; json?: unknown }, o: { message?: string | null; notice?: string | null } = {}): Promise<string> {
  if (r.status === 200) return (await renderPage(page, r.json, { zone: "UTC", ...o })).replace(/<!-- -->/g, "");
  if (r.status === 403) return renderNoAccess(NO_ACCESS_TEXT);
  return r.text;
}

/** Opens the SPA's page at `path` as `login`, reading what it shows from the API. */
export async function get(world: object, path: string, login: string): Promise<void> {
  const c = ctx(world);
  const { page, route } = pageAt(path);
  const r = await callApi((await dashboard(c)).app, pool(), login, "GET", route);
  c.status = r.status;
  c.page = await shown(page, r);
  recordResponse(world, c.status, c.page);
}

/**
 * Sends a change to the Configuration page as `login`, as its form does, then reads the page again as the SPA draws
 * it: with the factory's word on the saved change, or with the reason it turned the change down. `extra` adds fields to
 * the change, such as PBI 176's `reason`.
 */
export async function change(world: object, login: string, setting: string, value: string, extra: Record<string, string> = {}): Promise<void> {
  const c = ctx(world);
  const app = (await dashboard(c)).app;
  const r = await callApi(app, pool(), login, "POST", "/v1/configuration", { setting: keyOf(setting), value, ...extra });
  c.posted = r.status;
  const said = (r.json as { notice?: string; error?: string } | undefined) ?? {};
  const again = await callApi(app, pool(), login, "GET", "/v1/configuration");
  if (r.status === 200) {
    c.status = again.status;
    c.page = await shown("configuration", again, { notice: said.notice ?? null });
  } else {
    c.status = r.status;
    c.page = again.status === 200 ? await shown("configuration", again, { message: said.error ?? r.text }) : r.text;
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

export function settingRow(c: Ctx, which: keyof typeof SECTIONS, name: string): Row {
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
  ctx(this).signedIn = login;
  await pool().query(
    `insert into "user" (provider, subject, github_login, role) values ('microsoft', $1, $1, 'viewer') on conflict (provider, subject) do nothing`,
    [login],
  );
});

Given("{string} is an operator", long, async function (login: string) {
  await user(login, "operator");
});

// As a Given this adds the viewer; as a Then (PBI 284's owner adding someone through the API) it reads them, by the
// subject or GitHub login the API stored them under.
Given("{string} is a viewer", long, async function (login: string) {
  if (ctx(this).stepType !== "Outcome") return user(login, "viewer");
  const rows = (await pool().query<{ role: string }>(`select role from "user" where subject = $1 or github_login = $1`, [login])).rows;
  assert.deepEqual(rows.map((r) => r.role), ["viewer"], `"${login}" isn't one viewer in the user table`);
});

Given("the factory started with {word} set to {string}", function (name: string, value: string) {
  const c = ctx(this);
  assert.ok(!c.api$, "the API already started");
  c.env[name] = value;
});

Given("the factory started without {word}", function (name: string) {
  const c = ctx(this);
  assert.ok(!c.api$, "the API already started");
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

// PBI 19's "{string} opens Floor" opens the SPA through the BFF, as the person signs in, and its page is the SPA's
// Floor drawn from GET /v1/floor. The link steps read that Floor, and follow a link there through the same BFF.
function floorPage(world: object): string {
  const f = pbi19(world);
  assert.ok(f.status !== undefined && f.page !== undefined, "Floor didn't load");
  assert.equal(f.status, 200, `Floor answered ${f.status}: ${f.page.slice(0, 300)}`);
  return f.page;
}

Then("Floor has a link named {string}", function (name: string) {
  const links = [...floorPage(this).matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => text(m[1]));
  assert.ok(links.includes(name), `Floor has no link named "${name}": ${links.join(", ")}`);
});

When("{string} follows the {string} link", long, async function (login: string, name: string) {
  const floor = floorPage(this);
  const link = [...floor.matchAll(/<a\b[^>]*\bhref\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)].find((m) => text(m[2]) === name);
  // With no such link, the page that comes back is the one without it, and the heading's Then fails on that.
  if (!link) return;
  const dash = pbi19(this).dash;
  assert.ok(dash, "Floor wasn't opened through the BFF");
  const { page, route } = pageAt(decode(link[1]));
  const opened = await openSpa(dash, await browserOf(dash, login), page, `/bff${route}`);
  const c = ctx(this);
  c.status = opened.status;
  c.page = opened.page;
  recordResponse(this, c.status, c.page);
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
  // "No setting" means something only once the page shows settings to someone allowed to see them: a viewer added here,
  // since the allowlist's own people may sign in at another issuer than the test one.
  const allowed = "pbi-175-allowed";
  await pool().query(`insert into "user" (issuer, subject, role) values ($1, $2, 'viewer') on conflict do nothing`, [TEST_ISSUER, allowed]);
  await get(this, "/configuration", allowed);
  const shown = [...rows(section(okPage(c), SECTIONS.runtime)), ...rows(section(okPage(c), SECTIONS.env))].map((r) => r.name);
  assert.ok(shown.length > 0, "the Configuration page shows no setting even to an allowlisted user");
  const leaked = shown.filter((n) => text(refused).toLowerCase().includes(n.toLowerCase()));
  assert.deepEqual(leaked, [], "the refused page shows settings");
  assert.ok(!/<h2\b[^>]*>\s*(Runtime|Env-backed) settings/i.test(refused), "the refused page has a settings section");
});

// ---- runtime settings ----

Then("the runtime settings list {string} with the value {string}", long, async function (name: string, value: string) {
  // PBI 319: after a change that was turned down or refused, the response on hand isn't the page, so the setting is
  // read from the Configuration page as an operator opens it now.
  if ((this as { pbi319?: unknown }).pbi319 && !settingsPage(ctx(this))) await reopen(this);
  listsWith(ctx(this), "runtime", name, value);
});

/** True when the response on hand is the Configuration page, answered 200. */
function settingsPage(c: Ctx): boolean {
  return c.status === 200 && /<h2\b[^>]*>\s*Runtime settings/i.test(c.page ?? "");
}

/** Opens the Configuration page as the first operator or owner, as they'd see it now. */
async function reopen(world: object): Promise<void> {
  const login = (await pool().query<{ subject: string }>(`select subject from "user" where role in ('operator', 'owner') order by subject limit 1`)).rows[0]?.subject;
  assert.ok(login, "no operator to open the Configuration page");
  await get(world, "/configuration", login);
}

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

// PBI 176 says every change needs a reason, clearing one too.
When(/^"([^"]*)" clears (.+) on the Configuration page, giving the reason "(.*)"$/, long, async function (login: string, name: string, reason: string) {
  await change(this, login, name, "", { reason });
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

/** The SPA's Activity page as `login` opens it, drawn from GET /v1/activity. */
export async function activityPage(world: object, login: string): Promise<string> {
  const r = await callApi((await dashboard(ctx(world))).app, pool(), login, "GET", "/v1/activity");
  assert.equal(r.status, 200, `the activity log answered ${r.status} for ${login}: ${r.text.slice(0, 300)}`);
  return renderPage("activity", r.json, { zone: "UTC" });
}

export async function activityRows(world: object, login: string): Promise<string[]> {
  const page = await activityPage(world, login);
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
