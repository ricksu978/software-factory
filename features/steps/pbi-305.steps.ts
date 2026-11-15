// Step definitions for features/pbi-305-no-review-text-requeue.feature.
//
// Every scenario runs on PBI 4's test database with PBI 12's poller harness: a fake board, a fake repo host and the
// real pollOnce. PBI 260's steps supply the rest, reading the items these steps register in its context: "the item
// stopped at the address stage", "the scheduler runs once", "the poller has run once", the Hold and release, the
// question steps ("is answered by the factory", "is still open", "is answered exactly once", "nobody answered ... in
// person"), "the event's actor is the system", and the dashboard's. PBI 12's "the poller runs once" and "the item's
// run resumes from", PBI 142's "the poller runs twice" and PBI 168's "the factory holds item ... in state" read the
// same harness.
//
// The contract these steps set up, which the poller reads:
// - Each item is a board item labelled "factory" in "acme/widgets", held in NeedsInput with an open run stopped at
//   address whose PR is open in the fake repo host, on base "main". Its open needs_input question carries the body
//   the scenario names. "octo" is a user, so an allowlisted login; "stranger" isn't. The repo's trusted bot is
//   "factory[bot]", which starts the factory's own review threads.
// - A PR's mergeability is the fake PR's `mergeable`: false conflicts, true merges cleanly, null isn't worked out yet.
//   A review asking for changes is a `changes_requested` review with a body; an open-thread comment is an unresolved
//   `reviewComments` entry with its `submittedAt`, as prState reads them.
// - The factory's answer leaves `answered_by` null. After a conflict it names the PR, says it conflicts, and names the
//   base; after a review it says a trusted review asked for changes on the PR and names the review's time. The
//   re-queue is one event of kind REQUEUED_FOR_ADDRESS, by the system, on the item, whose payload holds `questionId`,
//   `prNumber`, `reason` ("conflict" or "review"), and `at`, the review's time, for a review.
// - "While the poller is reading PR 58" is the poller's prState call for that PR.
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { decide } from "../../src/control/decisions.ts";
import { withTx } from "../../src/store/db.ts";
import { REQUEUED_FOR_ADDRESS } from "../../src/watcher/poller.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";
import { ctx as pollCtx, poll, polled, setup, type Ctx as PollCtx } from "./pbi-12.steps.ts";
import { ctx as dashCtx } from "./pbi-175.steps.ts";
import { db as baseFailDb } from "./pbi-215.steps.ts";
import { ctx as base260 } from "./pbi-260.steps.ts";

const REPO = "acme/widgets";
const BOT = "factory[bot]";
const pool = () => need().pool;

type Ctx = {
  /** Each item's PR number, by item number. */
  prs: Map<number, number>;
  owner?: string;
};

function ctx(world: object): Ctx {
  const w = world as { pbi305?: Ctx };
  w.pbi305 ??= { prs: new Map() };
  return w.pbi305;
}

Before({ tags: "@pbi-305 and @db", ...long }, async function () {
  const d = await testDb();
  if (!d) return;
  await d.pool.query('truncate item, event, backlog_source, repo, "user", override cascade');
  await d.pool.query("update wip_policy set mode = 'fixed', current_wip = 2, review_capacity = 3, usage_paused_until = null");
});

After({ tags: "@pbi-305", ...long }, async function () {
  // PBI 175's dashboard closes its server only in its own scenarios.
  const s = (this as { pbi175?: { server?: Server; close?: () => Promise<void> } }).pbi175;
  if (!s) return;
  await s.close?.();
  if (s.server) {
    s.server.closeAllConnections();
    await new Promise<void>((resolve) => s.server!.close(() => resolve()));
  }
});

// ---- the items ----

