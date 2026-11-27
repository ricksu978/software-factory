// Step definitions for features/pbi-89-dashboard-wiring.feature. The @db scenarios run the split services in this
// process, on PBI 4's shared test database, with a fake board, through PBI 19's startDashboard: the orchestrator API
// and the cell API behind one front server on a free port, and the BFF in front of them, signing people in at the test
// sign-in provider. "{string} is signed in" signs the person in at that provider through the BFF, and the dashboard's
// calls they make then go through the BFF, as the SPA's do. GitHub's webhook goes to the API, and the worker's tick
// and outbox run as the worker runs them. The startup scenarios run src/api/main.ts itself as a child process. The
// @local one starts the AppHost and signs the owner in at Keycloak's "factory" realm, reading the realm's test owner
// from its import.
// Other features reuse this control plane: startControlPlane starts it, `origin` is the front server, headers(login)
// is a bearer token the test provider issues for `login`, and open() reads a page from the API and renders the SPA's
// own page from it, through the BFF for someone signed in there.
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { fakeBacklog, fakeRepoHost } from "../../src/adapters/fake.ts";
import { runToken } from "../../src/control/cell-api.ts";
import { startFactory, type Factory } from "../../src/e2e.ts";
import { cellApiHandler } from "../../src/cell-api/main.ts";
import { fakeLauncher } from "../../src/scheduler/launcher.ts";
import { tick, TICK_MS } from "../../src/scheduler/scheduler.ts";
import { workOutbox } from "../../src/worker/outbox.ts";
import { recordOpened, recordSignIn } from "../support/sign-ins.ts";
import { renderPage, type Page } from "../support/split-services.ts";
import { browserOf, signIn, startDashboard, viaBff, type Dashboard } from "./pbi-19.steps.ts";
import { Browser, type Seen } from "./pbi-288.steps.ts";
import { APPHOST, describe, startAspire, ctx as aspireCtx } from "./pbi-6.steps.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";

export const CELL_SECRET = "cell-secret";
const local = { timeout: 1_200_000 };
const WEBHOOK_SECRET = "webhook-secret";

export type Ctx = {
  env?: Record<string, string>;
  started?: SpawnSyncReturns<string>;
  server?: Server;
  close?: () => Promise<void>;
  origin?: string;
  fake?: ReturnType<typeof fakeBacklog>;
  host?: ReturnType<typeof fakeRepoHost>;
  sourceId?: string;
  blobs?: Map<string, string>;
  login?: string;
  itemId?: string;
  ext?: string;
  runId?: string;
  status?: number;
  html?: string;
  /** What the API answered for the page last opened. */
  json?: unknown;
  /** The split services, while they run. */
  dash?: Dashboard;
  /** The BFF's address. */
  bff?: string;
  factory?: Factory;
  /** Set by PBI 133's steps: the tick keeps the WIP limit, so it can take an item, and runs through `runTick`. */
  runTick?: (once: () => Promise<unknown>) => Promise<void>;
};

export function ctx(world: object): Ctx {
  const w = world as { pbi89?: Ctx };
  w.pbi89 ??= {};
  return w.pbi89;
}

// PBI 133's scenarios run this control plane on a Postgres of their own, which they stop and restart.
let poolOverride: import("pg").Pool | null = null;
export function usePool(p: import("pg").Pool | null): void {
  poolOverride = p;
}
const pool = () => poolOverride ?? need().pool;
/** The split services the scenario last started, whose provider issues the tokens headers() sends. */
let running: Dashboard | undefined;

/** A call's headers as `login`: a bearer token the test sign-in provider issued for them, which the API checks. */
export function headers(login: string): Record<string, string> {
  assert.ok(running, "the control plane isn't running, so no provider issues tokens");
  return { authorization: `Bearer ${running.provider.accessToken(login)}` };
}

