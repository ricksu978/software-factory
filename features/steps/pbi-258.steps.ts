// Step definitions for PBI 258's two feature files.
//
// features/pbi-258-thread-resolution-and-cause.feature runs the real poller and the real webhook handler over PBI 4's
// shared database, on PBI 12's harness (its fake board, its fake repo host and its InReview item with an open PR) and
// PBI 130's steps for the repo's trusted bot, the allowlisted users and the person's own threads. The person's first
// thread and the factory's reply in it are dated before the item came back to InReview, which is the run's
// `reviews_seen_at`, BACK_AT, and every comment a scenario adds comes after it. The scenarios' own times are on
// 2026-11-14, so BACK_AT is earlier that morning. A reply "in a review" is a review that only comments, plus the
// comment, which the fake ties to the review by its author and submittedAt. The `changes_requested` event's cause is
// read from its transition payload's `cause`:
//   { kind: "thread_comment", threadId, author, body, submittedAt }   a comment in an unresolved thread
//   { kind: "review", author, body, submittedAt }                     a review's summary
//   { kind: "not_mergeable" }                                         GitHub reported the PR not mergeable
//
// features/pbi-258-address-resolves-and-hands-back.feature runs the engine through PBI 18's harness, resuming at
// address through PBI 152's Background step, with PBI 128's fake repo host and scripted PR reviewer and PR addresser.
// A person's thread is `PT-<n>`, in the repo host's review threads and, while unresolved, in the cell's trusted
// comments, every comment of it, as the control plane hands them to an address run. Each resolve, reply and CI answer
// is logged in order, so the Thens can tell what came first.
import { Before, Given, Then, When } from "@cucumber/cucumber";
import type { DataTable } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import type pg from "pg";
import type { Ctx as CellCtx } from "./pbi-18.steps.ts";
import { ctx as pr128, done, reviewerCall, type Ctx as PrCtx } from "./pbi-128.steps.ts";
import { ctx as pbi12, polled, REPO as REPO12 } from "./pbi-12.steps.ts";
import { load, long, need, testDb } from "./pbi-8.steps.ts";

// ---- the poller and the webhook ----

const BACK_AT = "2026-11-14T08:30:00Z";

type Mine = { backAt?: Date };
function mine(world: object): Mine {
  const w = world as { pbi258?: Mine };
  w.pbi258 ??= {};
  return w.pbi258;
}

type Comment = { threadId: string; path: string | null; line: number | null; author: string; body: string; resolved?: boolean; submittedAt?: string };

function prComments(world: object): Comment[] {
  const c = pbi12(world);
  assert.ok(c.host && c.pr, "the item has no PR");
  const key = `${REPO12}#${c.pr}`;
  if (!c.host.reviewComments.has(key)) c.host.reviewComments.set(key, []);
  return c.host.reviewComments.get(key)!;
}

function fakePr(world: object) {
  const c = pbi12(world);
  const p = c.host?.prs.find((x) => x.number === c.pr);
  assert.ok(p, "the item has no PR");
  return p;
}

/** The id of the thread whose first comment reads `body`. */
function threadOf(world: object, body: string): string {
  const all = prComments(world);
  const first = all.find((x) => x.body === body && all.find((y) => y.threadId === x.threadId) === x);
  assert.ok(first, `no thread opens with "${body}"`);
  return first.threadId;
}

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/** Adds a reply to a thread at `at`. A thread can't open after its own reply, so earlier comments move just before it. */
function replyIn(world: object, threadId: string, author: string, body: string, at: string) {
  const all = prComments(world);
  const before = new Date(Date.parse(at) - 60_000).toISOString();
  for (const x of all) if (x.threadId === threadId && x.submittedAt && Date.parse(x.submittedAt) >= Date.parse(at)) x.submittedAt = before;
  const first = all.find((x) => x.threadId === threadId)!;
  all.push({ threadId, path: first.path, line: first.line, author, body, submittedAt: at });
}

