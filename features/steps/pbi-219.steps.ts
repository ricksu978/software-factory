// Step definitions for features/pbi-219-worker-runs-outbox.feature. The scenarios share PBI 8's database and PBI 156's
// two fake boards, with PBI 17's fake repo host, and PBI 218's steps add the items and people. Each change goes
// through the code that makes it in the factory: transitionItem for the scheduler, the cell API on a real server,
// handleWebhook for GitHub, decide, and the dashboard on a real server. Nothing here registers a hook, so the board
// changes only when "the worker works through the outbox" runs src/worker/outbox.ts's workOutbox, once.
// The worker's board for each source refuses the calls a scenario says it refuses, item by item.
import { After, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { CLAIM_MARKER } from "../../src/adapters/contract.ts";
import type { fakeRepoHost } from "../../src/adapters/fake.ts";
import type { BacklogAdapter, FactoryWebhookEvent } from "../../src/adapters/types.ts";
import { cellApi, runToken } from "../../src/control/cell-api.ts";
import { decide } from "../../src/control/decisions.ts";
import type { ItemEvent, ItemState } from "../../src/core/states.ts";
import { createAuth } from "../../src/http/auth.ts";
import { dashboardRoutes } from "../../src/http/routes.ts";
import { startServer } from "../../src/http/server.ts";
import { withTx } from "../../src/store/db.ts";
import * as items from "../../src/store/items.ts";
import { CONSUMER, type Consumer } from "../../src/store/outbox.ts";
import { handleWebhook } from "../../src/watcher/webhook.ts";
import { runRowEffects, workOutbox, type OutboxDeps } from "../../src/worker/outbox.ts";
import { ctx as p156, type Board } from "./pbi-156.steps.ts";
import { ctx as p17 } from "./pbi-17.steps.ts";
import { item, newItem, outbox, REPO, user as userByLogin } from "./pbi-218.steps.ts";
import { long, need } from "./pbi-8.steps.ts";

type Host = ReturnType<typeof fakeRepoHost>;
type Ctx = {
  /** The board items, by external id, the boards refuse every update to, and every comment on. */
  refuseUpdates: Set<string>;
  refuseComments: Set<string>;
  /** People this file made, by the name a scenario gives them. */
  users: Map<string, string>;
  /** What stops each server a scenario started. */
  closers: (() => Promise<void>)[];
  dashboard?: string;
  cellApi?: string;
  /** The running cell of each item, by item id. */
  cells: Map<string, { runId: string; generation: number }>;
  /** The dashboard's last response. */
  response?: { status: number; location: string | null };
  /** The source search's findings: each file that names onTransition. */
  hookFiles?: string[];
};

export function ctx(world: object): Ctx {
  const w = world as { pbi219?: Ctx };
  w.pbi219 ??= { refuseUpdates: new Set(), refuseComments: new Set(), users: new Map(), closers: [], cells: new Map() };
  return w.pbi219;
}

After({ tags: "@pbi-219" }, async function () {
  for (const close of ctx(this).closers.reverse()) await close();
});

const pool = () => need().pool;
const stop = (s: Server) => new Promise<void>((resolve) => s.close(() => resolve()));
const num = (issue: string) => issue.replace(/^#/, "");
export const MAIN = "main";
const SECRET = "pbi-219-cell-secret";
const WEBHOOK_SECRET = "pbi-219-webhook-secret";
const scheduler = { actor: "system", actorId: "scheduler" } as const;
const github = { actor: "system", actorId: "github" } as const;
export const host = (world: object) => p17(world).repoHost as unknown as Host;

export function boardNamed(world: object, name: string): Board {
  const b = p156(world).boards.find((x) => x.name === name);
  assert.ok(b, `no board "${name}"`);
  return b;
}

const UPDATES = new Set(["claim", "release", "comment", "setStatus", "linkPr", "close"]);

/** The board as the factory reaches it: PBI 156's recording adapter, refusing what the scenario says it refuses. */
function refusing(world: object, b: Board): BacklogAdapter {
  const c = ctx(world);
  return new Proxy(b.adapter, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      return async (...args: unknown[]) => {
        const id = String(args[0]);
        if (UPDATES.has(String(prop)) && c.refuseUpdates.has(id)) throw new Error(`board ${b.name} refuses every update to item ${id}`);
        if (prop === "comment" && c.refuseComments.has(id)) throw new Error(`board ${b.name} refuses every comment on item ${id}`);
        return v.apply(target, args);
      };
    },
  });
}

