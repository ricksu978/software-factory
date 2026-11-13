// Step definitions for features/pbi-156-worker-main.feature. The @db scenarios run the worker from src/worker/main.ts
// and today's control plane from src/main.ts in this process, on PBI 4's shared test database, with fakes. PBI 17's
// steps own the items, the launcher's record and the item states, so the worker's launcher records into PBI 17's
// context. The worker module loads lazily, so while it doesn't exist every scenario fails on a Then.
// Each process mirrors only the transitions it commits, so the control plane gets a pool of its own on the same
// database, as it has in its own process.
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { format } from "node:util";
import type pg from "pg";
import { CLAIM_MARKER, OPT_IN_LABEL } from "../../src/adapters/contract.ts";
import { fakeBacklog, type fakeRepoHost } from "../../src/adapters/fake.ts";
import type { BacklogAdapter, FactoryItem } from "../../src/adapters/types.ts";
import { createAuth } from "../../src/http/auth.ts";
import type { Policy } from "../../src/policy/policy.ts";
import { createPool } from "../../src/store/db.ts";
import { load, long, need, testDb } from "./pbi-8.steps.ts";
import { ctx as p17, freshDb, newItem } from "./pbi-17.steps.ts";

const REPO = "ricksu978/software-factory";
const IMAGE = "factory-cell:scenario";
const CONTROL_URL = "http://host.docker.internal:7400";
const BLOB = "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=a2V5;BlobEndpoint=http://127.0.0.1:7410/devstoreaccount1;";
// The worker ticks this often here. It polls once at start and not again within a scenario, so an item a step adds
// later reaches the worker only through the tick.
const TICK_MS = 100;
const POLL_MS = 3_600_000;
// The old control plane ran its first tick and poll the moment it started, so a second covers both many times over.
const RUN_FOR_MS = 1_000;

type Fake = ReturnType<typeof fakeBacklog>;
type Host = ReturnType<typeof fakeRepoHost>;
type Call = { method: string; id: unknown; args: unknown[] };
export type Board = { name: string; id: string; fake: Fake; adapter: BacklogAdapter; calls: Call[]; failAll: boolean; refuseStatus: boolean };
export type Running = { stop(): Promise<void>; runs: Map<string, number>; done?: Promise<void> };
type WorkerModule = {
  startWorker(d: object): Promise<Running>;
  main(env: Record<string, string>, egress?: (cfg: object) => Promise<void>): Promise<Running>;
};
type MainModule = { serveControl?: (d: object, port: number) => Promise<{ stop(): Promise<void> }> };

export type Ctx = {
  /** Deps another feature's steps add to, or put in place of, the worker's, as PBI 157's steps give it a pool of its own. */
  deps?: Record<string, unknown>;
  boards: Board[];
  /** "egress" when the proxy was set up and "cell:<item id>" when a cell started, in order. */
  events: string[];
  egressCalls: Record<string, unknown>[];
  egressFails: boolean;
  launcherFailures: number;
  /** The cells the worker's launcher started. The control plane has none of its own. */
  launched: string[];
  verdicts: Map<string, boolean>;
  judged: string[];
  logs: string[];
  restore: (() => void)[];
  kill: boolean;
  env?: Record<string, string>;
  worker?: Running;
  workerError?: unknown;
  control?: { stop(): Promise<void> };
  controlPool?: pg.Pool;
  /** Why a module this feature needs couldn't be loaded. */
  missing?: string;
};

export function ctx(world: object): Ctx {
  const w = world as { pbi156?: Ctx };
  w.pbi156 ??= {
    boards: [], events: [], egressCalls: [], egressFails: false, launcherFailures: 0, launched: [],
    verdicts: new Map(), judged: [], logs: [], restore: [], kill: false,
  };
  return w.pbi156;
}

const pool = () => need().pool;
const host = (world: object) => p17(world).repoHost as unknown as Host;

Before({ tags: "@pbi-156" }, function () {
  const c = ctx(this);
  const originals = { log: console.log, warn: console.warn, error: console.error };
  for (const k of ["log", "warn", "error"] as const) {
    console[k] = (...args: unknown[]) => {
      c.logs.push(format(...args));
      originals[k](...args);
    };
  }
  c.restore.push(() => Object.assign(console, originals));
});

