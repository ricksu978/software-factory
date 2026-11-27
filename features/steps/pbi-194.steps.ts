// Step definitions for features/pbi-194-merged-pr-while-needs-input.feature. The @db scenarios reuse PBI 12's poller
// harness and PBI 142's "the factory holds an item in state ... whose open run has PR" setup, and read Floor and the
// item's Run detail from the orchestrator API on the same database, as the SPA's pages do, through
// features/support/split-services.ts. The cell scenarios reuse PBI 18's engine
// harness through PBI 152's "a run for item ... that resumes at address", with the fake repo host holding the run's PR as a person merged it.
import { After, Before, BeforeStep, Given, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { fakeRepoHost } from "../../src/adapters/fake.ts";
import { apiApp } from "../../src/api/main.ts";
import type { FloorData, ItemData } from "../../web/src/api.ts";
import { callApi, TEST_AUDIENCE, TEST_ISSUER, testBearer } from "../support/split-services.ts";
import { load, long, need, testDb } from "./pbi-8.steps.ts";
import { ctx as pollCtx, poll, polled } from "./pbi-12.steps.ts";
import { lastAttempt } from "./pbi-142.steps.ts";
import { cellPr } from "./pbi-212.steps.ts";
import type { Ctx as CellCtx } from "./pbi-18.steps.ts";
import { isPbi259, reportsNoMove } from "./pbi-259.steps.ts";

type Host = ReturnType<typeof fakeRepoHost>;
type Ctx = { replies: unknown[]; api?: ReturnType<typeof apiApp>; stepType?: string };

function ctx(world: object): Ctx {
  const w = world as { pbi194?: Ctx };
  w.pbi194 ??= { replies: [] };
  return w.pbi194;
}

function cell(world: object): CellCtx {
  const w = world as { pbi18?: CellCtx };
  assert.ok(w.pbi18, "no run was set up");
  return w.pbi18;
}

const BRANCH = "factory/pbi-482-r1";
const CELL_REPO = "acme/app";
const pool = () => need().pool;

Before({ tags: "@pbi-194 and @db", ...long }, async function () {
  const d = await testDb();
  if (d) await d.pool.query('truncate item, event, backlog_source, repo, "user" cascade');
});

After({ tags: "@pbi-194 or @pbi-262", ...long }, async function () {
  const s = (this as { pbi194?: Ctx }).pbi194;
  if (!s) return;
  await s.api?.close();
  s.api = undefined;
});

// PBI 262 says "the item has no open question" as a Given too, where it sets the item up rather than checks it.
BeforeStep({ tags: "@pbi-194 or @pbi-262" }, function ({ pickleStep }) {
  ctx(this).stepType = pickleStep.type;
});

// ---- the poller ----

async function itemId(world: object): Promise<string> {
  const c = pollCtx(world);
  const r = await pool().query<{ id: string }>("select id from item where source_id = $1 and external_id = $2", [c.sourceId, c.extIds[0]]);
  assert.ok(r.rows[0], "the factory holds no item");
  return r.rows[0].id;
}

function prOf(world: object, n: number) {
  const found = pollCtx(world).host?.prs.find((p) => p.number === n);
  assert.ok(found, `the repo host has no PR ${n}`);
  return found;
}

/**
 * The item began waiting after its PR opened, in the factory's own PR review, so its run's resume pointer stands at
 * pr-review. Only a poll that sends the item to address moves it there.
 */
async function waitingAfterPrOpened(world: object): Promise<void> {
  await pool().query("update run set next_stage = 'pr-review' where item_id = $1 and ended_at is null", [await itemId(world)]);
}

Given("the item waits on an open question {string}", long, async function (body: string) {
  await pool().query("insert into question (item_id, kind, body, asked_at) values ($1, 'needs_input', $2, now() - interval '30 minutes')", [await itemId(this), body]);
});

Given("PR {int} is still open", long, async function (n: number) {
  // PBI 212's cell scenarios say it of the cell's repo host, with no poller set up.
  if ((this as { pbi18?: unknown }).pbi18 && !(this as { pbi12?: unknown }).pbi12) return void cellPr(this, n);
  Object.assign(prOf(this, n), { open: true, merged: false, mergeSha: null, mergeable: true });
  await waitingAfterPrOpened(this);
});

Given("PR {int} is still open and conflicts with main", long, async function (n: number) {
  Object.assign(prOf(this, n), { open: true, merged: false, mergeSha: null, mergeable: false });
  await waitingAfterPrOpened(this);
});

Given("{string} requested changes on PR {int} after the item began waiting", function (login: string, n: number) {
  // The run's reviews were last seen an hour ago, so a review from ten minutes ago is newer, and it has a body.
  prOf(this, n).reviews.push({ state: "changes_requested", submittedAt: new Date(Date.now() - 10 * 60_000).toISOString(), author: login, body: "Please rename this." });
});

async function question(world: object, body: string): Promise<{ answer: string | null; closed_at: Date | null }> {
  polled(pollCtx(world));
  const r = await pool().query<{ answer: string | null; closed_at: Date | null }>(
    "select answer, closed_at from question where item_id = $1 and body = $2", [await itemId(world), body],
  );
  assert.equal(r.rows.length, 1, `the item has ${r.rows.length} questions "${body}"`);
  return r.rows[0];
}

Then("the item has no open question", long, async function () {
  if (ctx(this).stepType === "Context") {
    await pool().query("delete from question where item_id = $1 and answer is null and closed_at is null", [await itemId(this)]);
    return;
  }
  polled(pollCtx(this));
  const r = await pool().query<{ body: string }>("select body from question where item_id = $1 and answer is null and closed_at is null", [await itemId(this)]);
  assert.deepEqual(r.rows.map((q) => q.body), [], "the item still has an open question");
});

Then("the question {string} is closed without an answer", long, async function (body: string) {
  const q = await question(this, body);
  assert.equal(q.answer, null, "the question has an answer");
  assert.notEqual(q.closed_at, null, "the question is still open");
});

Then("the question {string} is still open", long, async function (body: string) {
  const q = await question(this, body);
  assert.equal(q.answer, null, "the question has an answer");
  assert.equal(q.closed_at, null, "the question was closed");
});

// ---- the dashboard ----

/** What the API answers a viewer for `path`, as JSON. */
async function read<T>(world: object, path: string): Promise<T> {
  const c = ctx(world);
  if (!c.api) {
    await pool().query(
      `insert into "user" (issuer, subject, github_login, role) values ($1, 'viewer', 'viewer', 'viewer') on conflict on constraint user_issuer_subject do nothing`,
      [TEST_ISSUER],
    );
    c.api = apiApp({
      pool: pool(), issuer: TEST_ISSUER, audience: TEST_AUDIENCE, webhookSecret: "pbi-194", readBlob: async () => null, env: {}, verify: testBearer,
    });
  }
  const r = await callApi(c.api.app, pool(), "viewer", "GET", path);
  assert.equal(r.status, 200, `${path} answered ${r.status}: ${r.text.slice(0, 300)}`);
  return r.json as T;
}

/** Floor's sections by the heading the SPA's Floor gives them. */
const SECTIONS: Record<string, keyof FloorData> = { "Waiting on you": "waiting", "Next up": "next", "Not ready": "notReady" };

Then("{string} on the dashboard doesn't list the item", long, async function (name: string) {
  polled(pollCtx(this));
  const id = await itemId(this);
  const key = SECTIONS[name];
  assert.ok(key, `Floor has no "${name}" section`);
  const listed = (await read<FloorData>(this, "/v1/floor"))[key] as { id: string; title: string }[];
  assert.ok(!listed.some((i) => i.id === id), `"${name}" lists the item: ${JSON.stringify(listed)}`);
});

Then("the item's page asks for no answer", long, async function () {
  polled(pollCtx(this));
  const id = await itemId(this);
  const detail = await read<ItemData>(this, `/v1/items/${id}`);
  // Run detail shows its Answer form only for an open question of kind needs_input.
  assert.notEqual(detail.question?.kind, "needs_input", `the item's page asks for an answer: ${JSON.stringify(detail.question)}`);
});

// ---- the cell ----

Given("a trusted reviewer asked for changes on the run's PR {int}", function (n: number) {
  const run = cell(this);
  run.prNumber = n;
  run.trusted = [{ author: "owner", body: "Please rename the variable." }];
});

Given("no trusted review text waits on the run's PR {int}", function (n: number) {
  const run = cell(this);
  run.prNumber = n;
  run.trusted = [];
});

Given("PR {int} is one a person has already merged", async function (n: number) {
  const run = cell(this);
  const mine = ctx(this);
  const mod = await load<{ fakeRepoHost: () => Host }>("src/adapters/fake.ts");
  assert.ok(mod, "the fake repo host doesn't exist");
  const host = mod.fakeRepoHost();
  host.prs.push({
    number: n, repo: CELL_REPO, branch: BRANCH, base: "main", title: "Item 482", body: "the merged PR", headSha: null, open: false,
    merged: true, mergeSha: "m57", mergeable: null, reviewers: [], comments: [],
    reviews: [{ state: "changes_requested", submittedAt: new Date(Date.now() - 3_600_000).toISOString(), author: "owner", body: "Please rename the variable." }],
  });
  run.prNumber = n;
  // The fake itself, so whatever the engine asks about the PR it answers from the merged one. Each reply or PR comment
  // is recorded as well, so the Thens can tell whether one was posted.
  run.repoHost = new Proxy(host, {
    get(target, key, receiver) {
      if (key === "replyToThread") return async (...a: [string, string, string]) => { mine.replies.push(a); };
      if (key === "commentOnPr") return async (...a: [string, number, string]) => { mine.replies.push(a); return target.commentOnPr(...a); };
      return Reflect.get(target, key, receiver);
    },
  }) as unknown as Record<string, unknown>;
});

function transitions(c: CellCtx): Record<string, any>[] {
  return c.calls.filter((x) => x.route === "/transition").map((x) => x.body);
}

Then("the address stage's last attempt ends failed", function () {
  const last = lastAttempt(this, "address");
  assert.equal(last.status, "failed", `the last address report is ${last.status}, attempt ${last.attempt}`);
});

Then("the item doesn't move to NeedsInput", function () {
  const blocked = transitions(cell(this)).filter((t) => t.event === "blocked");
  assert.deepEqual(blocked, [], "the item moved to NeedsInput");
});

Then("no reply is posted on PR {int}", function (n: number) {
  assert.deepEqual(ctx(this).replies, [], `a reply was posted on PR ${n}`);
  // PBI 258: with PBI 128's repo host in place, neither a reply in a thread nor a comment on the PR itself.
  const host = (this as { pbi128?: { host: Host } }).pbi128?.host;
  if (!host) return;
  const pr = host.prs.find((p) => p.number === n);
  assert.deepEqual(pr?.comments ?? [], [], `a comment was posted on PR ${n}`);
  const all = [...host.reviewComments.values()].flat();
  const replies = all.filter((x, i) => x.author === "factory[bot]" && all.findIndex((y) => y.threadId === x.threadId) !== i);
  assert.deepEqual(replies.map((x) => x.body), [], `a reply was posted on PR ${n}`);
});

Then("the cell reports no move for the item", function () {
  if (isPbi259(this)) return reportsNoMove(this);
  const c = cell(this);
  assert.equal(c.error, null, `the cell failed: ${String(c.error)}`);
  assert.deepEqual(transitions(c).map((t) => t.event), [], "the cell reported a move for the item");
});