Before({ tags: "@pbi-89 and @db", ...long }, async function () {
  const d = await testDb();
  if (!d) return;
  await d.pool.query(`truncate item, "user", backlog_source, repo, webhook_delivery, override cascade`);
  await d.pool.query("update wip_policy set usage_paused_until = null, current_wip = 1");
});

After({ tags: "@pbi-89", ...long }, async function () {
  const c = ctx(this);
  await c.close?.();
  if (running === c.dash) running = undefined;
  await c.factory?.stop();
});

// ---- startup ----

Given(/^the API's environment sets everything but (\S+)$/, function (missing: string) {
  const all: Record<string, string> = {
    FACTORY_DB_URI: "postgresql://nobody@127.0.0.1:9/none", FACTORY_BLOB: "http://127.0.0.1:9/blobs",
    OIDC_ISSUER: "http://127.0.0.1:9/realms/factory", API_AUDIENCE: "factory-api", GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
  };
  assert.ok(missing in all, `the API reads no ${missing}`);
  delete all[missing];
  ctx(this).env = all;
});

When("the API starts", long, function () {
  const c = ctx(this);
  // Only PATH and SystemRoot from this process, so nothing else on the runner's environment changes the outcome.
  c.started = spawnSync(process.execPath, ["src/api/main.ts"], {
    env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", ...c.env }, encoding: "utf8", timeout: 60_000,
  });
});

Then("the API exits with an error naming {word}", function (name: string) {
  const r = ctx(this).started!;
  assert.notEqual(r.status, 0, `it exited 0: ${r.stdout}`);
  assert.ok(r.stderr.includes(name), `its error doesn't name ${name}: ${r.stderr}`);
});

// Other features' scenarios start the control plane their own way, through `controlStart`.
When("the control plane starts", long, async function () {
  const own = (this as { controlStart?: () => Promise<void> }).controlStart;
  assert.ok(own, "this scenario says nothing of how its control plane starts");
  await own();
});

// ---- @local: the owner runs these, and the PR records the run ----

When("I start {string} and wait until the BFF, the API, the cell API and the worker are up", long, async function (_cmd: string) {
  await startAspire(aspireCtx(this));
});

/** The realm's test user `name` and their password, from the realm import the AppHost gives Keycloak. */
function realmUser(name: string): { username: string; password: string } {
  const realm = JSON.parse(readFileSync(join(process.cwd(), "aspire-apphost", "keycloak", "factory-realm.json"), "utf8")) as {
    users: { username: string; credentials?: { type: string; value: string }[] }[];
  };
  const user = realm.users.find((u) => u.username === name);
  const password = user?.credentials?.find((k) => k.type === "password")?.value;
  assert.ok(user && password, `the realm import has no user "${name}" with a password`);
  return { username: name, password };
}

const decodeHtml = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

Then("{string} signs in at Keycloak's {string} realm through the BFF and opens Floor", local, async function (name: string, realm: string) {
  const url = describe("bff").doc?.resources[0]?.urls?.[0]?.url as string | undefined;
  assert.ok(url, "the bff resource has no address");
  const bff = new URL(url).origin;
  const b = new Browser();
  let at = await b.request(new URL("/auth/login", bff));
  for (let hop = 0; hop < 10 && at.status >= 300 && at.status < 400; hop++) at = await b.next(at);
  assert.ok(at.url.pathname.includes(`/realms/${realm}/`), `sign-in didn't reach Keycloak's ${realm} realm: ${at.url.href}`);
  const action = /<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/.exec(at.body)?.[1];
  assert.ok(action, `Keycloak's page has no sign-in form: ${at.body.slice(0, 500)}`);
  const user = realmUser(name);
  at = await b.request(new URL(decodeHtml(action), at.url), {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: user.username, password: user.password }).toString(),
  });
  for (let hop = 0; hop < 10 && at.status >= 300 && at.status < 400 && !(at.url.origin === bff && at.url.pathname === "/auth/callback"); hop++) at = await b.next(at);
  assert.equal(at.url.pathname, "/auth/callback", `Keycloak didn't send the browser back to the BFF: ${at.url.href} ${at.status}`);
  assert.ok(at.status >= 300 && at.status < 400, `the BFF's /auth/callback answered ${at.status}: ${at.body}`);
  recordSignIn(name, "keycloak", "bff", realm);
  const floor = await b.request(new URL("/bff/v1/floor", bff));
  assert.equal(floor.status, 200, `Floor answered ${floor.status}: ${floor.body.slice(0, 300)}`);
  recordOpened(name, "Floor");
});

