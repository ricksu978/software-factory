// Step definitions for features/pbi-223-cell-api-isolation-run-token.feature (redesign step 4b).
//
// The @db scenarios run the cell API service through PBI 222's steps and context (serveCellApi on a free port the
// scenario's 7401 stands for), with PBI 16's claimed run, cell token, snapshot and Thens. The owner's sign-in token is
// signed by PBI 284's fake issuer, and the orchestrator API (src/api/main.ts's startApi) is asked to accept it before the
// cell API ever sees it, so the 401 is the cell API's own refusal of a token that is valid elsewhere.
//
// The egress proxy scenario runs the real src/scheduler/egress-proxy.mjs as a child process, as its unit test does,
// in front of three recording servers, the dashboard, the cell API and the API, each on a free port the scenario's
// 7400, 7401 and 7402 stand for (src/bdd/ports.ts). So that the proxy forwards on this machine, 127.0.0.1 stands in for
// host.docker.internal in its allowlist and in the cell's requests. Because the ports the proxy sees are free ports and
// not 7400 and 7402, the step hands the proxy the ports it must refuse in EGRESS_REFUSED_PORTS, a comma-separated
// list of ports. The proxy refuses with 403 any request, plain or CONNECT, to a port in that list, whatever its
// allowlist names. Unset, the proxy refuses 7400 and 7402, which is what it does in a cell's network.
//
// The worker's refusal runs src/scheduler/launcher.ts's ensureEgress, the worker's egress step, with CELL_CONTROL_URL
// as the scenario sets it and a `run` that records the docker commands instead of running them. It must throw an error
// naming the port before any `docker run` of the proxy.
//
// The probe scenario starts serveCellApi twice with PBI 222's deps, once with `local: true` and once with `local:
// false`. The cell API serves PBI 2's probes (POST /internal/cells/ping, GET /probe/sas, GET /probe/env and GET
// /probe/runs) only when `local` is true.
//
// The @local scenarios use PBI 6's aspire helpers. A cell container runs on the cells' network, factory-cells, and
// reaches out only through the factory-egress proxy the worker set up, at the cell API's address the worker hands cells
// (its CELL_CONTROL_URL).
import { After, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, request, type Server } from "node:http";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { runToken } from "../../src/control/cell-api.ts";
import { freePort, scenarioPorts } from "../../src/bdd/ports.ts";
import { CELL_NETWORK, EGRESS, egressAllow, ensureEgress } from "../../src/scheduler/launcher.ts";
import { load, long, need } from "./pbi-8.steps.ts";
import { ctx as p16ctx, stageBody, routeCall } from "./pbi-16.steps.ts";
import { answers, cellCall, ctx as p222ctx, deps, record, SECRET } from "./pbi-222.steps.ts";
import { bearer, ctx as p284ctx, startIssuer, stopAll as stopPbi284, validToken } from "./pbi-284.steps.ts";
import { APPHOST, ctx as p6ctx, describe, sh, startAspire } from "./pbi-6.steps.ts";

const PROXY_SCRIPT = fileURLToPath(new URL("../../src/scheduler/egress-proxy.mjs", import.meta.url));
const BLOB = "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=a2V5;BlobEndpoint=http://blob.test:7410/devstoreaccount1;";
const OWNER = "owner";
const AUDIENCE = "factory-api";

type Serving = { server: Server; stop(): Promise<void> };
type Recorder = { server: Server; seen: { method: string; path: string }[] };
type ApiModule = { startApi?: (d: object, port: number) => Promise<Serving> };
type CellApiModule = { serveCellApi?: (d: object, port: number) => Promise<Serving> };

type Ctx = {
  /** CELL_CONTROL_URL as the scenario sets it, with the port it names. */
  controlUrl?: string;
  /** The dashboard's, the cell API's and the API's recording servers, by the port the scenario names. */
  recorders: Map<number, Recorder>;
  proxy?: ChildProcess;
  proxyPort?: number;
  /** What the cell got through the proxy, by the port the scenario names, or the error when nothing answered. */
  viaProxy: Map<number, number | string>;
  /** The docker commands ensureEgress ran, and what it threw. */
  docker: string[][];
  egressError?: unknown;
  egressDone: boolean;
  ownerToken?: string;
  /** The two cell API services of the probe scenario, and what each answered. */
  localApi?: Serving;
  otherApi?: Serving;
  localPort?: number;
  otherPort?: number;
  probeError?: unknown;
  localStatus?: number | string;
  otherStatus?: number | string;
  // ---- @local ----
  envNames?: string[] | null;
  runsBefore?: number | null;
  uploadUrl?: string | null;
};