function backlogFor(world: object) {
  return (sourceId: string): BacklogAdapter => {
    const b = p156(world).boards.find((x) => x.id === sourceId);
    assert.ok(b, `no board with source ${sourceId}`);
    return refusing(world, b);
  };
}

export function workerDeps(world: object): OutboxDeps {
  return { pool: pool(), backlogFor: backlogFor(world), repoHost: host(world) };
}

export async function statusFor(world: object, state: string, boardName = MAIN): Promise<string> {
  const r = await pool().query<{ status: string | null }>(
    "select field_map->'statusFor'->>$2 as status from backlog_source where id = $1", [boardNamed(world, boardName).id, state],
  );
  const status = r.rows[0]?.status;
  assert.ok(status, `board "${boardName}" shows no status for ${state}`);
  return status;
}

async function boardItem(world: object, issue: string, boardName = MAIN) {
  const found = await boardNamed(world, boardName).fake.adapter.getItem(num(issue));
  assert.ok(found, `board "${boardName}" holds no item ${issue}`);
  return found;
}

export const callsOn = (world: object, issue: string, method: string, boardName = MAIN) =>
  boardNamed(world, boardName).calls.filter((call) => call.method === method && call.id === num(issue));

async function comments(world: object, issue: string, boardName = MAIN): Promise<string[]> {
  return boardNamed(world, boardName).fake.comments(num(issue));
}

export async function exactlyOne(world: object, issue: string, what: string, matches: (body: string) => boolean): Promise<void> {
  const all = await comments(world, issue);
  const found = all.filter(matches);
  assert.equal(found.length, 1, `item ${issue} on the board has ${found.length} comments saying ${what}: ${JSON.stringify(all)}`);
}

const ANNOUNCEMENT = /Scenarios signed off|Scenarios sent back for changes|Answer received/;

/** A person this file made, or one PBI 218's or PBI 175's steps made, who are keyed on their GitHub login. */
async function person(world: object, name: string): Promise<string> {
  return ctx(world).users.get(name) ?? userByLogin(name);
}

async function newPerson(world: object, name: string, p: { provider: string; subject: string; login: string | null; role: string; productOwner: boolean }): Promise<void> {
  const r = await pool().query<{ id: string }>(
    `insert into "user" (provider, subject, github_login, role, product_owner) values ($1, $2, $3, $4, $5) returning id`,
    [p.provider, p.subject, p.login, p.role, p.productOwner],
  );
  ctx(world).users.set(name, r.rows[0].id);
}

async function moveItem(id: string, event: ItemEvent, actor: { actor: "system" | "human"; actorId: string } = scheduler): Promise<void> {
  await withTx(pool(), (c) => items.transitionItem(c, id, event, actor));
}

export async function repoId(repo: string): Promise<string> {
  const url = `https://github.com/${repo}`;
  await pool().query("insert into repo (host_adapter, url, trusted_bot) values ('github', $1, 'factory[bot]') on conflict (url) do nothing", [url]);
  return (await pool().query<{ id: string }>("select id from repo where url = $1", [url])).rows[0].id;
}

// ---- the board ----

