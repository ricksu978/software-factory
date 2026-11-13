// Step definitions for features/pbi-191-review-clock-at-pr.feature.
//
// The real cell API, the real poller and the real claim run over PBI 4's shared database, on PBI 12's harness: its fake
// board and fake repo host. The item is InProgress at the open-pr stage, with a run that has no PR yet. The cell API is
// served over HTTP with a clock the steps set, so "the cell records PR 57 at 10:00" is a `POST pr` the cell API takes at
// 10:00, and "reports PR 57 opened" is a `pr_opened` transition. The poller reads the fake repo host's PR state, which
// times its two-minute settle against Date.now(), so each poll runs with Date.now() set to the step's time. Every time
// is on one fixed day, in UTC. The cell API resumes runs by the default SOP, as the control plane does.
//
// PBI 130's steps name the repo's trusted bot and allowlist "octo". The trusted bot step runs before the item exists,
// so the item's setup here writes the bot to the repo row. PBI 12's "the factory holds the item in state" and "the
// item's run resumes from" check that a poll ran, so the setup polls once at 09:00, before anything else happens.
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type pg from "pg";
import { ctx as pbi12, poll, REPO, setup } from "./pbi-12.steps.ts";
import { ctx as pbi28 } from "./pbi-28.steps.ts";
import { load, long, need, testDb } from "./pbi-8.steps.ts";

const REPO_URL = `https://github.com/${REPO}`;
const SECRET = "pbi-191-cell-secret";
const DAY = Date.parse("2026-11-05T00:00:00Z");
const at = (h: number, m: number) => new Date(DAY + (h * 60 + m) * 60_000);
const hhmm = (d: Date) => d.toISOString().slice(11, 16);

type Mods = {
  cellApi: { runToken: (secret: string, runId: string, generation: number) => string; cellApi: (deps: object) => unknown };
  server: { startServer: (handlers: unknown[], opts: { port: number }) => Promise<Server> };
  items: { claimNext: (c: pg.PoolClient, owner: string, now: Date) => Promise<{ runId: string; generation: number } | null> };
  db: { withTx: <T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>) => Promise<T> };
  sop: { sop: unknown; stageAfter: (sop: unknown, stageId: string) => string | null };
};
type Review = { state: "changes_requested" | "approved" | "commented"; submittedAt: string; author: string; body?: string };
type Comment = { threadId: string; path: string; line: number; author: string; body: string; submittedAt: string };
type Ctx = {
  now: Date;
  runId?: string;
  token?: string;
  server?: Server;
  seq: number;
  /** The thread the last "left an open thread" step opened. */
  last?: string;
};

function ctx(world: object): Ctx {
  const w = world as { pbi191?: Ctx };
  w.pbi191 ??= { now: at(9, 0), seq: 0 };
  return w.pbi191;
}

async function mods(): Promise<Mods | null> {
  const [cellApi, server, items, db, sop] = await Promise.all([
    load<Mods["cellApi"]>("src/control/cell-api.ts"), load<Mods["server"]>("src/http/server.ts"),
    load<Mods["items"]>("src/store/items.ts"), load<Mods["db"]>("src/store/db.ts"), load<Mods["sop"]>("src/config/sop.ts"),
  ]);
  return cellApi && server && items && db && sop ? { cellApi, server, items, db, sop } : null;
}

Before({ tags: "@pbi-191 and @db", ...long }, async function () {
  const d = await testDb();
  if (d) await d.pool.query('truncate item, backlog_source, repo, "user" cascade');
});

After({ tags: "@pbi-191 and @db" }, async function () {
  const s = (this as { pbi191?: Ctx }).pbi191?.server;
  if (s) await new Promise((r) => s.close(r));
});

/** PR `n` on the fake repo host, opened on GitHub by the cell before it records it. */
function prOn(world: object, n: number) {
  const c = pbi12(world);
  assert.ok(c.host, "the fake repo host isn't set up");
  let p = c.host.prs.find((x) => x.repo === REPO && x.number === n);
  if (!p) {
    p = {
      number: n, repo: REPO, branch: `factory/pbi-${c.extIds[0]}-r1`, base: "main", title: "test item", body: "", headSha: null, open: true,
      merged: false, mergeSha: null, mergeable: true, reviewers: [], comments: [], reviews: [],
    } as (typeof c.host.prs)[number];
    c.host.prs.push(p);
  }
  return p;
}

