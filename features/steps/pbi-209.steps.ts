// Step definitions for features/pbi-209-running-stage-transcript.feature.
//
// PBI 131's steps make the item in its GitHub repo ("item ... is an issue in the repo ..."), on PBI 4's shared test
// database, and its "a viewer opens the item's Run detail" opens the dashboard this file's Before starts, with a
// readBlob that reads this scenario's blob store, so Run detail links stored transcripts.
//
// Each scenario runs a cell of its own, made of the parts a real cell is made of:
// - the engine's stageMeter, which every cell agent call goes through. Given a TranscriptUploads, it uploads the open
//   attempt's transcript so far on a setInterval of TRANSCRIPT_UPLOAD_MS. runCell hands it the cell API's upload.
// - a scripted agent whose calls fold their messages through the real foldMessages, which tells AgentArgs.onMessage
//   of each message's transcript line as it arrives. Each message the agent writes is an `assistant` message with an
//   id of its own, and a call that finishes writes a `result` message with its usage.
// - the real HTTP cell client, httpCellApi, talking to the real cell API on the test database, whose upload-url hands
//   out URLs on a blob server of this file's. That server keeps each PUT, when it arrived on the scenario's clock and
//   whether the stage was still running, and refuses PUTs while a step says blob storage does.
// - an attempt that ends does what runCell's `end` does: close the meter, wait for meter.settled(), then send /stage
//   and upload the complete transcript, or for a stopped attempt upload first and send /stage last.
// Only setInterval is mocked, so the scenario's clock moves only when a step says time passes, a second at a time,
// and each upload a tick starts is waited for before the next second.
//
// A transcript "holds" messages when the ids of the assistant messages on its lines are those messages, in order;
// a call's result line may sit between them. The log is console.error, console.warn and console.log: a failed
// transcript upload is a line saying "transcript upload" and "failed", naming the attempt as "build-1" or as
// "build" with "attempt 1".
//
// Run detail's Stages table is the <table> after <h2>Stages</h2>, its headings in <th> and one <tr> of <td> cells per
// attempt. "Stage", "Attempt", "Status", "Tokens", "Cost" and "Transcript" are its columns, and a transcript link is
// an <a href> in the Transcript cell. A running attempt says "running" or "so far" somewhere in its row.
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { mock } from "node:test";
import { format } from "node:util";
import { fakeBacklog, fakeRepoHost } from "../../src/adapters/fake.ts";
import { foldMessages, type AgentArgs, type AgentResult } from "../../src/agent/run.ts";
import { httpCellApi, type HttpCellApi } from "../../src/cell/api-client.ts";
import { stageMeter } from "../../src/cell/engine.ts";
import { cellApi, runToken } from "../../src/control/cell-api.ts";
import { createAuth } from "../../src/http/auth.ts";
import { dashboardRoutes } from "../../src/http/routes.ts";
import { startServer } from "../../src/http/server.ts";
import { withTx } from "../../src/store/db.ts";
import { expireLeases, transitionItem } from "../../src/store/items.ts";
import { ctx as itemCtx, open } from "./pbi-131.steps.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";

const SECRET = "pbi-209-cell-secret";
const MODEL = "claude-opus-5-5";
const pool = () => need().pool;

type Stream = AsyncIterable<SDKMessage> & { push(m: SDKMessage): void; end(): void };
type Call = { stream: Stream; done: Promise<AgentResult>; ended: boolean; error?: unknown };
type Attempt = {
  stage: string; attempt: number; calls: Call[];
  /** The ids of the messages its agent wrote, in order, across its calls. */
  messages: string[];
  /** The complete transcript the meter handed back when the attempt ended. */
  complete?: string;
  status?: string;
};
type Cell = {
  generation: number; api: HttpCellApi; meter: ReturnType<typeof stageMeter>;
  /** The stream the next agent call reads. */
  next?: Stream;
  abort: AbortController;
  dead: boolean;
};
type Put = { path: string; at: number; body: string; running: boolean };
type Ctx = {
  /** The scenario's clock, in ms since the cell started. */
  at: number;
  logs: string[];
  restore: (() => void)[];
  servers: Server[];
  blobOrigin?: string;
  cellOrigin?: string;
  runId?: string;
  itemId?: string;
  cell?: Cell;
  attempts: Attempt[];
  open?: Attempt;
  /** Every PUT the blob store kept. */
  puts: Put[];
  blobs: Map<string, string>;
  /** Every upload the cell tried while its stage ran, and whether it worked. */
  tries: { at: number; ok: boolean }[];
  inflight: Set<Promise<unknown>>;
  refuse: boolean;
  apiDown: boolean;
  /** Message ids handed out so far. */
  ids: number;
  /** What the last followed transcript link showed, or why there was nothing to show. */
  followed?: { text: string } | { missing: string };
  /** The tokens and cost the attempt's finished calls used, so a stage's total can be given "in all". */
  used: { tokensIn: number; tokensOut: number; costUsd: number };
};