Given(
  "the board {string} shows a status for each of {string}, {string}, {string}, {string} and {string}",
  long,
  async function (boardName: string, a: string, b: string, c: string, d: string, e: string) {
    const statuses = Object.fromEntries([a, b, c, d, e].map((s) => [s, `Board: ${s}`]));
    await pool().query(
      `update backlog_source set field_map = coalesce(field_map, '{}'::jsonb)
         || jsonb_build_object('statusFor', coalesce(field_map->'statusFor', '{}'::jsonb) || $2::jsonb)
       where id = $1`,
      [boardNamed(this, boardName).id, JSON.stringify(statuses)],
    );
  },
);

Given("the board refuses every update to item {string}", function (issue: string) {
  ctx(this).refuseUpdates.add(num(issue));
});

When("the board accepts updates to item {string} again", function (issue: string) {
  ctx(this).refuseUpdates.delete(num(issue));
});

Given("the board refuses every comment on item {string}", function (issue: string) {
  ctx(this).refuseComments.add(num(issue));
});

When("the board accepts comments on item {string} again", function (issue: string) {
  ctx(this).refuseComments.delete(num(issue));
});

// ---- items ----

Given("item {string} on board {string} is {string} with a running cell", long, async function (issue: string, boardName: string, state: ItemState) {
  const id = await newItem(this, issue, boardName, state);
  await pool().query("update item set lease_owner = 'cell-a', lease_expires = now() + interval '1 hour' where id = $1", [id]);
  const run = await pool().query<{ id: string }>(
    "insert into run (item_id, run_number, next_stage, repo_id, sop_version, config_sha) values ($1, 1, 'specify', $2, 'default@1', 'cfg1234') returning id",
    [id, await repoId(REPO)],
  );
  const generation = (await pool().query<{ g: number }>("select lease_generation as g from item where id = $1", [id])).rows[0].g;
  ctx(this).cells.set(id, { runId: run.rows[0].id, generation });
});

Given("item {string} on board {string} is {string} with an open PR", long, async function (issue: string, boardName: string, state: ItemState) {
  const id = await newItem(this, issue, boardName, state);
  const ext = num(issue);
  const branch = `factory/pbi-${ext}-r1`;
  await pool().query(
    "insert into run (item_id, run_number, next_stage, pr_number, pr_url, branch, repo_id) values ($1, 1, 'open-pr', 41, $2, $3, $4)",
    [id, `https://github.com/${REPO}/pull/41`, branch, await repoId(REPO)],
  );
  host(this).prs.push({
    number: 41, repo: REPO, branch, base: "main", title: `item ${issue}`, body: "", headSha: null, open: true,
    merged: false, mergeSha: null, mergeable: true, reviewers: [], comments: [], reviews: [],
  });
  // The factory claimed it when it started the run.
  await boardNamed(this, boardName).fake.adapter.claim(ext);
});

Given(
  "item {string} on board {string} is waiting in {string} for its scenarios to be signed off, in repo {string}",
  long,
  async function (issue: string, boardName: string, state: ItemState, repo: string) {
    const id = await newItem(this, issue, boardName, state);
    await pool().query("insert into run (item_id, next_stage, scenarios_sha, repo_id) values ($1, 'specify', 'abc123', $2)", [id, await repoId(repo)]);
    await pool().query("insert into question (item_id, kind, body) values ($1, 'sign_off', 'Please sign off the scenarios.')", [id]);
    const fake = boardNamed(this, boardName).fake;
    const current = await fake.adapter.getItem(num(issue));
    await fake.seed({ ...current!, repo });
  },
);

Given("item {string} on board {string} is waiting in {string} for an answer", long, async function (issue: string, boardName: string, state: ItemState) {
  const id = await newItem(this, issue, boardName, state);
  await pool().query("insert into run (item_id, run_number, next_stage) values ($1, 1, 'green')", [id]);
  await pool().query("insert into question (item_id, kind, body) values ($1, 'needs_input', 'Which currency should totals use?')", [id]);
});

// ---- people ----