function ctx(world: object): Ctx {
  const w = world as { pbi223?: Ctx };
  w.pbi223 ??= { recorders: new Map(), viaProxy: new Map(), docker: [], egressDone: false };
  return w.pbi223;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

After({ tags: "@pbi-223", ...long }, async function () {
  const c = ctx(this);
  if (c.proxy && c.proxy.exitCode === null) {
    const gone = new Promise((resolve) => c.proxy!.once("exit", resolve));
    c.proxy.kill();
    await gone;
  }
  for (const r of c.recorders.values()) {
    r.server.closeAllConnections();
    await new Promise((resolve) => r.server.close(resolve));
  }
  await c.localApi?.stop();
  await c.otherApi?.stop();
  await stopPbi284(this);
});

// ---- the egress proxy ----

/** A server on the free port `named` stands for that records each request and answers `status`. */
async function recorder(world: object, named: number, status: (path: string) => number): Promise<void> {
  const c = ctx(world);
  const seen: Recorder["seen"] = [];
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    seen.push({ method: req.method ?? "", path });
    req.resume();
    req.on("end", () => res.writeHead(status(path), { "content-type": "text/plain" }).end(status(path) === 204 ? undefined : "ok"));
  });
  const port = await scenarioPorts(world).real(named);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  c.recorders.set(named, { server, seen });
}

/** Whether something accepts a connection on `port` on this machine. */
function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(port, "127.0.0.1");
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
  });
}