async function harness(world: object): Promise<PollCtx> {
  const c = pollCtx(world);
  assert.ok(await setup(c), "the poller's fakes or database aren't available");
  const known = await pool().query("select 1 from repo where lower(url) = lower($1)", [`https://github.com/${REPO}`]);
  if (known.rowCount === 0) await pool().query("insert into repo (host_adapter, url, trusted_bot) values ('fake', $1, $2)", [`https://github.com/${REPO}`, BOT]);
  // "octo" is allowlisted, signed in as the dashboard steps sign people in, so either step may come first.
  await pool().query(
    `insert into "user" (provider, subject, github_login, role) values ('microsoft', 'octo', 'octo', 'viewer') on conflict (provider, subject) do nothing`,
  );
  return c;
}

type BaseFailure = { sha: string; tests: string[]; base: string };

async function waits(world: object, n: number, body: string, opts: { askedAt?: string; pr?: number; repo?: string; baseFailure?: BaseFailure } = {}): Promise<void> {
  const repo = opts.repo ?? REPO;
  assert.equal(repo, REPO, `the scenarios' PRs are all in ${REPO}`);
  const prNumber = opts.pr ?? 57;
  const c = await harness(world);
  const m = base260(world);
  const ext = String(n);
  const branch = `factory/pbi-${n}-r1`;
  await c.fake!.seed({ externalId: ext, title: `Item ${n}`, labels: ["factory"], repo });
  c.host!.prs.push({
    number: prNumber, repo, branch, base: "main", title: `Item ${n}`, body: "b", headSha: `head-${n}`, open: true, merged: false,
    mergeSha: null, mergeable: true, reviewers: [], comments: [], reviews: [],
  });
  const id = (await pool().query<{ id: string }>(
    "insert into item (source_id, external_id, title, state, repo) values ($1, $2, $3, 'NeedsInput', $4) returning id",
    [c.sourceId, ext, `Item ${n}`, repo],
  )).rows[0].id;
  // A run stopped at address has been claimed before, so its repo and config commit are already pinned.
  await pool().query(
    `insert into run (item_id, run_number, next_stage, branch, pr_number, pr_url, reviews_seen_at, repo_id, config_sha)
     values ($1, 1, 'address', $2, $3, $4, coalesce($6::timestamptz, now()) - interval '7 days', (select id from repo where lower(url) = lower($5)), 'c1')`,
    // Dated from the question when it has a date, so a fixed date never falls behind the real clock.
    [id, branch, prNumber, `https://github.com/${repo}/pull/${prNumber}`, `https://github.com/${repo}`, opts.askedAt ?? null],
  );
  const question = (await pool().query<{ id: string }>(
    `insert into question (item_id, kind, body, asked_at, base_failure)
     values ($1, 'needs_input', $2, coalesce($3::timestamptz, now() - interval '30 minutes'), $4) returning id`,
    [id, body, opts.askedAt ?? null, opts.baseFailure ? JSON.stringify(opts.baseFailure) : null],
  )).rows[0].id;
  if (opts.baseFailure) {
    const key = `${repo}@${opts.baseFailure.base}`;
    const list = c.host!.branches.get(key) ?? [];
    if (!list.includes(opts.baseFailure.sha)) list.push(opts.baseFailure.sha);
    c.host!.branches.set(key, list);
  }
  c.extIds.push(ext);
  m.items.set(n, { id, question });
  ctx(world).prs.set(n, prNumber);
  baseFailDb(world).items.set(n, id);
  dashCtx(world).sourceId ??= c.sourceId;
  // The factory has been polling all along, so the item has seen a poll before the scenario's own.
  await poll(c);
  polled(c);
}

Given("item {int} waits in NeedsInput on the question {string}", long, async function (n: number, body: string) {
  await waits(this, n, body);
});

Given("item {int} waits in NeedsInput on the question {string}, asked at {string}", long, async function (n: number, body: string, at: string) {
  await waits(this, n, body, { askedAt: at });
  // The scheduler runs a day after the question, short of its 2-day reminder and 5-day timeout, whatever today is.
  base260(this).now = new Date(Date.parse(at) + 24 * 60 * 60 * 1000);
});