Given("{string} is a product owner with the GitHub login {string}", long, async function (name: string, login: string) {
  await newPerson(this, name, { provider: "dev", subject: name, login, role: "viewer", productOwner: true });
});

Given("{string} is an operator but not a product owner, with the GitHub login {string}", long, async function (name: string, login: string) {
  await newPerson(this, name, { provider: "dev", subject: name, login, role: "operator", productOwner: false });
});

Given("{string} is a product owner signed in to the dashboard", long, async function (name: string) {
  await newPerson(this, name, { provider: "microsoft", subject: name, login: name, role: "viewer", productOwner: true });
});

Given("{string} is an operator signed in to the dashboard", long, async function (name: string) {
  await newPerson(this, name, { provider: "microsoft", subject: name, login: name, role: "operator", productOwner: false });
});

// ---- moves ----

When("the scheduler moves item {string} on board {string} to {string}", long, async function (issue: string, boardName: string, to: string) {
  assert.equal(to, "InProgress", `no scheduler move to ${to}`);
  await moveItem(await item(this, issue, boardName), "claimed");
});

When("the scheduler moves item {string} and item {string} on board {string} to {string}", long, async function (a: string, b: string, boardName: string, to: string) {
  assert.equal(to, "InProgress", `no scheduler move to ${to}`);
  for (const issue of [a, b]) await moveItem(await item(this, issue, boardName), "claimed");
});

When("item {string} on board {string} then moves to {string}", long, async function (issue: string, boardName: string, to: string) {
  assert.equal(to, "SignOff", `no move to ${to}`);
  await moveItem(await item(this, issue, boardName), "scenarios_written");
});

When(
  "item {string} on board {string} moves to {string} on a merge and then to {string} on a verified definition of done",
  long,
  async function (issue: string, boardName: string, first: string, second: string) {
    const id = await item(this, issue, boardName);
    let state = await withTx(pool(), (c) => items.transitionItem(c, id, "merged", github));
    assert.equal(state, first);
    state = await withTx(pool(), (c) => items.transitionItem(c, id, "dod_verified", scheduler));
    assert.equal(state, second);
  },
);

When("item {string} on board {string} is withdrawn from the backlog and moves to {string}", long, async function (issue: string, boardName: string, to: string) {
  const id = await item(this, issue, boardName);
  assert.equal(await withTx(pool(), (c) => items.transitionItem(c, id, "withdrawn", { actor: "system", actorId: "poller" })), to);
});

When("an operator overrides item {string} to {string} from the dashboard with the reason {string}", long, async function (issue: string, to: ItemState, reason: string) {
  const id = await item(this, issue, MAIN);
  const operator = (await pool().query<{ id: string }>(`select id from "user" where role = 'operator' limit 1`)).rows[0].id;
  await withTx(pool(), (c) => items.overrideItem(c, id, to, { actor: "human", actorId: operator }, reason));
});

// ---- the cell API ----

async function cellApiUrl(world: object): Promise<string> {
  const c = ctx(world);
  if (c.cellApi) return c.cellApi;
  const api = cellApi({
    pool: pool(), secret: SECRET, repoHost: host(world), backlogFor: backlogFor(world),
    stageAfter: (_sop, stageId) => ({ understand: "specify", specify: "sign-off", red: "green" } as Record<string, string>)[stageId] ?? null,
    uploadUrl: async (path) => `http://blob.test/${path}`,
    gateway: { upstream: "http://127.0.0.1:9", ownerToken: () => "unused" },
    webToolsOf: () => [],
  });
  const server = await startServer([api], { port: 0 });
  c.closers.push(() => stop(server));
  c.cellApi = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return c.cellApi;
}

