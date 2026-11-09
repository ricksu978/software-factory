// Step definitions for features/pbi-89-dashboard-wiring.feature. The @db scenarios run the control plane's real
// handlers from src/main.ts on a free port, on PBI 4's shared test database, with a fake board. People sign in with
// the headers Container Apps adds. The startup scenarios run src/main.ts itself as a child process.
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fakeBacklog, fakeRepoHost } from "../../src/adapters/fake.ts";
import { runToken } from "../../src/control/cell-api.ts";
import { startFactory, type Factory } from "../../src/e2e.ts";
import { createAuth } from "../../src/http/auth.ts";
import { startServer, type Handler } from "../../src/http/server.ts";
import { controlHandlers } from "../../src/main.ts";
import { fakeLauncher } from "../../src/scheduler/launcher.ts";
import { tick, TICK_MS } from "../../src/scheduler/scheduler.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";

export const CELL_SECRET = "cell-secret";
const WEBHOOK_SECRET = "webhook-secret";
const APPHOST = "--apphost . --non-interactive --nologo";

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
export const headers = (login: string) => ({ "x-ms-client-principal-idp": "aad", "x-ms-client-principal-id": login });

Before({ tags: "@pbi-89 and @db", ...long }, async function () {
  const d = await testDb();
  if (!d) return;
  await d.pool.query(`truncate item, "user", backlog_source, repo, webhook_delivery, override cascade`);
  await d.pool.query("update wip_policy set usage_paused_until = null, current_wip = 1");
});

After({ tags: "@pbi-89", ...long }, async function () {
  const c = ctx(this);
  await c.close?.();
  if (c.server) {
    c.server.closeAllConnections();
    await new Promise<void>((resolve) => c.server!.close(() => resolve()));
  }
  await c.factory?.stop();
});

// ---- startup ----

Given(/^the control plane's environment sets (.+)$/, function (vars: string) {
  ctx(this).env = Object.fromEntries(vars.trim().split(/\s+/).map((v) => [v.slice(0, v.indexOf("=")), v.slice(v.indexOf("=") + 1)]));
});

When("the control plane starts", long, async function () {
  // PBI 140's scenarios start the control plane in process, on their own database, through `controlStart`.
  const own = (this as { controlStart?: () => Promise<void> }).controlStart;
  if (own) return own();
  const c = ctx(this);
  // Only PATH and SystemRoot from this process, so nothing else on the runner's environment changes the outcome.
  c.started = spawnSync(process.execPath, ["src/main.ts"], {
    env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", ...c.env }, encoding: "utf8", timeout: 60_000,
  });
});

Then("it exits with an error naming FACTORY_ENV or FACTORY_DEV_LOGIN", function () {
  const r = ctx(this).started!;
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /FACTORY_ENV|FACTORY_DEV_LOGIN/);
});

Then("it logs no sign-in link", function () {
  assert.doesNotMatch(ctx(this).started!.stdout, /dev-login/);
});

Then("it logs a sign-in link to {word} with a 64-character token", function (origin: string) {
  assert.match(ctx(this).started!.stdout, new RegExp(`${origin.replace(/[.:/]/g, "\\$&")}/dev-login\\?token=[0-9a-f]{64}\\b`));
});

// ---- @local: the owner runs these, and the PR records the run ----

Then("the control resource's console shows a dashboard sign-in link", function () {
  // The link carries this start's token, so it is matched here and never printed.
  const r = spawnSync(`aspire logs control --search dev-login ${APPHOST}`, { shell: true, encoding: "utf8" });
  assert.match(r.stdout ?? "", /\/dev-login\?token=[0-9a-f]{64}/, "no sign-in link in control's console");
});