Given(
  "item {int} waits in NeedsInput on the question {string}, with PR {int} in {string}",
  long,
  async function (n: number, body: string, pr: number, repo: string) {
    await waits(this, n, body, { pr, repo });
  },
);

Given("item {int} waits in NeedsInput on a question saying the base fails in the cell at commit {string}", long, async function (n: number, sha: string) {
  const body = `The base fails in the cell. The Definition of Done line "Unit tests pass." fails on the base commit ${sha}, origin/main, `
    + `as it does on this item's branch, so the item isn't at fault. Failing tests:\n- parses the config`;
  await waits(this, n, body, { baseFailure: { sha, tests: ["parses the config"], base: "main" } });
});

Given("CI still fails on the newest commit of {string}", function (base: string) {
  const c = pollCtx(this);
  assert.ok(c.host, "the poller's fake repo host isn't set up");
  const key = `${REPO}@${base}`;
  const list = c.host.branches.get(key) ?? [];
  assert.ok(list.length > 0, `${key} holds no base-failure commit for the newest commit to follow`);
  const newest = "b4se-newest";
  list.push(newest);
  c.host.branches.set(key, list);
  c.host.checks.set(`${REPO}@${newest}`, "failure");
  assert.equal(c.host.branches.get(key)!.at(-1), newest, `${newest} isn't the newest commit of ${key}`);
  assert.equal(c.host.checks.get(`${REPO}@${newest}`), "failure", `CI on ${newest} isn't failing`);
});

// ---- the PR on GitHub ----

function prOf(world: object, n: number) {
  const c = pollCtx(world);
  const found = c.host?.prs.find((p) => p.repo === REPO && p.number === n);
  assert.ok(found, `no PR ${n} in ${REPO}`);
  return found;
}

Given("GitHub reports PR {int} as conflicting with its base", function (n: number) {
  prOf(this, n).mergeable = false;
});

Given("GitHub reports PR {int} as merging cleanly with its base", function (n: number) {
  prOf(this, n).mergeable = true;
});

Given("GitHub hasn't yet worked out whether PR {int} conflicts with its base", function (n: number) {
  prOf(this, n).mergeable = null;
});

Given("nobody has reviewed PR {int} since the question was asked", function (n: number) {
  const p = prOf(this, n);
  assert.deepEqual(p.reviews, [], `PR ${n} has reviews`);
  assert.equal((pollCtx(this).host!.reviewComments.get(`${REPO}#${n}`) ?? []).length, 0, `PR ${n} has review comments`);
});

function requestChanges(world: object, login: string, n: number, at: string): void {
  prOf(world, n).reviews.push({ state: "changes_requested", submittedAt: at, author: login, body: "Please change this." });
}

Given("{string} requested changes on PR {int} at {string}", function (login: string, n: number, at: string) {
  requestChanges(this, login, n, at);
});

When("{string} requests changes on PR {int} at {string}", function (login: string, n: number, at: string) {
  requestChanges(this, login, n, at);
});

let threads = 0;

function threadComment(world: object, n: number, c: { threadId: string; author: string; body: string; submittedAt: string }): void {
  prOf(world, n);
  const host = pollCtx(world).host!;
  const key = `${REPO}#${n}`;
  host.reviewComments.set(key, [...(host.reviewComments.get(key) ?? []), { ...c, path: "src/app.ts", line: 1 }]);
}

Given("{string} commented {string} in a still-open thread on PR {int} at {string}", function (login: string, body: string, n: number, at: string) {
  threadComment(this, n, { threadId: `pbi305-thread-${++threads}`, author: login, body, submittedAt: at });
});

When("{string} comments {string} in a new thread on PR {int} at {string}", function (login: string, body: string, n: number, at: string) {
  threadComment(this, n, { threadId: `pbi305-thread-${++threads}`, author: login, body, submittedAt: at });
});