async function cellTransition(world: object, issue: string, body: Record<string, unknown>): Promise<void> {
  const id = await item(world, issue, MAIN);
  const cell = ctx(world).cells.get(id);
  assert.ok(cell, `item ${issue} has no running cell`);
  const r = await fetch(`${await cellApiUrl(world)}/internal/cells/${cell.runId}/transition`, {
    method: "POST",
    headers: { authorization: `Bearer ${runToken(SECRET, cell.runId, cell.generation)}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(r.status, 200, `the cell API answered ${r.status}: ${await r.text()}`);
}

When("the cell reports through the cell API that its scenarios are ready for sign-off", long, async function () {
  await cellTransition(this, "#11", {
    event: "scenarios_written", question: { kind: "sign_off", body: "Please sign off the scenarios." },
    scenariosSha: "5c3a1f0", lockedFiles: ["features/pbi-11.feature"],
  });
});

When("the cell asks {string} and item {string} moves to {string}", long, async function (question: string, issue: string, to: string) {
  await cellTransition(this, issue, { event: "blocked", question: { kind: "needs_input", body: question } });
  const r = await pool().query<{ state: string }>("select state from item where id = $1", [await item(this, issue, MAIN)]);
  assert.equal(r.rows[0].state, to);
});

// ---- GitHub's webhook ----

async function deliver(world: object, issue: string, login: string, body: string, repo: string): Promise<void> {
  const id = randomUUID();
  const raw = Buffer.from(JSON.stringify({ issue: { number: Number(num(issue)) }, comment: { id, body }, repository: { full_name: repo } }));
  const headers = {
    "x-github-delivery": id, "x-github-event": "issue_comment", "content-type": "application/json",
    "x-hub-signature-256": `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex")}`,
  };
  // Parsing GitHub's payload is the adapter's job, so a stub hands over the comment it names.
  const parse = (): FactoryWebhookEvent => ({ kind: "comment", externalId: num(issue), repo, login, body, commentId: id });
  const r = await handleWebhook({ pool: pool(), secret: WEBHOOK_SECRET, parse }, { headers, rawBody: raw });
  assert.equal(r.status, 204);
}

When("GitHub delivers a comment {string} by {string} on issue {string} in the item's repo", long, async function (body: string, login: string, issue: string) {
  const repo = (await boardItem(this, issue)).repo;
  assert.ok(repo, `item ${issue} on the board names no repo`);
  await deliver(this, issue, login, body, repo);
});

When("GitHub delivers a comment {string} by {string} on issue {string} in repo {string}", long, async function (body: string, login: string, issue: string, repo: string) {
  await deliver(this, issue, login, body, repo);
});

// ---- decisions ----

async function decision(world: object, name: string, kind: "approve" | "answer", issue: string, text: string): Promise<void> {
  const itemId = await item(world, issue, MAIN);
  const userId = await person(world, name);
  const outcome = await withTx(pool(), (c) => decide(c, { itemId, userId, kind, text, via: "dashboard" }));
  assert.equal(outcome, "applied", `${name}'s decision was ${outcome}`);
}

When("{string} answers item {string} with {string} and the decision commits", long, async function (name: string, issue: string, text: string) {
  await decision(this, name, "answer", issue, text);
});

When("{string} approves the scenarios of item {string} and the decision commits", long, async function (name: string, issue: string) {
  await decision(this, name, "approve", issue, "");
});

// ---- the dashboard ----

async function dashboardUrl(world: object): Promise<string> {
  const c = ctx(world);
  if (c.dashboard) return c.dashboard;
  const main = boardNamed(world, MAIN);
  let handler: ReturnType<typeof dashboardRoutes> | null = null;
  const server = await startServer([(req, res) => handler!(req, res)], { port: 0 });
  c.closers.push(() => stop(server));
  c.dashboard = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  handler = dashboardRoutes({
    pool: pool(), auth: createAuth({ mode: "azure" }), origin: c.dashboard, adapter: refusing(world, main), sourceId: main.id, repoHost: host(world),
  });
  c.closers.push(handler.close);
  return c.dashboard;
}

async function post(world: object, login: string, path: string, form: Record<string, string>): Promise<void> {
  const origin = await dashboardUrl(world);
  const r = await fetch(`${origin}${path}`, {
    method: "POST", redirect: "manual", body: new URLSearchParams(form).toString(),
    headers: {
      "x-ms-client-principal-idp": "aad", "x-ms-client-principal-id": login, "x-ms-client-principal-name": login,
      "content-type": "application/x-www-form-urlencoded", origin,
    },
  });
  await r.text();
  ctx(world).response = { status: r.status, location: r.headers.get("location") };
}

When("{string} approves the scenarios of item {string} on the dashboard", long, async function (name: string, issue: string) {
  await post(this, name, `/items/${await item(this, issue, MAIN)}/signoff`, { decision: "approve", note: "" });
});

When("{string} answers item {string} on the dashboard with {string}", long, async function (name: string, issue: string, text: string) {
  await post(this, name, `/items/${await item(this, issue, MAIN)}/answer`, { answer: text });
  assert.equal(ctx(this).response?.status, 303, `the dashboard answered ${ctx(this).response?.status}`);
});

Then("the dashboard takes {string} back to item {string}", long, async function (_name: string, issue: string) {
  const r = ctx(this).response;
  assert.ok(r, "nothing was posted to the dashboard");
  assert.equal(r.status, 303, `the dashboard answered ${r.status}`);
  assert.equal(r.location, `/items/${await item(this, issue, MAIN)}`);
});

// ---- the worker ----

When("the worker works through the outbox", long, async function () {
  await workOutbox(workerDeps(this));
});

When("the row for item {string} is due again and the worker works through the outbox", long, async function (issue: string) {
  await pool().query("update outbox set next_attempt_at = now() where item_id = $1", [await item(this, issue, MAIN)]);
  await workOutbox(workerDeps(this));
});

When("the worker handles that decision's announcement row twice, as it would after a crash before removing it", long, async function () {
  const rows = (await outbox()).filter((r) => r.consumer === CONSUMER.decisionAnnouncement);
  assert.equal(rows.length, 1, `the outbox holds ${rows.length} decision announcement rows`);
  const r = rows[0];
  const row = { seq: r.seq, consumer: r.consumer as Consumer, eventId: r.event_id, itemId: r.item_id };
  await runRowEffects(workerDeps(this), row);
  await runRowEffects(workerDeps(this), row);
});

// ---- the source ----

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await sourceFiles(path)));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

