// Step definitions for features/pbi-154-slow-model-requests.feature, on PBI 134's harness: the same test database,
// the real cell API with the model gateway it mounts under /internal/model, the same fake clock, and the same log.
//
// The upstream is a fake model service on a local port. It tells the items' requests apart by an x-pbi-154-item
// header the cell sends, which the gateway forwards unchanged, and acts on the fake clock: it never answers, sends its
// headers after a delay (and then streams for a while), or drops the connection after a delay. "The gateway forwards
// it" is the upstream getting the request, which a When waits for, so the clock never moves before the forward.
//
// A gateway slow line is a "slow:" line that names the model gateway, in the format src/control/slow-work.ts
// documents. A cell API slow line is PBI 134's.
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { long } from "./pbi-8.steps.ts";
import { ctx as ctx134, type Ctx as Ctx134 } from "./pbi-134.steps.ts";

type Behaviour =
  | { kind: "never" }
  | { kind: "headers"; afterMs: number; streamMs: number | null }
  | { kind: "drop"; afterMs: number };

type Sent = { ext: string; path: string; abort: AbortController; status?: number; error?: unknown; done: boolean; promise: Promise<void> };
type Ctx = {
  upstream: Server;
  url: string;
  behaviours: Map<string, Behaviour>;
  fallback: Behaviour;
  received: { ext: string; path: string; at: number }[];
  sent: Sent[];
  forwardedAt?: number;
};

const HEADER = "x-pbi-154-item";

function ctx(world: object): Ctx {
  const w = world as { pbi154?: Ctx };
  assert.ok(w.pbi154, "the fake upstream isn't running");
  return w.pbi154;
}

function behaviourFor(c: Ctx, ext: string): Behaviour {
  return c.behaviours.get(ext) ?? c.fallback;
}

function serve(world: object, req: IncomingMessage, res: ServerResponse): void {
  const c = ctx(world);
  const clock = ctx134(world).clock;
  const ext = String(req.headers[HEADER] ?? "");
  req.on("error", () => undefined);
  res.on("error", () => undefined);
  req.resume();
  req.on("end", () => {
    c.received.push({ ext, path: new URL(req.url ?? "/", "http://upstream").pathname, at: clock.now() });
    const b = behaviourFor(c, ext);
    if (b.kind === "never") return;
    if (b.kind === "drop") {
      clock.setTimeout(() => req.socket.destroy(), b.afterMs);
      return;
    }
    const started = clock.now();
    clock.setTimeout(() => {
      if (res.destroyed) return;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (b.streamMs === null) {
        res.end("event: message_stop\ndata: {}\n\n");
        return;
      }
      const end = started + b.streamMs;
      const next = () => {
        if (res.destroyed) return;
        if (clock.now() >= end) {
          res.end("event: message_stop\ndata: {}\n\n");
          return;
        }
        res.write("event: ping\ndata: {}\n\n");
        clock.setTimeout(next, Math.min(10_000, end - clock.now()));
      };
      next();
    }, b.afterMs);
  });
}

Before({ tags: "@pbi-154", ...long }, async function () {
  const upstream = createServer((req, res) => serve(this, req, res));
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  const url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  (this as { pbi154?: Ctx }).pbi154 = { upstream, url, behaviours: new Map(), fallback: { kind: "never" }, received: [], sent: [] };
  // The cell API, which PBI 134's steps start with the first run, sends model requests here.
  ctx134(this).upstream = url;
});

After({ tags: "@pbi-154", ...long }, async function () {
  const c = (this as { pbi154?: Ctx }).pbi154;
  if (!c) return;
  for (const s of c.sent) s.abort.abort();
  await Promise.race([Promise.allSettled(c.sent.map((s) => s.promise)), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  c.upstream.closeAllConnections();
  await new Promise<void>((resolve) => c.upstream.close(() => resolve()));
});

// --- the upstream --------------------------------------------------------------------------------------------------

const ms = (n: number, unit: string) => n * (unit.startsWith("minute") ? 60_000 : 1000);

Given("the upstream never answers", function () {
  ctx(this).fallback = { kind: "never" };
});

Given("the upstream never answers item {string}'s model requests", function (ext: string) {
  ctx(this).behaviours.set(ext, { kind: "never" });
});

Given(/^the upstream sends its response headers (\d+) (seconds?|minutes?) after it gets a request$/, function (n: string, unit: string) {
  ctx(this).fallback = { kind: "headers", afterMs: ms(Number(n), unit), streamMs: null };
});

Given(
  /^the upstream answers item "([^"]*)"'s model requests with headers after (\d+) (seconds?|minutes?) and keeps streaming for (\d+) (seconds?|minutes?)$/,
  function (ext: string, h: string, hUnit: string, s: string, sUnit: string) {
    ctx(this).behaviours.set(ext, { kind: "headers", afterMs: ms(Number(h), hUnit), streamMs: ms(Number(s), sUnit) });
  },
);

