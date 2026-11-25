// Step definitions for features/pbi-286-api-read-endpoints.feature. They run on PBI 284's harness: the API runs in this
// process from src/api/main.ts's startApi on the scenario's free port (PBI 284's apiPort), against PBI 284's fake issuer, on PBI 4's shared test database.
// The activity log's Givens and most of its Thens are PBI 105's, which read the API's rows here in place of the page.
//
// Time: an event stream ends after STREAM_MS, a timer the API sets with setTimeout. While a scenario has a stream
// open, a setTimeout of STREAM_MS made from src/api is held on a fake clock, and "N minutes pass" moves that clock on.
// Every other timer, such as cucumber's own step timeout, keeps real time.
//
// GitHub: the stand-in records every request made in this process, through fetch or node:https, to a host that isn't
// this machine, and answers none of them. The API holds no GitHub credentials, so it should never make one.
//
// The API's contract these steps read:
// - GET /v1/events is a text/event-stream whose `data:` lines are the factory_events notifications, `{id, itemId, kind}`.
// - GET /v1/floor carries `claudeToken` (null with no creation date) with `ageDays` and `banner` (null for none), and
//   `workerHeartbeat`, the worker_heartbeat row's ticked_at as an ISO time, or null.
// - GET /v1/items/{id} carries `run.acceptance_criteria` and `files`, each `{path, sha, text}`, from the latest run.
// - GET /v1/activity answers `{ events: [...] }`, the 100 newest events, newest first. Each event has `at` (ISO),
//   `external_id`, `repo`, `title`, `kind`, `from`, `to` and `event`, and a setting change also `actor`, `setting`
//   and `reason`. `from`, `to` and `event` are null for any kind but a move (transition, override or sop_moved).
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { STREAM_MS } from "../../src/api/events.ts";
import type { ItemEvent } from "../../src/core/states.ts";
import { withTx } from "../../src/store/db.ts";
import { appendEvent } from "../../src/store/events.ts";
import { transitionItem } from "../../src/store/items.ts";
import { readActivityFromApi } from "./pbi-105.steps.ts";
import { apiPort, bearer, body, call, ctx as pbi284, itemId, reply, validToken } from "./pbi-284.steps.ts";
import { long, need } from "./pbi-8.steps.ts";

const DAY = 86_400_000;

type Stream = {
  status: number | null;
  data: string;
  /** "end" when the API ended the response, "error" when the connection failed. */
  ended?: "end" | "error";
  request: http.ClientRequest;
};

type Fake = { at: number; fn: () => void; cleared: boolean };

type Ctx = {
  streams: Map<string, Stream[]>;
  event?: { id: string; itemId: string };
  clock?: { now: number; timers: Fake[]; restore(): void };
  github?: { calls: string[]; restore(): void };
};

function ctx(world: object): Ctx {
  const w = world as { pbi286?: Ctx };
  w.pbi286 ??= { streams: new Map() };
  return w.pbi286;
}

/** True in a PBI 286 scenario, so a shared step such as PBI 134's "5 minutes pass" hands over to these steps. */
export function isPbi286(world: object): boolean {
  return (world as { pbi286?: Ctx }).pbi286 !== undefined;
}

const pool = () => need().pool;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

Before({ tags: "@pbi-286" }, function () {
  ctx(this);
});

After({ tags: "@pbi-286" }, function () {
  const c = ctx(this);
  for (const list of c.streams.values()) for (const s of list) s.request.destroy();
  c.clock?.restore();
  c.github?.restore();
});

// ---- the fake clock for the API's stream timer ----

function installClock(c: Ctx): void {
  if (c.clock) return;
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const clock = { now: 0, timers: [] as Fake[], restore() {} };
  const fakes = new WeakSet<object>();
  const patchedSet = function (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) {
    if (ms === STREAM_MS && /[\\/]src[\\/]api[\\/]/.test(new Error().stack ?? "")) {
      const t: Fake = { at: clock.now + ms, fn: () => fn(...args), cleared: false };
      clock.timers.push(t);
      const handle = { ref: () => handle, unref: () => handle, hasRef: () => false, refresh: () => handle, [Symbol.toPrimitive]: () => 0, fake: t };
      fakes.add(handle);
      return handle;
    }
    return realSet(fn, ms, ...args);
  } as unknown as typeof setTimeout;
  const patchedClear = function (h: unknown) {
    if (h && typeof h === "object" && fakes.has(h)) {
      (h as { fake: Fake }).fake.cleared = true;
      return;
    }
    return realClear(h as Parameters<typeof clearTimeout>[0]);
  } as typeof clearTimeout;
  globalThis.setTimeout = patchedSet;
  globalThis.clearTimeout = patchedClear;
  clock.restore = () => {
    if (globalThis.setTimeout === patchedSet) globalThis.setTimeout = realSet;
    if (globalThis.clearTimeout === patchedClear) globalThis.clearTimeout = realClear;
  };
  c.clock = clock;
}