Given(
  "{string} replied at {string} inside a still-open thread the factory's PR reviewer started on PR {int}",
  function (login: string, at: string, n: number) {
    const threadId = `pbi305-thread-${++threads}`;
    const started = new Date(Date.parse(at) - 3_600_000).toISOString();
    threadComment(this, n, { threadId, author: BOT, body: "The factory's review finding.", submittedAt: started });
    threadComment(this, n, { threadId, author: login, body: "Agreed, please fix.", submittedAt: at });
  },
);

// ---- people and the poller ----

async function owner(world: object): Promise<string> {
  const m = ctx(world);
  m.owner ??= (await pool().query<{ id: string }>(
    `insert into "user" (provider, subject, github_login, role, product_owner) values ('microsoft', 'pbi-305-owner', 'pbi-305-owner', 'owner', true)
     on conflict (provider, subject) do update set role = excluded.role returning id`,
  )).rows[0].id;
  return m.owner;
}

async function answer(world: object, n: number, text: string): Promise<void> {
  const item = base260(world).items.get(n);
  assert.ok(item, `no item ${n} was set up`);
  const userId = await owner(world);
  const outcome = await withTx(pool(), (c) => decide(c, { itemId: item.id, userId, kind: "answer", text, via: "dashboard" }));
  assert.equal(outcome, "applied", `the owner's answer to item ${n} was ${outcome}`);
}

Given("the owner has answered item {int}'s question {string}", long, async function (n: number, text: string) {
  await answer(this, n, text);
});

Given("the owner answers item {int}'s question {string} while the poller is reading PR {int}", long, async function (n: number, text: string, pr: number) {
  const host = pollCtx(this).host;
  assert.ok(host, "the poller's fake repo host isn't set up");
  prOf(this, pr);
  const item = base260(this).items.get(n);
  assert.ok(item, `no item ${n} was set up`);
  const open = (await pool().query<{ answer: string | null }>("select answer from question where id = $1", [item.question])).rows[0];
  assert.ok(open, `item ${n}'s question isn't in the database`);
  assert.equal(open.answer, null, `item ${n}'s question is already answered`);
  const read = host.prState.bind(host);
  let answered = false;
  host.prState = async (repo, number, ...rest) => {
    if (!answered && repo === REPO && number === pr) {
      answered = true;
      await answer(this, n, text);
    }
    return read(repo, number, ...rest);
  };
});

When("two polls run at the same time", long, async function () {
  const c = pollCtx(this);
  const before = c.polls;
  await Promise.all([poll(c), poll(c)]);
  assert.equal(c.error, undefined, `a poll failed: ${String(c.error)}`);
  assert.equal(c.polls, before + 2, `${c.polls - before} of the two polls ran`);
});

// ---- the outcomes ----

Then("item {int}'s answer is still {string}, given by the owner", long, async function (n: number, text: string) {
  polled(pollCtx(this));
  const item = base260(this).items.get(n);
  assert.ok(item, `no item ${n} was set up`);
  const q = (await pool().query<{ answer: string | null; answered_by: string | null }>(
    "select answer, answered_by from question where id = $1", [item.question],
  )).rows[0];
  assert.equal(q.answer, text, `item ${n}'s answer is ${JSON.stringify(q.answer)}`);
  assert.equal(q.answered_by, await owner(this), `item ${n}'s question was answered by ${q.answered_by}`);
});

async function theAnswer(world: object): Promise<string> {
  polled(pollCtx(world));
  const m = base260(world);
  const n = m.lastAsked ?? [...m.items.keys()][0];
  const q = (await pool().query<{ answer: string | null }>("select answer from question where id = $1", [m.items.get(n)!.question])).rows[0];
  assert.ok(q.answer, `item ${n}'s question has no answer`);
  return q.answer;
}

const namesPr = (a: string, n: number) => new RegExp(`(?<![\\w.])(?:PR\\s*)?#?${n}(?!\\d)`, "i").test(a);

