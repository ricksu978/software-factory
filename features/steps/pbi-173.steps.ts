// Step definitions for features/pbi-173-sop-move-on-resume.feature. The SOP in the cell image is the real
// sop/default.yml, at 0.2.0. A cell's run is its start up to the first stage: it reads its context, settles its SOP
// through resumeOnImageSop, as src/cell/main.ts does, and reports the stage it runs. The stage's agent work is out of
// scope, so a stage that "passes" is reported passed straight away.
//
// The @db scenarios run on PBI 4's shared test database: the real scheduler tick claims and pins, with a recording
// launcher, and the cell reaches the real cell API over HTTP with the RUN_TOKEN the tick handed it. The dashboard is
// the real one on a free port. The other scenarios need no Postgres: their claim and cell API are an in-memory run,
// whose SOP lookup knows only the image's SOP, as a cell image does.
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fakeBacklog, fakeRepoHost } from "../../src/adapters/fake.ts";
import { httpCellApi } from "../../src/cell/api-client.ts";
import type { CellContext } from "../../src/cell/engine.ts";
import { resumeOnImageSop, SOP_MOVED, type SopMoveApi } from "../../src/cell/sop-move.ts";
import { loadSop, stageAfter, type Sop } from "../../src/config/sop.ts";
import { cellApi, runToken } from "../../src/control/cell-api.ts";
import { decide } from "../../src/control/decisions.ts";
import { createAuth } from "../../src/http/auth.ts";
import { dashboardRoutes } from "../../src/http/routes.ts";
import { startServer } from "../../src/http/server.ts";
import { tick } from "../../src/scheduler/scheduler.ts";
import { withTx } from "../../src/store/db.ts";
import { transitionItem } from "../../src/store/items.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";