After({ tags: "@pbi-156", ...long }, async function () {
  const c = ctx(this);
  await c.worker?.stop();
  await c.control?.stop();
  await c.controlPool?.end();
  for (const r of c.restore.reverse()) r();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await ok())) {
    assert.ok(Date.now() < end, `timed out waiting until ${what}`);
    await sleep(25);
  }
}

/** A board adapter that records each call, and refuses the calls the scenario says it refuses. */
function recording(b: Omit<Board, "adapter">): BacklogAdapter {
  return new Proxy(b.fake.adapter, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      return async (...args: unknown[]) => {
        b.calls.push({ method: String(prop), id: args[0], args });
        if (b.failAll) throw new Error(`board ${b.name} is down`);
        if (b.refuseStatus && prop === "setStatus") throw new Error(`board ${b.name} refuses to set a status`);
        return v.apply(target, args);
      };
    },
  });
}

/** The named board, made on first use. The scenario's one board is PBI 17's fake, so items PBI 17 adds sit on it. */
export async function board(world: object, name = "the board"): Promise<Board> {
  const c = ctx(world);
  const found = c.boards.find((b) => b.name === name);
  if (found) return found;
  const id = (await pool().query<{ id: string }>(
    "insert into backlog_source (adapter, url, field_map) values ('fake', $1, $2) returning id",
    [`pbi-156:${name}:${crypto.randomUUID()}`, JSON.stringify({ optInLabel: OPT_IN_LABEL })],
  )).rows[0].id;
  const fake = name === "the board" ? (p17(world).backlog as unknown as Fake) : fakeBacklog();
  const b = { name, id, fake, calls: [] as Call[], failAll: false, refuseStatus: false };
  const made: Board = { ...b, adapter: null as never };
  made.adapter = recording(made);
  c.boards.push(made);
  // What the readiness gate reads from the repo at its head: a config and a DoD, so the factory's defaults run.
  const head = host(world).heads.get(REPO)!;
  host(world).files.set(`${REPO}@${head}:.factory/config.yml`, 'bdd:\n  parse: "true"\n  run: "true"\n  report: reports/bdd.ndjson\ncommands:\n  test: "true"\n  lint: "true"\n');
  host(world).files.set(`${REPO}@${head}:.factory/dod.md`, "- [ ] Tests pass. `run: true`\n");
  return made;
}

/** PBI 17 gives each item a backlog source of its own. Here they all sit on the scenario's one board. */
export async function rehome(world: object): Promise<void> {
  const b = await board(world);
  await pool().query("update item set source_id = $1 where source_id in (select id from backlog_source where url like 'test:%')", [b.id]);
}

/** Maps each board item the factory now holds to its id, so PBI 17's state steps can name it. */
export async function learnItems(world: object): Promise<void> {
  const c = ctx(world);
  const rows = (await pool().query<{ id: string; external_id: string }>(
    "select id, external_id from item where source_id = any($1)", [c.boards.map((b) => b.id)])).rows;
  for (const r of rows) p17(world).items[r.external_id] ??= r.id;
}

/** The readiness judge, as Task 12's verdict lines: every DoR criterion passes for a ready item, and the first fails otherwise. */
function judge(c: Ctx) {
  return async (item: FactoryItem, dor: Policy): Promise<string> => {
    c.judged.push(item.externalId);
    const ready = c.verdicts.get(item.externalId) ?? true;
    const lines = dor.criteria.map((cr, i) => JSON.stringify({ index: cr.index, status: ready || i > 0 ? "passed" : "failed", reason: ready ? "ok" : "not ready" }));
    return [...lines, '{"flags":[]}'].join("\n");
  };
}

