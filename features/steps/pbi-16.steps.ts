import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type pg from "pg";
import { load, long, need, testDb } from "./pbi-8.steps.ts";

// The cell API runs on a real port over PBI 4's shared database, with the fake backlog and repo host behind it.
// Modules load lazily, so while one doesn't exist the server never starts and every scenario fails on its Then.
// The gateway scenario reuses PBI 33's "gateway answers" and "upstream receives no request" steps through its context.
const secret = "cell-secret";
const repoName = "ricksu978/software-factory";
const marker = "factory:in-progress";

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
type Adapter = { getItem(id: string): Promise<{ status: string; labels: string[]; fields: Record<string, string> } | null> };
type Target = { adapter: Adapter; seed(item: { externalId: string; status?: string }): Promise<string>; comments(id: string): Promise<string[]> };
type Mods = {
  cellApi: {
    runToken: (secret: string, runId: string, generation: number) => string;
    cellApi: (deps: object) => Handler;
  };
  server: { startServer: (handlers: Handler[], opts: { port: number; host?: string }) => Promise<Server> };
  board: { mirrorBoard: (deps: object) => () => void };
  fake: { fakeBacklog: () => Target; fakeRepoHost: () => object };
  items: {
    claimNext: (c: pg.PoolClient, owner: string, now: Date) => Promise<{ itemId: string; runId: string; generation: number } | null>;
    expireLeases: (c: pg.PoolClient, now: Date) => Promise<string[]>;
    transitionItem: (c: pg.PoolClient, itemId: string, event: string, actor: { actor: string; actorId: string }) => Promise<string>;
  };
  db: { withTx: <T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>) => Promise<T> };
};
type Cell = { runId: string; generation: number; token: string };
type Ctx = {
  mods?: Mods; server?: Server; upstream?: Server; seen: { headers: IncomingHttpHeaders; body: string }[]; off?: () => void;
  board?: Target; sourceId?: string; items: Map<string, string>; first?: Cell; statuses: number[]; before?: string; at: Date;
};

function ctx(world: object): Ctx {
  const w = world as { pbi16?: Ctx };
  w.pbi16 ??= { seen: [], items: new Map(), statuses: [], at: new Date("2026-11-06T10:00:00Z") };
  return w.pbi16;
}