function ctx(world: object): Ctx {
  const w = world as { pbi209?: Ctx };
  w.pbi209 ??= {
    at: 0, logs: [], restore: [], servers: [], attempts: [], puts: [], blobs: new Map(), tries: [], inflight: new Set(),
    refuse: false, apiDown: false, ids: 0, used: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
  };
  return w.pbi209;
}

const listen = async (s: Server) => {
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", () => resolve()));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
};

Before({ tags: "@pbi-209", ...long }, async function () {
  const d = await testDb();
  assert.ok(d, "src/store/test-db.ts doesn't exist");
  await d.pool.query('truncate item, event, backlog_source, repo, "user", override cascade');
  const c = ctx(this);

  const originals = { log: console.log, warn: console.warn, error: console.error };
  for (const k of ["log", "warn", "error"] as const) console[k] = (...args: unknown[]) => void c.logs.push(format(...args));
  c.restore.push(() => Object.assign(console, originals));

  // Blob storage: keeps each PUT by its path, unless it's refusing uploads.
  const blobs = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (b: Buffer) => chunks.push(b));
    req.on("end", () => {
      const path = decodeURIComponent((req.url ?? "/").slice(1));
      if (req.method !== "PUT") return void res.writeHead(405).end();
      if (c.refuse) return void res.writeHead(503).end("refused");
      const body = Buffer.concat(chunks).toString("utf8");
      c.blobs.set(path, body);
      c.puts.push({ path, at: c.at, body, running: c.open !== undefined });
      res.writeHead(201).end();
    });
  });
  c.blobOrigin = await listen(blobs);
  c.servers.push(blobs);

  const cells = await startServer([cellApi({
    pool: d.pool, secret: SECRET, repoHost: fakeRepoHost() as never, backlogFor: () => fakeBacklog().adapter as never,
    stageAfter: () => null, uploadUrl: async (path) => `${c.blobOrigin}/${encodeURIComponent(path)}`,
    gateway: { upstream: "http://model.test", ownerToken: () => "unused" }, webToolsOf: () => [],
  })], { port: 0 });
  c.cellOrigin = `http://127.0.0.1:${(cells.address() as AddressInfo).port}`;
  c.servers.push(cells);

  // PBI 131's dashboard, started here with a readBlob over this scenario's blob store, so Run detail links transcripts.
  const ic = itemCtx(this);
  const sourceId = (await d.pool.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'pbi-209:' || gen_random_uuid()) returning id")).rows[0].id;
  let handler: ReturnType<typeof dashboardRoutes> | undefined;
  ic.server = await startServer([(req, res) => handler!(req, res)], { port: 0 });
  ic.origin = `http://127.0.0.1:${(ic.server.address() as AddressInfo).port}`;
  handler = dashboardRoutes({
    pool: d.pool, auth: createAuth({ mode: "azure" }), origin: ic.origin, adapter: fakeBacklog().adapter, sourceId,
    readBlob: async (path) => c.blobs.get(path) ?? null,
  });
  ic.close = handler.close;

  mock.timers.enable({ apis: ["setInterval"] });
});

After({ tags: "@pbi-209", ...long }, async function () {
  const c = ctx(this);
  mock.timers.reset();
  c.cell?.abort.abort();
  for (const a of c.attempts) for (const call of a.calls) if (!call.ended) call.stream.end();
  for (const r of c.restore.reverse()) r();
  const ic = itemCtx(this);
  await ic.close?.();
  for (const s of [...c.servers, ...(ic.server ? [ic.server] : [])]) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

// ---- the scripted agent and the cell ----

function stream(): Stream {
  const queue: SDKMessage[] = [];
  let ended = false;
  let wake: (() => void) | null = null;
  return {
    push(m) {
      queue.push(m);
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (queue.length) {
          yield queue.shift()!;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => (wake = resolve));
        wake = null;
      }
    },
  };
}

/** Lets every upload a tick or a message started finish, as many event loop turns as that takes. */
async function settle(c: Ctx): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    while (c.inflight.size) await Promise.allSettled([...c.inflight]);
  }
}

function makeCell(world: object, generation: number): Cell {
  const c = ctx(world);
  const runId = c.runId!;
  const api = httpCellApi({ controlUrl: c.cellOrigin!, runId, runToken: runToken(SECRET, runId, generation), generation });
  // The cell API can't be reached: a port nothing listens on.
  const down = httpCellApi({ controlUrl: "http://127.0.0.1:1", runId, runToken: runToken(SECRET, runId, generation), generation });
  const cell: Cell = {
    generation, api, abort: new AbortController(), dead: false,
    meter: undefined as never,
  };
  const agent = (a: AgentArgs): Promise<AgentResult> => {
    const s = cell.next;
    assert.ok(s, "the scripted agent has no call to run");
    cell.next = undefined;
    return foldMessages(s, a.onMessage).then((r) => ({ ...r, model: a.model }));
  };
  cell.meter = stageMeter(agent, {
    upload: (b) => {
      // A dead cell sends nothing more.
      if (cell.dead) return new Promise<void>(() => {});
      const running = c.open !== undefined;
      const p = (c.apiDown ? down : api).upload(b);
      const tracked = p.then(() => running && c.tries.push({ at: c.at, ok: true }), () => running && c.tries.push({ at: c.at, ok: false }))
        .finally(() => c.inflight.delete(tracked));
      c.inflight.add(tracked);
      return p;
    },
  });
  return cell;
}