/** Everything a process could be handed: the worker's fakes, and the control plane's settings beside them. */
export async function fakes(world: object) {
  const c = ctx(world);
  const s = p17(world);
  if (!c.boards.length) await board(world);
  const launcher = {
    async start(env: Record<string, string>) {
      if (c.launcherFailures > 0) {
        c.launcherFailures--;
        throw new Error("the cell launcher is down");
      }
      s.started.push(env);
      c.events.push(`cell:${env.ITEM_ID}`);
      c.launched.push(env.ITEM_ID);
      return `cell-${s.started.length}`;
    },
    async stop(name: string) {
      s.stopped.push(name);
    },
  };
  return {
    sources: c.boards.map((b) => ({ id: b.id, adapter: b.adapter })),
    repoHost: s.repoHost,
    launcher,
    egress: async (cfg: Record<string, unknown>) => {
      c.egressCalls.push(cfg);
      if (c.egressFails) throw new Error("docker isn't running");
      c.events.push("egress");
    },
    judge: judge(c),
    killFlag: c.kill,
    secret: "scenario-secret",
    controlUrl: CONTROL_URL,
    image: IMAGE,
    blob: BLOB,
    sopVersion: "default@1",
    tickMs: TICK_MS,
    pollMs: POLL_MS,
    // The control plane's own settings.
    local: false,
    auth: createAuth({ mode: "azure" }),
    origin: "http://127.0.0.1:7400",
    webhookSecret: "webhook-secret",
    claudeToken: "unused",
    uploadUrl: async (path: string) => `http://blob.test/${path}`,
    readBlob: async () => null,
  };
}

const ticks = (w: Running) => w.runs.get("scheduler tick") ?? 0;

/** Starts the worker and waits for `n` ticks and one poll of each board. A worker that fails to start is recorded. */
export async function startWorker(world: object, n: number): Promise<void> {
  const c = ctx(world);
  await rehome(world);
  const mod = await load<WorkerModule>("src/worker/main.ts");
  if (!mod) {
    c.missing = "src/worker/main.ts doesn't exist";
    return;
  }
  // PBI 17's state steps check that a scheduler ran. Here it's the worker's, once it has been started.
  p17(world).ticked = true;
  try {
    c.worker = await mod.startWorker({ pool: pool(), ...(await fakes(world)), ...c.deps });
  } catch (e) {
    c.workerError = e;
    // A worker that went ahead anyway would tick by now.
    await sleep(RUN_FOR_MS);
    return;
  }
  await waitFor(world, n);
}

/**
 * Waits for the start-up poll of each board, then for `n` ticks that ran wholly after it. A tick beside the poll can
 * find an item's row locked by it, and claimNext skips locked rows, so its claim waits for the next tick.
 */
async function waitFor(world: object, n: number): Promise<void> {
  const c = ctx(world);
  const w = c.worker!;
  for (const b of c.boards) await until(`the worker polls board ${b.name}`, () => (w.runs.get(`polling source ${b.id}`) ?? 0) >= 1);
  // The tick under way as the poll ended started beside it, so it doesn't count.
  const base = ticks(w) + 1;
  await until(`the worker ticks ${n} time(s)`, () => ticks(w) >= base + n);
  await learnItems(world);
}

async function startControl(world: object): Promise<void> {
  const c = ctx(world);
  await rehome(world);
  const mod = await load<MainModule>("src/main.ts");
  if (!mod?.serveControl) {
    c.missing = "src/main.ts has no serveControl, the control plane's start once its settings are read";
    return;
  }
  p17(world).ticked = true;
  const url = ((await testDb()) as unknown as { url: string }).url;
  c.controlPool = createPool(url);
  // Handed every fake the worker gets, so a control plane that still ran a job would reach for it.
  c.control = await mod.serveControl({ ...(await fakes(world)), pool: c.controlPool }, 0);
}

function started(c: Ctx): void {
  if (c.missing) assert.fail(c.missing);
}

// ---- Given ----

Given("a fresh factory database with one board", long, async function () {
  // No WIP, so the worker's tick leaves an item where its poll put it.
  await freshDb(this, 0);
  await board(this);
});

Given("a fresh factory database with two boards, {string} and {string}", long, async function (a: string, b: string) {
  await freshDb(this, 0);
  await board(this, a);
  await board(this, b);
});

Given("the egress proxy can't be set up", function () {
  ctx(this).egressFails = true;
});

Given("the worker's environment doesn't set CELL_IMAGE", function () {
  ctx(this).env = {
    FACTORY_ENV: "local", FACTORY_DB_URI: "postgres://nobody@127.0.0.1:1/none", FACTORY_BLOB: BLOB, CELL_SECRET: "s",
    GITHUB_APP_ID: "1", GITHUB_APP_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "t", CELL_CONTROL_URL: CONTROL_URL,
  };
});