function resolve(world: object, thread: string) {
  const id = threadOf(world, thread);
  for (const x of prComments(world)) if (x.threadId === id) x.resolved = true;
}

Before({ tags: "@pbi-258 and @db", ...long }, async function () {
  const d = await testDb();
  if (d) await d.pool.query('truncate item, backlog_source, repo, "user" cascade');
});

Given("the factory replied {string} inside that thread", function (body: string) {
  const c = pbi12(this);
  if (!c.host || !c.pr) return;
  const last = prComments(this).at(-1);
  assert.ok(last, "no thread was opened before this step");
  replyIn(this, last.threadId, "factory[bot]", body, ago(1));
});

Given("the item came back to InReview after that reply", long, async function () {
  const c = pbi12(this);
  if (!c.host || !c.pr || !c.sourceId) return;
  // Every comment so far came before the item came back to InReview.
  const all = prComments(this);
  all.forEach((x, i) => { x.submittedAt = new Date(Date.parse(BACK_AT) - (all.length - i) * 5 * 60_000).toISOString(); });
  await need().pool.query(
    `update run set reviews_seen_at = $3 where ended_at is null and item_id in (select id from item where source_id = $1 and external_id = $2)`,
    [c.sourceId, c.extIds[0], BACK_AT],
  );
  mine(this).backAt = (await need().pool.query<{ now: Date }>("select now()")).rows[0].now;
});

Given("{string} submitted a review requesting changes whose only text is the reply {string} inside the thread {string}", function (login: string, body: string, thread: string) {
  if (!pbi12(this).host) return;
  const at = ago(10);
  fakePr(this).reviews.push({ state: "changes_requested", submittedAt: at, author: login, body: "" });
  replyIn(this, threadOf(this, thread), login, body, at);
});

Given("{string} submitted a review requesting changes whose only text is the reply {string} inside the thread {string}, at {string}", function (login: string, body: string, thread: string, at: string) {
  if (!pbi12(this).host) return;
  fakePr(this).reviews.push({ state: "changes_requested", submittedAt: at, author: login, body: "" });
  replyIn(this, threadOf(this, thread), login, body, at);
});

Given("{string} replied {string} inside the thread {string}, in a review submitted at {string}", function (login: string, body: string, thread: string, at: string) {
  if (!pbi12(this).host) return;
  fakePr(this).reviews.push({ state: "commented", submittedAt: at, author: login, body: "" });
  replyIn(this, threadOf(this, thread), login, body, at);
});

Given("{string} resolved the thread {string}", function (_login: string, thread: string) {
  if (pbi12(this).host) resolve(this, thread);
});

When("{string} resolves the thread {string}", function (_login: string, thread: string) {
  if (pbi12(this).host) resolve(this, thread);
});

Given("the thread {string} is still unresolved", function (thread: string) {
  if (!pbi12(this).host) return;
  const id = threadOf(this, thread);
  assert.ok(prComments(this).filter((x) => x.threadId === id).every((x) => !x.resolved), `the thread "${thread}" is resolved`);
});

Given("{string} then approved the item's PR with the summary {string}", function (login: string, body: string) {
  if (pbi12(this).host) fakePr(this).reviews.push({ state: "approved", submittedAt: ago(5), author: login, body });
});

Given("{string} requested changes on the item's PR with only the summary {string}, in a review submitted at {string}", function (login: string, body: string, at: string) {
  if (pbi12(this).host) fakePr(this).reviews.push({ state: "changes_requested", submittedAt: at, author: login, body });
});

Given("GitHub reports the item's PR as not mergeable", function () {
  if (pbi12(this).host) fakePr(this).mergeable = false;
});

type Webhook = {
  handleWebhook: (deps: { pool: pg.Pool; secret: string; parse: (h: Record<string, string>, b: unknown) => unknown }, req: { headers: Record<string, string>; rawBody: Buffer }) => Promise<{ status: number }>;
};
type Parser = { parseGitHubWebhook: (h: Record<string, string>, b: unknown) => unknown };
const WEBHOOK_SECRET = "pbi-258-webhook-secret";