function startCall(world: object): Call {
  const c = ctx(world);
  const cell = c.cell!;
  const a = c.open;
  assert.ok(a, "no stage attempt is running");
  const s = stream();
  cell.next = s;
  const call: Call = { stream: s, ended: false, done: undefined as never };
  call.done = cell.meter.ask({ prompt: `the ${a.stage} stage`, model: MODEL, cwd: tmpdir(), mode: "cell", signal: cell.abort.signal });
  call.done.catch((e) => (call.error = e));
  a.calls.push(call);
  return call;
}

function running(world: object): Call {
  const a = ctx(world).open;
  assert.ok(a, "no stage attempt is running");
  const call = a.calls.at(-1);
  return call && !call.ended ? call : startCall(world);
}

async function write(world: object, n: number): Promise<void> {
  const c = ctx(world);
  const a = c.open!;
  const call = running(world);
  for (let i = 0; i < n; i++) {
    const id = `m${++c.ids}`;
    a.messages.push(id);
    call.stream.push({ type: "assistant", pbi209: id, message: { role: "assistant", content: [{ type: "text", text: `${a.stage}-${a.attempt} message ${id}` }] } } as never);
  }
  await settle(c);
}

/** Ends the running call with a result carrying its usage. */
async function finishCall(world: object, use = { tokensIn: 0, tokensOut: 0, costUsd: 0 }): Promise<void> {
  const c = ctx(world);
  const call = c.open?.calls.at(-1);
  if (!call || call.ended) return;
  call.stream.push({
    type: "result", subtype: "success", is_error: false, result: "done", session_id: "pbi-209-session",
    modelUsage: { [MODEL]: { inputTokens: use.tokensIn, outputTokens: use.tokensOut, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: use.costUsd } },
  } as never);
  call.stream.end();
  call.ended = true;
  await call.done.catch(() => {});
  c.used.tokensIn += use.tokensIn;
  c.used.tokensOut += use.tokensOut;
  c.used.costUsd += use.costUsd;
  await settle(c);
}

/** Moves the scenario's clock on, a second at a time. `each(s)` runs at the start of each second. */
async function pass(world: object, seconds: number, each?: (s: number) => Promise<void>): Promise<void> {
  const c = ctx(world);
  for (let s = 0; s < seconds; s++) {
    await each?.(s);
    c.at += 1000;
    mock.timers.tick(1000);
    await settle(c);
  }
}

async function startAttempt(world: object, stage: string, attempt: number): Promise<Attempt> {
  const c = ctx(world);
  const a: Attempt = { stage, attempt, calls: [], messages: [] };
  c.attempts.push(a);
  c.open = a;
  c.used = { tokensIn: 0, tokensOut: 0, costUsd: 0 };
  c.cell!.meter.open(stage, attempt);
  await c.cell!.api.stage({ stageId: stage, attempt, status: "started", model: MODEL, tokensIn: 0, tokensOut: 0, costUsd: 0 });
  return a;
}

/** Ends the open attempt as runCell's `end` does. `use` is what its last call used. */
async function endAttempt(world: object, status: "passed" | "failed" | "stopped", use?: { tokensIn: number; tokensOut: number; costUsd: number }): Promise<void> {
  const c = ctx(world);
  const a = c.open;
  assert.ok(a, "no stage attempt is running");
  const cell = c.cell!;
  if (status === "stopped") {
    // A stop from the dashboard aborts the agent, and its call ends.
    const call = a.calls.at(-1);
    if (call && !call.ended) {
      call.stream.end();
      call.ended = true;
      await call.done.catch(() => {});
    }
  } else await finishCall(world, use);
  c.open = undefined;
  const m = cell.meter.close();
  assert.ok(m, "the meter had no attempt open");
  await cell.meter.settled();
  a.complete = m.transcript;
  a.status = status;
  const report = { stageId: a.stage, attempt: a.attempt, status, model: MODEL, tokensIn: m.tokensIn, tokensOut: m.tokensOut, costUsd: m.costUsd };
  const upload = () => cell.api.upload({ kind: "transcript", stageId: a.stage, attempt: a.attempt, body: m.transcript });
  if (status === "stopped") {
    if (m.transcript) await upload().catch((e) => console.error(`stopped attempt ${a.stage}-${a.attempt}: transcript upload failed`, e));
    await cell.api.stage(report);
  } else {
    await cell.api.stage(report);
    if (m.transcript) await upload();
  }
  await settle(c);
}

/** Writes messages and lets 15 seconds pass, so the transcript so far is uploaded. */
async function uploadSoFar(world: object, messages: number): Promise<void> {
  await write(world, messages);
  await pass(world, 15);
}

// ---- reading what was stored ----

const pathOf = (world: object, p: string) => p.replace("<run>", ctx(world).runId!);