Then("PBI 2's @local scenarios pass", local, function () {
  // PBI 2's scenarios start their own AppHost, and two from one worktree share its data volumes, so this one stops first.
  spawnSync(`aspire stop ${APPHOST}`, { shell: true, encoding: "utf8" });
  const r = spawnSync(`npx cucumber-js features/pbi-6-local-platform.feature --tags @local --import "features/support/**/*.ts" --import "features/steps/**/*.ts" --format summary`,
    { shell: true, encoding: "utf8", env: { ...process.env, FACTORY_FLOAT_PORTS: "1" } });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`.slice(-4000));
});

// ---- the split services ----

Given("the control plane is running with a fake board", long, async function () {
  await startControlPlane(this);
});

/**
 * Starts the split services with a fake board: the API and the cell API behind one front server, at `origin`, and the
 * BFF in front of them, signing people in at a test sign-in provider. Other features' steps reuse it.
 */
export async function startControlPlane(world: object): Promise<void> {
  const c = ctx(world);
  await testDb();
  c.fake = fakeBacklog();
  c.host = fakeRepoHost();
  c.blobs = new Map();
  c.sourceId = (await pool().query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'pbi-89') returning id")).rows[0].id;
  const sources = [{ id: c.sourceId, adapter: c.fake.adapter }];
  const uploadUrl = async (path: string) => `http://blob.test/${path}`;
  const blobs = c.blobs;
  c.dash = await startDashboard({
    pool: pool(), webhookSecret: WEBHOOK_SECRET, repoHost: c.host, readBlob: async (path) => blobs.get(path) ?? null,
    cell: cellApiHandler({ pool: pool(), sources, repoHost: c.host, secret: CELL_SECRET, claudeToken: "unused", modelUpstream: "http://127.0.0.1:9", uploadUrl }),
  });
  running = c.dash;
  c.server = c.dash.server;
  c.origin = c.dash.api;
  c.bff = c.dash.origin;
  const dash = c.dash;
  c.close = () => dash.stop();
}

/**
 * Adds `login` with `role`, keyed by their name as today's other features key people, and signs them in at the test
 * sign-in provider through the BFF when the split services run. Their first token moves them under its issuer.
 */
async function person(c: Ctx, login: string, role: string, productOwner = false) {
  await pool().query(`insert into "user" (provider, subject, github_login, role, product_owner) values ('microsoft', $1, $1, $2, $3)`, [login, role, productOwner]);
  c.login = login;
  if (c.dash) await signIn(c.dash, login);
}

async function item(c: Ctx, state: string, repo: string | null = null) {
  c.ext = await c.fake!.seed({ title: "an item", repo, acceptanceCriteria: ["it works"] });
  c.itemId = (await pool().query<{ id: string }>("insert into item (source_id, external_id, title, state) values ($1, $2, 'an item', $3) returning id", [c.sourceId, c.ext, state])).rows[0].id;
}

Given("an item waiting for sign-off, and a product owner whose GitHub login is {string}", async function (login: string) {
  const c = ctx(this);
  await item(c, "SignOff", "octo/repo");
  await pool().query("insert into run (item_id, run_number, next_stage, scenarios_sha) values ($1, 1, 'sign-off', 'abc')", [c.itemId]);
  await pool().query("insert into question (item_id, kind, body) values ($1, 'sign_off', 'q')", [c.itemId]);
  await person(c, login, "operator", true);
});

When("GitHub delivers a signed comment {string} by {string} on the item", long, async function (text: string, login: string) {
  const c = ctx(this);
  const body = Buffer.from(JSON.stringify({
    action: "created", repository: { full_name: "octo/repo" }, issue: { number: Number(c.ext) },
    comment: { id: 1, body: text, user: { login, type: "User" } },
  }));
  const r = await fetch(`${c.bff}/webhooks/github`, {
    method: "POST", body,
    headers: {
      "content-type": "application/json", "x-github-event": "issue_comment", "x-github-delivery": randomUUID(),
      "x-hub-signature-256": `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`,
    },
  });
  assert.equal(r.status, 204);
  // The control plane only records the comment. The worker runs it, and announces its decision, from the outbox (PBI 219).
  await workOutbox({ pool: pool(), backlogFor: () => c.fake!.adapter, repoHost: c.host! });
});

Then("the item's sign-off question is answered with {string}", async function (decision: string) {
  assert.equal((await pool().query("select decision from question where item_id = $1", [ctx(this).itemId])).rows[0].decision, decision);
});

Then("the item has a comment saying its scenarios were signed off", async function () {
  const c = ctx(this);
  assert.match((await c.fake!.comments(c.ext!))[0] ?? "", /signed off/);
});

Given("an operator is signed in, and an item is in flight", async function () {
  const c = ctx(this);
  await person(c, "op", "operator");
  await item(c, "InProgress");
});

Given("an operator is signed in, and an item is {word}", async function (state: string) {
  const c = ctx(this);
  await person(c, "op", "operator");
  await item(c, state);
});

Given("an operator is signed in", async function () {
  await person(ctx(this), "op", "operator");
});

Given("a viewer is signed in", async function () {
  await person(ctx(this), "viewer", "viewer");
});

/** The signed-in operator posts an override from the dashboard, through the BFF from its own origin. */
async function postOverride(c: Ctx, body: Record<string, string>) {
  assert.ok(c.dash && c.login, "no one is signed in to the dashboard");
  const r = await viaBff(c.dash, await browserOf(c.dash, c.login), "POST", "/bff/v1/overrides", body);
  c.status = r.status;
}

When("the operator posts a {string} override on the item with the reason {string}", async function (kind: string, reason: string) {
  const c = ctx(this);
  await postOverride(c, { kind, reason, itemId: c.itemId! });
});

When("the operator posts a {string} override with the reason {string}", async function (kind: string, reason: string) {
  await postOverride(ctx(this), { kind, reason });
});

When("the scheduler ticks once", long, async function () {
  const c = ctx(this);
  if (c.runTick) {
    await c.runTick(() => tick({ pool: pool(), launcher: fakeLauncher(), now: new Date(), killFlag: false, repoHost: c.host!, backlogFor: () => c.fake!.adapter,
      secret: CELL_SECRET, controlUrl: "http://control.test", sopVersion: "0.1.0" }));
    return;
  }
  // No WIP, so the tick applies overrides and starts no cell.
  await pool().query("update wip_policy set current_wip = 0");
  try {
    await tick({ pool: pool(), launcher: fakeLauncher(), now: new Date(), killFlag: false, repoHost: c.host!, backlogFor: () => c.fake!.adapter,
      secret: CELL_SECRET, controlUrl: "http://control.test", sopVersion: "0.1.0" });
  } finally {
    await pool().query("update wip_policy set current_wip = 1");
  }
});

Then("the item is held", async function () {
  assert.equal((await pool().query("select held from item where id = $1", [ctx(this).itemId])).rows[0].held, true);
});

Then("the item's state is {word}", async function (state: string) {
  assert.equal((await pool().query("select state from item where id = $1", [ctx(this).itemId])).rows[0].state, state);
});

Then("the scheduler ticks at least every 30 seconds", function () {
  assert.ok(TICK_MS <= 30_000, `the tick runs every ${TICK_MS} ms`);
});

Then("the dashboard answers {int}", function (status: number) {
  assert.equal(ctx(this).status, status);
});

Then("no override is recorded", async function () {
  assert.equal((await pool().query("select count(*)::int as n from override")).rows[0].n, 0);
});

// ---- seed-owner ----

When("the migrate job runs seed-owner with {string}", long, async function (words: string) {
  // startTestDb hands back the database's URL beside its pool, which migrate-cli needs.
  const db = (await testDb()) as unknown as { url: string };
  ctx(this).started = spawnSync(process.execPath, ["src/store/migrate-cli.ts", "seed-owner", ...words.split(" ")],
    { env: { ...process.env, FACTORY_DB_URI: db.url }, encoding: "utf8", timeout: 120_000 });
});

Then("it exits {int}", function (status: number) {
  const r = ctx(this).started!;
  assert.equal(r.status, status, r.stderr);
});

Then("it exits {int} naming {string}", function (status: number, word: string) {
  const r = ctx(this).started!;
  assert.equal(r.status, status);
  assert.ok(r.stderr.includes(word), r.stderr);
});

Then("the user {string} is an owner and a product owner", async function (subject: string) {
  const rows = (await pool().query(`select role, product_owner from "user" where subject = $1`, [subject])).rows;
  assert.deepEqual(rows, [{ role: "owner", product_owner: true }]);
});

Then("no user {string} exists", async function (subject: string) {
  // PBI 117's scenarios each run in a database of their own, kept on the world.
  const own = (this as { pbi117?: { pool?: import("pg").Pool } }).pbi117?.pool;
  assert.equal((await (own ?? pool()).query(`select 1 from "user" where subject = $1`, [subject])).rowCount, 0);
});

// ---- Run detail, /phase0 and Floor ----

/** A Cucumber Messages report with one scenario, tagged with the item's tag. */
function report(tag: string, name: string, status: "PASSED" | "FAILED"): string {
  return [
    { pickle: { id: "p", name, tags: [{ name: tag }], steps: [{ id: "s", type: "Outcome", text: "it works" }] } },
    { testCase: { id: "c", pickleId: "p", testSteps: [{ id: "t", pickleStepId: "s" }] } },
    { testCaseStarted: { id: "r", testCaseId: "c" } },
    { testStepFinished: { testCaseStartedId: "r", testStepId: "t", testStepResult: { status } } },
  ].map((m) => JSON.stringify(m)).join("\n") + "\n";
}

async function newRun(c: Ctx, nextStage: string): Promise<string> {
  c.runId = (await pool().query<{ id: string }>("insert into run (item_id, run_number, next_stage) values ($1, 1, $2) returning id", [c.itemId, nextStage])).rows[0].id;
  return c.runId;
}

Given("an item whose red report has {string} failing, whose green report has it passing, and whose red stage stored a transcript", async function (name: string) {
  const c = ctx(this);
  await item(c, "InReview");
  const run = await newRun(c, "address");
  await pool().query(
    `insert into stage_run (run_id, stage_id, attempt, status, report_ref, transcript_ref, started_at) values
     ($1, 'red', 1, 'passed', $2, $3, now() - interval '2 hours'), ($1, 'green', 1, 'passed', $4, null, now() - interval '1 hour')`,
    [run, `reports/${run}/red-1.ndjson`, `transcripts/${run}/red-1.jsonl`, `reports/${run}/green-1.ndjson`],
  );
  c.blobs!.set(`reports/${run}/red-1.ndjson`, report(`@pbi-${c.ext}`, name, "FAILED"));
  c.blobs!.set(`reports/${run}/green-1.ndjson`, report(`@pbi-${c.ext}`, name, "PASSED"));
  c.blobs!.set(`transcripts/${run}/red-1.jsonl`, '{"type":"assistant"}\n');
});

/** The SPA page and the API read behind a dashboard path. */
function apiPath(path: string): { page: Page; read: string } {
  const item = /^\/items\/([^/?]+)$/.exec(path)?.[1];
  if (item) return { page: "item", read: `/v1/items/${item}` };
  if (path === "/" || path === "") return { page: "floor", read: "/v1/floor" };
  if (path === "/phase0") return { page: "phase0", read: "/v1/phase0" };
  if (path === "/activity") return { page: "activity", read: "/v1/activity" };
  throw new Error(`the SPA has no page at ${path}`);
}

/**
 * Opens the dashboard's page at `path` as the signed-in person: it reads the API, through the BFF when they signed in
 * there and straight from the API with their token otherwise, and renders the SPA's own page from what it answered.
 */
export async function open(c: Ctx, path: string) {
  assert.ok(c.dash && c.login, "the control plane isn't running, or no one is signed in");
  const { page, read } = apiPath(path);
  const b = c.dash.browsers.get(c.login);
  let r: { status: number; body: string };
  if (b) r = await viaBff(c.dash, b, "GET", `/bff${read}`);
  else {
    const got = await fetch(`${c.origin}${read}`, { headers: headers(c.login) });
    r = { status: got.status, body: await got.text() };
  }
  c.status = r.status;
  c.json = r.status === 200 ? JSON.parse(r.body) : undefined;
  c.html = r.status === 200 ? await renderPage(page, c.json) : r.body;
  if (r.status === 200) recordOpened(c.login, page === "item" ? "Run detail" : page === "floor" ? "Floor" : page);
}

When("the viewer opens the item's Run detail", async function () {
  const c = ctx(this);
  await open(c, `/items/${c.itemId}`);
});

When("the viewer opens {string}", async function (path: string) {
  await open(ctx(this), path);
});

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

Then("the scenario {string} shows red at Red and green at Green", function (name: string) {
  const c = ctx(this);
  const verdicts = (c.json as { verdicts?: { name: string; red: string; green: string }[] } | undefined)?.verdicts ?? [];
  assert.deepEqual(verdicts.filter((v) => v.name === name), [{ name, red: "red", green: "green" }], `the API's verdicts: ${JSON.stringify(verdicts)}`);
  const rows = [...c.html!.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => text(m[1]).trim());
  assert.ok(rows.some((r) => r === `${name} red green`), `Run detail has no red and green row for the scenario: ${JSON.stringify(rows)}`);
});

Then("the red stage links its transcript, and the link opens it", async function () {
  const c = ctx(this);
  const href = `/bff/v1/blobs/transcripts/${c.runId}/red-1.jsonl`;
  assert.ok(c.html!.includes(`href="${href}"`), "Run detail has no transcript link");
  const r = await viaBff(c.dash!, await browserOf(c.dash!, c.login!), "GET", href);
  assert.equal(r.status, 200, r.body);
  assert.equal(r.body, '{"type":"assistant"}\n');
});

Given("an item whose first run merged at a cost of $1.50 with a Low tier, and whose second run merged at a cost of $2.50 with a High tier", async function () {
  const c = ctx(this);
  await item(c, "Done");
  for (const [n, cost, tier, startedHoursAgo, mergedHoursAgo] of [[1, "1.50", "Low", 9, 6], [2, "2.50", "High", 3, 1]] as const) {
    const run = (await pool().query<{ id: string }>(
      `insert into run (item_id, run_number, pr_url, merge_sha, risk_tier, tier_reasons, started_at)
       values ($1, $2, $3, $4, $5, $6, now() - make_interval(hours => $7)) returning id`,
      [c.itemId, n, `https://github.com/octo/repo/pull/${n}`, `sha${n}`, tier, [`${tier} reason`], startedHoursAgo],
    )).rows[0].id;
    await pool().query("insert into stage_run (run_id, stage_id, attempt, status, cost_usd) values ($1, 'green', 1, 'passed', $2)", [run, cost]);
    await pool().query(
      `insert into event (actor, actor_id, item_id, kind, payload, at)
       values ('system', 'github', $1, 'transition', '{"from":"InReview","to":"Accepted","event":"merged"}', now() - make_interval(hours => $2))`,
      [c.itemId, mergedHoursAgo],
    );
  }
});

Then("the report says {string}", function (said: string) {
  assert.ok(text(ctx(this).html!).includes(said), `"${said}" isn't on the page: ${text(ctx(this).html!).slice(0, 500)}`);
});

Then("it lists the first run's PR before the second's, each with its own cost and tier", function () {
  const html = ctx(this).html!;
  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]).filter((r) => r.includes("pull/"));
  assert.equal(rows.length, 2, `the page lists ${rows.length} PRs`);
  for (const [i, want] of [["pull/1", "$1.50", "Low", "Low reason"], ["pull/2", "$2.50", "High", "High reason"]].entries()) {
    for (const w of want) assert.ok(text(rows[i]).includes(w) || rows[i].includes(w), `row ${i + 1} lacks ${w}`);
  }
});