/** Moves the fake clock on by `ms`, firing each held timer that falls due, then lets the event loop run. */
export async function pass(world: object, ms: number): Promise<void> {
  const c = ctx(world);
  assert.ok(c.clock, "no event stream is open, so nothing waits on the clock");
  c.clock.now += ms;
  for (const t of c.clock.timers) {
    if (t.cleared || t.at > c.clock.now) continue;
    t.cleared = true;
    t.fn();
  }
  await sleep(50);
}

When("{int} minutes and {int} seconds pass", async function (m: number, s: number) {
  await pass(this, (m * 60 + s) * 1000);
});

// ---- the event stream ----

/** Opens GET /v1/events with `token` and resolves once the response's head and first chunk arrive, or it fails. */
async function openStream(world: object, token: string): Promise<Stream> {
  const port = await apiPort(world);
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/v1/events", headers: { authorization: bearer(token), accept: "text/event-stream" } });
    const s: Stream = { status: null, data: "", request: req };
    req.on("response", (res) => {
      s.status = res.statusCode ?? null;
      res.setEncoding("utf8");
      res.on("data", (d: string) => {
        s.data += d;
        resolve(s);
      });
      res.on("end", () => {
        s.ended ??= "end";
        resolve(s);
      });
      res.on("error", () => {
        s.ended ??= "error";
        resolve(s);
      });
    });
    req.on("error", () => {
      s.ended ??= "error";
      resolve(s);
    });
  });
}

When("{string} opens the event stream on port {int} with a valid token", long, async function (name: string, _port: number) {
  const c = ctx(this);
  installClock(c);
  const s = await openStream(this, await validToken(pbi284(this), name));
  c.streams.set(name, [...(c.streams.get(name) ?? []), s]);
});

When("{string} opens the event stream again with the same token", long, async function (name: string) {
  const token = pbi284(this).tokens.get(name);
  assert.ok(token, `"${name}" hasn't sent a token yet`);
  await call(this, "GET", "/v1/events", { auth: bearer(token) });
});

When("the factory records an event for item {string}", long, async function (name: string) {
  const c = ctx(this);
  const id = itemId(pbi284(this), name);
  const eventId = await withTx(pool(), (tx) => appendEvent(tx, { actor: "system", actorId: "pbi-286", itemId: id, kind: "comment", payload: { body: "PBI 286" } }));
  c.event = { id: eventId, itemId: id };
});

function stream(c: Ctx, name: string, which: "first" | "last" = "last"): Stream {
  const list = c.streams.get(name) ?? [];
  assert.ok(list.length, `"${name}" opened no event stream`);
  const s = which === "first" ? list[0] : list[list.length - 1];
  assert.equal(s.status, 200, `"${name}"'s stream was answered ${s.status ?? s.ended}: ${s.data.slice(0, 300)}`);
  return s;
}

/** Each `data:` line's JSON in the stream so far. */
function delivered(s: Stream): unknown[] {
  return s.data.split(/\r?\n/).filter((l) => l.startsWith("data:")).flatMap((l) => {
    try {
      return [JSON.parse(l.slice(5).trim())];
    } catch {
      return [];
    }
  });
}

Then("{string}'s stream delivers that event", long, async function (name: string) {
  const c = ctx(this);
  assert.ok(c.event, "the factory recorded no event");
  const s = stream(c, name);
  const want = c.event;
  const has = () => delivered(s).some((e) => (e as { id?: unknown }).id === want.id && (e as { itemId?: unknown }).itemId === want.itemId);
  for (let waited = 0; !has() && waited < 5_000; waited += 50) await sleep(50);
  assert.ok(has(), `"${name}"'s stream didn't deliver event ${want.id}: ${s.data.slice(0, 500)}`);
});

Then("{string}'s stream is still open", long, async function (name: string) {
  const s = stream(ctx(this), name);
  await sleep(500);
  assert.equal(s.ended, undefined, `"${name}"'s stream has ended`);
});

async function endedByApi(c: Ctx, name: string, which: "first" | "last"): Promise<void> {
  const s = stream(c, name, which);
  for (let waited = 0; s.ended === undefined && waited < 5_000; waited += 50) await sleep(50);
  assert.equal(s.ended, "end", `"${name}"'s ${which === "first" ? "first " : ""}stream ${s.ended ? "failed" : "is still open"}`);
}

