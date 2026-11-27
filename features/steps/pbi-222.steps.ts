// Step definitions for features/pbi-222-cell-api-service.feature. The @db scenarios run the cell API service from
// src/cell-api/main.ts in this process, on PBI 4's shared test database, with a fake board, a fake repo host and a fake
// model upstream. Today's control plane is retired (PBI 283), so where a scenario contrasts the cell API with it, the
// steps run the service that took over its other routes, the orchestrator API from src/api/main.ts: in this process,
// through apiApp with the test bearer check, or, for the PORT scenarios, as a child process from the environment they
// set, checking tokens at a test sign-in provider (features/fixtures/pbi-288-provider.ts). The API's /v1 routes are
// what the dashboard reads and posts its decisions to.
// PBI 16's steps own the claimed item, the cell's token, the snapshot and the cell API's Thens, so this file runs the
// cell API through PBI 16's context. PBI 156's "today's control plane starts" hands over to `todaysControlStart`.
// Each port a scenario names, 7400 or 7401, stands for a free port of the scenario's own (src/bdd/ports.ts), so
// scenarios in parallel workers never collide, and a program that really holds 7400 or 7401 is never reached.
import { After, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { createAdaptorServer } from "@hono/node-server";
import { fakeBacklog, fakeRepoHost } from "../../src/adapters/fake.ts";
import { runToken } from "../../src/control/cell-api.ts";
import { scenarioPorts } from "../../src/bdd/ports.ts";
import { startProvider, type Provider } from "../fixtures/pbi-288-provider.ts";
import { TEST_AUDIENCE, TEST_ISSUER, testBearer } from "../support/split-services.ts";
import { load, long, need, testDb } from "./pbi-8.steps.ts";
import { ctx as p16ctx, mods as p16mods, routeCall, snapshot, stageBody } from "./pbi-16.steps.ts";
import { freshForPbi319, isPbi319 } from "./pbi-319.steps.ts";

export const SECRET = "cell-secret";
const REPO = "ricksu978/software-factory";
/** The person who signs in to sign items off. */
const OWNER = "owner";
const CONFIG = "bdd:\n  parse: npm run bdd -- --dry-run\n  run: npm run bdd\n  report: reports/bdd.ndjson\ncommands:\n  test: npm test\n  lint: npm run lint\n";
const BLOB = "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=a2V5;BlobEndpoint=http://blob.test:7410/devstoreaccount1;";

type Serving = { server: Server; stop(): Promise<void> };
type CellApiModule = {
  serveCellApi?: (d: object, port: number) => Promise<Serving>;
  main?: (env: Record<string, string>) => Promise<{ stop(): Promise<void> }>;
};
type ApiModule = { apiApp?: (d: object) => { app: { fetch: (req: Request) => Response | Promise<Response> }; close(): Promise<void> } };
type Seen = { headers: IncomingHttpHeaders; body: string };

type Ctx = {
  board?: ReturnType<typeof fakeBacklog>;
  /** One repo host per scenario, so the claimed run's repo config is there when the model gateway reads it. */
  repoHost?: ReturnType<typeof fakeRepoHost>;
  sourceId?: string;
  upstream?: Server;
  upstreamUrl?: string;
  ownerToken?: string;
  seen: Seen[];
  /** The model request's answer, as the cell got it. */
  answer?: { status: number; body: string };
  cellApi?: Serving;
  cellApiError?: unknown;
  cellApiMain?: { stop(): Promise<void> };
  control?: Serving;
  /** What the API, in place of today's control plane, answered each call, in order. */
  statuses: number[];
  env?: Record<string, string>;
  child?: ChildProcess;
  stdout: string;
  stderr: string;
  exit?: { code: number | null };
  /** The test sign-in provider the API spawned by the PORT scenarios checks tokens at. */
  provider?: Provider;
  /** The owner's access token from the provider, once they signed in. */
  token?: string;
  itemId?: string;
  signOff?: number;
  failure?: string;
};

export function ctx(world: object): Ctx {
  const w = world as { pbi222?: Ctx };
  w.pbi222 ??= { seen: [], statuses: [], stdout: "", stderr: "" };
  return w.pbi222;
}

const pool = () => need().pool;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// PBI 223's scenarios run the cell API service through this context too.
After({ tags: "@pbi-222 or @pbi-223", ...long }, async function () {
  const c = ctx(this);
  await c.cellApi?.stop();
  await c.cellApiMain?.stop();
  await c.control?.stop();
  if (c.child && c.exit === undefined) {
    const gone = new Promise((resolve) => c.child!.once("exit", resolve));
    c.child.kill();
    await gone;
  }
  if (c.upstream) await new Promise((resolve) => c.upstream!.close(resolve));
  await c.provider?.stop();
});

/** True when something accepts a TCP connection on `port`, over IPv4 or IPv6. */
/** Whether anything answers on the free port the scenario's `named` port stands for. */
export async function answers(world: object, named: number): Promise<boolean> {
  const port = await scenarioPorts(world).real(named);
  const on = (host: string) => new Promise<boolean>((resolve) => {
    const s = connect({ host, port, timeout: 2_000 });
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
    s.once("timeout", () => { s.destroy(); resolve(false); });
  });
  return (await on("127.0.0.1")) || (await on("::1"));
}

async function fresh(): Promise<void> {
  const d = await testDb();
  assert.ok(d, "src/store/test-db.ts doesn't exist");
  await d.pool.query(`truncate item, "user", backlog_source, repo, webhook_delivery, override cascade`);
  await d.pool.query("update wip_policy set usage_paused_until = null, current_wip = 1");
}

async function source(c: Ctx): Promise<string> {
  c.board ??= fakeBacklog();
  c.sourceId ??= (await pool().query<{ id: string }>(
    "insert into backlog_source (adapter, url) values ('fake', 'pbi-222:' || gen_random_uuid()) returning id")).rows[0].id;
  return c.sourceId;
}

/** Everything the two services could be handed. Each takes the settings it needs. */
export function deps(world: object) {
  const c = ctx(world);
  return {
    pool: pool(),
    sources: c.sourceId ? [{ id: c.sourceId, adapter: c.board!.adapter }] : [],
    repoHost: c.repoHost ??= fakeRepoHost(),
    secret: SECRET,
    claudeToken: c.ownerToken ?? "unused",
    modelUpstream: c.upstreamUrl ?? "http://127.0.0.1:9/no-model-upstream",
    uploadUrl: async (path: string) => `http://blob.test/${path}`,
    local: false,
    // The orchestrator API's own settings. It checks bearer tokens with the test check, so no issuer has to run.
    issuer: TEST_ISSUER,
    audience: TEST_AUDIENCE,
    verify: testBearer,
    env: {},
    webhookSecret: "webhook-secret",
    readBlob: async () => null,
  };
}

async function fakeUpstream(c: Ctx, owner?: string): Promise<void> {
  c.ownerToken = owner;
  c.upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      c.seen.push({ headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ reply: "from the model upstream" }));
    });
  });
  await new Promise<void>((resolve) => c.upstream!.listen(0, "127.0.0.1", () => resolve()));
  c.upstreamUrl = `http://127.0.0.1:${(c.upstream.address() as AddressInfo).port}`;
}