function ids(body: string): string[] {
  return body.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as { type?: string; pbi209?: string })
    .filter((m) => m.type === "assistant" && m.pbi209).map((m) => m.pbi209!);
}

function attemptOf(world: object, stage: string, n: number): Attempt {
  const a = ctx(world).attempts.find((x) => x.stage === stage && x.attempt === n);
  assert.ok(a, `no "${stage}" attempt ${n} ran`);
  return a;
}

const latestTo = (c: Ctx, path: string, running?: boolean) =>
  c.puts.filter((p) => p.path === path && (running === undefined || p.running === running)).at(-1);

const show = (c: Ctx) => c.puts.map((p) => `${p.at / 1000}s ${p.running ? "running" : "ended"} ${p.path}: ${ids(p.body).join(",")}`).join("\n") || "(none)";

function holds(c: Ctx, body: string | undefined, expected: string[], what: string): void {
  assert.ok(body !== undefined, `${what}: nothing was uploaded. Uploads:\n${show(c)}`);
  assert.deepEqual(ids(body), expected, `${what}: the transcript holds the wrong messages`);
  for (const line of body.split("\n").slice(0, -1)) JSON.parse(line);
  assert.ok(body.endsWith("\n"), `${what}: the transcript doesn't end its last line`);
}

// ---- Run detail ----

type Table = { headings: string[]; rows: { cells: string[]; html: string[] }[] };
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();

async function runDetail(world: object): Promise<string> {
  await open(world, `/items/${ctx(world).itemId}`);
  const ic = itemCtx(world);
  assert.equal(ic.status, 200, `Run detail answered ${ic.status}: ${ic.page?.slice(0, 300)}`);
  return ic.page!;
}

function stages(html: string): Table {
  const at = html.search(/<h2[^>]*>\s*Stages\s*<\/h2>/i);
  assert.ok(at >= 0, "Run detail has no Stages section");
  const rest = html.slice(at).replace(/^<h2[\s\S]*?<\/h2>/i, "");
  const section = rest.split(/<h2\b/i)[0];
  const t = /<table\b[\s\S]*?<\/table>/i.exec(section);
  assert.ok(t, "the Stages section has no table");
  const headings = [...t[0].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => text(m[1]));
  const rows = [...t[0].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => [...m[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => x[1]))
    .filter((cells) => cells.length).map((cells) => ({ cells: cells.map(text), html: cells }));
  return { headings, rows };
}

function column(t: Table, name: RegExp): number {
  const i = t.headings.findIndex((h) => name.test(h));
  assert.ok(i >= 0, `the Stages table has no ${name} column: ${t.headings.join(" | ")}`);
  return i;
}

function row(t: Table, stage: string, n: number): { cells: string[]; html: string[] } {
  const s = column(t, /^Stage$/i);
  const a = column(t, /^Attempt$/i);
  const rows = t.rows.filter((r) => r.cells[s] === stage && r.cells[a] === String(n));
  assert.equal(rows.length, 1, `the Stages table has ${rows.length} rows for "${stage}" attempt ${n}:\n${t.rows.map((r) => r.cells.join(" | ")).join("\n")}`);
  return rows[0];
}

/** The href of the attempt's transcript link on the page, or null when its Transcript cell has none. */
function link(html: string, stage: string, n: number): string | null {
  const t = stages(html);
  const r = row(t, stage, n);
  return /<a\b[^>]*\bhref\s*=\s*"([^"]*)"/i.exec(r.html[column(t, /^Transcript$/i)])?.[1].replace(/&amp;/g, "&") ?? null;
}

async function blob(world: object, href: string): Promise<{ status: number; text: string }> {
  const ic = itemCtx(world);
  const r = await fetch(new URL(href, ic.origin), { headers: { "x-ms-client-principal-idp": "aad", "x-ms-client-principal-id": "viewer", "x-ms-client-principal-name": "viewer" } });
  return { status: r.status, text: await r.text() };
}

/** Follows the attempt's transcript link. A missing link or file is kept as the reason, for the Then to report. */
async function follow(world: object, stage: string, n: number): Promise<void> {
  const c = ctx(world);
  const href = link(await runDetail(world), stage, n);
  if (!href) return void (c.followed = { missing: `Run detail has no transcript link for "${stage}" attempt ${n}` });
  const got = await blob(world, href);
  c.followed = got.status === 200 ? { text: got.text } : { missing: `${href} answered ${got.status}` };
}

function followed(world: object): string {
  const f = ctx(world).followed;
  assert.ok(f, "no transcript link was followed");
  if ("missing" in f) assert.fail(f.missing);
  return f.text;
}

// ---- the background ----