const SOP: Sop = loadSop(readFileSync(join(process.cwd(), "sop/default.yml"), "utf8"));
const REPO = "acme/widgets";
const EXT = "482";
const SECRET = "pbi-173-secret";
const HEAD = "c0ffee0";
const decode = (html: string) => html.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const text = (html: string) => decode(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

/** What a step reads back about the item and its run, from whichever side holds them. */
type Seen = {
  state: string; sopVersion: string | null; configSha: string | null; nextStage: string | null;
  /** Bodies of the needs_input questions still open, newest first. */
  open: string[];
  /** Questions asked after the owner's answer. */
  askedAfterAnswer: number;
  /** Stage attempts recorded on the run, in order. */
  stages: string[];
};

/** One side of a scenario: the in-memory run, or the database and the real control plane. */
type Side = {
  run(o: { sopVersion: string | null; stage: string; configSha: string | null }): Promise<void>;
  needsInput(question: string): Promise<void>;
  answer(text: string): Promise<void>;
  claim(): Promise<void>;
  /** The cell's API and its context, for the claim the last tick made. */
  cell(): Promise<{ api: SopMoveApi & { stage(b: { stageId: string; attempt: number; status: "started" | "passed" }): Promise<void> }; ctx: CellContext }>;
  /** Ends the current claim and puts the run back in the queue at `stage`. */
  requeueAt(stage: string): Promise<void>;
  seen(): Promise<Seen>;
  close(): Promise<void>;
};

type Ctx = { side?: Side; passes: Set<string>; ran: string[]; page?: string; status?: number };

function ctx(world: object): Ctx {
  const w = world as { pbi173?: Ctx };
  w.pbi173 ??= { passes: new Set(), ran: [] };
  return w.pbi173;
}

const side = (world: object): Side => {
  const s = ctx(world).side;
  assert.ok(s, "the scenario set up no run");
  return s;
};

// ---- the in-memory side ----

function memorySide(): Side {
  type Q = { body: string; answer: string | null; afterAnswer: boolean };
  const m = {
    state: "Queued", sopVersion: null as string | null, configSha: null as string | null, nextStage: "understand",
    questions: [] as Q[], stages: [] as string[], answered: false, claimed: false,
  };
  const api = {
    async transition(b: Parameters<SopMoveApi["transition"]>[0]) {
      assert.ok(m.claimed, "the cell called the cell API without a claim");
      if (b.event !== "blocked") throw new Error(`the in-memory cell API takes only blocked, not ${b.event}`);
      m.questions.push({ body: b.question?.body ?? "", answer: null, afterAnswer: m.answered });
      m.state = "NeedsInput";
      m.claimed = false;
    },
    async moveSop(b: { from: string; to: string }) {
      assert.ok(m.claimed, "the cell called the cell API without a claim");
      assert.equal(b.from, m.sopVersion, "the move names a version the run isn't pinned to");
      m.sopVersion = b.to;
    },
    async stage(b: { stageId: string; attempt: number; status: "started" | "passed" }) {
      if (b.status === "started") m.stages.push(b.stageId);
      // Only the image's SOP is known here, as in a cell image.
      if (b.status === "passed" && m.sopVersion === SOP.version) m.nextStage = stageAfter(SOP, b.stageId) ?? m.nextStage;
    },
  };
  return {
    async run(o) {
      m.sopVersion = o.sopVersion;
      m.nextStage = o.stage;
      m.configSha = o.configSha;
    },
    async needsInput(question) {
      m.state = "NeedsInput";
      m.questions.push({ body: question, answer: null, afterAnswer: false });
    },
    async answer(t) {
      for (const q of m.questions) q.answer ??= t;
      m.answered = true;
    },
    async claim() {
      const waiting = m.state === "NeedsInput" && m.questions.every((q) => q.answer !== null);
      assert.ok(m.state === "Queued" || waiting, `item ${EXT} is ${m.state} and can't be claimed`);
      m.state = "InProgress";
      m.claimed = true;
      if (m.configSha === null) {
        m.configSha = HEAD;
        m.sopVersion = SOP.version;
      }
    },
    async cell() {
      const ctx = {
        externalId: EXT, title: `item ${EXT}`, acceptanceCriteria: ["it works"], nextStage: m.nextStage, decision: null, lockSha: null,
        lockedFiles: [], prNumber: null, repo: REPO, base: "main", branch: `factory/pbi-${EXT}-r1`, configSha: m.configSha!,
        sopVersion: m.sopVersion!, dodVerdicts: [], dodCheckedSha: null, scenarioNotes: [], trustedComments: [], stageAttempts: {}, resume: null,
      } satisfies CellContext;
      return { api, ctx };
    },
    async requeueAt(stage) {
      m.state = "Queued";
      m.claimed = false;
      m.nextStage = stage;
    },
    async seen() {
      return {
        state: m.state, sopVersion: m.sopVersion, configSha: m.configSha, nextStage: m.nextStage,
        open: m.questions.filter((q) => q.answer === null).map((q) => q.body).reverse(),
        askedAfterAnswer: m.questions.filter((q) => q.afterAnswer).length, stages: [...m.stages],
      };
    },
    async close() {},
  };
}

// ---- the database side ----

async function dbSide(): Promise<Side & { itemId(): string; dashboard(path: string): Promise<{ status: number; page: string }> }> {
  const pool = need().pool;
  const backlog = fakeBacklog();
  await backlog.seed({ externalId: EXT, repo: REPO });
  const host = fakeRepoHost();
  host.heads.set(REPO, HEAD);
  const repoId = (await pool.query<{ id: string }>("insert into repo (host_adapter, url) values ('github', $1) returning id", [`https://github.com/${REPO}`])).rows[0].id;
  const sourceId = (await pool.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'pbi-173:' || gen_random_uuid()) returning id")).rows[0].id;
  const itemId = (await pool.query<{ id: string }>(
    "insert into item (source_id, external_id, title, state, backlog_rank) values ($1, $2, $3, 'Queued', 1) returning id",
    [sourceId, EXT, `item ${EXT}`],
  )).rows[0].id;
  let started: Record<string, string>[] = [];
  let answeredAt: Date | null = null;
  const servers: Server[] = [];
  const closers: (() => Promise<void>)[] = [];
  const serve = async (handler: Parameters<typeof startServer>[0][number]) => {
    const s = await startServer([handler], { port: 0 });
    servers.push(s);
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  };
  let cellBase: string | undefined;
  let dashBase: string | undefined;

  return {
    itemId: () => itemId,
    async run(o) {
      await pool.query(
        "insert into run (item_id, run_number, next_stage, branch, repo_id, config_sha, sop_version) values ($1, 1, $2, $3, $4, $5, $6)",
        [itemId, o.stage, `factory/pbi-${EXT}-r1`, o.configSha === null ? null : repoId, o.configSha, o.sopVersion],
      );
    },
    async needsInput(question) {
      await pool.query("update item set state = 'NeedsInput' where id = $1", [itemId]);
      await pool.query("insert into question (item_id, kind, body) values ($1, 'needs_input', $2)", [itemId, question]);
    },
    async answer(t) {
      const owner = (await pool.query<{ id: string }>(
        `insert into "user" (provider, subject, github_login, role, product_owner) values ('microsoft', 'pbi-173-owner', 'pbi-173-owner', 'owner', true) returning id`,
      )).rows[0].id;
      const outcome = await withTx(pool, (c) => decide(c, { itemId, userId: owner, kind: "answer", text: t, via: "dashboard" }));
      assert.equal(outcome, "applied", `the owner's answer was ${outcome}`);
      answeredAt = (await pool.query<{ now: Date }>("select clock_timestamp() as now")).rows[0].now;
    },
    async claim() {
      started = [];
      await tick({
        pool, now: new Date(), killFlag: false, repoHost: host, backlogFor: () => backlog.adapter, secret: SECRET,
        controlUrl: "http://control.test:7400", sopVersion: SOP.version,
        launcher: { start: async (env) => (started.push(env), `exec-${started.length}`), stop: async () => {} },
      });
      assert.equal(started.length, 1, `the tick started ${started.length} cells, not one for item ${EXT}`);
    },
    async cell() {
      const env = started.at(-1);
      assert.ok(env, "no claim started a cell");
      cellBase ??= await serve(cellApi({
        pool, secret: SECRET, repoHost: host, backlogFor: () => backlog.adapter,
        // Only the image's SOP is known, as in a cell image.
        stageAfter: (version, stageId) => (version === SOP.version ? stageAfter(SOP, stageId) : null),
        uploadUrl: async (path) => `http://blob.test/${path}`, gateway: { upstream: "http://model.test", ownerToken: () => "unused" },
        webToolsOf: () => [],
      }));
      const api = httpCellApi({ controlUrl: cellBase, runId: env.RUN_ID, runToken: runToken(SECRET, env.RUN_ID, Number(env.GENERATION)), generation: Number(env.GENERATION) });
      const stage = async (b: { stageId: string; attempt: number; status: "started" | "passed" }) =>
        api.stage({ ...b, model: SOP.models.coding, tokensIn: 0, tokensOut: 0, costUsd: 0 });
      return { api: { transition: api.transition, moveSop: api.moveSop, stage }, ctx: await api.context() };
    },
    async requeueAt(stage) {
      await withTx(pool, async (c) => {
        await c.query("update run set next_stage = $2 where item_id = $1 and ended_at is null", [itemId, stage]);
        const { state } = (await c.query<{ state: string }>("select state from item where id = $1", [itemId])).rows[0];
        if (state === "InProgress") {
          await transitionItem(c, itemId, "lease_expired", { actor: "system", actorId: "pbi-173" });
        } else {
          // The first claim's cell didn't carry on, so the run is put back in the queue as the scenario has it.
          await c.query("update question set closed_at = now() where item_id = $1 and answer is null and closed_at is null", [itemId]);
          await c.query("update item set state = 'Queued', lease_owner = null, lease_expires = null where id = $1", [itemId]);
        }
      });
    },
    async seen() {
      const item = (await pool.query<{ state: string }>("select state from item where id = $1", [itemId])).rows[0];
      const run = (await pool.query<{ id: string; sop_version: string | null; config_sha: string | null; next_stage: string | null }>(
        "select id, sop_version, config_sha, next_stage from run where item_id = $1 order by run_number desc, started_at desc limit 1", [itemId],
      )).rows[0];
      const open = (await pool.query<{ body: string }>(
        "select body from question where item_id = $1 and kind = 'needs_input' and answer is null and closed_at is null order by asked_at desc", [itemId],
      )).rows.map((r) => r.body);
      const after = answeredAt
        ? Number((await pool.query<{ n: string }>("select count(*) as n from question where item_id = $1 and asked_at > $2", [itemId, answeredAt])).rows[0].n)
        : 0;
      const stages = run ? (await pool.query<{ stage_id: string }>("select stage_id from stage_run where run_id = $1 order by started_at", [run.id])).rows.map((r) => r.stage_id) : [];
      return {
        state: item.state, sopVersion: run?.sop_version ?? null, configSha: run?.config_sha ?? null, nextStage: run?.next_stage ?? null,
        open, askedAfterAnswer: after, stages,
      };
    },
    async dashboard(path) {
      if (!dashBase) {
        let handler: ReturnType<typeof dashboardRoutes> | undefined;
        dashBase = await serve((req, res) => handler!(req, res));
        handler = dashboardRoutes({ pool, auth: createAuth({ mode: "azure" }), origin: dashBase, adapter: backlog.adapter, sourceId });
        closers.push(() => handler!.close());
      }
      await pool.query(
        `insert into "user" (provider, subject, github_login, role) values ('microsoft', 'pbi-173-viewer', 'pbi-173-viewer', 'viewer')
         on conflict (provider, subject) do nothing`,
      );
      const r = await fetch(`${dashBase}${path}`, {
        headers: { "x-ms-client-principal-idp": "aad", "x-ms-client-principal-id": "pbi-173-viewer", "x-ms-client-principal-name": "pbi-173-viewer" },
        redirect: "manual",
      });
      return { status: r.status, page: await r.text() };
    },
    async close() {
      for (const c of closers) await c();
      for (const s of servers) {
        s.closeAllConnections();
        await new Promise<void>((resolve) => s.close(() => resolve()));
      }
    },
  };
}

type DbSide = Awaited<ReturnType<typeof dbSide>>;
const db = (world: object): DbSide => {
  const s = side(world) as Partial<DbSide>;
  assert.ok(s.itemId, "this step needs the database side, so its scenario must be tagged @db");
  return s as DbSide;
};

Before({ tags: "@pbi-173 and not @db" }, function () {
  ctx(this).side = memorySide();
});

Before({ tags: "@pbi-173 and @db", ...long }, async function () {
  const d = await testDb();
  assert.ok(d, "src/store/test-db.ts doesn't exist");
  await d.pool.query(`truncate item, event, "user", backlog_source, repo, override cascade`);
  await d.pool.query("update wip_policy set mode = 'fixed', current_wip = 1, review_capacity = 3, usage_paused_until = null");
  ctx(this).side = await dbSide();
});

After({ tags: "@pbi-173", ...long }, async function () {
  await ctx(this).side?.close();
});

/** The cell's start up to its first stage, as src/cell/main.ts runs it. */
async function cellRuns(world: object): Promise<void> {
  const c = ctx(world);
  const { api, ctx: context } = await side(world).cell();
  const run = await resumeOnImageSop(api, context, SOP);
  if (!run) return;
  const stageId = run.nextStage;
  const attempt = (run.stageAttempts[stageId] ?? 0) + 1;
  await api.stage({ stageId, attempt, status: "started" });
  c.ran.push(stageId);
  if (c.passes.has(stageId)) await api.stage({ stageId, attempt, status: "passed" });
}

// ---- Given ----

Given("a run for item 482 pinned to SOP {word} that resumes at {word}", long, async function (version: string, stage: string) {
  await side(this).run({ sopVersion: version, stage, configSha: HEAD });
});

Given("a run for item 482 pinned to SOP {word} and to config commit {string} that resumes at {word}", long, async function (version: string, sha: string, stage: string) {
  await side(this).run({ sopVersion: version, stage, configSha: sha });
});

Given("a fresh run for item 482 that has never been claimed", long, async function () {
  await side(this).run({ sopVersion: null, stage: "understand", configSha: null });
});

Given("green passes", function () {
  const stage = "green";
  ctx(this).passes.add(stage);
});

Given("SOP {word} has no {word} stage", function (version: string, stage: string) {
  assert.equal(SOP.version, version, `the cell image holds SOP ${SOP.version}, not ${version}`);
  assert.ok(!SOP.stages.some((s) => s.id === stage), `SOP ${version} has a ${stage} stage`);
});

Given("item 482 is in NeedsInput with the question {string}", long, async function (question: string) {
  await side(this).needsInput(question);
});

Given("the factory has claimed the run and its cell has run", long, async function () {
  await side(this).claim();
  await cellRuns(this);
});

Given("the run is claimed again at {word}", long, async function (stage: string) {
  await side(this).requeueAt(stage);
  await side(this).claim();
});

// ---- When ----

When("the factory claims the run and its cell runs", long, async function () {
  await side(this).claim();
  await cellRuns(this);
});

When("the factory claims the run", long, async function () {
  await side(this).claim();
});

When("its cell runs", long, async function () {
  await cellRuns(this);
});

When("the owner answers the question", long, async function () {
  await side(this).answer("");
});

When("the owner answers the question with {string}", long, async function (answer: string) {
  await side(this).answer(answer);
});

When("a viewer opens the item's run detail", long, async function () {
  const s = db(this);
  const r = await s.dashboard(`/items/${s.itemId()}`);
  Object.assign(ctx(this), r);
});

/** True in a PBI 173 scenario. PBI 105's and PBI 152's steps of the same text hand those scenarios to the two below. */
export const isPbi173 = (world: object): boolean => (world as { pbi173?: Ctx }).pbi173?.side !== undefined;

/** PBI 105's "a viewer opens the activity log", in a PBI 173 scenario. */
export async function openActivityLog(world: object): Promise<void> {
  const r = await db(world).dashboard("/activity");
  Object.assign(ctx(world), r);
}

// ---- Then ----

Then("the cell runs the {word} stage", long, async function (stage: string) {
  const seen = await side(this).seen();
  assert.deepEqual(ctx(this).ran, [stage], `the cell ran ${JSON.stringify(ctx(this).ran)}; open questions: ${JSON.stringify(seen.open)}`);
  assert.deepEqual(seen.stages, [stage], `the run recorded the stages ${JSON.stringify(seen.stages)}`);
});

Then("the run records SOP version {word}", long, async function (version: string) {
  assert.equal((await side(this).seen()).sopVersion, version);
});

Then("the run still records SOP version {word}", long, async function (version: string) {
  assert.equal((await side(this).seen()).sopVersion, version);
});

/** PBI 152's "the owner is asked no question", in a PBI 173 scenario. */
export async function ownerAskedNoQuestion(world: object): Promise<void> {
  assert.deepEqual((await side(world).seen()).open, [], "the owner has an open question");
}

Then("the owner is asked no further question", long, async function () {
  const seen = await side(this).seen();
  assert.equal(seen.askedAfterAnswer, 0, `the factory asked ${seen.askedAfterAnswer} more questions: ${JSON.stringify(seen.open)}`);
  assert.deepEqual(seen.open, [], "the owner has an open question");
});

Then("item 482 is not in NeedsInput", long, async function () {
  assert.notEqual((await side(this).seen()).state, "NeedsInput");
});

Then("item 482 moves to NeedsInput", long, async function () {
  assert.equal((await side(this).seen()).state, "NeedsInput");
});

Then("the question names the stage {string}", long, async function (stage: string) {
  const [question] = (await side(this).seen()).open;
  assert.ok(question !== undefined, "the owner has no open question");
  assert.ok(question.includes(stage), `the question doesn't name ${stage}: ${question}`);
});

Then("the question says SOP {word} has no such stage", long, async function (version: string) {
  const [question] = (await side(this).seen()).open;
  assert.ok(question !== undefined, "the owner has no open question");
  assert.ok(question.includes(version), `the question doesn't name SOP ${version}: ${question}`);
  assert.match(question, /has no|lacks|doesn't have|does not have|missing/i, `the question doesn't say the stage is missing: ${question}`);
});

Then("no stage runs", long, async function () {
  assert.deepEqual(ctx(this).ran, [], "the cell ran a stage");
  assert.deepEqual((await side(this).seen()).stages, [], "the run recorded a stage");
});

Then("the run's next stage is {word}, the stage after {word} in SOP {word}", long, async function (next: string, stage: string, version: string) {
  assert.equal(SOP.version, version);
  assert.equal(stageAfter(SOP, stage), next, `SOP ${version} doesn't put ${next} after ${stage}`);
  const seen = await side(this).seen();
  assert.deepEqual(ctx(this).ran, [stage], `the cell ran ${JSON.stringify(ctx(this).ran)}, not ${stage}`);
  assert.equal(seen.nextStage, next);
});

Then("the run is still pinned to config commit {string}", long, async function (sha: string) {
  assert.equal((await side(this).seen()).configSha, sha);
});

/** The value of the run detail's "SOP version" entry. */
function shownSop(c: Ctx): string {
  assert.equal(c.status, 200, `run detail answered ${c.status}: ${c.page?.slice(0, 300)}`);
  const m = /<dt>\s*SOP version\s*<\/dt>\s*<dd>([\s\S]*?)<\/dd>/i.exec(c.page ?? "");
  assert.ok(m, "run detail shows no SOP version");
  return text(m[1]);
}

Then("run detail shows SOP version {string}", function (version: string) {
  assert.equal(shownSop(ctx(this)), version);
});

Then("run detail does not show SOP version {string} as the version in use", function (version: string) {
  assert.notEqual(shownSop(ctx(this)), version);
});

async function moves(world: object): Promise<{ actor: string; from: string | null; to: string | null }[]> {
  return (await need().pool.query<{ actor: string; from: string | null; to: string | null }>(
    "select actor, payload->>'from' as \"from\", payload->>'to' as \"to\" from event where item_id = $1 and kind = $2 order by at, id",
    [db(world).itemId(), SOP_MOVED],
  )).rows;
}

Then("item 482 has a system event recording the run's move from SOP {word} to SOP {word}", long, async function (from: string, to: string) {
  const found = await moves(this);
  assert.ok(found.some((e) => e.actor === "system" && e.from === from && e.to === to),
    `item ${EXT} has no system ${SOP_MOVED} event from ${from} to ${to}: ${JSON.stringify(found)}`);
});

Then("item 482 has exactly one system event recording a move of SOP version", long, async function () {
  const found = await moves(this);
  assert.equal(found.filter((e) => e.actor === "system").length, 1, `item ${EXT} has these ${SOP_MOVED} events: ${JSON.stringify(found)}`);
  assert.equal(found.length, 1, `item ${EXT} has these ${SOP_MOVED} events: ${JSON.stringify(found)}`);
});

Then("item 482 has no system event recording a move of SOP version", long, async function () {
  assert.deepEqual(await moves(this), []);
});

Then("the activity log lists the SOP move for item 482", function () {
  const c = ctx(this);
  assert.equal(c.status, 200, `the activity log answered ${c.status}: ${c.page?.slice(0, 300)}`);
  const rows = [...(c.page ?? "").matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => text(m[1])).filter((r) => r.includes(SOP_MOVED));
  assert.ok(rows.some((r) => r.includes(EXT) && r.includes("0.1.0") && r.includes("0.2.0")),
    `the activity log has no ${SOP_MOVED} row for item ${EXT} from 0.1.0 to 0.2.0: ${JSON.stringify(rows)}`);
});