Then("the API has ended {string}'s stream", long, async function (name: string) {
  await endedByApi(ctx(this), name, "last");
});

Then("the API has ended {string}'s first stream", long, async function (name: string) {
  await endedByApi(ctx(this), name, "first");
});

// ---- the floor ----

Given("the Claude token's creation date isn't set", function () {
  delete pbi284(this).env.CLAUDE_TOKEN_CREATED_AT;
});

/** Today at hh:mm UTC. */
const today = (h: number, m: number) => {
  const d = new Date();
  d.setUTCHours(h, m, 0, 0);
  return d;
};

Given("the worker last sent a heartbeat at {int}:{int}", long, async function (h: number, m: number) {
  const at = today(h, m);
  pbi284(this).heartbeat = at;
  await pool().query("delete from worker_heartbeat");
  await pool().query("insert into worker_heartbeat (ticked_at) values ($1)", [at]);
});

Given("the worker has never sent a heartbeat", long, async function () {
  await pool().query("delete from worker_heartbeat");
});

type Token = { ageDays?: unknown; banner?: unknown } | null | undefined;
const token = (world: object) => body(pbi284(world)).claudeToken as Token;

Then("the floor shows the Claude token's age as {int} days", function (days: number) {
  const t = token(this);
  assert.equal(t?.ageDays, days, `the floor's claudeToken is ${JSON.stringify(t)}`);
});

Then("the floor's banner says the Claude token expires in {int} days", function (days: number) {
  const t = token(this);
  assert.equal(typeof t?.banner, "string", `the floor's claudeToken is ${JSON.stringify(t)}`);
  assert.match(t!.banner as string, new RegExp(`\\bexpires in ${days} days\\b`));
});

Then("the floor has no banner", function () {
  const t = token(this);
  assert.ok(t === null || t?.banner === null, `the floor's claudeToken is ${JSON.stringify(t)}`);
});

Then("the floor shows no Claude token", function () {
  const t = token(this);
  assert.equal(t, null, `the floor's claudeToken is ${JSON.stringify(t)}`);
});

Then("the floor shows the worker's last heartbeat as {int}:{int}", function (h: number, m: number) {
  const at = body(pbi284(this)).workerHeartbeat;
  assert.equal(typeof at, "string", `the floor's workerHeartbeat is ${JSON.stringify(at)}`);
  assert.equal(Date.parse(at as string), today(h, m).getTime());
});

Then("the floor shows no worker heartbeat", function () {
  const at = body(pbi284(this)).workerHeartbeat;
  assert.equal(at, null, `the floor's workerHeartbeat is ${JSON.stringify(at)}`);
});

// ---- Run detail and the run's snapshot ----

type Snap = { runId: string };
const snapshots = new WeakMap<object, Snap>();

async function run(world: object, name: string, n: number, criteria: string[] | null): Promise<string> {
  const id = itemId(pbi284(world), name);
  const runId = (await pool().query<{ id: string }>(
    `insert into run (item_id, run_number, next_stage, scenarios_sha, acceptance_criteria, started_at)
     values ($1, $2, 'red', $3, $4, now() - make_interval(hours => $5::int)) returning id`,
    [id, n, `sha-286-${n}`, criteria, 10 - n],
  )).rows[0].id;
  snapshots.set(world, { runId });
  return runId;
}

Given("item {string}'s run has a snapshot with the criteria {string} and {string}", long, async function (name: string, a: string, b: string) {
  await run(this, name, 1, [a, b]);
});

Given("the snapshot holds the file {string} with the text {string}", long, async function (path: string, text: string) {
  const s = snapshots.get(this);
  assert.ok(s, "no run has a snapshot");
  await pool().query("insert into run_file (run_id, sha, path, text) values ($1, 'sha-286-1', $2, $3)", [s.runId, path, text]);
});

Given("item {string}'s run has a scenarios sha but no snapshot", long, async function (name: string) {
  await run(this, name, 1, null);
});

Given("item {string}'s first run has a snapshot with the criterion {string}", long, async function (name: string, criterion: string) {
  await run(this, name, 1, [criterion]);
});

Given("item {string}'s second run has a snapshot with the criterion {string}", long, async function (name: string, criterion: string) {
  await run(this, name, 2, [criterion]);
});

const isLocal = (host: string) => /^(127\.0\.0\.1|localhost|\[?::1\]?|0\.0\.0\.0)$/i.test(host);