Given("an item in flight whose cell sends a 600-character message as its stage passes", async function () {
  const c = ctx(this);
  await item(c, "InProgress");
  const run = await newRun(c, "green");
  const generation = (await pool().query<{ lease_generation: number }>("select lease_generation from item where id = $1", [c.itemId])).rows[0].lease_generation;
  const r = await fetch(`${c.origin}/internal/cells/${run}/stage`, {
    method: "POST",
    headers: { authorization: `Bearer ${runToken(CELL_SECRET, run, generation)}`, "content-type": "application/json" },
    body: JSON.stringify({ stageId: "green", attempt: 1, status: "passed", model: "claude-opus-5-5", effort: "medium", message: "m".repeat(500) + "n".repeat(100) }),
  });
  assert.equal(r.status, 200);
});

Then("the item's row shows the message's first 500 characters and no more", function () {
  const c = ctx(this);
  const active = (c.json as { active?: { id: string; message: string | null }[] } | undefined)?.active ?? [];
  assert.equal(active.find((a) => a.id === c.itemId)?.message, "m".repeat(500), "the API doesn't send the message cut to 500 characters");
  const html = c.html!;
  assert.ok(html.includes("m".repeat(500)), "Floor doesn't show the message");
  assert.ok(!html.includes("m".repeat(500) + "n"), "Floor shows more than the first 500 characters");
});