When("the factory's source is searched for a transition hook to register", long, async function () {
  const found: string[] = [];
  for (const f of await sourceFiles("src")) if (/\bonTransition\b/.test(await readFile(f, "utf8"))) found.push(f);
  ctx(this).hookFiles = found;
});

Then("there is no {string} hook, and no part of the factory registers one", function (name: string) {
  assert.ok(!(name in items), `src/store/items.ts exports ${name}`);
  assert.deepEqual(ctx(this).hookFiles, [], `the factory's source names ${name}`);
});

// ---- what the board shows ----

Then("the board still shows item {string} as it was, with no status change and no claim", long, async function (issue: string) {
  assert.deepEqual(callsOn(this, issue, "setStatus").map((c) => c.args[1]), [], `the board's status for item ${issue} was set`);
  assert.equal(callsOn(this, issue, "claim").length, 0, `item ${issue} was claimed on the board`);
  assert.ok(!(await boardItem(this, issue)).labels.includes(CLAIM_MARKER), `item ${issue} is claimed on the board`);
});

Then("the board still shows item {string} with the status for {string}", long, async function (issue: string, state: string) {
  assert.equal((await boardItem(this, issue)).status, await statusFor(this, state));
});

Then("the board shows item {string} with the status for {string}", long, async function (issue: string, state: string) {
  assert.equal((await boardItem(this, issue)).status, await statusFor(this, state));
});