export async function startCellApi(world: object, port: number): Promise<void> {
  const c = ctx(world);
  const mod = await load<CellApiModule>("src/cell-api/main.ts");
  if (!mod?.serveCellApi) {
    c.cellApiError = new Error("src/cell-api/main.ts has no serveCellApi");
    return;
  }
  try {
    c.cellApi = await mod.serveCellApi(deps(world), await scenarioPorts(world).real(port));
    // PBI 16's Thens check the cell API it calls is up.
    p16ctx(world).server = c.cellApi.server;
  } catch (e) {
    c.cellApiError = e;
  }
}

/** Serves the orchestrator API's app, in place of today's control plane, on the free port `port` stands for. */
async function startControl(world: object, port: number): Promise<void> {
  const c = ctx(world);
  const mod = await load<ApiModule>("src/api/main.ts");
  assert.ok(mod?.apiApp, "src/api/main.ts has no apiApp");
  const { app, close } = mod.apiApp(deps(world));
  const server = createAdaptorServer({ fetch: app.fetch }) as Server;
  const real = await scenarioPorts(world).real(port);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(real, "::", () => resolve());
  });
  c.control = {
    server,
    async stop() {
      await close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  p16ctx(world).server = server;
}

/** A cell's call to `port` under /internal/cells/<run>, with its token, unless the service on it never started. */
export async function cellCall(world: object, port: number, method: string, path: string, body?: unknown, token?: string): Promise<number | null> {
  const first = p16ctx(world).first;
  assert.ok(first, "no run was claimed");
  if (!(await answers(world, port))) return null;
  const r = await fetch(`http://127.0.0.1:${await scenarioPorts(world).real(port)}/internal/cells/${first.runId}${path}`, {
    method,
    headers: { authorization: `Bearer ${token ?? first.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  await r.text();
  return r.status;
}

async function modelRequest(world: object, port: number, token?: string): Promise<{ status: number; body: string } | null> {
  const first = p16ctx(world).first;
  assert.ok(first, "no run was claimed");
  if (!(await answers(world, port))) return null;
  const r = await fetch(`http://127.0.0.1:${await scenarioPorts(world).real(port)}/internal/model/v1/messages`, {
    method: "POST",
    headers: { authorization: `Bearer sk-ant-oat01-${first.runId}.${first.generation}.${token ?? first.token}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku-5-5" }),
  });
  return { status: r.status, body: await r.text() };
}

/** Records an answer from the scenario's `port`: the cell API's, on 7401, go to PBI 16's context, the API's to this one's. */
export function record(world: object, port: number, status: number | null): void {
  if (status === null) return;
  if (port === 7401) p16ctx(world).statuses.push(status);
  else ctx(world).statuses.push(status);
}

function cellApiStarted(c: Ctx): void {
  if (c.cellApiError) assert.fail(`the cell API service didn't start: ${(c.cellApiError as Error).message ?? c.cellApiError}`);
}

// ---- The orchestrator API as its own process ----

/** The scenario's test sign-in provider, started the first time a step needs it. */
async function provider(world: object): Promise<Provider> {
  const c = ctx(world);
  c.provider ??= await startProvider(OWNER);
  return c.provider;
}

/** The cell API's settings, with its port and cells' address set to the free port `cellApiPort` stands for. */
async function cellApiEnv(world: object, cellApiPort: number): Promise<Record<string, string>> {
  const real = await scenarioPorts(world).real(cellApiPort);
  return {
    FACTORY_ENV: "local", FACTORY_BLOB: BLOB, CELL_SECRET: SECRET, GITHUB_APP_ID: "1", GITHUB_APP_KEY: "k",
    CLAUDE_CODE_OAUTH_TOKEN: "t", PORT: String(real), CELL_CONTROL_URL: `http://localhost:${real}`,
  };
}

/** The API's settings for the scenario's `port` and `cellApiPort`, set to the free ports they stand for. */
async function apiEnv(world: object, port: number | null, cellApiPort: number): Promise<Record<string, string>> {
  const ports = scenarioPorts(world);
  const env: Record<string, string> = {
    FACTORY_ENV: "local", FACTORY_BLOB: BLOB, GITHUB_WEBHOOK_SECRET: "webhook-secret", GITHUB_APP_ID: "1", GITHUB_APP_KEY: "k",
    OIDC_ISSUER: (await provider(world)).issuer, API_AUDIENCE: TEST_AUDIENCE,
    CELL_CONTROL_URL: `http://localhost:${await ports.real(cellApiPort)}`,
  };
  if (port !== null) env.PORT = String(await ports.real(port));
  return env;
}

/** Starts the API's process and waits until it says it answers, or exits. Only PATH and SystemRoot come from this process. */
async function spawnApi(world: object): Promise<void> {
  const c = ctx(world);
  const db = (await testDb()) as unknown as { url: string };
  const child = spawn(process.execPath, ["src/api/main.ts"], {
    env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", FACTORY_DB_URI: db.url, ...c.env },
  });
  c.child = child;
  child.stdout.setEncoding("utf8").on("data", (d: string) => (c.stdout += d));
  child.stderr.setEncoding("utf8").on("data", (d: string) => (c.stderr += d));
  child.once("exit", (code) => (c.exit = { code }));
  const end = Date.now() + 60_000;
  while (c.exit === undefined && !/answers on port/.test(c.stdout) && Date.now() < end) await sleep(50);
}

// ---- Given ----

Given("a fresh factory database", long, async function () {
  // PBI 319's Before already emptied the database ahead of its Background, which signs people in to keep.
  if (isPbi319(this)) return freshForPbi319();
  await fresh();
});

Given("a fresh factory database where item {string} was claimed, so its run is in progress at lease generation {int}", long, async function (name: string, generation: number) {
  await fresh();
  const c = ctx(this);
  const p16 = p16ctx(this);
  const m = await p16mods();
  assert.ok(m, "a module PBI 16's steps need is missing");
  p16.mods = m;
  const sourceId = await source(c);
  await c.board!.seed({ externalId: name });
  await pool().query("insert into repo (host_adapter, url, trusted_bot) values ('github', $1, 'factory[bot]') on conflict (url) do nothing", [`https://github.com/${REPO}`]);
  const id = (await pool().query<{ id: string }>(
    "insert into item (source_id, external_id, title, state) values ($1, $2, 'Cell API', 'Queued') returning id", [sourceId, name])).rows[0].id;
  p16.items.set(name, id);
  const claim = await m.db.withTx(pool(), (client) => m.items.claimNext(client, "cell-a", p16.at));
  assert.ok(claim, "the claim returned nothing");
  assert.equal(claim.generation, generation);
  await pool().query("update run set repo_id = (select id from repo where url = $2), sop_version = 'default@1', config_sha = 'cfg1234' where id = $1", [claim.runId, `https://github.com/${REPO}`]);
  // The model gateway reads the run's pinned .factory/config.yml for its web tools, as it does for a real repo.
  (c.repoHost ??= fakeRepoHost()).files.set(`${REPO}@cfg1234:.factory/config.yml`, CONFIG);
  p16.first = { runId: claim.runId, generation: claim.generation, token: runToken(SECRET, claim.runId, claim.generation) };
  p16.before = await snapshot();
});

Given("a fresh factory database where item {string} waits for sign-off", long, async function (name: string) {
  await fresh();
  const c = ctx(this);
  const sourceId = await source(c);
  await c.board!.seed({ externalId: name });
  c.itemId = (await pool().query<{ id: string }>(
    "insert into item (source_id, external_id, title, state) values ($1, $2, 'the item', 'SignOff') returning id", [sourceId, name])).rows[0].id;
  await pool().query("insert into run (item_id, run_number, next_stage, scenarios_sha, locked_files) values ($1, 1, 'sign-off', 'abc1234', '{features/x.feature}')", [c.itemId]);
  await pool().query("insert into question (item_id, kind, body) values ($1, 'sign_off', 'Please sign off the scenarios')", [c.itemId]);
  // The owner signs in at the scenario's sign-in provider, which keys them, and is a product owner, so may sign off.
  const p = await provider(this);
  await pool().query(`insert into "user" (issuer, subject, github_login, role, product_owner) values ($1, $2, $3, 'owner', true)`, [p.issuer, p.subjectOf(OWNER), OWNER]);
});

Given("the cell API service's environment doesn't set CELL_SECRET", async function () {
  const env = await cellApiEnv(this, 7401);
  delete env.CELL_SECRET;
  ctx(this).env = { ...env, FACTORY_DB_URI: "postgres://nobody@127.0.0.1:1/none" };
});

Given("today's control plane's environment sets PORT to {int} and points cells at the cell API on {int}", async function (port: number, cellApi: number) {
  ctx(this).env = await apiEnv(this, port, cellApi);
  (this as { todaysControlStart?: () => Promise<void> }).todaysControlStart = () => spawnApi(this);
});

Given("today's control plane's environment points cells at the cell API on {int} but doesn't set PORT", async function (cellApi: number) {
  ctx(this).env = await apiEnv(this, null, cellApi);
  (this as { todaysControlStart?: () => Promise<void> }).todaysControlStart = () => spawnApi(this);
});

// ---- When ----

When("the cell API service starts on port {int}", long, async function (port: number) {
  await startCellApi(this, port);
});

When("the cell API service starts on port {int} in front of a fake model upstream, holding the owner token {string}", long, async function (port: number, owner: string) {
  await fakeUpstream(ctx(this), owner);
  await startCellApi(this, port);
});

When("the cell API service starts", long, async function () {
  const c = ctx(this);
  const mod = await load<CellApiModule>("src/cell-api/main.ts");
  if (!mod?.main) {
    c.cellApiError = new Error("src/cell-api/main.ts has no main");
    return;
  }
  try {
    c.cellApiMain = await mod.main(c.env!);
  } catch (e) {
    c.cellApiError = e;
  }
});

When("today's control plane starts on port {int}", long, async function (port: number) {
  await startControl(this, port);
});

When("today's control plane starts on port {int} in front of a fake model upstream", long, async function (port: number) {
  await fakeUpstream(ctx(this), "owner-secret");
  await startControl(this, port);
});

When("the cell reports stage {string} attempt {int} as {string} to port {int} with its token", long, async function (stage: string, attempt: number, status: string, port: number) {
  record(this, port, await cellCall(this, port, "POST", "/stage", stageBody(stage, attempt, status)));
});

When("the first cell calls {string} on port {int} with its token", long, async function (route: string, port: number) {
  const [method, path, body] = routeCall(route);
  record(this, port, await cellCall(this, port, method, path, body));
});

When("the cell calls {string} on port {int} with its token", long, async function (route: string, port: number) {
  const [method, path, body] = routeCall(route);
  record(this, port, await cellCall(this, port, method, path, body));
});

When("the cell sends a model request to port {int} with its token", long, async function (port: number) {
  const r = await modelRequest(this, port);
  if (!r) return;
  ctx(this).answer = r;
  record(this, port, r.status);
});

When("a cell sends a model request to port {int} with a token signed by another secret", long, async function (port: number) {
  const first = p16ctx(this).first!;
  const r = await modelRequest(this, port, runToken("another-secret", first.runId, first.generation));
  if (!r) return;
  ctx(this).answer = r;
  record(this, port, r.status);
});

When("someone asks port {int} for the dashboard's home page", long, async function (port: number) {
  if (!(await answers(this, port))) return;
  const r = await fetch(`http://127.0.0.1:${await scenarioPorts(this).real(port)}/`, { redirect: "manual" });
  await r.text();
  record(this, port, r.status);
});

// The owner signs in at the scenario's sign-in provider, which issues their access token, and the API on `named` takes
// it: the floor answers them.
When("the owner signs in to the dashboard on {string}", long, async function (named: string) {
  const c = ctx(this);
  const origin = await scenarioPorts(this).url(named);
  const token = (await provider(this)).accessToken(OWNER);
  try {
    const r = await fetch(`${origin}/v1/floor`, { headers: { authorization: `Bearer ${token}` } });
    const body = await r.text();
    if (r.status === 200) c.token = token;
    else c.failure = `the floor on ${origin} answered the signed-in owner ${r.status}: ${body}`;
  } catch (e) {
    c.failure = `nothing answered on ${origin}: ${(e as Error).message}`;
  }
});

When("the owner signs off item {string} from the dashboard on {string}", long, async function (_name: string, named: string) {
  const c = ctx(this);
  const origin = await scenarioPorts(this).url(named);
  if (!c.token) return;
  try {
    const r = await fetch(`${origin}/v1/items/${c.itemId}/decisions`, {
      method: "POST", body: JSON.stringify({ kind: "approve", text: "" }),
      headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json" },
    });
    await r.text();
    c.signOff = r.status;
  } catch (e) {
    c.failure = `nothing answered on ${origin}: ${(e as Error).message}`;
  }
});

// ---- Then ----

Then("item {string}'s run has {int} stage runs", long, async function (_name: string, n: number) {
  const first = p16ctx(this).first;
  assert.ok(first, "no run was claimed");
  const r = await pool().query("select count(*)::int as n from stage_run where run_id = $1", [first.runId]);
  assert.equal(r.rows[0].n, n);
});

Then("the model upstream receives the authorization {string}", function (auth: string) {
  const c = ctx(this);
  cellApiStarted(c);
  assert.equal(c.seen.length, 1, `the model upstream got ${c.seen.length} requests`);
  assert.equal(c.seen[0].headers.authorization, auth);
});

Then("the cell receives the model upstream's answer", function () {
  const c = ctx(this);
  cellApiStarted(c);
  assert.ok(c.answer, "the cell got no answer");
  assert.equal(c.answer.status, 200);
  assert.deepEqual(JSON.parse(c.answer.body), { reply: "from the model upstream" });
});

Then("the model upstream received no request", function () {
  const c = ctx(this);
  cellApiStarted(c);
  assert.equal(c.seen.length, 0, `the model upstream got ${c.seen.length} requests`);
});

Then("it exits with an error naming CELL_SECRET", function () {
  const c = ctx(this);
  assert.ok(c.cellApiError, "the cell API service started");
  assert.match(String((c.cellApiError as Error).message ?? c.cellApiError), /CELL_SECRET/);
});

Then("nothing answers on port {int}", long, async function (port: number) {
  assert.equal(await answers(this, port), false, `something answers on port ${port}`);
});

Then("today's control plane answers {int}", function (status: number) {
  const c = ctx(this);
  assert.ok(c.control, "the API didn't start");
  assert.equal(c.statuses.at(-1), status, `answers so far: ${c.statuses.join(", ")}`);
});

// A request without a sign-in is refused and asked for a bearer token, as the dashboard's reads are.
Then("the dashboard answers on port {int}", long, async function (port: number) {
  const c = ctx(this);
  assert.ok(c.exit === undefined, `the API exited ${c.exit?.code}:\n${c.stderr}`);
  const r = await fetch(`http://localhost:${await scenarioPorts(this).real(port)}/v1/floor`);
  await r.text();
  assert.equal(r.status, 401, `port ${port} answered ${r.status}`);
  assert.match(r.headers.get("www-authenticate") ?? "", /^Bearer\b/, `port ${port} asked for no bearer token`);
});

Then("nothing from today's control plane answers on port {int}", long, async function (port: number) {
  const c = ctx(this);
  const real = await scenarioPorts(this).real(port);
  assert.doesNotMatch(c.stdout, new RegExp(`answers on port ${real}\\b`), `the API says it answers on port ${port}, on ${real}`);
  assert.equal(await answers(this, port), false, `something answers on port ${port}`);
});

// The dev sign-in link is retired with the dev sign-in (PBI 283), and people sign in at the sign-in provider. So the
// console shows where the API answers: the port of the address people reach it on.
Then("its console shows a dashboard sign-in link on {string}", async function (named: string) {
  const c = ctx(this);
  const port = new URL(await scenarioPorts(this).url(named)).port;
  assert.match(c.stdout, new RegExp(`answers on port ${port}\\b`), `the console doesn't say it answers on ${named}'s port, ${port}:\n${c.stdout}`);
});

Then("the dashboard accepts the sign-off", function () {
  const c = ctx(this);
  if (c.failure) assert.fail(c.failure);
  // The API answers 200 with the decision's outcome once it is applied.
  assert.equal(c.signOff, 200, `the sign-off answered ${c.signOff}`);
});

// The item itself moves on at its next claim, which is the worker's, and none runs here. So "left SignOff" means the
// sign-off took: its question is answered with approve and the run moves on to red.
Then("item {string} has left SignOff", long, async function (_name: string) {
  const c = ctx(this);
  const q = (await pool().query("select decision from question where item_id = $1 and kind = 'sign_off'", [c.itemId])).rows[0];
  assert.equal(q?.decision, "approve", "the sign-off question isn't answered with approve");
  const run = (await pool().query("select next_stage from run where item_id = $1", [c.itemId])).rows[0];
  assert.equal(run.next_stage, "red");
});

Then("it exits with an error naming PORT", function () {
  const c = ctx(this);
  assert.ok(c.exit, `the API is still running:\n${c.stdout}`);
  assert.notEqual(c.exit.code, 0);
  assert.match(c.stderr, /\bPORT\b/);
});