Given(/^the upstream drops item "([^"]*)"'s model requests after (\d+) (seconds?|minutes?) without answering$/, function (ext: string, n: string, unit: string) {
  ctx(this).behaviours.set(ext, { kind: "drop", afterMs: ms(Number(n), unit) });
});

// --- the cell ------------------------------------------------------------------------------------------------------

async function cellApiUrl(c134: Ctx134): Promise<string> {
  assert.ok(c134.server, "the cell API isn't running: no item has a run in progress");
  return `http://127.0.0.1:${(c134.server.address() as AddressInfo).port}`;
}

When("item {string}'s cell sends a model request to {string}", long, async function (ext: string, path: string) {
  const c = ctx(this);
  const c134 = ctx134(this);
  const run = c134.runs.get(ext);
  assert.ok(run, `item ${ext} has no run in progress`);
  const credential = `${run.runId}.${run.generation}.${run.token}`;
  const abort = new AbortController();
  const body = JSON.stringify({ model: "claude-opus-5-5", max_tokens: 16, messages: [{ role: "user", content: "hello" }] });
  const sent: Sent = { ext, path, abort, done: false, promise: Promise.resolve() };
  sent.promise = fetch(`${await cellApiUrl(c134)}/internal/model${path}`, {
    method: "POST",
    headers: { authorization: `Bearer sk-ant-oat01-${credential}`, "content-type": "application/json", [HEADER]: ext },
    body,
    signal: abort.signal,
  }).then(
    async (r) => {
      sent.status = r.status;
      await r.text().catch((e: unknown) => void (sent.error = e));
      sent.done = true;
    },
    (e: unknown) => {
      sent.error = e;
      sent.done = true;
    },
  );
  c.sent.push(sent);
  // The gateway has forwarded it once the upstream has it.
  const want = c.sent.length;
  const until = Date.now() + 15_000;
  while (c.received.length < want) {
    assert.ok(!sent.done, `the gateway answered item ${ext}'s model request with ${sent.status ?? String(sent.error)} instead of forwarding it`);
    assert.ok(Date.now() < until, `the gateway never forwarded item ${ext}'s model request to ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  c.forwardedAt = c134.clock.now();
});

When(/^item "([^"]*)"'s cell disconnects (\d+) seconds later$/, long, async function (ext: string, n: string) {
  const c = ctx(this);
  const sent = c.sent.find((s) => s.ext === ext);
  assert.ok(sent, `item ${ext}'s cell sent no model request`);
  await ctx134(this).clock.advance(Number(n) * 1000);
  assert.ok(!sent.done, `item ${ext}'s model request ended before its cell disconnected`);
  sent.abort.abort();
  await Promise.race([sent.promise, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  // Let the gateway see the closed connection before the clock moves on.
  await new Promise((resolve) => setTimeout(resolve, 100));
});

When(/^(\d+) (seconds?|minutes?) pass after the gateway forwards (?:it|them)$/, long, async function (n: string, unit: string) {
  const c = ctx(this);
  const clock = ctx134(this).clock;
  assert.ok(c.forwardedAt !== undefined, "the gateway forwarded nothing");
  const target = c.forwardedAt + ms(Number(n), unit);
  assert.ok(target >= clock.now(), `the clock is already past ${n} ${unit} after the forward`);
  await clock.advance(target - clock.now());
  assert.equal(clock.now(), target, `the clock is at ${clock.now()} ms, not ${target}`);
  assert.equal(clock.overdue(), 0, "a timer due by now is still pending");
  // Give the cell's connections, such as a stream that just ended, a moment to settle in real time.
  await new Promise((resolve) => setTimeout(resolve, 50));
});

// --- the log -------------------------------------------------------------------------------------------------------

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const CELL_API = /^slow: the cell API request \S+ \S+ for run (\S+)/;

const gatewayLines = (world: object) => ctx134(world).lines.filter((l) => l.startsWith("slow:") && l.includes("model gateway"));
const shown = (world: object) => {
  const lines = ctx134(world).lines;
  return lines.length ? lines.map((l) => `  ${l}`).join("\n") : "  (nothing)";
};
const namesPath = (line: string, path: string) => new RegExp(`(^|\\s)${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$|[,.;:])`).test(line);
const namesRun = (line: string, runId: string) => line.includes(runId);

function runIdOf(world: object, ext: string): string {
  const run = ctx134(world).runs.get(ext);
  assert.ok(run, `item ${ext} has no run in progress`);
  return run.runId;
}

function onlyGatewayLine(world: object): string {
  const lines = gatewayLines(world);
  assert.ok(lines.length === 1, `expected exactly 1 "slow:" line from the model gateway, the log has ${lines.length}:\n${shown(world)}`);
  return lines[0];
}

Then(/^the log has exactly (\d+) "slow:" lines? from the model gateway$/, function (n: string) {
  const lines = gatewayLines(this);
  assert.ok(lines.length === Number(n), `expected exactly ${n} "slow:" lines from the model gateway, the log has ${lines.length}:\n${shown(this)}`);
});

Then("that line names the path {string}", function (path: string) {
  const line = onlyGatewayLine(this);
  assert.ok(namesPath(line, path), `the gateway's slow line doesn't name the path ${path}: ${line}`);
});

Then("that line names item {string}'s run id", function (ext: string) {
  const line = onlyGatewayLine(this);
  const runId = runIdOf(this, ext);
  assert.ok(namesRun(line, runId), `the gateway's slow line doesn't name run ${runId}: ${line}`);
});

Then("the log has a {string} line from the cell API naming a run id", function (prefix: string) {
  assert.equal(prefix, "slow:");
  const line = ctx134(this).lines.find((l) => CELL_API.test(l));
  assert.ok(line, `the log has no "slow:" line from the cell API:\n${shown(this)}`);
  assert.ok(UUID.test(CELL_API.exec(line)![1]), `the cell API's slow line names no run id: ${line}`);
});

Then("the log has a {string} line from the model gateway naming a run id", function (prefix: string) {
  assert.equal(prefix, "slow:");
  assert.ok(gatewayLines(this).some((l) => UUID.test(l)), `the log has no "slow:" line from the model gateway naming a run id:\n${shown(this)}`);
});

Then("both lines name item {string}'s run id", function (ext: string) {
  const runId = runIdOf(this, ext);
  const cellApiLine = ctx134(this).lines.find((l) => CELL_API.test(l));
  assert.ok(cellApiLine, `the log has no "slow:" line from the cell API:\n${shown(this)}`);
  assert.equal(CELL_API.exec(cellApiLine)![1], runId, `the cell API's slow line names another run: ${cellApiLine}`);
  const gateway = gatewayLines(this);
  assert.ok(gateway.length > 0, `the log has no "slow:" line from the model gateway:\n${shown(this)}`);
  for (const l of gateway) assert.ok(namesRun(l, runId), `the gateway's slow line doesn't name run ${runId}: ${l}`);
});

Then("the log has a {string} line from the model gateway naming the path {string} and item {string}'s run id", function (prefix: string, path: string, ext: string) {
  assert.equal(prefix, "slow:");
  const runId = runIdOf(this, ext);
  assert.ok(
    gatewayLines(this).some((l) => namesPath(l, path) && namesRun(l, runId)),
    `no "slow:" line from the model gateway names the path ${path} and run ${runId}. The log:\n${shown(this)}`,
  );
});

Then("item {string}'s cell got a failed response", long, async function (ext: string) {
  const sent = ctx(this).sent.find((s) => s.ext === ext);
  assert.ok(sent, `item ${ext}'s cell sent no model request`);
  await Promise.race([sent.promise, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  assert.ok(sent.done, `item ${ext}'s model request is still open`);
  assert.ok(sent.error !== undefined || (sent.status ?? 0) >= 500, `item ${ext}'s cell got ${sent.status}, not a failure`);
});