async function mods(): Promise<Mods | null> {
  const [cellApi, server, board, fake, items, db] = await Promise.all([
    load<Mods["cellApi"]>("src/control/cell-api.ts"), load<Mods["server"]>("src/http/server.ts"), load<Mods["board"]>("src/control/board.ts"),
    load<Mods["fake"]>("src/adapters/fake.ts"), load<Mods["items"]>("src/store/items.ts"), load<Mods["db"]>("src/store/db.ts"),
  ]);
  return cellApi && server && board && fake && items && db ? { cellApi, server, board, fake, items, db } : null;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function base(c: Ctx): string {
  assert.ok(c.server, "the cell API didn't start: src/control/cell-api.ts, src/http/server.ts or src/control/board.ts is missing");
  return `http://127.0.0.1:${(c.server.address() as AddressInfo).port}`;
}

// Every table the cell API writes, so "nothing changed" means no route wrote anything at all.
async function snapshot(): Promise<string> {
  const pool = need().pool;
  const rows = async (sql: string) => (await pool.query(sql)).rows;
  return JSON.stringify([
    await rows("select * from item order by id"),
    await rows("select * from stage_run order by id"),
    await rows("select * from policy_result order by id"),
    await rows("select id from event order by id"),
  ]);
}

async function itemRow(c: Ctx, name: string): Promise<{ state: string; lease_owner: string | null; lease_generation: number }> {
  const id = c.items.get(name);
  assert.ok(id, `no item "${name}" was created`);
  return (await need().pool.query("select state, lease_owner, lease_generation from item where id = $1", [id])).rows[0];
}

async function call(c: Ctx, cell: Cell | undefined, method: string, path: string, body?: unknown, token = cell?.token): Promise<void> {
  if (!c.server || !cell) return;
  const r = await fetch(`${base(c)}/internal/cells/${cell.runId}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  await r.text();
  c.statuses.push(r.status);
}

function transitionBody(event: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const prUrl = `https://github.com/${repoName}/pull/41`;
  const byEvent: Record<string, Record<string, unknown>> = {
    scenarios_written: { question: { kind: "sign_off", body: "Scenarios for sign-off" }, scenariosSha: "5c3a1f0", lockedFiles: ["features/pbi-16-cell-api.feature"] },
    blocked: { question: { kind: "needs_input", body: "What should the cell do?" } },
    pr_opened: { prNumber: 41, prUrl },
    usage_limited: { resumeAt: "2026-11-06T15:00:00Z" },
  };
  return { event, ...byEvent[event], ...extra };
}

const stageBody = (stageId: string, attempt: number, status: string) => ({
  stageId, attempt, status, model: "claude-opus-5-5", tokensIn: 10, tokensOut: 20, costUsd: 0.01,
});

// One request per route, each with a body that would be accepted from the current generation.
function routeCall(route: string): [string, string, unknown?] {
  const calls: Record<string, [string, string, unknown?]> = {
    "POST /lease": ["POST", "/lease", { generation: 1 }],
    "POST /github-token": ["POST", "/github-token", {}],
    "GET /context": ["GET", "/context"],
    "POST /policy-results": ["POST", "/policy-results", {
      file: "dod", source: "repo", stageId: "green", attempt: 1, checkedSha: "abc1234",
      verdicts: [{ index: 1, criterion: "Tests pass", status: "passed", reason: "exit 0" }],
    }],
    "POST /pr": ["POST", "/pr", { prNumber: 41, prUrl: `https://github.com/${repoName}/pull/41` }],
    "GET /checks": ["GET", "/checks?sha=abc1234"],
    "POST /stage": ["POST", "/stage", stageBody("understand", 1, "started")],
    "POST /transition": ["POST", "/transition", transitionBody("blocked")],
    "POST /upload-url": ["POST", "/upload-url", { kind: "transcript", stageId: "understand", attempt: 1 }],
  };
  const found = calls[route];
  assert.ok(found, `unknown route ${route}`);
  return found;
}

Before({ tags: "@pbi-16", ...long }, async function () {
  const d = await testDb();
  if (d) await d.pool.query("truncate item cascade");
});

After({ tags: "@pbi-16" }, async function () {
  const c = ctx(this);
  c.off?.();
  for (const s of [c.server, c.upstream]) if (s) await new Promise((r) => s.close(r));
});

Given("a backlog source whose field map sets these board statuses:", long, async function (table: { hashes(): { state: string; status: string }[] }) {
  const c = ctx(this);
  const d = await testDb();
  const m = await mods();
  if (!d || !m) return;
  c.mods = m;
  const statusFor = Object.fromEntries(table.hashes().map((r) => [r.state, r.status || null]));
  const source = await d.pool.query<{ id: string }>(
    "insert into backlog_source (adapter, url, field_map) values ('fake', 'test:' || gen_random_uuid(), $1) returning id",
    [JSON.stringify({ statusFor })],
  );
  c.sourceId = source.rows[0].id;
  await d.pool.query("insert into repo (host_adapter, url, trusted_bot) values ('github', $1, 'factory[bot]') on conflict (url) do nothing", [`https://github.com/${repoName}`]);
  c.upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      c.seen.push({ headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  const upstreamPort = await listen(c.upstream);
  const board = m.fake.fakeBacklog();
  const repoHost = m.fake.fakeRepoHost();
  c.board = board;
  const backlogFor = () => board.adapter;
  c.off = m.board.mirrorBoard({ pool: d.pool, backlogFor, repoHost });
  const api = m.cellApi.cellApi({
    pool: d.pool, secret, repoHost, backlogFor,
    stageAfter: (_sop: string | null, stageId: string) => ({ understand: "specify", specify: "sign-off", red: "green" })[stageId] ?? null,
    uploadUrl: async (path: string) => `http://blob.test/${path}?sig=write-only`,
    gateway: { upstream: `http://127.0.0.1:${upstreamPort}`, ownerToken: () => "owner-secret" },
    webToolsOf: () => [],
  });
  c.server = await m.server.startServer([api], { port: 0 });
});

Given("item {string} from that source was claimed, so its run is in progress at lease generation {int}", long, async function (name: string, _generation: number) {
  const c = ctx(this);
  const m = c.mods;
  if (!m || !c.board || !c.sourceId) return;
  const pool = need().pool;
  await c.board.seed({ externalId: name });
  const item = await pool.query<{ id: string }>("insert into item (source_id, external_id, title, state) values ($1, $2, 'Cell API', 'Queued') returning id", [c.sourceId, name]);
  c.items.set(name, item.rows[0].id);
  const claim = await m.db.withTx(pool, (client) => m.items.claimNext(client, "cell-a", c.at));
  assert.ok(claim, "the claim returned nothing");
  await pool.query("update run set repo_id = (select id from repo where url = $2), sop_version = 'default@1', config_sha = 'cfg1234' where id = $1", [claim.runId, `https://github.com/${repoName}`]);
  c.first = { runId: claim.runId, generation: claim.generation, token: m.cellApi.runToken(secret, claim.runId, claim.generation) };
  c.before = await snapshot();
});

Given("item {string}'s lease expired and it was claimed again, so the first cell's token is from an older generation", long, async function (_name: string) {
  const c = ctx(this);
  const m = c.mods;
  if (!m || !c.first) return;
  const later = new Date(c.at.getTime() + 6 * 60_000);
  await m.db.withTx(need().pool, async (client) => {
    await m.items.expireLeases(client, later);
    await m.items.claimNext(client, "cell-b", later);
  });
  c.before = await snapshot();
});

Given("item {string} from that source is NotReady, and the board shows it as {string}", long, async function (name: string, status: string) {
  const c = ctx(this);
  if (!c.board || !c.sourceId) return;
  await c.board.seed({ externalId: name, status });
  const item = await need().pool.query<{ id: string }>("insert into item (source_id, external_id, title, state) values ($1, $2, 'Other item', 'NotReady') returning id", [c.sourceId, name]);
  c.items.set(name, item.rows[0].id);
});

Given("a model gateway in front of a fake upstream", function () {
  // The Background already put the gateway in front of a fake upstream, so this step only checks it did.
  const c = ctx(this);
  if (c.server) assert.ok(c.upstream);
});

When("the cell reports stage {string} attempt {int} as {string} with its token", long, async function (stage: string, attempt: number, status: string) {
  const c = ctx(this);
  await call(c, c.first, "POST", "/stage", stageBody(stage, attempt, status));
});

When("the first cell calls {string} with its token", long, async function (route: string) {
  const c = ctx(this);
  const [method, path, body] = routeCall(route);
  await call(c, c.first, method, path, body);
});

When("a cell calls {string} for item {string}'s run with a token signed by another secret", long, async function (route: string, _name: string) {
  const c = ctx(this);
  const [method, path, body] = routeCall(route);
  if (!c.first || !c.mods) return;
  await call(c, c.first, method, path, body, c.mods.cellApi.runToken("another-secret", c.first.runId, c.first.generation));
});

When("the cell sends the transition {string} with its token", long, async function (event: string) {
  const c = ctx(this);
  await call(c, c.first, "POST", "/transition", transitionBody(event));
});

When("the cell sends the transition {string} for PR {int} with its token", long, async function (event: string, pr: number) {
  const c = ctx(this);
  await call(c, c.first, "POST", "/transition", transitionBody(event, { prNumber: pr, prUrl: `https://github.com/${repoName}/pull/${pr}` }));
});

When("the cell sends the transition {string} with the question {string} and its token", long, async function (event: string, question: string) {
  const c = ctx(this);
  await call(c, c.first, "POST", "/transition", transitionBody(event, { question: { kind: "needs_input", body: question } }));
});

When("the watcher moves item {string} back to Eligible because the item was edited", long, async function (name: string) {
  const c = ctx(this);
  const m = c.mods;
  const id = c.items.get(name);
  if (!m || !id) return;
  await m.db.withTx(need().pool, (client) => m.items.transitionItem(client, id, "item_edited", { actor: "system", actorId: "watcher" }));
});

When("the first cell sends a model request with its stand-in token", long, async function () {
  const c = ctx(this);
  if (!c.server || !c.first) return;
  const r = await fetch(`${base(c)}/internal/model/v1/messages`, {
    method: "POST",
    headers: { authorization: `Bearer sk-ant-oat01-${c.first.runId}.${c.first.generation}.${c.first.token}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku-5-5" }),
  });
  await r.text();
  // PBI 33's steps read the gateway's answer and the upstream's requests from their own context.
  (this as { pbi33?: unknown }).pbi33 = { gateway: c.server, status: r.status, seen: c.seen, containers: false };
});

Then("the cell API answers {int}", function (status: number) {
  const c = ctx(this);
  base(c);
  assert.equal(c.statuses.at(-1), status, `answers so far: ${c.statuses.join(", ")}`);
});

Then("the cell API answered {int}, {int} and then {int}", function (a: number, b: number, d: number) {
  const c = ctx(this);
  base(c);
  assert.deepEqual(c.statuses, [a, b, d]);
});

Then("item {string}'s run has {int} stage run", long, async function (_name: string, n: number) {
  const c = ctx(this);
  base(c);
  assert.ok(c.first, "no run was claimed");
  const r = await need().pool.query("select count(*)::int as n from stage_run where run_id = $1", [c.first.runId]);
  assert.equal(r.rows[0].n, n);
});

Then("no stage run, event, item or policy result changed", long, async function () {
  const c = ctx(this);
  base(c);
  assert.ok(c.before, "no snapshot was taken");
  assert.equal(await snapshot(), c.before);
});

Then("item {string} is in state {string}", long, async function (name: string, state: string) {
  const c = ctx(this);
  base(c);
  assert.equal((await itemRow(c, name)).state, state);
});

Then("item {string} has no lease owner and is at lease generation {int}", long, async function (name: string, generation: number) {
  const c = ctx(this);
  base(c);
  const row = await itemRow(c, name);
  assert.equal(row.lease_owner, null);
  assert.equal(row.lease_generation, generation);
});

async function boardItem(c: Ctx, name: string) {
  base(c);
  assert.ok(c.board, "no board");
  const item = await c.board.adapter.getItem(name);
  assert.ok(item, `no board item ${name}`);
  return item;
}

Then("item {string} on the board shows the status {string}", async function (name: string, status: string) {
  assert.equal((await boardItem(ctx(this), name)).status, status);
});

Then("item {string} on the board carries the in-progress marker", async function (name: string) {
  assert.ok((await boardItem(ctx(this), name)).labels.includes(marker));
});

Then("item {string} on the board doesn't carry the in-progress marker", async function (name: string) {
  const c = ctx(this);
  assert.equal(c.statuses.at(-1), 200, `the transition answered ${c.statuses.at(-1)}`);
  assert.ok(!(await boardItem(c, name)).labels.includes(marker));
});

Then("item {string} on the board links {string}", async function (name: string, url: string) {
  assert.equal((await boardItem(ctx(this), name)).fields.pr, url);
});

Then("item {string} on the board has a comment holding {string}", async function (name: string, text: string) {
  const c = ctx(this);
  await boardItem(c, name);
  const comments = await c.board!.comments(name);
  assert.ok(comments.some((body) => body.includes(text)), `comments: ${JSON.stringify(comments)}`);
});