Then("PBI 2's @local scenarios pass", long, function () {
  // PBI 2's scenarios start their own AppHost, and two from one worktree share its data volumes, so this one stops first.
  spawnSync(`aspire stop ${APPHOST}`, { shell: true, encoding: "utf8" });
  const r = spawnSync(`npx cucumber-js features/pbi-6-local-platform.feature --tags @local --import "features/steps/**/*.ts" --format summary`,
    { shell: true, encoding: "utf8", env: { ...process.env, FACTORY_FLOAT_PORTS: "1" } });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`.slice(-4000));
});

// ---- the control plane's handlers ----

Given("the control plane is running with a fake board", long, async function () {
  await startControlPlane(this);
});

/** Starts the control plane's handlers on a free port, with a fake board. PBI 140's steps reuse it. */
export async function startControlPlane(world: object): Promise<void> {
  const c = ctx(world);
  await testDb();
  c.fake = fakeBacklog();
  c.host = fakeRepoHost();
  c.blobs = new Map();
  c.sourceId = (await pool().query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'pbi-89') returning id")).rows[0].id;
  const handlers: Handler[] = [];
  c.server = await startServer([async (req, res) => {
    for (const h of handlers) if (await h(req, res)) return true;
    return false;
  }], { port: 0 });
  c.origin = `http://127.0.0.1:${(c.server.address() as AddressInfo).port}`;
  const control = controlHandlers({
    pool: pool(), local: false, auth: createAuth({ mode: "azure" }), origin: c.origin,
    sources: [{ id: c.sourceId, adapter: c.fake.adapter }], repoHost: c.host, secret: CELL_SECRET,
    webhookSecret: WEBHOOK_SECRET, claudeToken: "unused", uploadUrl: async (path) => `http://blob.test/${path}`,
    readBlob: async (path) => c.blobs!.get(path) ?? null,
  });
  handlers.push(...control.handlers);
  c.close = control.close;
}

async function person(c: Ctx, login: string, role: string, productOwner = false) {
  await pool().query(`insert into "user" (provider, subject, github_login, role, product_owner) values ('microsoft', $1, $1, $2, $3)`, [login, role, productOwner]);
  c.login = login;
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
  const r = await fetch(`${c.origin}/webhooks/github`, {
    method: "POST", body,
    headers: {
      "content-type": "application/json", "x-github-event": "issue_comment", "x-github-delivery": randomUUID(),
      "x-hub-signature-256": `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`,
    },
  });
  assert.equal(r.status, 204);
  // The control plane applies the comment after its 204, so give it a moment.
  for (let i = 0; i < 50; i++) {
    if ((await pool().query("select decision from question where item_id = $1", [c.itemId])).rows[0].decision) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
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

async function postOverride(c: Ctx, form: Record<string, string>) {
  const r = await fetch(`${c.origin}/overrides`, {
    method: "POST", redirect: "manual", body: new URLSearchParams(form).toString(),
    headers: { ...headers(c.login!), origin: c.origin!, "content-type": "application/x-www-form-urlencoded" },
  });
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

export async function open(c: Ctx, path: string) {
  const r = await fetch(`${c.origin}${path}`, { headers: headers(c.login!) });
  c.status = r.status;
  c.html = await r.text();
}

When("the viewer opens the item's Run detail", async function () {
  const c = ctx(this);
  await open(c, `/items/${c.itemId}`);
});

When("the viewer opens {string}", async function (path: string) {
  await open(ctx(this), path);
});

Then("the scenario {string} shows red at Red and green at Green", function (name: string) {
  assert.ok(ctx(this).html!.includes(`<td>${name}</td><td>red</td><td>green</td>`), "no red and green row for the scenario");
});

Then("the red stage links its transcript, and the link opens it", async function () {
  const c = ctx(this);
  const href = `/blobs/transcripts/${c.runId}/red-1.jsonl`;
  assert.ok(c.html!.includes(`<a href="${href}">`), "no transcript link");
  const r = await fetch(`${c.origin}${href}`, { headers: headers(c.login!) });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '{"type":"assistant"}\n');
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

Then("the report says {string}", function (text: string) {
  assert.ok(ctx(this).html!.includes(text), `"${text}" isn't on the page`);
});

Then("it lists the first run's PR before the second's, each with its own cost and tier", function () {
  const html = ctx(this).html!;
  const rows = html.split("<tr>").slice(2);
  assert.equal(rows.length, 2);
  for (const [i, want] of [["pull/1", "$1.50", "Low", "Low reason"], ["pull/2", "$2.50", "High", "High reason"]].entries()) {
    for (const w of want) assert.ok(rows[i].includes(w), `row ${i + 1} lacks ${w}`);
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
    body: JSON.stringify({ stageId: "green", attempt: 1, status: "passed", message: "m".repeat(500) + "n".repeat(100) }),
  });
  assert.equal(r.status, 200);
});

Then("the item's row shows the message's first 500 characters and no more", function () {
  const html = ctx(this).html!;
  const row = html.slice(html.indexOf("an item"), html.indexOf("</tr>", html.indexOf("an item")));
  assert.ok(row.includes(`>${"m".repeat(500)}<`), "the row doesn't end the message at 500 characters");
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
  assert.deepEqual(openPr.map((m) => m.message), [`Builds item ${c.ext}.`]);
});

Then("no stage's message is a risk tier", async function () {
  for (const m of await messages(ctx(this))) assert.doesNotMatch(m.message ?? "", /"tier"|"needsPerson"/, `${m.stage_id}: ${m.message}`);
});