Given("the item's run is in progress in a cell", long, async function () {
  const c = ctx(this);
  const it = itemCtx(this).items.at(-1);
  assert.ok(it, "no item was set up");
  c.itemId = it.id;
  await pool().query(
    "update item set state = 'InProgress', lease_generation = 1, lease_owner = 'pbi-209-cell', lease_expires = now() + interval '5 minutes' where id = $1",
    [it.id]);
  c.runId = (await pool().query<{ id: string }>(
    `insert into run (item_id, repo_id, run_number, next_stage, branch, config_sha, execution_name, sop_version)
     values ($1, $2, 1, 'build', $3, 'c0ffee0', 'pbi-209-cell-1', '0.2.0') returning id`,
    [it.id, it.repoId, `factory/pbi-${it.ext}-r1`],
  )).rows[0].id;
  c.cell = makeCell(this, 1);
});

// ---- the stage and its agent ----

Given("the item's {string} stage attempt {int} has started", long, async function (stage: string, n: number) {
  await startAttempt(this, stage, n);
});

Given("its agent has written {int} messages", long, async function (n: number) {
  await write(this, n);
});

Given("its agent has written no messages yet", function () {
  assert.equal(ctx(this).open?.messages.length, 0);
});

Given("its agent wrote {int} messages before the first upload", long, async function (n: number) {
  await uploadSoFar(this, n);
});

Given("its agent wrote {int} messages before the cell uploaded the transcript so far", long, async function (n: number) {
  await uploadSoFar(this, n);
});

Given("it has written {int} more messages since", long, async function (n: number) {
  await write(this, n);
});

Given("it has written {int} more messages since, which haven't been uploaded yet", long, async function (n: number) {
  await write(this, n);
});

Given("its agent has written {int} more message since", long, async function (n: number) {
  await write(this, n);
});

Given("its agent has written no message since", function () {
  // Nothing to write.
});

Given("its first agent call finished after writing {int} messages", long, async function (n: number) {
  await write(this, n);
  await finishCall(this);
});

Given("its second agent call is still running and has written {int} messages", long, async function (n: number) {
  startCall(this);
  await write(this, n);
});

Given("its first agent call finished having used {int} tokens in and {int} tokens out at a cost of ${float}",
  long, async function (tokensIn: number, tokensOut: number, costUsd: number) {
    await write(this, 2);
    await finishCall(this, { tokensIn, tokensOut, costUsd });
  });

Given("its second agent call is still running", long, async function () {
  startCall(this);
  await write(this, 1);
});

Given("its first agent call wrote {int} messages and its second wrote {int}", long, async function (first: number, second: number) {
  await write(this, first);
  await finishCall(this);
  startCall(this);
  await write(this, second);
});

Given("the cell has uploaded the transcript so far", long, async function () {
  // A running call, writing a message, and 15 seconds for the upload.
  await uploadSoFar(this, 1);
});

Given("the cell uploaded the transcript so far when its agent had written {int} messages", long, async function (n: number) {
  await uploadSoFar(this, n);
});

Given("the cell uploaded it again after its agent had written {int} more", long, async function (n: number) {
  await uploadSoFar(this, n);
});

Given("the cell uploaded the transcript so far {int} seconds ago", long, async function (ago: number) {
  await write(this, 1);
  await pass(this, 15 - ago);
  await pass(this, ago);
});

Given("the item's {string} stage attempt {int} failed, and its transcript is stored at {string}", long, async function (stage: string, n: number, path: string) {
  const c = ctx(this);
  await startAttempt(this, stage, n);
  await write(this, 2);
  await endAttempt(this, "failed");
  assert.ok(c.blobs.has(pathOf(this, path)), `the failed attempt's transcript isn't at ${pathOf(this, path)}`);
  attemptOf(this, stage, n).complete = c.blobs.get(pathOf(this, path));
});

When("{int} seconds pass and the stage is still running", long, async function (s: number) {
  await pass(this, s);
});

When("{int} more seconds pass and the stage is still running", long, async function (s: number) {
  await pass(this, s);
});

When("its agent writes a message every second for {int} seconds while the stage keeps running", long, async function (s: number) {
  await pass(this, s, () => write(this, 1));
});

When("{int} seconds pass with no new messages and the stage still running", long, async function (s: number) {
  await pass(this, s);
});

When("its agent writes {int} message and {int} more seconds pass", long, async function (n: number, s: number) {
  await write(this, n);
  await pass(this, s);
});

When("its agent writes {int} messages and the cell uploads the transcript so far", long, async function (n: number) {
  await uploadSoFar(this, n);
});

When("the stage passes", long, async function () {
  await endAttempt(this, "passed");
});

When("the stage fails", long, async function () {
  await endAttempt(this, "failed");
});

When("the stage is stopped from the dashboard", long, async function () {
  await endAttempt(this, "stopped");
});

When("the stage passes, its agent calls having used {int} tokens in and {int} tokens out at a cost of ${float} in all",
  long, async function (tokensIn: number, tokensOut: number, costUsd: number) {
    const u = ctx(this).used;
    await endAttempt(this, "passed", { tokensIn: tokensIn - u.tokensIn, tokensOut: tokensOut - u.tokensOut, costUsd: costUsd - u.costUsd });
  });

// ---- uploads that fail ----

Given("blob storage refuses the upload", function () {
  ctx(this).refuse = true;
});

Given("the cell API can't be reached when the cell asks where to upload", function () {
  ctx(this).apiDown = true;
});

