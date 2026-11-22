// Step definitions for features/pbi-224-run-detail-snapshots.feature (redesign step 4c).
//
// Every scenario runs on PBI 4's shared test database, with a fake board (src/adapters/fake.ts's fakeBacklog) and a
// fake repo host (fakeRepoHost) whose files are keyed `repo@sha:path`. Both are wrapped so a step can make them stop
// answering: "the repo stops answering every read" makes every call to either throw, and "the repo refuses every read
// of <path>" makes readFile throw for that path alone.
//
// The cell API is src/control/cell-api.ts's cellApi on a free port, as PBI 16's steps run it. A run is claimed the way
// claimNext claims one (the `claimed` transition, a new lease generation and the item's open run, or a new one), but
// for the named item, so two items in progress don't depend on claim order. The cell reports its scenarios written
// with POST /transition, event `scenarios_written`, its `scenariosSha` and `lockedFiles`. That report takes the item
// to SignOff, so a later report from the same run needs a changes round first: the owner asks for changes through
// src/control/decisions.ts's decide and the run is claimed again. A step that reports while the item waits at SignOff
// runs that round itself, as "the owner asked for changes to the scenarios" does.
//
// The snapshot is the run's `acceptance_criteria` and its `run_file` rows, read straight from the database. Run
// detail is GET /v1/items/{id} on the API (src/api/main.ts's startApi), with the owner's sign-in token from PBI 284's
// fake issuer. The API's Sign off form shows when the open question is a sign_off and `pending` holds the files at
// the scenarios sha, as web/src/pages/RunDetail.tsx decides.
//
// The backfill is src/worker/snapshot-backfill.ts's backfillSnapshots({ pool, repoHost, backlogFor }), which answers
// `{ filled: runIds, unfilled: [{ runId, reason }] }`. A run "before snapshots were stored" is a run row with a repo,
// a scenarios sha and its locked files, and no criteria and no run_file rows.
import { After, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { OPT_IN_LABEL } from "../../src/adapters/contract.ts";
import { fakeBacklog, fakeRepoHost } from "../../src/adapters/fake.ts";
import type { BacklogAdapter, RepoHost } from "../../src/adapters/types.ts";
import { freePort } from "../../src/bdd/ports.ts";
import { cellApi, runToken } from "../../src/control/cell-api.ts";
import { decide } from "../../src/control/decisions.ts";
import { startServer } from "../../src/http/server.ts";
import { withTx } from "../../src/store/db.ts";
import { transitionItem } from "../../src/store/items.ts";
import { load, long, need, testDb } from "./pbi-8.steps.ts";
import { ctx as p284ctx, startIssuer, stopAll as stopPbi284, validToken } from "./pbi-284.steps.ts";

const SECRET = "pbi-224-cell-secret";
const AUDIENCE = "factory-api";
const OWNER = "owner";
const LEASE_MS = 3_600_000;

type Serving = { server: Server; stop(): Promise<void> };
type ApiModule = { startApi?: (d: object, port: number) => Promise<Serving> };
type BackfillReport = { filled: string[]; unfilled: { runId: string; reason: string }[] };
type BackfillModule = {
  backfillSnapshots?: (d: { pool: unknown; repoHost: RepoHost; backlogFor: (sourceId: string) => BacklogAdapter }) => Promise<BackfillReport>;
};
type Cell = { runId: string; generation: number; token: string };
type Report = { status: number; body: string };
type Detail = {
  criteria: { criterion: string; scenarios: { name: string }[] }[] | null;
  pending: { path: string; text: string }[];
  question: { kind: string } | null;
};

type Ctx = {
  board: ReturnType<typeof fakeBacklog>;
  files: ReturnType<typeof fakeRepoHost>;
  /** The repo host and board the factory is handed, which honour `down` and `refused`. */
  host: RepoHost;
  backlog: BacklogAdapter;
  down: boolean;
  refused: Set<string>;
  repo?: string;
  repoId?: string;
  sourceId?: string;
  /** Each issue's external id on the board, by title. The first is the one "the issue" and "the run" mean. */
  issues: Map<string, string>;
  /** Each item's id and its run's id, by title. */
  items: Map<string, string>;
  runs: Map<string, string>;
  cells: Map<string, Cell>;
  server?: Server;
  reports: Report[];
  /** Each file's text in the repo when the cell last reported it, by path, and when the first backfill ran, by `repo@sha:path`. */
  reported: Map<string, string>;
  firstBackfill: Map<string, string>;
  backfills: BackfillReport[];
  api?: Serving;
  detail?: Detail;
};

function ctx(world: object): Ctx {
  const w = world as { pbi224?: Ctx };
  if (!w.pbi224) {
    const board = fakeBacklog();
    const files = fakeRepoHost();
    const c = { board, files, down: false, refused: new Set<string>(), issues: new Map(), items: new Map(), runs: new Map(), cells: new Map(), reports: [], reported: new Map(), firstBackfill: new Map(), backfills: [] } as unknown as Ctx;
    const unreachable = (what: string) => Object.assign(new Error(`${what}: the repo isn't answering`), { status: 503 });
    c.host = new Proxy(files, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (typeof v !== "function") return v;
        return (...args: unknown[]) => {
          if (c.down) throw unreachable(String(prop));
          if (prop === "readFile" && c.refused.has(String(args[2]))) throw Object.assign(new Error(`readFile ${String(args[2])}: refused`), { status: 500 });
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as RepoHost;
    c.backlog = new Proxy(board.adapter, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (typeof v !== "function") return v;
        return (...args: unknown[]) => {
          if (c.down) throw unreachable(String(prop));
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    w.pbi224 = c;
  }
  return w.pbi224;
}

const pool = () => need().pool;

After({ tags: "@pbi-224", ...long }, async function () {
  const c = ctx(this);
  if (c.server) {
    c.server.closeAllConnections();
    await new Promise((resolve) => c.server!.close(resolve));
  }
  await c.api?.stop();
  await stopPbi284(this);
});

/** The text of `path` the repo holds at `sha`, made up so each file and commit reads differently. */
const textOf = (path: string, sha: string, extra = "") =>
  `@pbi-224\nFeature: ${path} at ${sha}${extra}\n\n  Scenario: Something about ${path}\n    Given ${path} at ${sha}\n`;

function hold(c: Ctx, path: string, sha: string, text = textOf(path, sha)): void {
  assert.ok(c.repo, "no repo was set up");
  c.files.files.set(`${c.repo}@${sha}:${path}`, text);
}

function heldText(c: Ctx, path: string, sha: string): string {
  const text = c.files.files.get(`${c.repo}@${sha}:${path}`);
  assert.ok(text !== undefined, `the repo holds no ${path} at ${sha}`);
  return text;
}

/** The title of the issue "the issue" and "the run" mean: the first one the scenario names. */
function primary(c: Ctx): string {
  const first = [...c.issues.keys()][0];
  assert.ok(first, "no issue was set up");
  return first;
}

function runOf(c: Ctx, title: string): string {
  const id = c.runs.get(title);
  assert.ok(id, `"${title}" has no run`);
  return id;
}

// ---- the board, the repo and the issues ----

Given("a repo {string} on a board whose opt-in label is {string}", long, async function (repo: string, label: string) {
  const d = await testDb();
  assert.ok(d, "src/store/test-db.ts doesn't exist");
  assert.equal(label, OPT_IN_LABEL, `the fake board's opt-in label is ${OPT_IN_LABEL}`);
  await d.pool.query(`truncate item, "user", backlog_source, repo, webhook_delivery, override cascade`);
  await d.pool.query("update wip_policy set usage_paused_until = null, current_wip = 1");
  const c = ctx(this);
  c.repo = repo;
  c.sourceId = (await d.pool.query<{ id: string }>(
    "insert into backlog_source (adapter, url) values ('fake', 'pbi-224:' || gen_random_uuid()) returning id")).rows[0].id;
  c.repoId = (await d.pool.query<{ id: string }>(
    "insert into repo (host_adapter, url, trusted_bot) values ('github', $1, 'factory[bot]') returning id", [`https://github.com/${repo}`])).rows[0].id;
  const handler = cellApi({
    pool: d.pool, secret: SECRET, repoHost: c.host, backlogFor: () => c.backlog,
    stageAfter: (_sop, stageId) => ({ understand: "specify", specify: "sign-off", red: "green" } as Record<string, string>)[stageId] ?? null,
    uploadUrl: async (path) => `http://blob.test/${path}`,
    gateway: { upstream: "http://127.0.0.1:9/no-model-upstream", ownerToken: () => "unused" },
    webToolsOf: () => [],
  });
  c.server = await startServer([handler], { port: 0 });
});

async function issue(world: object, title: string, repo: string, criteria: string[]): Promise<void> {
  const c = ctx(world);
  assert.equal(repo, c.repo, `the issue's repo "${repo}" isn't the repo that was set up`);
  const id = await c.board.seed({ title, repo, acceptanceCriteria: criteria, labels: [OPT_IN_LABEL] });
  const seeded = await c.board.adapter.getItem(id);
  assert.ok(seeded, `the board doesn't read back the issue "${title}" it was seeded with`);
  assert.deepEqual(seeded.acceptanceCriteria, criteria, `the board reads back "${title}" with other acceptance criteria`);
  c.issues.set(title, id);
}

Given("an issue {string} in {string} whose acceptance criteria are {string} and {string}", async function (title: string, repo: string, a: string, b: string) {
  await issue(this, title, repo, [a, b]);
});

Given("an issue {string} in {string} whose acceptance criteria are {string}", async function (title: string, repo: string, a: string) {
  await issue(this, title, repo, [a]);
});

async function changeCriteria(world: object, criteria: string[]): Promise<void> {
  const c = ctx(world);
  const id = c.issues.get(primary(c))!;
  const item = await c.board.adapter.getItem(id);
  assert.ok(item, `the board has no issue ${id}`);
  await c.board.seed({ ...item, externalId: id, acceptanceCriteria: criteria });
}

Given("the issue's acceptance criteria were then changed to {string} and {string}", async function (a: string, b: string) {
  await changeCriteria(this, [a, b]);
});

Given("the issue's acceptance criteria were then changed to {string}", async function (a: string) {
  await changeCriteria(this, [a]);
});

Given("{string} holds {string} and {string} at commit {string}", function (_repo: string, a: string, b: string, sha: string) {
  hold(ctx(this), a, sha);
  hold(ctx(this), b, sha);
});

Given("{string} holds {string} at commit {string}", function (_repo: string, path: string, sha: string) {
  hold(ctx(this), path, sha);
});

Given("{string} holds {string} at commit {string} and at commit {string}", function (_repo: string, path: string, x: string, y: string) {
  for (const sha of [x, y]) hold(ctx(this), path, sha);
});

Given("{string} holds {string} and {string} at commit {string} and at commit {string}", function (_repo: string, a: string, b: string, x: string, y: string) {
  for (const sha of [x, y]) for (const path of [a, b]) hold(ctx(this), path, sha);
});

Given("{string} holds {string} at commit {string}, with a scenario tagged @ac-1 named {string}", function (_repo: string, path: string, sha: string, name: string) {
  hold(ctx(this), path, sha, `@pbi-224\nFeature: Paying\n\n  @ac-1\n  Scenario: ${name}\n    Given a customer at the checkout\n`);
});

Given("{string} holds a changed {string} and a new {string} at commit {string}", function (_repo: string, changed: string, added: string, sha: string) {
  hold(ctx(this), changed, sha, textOf(changed, sha, ", changed"));
  hold(ctx(this), added, sha);
});

Given("{string} at commit {string} in {string} now reads differently", function (path: string, sha: string, _repo: string) {
  const c = ctx(this);
  hold(c, path, sha, `${heldText(c, path, sha)}\n# Edited after the fact.\n`);
});

/** Every file the repo holds, as `{ sha, path }`. */
function heldFiles(c: Ctx): { sha: string; path: string }[] {
  const prefix = `${c.repo}@`;
  return [...c.files.files.keys()].filter((k) => k.startsWith(prefix)).map((k) => {
    const rest = k.slice(prefix.length);
    const at = rest.indexOf(":");
    return { sha: rest.slice(0, at), path: rest.slice(at + 1) };
  });
}

Given("the repo stops answering every read", async function () {
  const c = ctx(this);
  assert.ok(c.repo, "no repo was set up");
  c.down = true;
  const file = heldFiles(c)[0] ?? { sha: "HEAD", path: "features/none.feature" };
  await assert.rejects(async () => c.host.readFile(c.repo!, file.sha, file.path), "the repo still answers reads of files");
  await assert.rejects(async () => c.backlog.getItem(c.issues.get(primary(c))!), "the board still answers reads");
});

Given("the repo refuses every read of {string}", async function (path: string) {
  const c = ctx(this);
  const held = heldFiles(c).filter((f) => f.path === path);
  assert.ok(held.length > 0, `the repo holds no ${path}, so refusing it tests nothing`);
  c.refused.add(path);
  for (const f of held) await assert.rejects(async () => c.host.readFile(c.repo!, f.sha, path), `the repo still answers reads of ${path} at ${f.sha}`);
});

When("the repo answers reads again", async function () {
  const c = ctx(this);
  c.down = false;
  c.refused.clear();
  for (const f of heldFiles(c)) {
    assert.equal(await c.host.readFile(c.repo!, f.sha, f.path), heldText(c, f.path, f.sha), `the repo doesn't answer a read of ${f.path} at ${f.sha}`);
  }
  assert.ok(await c.backlog.getItem(c.issues.get(primary(c))!), "the board doesn't answer reads");
});

// ---- the factory's items, runs and cells ----

async function newItem(c: Ctx, title: string, state: string): Promise<string> {
  const externalId = c.issues.get(title);
  assert.ok(externalId, `no issue "${title}" was set up`);
  const id = (await pool().query<{ id: string }>(
    "insert into item (source_id, external_id, title, state, repo) values ($1, $2, $3, $4, $5) returning id",
    [c.sourceId, externalId, title, state, c.repo])).rows[0].id;
  c.items.set(title, id);
  return id;
}

/** Claims `title`'s item as claimNext does, and hands its cell the run token for the new generation. */
async function claim(c: Ctx, title: string): Promise<Cell> {
  const itemId = c.items.get(title);
  assert.ok(itemId, `the factory doesn't hold "${title}"`);
  const cell = await withTx(pool(), async (tx) => {
    await transitionItem(tx, itemId, "claimed", { actor: "system", actorId: "pbi-224" });
    const generation = (await tx.query<{ g: number }>(
      "update item set lease_generation = lease_generation + 1, lease_owner = 'cell-pbi-224', lease_expires = $2 where id = $1 returning lease_generation as g",
      [itemId, new Date(Date.now() + LEASE_MS)])).rows[0].g;
    const open = (await tx.query<{ id: string }>("select id from run where item_id = $1 and ended_at is null order by started_at desc limit 1", [itemId])).rows[0];
    const runId = open?.id ?? (await tx.query<{ id: string }>(
      `insert into run (item_id, run_number, next_stage, repo_id, sop_version, config_sha)
       values ($1, 1, 'specify', $2, 'default@1', 'cfg224') returning id`, [itemId, c.repoId])).rows[0].id;
    return { runId, generation, token: runToken(SECRET, runId, generation) };
  });
  c.runs.set(title, cell.runId);
  c.cells.set(title, cell);
  return cell;
}

Given("the factory holds {string} in progress, with a cell working on its run", long, async function (title: string) {
  const c = ctx(this);
  await newItem(c, title, "Queued");
  await claim(c, title);
});

Given("the factory holds {string} and {string} in progress, each with a cell working on its run", long, async function (a: string, b: string) {
  const c = ctx(this);
  for (const title of [a, b]) {
    await newItem(c, title, "Queued");
    await claim(c, title);
  }
});

/** The owner asks for changes at sign-off, and the run is claimed again for the changes round. */
async function changesRound(c: Ctx, title: string): Promise<void> {
  const itemId = c.items.get(title)!;
  const user = (await pool().query<{ id: string }>(
    `insert into "user" (issuer, subject, github_login, role, product_owner) values ('http://pbi-224.test', 'po', 'pbi-224-po', 'owner', true)
     on conflict (github_login) do update set product_owner = true returning id`)).rows[0].id;
  const outcome = await withTx(pool(), (tx) => decide(tx, { itemId, userId: user, kind: "changes", text: "Say more about declines.", via: "dashboard" }));
  assert.equal(outcome, "applied", `the owner's request for changes was ${outcome}`);
  await claim(c, title);
}

Given("the owner asked for changes to the scenarios", long, async function () {
  const c = ctx(this);
  await changesRound(c, primary(c));
});

async function report(world: object, title: string, sha: string, files: string[]): Promise<Report> {
  const c = ctx(world);
  const itemId = c.items.get(title);
  assert.ok(itemId, `the factory doesn't hold "${title}"`);
  const state = (await pool().query<{ state: string }>("select state from item where id = $1", [itemId])).rows[0].state;
  if (state === "SignOff") await changesRound(c, title);
  const cell = c.cells.get(title);
  assert.ok(cell && c.server, "no cell is working on the run");
  for (const path of files) {
    const text = c.files.files.get(`${c.repo}@${sha}:${path}`);
    if (text !== undefined) c.reported.set(path, text);
  }
  const r = await fetch(`http://127.0.0.1:${(c.server.address() as AddressInfo).port}/internal/cells/${cell.runId}/transition`, {
    method: "POST",
    headers: { authorization: `Bearer ${cell.token}`, "content-type": "application/json" },
    body: JSON.stringify({ event: "scenarios_written", scenariosSha: sha, lockedFiles: files, question: { kind: "sign_off", body: "Scenarios for sign-off" } }),
  });
  const got = { status: r.status, body: await r.text() };
  c.reports.push(got);
  return got;
}

async function reported(world: object, title: string, sha: string, files: string[]): Promise<void> {
  const r = await report(world, title, sha, files);
  assert.equal(r.status, 200, `the cell API answered ${r.status} to the report: ${r.body}`);
}

Given("the cell has reported its scenarios written at commit {string}, locking {string} and {string}", long, async function (sha: string, a: string, b: string) {
  await reported(this, primary(ctx(this)), sha, [a, b]);
});

Given("the cell has reported its scenarios written at commit {string}, locking {string}", long, async function (sha: string, a: string) {
  await reported(this, primary(ctx(this)), sha, [a]);
});

Given("the cell on {string} has reported its scenarios written at commit {string}, locking {string}", long, async function (title: string, sha: string, a: string) {
  await reported(this, title, sha, [a]);
});

When("the cell reports its scenarios written at commit {string}, locking {string} and {string}", long, async function (sha: string, a: string, b: string) {
  await report(this, primary(ctx(this)), sha, [a, b]);
});

When("the cell reports its scenarios written at commit {string}, locking {string}", long, async function (sha: string, a: string) {
  await report(this, primary(ctx(this)), sha, [a]);
});

When("the cell reports its scenarios written at commit {string}, locking no files", long, async function (sha: string) {
  await report(this, primary(ctx(this)), sha, []);
});

When("the cell on {string} reports its scenarios written at commit {string}, locking {string}", long, async function (title: string, sha: string, a: string) {
  // The scenario's Then steps look only at the other run, so a refused report would pass it untested: it must land.
  await reported(this, title, sha, [a]);
});

// ---- runs from before snapshots ----

async function earlierRun(world: object, title: string, sha: string | null, files: string[]): Promise<void> {
  const c = ctx(world);
  const itemId = await newItem(c, title, sha ? "SignOff" : "NeedsInput");
  const runId = (await pool().query<{ id: string }>(
    `insert into run (item_id, run_number, next_stage, repo_id, sop_version, config_sha, scenarios_sha, locked_files)
     values ($1, 1, $2, $3, 'default@1', 'cfg224', $4, $5) returning id`,
    [itemId, sha ? "sign-off" : "understand", c.repoId, sha, sha ? files : null])).rows[0].id;
  c.runs.set(title, runId);
}

Given("a run of {string} that recorded scenarios sha {string}, locking {string} and {string}, before snapshots were stored", long, async function (title: string, sha: string, a: string, b: string) {
  await earlierRun(this, title, sha, [a, b]);
});

Given("a run of {string} that recorded scenarios sha {string}, locking {string}, before snapshots were stored", long, async function (title: string, sha: string, a: string) {
  await earlierRun(this, title, sha, [a]);
});

Given("a run of {string} that never recorded a scenarios sha", long, async function (title: string) {
  await earlierRun(this, title, null, []);
});

// ---- the backfill ----

async function backfill(world: object): Promise<void> {
  const c = ctx(world);
  const mod = await load<BackfillModule>("src/worker/snapshot-backfill.ts");
  assert.ok(mod?.backfillSnapshots, "src/worker/snapshot-backfill.ts has no backfillSnapshots");
  if (c.backfills.length === 0) for (const [key, text] of c.files.files) c.firstBackfill.set(key, text);
  c.backfills.push(await mod.backfillSnapshots({ pool: pool(), repoHost: c.host, backlogFor: () => c.backlog }));
}

When("the operator runs the snapshot backfill", long, async function () {
  await backfill(this);
});

When("the operator runs the snapshot backfill again", long, async function () {
  await backfill(this);
});

Given("the operator has run the snapshot backfill once", long, async function () {
  await backfill(this);
});

// ---- Run detail ----

When("the owner opens Run detail for {string}", long, async function (title: string) {
  const c = ctx(this);
  const itemId = c.items.get(title);
  assert.ok(itemId, `the factory doesn't hold "${title}"`);
  const p = p284ctx(this);
  await startIssuer(p);
  p.audience = AUDIENCE;
  await pool().query(`insert into "user" (issuer, subject, github_login, role, product_owner) values ($1, $2, $2, 'owner', true)`, [p.issuerUrl, OWNER]);
  const token = await validToken(p, OWNER);
  const mod = await load<ApiModule>("src/api/main.ts");
  assert.ok(mod?.startApi, "src/api/main.ts has no startApi");
  const port = await freePort();
  c.api = await mod.startApi({ pool: pool(), issuer: p.issuerUrl, audience: AUDIENCE, webhookSecret: "pbi-224-webhook-secret", readBlob: async () => null, env: {} }, port);
  const r = await fetch(`http://127.0.0.1:${port}/v1/items/${itemId}`, { headers: { authorization: `Bearer ${token}` } });
  const text = await r.text();
  assert.equal(r.status, 200, `Run detail answered ${r.status}: ${text}`);
  c.detail = JSON.parse(text) as Detail;
});

function detail(c: Ctx): Detail {
  assert.ok(c.detail, "the owner didn't open Run detail");
  return c.detail;
}

Then("Run detail lists the criterion {string} with the scenario {string} under it", function (criterion: string, scenario: string) {
  const criteria = detail(ctx(this)).criteria;
  assert.ok(criteria, "Run detail lists no criteria");
  const found = criteria.find((k) => k.criterion === criterion);
  assert.ok(found, `Run detail lists the criteria ${JSON.stringify(criteria.map((k) => k.criterion))}`);
  assert.ok(found.scenarios.some((s) => s.name === scenario), `under "${criterion}" Run detail lists ${JSON.stringify(found.scenarios)}`);
});

Then("Run detail shows the text of {string} at commit {string}", function (path: string, sha: string) {
  const c = ctx(this);
  const shown = detail(c).pending.find((f) => f.path === path);
  assert.ok(shown, `Run detail shows the files ${JSON.stringify(detail(c).pending.map((f) => f.path))}`);
  assert.equal(shown.text, heldText(c, path, sha));
});

Then("Run detail offers the owner the Sign off form", function () {
  const d = detail(ctx(this));
  assert.equal(d.question?.kind, "sign_off", `Run detail's open question is ${JSON.stringify(d.question)}`);
  assert.ok(d.pending.length > 0, "Run detail has no scenarios up for sign-off, so it shows no Sign off form");
});

// ---- the stored snapshot ----

async function stored(runId: string): Promise<{ criteria: string[] | null; files: { path: string; sha: string; text: string }[] }> {
  const criteria = (await pool().query<{ acceptance_criteria: string[] | null }>("select acceptance_criteria from run where id = $1", [runId])).rows[0].acceptance_criteria;
  const files = (await pool().query<{ path: string; sha: string; text: string }>("select path, sha, text from run_file where run_id = $1 order by path", [runId])).rows;
  return { criteria, files };
}

async function criteriaAre(runId: string, want: string[]): Promise<void> {
  assert.deepEqual((await stored(runId)).criteria, want, "the run's stored acceptance criteria");
}

async function filesAre(runId: string, paths: string[], sha: string): Promise<void> {
  const got = (await stored(runId)).files.map((f) => [f.path, f.sha]);
  assert.deepEqual(got, [...paths].sort().map((p) => [p, sha]), "the run's stored files");
}

async function fileText(runId: string, path: string): Promise<string> {
  const file = (await stored(runId)).files.find((f) => f.path === path);
  assert.ok(file, `the run stores no file ${path}`);
  return file.text;
}

Then("the run's stored acceptance criteria are {string} and {string}, in that order", async function (a: string, b: string) {
  await criteriaAre(runOf(ctx(this), primary(ctx(this))), [a, b]);
});

Then("the run's stored acceptance criteria are still {string} and {string}", async function (a: string, b: string) {
  await criteriaAre(runOf(ctx(this), primary(ctx(this))), [a, b]);
});

Then("the run's stored files are {string} and {string}, each at commit {string}", async function (a: string, b: string, sha: string) {
  await filesAre(runOf(ctx(this), primary(ctx(this))), [a, b], sha);
});

Then("the run's stored files are {string}, at commit {string}", async function (a: string, sha: string) {
  await filesAre(runOf(ctx(this), primary(ctx(this))), [a], sha);
});

Then("each stored file's text is that file's text in {string} at commit {string}", async function (_repo: string, sha: string) {
  const c = ctx(this);
  const files = (await stored(runOf(c, primary(c)))).files;
  assert.ok(files.length > 0, "the run stores no files");
  for (const f of files) assert.equal(f.text, heldText(c, f.path, sha), `the stored text of ${f.path}`);
});

Then("the stored text of {string} is its changed text at commit {string}", async function (path: string, sha: string) {
  const c = ctx(this);
  assert.equal(await fileText(runOf(c, primary(c)), path), heldText(c, path, sha));
});

Then("the run has no stored file {string}", async function (path: string) {
  const c = ctx(this);
  const paths = (await stored(runOf(c, primary(c)))).files.map((f) => f.path);
  assert.ok(!paths.includes(path), `the run still stores ${path}`);
});

Then("the run of {string} still stores {string} at commit {string}", async function (title: string, path: string, sha: string) {
  await filesAre(runOf(ctx(this), title), [path], sha);
});

Then("the run of {string} still stores the acceptance criterion {string}", async function (title: string, criterion: string) {
  await criteriaAre(runOf(ctx(this), title), [criterion]);
});

Then("the cell API refuses the report", function () {
  const last = ctx(this).reports.at(-1);
  assert.ok(last, "the cell sent no report");
  assert.equal(last.status, 400, `the cell API answered ${last.status}: ${last.body}`);
});

Then("the run of {string} stores the acceptance criteria {string} and {string}, in that order", async function (title: string, a: string, b: string) {
  await criteriaAre(runOf(ctx(this), title), [a, b]);
});

Then("the run of {string} stores {string} and {string}, each at commit {string}, with their text in {string} at that commit", async function (title: string, a: string, b: string, sha: string, _repo: string) {
  const c = ctx(this);
  const runId = runOf(c, title);
  await filesAre(runId, [a, b], sha);
  for (const path of [a, b]) assert.equal(await fileText(runId, path), heldText(c, path, sha), `the stored text of ${path}`);
});

Then("the run of {string} stores {string} at commit {string}", async function (title: string, path: string, sha: string) {
  await filesAre(runOf(ctx(this), title), [path], sha);
});

Then("the run of {string} stores {string} at commit {string}, with its text in {string} at that commit", async function (title: string, path: string, sha: string, _repo: string) {
  const c = ctx(this);
  const runId = runOf(c, title);
  await filesAre(runId, [path], sha);
  assert.equal(await fileText(runId, path), heldText(c, path, sha));
});

Then("the run of {string} stores no acceptance criteria and no files", async function (title: string) {
  const s = await stored(runOf(ctx(this), title));
  assert.equal(s.criteria, null, `the run stores the criteria ${JSON.stringify(s.criteria)}`);
  assert.deepEqual(s.files.map((f) => f.path), [], "the run stores files");
});

Then("the stored text of {string} is still the text it had when the cell reported its scenarios", async function (path: string) {
  const c = ctx(this);
  const then = c.reported.get(path);
  assert.ok(then !== undefined, `the cell never reported ${path}`);
  assert.equal(await fileText(runOf(c, primary(c)), path), then);
});

Then("the stored text of {string} is still the text the first backfill stored", async function (path: string) {
  const c = ctx(this);
  const runId = runOf(c, primary(c));
  const sha = (await pool().query<{ scenarios_sha: string }>("select scenarios_sha from run where id = $1", [runId])).rows[0].scenarios_sha;
  const then = c.firstBackfill.get(`${c.repo}@${sha}:${path}`);
  assert.ok(then !== undefined, `the repo held no ${path} at ${sha} when the first backfill ran`);
  assert.equal(await fileText(runId, path), then);
});

Then("the second backfill reports that it filled no runs", function () {
  const second = ctx(this).backfills[1];
  assert.ok(second, "the backfill didn't run twice");
  assert.deepEqual(second.filled, [], "the second backfill filled runs");
});

Then("the backfill reports that it couldn't fill the run of {string}", function (title: string) {
  const c = ctx(this);
  const last = c.backfills.at(-1);
  assert.ok(last, "the backfill didn't run");
  const runId = runOf(c, title);
  assert.ok(last.unfilled.some((u) => u.runId === runId), `the backfill's unfilled runs are ${JSON.stringify(last.unfilled)}`);
  assert.ok(!last.filled.includes(runId), "the backfill reports it filled the run");
});