Given("the cell launcher fails once and then works", function () {
  ctx(this).launcherFailures = 1;
});

// The worker reads FACTORY_KILL into its kill flag at start, as today's control plane did.
Given("the worker's environment sets FACTORY_KILL=1", function () {
  ctx(this).kill = true;
});

Given("the board holds a new item {string} with acceptance criteria", long, async function (ext: string) {
  await (await board(this)).fake.seed({ externalId: ext, title: `item ${ext}`, repo: REPO, acceptanceCriteria: ["Exports one month", "Totals add up"] });
});

Given("the readiness judge finds item {string} ready", function (ext: string) {
  ctx(this).verdicts.set(ext, true);
});

Given("the readiness judge finds item {string} not ready", function (ext: string) {
  ctx(this).verdicts.set(ext, false);
});

Given("board {string} holds a new item {string} the readiness judge finds ready", long, async function (name: string, ext: string) {
  await (await board(this, name)).fake.seed({ externalId: ext, title: `item ${ext}`, repo: REPO, acceptanceCriteria: ["Exports one month"] });
  ctx(this).verdicts.set(ext, true);
});

Given("board {string} fails every call", long, async function (name: string) {
  (await board(this, name)).failAll = true;
});

Given("the board shows the factory's state {string} as {string}", long, async function (state: string, status: string) {
  const b = await board(this);
  await pool().query(
    `update backlog_source set field_map = coalesce(field_map, '{}'::jsonb)
       || jsonb_build_object('statusFor', coalesce(field_map->'statusFor', '{}'::jsonb) || jsonb_build_object($2::text, $3::text))
     where id = $1`, [b.id, state, status]);
});

Given("the board refuses to set any status", long, async function () {
  (await board(this)).refuseStatus = true;
});

Given("item {string} is in review with open PR {int}", long, async function (ext: string, pr: number) {
  const id = await newItem(p17(this), ext, "InReview");
  await pool().query(
    "insert into run (item_id, run_number, next_stage, pr_number, branch, repo_id) values ($1, 1, 'address', $2, $3, (select id from repo where url = $4))",
    [id, pr, `factory/pbi-${ext}-r1`, `https://github.com/${REPO}`]);
  host(this).prs.push({
    number: pr, repo: REPO, branch: `factory/pbi-${ext}-r1`, base: "main", title: `item ${ext}`, body: "", headSha: null, open: true,
    merged: false, mergeSha: null, mergeable: true, reviewers: [], comments: [], reviews: [],
  });
  await (await board(this)).fake.adapter.claim(ext);
});

Given("item {string} has been withdrawn from the board", long, async function (ext: string) {
  // The opt-in label is gone and the factory's claim is still on it.
  await (await board(this)).fake.seed({ externalId: ext, title: `item ${ext}`, repo: REPO, labels: [CLAIM_MARKER] });
});

Given("item {string} is accepted, its PR merged and its definition of done met", long, async function (ext: string) {
  const id = await newItem(p17(this), ext, "Accepted");
  await pool().query(
    "insert into run (item_id, run_number, next_stage, merge_sha, repo_id) values ($1, 1, 'done', 'feed156', (select id from repo where url = $2))",
    [id, `https://github.com/${REPO}`]);
  // The DoD holds once CI on the merge commit passes.
  host(this).checks.set(`${REPO}@feed156`, "success");
  await (await board(this)).fake.adapter.claim(ext);
});

Given("the worker is running and has ticked once", long, async function () {
  await startWorker(this, 1);
});

// ---- When ----

When("the worker starts", long, async function () {
  const c = ctx(this);
  if (!c.env) return startWorker(this, 1);
  const mod = await load<WorkerModule>("src/worker/main.ts");
  if (!mod) {
    c.missing = "src/worker/main.ts doesn't exist";
    return;
  }
  p17(this).ticked = true;
  try {
    c.worker = await mod.main(c.env, async (cfg) => void c.egressCalls.push(cfg as Record<string, unknown>));
  } catch (e) {
    c.workerError = e;
  }
});

When("the worker starts and ticks once", long, async function () {
  await startWorker(this, 1);
});