When("the cell tries to upload the transcript so far", long, async function () {
  await pass(this, 15);
});

Given("the cell's first try at uploading the transcript so far failed", long, async function () {
  const c = ctx(this);
  c.refuse = true;
  await pass(this, 15);
  c.refuse = false;
});

Given("blob storage refuses every upload while the stage runs", function () {
  ctx(this).refuse = true;
});

Given("its agent writes a message every {int} seconds for {int} seconds", long, async function (every: number, s: number) {
  await pass(this, s, (at) => (at % every === 0 ? write(this, 1) : Promise.resolve()));
});

When("blob storage takes uploads again and the stage passes", long, async function () {
  ctx(this).refuse = false;
  await endAttempt(this, "passed");
});

// ---- the cell dies ----

Given("it wrote {int} more messages before the cell died without ending the stage", long, async function (n: number) {
  await write(this, n);
  ctx(this).cell!.dead = true;
});

When("the run's lease expires", long, async function () {
  const c = ctx(this);
  await pool().query("update item set lease_expires = now() - interval '1 minute' where id = $1", [c.itemId]);
  await withTx(pool(), (tx) => expireLeases(tx, new Date()));
});

Given("the cell died without ending the stage, and the run's lease expired", long, async function () {
  const c = ctx(this);
  c.cell!.dead = true;
  await pool().query("update item set lease_expires = now() - interval '1 minute' where id = $1", [c.itemId]);
  await withTx(pool(), (tx) => expireLeases(tx, new Date()));
});

When("the item is claimed again and its {string} stage attempt {int} runs and uploads its own transcript", long, async function (stage: string, n: number) {
  const c = ctx(this);
  c.open = undefined;
  const generation = await withTx(pool(), async (tx) => {
    await transitionItem(tx, c.itemId!, "claimed", { actor: "system", actorId: "pbi-209" });
    return (await tx.query<{ g: number }>(
      "update item set lease_generation = lease_generation + 1, lease_owner = 'pbi-209-cell-2', lease_expires = now() + interval '5 minutes' where id = $1 returning lease_generation as g",
      [c.itemId])).rows[0].g;
  });
  c.cell = makeCell(this, generation);
  await startAttempt(this, stage, n);
  await uploadSoFar(this, 2);
  await endAttempt(this, "passed");
});

// ---- what the cell uploaded ----

Then("the cell has uploaded a transcript to {string}", function (path: string) {
  const c = ctx(this);
  const p = pathOf(this, path);
  assert.ok(latestTo(c, p, true), `nothing was uploaded to ${p} while the stage ran. Uploads:\n${show(c)}`);
});

Then("that transcript holds the {int} messages, one per line, in the order they were written", function (n: number) {
  const c = ctx(this);
  const a = c.open!;
  const put = latestTo(c, `transcripts/${c.runId}/${a.stage}-${a.attempt}.jsonl`, true);
  holds(c, put?.body, a.messages.slice(0, n), "the transcript so far");
});

Then("the latest transcript uploaded to {string} holds all {int} messages in order", function (path: string, n: number) {
  const c = ctx(this);
  assert.equal(c.open!.messages.length, n);
  holds(c, latestTo(c, pathOf(this, path), true)?.body, c.open!.messages, "the latest upload");
});

Then("the latest transcript uploaded to {string} holds the first call's {int} messages followed by the second call's {int}",
  function (path: string, first: number, second: number) {
    const c = ctx(this);
    assert.equal(c.open!.messages.length, first + second);
    holds(c, latestTo(c, pathOf(this, path), true)?.body, c.open!.messages, "the latest upload");
  });

Then("the cell has uploaded the transcript so far at least once", function () {
  const c = ctx(this);
  assert.ok(c.puts.some((p) => p.running), `nothing was uploaded while the stage ran. Uploads:\n${show(c)}`);
});

Then("no two of the uploads while the stage ran were less than {int} seconds apart", function (s: number) {
  const c = ctx(this);
  const at = c.puts.filter((p) => p.running).map((p) => p.at);
  for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= s * 1000, `uploads ${at[i - 1] / 1000}s and ${at[i] / 1000}s are closer than ${s}s. Uploads:\n${show(c)}`);
});

Then("there were no more than {int} uploads while the stage ran", function (n: number) {
  const c = ctx(this);
  const count = c.puts.filter((p) => p.running).length;
  assert.ok(count <= n, `${count} uploads while the stage ran:\n${show(c)}`);
});

Then("the cell has uploaded the transcript exactly once while the stage ran", function () {
  const c = ctx(this);
  assert.equal(c.puts.filter((p) => p.running).length, 1, `uploads:\n${show(c)}`);
});

Then("the cell has uploaded no transcript for {string} attempt {int} yet", function (stage: string, n: number) {
  const c = ctx(this);
  const p = `transcripts/${c.runId}/${stage}-${n}.jsonl`;
  assert.ok(!c.puts.some((x) => x.path === p), `${p} was uploaded:\n${show(c)}`);
});