/** A plain HTTP request through the proxy for `url`, as a cell's curl or fetch sends one with http_proxy set. */
function throughProxy(c: Ctx, method: string, url: string): Promise<number | string> {
  return new Promise((resolve) => {
    assert.ok(c.proxyPort, "no egress proxy is running");
    const req = request({ host: "127.0.0.1", port: c.proxyPort, method, path: url, headers: { host: new URL(url).host } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", (e) => resolve(`nothing answered: ${e.message}`));
    req.setTimeout(10_000, () => req.destroy(new Error("timed out")));
    req.end();
  });
}

/** The cell's request to the scenario's `named` port on host.docker.internal, for which 127.0.0.1 stands in here. */
async function cellRequest(world: object, method: string, named: number, path: string): Promise<void> {
  const c = ctx(world);
  const real = await scenarioPorts(world).real(named);
  c.viaProxy.set(named, await throughProxy(c, method, `http://127.0.0.1:${real}${path}`));
}

Given("the dashboard answers on port {int}, the cell API on port {int} and the API on port {int}", long, async function (dashboard: number, cellApi: number, api: number) {
  await recorder(this, dashboard, () => 200);
  await recorder(this, cellApi, (path) => (path === "/internal/cells/ping" ? 204 : 404));
  await recorder(this, api, () => 200);
});

Given("the worker's environment points cells at {string}", function (url: string) {
  ctx(this).controlUrl = url;
});

Given("the egress proxy runs with the allowlist the worker builds for cells, widened to name ports {int} and {int} as well", long, async function (a: number, b: number) {
  const c = ctx(this);
  assert.ok(c.controlUrl, "the worker's environment doesn't point cells anywhere");
  const ports = scenarioPorts(this);
  const named = new URL(c.controlUrl);
  // The cell API's port as the worker would let it through, swapped for the free port it stands for here.
  named.port = String(await ports.real(Number(named.port)));
  const built = egressAllow({ controlUrl: named.toString(), blob: BLOB });
  const widened = [...built, `http:host.docker.internal:${await ports.real(a)}`, `http:host.docker.internal:${await ports.real(b)}`];
  const allow = widened.map((entry) => entry.replace(":host.docker.internal:", ":127.0.0.1:")).join(",");
  c.proxyPort = await freePort();
  c.proxy = spawn(process.execPath, [PROXY_SCRIPT], {
    env: {
      PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "",
      EGRESS_PORT: String(c.proxyPort), EGRESS_ALLOW: allow,
      EGRESS_REFUSED_PORTS: `${await ports.real(a)},${await ports.real(b)}`,
    },
    stdio: "ignore",
  });
  const end = Date.now() + 30_000;
  while (c.proxy.exitCode === null && !(await listening(c.proxyPort)) && Date.now() < end) await sleep(100);
  assert.ok(await listening(c.proxyPort), `the egress proxy never listened (exit code ${c.proxy.exitCode})`);
});

When("a cell posts to {string} on port {int} through the egress proxy", long, async function (path: string, port: number) {
  await cellRequest(this, "POST", port, path);
});

When("the cell asks for the dashboard's home page on port {int} through the egress proxy", long, async function (port: number) {
  await cellRequest(this, "GET", port, "/");
});

When("the cell asks for the floor on port {int} through the egress proxy", long, async function (port: number) {
  await cellRequest(this, "GET", port, "/v1/floor");
});

Then("the egress proxy forwards the cell's ping to the cell API", function () {
  const c = ctx(this);
  const named = Number(new URL(c.controlUrl!).port);
  const seen = c.recorders.get(named)?.seen ?? [];
  assert.deepEqual(seen, [{ method: "POST", path: "/internal/cells/ping" }], `the cell API received ${JSON.stringify(seen)}`);
  assert.equal(c.viaProxy.get(named), 204, `the cell's ping got ${c.viaProxy.get(named)}`);
});

Then("the egress proxy refuses the request to port {int} with {int}", function (port: number, status: number) {
  assert.equal(ctx(this).viaProxy.get(port), status, `the cell's request to port ${port} got ${ctx(this).viaProxy.get(port)}`);
});

Then("neither the dashboard nor the API received a request", function () {
  const c = ctx(this);
  const cellApi = Number(new URL(c.controlUrl!).port);
  for (const [port, r] of c.recorders) {
    if (port === cellApi) continue;
    assert.deepEqual(r.seen, [], `the server on port ${port} received ${JSON.stringify(r.seen)}`);
  }
});

// ---- the worker's egress step ----

When("the worker sets up the egress proxy for cells", long, async function () {
  const c = ctx(this);
  assert.ok(c.controlUrl, "the worker's environment doesn't point cells anywhere");
  const run = async (file: string, args: string[]) => {
    c.docker.push([file, ...args]);
    // No proxy is running yet, so inspecting it finds nothing.
    if (args[0] === "inspect") throw Object.assign(new Error("inspect failed"), { stderr: `Error: No such object: ${EGRESS}` });
    return { stdout: "" };
  };
  try {
    await ensureEgress({ image: "factory-cell:local", controlUrl: c.controlUrl, blob: BLOB, run });
  } catch (e) {
    c.egressError = e;
  }
  c.egressDone = true;
});

Then("it refuses with an error naming port {int}", function (port: number) {
  const c = ctx(this);
  assert.ok(c.egressDone, "the worker didn't set up the egress proxy");
  assert.ok(c.egressError, `the worker set up the egress proxy for cells at ${c.controlUrl}`);
  assert.match(String((c.egressError as Error).message ?? c.egressError), new RegExp(`\\b${port}\\b`));
});

Then("no egress proxy is started for cells", function () {
  const started = ctx(this).docker.filter((cmd) => cmd[0] === "docker" && cmd[1] === "run");
  assert.deepEqual(started, [], "the worker started an egress proxy");
});

// ---- the owner's sign-in token ----

Given("the owner holds a sign-in token that the orchestrator API accepts", long, async function () {
  const p = p284ctx(this);
  await startIssuer(p);
  p.audience = AUDIENCE;
  p.db = true;
  await need().pool.query(
    `insert into "user" (issuer, subject, github_login, role, product_owner) values ($1, $2, $2, 'owner', true)`, [p.issuerUrl, OWNER]);
  const token = await validToken(p, OWNER);
  ctx(this).ownerToken = token;
  // The orchestrator API takes it, so it is a good sign-in token and only the cell API refuses it.
  const mod = await load<ApiModule>("src/api/main.ts");
  assert.ok(mod?.startApi, "src/api/main.ts has no startApi");
  const port = await freePort();
  const api = await mod.startApi({
    pool: need().pool, issuer: p.issuerUrl, audience: AUDIENCE, webhookSecret: "pbi-223-webhook-secret",
    readBlob: async () => null, env: {},
  }, port);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/floor`, { headers: { authorization: bearer(token) } });
    await r.text();
    assert.equal(r.status, 200, `the orchestrator API answered ${r.status} to the owner's token`);
  } finally {
    await api.stop();
  }
});

When("someone calls {string} for item {string}'s run on port {int} with the owner's sign-in token", long, async function (route: string, _name: string, port: number) {
  const [method, path, body] = routeCall(route);
  record(this, port, await cellCall(this, port, method, path, body, ctx(this).ownerToken));
});

When("someone reports stage {string} attempt {int} as {string} for item {string}'s run on port {int} with the owner's sign-in token", long, async function (stage: string, attempt: number, status: string, _name: string, port: number) {
  record(this, port, await cellCall(this, port, "POST", "/stage", stageBody(stage, attempt, status), ctx(this).ownerToken));
});

When("the second cell calls {string} on port {int} with its token", long, async function (route: string, port: number) {
  const first = p16ctx(this).first;
  assert.ok(first, "no run was claimed");
  const { rows } = await need().pool.query<{ generation: number }>(
    "select i.lease_generation as generation from item i join run r on r.item_id = i.id where r.id = $1", [first.runId]);
  assert.ok(rows[0].generation > first.generation, "the item wasn't claimed again");
  const [method, path, body] = routeCall(route);
  record(this, port, await cellCall(this, port, method, path, body, runToken(SECRET, first.runId, rows[0].generation)));
});

Then("the cell API answered {int} and then {int}", function (a: number, b: number) {
  const p16 = p16ctx(this);
  const p222 = p222ctx(this);
  if (p222.cellApiError) assert.fail(`the cell API service didn't start: ${(p222.cellApiError as Error).message ?? p222.cellApiError}`);
  assert.ok(p16.server, "the cell API service didn't start");
  assert.deepEqual(p16.statuses, [a, b]);
});

// ---- PBI 2's probes on the cell API ----

When("one cell API service starts for the local platform and another starts outside it", long, async function () {
  const c = ctx(this);
  const mod = await load<CellApiModule>("src/cell-api/main.ts");
  assert.ok(mod?.serveCellApi, "src/cell-api/main.ts has no serveCellApi");
  c.localPort = await freePort();
  c.localApi = await mod.serveCellApi({ ...deps(this), local: true }, c.localPort);
  c.otherPort = await freePort();
  c.otherApi = await mod.serveCellApi({ ...deps(this), local: false }, c.otherPort);
});

When("a cell posts to {string} on each of them", long, async function (path: string) {
  const c = ctx(this);
  const post = async (port: number) => {
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST" });
      await r.text();
      return r.status;
    } catch (e) {
      return `nothing answered: ${(e as Error).message}`;
    }
  };
  c.localStatus = await post(c.localPort!);
  c.otherStatus = await post(c.otherPort!);
});