When("the worker starts and ticks twice", long, async function () {
  await startWorker(this, 2);
});

When("the worker ticks again", long, async function () {
  const c = ctx(this);
  // A worker that never started leaves the Then to fail.
  if (!c.worker) return;
  // PBI 17 gave the item it just added a source of its own.
  await rehome(this);
  const w = c.worker;
  const now = ticks(w);
  await until("the worker ticks again", () => ticks(w) > now + 1);
});

When("the worker starts and polls the board once", long, async function () {
  await startWorker(this, 1);
});

When("the worker starts and polls each board once", long, async function () {
  await startWorker(this, 1);
});

When("today's control plane starts and has run for longer than one scheduler tick", long, async function () {
  await startControl(this);
  await sleep(RUN_FOR_MS);
});

When("today's control plane starts and has run for longer than one board poll", long, async function () {
  await startControl(this);
  await sleep(RUN_FOR_MS);
  await learnItems(this);
});

When("today's control plane starts", long, async function () {
  await startControl(this);
});

When("today's control plane and the worker both start and have run for longer than one scheduler tick", long, async function () {
  await startControl(this);
  if (ctx(this).missing) return;
  await startWorker(this, 2);
  await sleep(RUN_FOR_MS);
});

// ---- Then ----

Then("the egress proxy has been set up for the cell image, the cell API's address and the blob account", function () {
  const c = ctx(this);
  started(c);
  assert.equal(c.egressCalls.length, 1, `the egress proxy was set up ${c.egressCalls.length} times`);
  const { image, controlUrl, blob } = c.egressCalls[0];
  assert.deepEqual({ image, controlUrl, blob }, { image: IMAGE, controlUrl: CONTROL_URL, blob: BLOB });
});

Then("the egress proxy was set up before a cell started for item {string}", function (name: string) {
  const c = ctx(this);
  started(c);
  const egress = c.events.indexOf("egress");
  const cell = c.events.indexOf(`cell:${p17(this).items[name]}`);
  assert.ok(egress !== -1, "the egress proxy was never set up");
  assert.ok(cell !== -1, `no cell started for item ${name}`);
  assert.ok(egress < cell, `a cell started before the egress proxy was set up: ${c.events.join(", ")}`);
});