Then("the cell has uploaded a transcript to {string} holding that {int} message", function (path: string, n: number) {
  const c = ctx(this);
  holds(c, latestTo(c, pathOf(this, path), true)?.body, c.open!.messages.slice(-n), "the transcript so far");
});

Then("the cell has uploaded a transcript to {string} holding those {int} messages", function (path: string, n: number) {
  const c = ctx(this);
  assert.equal(c.open!.messages.length, n);
  holds(c, latestTo(c, pathOf(this, path), true)?.body, c.open!.messages, "the transcript so far");
});

Then("the transcript stored at {string} is unchanged", function (path: string) {
  const c = ctx(this);
  const p = pathOf(this, path);
  const before = attemptOf(this, "build", Number(/-(\d+)\.jsonl$/.exec(p)![1])).complete;
  assert.equal(c.blobs.get(p), before, `${p} changed`);
});

Then("the cell has tried again and uploaded a transcript to {string} holding the {int} messages", function (path: string, n: number) {
  const c = ctx(this);
  const p = pathOf(this, path);
  assert.ok(c.tries.some((t) => !t.ok), "no upload failed first");
  holds(c, latestTo(c, p, true)?.body, c.open!.messages.slice(0, n), "the retried upload");
});

// ---- the stored transcript once the stage ends ----

Then("the transcript stored at {string} holds the first call's {int} messages followed by the second call's {int}, one per line",
  function (path: string, first: number, second: number) {
    const c = ctx(this);
    const a = c.attempts.at(-1)!;
    assert.equal(a.messages.length, first + second);
    holds(c, c.blobs.get(pathOf(this, path)), a.messages, "the stored transcript");
  });

Then("Run detail links that transcript for {string} attempt {int}", long, async function (stage: string, n: number) {
  const c = ctx(this);
  const href = link(await runDetail(this), stage, n);
  assert.equal(href, `/blobs/transcripts/${c.runId}/${stage}-${n}.jsonl`);
  const got = await blob(this, href);
  assert.equal(got.status, 200);
  assert.equal(got.text, c.blobs.get(`transcripts/${c.runId}/${stage}-${n}.jsonl`));
});

Then("{string} received an upload while the stage ran and another when it ended", function (path: string) {
  const c = ctx(this);
  const p = pathOf(this, path);
  assert.ok(latestTo(c, p, true), `${p} got no upload while the stage ran. Uploads:\n${show(c)}`);
  assert.ok(latestTo(c, p, false), `${p} got no upload when the stage ended. Uploads:\n${show(c)}`);
});

Then("the transcript stored there holds all {int} messages in order, the same as the complete transcript the stage would upload today", function (n: number) {
  const c = ctx(this);
  const a = c.attempts.at(-1)!;
  assert.equal(a.messages.length, n);
  const stored = c.blobs.get(`transcripts/${c.runId}/${a.stage}-${a.attempt}.jsonl`);
  holds(c, stored, a.messages, "the stored transcript");
  assert.equal(stored, a.complete, "the stored transcript isn't the complete transcript");
});

Then("no other transcript path holds a copy for {string} attempt {int}", function (stage: string, n: number) {
  const c = ctx(this);
  const own = `transcripts/${c.runId}/${stage}-${n}.jsonl`;
  const mine = new Set(attemptOf(this, stage, n).messages);
  const others = [...c.blobs].filter(([p, body]) => p !== own && ids(body).some((id) => mine.has(id))).map(([p]) => p);
  assert.deepEqual(others, []);
});

Then("the cell uploaded the complete transcript there without waiting for {int} seconds to pass", function (_s: number) {
  const c = ctx(this);
  const a = c.attempts.at(-1)!;
  const p = `transcripts/${c.runId}/${a.stage}-${a.attempt}.jsonl`;
  const last = latestTo(c, p, true);
  const final = latestTo(c, p, false);
  assert.ok(last && final, `uploads:\n${show(c)}`);
  assert.ok(final.at - last.at < 15_000, `the final upload came ${(final.at - last.at) / 1000}s after the last one`);
  assert.equal(final.body, a.complete);
});

Then("the transcript stored there holds the last message", function () {
  const c = ctx(this);
  const a = c.attempts.at(-1)!;
  const stored = c.blobs.get(`transcripts/${c.runId}/${a.stage}-${a.attempt}.jsonl`) ?? "";
  assert.ok(ids(stored).includes(a.messages.at(-1)!), `the stored transcript lacks ${a.messages.at(-1)}`);
});

Then("the transcript stored there holds all {int} messages in order", function (n: number) {
  const c = ctx(this);
  const a = c.attempts.at(-1)!;
  assert.equal(a.messages.length, n);
  holds(c, c.blobs.get(`transcripts/${c.runId}/${a.stage}-${a.attempt}.jsonl`), a.messages, "the stored transcript");
});

Then("the transcript stored at {string} holds all {int} messages in order", function (path: string, n: number) {
  const c = ctx(this);
  const a = c.attempts.at(-1)!;
  assert.equal(a.messages.length, n);
  holds(c, c.blobs.get(pathOf(this, path)), a.messages, "the stored transcript");
});