Given("a GitHub stand-in that records every call made to it", function () {
  const c = ctx(this);
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  const realRequest = https.request;
  const realGet = https.get;
  const record = (url: string) => {
    calls.push(url);
    return new Error(`the GitHub stand-in refuses ${url}`);
  };
  const patchedFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (!isLocal(url.hostname)) throw record(url.href);
    return realFetch(input, init);
  }) as typeof fetch;
  const httpsUrl = (a: unknown) => {
    if (typeof a === "string" || a instanceof URL) return String(a);
    const o = a as { hostname?: string; host?: string; path?: string };
    return `https://${o?.hostname ?? o?.host ?? "?"}${o?.path ?? "/"}`;
  };
  const patchedRequest = ((...a: unknown[]) => {
    throw record(httpsUrl(a[0]));
  }) as unknown as typeof https.request;
  globalThis.fetch = patchedFetch;
  (https as { request: unknown }).request = patchedRequest;
  (https as { get: unknown }).get = patchedRequest;
  c.github = {
    calls,
    restore() {
      if (globalThis.fetch === patchedFetch) globalThis.fetch = realFetch;
      (https as { request: unknown }).request = realRequest;
      (https as { get: unknown }).get = realGet;
    },
  };
});

When("{string} asks port {int} for an item that doesn't exist with a valid token", long, async function (name: string, _port: number) {
  await call(this, "GET", `/v1/items/${crypto.randomUUID()}`, { auth: bearer(await validToken(pbi284(this), name)) });
});

type Detail = { run?: { acceptance_criteria?: unknown } | null; files?: { path: string; text: string }[] };
const detail = (world: object) => body(pbi284(world)) as Detail;
const criteria = (d: Detail) => d.run?.acceptance_criteria;

Then("Run detail lists the criteria {string} and {string}, in that order", function (a: string, b: string) {
  assert.deepEqual(criteria(detail(this)), [a, b]);
});

Then("Run detail lists the criterion {string}", function (criterion: string) {
  const list = criteria(detail(this));
  assert.ok(Array.isArray(list) && list.includes(criterion), `Run detail's criteria are ${JSON.stringify(list)}`);
});

Then("Run detail doesn't list {string}", function (criterion: string) {
  const list = criteria(detail(this));
  assert.ok(!(Array.isArray(list) && list.includes(criterion)), `Run detail's criteria are ${JSON.stringify(list)}`);
});

Then("Run detail shows the file {string} with the text {string}", function (path: string, text: string) {
  const files = detail(this).files ?? [];
  assert.deepEqual(files.filter((f) => f.path === path).map((f) => f.text), [text], `Run detail's files are ${JSON.stringify(files)}`);
});

Then("Run detail shows no criteria", function () {
  const list = criteria(detail(this));
  assert.ok(list === null || list === undefined || (Array.isArray(list) && list.length === 0), `Run detail's criteria are ${JSON.stringify(list)}`);
});

Then("Run detail shows no files", function () {
  const d = detail(this);
  assert.ok(Array.isArray(d.files), `Run detail has no files list: ${JSON.stringify(d)}`);
  assert.deepEqual(d.files, []);
});

Then("the GitHub stand-in received no call", function () {
  const c = ctx(this);
  assert.ok(c.github, "no GitHub stand-in is running");
  reply(pbi284(this));
  assert.deepEqual(c.github.calls, []);
});

// ---- the activity log ----

When("{string} asks port {int} for the activity log with a valid token", long, async function (name: string, _port: number) {
  const p = pbi284(this);
  await call(this, "GET", "/v1/activity", { auth: bearer(await validToken(p, name)) });
  readActivityFromApi(this, p.reply!);
});

type Row = Record<string, unknown> & { at?: unknown; kind?: unknown; from?: unknown; to?: unknown; event?: unknown };

function events(world: object): Row[] {
  const b = body(pbi284(world));
  assert.ok(Array.isArray(b.events), `the activity log's answer has no events array: ${JSON.stringify(b).slice(0, 300)}`);
  return b.events as Row[];
}

const hhmm = (r: Row) => (typeof r.at === "string" ? new Date(r.at).toISOString().slice(11, 16) : null);

function only(rows: Row[], what: string): Row {
  assert.equal(rows.length, 1, `expected one row ${what}, found ${rows.length}: ${JSON.stringify(rows)}`);
  return rows[0];
}

function rowAt(world: object, h: number, m: number): Row {
  const t = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  return only(events(world).filter((r) => hhmm(r) === t), `at ${t}`);
}

