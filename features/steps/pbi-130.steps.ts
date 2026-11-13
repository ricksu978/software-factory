// Step definitions for PBI 130's two feature files.
//
// features/pbi-130-pr-review-after-address.feature runs the engine through PBI 18's harness, resuming at address, with
// PBI 128's fake repo host and scripted PR reviewer and PR addresser. The person's thread is `PT-1`, in the repo host's
// review threads and in the cell's trusted comments, as the control plane hands it to an address run. The PR stays #57.
//
// features/pbi-130-own-threads-never-address.feature runs the real poller and the real webhook handler over PBI 4's
// shared database, on PBI 12's harness: its fake board and fake repo host, and its InReview item with an open PR. The
// factory's threads open with a comment by the trusted bot; people's replies go into the same thread. The address run
// asks the real cell API for its context through PBI 28's steps, once this file's BeforeStep hook has claimed the run.
import { After, AfterStep, Before, BeforeStep, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type pg from "pg";
import { setUp, type Ctx as CellCtx } from "./pbi-18.steps.ts";
import {
  ctx as pr128, done, newPass, posted, reviewerCall, stageReports, that,
} from "./pbi-128.steps.ts";
import { ctx as pbi12, polled, REPO as REPO12 } from "./pbi-12.steps.ts";
import { ctx as pbi28 } from "./pbi-28.steps.ts";
import { load, long, need, testDb } from "./pbi-8.steps.ts";

// ---- the PR review after address ----

const PR = 57;
const PERSON = "owner";

function cell(world: object): CellCtx {
  const w = world as { pbi18?: CellCtx };
  assert.ok(w.pbi18, "no run was set up");
  return w.pbi18;
}

Given("a run for item {int} whose PR is in review", function (_item: number) {
  const run = setUp(this, "address", true);
  run.prNumber = PR;
});

Given("a trusted person's thread {string} on line {int} of {string} sent the item back to address", function (body: string, line: number, path: string) {
  const run = cell(this);
  const c = pr128(this);
  const threadId = `PT-${c.personThreads.length + 1}`;
  const key = `acme/app#${PR}`;
  const list = c.host.reviewComments.get(key) ?? [];
  list.push({ threadId, path, line, author: PERSON, body, submittedAt: new Date(Date.now() - 3_600_000).toISOString() });
  c.host.reviewComments.set(key, list);
  c.personThreads.push({ threadId, body });
  c.last = null;
  const trustedComments = [...((run.context?.trustedComments as unknown[]) ?? []), { threadId, path, line, author: PERSON, body }];
  run.context = { ...run.context, trustedComments };
});

function person(world: object): string {
  const p = pr128(world).personThreads[0];
  assert.ok(p, "no person's thread was set up");
  return p.body;
}

Given("the PR addresser fixes the person's thread with a new commit", function () {
  newPass(pr128(this)).actions.set(person(this), { kind: "fix" });
});

Given("the PR addresser fixes the person's thread with a new commit on each attempt", function () {
  pr128(this).fixPersonEachTime.add(person(this));
});

Given("CI fails on the addresser's first fix and passes on its second", function () {
  pr128(this).ci.addresserFirstFails = true;
});

Given("the PR addresser fixes that finding with a new commit", function () {
  const c = pr128(this);
  newPass(c).actions.set(that(c), { kind: "fix" });
});

function addresserSha(c: ReturnType<typeof pr128>, n: number): string {
  const sha = c.addresserShas[n - 1];
  assert.ok(sha, `the PR addresser made ${c.addresserShas.length} commits, so it has no commit ${n}`);
  return sha;
}

function namesHead(r: { head: string; prompt: string }, sha: string, which: string) {
  assert.equal(r.head, sha, `the PR reviewer ran at ${r.head}, not at ${which} ${sha}`);
  assert.ok(r.prompt.includes(sha), `the PR reviewer's brief doesn't name ${which} ${sha}`);
}

Then("the PR reviewer's brief names the addresser's new commit as the head to review", function () {
  const { c } = done(this);
  namesHead(reviewerCall(c, 1), addresserSha(c, 1), "the addresser's new commit");
});

Then("the PR reviewer's brief names the addresser's second fix as the head to review", function () {
  const { c } = done(this);
  namesHead(reviewerCall(c, 1), addresserSha(c, 2), "the addresser's second fix");
});

Then("the PR reviewer's second brief names the addresser's newest commit as the head to review", function () {
  const { c } = done(this);
  const r = reviewerCall(c, 2);
  assert.ok(c.addresserShas.length >= 2, `the PR addresser made ${c.addresserShas.length} commits`);
  namesHead(r, c.addresserShas.at(-1)!, "the addresser's newest commit");
});

Then("the factory posted one review on the PR, at the addresser's new commit", function () {
  const { c } = done(this);
  const all = posted(c);
  assert.equal(all.length, 1, `the factory posted ${all.length} reviews on the PR`);
  assert.equal(all[0].commitSha, addresserSha(c, 1));
});

Then("the PR reviewer's brief doesn't hold {string} as one of its own threads", function (body: string) {
  const { c } = done(this);
  const p = c.personThreads.find((x) => x.body === body);
  assert.ok(p, `no person's thread "${body}"`);
  const r = reviewerCall(c, 1);
  assert.ok(!r.prompt.includes(p.threadId) && !r.prompt.includes(body), `the PR reviewer's brief holds the person's thread ${p.threadId}`);
});

Then("the factory didn't resolve the thread {string}", function (body: string) {
  const { c } = done(this);
  const p = c.personThreads.find((x) => x.body === body);
  assert.ok(p, `no person's thread "${body}"`);
  assert.ok(!c.host.resolvedThreads.some((r) => r.threadId === p.threadId), "the factory resolved the person's thread");
});

Then("the item never moved to InReview before the PR review stage passed", function () {
  const { run } = done(this);
  const passed = stageReports(run, "pr-review").find((x) => x.body.status === "passed");
  assert.ok(passed, "the PR review stage never passed");
  const early = run.calls.map((x, i) => ({ ...x, i })).filter((x) => x.route === "/transition" && x.body.event === "pr_opened" && x.i < passed.i);
  assert.deepEqual(early.map((x) => x.i), [], "the item moved to InReview before the PR review stage passed");
});

// ---- the factory's own threads and the poller and webhook ----

type Thread = { threadId: string; path: string; line: number; author: string; body: string; submittedAt: string };
type Own = { bot: string; threads: Map<string, string>; last: string | null; seq: number; server?: Server; claimed?: boolean };

const REPO_URL = `https://github.com/${REPO12}`;
const WEBHOOK_SECRET = "pbi-130-webhook-secret";
const CELL_SECRET = "pbi-130-cell-secret";

function own(world: object): Own {
  const w = world as { pbi130?: Own };
  w.pbi130 ??= { bot: "factory[bot]", threads: new Map(), last: null, seq: 0 };
  return w.pbi130;
}

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function addComment(world: object, t: Thread) {
  const c = pbi12(world);
  if (!c.host || !c.pr) return;
  const key = `${REPO12}#${c.pr}`;
  c.host.reviewComments.set(key, [...(c.host.reviewComments.get(key) ?? []), t]);
}

function openThread(world: object, author: string, body: string, minutesAgo = 30): string {
  const o = own(world);
  const threadId = `thread-${++o.seq}`;
  addComment(world, { threadId, path: "src/totals.ts", line: 10 + o.seq, author, body, submittedAt: ago(minutesAgo) });
  return threadId;
}

function factoryThread(world: object, bot: string, body: string) {
  const o = own(world);
  const threadId = openThread(world, bot, body);
  o.threads.set(body, threadId);
  o.last = threadId;
}

function reply(world: object, login: string, body: string, threadId: string) {
  addComment(world, { threadId, path: "src/totals.ts", line: 1, author: login, body, submittedAt: ago(10) });
}

Before({ tags: "@pbi-130 and @db", ...long }, async function () {
  const d = await testDb();
  if (d) await d.pool.query('truncate item, backlog_source, repo, "user" cascade');
});

After({ tags: "@pbi-130 and @db" }, async function () {
  const s = (this as { pbi130?: Own }).pbi130?.server ?? pbi28(this).server;
  if (s) await new Promise((r) => s.close(r));
});

Given("the repo's trusted bot is {string}", long, async function (login: string) {
  own(this).bot = login;
  const c = pbi12(this);
  if (!c.sourceId) return;
  const pool = need().pool;
  await pool.query("update repo set trusted_bot = $2 where url = $1", [REPO_URL, login]);
  // The webhook finds the item through its run's repo, so the run names it.
  await pool.query(
    `update run set repo_id = (select id from repo where url = $1)
     where item_id in (select id from item where source_id = $2) and ended_at is null`,
    [REPO_URL, c.sourceId],
  );
});

Given("the repo's trusted bot is instead stored as {string}", long, async function (login: string) {
  if (!pbi12(this).sourceId) return;
  await need().pool.query("update repo set trusted_bot = $2 where url = $1", [REPO_URL, login]);
});

Given("{string} is an allowlisted user", long, async function (login: string) {
  if (!(await testDb())) return;
  await need().pool.query(`insert into "user" (provider, subject, github_login, role) values ('dev', $1, $1, 'owner')`, [login]);
});

Given("the factory's own review left an open thread {string} on the item's PR", function (body: string) {
  factoryThread(this, own(this).bot, body);
});

Given("{string}'s review left an open thread {string} on the item's PR", function (bot: string, body: string) {
  factoryThread(this, bot, body);
});

Given("the factory's own review left open threads {string} and {string} on the item's PR", function (a: string, b: string) {
  factoryThread(this, own(this).bot, a);
  factoryThread(this, own(this).bot, b);
});

Given("{string} replied {string} inside that thread", function (login: string, body: string) {
  const o = own(this);
  assert.ok(o.last, "no thread was named before this step");
  reply(this, login, body, o.last);
});

Given("{string} replied {string} inside the thread {string}", function (login: string, body: string, thread: string) {
  const threadId = own(this).threads.get(thread);
  assert.ok(threadId, `the factory left no thread "${thread}"`);
  reply(this, login, body, threadId);
});

Given("{string} opened a thread of their own, {string}, on the item's PR", function (login: string, body: string) {
  openThread(this, login, body, 5);
});

type Webhook = {
  handleWebhook: (deps: { pool: pg.Pool; secret: string; parse: (h: Record<string, string>, b: unknown) => unknown }, req: { headers: Record<string, string>; rawBody: Buffer }) => Promise<{ status: number }>;
};
type Parser = { parseGitHubWebhook: (h: Record<string, string>, b: unknown) => unknown };

When("GitHub delivers octo's reply to the webhook as a review that only comments", long, async function () {
  const c = pbi12(this);
  const [hook, gh] = await Promise.all([load<Webhook>("src/watcher/webhook.ts"), load<Parser>("src/adapters/github/backlog.ts")]);
  if (!hook || !gh || !c.pr) return;
  const raw = Buffer.from(JSON.stringify({
    action: "submitted", repository: { full_name: REPO12 }, pull_request: { number: c.pr },
    review: { id: 9001, state: "commented", body: "", submitted_at: ago(10), user: { login: "octo", type: "User" } },
    sender: { login: "octo", type: "User" },
  }));
  const r = await hook.handleWebhook({ pool: need().pool, secret: WEBHOOK_SECRET, parse: gh.parseGitHubWebhook }, {
    rawBody: raw,
    headers: {
      "content-type": "application/json", "x-github-event": "pull_request_review", "x-github-delivery": randomUUID(),
      "x-hub-signature-256": `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex")}`,
    },
  });
  assert.equal(r.status, 204, "the webhook didn't take the delivery");
});

Then("the item's run doesn't resume from {string}", long, async function (stage: string) {
  const c = pbi12(this);
  polled(c);
  const r = await need().pool.query<{ next_stage: string | null }>(
    "select r.next_stage from run r join item i on i.id = r.item_id where i.source_id = $1 and i.external_id = $2 and r.ended_at is null",
    [c.sourceId, c.extIds[0]],
  );
  assert.equal(r.rows.length, 1, "the item has no open run");
  assert.notEqual(r.rows[0].next_stage, stage);
});

// PBI 28's "the address run asks for its context" asks the real cell API as the claimed address run. Here the run is
// claimed after the poll, as the scheduler would, and the cell API is served over the poller's fake board and host.
// Once the context is read, the claim's lease runs out, so the item goes back to Queued with its run's next stage as
// the poller left it, and the Thens read the state the poll left.
const CONTEXT_STEP = "the address run asks for its context";
type Mods = {
  cellApi: { runToken: (secret: string, runId: string, generation: number) => string; cellApi: (deps: object) => unknown };
  server: { startServer: (handlers: unknown[], opts: { port: number }) => Promise<Server> };
  items: {
    claimNext: (c: pg.PoolClient, owner: string, now: Date) => Promise<{ runId: string; generation: number } | null>;
    expireLeases: (c: pg.PoolClient, now: Date) => Promise<string[]>;
  };
  db: { withTx: <T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>) => Promise<T> };
};