async function pollAt(world: object, h: number, m: number) {
  const t = at(h, m).getTime();
  const real = Date.now;
  Date.now = () => t;
  try {
    await poll(pbi12(world));
  } finally {
    Date.now = real;
  }
}

async function call(world: object, route: string, body: object, time: Date): Promise<unknown> {
  const c = ctx(world);
  assert.ok(c.server && c.runId && c.token, "the cell API isn't set up");
  c.now = time;
  const r = await fetch(`http://127.0.0.1:${(c.server.address() as AddressInfo).port}/internal/cells/${c.runId}/${route}`, {
    method: route === "context" ? "GET" : "POST",
    headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json" },
    ...(route === "context" ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  assert.equal(r.status, 200, `${route} answered ${r.status}: ${text}`);
  return JSON.parse(text);
}

Given("the factory holds an item in state {string} whose run is at the open-pr stage, with no PR yet", long, async function (state: string) {
  const c = pbi12(this);
  const m = await mods();
  if (!(await setup(c)) || !m) return;
  const pool = need().pool;
  const ext = await c.fake!.seed({ labels: ["factory"], repo: REPO });
  c.extIds = [ext];
  const bot = (this as { pbi130?: { bot: string } }).pbi130?.bot ?? "factory[bot]";
  await pool.query("update repo set trusted_bot = $2 where url = $1", [REPO_URL, bot]);
  const item = await pool.query<{ id: string }>(
    `insert into item (source_id, external_id, title, repo, state, lease_generation, lease_owner, lease_expires)
     values ($1, $2, 'test item', $3, $4, 1, 'cell-a', now() + interval '1 day') returning id`,
    [c.sourceId, ext, REPO, state],
  );
  const run = await pool.query<{ id: string }>(
    `insert into run (item_id, run_number, next_stage, branch, repo_id, sop_version, config_sha)
     values ($1, 1, 'open-pr', $2, (select id from repo where url = $3), 'default@1', 'c1') returning id`,
    [item.rows[0].id, `factory/pbi-${ext}-r1`, REPO_URL],
  );
  const own = ctx(this);
  own.runId = run.rows[0].id;
  own.token = m.cellApi.runToken(SECRET, own.runId, 1);
  const fake = c.fake!;
  const api = m.cellApi.cellApi({
    pool, secret: SECRET, repoHost: c.host, backlogFor: () => fake.adapter, stageAfter: (_v: string | null, stageId: string) => m.sop.stageAfter(m.sop.sop, stageId), now: () => own.now,
    uploadUrl: async (path: string) => path, gateway: { upstream: "http://127.0.0.1:1", ownerToken: () => "owner-secret" }, webToolsOf: () => [],
  });
  own.server = await m.server.startServer([api], { port: 0 });
  await pollAt(this, 9, 0);
});

async function record(world: object, n: number, h: number, mi: number) {
  prOn(world, n);
  await call(world, "pr", { prNumber: n, prUrl: `${REPO_URL}/pull/${n}` }, at(h, mi));
}

async function opened(world: object, n: number, h: number, mi: number) {
  const r = (await call(world, "transition", { event: "pr_opened", prNumber: n, prUrl: `${REPO_URL}/pull/${n}`, tier: "Low" }, at(h, mi))) as { state?: string };
  assert.equal(r.state, "InReview", `pr_opened left the item in ${r.state}`);
}

Given("the cell recorded PR {int} at {int}:{int}", long, async function (n: number, h: number, mi: number) {
  await record(this, n, h, mi);
});

When("the cell records PR {int} at {int}:{int}", long, async function (n: number, h: number, mi: number) {
  await record(this, n, h, mi);
});

When("the cell records PR {int} again at {int}:{int}", long, async function (n: number, h: number, mi: number) {
  await record(this, n, h, mi);
});

Given("the cell reported PR {int} opened at {int}:{int}", long, async function (n: number, h: number, mi: number) {
  await opened(this, n, h, mi);
});

When("the cell reports PR {int} opened at {int}:{int}", long, async function (n: number, h: number, mi: number) {
  await opened(this, n, h, mi);
});

// As the engine does at the end of an address run with no PR review: the address attempt passes, then pr_opened hands
// the item back. The stage reports go through the cell API as the cell sends them, so the run's resume pointer ends
// wherever the cell API leaves it after an address run.
When("the address run reports PR {int} opened again at {int}:{int}", long, async function (n: number, h: number, mi: number) {
  await call(this, "stage", { stageId: "address", attempt: 1, status: "started" }, at(h, mi));
  await call(this, "stage", { stageId: "address", attempt: 1, status: "passed" }, at(h, mi));
  await opened(this, n, h, mi);
});

Given("{string} submitted a review requesting changes, {string}, on PR {int} at {int}:{int}", function (login: string, body: string, n: number, h: number, mi: number) {
  const review: Review = { state: "changes_requested", author: login, body, submittedAt: at(h, mi).toISOString() };
  (prOn(this, n).reviews as Review[]).push(review);
});

function comment(world: object, n: number, t: Omit<Comment, "submittedAt">, h: number, mi: number) {
  const host = pbi12(world).host;
  assert.ok(host, "the fake repo host isn't set up");
  prOn(world, n);
  const key = `${REPO}#${n}`;
  host.reviewComments.set(key, [...(host.reviewComments.get(key) ?? []), { ...t, submittedAt: at(h, mi).toISOString() }]);
}

Given("{string} opened a thread, {string}, on line {int} of {string} in PR {int} at {int}:{int}", function (login: string, body: string, line: number, path: string, n: number, h: number, mi: number) {
  const c = ctx(this);
  comment(this, n, { threadId: `thread-${++c.seq}`, path, line, author: login, body }, h, mi);
});

Given("the factory's own review left an open thread {string} on PR {int} at {int}:{int}", function (body: string, n: number, h: number, mi: number) {
  const c = ctx(this);
  const bot = (this as { pbi130?: { bot: string } }).pbi130?.bot ?? "factory[bot]";
  c.last = `thread-${++c.seq}`;
  comment(this, n, { threadId: c.last, path: "src/totals.ts", line: 20, author: bot, body }, h, mi);
});

Given("{string} replied {string} inside that thread at {int}:{int}", function (login: string, body: string, h: number, mi: number) {
  const c = ctx(this);
  assert.ok(c.last, "no thread was named before this step");
  const n = pbi12(this).host?.prs.find((p) => p.repo === REPO)?.number;
  assert.ok(n, "the item has no PR");
  comment(this, n, { threadId: c.last, path: "src/totals.ts", line: 20, author: login, body }, h, mi);
});

Given("the poller ran once at {int}:{int}", long, async function (h: number, mi: number) {
  await pollAt(this, h, mi);
});

When("the poller runs once at {int}:{int}", long, async function (h: number, mi: number) {
  await pollAt(this, h, mi);
});

async function claim(world: object, h: number, mi: number) {
  const m = await mods();
  assert.ok(m, "the claim's modules are missing");
  const c = ctx(world);
  const got = await m.db.withTx(need().pool, (client) => m.items.claimNext(client, "cell-a", at(h, mi)));
  assert.ok(got, "there was nothing to claim");
  assert.equal(got.runId, c.runId, "the claim started a new run");
  c.token = m.cellApi.runToken(SECRET, got.runId, got.generation);
  c.now = at(h, mi);
}

When("the address run claims the item at {int}:{int}", long, async function (h: number, mi: number) {
  await claim(this, h, mi);
});

When("the address run claims the item at {int}:{int} and asks for its context", long, async function (h: number, mi: number) {
  await claim(this, h, mi);
  const body = (await call(this, "context", {}, at(h, mi))) as { trustedComments?: { author: string; body: string }[] };
  pbi28(this).comments = body.trustedComments ?? null;
});

Then("the run's review clock reads {int}:{int}", long, async function (h: number, mi: number) {
  const c = ctx(this);
  assert.ok(c.runId, "the item has no run");
  const r = await need().pool.query<{ reviews_seen_at: Date | null }>("select reviews_seen_at from run where id = $1", [c.runId]);
  const clock = r.rows[0]?.reviews_seen_at ?? null;
  assert.ok(clock, "the run's review clock hasn't started");
  assert.equal(hhmm(clock), hhmm(at(h, mi)), `the run's review clock reads ${clock.toISOString()}`);
});