// ---- failed uploads ----

Then("the log says the transcript upload for {string} attempt {int} failed", function (stage: string, n: number) {
  const c = ctx(this);
  const said = c.logs.some((l) => /transcript upload/i.test(l) && /fail/i.test(l)
    && (l.includes(`${stage}-${n}`) || (l.includes(stage) && new RegExp(`attempt ${n}\\b`).test(l))));
  assert.ok(said, `no log line says the transcript upload for "${stage}" attempt ${n} failed. The log:\n${c.logs.join("\n") || "(empty)"}`);
});

Then("the stage keeps running and its agent is not interrupted", long, async function () {
  const c = ctx(this);
  const call = c.open?.calls.at(-1);
  assert.ok(call && !call.ended && call.error === undefined, "the agent's call ended");
  assert.equal(c.cell!.abort.signal.aborted, false, "the agent was aborted");
  // The agent carries on: it writes another message, and its call is still the stage's.
  await write(this, 1);
  assert.equal(call.error, undefined);
});

Then("the item stays InProgress", long, async function () {
  const r = await pool().query<{ state: string }>("select state from item where id = $1", [ctx(this).itemId]);
  assert.equal(r.rows[0].state, "InProgress");
});

// ---- Run detail ----

Then("the Stages table shows no transcript link for {string} attempt {int}", function (stage: string, n: number) {
  assert.equal(link(itemCtx(this).page!, stage, n), null);
});

Then("the Stages table shows {string} attempt {int} as still running", function (stage: string, n: number) {
  const r = row(stages(itemCtx(this).page!), stage, n);
  assert.ok(r.cells.some((x) => /\brunning\b|\bso far\b/i.test(x)), `the row doesn't say it's running: ${r.cells.join(" | ")}`);
});

Then("the Stages table links the transcript for {string} attempt {int}", function (stage: string, n: number) {
  const href = link(itemCtx(this).page!, stage, n);
  assert.equal(href, `/blobs/transcripts/${ctx(this).runId}/${stage}-${n}.jsonl`);
});

When("a viewer follows the transcript link for {string} attempt {int} on Run detail", long, async function (stage: string, n: number) {
  await follow(this, stage, n);
});

Then("the transcript shows the {int} messages written before the upload", function (n: number) {
  const a = ctx(this).open!;
  assert.deepEqual(ids(followed(this)), a.messages.slice(0, n));
});

Then("it doesn't show the {int} messages written since", function (n: number) {
  const a = ctx(this).open!;
  const shown = new Set(ids(followed(this)));
  assert.deepEqual(a.messages.slice(-n).filter((id) => shown.has(id)), []);
});

Then("the transcript shows all {int} messages in order", function (n: number) {
  const a = ctx(this).open!;
  assert.equal(a.messages.length, n);
  assert.deepEqual(ids(followed(this)), a.messages);
});

Then("the transcript shows the {int} messages uploaded before the cell died", function (n: number) {
  const a = ctx(this).attempts.at(-1)!;
  assert.deepEqual(ids(followed(this)), a.messages.slice(0, n));
});

Then("the Stages table shows {string} attempt {int} as stopped", long, async function (stage: string, n: number) {
  const t = stages(await runDetail(this));
  const r = row(t, stage, n);
  assert.match(r.cells[column(t, /^Status$/i)], /stopped/i);
});

Then("the Stages table shows {string} attempt {int} as passed", long, async function (stage: string, n: number) {
  const t = stages(await runDetail(this));
  const r = row(t, stage, n);
  assert.match(r.cells[column(t, /^Status$/i)], /passed/i);
});

Then("the Stages table shows {string} for {string} attempt {int}", function (tokens: string, stage: string, n: number) {
  const t = stages(itemCtx(this).page!);
  assert.equal(row(t, stage, n).cells[column(t, /^Tokens$/i)], tokens);
});

Then("the Stages table shows a cost of exactly {string} for {string} attempt {int}", function (cost: string, stage: string, n: number) {
  const t = stages(itemCtx(this).page!);
  assert.equal(row(t, stage, n).cells[column(t, /^Cost$/i)], cost);
});

Then("the Stages table links a transcript for {string} attempt {int} showing those {int} messages", long, async function (stage: string, n: number, count: number) {
  const href = link(itemCtx(this).page!, stage, n);
  assert.ok(href, `Run detail has no transcript link for "${stage}" attempt ${n}`);
  const got = await blob(this, href);
  assert.equal(got.status, 200, `${href} answered ${got.status}`);
  assert.deepEqual(ids(got.text), attemptOf(this, stage, n).messages.slice(0, count));
});

Then("the Stages table links a separate transcript for {string} attempt {int}", long, async function (stage: string, n: number) {
  const href = link(itemCtx(this).page!, stage, n);
  assert.equal(href, `/blobs/transcripts/${ctx(this).runId}/${stage}-${n}.jsonl`);
  const got = await blob(this, href);
  assert.deepEqual(ids(got.text), attemptOf(this, stage, n).messages);
});