function has(row: Row, values: string[]): void {
  assert.equal(typeof row.at, "string", `the row has no time: ${JSON.stringify(row)}`);
  const held = Object.values(row).filter((v) => v !== null && v !== undefined).map(String);
  for (const v of values) assert.ok(held.includes(v), `the row doesn't hold "${v}": ${JSON.stringify(row)}`);
}

function noStates(row: Row): void {
  assert.deepEqual({ from: row.from ?? null, to: row.to ?? null }, { from: null, to: null }, `the row carries states: ${JSON.stringify(row)}`);
}

Then("the {int}:{int} row has its time, {string}, {string}, {string}, {string}, {string} and {string}",
  function (h: number, m: number, a: string, b: string, k: string, from: string, to: string, ev: string) {
    const row = rowAt(this, h, m);
    has(row, [a, b, k]);
    assert.deepEqual([row.from, row.to, row.event], [from, to, ev], `the row is ${JSON.stringify(row)}`);
  });

Then("the {int}:{int} row has its time, {string}, {string}, {string}, {string} and {string}",
  function (h: number, m: number, a: string, b: string, k: string, from: string, to: string) {
    const row = rowAt(this, h, m);
    has(row, [a, b, k]);
    assert.deepEqual([row.from, row.to], [from, to], `the row is ${JSON.stringify(row)}`);
  });

Then("the {int}:{int} row has its time, {string}, {string} and {string}, and no states", function (h: number, m: number, a: string, b: string, k: string) {
  const row = rowAt(this, h, m);
  has(row, [a, b, k]);
  noStates(row);
});

Given("item {string} from the repo {string} was claimed", long, async function (ext: string, repo: string) {
  const source = (await pool().query<{ id: string }>(
    "insert into backlog_source (adapter, url) values ('fake', 'pbi-286:' || gen_random_uuid()) returning id")).rows[0].id;
  const id = (await pool().query<{ id: string }>(
    "insert into item (source_id, external_id, title, state, repo) values ($1, $2, $3, 'Queued', $4) returning id",
    [source, ext, `item ${ext}`, repo])).rows[0].id;
  await withTx(pool(), (tx) => transitionItem(tx, id, "claimed" as ItemEvent, { actor: "system", actorId: "pbi-286" }));
});

Then("the claim's row names item {string} in the repo {string}", function (ext: string, repo: string) {
  const row = only(events(this).filter((r) => r.kind === "transition" && r.event === "claimed"), "for the claim");
  assert.deepEqual([row.external_id, row.repo], [ext, repo], `the row is ${JSON.stringify(row)}`);
});

Given("{string} changed review capacity from {string} to {string} because {string}", long, async function (login: string, from: string, to: string, reason: string) {
  const id = (await pool().query<{ id: string }>(
    `insert into "user" (provider, subject, github_login, role) values ('microsoft', $1, $1, 'operator') returning id`, [login])).rows[0].id;
  await withTx(pool(), (tx) => appendEvent(tx, { actor: "human", actorId: id, itemId: null, kind: "setting", payload: { setting: "review capacity", from, to, reason } }));
});

const settingRows = new WeakMap<object, Row>();

Then("the log has a setting row saying {string} changed review capacity from {string} to {string} because {string}",
  function (login: string, from: string, to: string, reason: string) {
    const row = only(events(this).filter((r) => r.kind === "setting"), "for the setting change");
    assert.deepEqual({ actor: row.actor, setting: row.setting, from: row.from, to: row.to, reason: row.reason },
      { actor: login, setting: "review capacity", from, to, reason }, `the row is ${JSON.stringify(row)}`);
    settingRows.set(this, row);
  });

Then("that row names no item", function () {
  const row = settingRows.get(this);
  assert.ok(row, "no setting row was found");
  assert.deepEqual({ external_id: row.external_id ?? null, title: row.title ?? null }, { external_id: null, title: null }, `the row is ${JSON.stringify(row)}`);
});

Then("the {string} row has no states", function (kind: string) {
  noStates(only(events(this).filter((r) => r.kind === kind), `of kind ${kind}`));
});

Then("the item's row has {string}, {string} and {string}", function (a: string, b: string, d: string) {
  has(only(events(this), "in the log"), [a, b, d]);
});

Then("the item's row has {string} and {string}", function (a: string, b: string) {
  has(only(events(this), "in the log"), [a, b]);
});

Then("the response doesn't contain {string}", function (s: string) {
  const r = reply(pbi284(this));
  assert.equal(r.status, 200, `the API answered ${r.status}: ${r.text.slice(0, 300)}`);
  assert.ok(!r.text.includes(s), `the response contains "${s}"`);
});