Then("the local cell API answers {int}", function (status: number) {
  assert.equal(ctx(this).localStatus, status);
});

Then("the other cell API answers {int}", function (status: number) {
  assert.equal(ctx(this).otherStatus, status);
});

// ---- @local: aspire run ----

/** The cell API's URL on this machine, once `aspire run` says it's up, or null. */
function cellApiUrl(): string | null {
  const waited = sh(`aspire wait cell-api --status up --timeout 300 ${APPHOST}`);
  const url = describe("cell-api").doc?.resources[0]?.urls?.[0]?.url;
  return waited.status === 0 && typeof url === "string" ? url.replace(/\/$/, "") : null;
}

/** The cell API's address as the worker hands it to cells, its CELL_CONTROL_URL, or null. */
function cellControlUrl(): string | null {
  const told = describe("worker").doc?.resources[0]?.environment?.CELL_CONTROL_URL;
  return typeof told === "string" ? told.replace(/\/$/, "") : null;
}

/** A URL on this machine as a cell names it, through host.docker.internal. */
const fromCell = (url: string) => url.replace(/\/\/(localhost|127\.0\.0\.1)(?=[:/])/, "//host.docker.internal");

/** Runs curl in a cell container on the cells' network, through the egress proxy, and gives back the status it printed. */
function curlInCell(image: string, args: string): number | null {
  const r = sh(`docker run --rm --network ${CELL_NETWORK} ${image} curl -s -o /dev/null -w "%{http_code}" --proxy http://${EGRESS}:3128 ${args}`);
  return Number.parseInt(r.stdout.trim(), 10) || null;
}