Then("the board shows item {string} claimed by the factory", long, async function (issue: string) {
  assert.equal(callsOn(this, issue, "claim").length, 1, `the factory didn't claim item ${issue} on the board`);
  assert.ok((await boardItem(this, issue)).labels.includes(CLAIM_MARKER), `item ${issue} isn't claimed on the board`);
});

Then("the board shows item {string} released", long, async function (issue: string) {
  assert.ok(callsOn(this, issue, "release").length >= 1, `the factory didn't release item ${issue} on the board`);
  assert.ok(!(await boardItem(this, issue)).labels.includes(CLAIM_MARKER), `item ${issue} is still claimed on the board`);
});

Then("the board shows item {string} released and closed", long, async function (issue: string) {
  const found = await boardItem(this, issue);
  assert.ok(!found.labels.includes(CLAIM_MARKER), `item ${issue} is still claimed on the board`);
  assert.equal(found.closed, true, `item ${issue} isn't closed on the board`);
});

Then("the board's last status for item {string} is the status for {string}", long, async function (issue: string, state: string) {
  const set = callsOn(this, issue, "setStatus").map((c) => c.args[1]);
  assert.equal(set.at(-1), await statusFor(this, state), `the board's status for item ${issue} was set to ${JSON.stringify(set)}`);
  assert.equal((await boardItem(this, issue)).status, await statusFor(this, state));
});

Then("the board was set to the status for {string} before the status for {string}", long, async function (first: string, second: string) {
  const set = callsOn(this, "#11", "setStatus").map((c) => c.args[1]);
  assert.deepEqual(set, [await statusFor(this, first), await statusFor(this, second)]);
});

Then("the PR of item {string} is still open", function (_issue: string) {
  const pr = host(this).prs.find((p) => p.repo === REPO && p.number === 41);
  assert.ok(pr, "no PR 41");
  assert.equal(pr.open, true, "the PR is closed");
});

Then("the PR of item {string} is closed with a note that the item was withdrawn", function (_issue: string) {
  const pr = host(this).prs.find((p) => p.repo === REPO && p.number === 41);
  assert.ok(pr, "no PR 41");
  assert.equal(pr.open, false, "the PR is still open");
  assert.ok(pr.comments.some((m) => /withdrawn/.test(m)), `the PR's comments don't say the item was withdrawn: ${JSON.stringify(pr.comments)}`);
});

// ---- comments on the board item ----

Then("item {string} on the board has one comment saying it waits for sign-off on the scenarios", long, async function (issue: string) {
  await exactlyOne(this, issue, "it waits for sign-off", (b) => /Waiting for sign-off on the scenarios/.test(b));
});

Then("item {string} on the board has exactly one comment saying it waits for an answer, quoting {string}", long, async function (issue: string, quote: string) {
  await exactlyOne(this, issue, "it waits for an answer", (b) => /Waiting for an answer/.test(b) && b.includes(quote));
});

Then("item {string} on the board has one comment saying it failed and waits for an operator to re-queue it", long, async function (issue: string) {
  await exactlyOne(this, issue, "it failed and waits to be re-queued", (b) => /Failed\./.test(b) && /operator to re-queue/.test(b));
});

Then("item {string} on the board has exactly one comment saying the scenarios were sent back for changes, quoting {string}", long, async function (issue: string, quote: string) {
  await exactlyOne(this, issue, "the scenarios were sent back", (b) => /Scenarios sent back for changes/.test(b) && b.includes(quote));
});

Then("item {string} on the board has exactly one comment saying the scenarios were signed off", long, async function (issue: string) {
  await exactlyOne(this, issue, "the scenarios were signed off", (b) => /Scenarios signed off/.test(b));
});

Then("item {string} on the board has exactly one comment saying the answer was received, quoting {string}", long, async function (issue: string, quote: string) {
  await exactlyOne(this, issue, "the answer was received", (b) => /Answer received/.test(b) && b.includes(quote));
});