// ---- the whole factory ----

Given("the whole factory runs in process with a scripted agent", long, async function () {
  await testDb();
  ctx(this).factory = await startFactory(pool());
});

When("it takes a labelled item through readiness, Specify, sign-off, Red, Green and its pull request", long, async function () {
  const c = ctx(this);
  const f = c.factory!;
  c.ext = await f.addItem("Export to CSV", ["Exports one month"]);
  await f.poll();
  await f.tick();
  await f.approveInRunDetail(c.ext);
  await f.tick();
});

async function messages(c: Ctx) {
  return (await pool().query<{ stage_id: string; message: string | null }>(
    `select s.stage_id, s.message from stage_run s join run r on r.id = s.run_id join item i on i.id = r.item_id
     where i.external_id = $1 and s.status = 'passed' order by s.started_at`, [c.ext],
  )).rows;
}

Then("the open-pr stage's message is the PR summary its own agent wrote", async function () {
  const c = ctx(this);
  const openPr = (await messages(c)).filter((m) => m.stage_id === "open-pr");
  assert.deepEqual(openPr.map((m) => m.message), [`## Problem\n\nBuilds item ${c.ext}.`]);
});

Then("no stage's message is a risk tier", async function () {
  for (const m of await messages(ctx(this))) assert.doesNotMatch(m.message ?? "", /"tier"|"needsPerson"/, `${m.stage_id}: ${m.message}`);
});