Then("the answer says PR {int} conflicts with its base {string}", long, async function (n: number, base: string) {
  const a = await theAnswer(this);
  assert.ok(namesPr(a, n), `the answer doesn't name PR ${n}: ${a}`);
  assert.match(a, /conflict/i, `the answer doesn't say the PR conflicts: ${a}`);
  assert.ok(new RegExp(`\\b${base}\\b`).test(a), `the answer doesn't name the base ${base}: ${a}`);
});

Then("the answer says a trusted review asked for changes on PR {int}", long, async function (n: number) {
  const a = await theAnswer(this);
  assert.ok(namesPr(a, n), `the answer doesn't name PR ${n}: ${a}`);
  assert.match(a, /review/i, `the answer doesn't name a review: ${a}`);
  assert.match(a, /\bchanges\b/i, `the answer doesn't say the review asked for changes: ${a}`);
});

/** The forms a time may take in the answer or the event: as the scenario gives it, or as JavaScript prints it. */
const timeForms = (at: string) => [at, new Date(at).toISOString()];

Then("the answer names the time {string}", long, async function (at: string) {
  const a = await theAnswer(this);
  assert.ok(timeForms(at).some((t) => a.includes(t)), `the answer doesn't name the time ${at}: ${a}`);
});

type EventRow = { actor: string; actor_id: string; payload: { questionId?: string; prNumber?: number; reason?: string; at?: string } | null };

async function requeues(world: object, n: number): Promise<EventRow[]> {
  polled(pollCtx(world));
  const item = base260(world).items.get(n);
  assert.ok(item, `no item ${n} was set up`);
  return (await pool().query<EventRow>(
    "select actor, actor_id, payload from event where item_id = $1 and kind = $2 order by at, id", [item.id, REQUEUED_FOR_ADDRESS],
  )).rows;
}

Then(
  "item {int} has a system event recording its re-queue for address after PR {int} conflicted with its base",
  long,
  async function (n: number, pr: number) {
    const all = await requeues(this, n);
    assert.equal(all.length, 1, `item ${n} has ${all.length} ${REQUEUED_FOR_ADDRESS} events`);
    assert.equal(all[0].actor, "system", `the event's actor is ${all[0].actor}`);
    assert.equal(all[0].payload?.reason, "conflict", `the event's reason is ${all[0].payload?.reason}`);
    assert.equal(all[0].payload?.prNumber, pr, `the event names PR ${all[0].payload?.prNumber}`);
    base260(this).lastAsked = n;
  },
);

Then("item {int} has a system event recording its re-queue for address after a review at {string}", long, async function (n: number, at: string) {
  const all = await requeues(this, n);
  assert.equal(all.length, 1, `item ${n} has ${all.length} ${REQUEUED_FOR_ADDRESS} events`);
  assert.equal(all[0].actor, "system", `the event's actor is ${all[0].actor}`);
  assert.equal(all[0].payload?.reason, "review", `the event's reason is ${all[0].payload?.reason}`);
  const got = all[0].payload?.at;
  assert.ok(got && Date.parse(got) === Date.parse(at), `the event names the review's time ${got}, not ${at}`);
});

Then("the event names item {int}'s question", long, async function (n: number) {
  const all = await requeues(this, n);
  assert.ok(all.length > 0, `item ${n} has no ${REQUEUED_FOR_ADDRESS} event`);
  const question = base260(this).items.get(n)!.question;
  for (const e of all) assert.equal(e.payload?.questionId, question, `the event names question ${e.payload?.questionId}`);
});

Then("item {int} has exactly one system event recording a re-queue for address", long, async function (n: number) {
  const all = await requeues(this, n);
  assert.equal(all.length, 1, `item ${n} has ${all.length} ${REQUEUED_FOR_ADDRESS} events`);
  assert.equal(all[0].actor, "system", `the event's actor is ${all[0].actor}`);
});

Then("item {int} has no system event recording a re-queue for address", long, async function (n: number) {
  const all = await requeues(this, n);
  assert.equal(all.length, 0, `item ${n} has ${all.length} ${REQUEUED_FOR_ADDRESS} events`);
});