Then("item {string} on the board has exactly one reply to {string} saying only a product owner can sign off scenarios", long, async function (issue: string, login: string) {
  await exactlyOne(this, issue, `a refusal to ${login}`, (b) => b.startsWith(`@${login} `) && /Only a product owner can sign off scenarios/.test(b));
});

Then("item {string} on the board has no reply yet", long, async function (issue: string) {
  assert.deepEqual(await comments(this, issue), []);
});

Then("item {string} on the board has no announcement yet", long, async function (issue: string) {
  const all = await comments(this, issue);
  assert.deepEqual(all.filter((b) => ANNOUNCEMENT.test(b)), [], `item ${issue} on the board has an announcement`);
});

// ---- decisions applied ----

async function signOff(world: object, issue: string, boardName: string) {
  const id = await item(world, issue, boardName);
  const r = await pool().query<{ state: string; signed_off_by: string | null; next_stage: string | null; open: number }>(
    `select i.state, r.signed_off_by, r.next_stage,
       (select count(*)::int from question q where q.item_id = i.id and q.kind = 'sign_off' and q.answer is null and q.closed_at is null) as open
     from item i left join lateral (select * from run where run.item_id = i.id order by run.started_at desc limit 1) r on true where i.id = $1`,
    [id],
  );
  return r.rows[0];
}

async function stillWaiting(world: object, issue: string, boardName: string, state: string): Promise<void> {
  const s = await signOff(world, issue, boardName);
  assert.equal(s.state, state);
  assert.equal(s.signed_off_by, null, `the scenarios of item ${issue} on board "${boardName}" are signed off`);
  assert.equal(s.open, 1, `item ${issue} on board "${boardName}" has no open sign-off question`);
}

async function signedOffBy(world: object, issue: string, boardName: string, name: string) {
  const s = await signOff(world, issue, boardName);
  assert.equal(s.signed_off_by, await person(world, name), `the scenarios of item ${issue} on board "${boardName}" aren't signed off by ${name}`);
  return s;
}

Then("item {string} is still waiting in {string} with its scenarios not signed off", long, async function (issue: string, state: string) {
  await stillWaiting(this, issue, MAIN, state);
});

Then("item {string} on board {string} is still waiting in {string} with its scenarios not signed off", long, async function (issue: string, boardName: string, state: string) {
  await stillWaiting(this, issue, boardName, state);
});

Then("the scenarios of item {string} are signed off by {string} and its run resumes at Red", long, async function (issue: string, name: string) {
  const s = await signedOffBy(this, issue, MAIN, name);
  assert.equal(s.next_stage, "red");
});

Then("the scenarios of item {string} are signed off by {string}", long, async function (issue: string, name: string) {
  await signedOffBy(this, issue, MAIN, name);
});

Then("the scenarios of item {string} on board {string} are signed off by {string}", long, async function (issue: string, boardName: string, name: string) {
  await signedOffBy(this, issue, boardName, name);
});

// ---- the outbox ----

Then("the outbox still holds the board mirror row for item {string}", long, async function (issue: string) {
  const id = await item(this, issue, MAIN);
  const rows = (await outbox()).filter((r) => r.consumer === CONSUMER.boardMirror && r.item_id === id);
  assert.equal(rows.length, 1, `the outbox holds ${rows.length} board mirror rows for item ${issue}`);
});

Then("the outbox still holds the decision announcement row for item {string}", long, async function (issue: string) {
  const id = await item(this, issue, MAIN);
  const rows = (await outbox()).filter((r) => r.consumer === CONSUMER.decisionAnnouncement && r.item_id === id);
  assert.equal(rows.length, 1, `the outbox holds ${rows.length} decision announcement rows for item ${issue}`);
});

Then("the outbox holds no row for item {string}", long, async function (issue: string) {
  const id = await item(this, issue, MAIN);
  assert.deepEqual((await outbox()).filter((r) => r.item_id === id), []);
});