When("GitHub delivers octo's review to the webhook", long, async function () {
  const c = pbi12(this);
  const [hook, gh] = await Promise.all([load<Webhook>("src/watcher/webhook.ts"), load<Parser>("src/adapters/github/backlog.ts")]);
  if (!hook || !gh || !c.host || !c.pr) return;
  const review = fakePr(this).reviews.filter((r) => r.author === "octo").at(-1);
  assert.ok(review, "octo submitted no review");
  const raw = Buffer.from(JSON.stringify({
    action: "submitted", repository: { full_name: REPO12 }, pull_request: { number: c.pr },
    review: { id: 9258, state: review.state, body: review.body ?? "", submitted_at: review.submittedAt, user: { login: "octo", type: "User" } },
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
  c.deliveries = (c.deliveries ?? 0) + 1;
});

type Cause = { kind?: string; threadId?: string; author?: string; body?: string; submittedAt?: string };

async function events(world: object, event: string): Promise<{ payload: { cause?: Cause } }[]> {
  const c = pbi12(world);
  polled(c);
  const r = await need().pool.query<{ payload: { cause?: Cause } }>(
    `select e.payload from event e join item i on i.id = e.item_id
     where i.source_id = $1 and i.external_id = $2 and e.kind = 'transition' and e.payload->>'event' = $3 and e.at >= $4
     order by e.at, e.id`,
    [c.sourceId, c.extIds[0], event, mine(world).backAt ?? new Date(0)],
  );
  return r.rows;
}

async function cause(world: object, event: string): Promise<Cause> {
  const all = await events(world, event);
  assert.ok(all.length > 0, `the item has no "${event}" event`);
  const found = all.at(-1)!.payload.cause;
  assert.ok(found && typeof found === "object", `the item's "${event}" event names no cause: ${JSON.stringify(all.at(-1)!.payload)}`);
  return found;
}

const sameTime = (a: string | undefined, b: string) => a !== undefined && Date.parse(a) === Date.parse(b);

Then("the item has no {string} event since it came back to InReview", long, async function (event: string) {
  const all = await events(this, event);
  assert.deepEqual(all.map((e) => e.payload), [], `the item has a "${event}" event`);
});

Then("the item's {string} event names a thread comment by {string} reading {string}", long, async function (event: string, login: string, body: string) {
  const x = await cause(this, event);
  assert.equal(x.kind, "thread_comment", `the cause is ${JSON.stringify(x)}`);
  assert.equal(x.author, login);
  assert.equal(x.body, body);
});

Then("the item's {string} event names the comment inside the thread {string}", long, async function (event: string, thread: string) {
  const x = await cause(this, event);
  assert.equal(x.kind, "thread_comment", `the cause is ${JSON.stringify(x)}`);
  assert.equal(x.threadId, threadOf(this, thread), `the cause names thread ${x.threadId}`);
});

Then("the item's {string} event names {string} as the time that comment was submitted", long, async function (event: string, at: string) {
  const x = await cause(this, event);
  assert.equal(x.kind, "thread_comment", `the cause is ${JSON.stringify(x)}`);
  assert.ok(sameTime(x.submittedAt, at), `the cause was submitted at ${x.submittedAt}, not ${at}`);
});

Then("the item's {string} event doesn't name the thread {string}", long, async function (event: string, thread: string) {
  const x = await cause(this, event);
  assert.notEqual(x.threadId, threadOf(this, thread), `the cause names the thread "${thread}"`);
});

Then("the item's {string} event doesn't say GitHub reported the PR not mergeable", long, async function (event: string) {
  const x = await cause(this, event);
  assert.notEqual(x.kind, "not_mergeable");
});

Then("the item's {string} event names a review by {string} whose summary reads {string}", long, async function (event: string, login: string, body: string) {
  const x = await cause(this, event);
  assert.equal(x.kind, "review", `the cause is ${JSON.stringify(x)}`);
  assert.equal(x.author, login);
  assert.equal(x.body, body);
});

Then("the item's {string} event names {string} as the time that review was submitted", long, async function (event: string, at: string) {
  const x = await cause(this, event);
  assert.equal(x.kind, "review", `the cause is ${JSON.stringify(x)}`);
  assert.ok(sameTime(x.submittedAt, at), `the review was submitted at ${x.submittedAt}, not ${at}`);
});

Then("the item's {string} event says GitHub reported the PR not mergeable", long, async function (event: string) {
  const x = await cause(this, event);
  assert.equal(x.kind, "not_mergeable", `the cause is ${JSON.stringify(x)}`);
});

Then("the item's {string} event names no review or thread comment", long, async function (event: string) {
  const x = await cause(this, event);
  assert.equal(x.kind, "not_mergeable", `the cause is ${JSON.stringify(x)}`);
  assert.deepEqual([x.threadId, x.author, x.body], [undefined, undefined, undefined], `the cause names a comment: ${JSON.stringify(x)}`);
});

// ---- the cell: address resolves what it answers, and an empty address hands the PR back ----

const CELL_REPO = "acme/app";
const PR = 57;

type Logged = { kind: "checks"; sha: string; result: string } | { kind: "resolve"; threadId: string } | { kind: "reply"; threadId: string; body: string };
type Track = { log: Logged[] };

function cell(world: object): CellCtx {
  const w = world as { pbi18?: CellCtx };
  assert.ok(w.pbi18, "no run was set up");
  return w.pbi18;
}

/** PBI 128's repo host, CI and scripted agents, with each resolve, reply and CI answer logged in order. */
function track(world: object): Track {
  const w = world as { pbi258cell?: Track };
  if (w.pbi258cell) return w.pbi258cell;
  const t: Track = { log: [] };
  w.pbi258cell = t;
  const run = cell(world);
  pr128(world);
  const inner = run.repoHost!;
  run.repoHost = new Proxy(inner, {
    get(target, key, receiver) {
      const real = Reflect.get(target, key, receiver) as ((...a: unknown[]) => Promise<unknown>) | undefined;
      if (key === "resolveThread") return async (repo: string, threadId: string) => { const r = await real!.call(target, repo, threadId); t.log.push({ kind: "resolve", threadId }); return r; };
      if (key === "replyToThread") return async (repo: string, threadId: string, body: string) => { const r = await real!.call(target, repo, threadId, body); t.log.push({ kind: "reply", threadId, body }); return r; };
      return typeof real === "function" ? real.bind(target) : real;
    },
  });
  const checks = run.checks!;
  run.checks = async (sha: string) => {
    const result = await checks(sha);
    t.log.push({ kind: "checks", sha, result });
    return result;
  };
  return t;
}

type Person = { threadId: string; path: string; line: number; author: string; comments: { author: string; body: string }[] };

function people(world: object): Person[] {
  const w = world as { pbi258people?: Person[] };
  w.pbi258people ??= [];
  return w.pbi258people;
}

/** The control plane's trusted comments: every comment in each person's thread that is still unresolved. */
function handOver(world: object) {
  const run = cell(world);
  const c = pr128(world);
  const open = people(world).filter((p) => !resolvedNow(c, p.threadId));
  const trustedComments = open.flatMap((p) => p.comments.map((x) => ({ threadId: p.threadId, path: p.path, line: p.line, author: x.author, body: x.body })));
  run.context = { ...run.context, trustedComments };
}

function resolvedNow(c: PrCtx, threadId: string): boolean {
  const cs = (c.host.reviewComments.get(`${CELL_REPO}#${PR}`) ?? []).filter((x) => x.threadId === threadId);
  return cs.length > 0 && cs.every((x) => x.resolved);
}

function personThread(world: object, author: string, path: string, line: number, comments: { author: string; body: string }[]): Person {
  track(world);
  const c = pr128(world);
  const threadId = `PT-${c.personThreads.length + 1}`;
  const key = `${CELL_REPO}#${PR}`;
  const list = c.host.reviewComments.get(key) ?? [];
  comments.forEach((x, i) => list.push({ threadId, path, line, author: x.author, body: x.body, submittedAt: new Date(Date.now() - (60 - i) * 60_000).toISOString() }));
  c.host.reviewComments.set(key, list);
  c.personThreads.push({ threadId, body: comments[0].body });
  c.last = comments[0].body;
  const p: Person = { threadId, path, line, author, comments };
  people(world).push(p);
  handOver(world);
  return p;
}

function personByBody(world: object, body: string): Person {
  const p = people(world).find((x) => x.comments[0].body === body);
  assert.ok(p, `no person's thread "${body}"`);
  return p;
}

function resolvedAt(t: Track, threadId: string): number {
  return t.log.findIndex((x) => x.kind === "resolve" && x.threadId === threadId);
}

Given("the branch merges the base with no conflict", function () {
  // The run's branch is cut from main, which has no commit since, so merging it conflicts with nothing.
  track(this);
});

Given("{string}'s unresolved thread on line {int} of {string} on PR {int} holds these comments, oldest first:", function (login: string, line: number, path: string, _pr: number, table: DataTable) {
  personThread(this, login, path, line, table.hashes().map((r) => ({ author: r.author, body: r.comment })));
});

Given("{string}'s unresolved thread {string} on line {int} of {string} on PR {int} sent the item back to address", function (login: string, body: string, line: number, path: string, _pr: number) {
  personThread(this, login, path, line, [{ author: login, body }]);
});

Given("{string}'s unresolved thread {string} on line {int} of {string} is also on PR {int}", function (login: string, body: string, line: number, path: string, _pr: number) {
  const keep = pr128(this).last;
  personThread(this, login, path, line, [{ author: login, body }]);
  pr128(this).last = keep;
});

Given("{string}'s thread {string} sent the item back to address", function (login: string, body: string) {
  personThread(this, login, "src/totals.ts", 12, [{ author: login, body }]);
});

Given("{string} resolved that thread before the cell started", function (_login: string) {
  const c = pr128(this);
  const p = people(this).at(-1);
  assert.ok(p, "no person's thread was set up");
  for (const x of c.host.reviewComments.get(`${CELL_REPO}#${PR}`) ?? []) if (x.threadId === p.threadId) x.resolved = true;
  handOver(this);
});

Given("no other trusted review text waits on the run's PR {int}", function (n: number) {
  const run = cell(this);
  run.prNumber = n;
  run.trusted = [];
  handOver(this);
});

Given("the PR addresser fixes that thread with a new commit", function () {
  const c = pr128(this);
  assert.ok(c.last, "no thread was named before this step");
  c.addresses.push({ actions: new Map([[c.last, { kind: "fix" }]]) });
});

Given("the PR addresser replies {string} on the thread {string}, and neither fixes nor replies to {string}", function (reply: string, body: string, other: string) {
  const c = pr128(this);
  personByBody(this, other);
  const pass = { actions: new Map<string, { kind: "fix" } | { kind: "reply"; body: string }>() };
  pass.actions.set(personByBody(this, body).comments[0].body, { kind: "reply", body: reply });
  c.addresses.push(pass);
});

Then("the PR addresser's brief holds {string}, {string} and {string}", function (a: string, b: string, d: string) {
  const { c } = done(this);
  assert.ok(c.addresserCalls.length > 0, "the PR addresser never ran");
  for (const text of [a, b, d]) assert.ok(c.addresserCalls[0].prompt.includes(text), `the PR addresser's brief lacks "${text}"`);
});

Then("the factory resolved octo's thread on line {int} of {string}", function (line: number, path: string) {
  done(this);
  const p = people(this).find((x) => x.author === "octo" && x.line === line && x.path === path);
  assert.ok(p, `octo has no thread on line ${line} of ${path}`);
  assert.ok(resolvedAt(track(this), p.threadId) >= 0 && resolvedNow(pr128(this), p.threadId), "the factory didn't resolve octo's thread");
  (this as { pbi258that?: string }).pbi258that = p.threadId;
});

Then("the factory resolved that thread only after CI passed on the addresser's new commit", function () {
  const { c } = done(this);
  const threadId = (this as { pbi258that?: string }).pbi258that;
  assert.ok(threadId, "no thread was named before this step");
  const fix = c.addresserShas[0];
  assert.ok(fix, "the PR addresser made no commit");
  const t = track(this);
  const passed = t.log.findIndex((x) => x.kind === "checks" && x.sha === fix && x.result === "success");
  assert.ok(passed >= 0, `CI never passed on the addresser's commit ${fix}`);
  const at = resolvedAt(t, threadId);
  assert.ok(at >= 0, "the factory never resolved the thread");
  assert.ok(at > passed, "the factory resolved the thread before CI passed on the addresser's commit");
});

Then("the factory posted the reply {string} in the thread {string}", function (reply: string, body: string) {
  const { c } = done(this);
  const p = personByBody(this, body);
  const replies = (c.host.reviewComments.get(`${CELL_REPO}#${PR}`) ?? []).filter((x) => x.threadId === p.threadId && x.author === "factory[bot]");
  assert.ok(replies.some((x) => x.body === reply), `the factory's replies in the thread are ${JSON.stringify(replies.map((x) => x.body))}`);
});

Then("the factory resolved the thread {string} after posting that reply", function (body: string) {
  done(this);
  const p = personByBody(this, body);
  const t = track(this);
  const replied = t.log.findIndex((x) => x.kind === "reply" && x.threadId === p.threadId);
  assert.ok(replied >= 0, "the factory posted no reply in the thread");
  const at = resolvedAt(t, p.threadId);
  assert.ok(at >= 0, "the factory never resolved the thread");
  assert.ok(at > replied, "the factory resolved the thread before posting its reply");
});

Then("the factory resolved the thread {string}", function (body: string) {
  done(this);
  const p = personByBody(this, body);
  assert.ok(resolvedAt(track(this), p.threadId) >= 0 && resolvedNow(pr128(this), p.threadId), `the factory didn't resolve the thread "${body}"`);
});

Then("the address stage's last attempt ends passed", function () {
  const run = cell(this);
  const all = run.calls.filter((x) => x.route === "/stage" && x.body.stageId === "address").map((x) => x.body);
  assert.ok(all.length > 0, "address never started");
  const last = all.at(-1)!;
  assert.equal(last.status, "passed", `the last address report is ${last.status}, attempt ${last.attempt}: ${last.message ?? ""}`);
});

Then("the PR addresser never ran", function () {
  const { c } = done(this);
  assert.equal(c.addresserCalls.length, 0, `the PR addresser ran ${c.addresserCalls.length} times`);
});

Then("the PR reviewer's brief names PR {int}'s current head as the head to review", function (_n: number) {
  const { c } = done(this);
  const r = reviewerCall(c, 1);
  assert.equal(r.head, r.originHead, "the PR reviewer ran at a commit that wasn't the PR's pushed head");
  assert.ok(r.prompt.includes(r.originHead), `the PR reviewer's brief doesn't name the PR's head ${r.originHead}`);
});

Then("no question says {string}", function (text: string) {
  const run = cell(this);
  const asked = run.calls.filter((x) => x.route === "/transition" && x.body.question).map((x) => String(x.body.question.body ?? ""));
  assert.deepEqual(asked.filter((q) => q.includes(text)), [], `a question says "${text}"`);
});