Then("the worker exits with an error saying the egress proxy couldn't be set up", function () {
  const c = ctx(this);
  started(c);
  assert.ok(c.workerError, "the worker started");
  assert.match(String((c.workerError as Error).message), /egress proxy couldn't be set up/);
});

Then("the worker exits with an error naming CELL_IMAGE", function () {
  const c = ctx(this);
  started(c);
  assert.ok(c.workerError, "the worker started");
  assert.match(String((c.workerError as Error).message), /CELL_IMAGE/);
});

Then("no egress proxy is set up", function () {
  const c = ctx(this);
  started(c);
  assert.deepEqual(c.egressCalls, []);
});

// A launcher that throws is caught inside the tick and logged as a scheduler failure, so either line counts.
Then("the worker's log records that a scheduler tick failed", function () {
  const c = ctx(this);
  started(c);
  assert.ok(c.logs.some((l) => /^scheduler(?: tick failed|: .* failed)/.test(l)), "no scheduler failure in the log");
});

Then("the readiness judge was asked about item {string}", function (ext: string) {
  const c = ctx(this);
  started(c);
  assert.ok(c.judged.includes(ext), `the judge was asked only about ${JSON.stringify(c.judged)}`);
});

Then("the worker's log records that polling board {string} failed", async function (name: string) {
  const c = ctx(this);
  started(c);
  const b = await board(this, name);
  assert.ok(c.logs.some((l) => l.startsWith(`polling source ${b.id} failed`)), `no failed poll of board ${name} in the log`);
});

Then("the board was never polled", function () {
  const c = ctx(this);
  started(c);
  for (const b of c.boards) assert.deepEqual(b.calls.filter((call) => call.method === "listEligible"), [], `board ${b.name} was polled`);
});

Then("the readiness judge was never asked about item {string}", function (ext: string) {
  const c = ctx(this);
  started(c);
  assert.ok(!c.judged.includes(ext), `the judge was asked about item ${ext}`);
});

Then("the factory holds no item {string}", async function (ext: string) {
  started(ctx(this));
  assert.equal((await pool().query("select 1 from item where external_id = $1", [ext])).rowCount, 0);
});

Then("exactly one cell starts for item {string}", function (name: string) {
  const c = ctx(this);
  started(c);
  const id = p17(this).items[name];
  assert.equal(p17(this).started.filter((env) => env.ITEM_ID === id).length, 1);
});

Then("the worker launched it", function () {
  const c = ctx(this);
  started(c);
  assert.deepEqual(c.launched, [...new Set(p17(this).started.map((env) => env.ITEM_ID))]);
});

async function boardItem(world: object, ext: string): Promise<FactoryItem> {
  const item = await (await board(world)).fake.adapter.getItem(ext);
  assert.ok(item, `the board holds no item ${ext}`);
  return item;
}

Then("the board item {string} is claimed", async function (ext: string) {
  started(ctx(this));
  assert.ok((await boardItem(this, ext)).labels.includes(CLAIM_MARKER), `board item ${ext} isn't claimed`);
});

Then("the board item {string} shows {string}", async function (ext: string, status: string) {
  started(ctx(this));
  assert.equal((await boardItem(this, ext)).status, status);
});

Then("the board item {string} is released", async function (ext: string) {
  started(ctx(this));
  assert.ok(!(await boardItem(this, ext)).labels.includes(CLAIM_MARKER), `board item ${ext} is still claimed`);
});

Then("the board item {string} is released and closed", async function (ext: string) {
  started(ctx(this));
  const item = await boardItem(this, ext);
  assert.ok(!item.labels.includes(CLAIM_MARKER), `board item ${ext} is still claimed`);
  assert.equal(item.closed, true, `board item ${ext} isn't closed`);
});

Then("PR {int} is closed with a note that the item was withdrawn", function (n: number) {
  started(ctx(this));
  const pr = host(this).prs.find((p) => p.number === n)!;
  assert.equal(pr.open, false, `PR ${n} is still open`);
  assert.ok(pr.comments.some((m) => /withdrawn/.test(m)), `PR ${n}'s comments don't say the item was withdrawn: ${JSON.stringify(pr.comments)}`);
});

const callsOn = async (world: object, ext: string, method: string) =>
  (await board(world)).calls.filter((call) => call.method === method && call.id === ext);

Then("the board item {string} was claimed exactly once", async function (ext: string) {
  started(ctx(this));
  assert.equal((await callsOn(this, ext, "claim")).length, 1);
});

Then("the board item {string} was set to {string} exactly once", async function (ext: string, status: string) {
  started(ctx(this));
  assert.equal((await callsOn(this, ext, "setStatus")).filter((call) => call.args[1] === status).length, 1);
});

Then("the worker's log records that board mirroring's setStatus failed for item {string}", function (name: string) {
  const c = ctx(this);
  started(c);
  const id = p17(this).items[name];
  assert.ok(c.logs.some((l) => l.startsWith(`board mirroring: setStatus failed for item ${id}`)), "no failed setStatus in the log");
});

// ---- @local: the owner runs these, and the PR records the run ----

const APPHOST = "--apphost . --non-interactive --nologo";
const aspire = (args: string) =>
  spawnSync(`aspire ${args} ${APPHOST}`, { shell: true, encoding: "utf8", env: { ...process.env, FACTORY_FLOAT_PORTS: "1" } });

Then("Aspire shows a worker resource started from src/worker/main.ts", function () {
  const r = aspire("describe worker --format Json");
  const out = r.stdout ?? "";
  // Asserted on, never printed: describe shows environment values such as FACTORY_DB_URI.
  assert.ok(/"name"\s*:\s*"worker/.test(out), `Aspire has no worker resource, exit status ${r.status}`);
  assert.ok(/src[\\/]+worker[\\/]+main\.ts/.test(out), "the worker resource doesn't run src/worker/main.ts");
});

Then("the worker resource's console shows its first scheduler tick", long, async function () {
  await until("the worker logs its first scheduler tick", () => /first scheduler tick/.test(aspire('logs worker --search "first scheduler tick"').stdout ?? ""), 120_000);
});