BeforeStep({ tags: "@pbi-130 and @db", ...long }, async function ({ pickleStep }) {
  if (pickleStep.text !== CONTEXT_STEP) return;
  const c = pbi12(this);
  const d = await testDb();
  const [cellApi, server, items, db] = await Promise.all([
    load<Mods["cellApi"]>("src/control/cell-api.ts"), load<Mods["server"]>("src/http/server.ts"),
    load<Mods["items"]>("src/store/items.ts"), load<Mods["db"]>("src/store/db.ts"),
  ]);
  if (!d || !cellApi || !server || !items || !db || !c.fake || !c.host) return;
  const claim = await db.withTx(d.pool, (client) => items.claimNext(client, "cell-a", new Date()));
  if (!claim) return; // nothing went to address, so the address run gets no context and its Thens say so
  await d.pool.query(
    "update run set repo_id = (select id from repo where url = $2), sop_version = 'default@1', config_sha = 'cfg1234' where id = $1",
    [claim.runId, REPO_URL],
  );
  const fake = c.fake;
  const api = cellApi.cellApi({
    pool: d.pool, secret: CELL_SECRET, repoHost: c.host, backlogFor: () => fake.adapter, stageAfter: () => null,
    uploadUrl: async (path: string) => path, gateway: { upstream: "http://127.0.0.1:1", ownerToken: () => "owner-secret" }, webToolsOf: () => [],
  });
  const p28 = pbi28(this);
  p28.server = await server.startServer([api], { port: 0 });
  own(this).server = p28.server;
  own(this).claimed = true;
  p28.run = { runId: claim.runId, token: cellApi.runToken(CELL_SECRET, claim.runId, claim.generation) };
});

AfterStep({ tags: "@pbi-130 and @db", ...long }, async function ({ pickleStep }) {
  if (pickleStep.text !== CONTEXT_STEP || !own(this).claimed) return;
  const [items, db] = await Promise.all([load<Mods["items"]>("src/store/items.ts"), load<Mods["db"]>("src/store/db.ts")]);
  if (!items || !db) return;
  await db.withTx(need().pool, (client) => items.expireLeases(client, new Date(Date.now() + 24 * 3_600_000)));
});