function setStatus(world: object, status: number | null): void {
  p6ctx(world).status = status;
}

async function getJson(path: string): Promise<unknown> {
  const base = cellApiUrl();
  if (!base) return null;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const r = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5_000) });
      return r.status === 200 ? await r.json() : null;
    } catch {
      await sleep(1_000);
    }
  }
  return null;
}

async function runCount(): Promise<number | null> {
  const n = ((await getJson("/probe/runs")) as { count?: unknown } | null)?.count;
  return typeof n === "number" ? n : null;
}

When("a {string} container on the cells' network posts to {string} on the cell API through the egress proxy", long, function (image: string, path: string) {
  const p6 = p6ctx(this);
  const base = cellControlUrl();
  setStatus(this, p6.imageBuilt && base ? curlInCell(image, `-X POST ${base}${path}`) : null);
});

When("the same container asks today's control plane for the dashboard's home page through the egress proxy", long, function () {
  const p6 = p6ctx(this);
  const url = describe("control").doc?.resources[0]?.urls?.[0]?.url;
  setStatus(this, p6.imageBuilt && typeof url === "string" ? curlInCell("factory-cell:local", fromCell(new URL("/", url).toString())) : null);
});

When("the same container asks the API on {int} for the floor through the egress proxy", long, function (port: number) {
  const p6 = p6ctx(this);
  setStatus(this, p6.imageBuilt ? curlInCell("factory-cell:local", `http://host.docker.internal:${port}/v1/floor`) : null);
});

Then("the egress proxy refuses the request with {int}", function (status: number) {
  assert.equal(p6ctx(this).status, status, "the egress proxy didn't refuse the cell's request");
});

When("a {string} container gets an upload URL from {string} on the cell API through the egress proxy", long, function (image: string, path: string) {
  const c = ctx(this);
  const base = cellControlUrl();
  c.uploadUrl = null;
  if (!p6ctx(this).imageBuilt || !base) return;
  const r = sh(`docker run --rm --network ${CELL_NETWORK} ${image} curl -s --proxy http://${EGRESS}:3128 ${base}${path}`);
  try {
    const url = (JSON.parse(r.stdout) as { url?: unknown }).url;
    c.uploadUrl = typeof url === "string" ? url : null;
  } catch {
    c.uploadUrl = null;
  }
});

When("the container PUTs a blob to that upload URL through the egress proxy", long, function () {
  const url = ctx(this).uploadUrl;
  setStatus(this, url ? curlInCell("factory-cell:local", `-X PUT -H "x-ms-blob-type: BlockBlob" --data hi "${url}"`) : null);
});

When("I ask the cell API for the names of its environment variables", long, async function () {
  const names = await getJson("/probe/env");
  ctx(this).envNames = Array.isArray(names) ? (names as string[]) : null;
});

Then("the names include {string}, {string}, {string}, {string} and {string}", function (a: string, b: string, c: string, d: string, e: string) {
  const names = ctx(this).envNames;
  assert.ok(names, "the cell API gave no variable names");
  for (const n of [a, b, c, d, e]) assert.ok(names.includes(n), `"${n}" is missing from ${JSON.stringify(names)}`);
});

Given("{string} has run once and the cell API's migrate probe recorded its run count", long, async function (_cmd: string) {
  const c = p6ctx(this);
  await startAspire(c);
  ctx(this).runsBefore = c.up ? await runCount() : null;
});

// PBI 6's "I stop aspire run and start it again" restarts it. The count after is the cell API's, read here.
Then("the cell API's migrate probe's run count is one higher than before", long, async function () {
  const before = ctx(this).runsBefore;
  const after = p6ctx(this).up ? await runCount() : null;
  assert.ok(typeof before === "number", "no run count from the cell API before the restart");
  assert.ok(typeof after === "number", "no run count from the cell API after the restart");
  assert.equal(after, before + 1);
});
