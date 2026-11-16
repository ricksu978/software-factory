// Step definitions for features/pbi-318-pr-review-earlier-claim-threads.feature.
//
// Every scenario runs the engine through PBI 18's harness, with PBI 128's fake repo host, CI, scripted PR reviewer and
// scripted PR addresser. The run's PR is #57 on acme/app, and the run resumes at "pr-review", as a run does once
// open-pr has passed (the cell API's stageAfter). The context names the repo's trusted bot as `trustedBot`, so the
// stage can tell the factory's threads from people's.
//
// - A thread from an earlier claim is one the fake repo host already holds on the PR when the cell starts: an `ET-<n>`
//   thread whose first comment is the finding, by the trusted bot, as postReview opens one. A reply inside it is a
//   comment by the trusted bot too, as replyToThread posts every reply: the addresser's as it wrote it, the PR
//   reviewer's as "Still open...". It's in PBI 128's `threads`, so the scripted agents judge it and answer it as any of
//   the factory's threads whose id their brief holds.
// - A review an earlier claim posted is one the PR already holds: a `commented` review by the trusted bot in the fake
//   PR's `reviews`, and in the host's `postedReviews`, with the body the engine's reviewBody writes for its round. A
//   person's review is only in the PR's `reviews`, by "owner". The reviews "the factory posted in this cell" are the
//   `postedReviews` after those the host held when the cell started.
// - The stage reads the PR's threads through the repo host's openReviewComments, which this file records.
// - A "next claim" runs the engine again, in a fresh clone of the same origin, against the same repo host, so it finds
//   the PR as the first claim left it. PBI 18's and PBI 128's records of calls start again for it; the first claim's are
//   kept here. Its context carries the first claim's highest attempt per stage, as the cell API's would.
import { Given, Then, When, type DataTable } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { reviewBody } from "../../src/cell/engine.ts";
import { runTheCell, setUp, type Ctx as CellCtx } from "./pbi-18.steps.ts";
import {
  briefEntries, ctx as pr128, done, newPass, ordinal, raise, REVIEWER, review, reviewerCall, stageReports, that, threadFor,
  type AgentRecord, type Ctx as PrCtx,
} from "./pbi-128.steps.ts";

const REPO = "acme/app";
const PR = 57;
const KEY = `${REPO}#${PR}`;
const BRANCH = "factory/pbi-482-r1";
const BOT = "factory[bot]";
const PERSON = "owner";
const ORD = "(first|second|third|fourth|fifth)";
const LONG = { timeout: 120_000 };

type Comment = { threadId: string; path: string | null; line: number | null; author: string; body: string; resolved?: boolean; submittedAt?: string };
type NextSpec = Pick<PrCtx, "reviews" | "addresses" | "heldFrom"> & { last: string | null };
type Claim = {
  calls: CellCtx["calls"]; result: string | null; error: unknown;
  reviewerCalls: AgentRecord[]; addresserCalls: AgentRecord[]; addresserShas: string[];
};
type Ctx = {
  /** Each read of the PR's open review threads, with how many agent calls the claim had made by then. */
  reads: { repo: string; prNumber: number; agentCalls: number; claim: number }[];
  /** The rounds each earlier claim's reviews posted, by claim. */
  claimRounds: Map<string, number[]>;
  seq: number;
  /** How many reviews the host held when this claim's cell started. */
  postedBefore: number;
  /** How many threads the host had resolved when this claim's cell started. */
  resolvedBefore: number;
  claim: number;
  /** Ends the first claim on a usage limit at the PR reviewer's first call after the addresser's commit. */
  limitAfterFix: boolean;
  expectFirstBlocked: boolean;
  nextDecision: { kind: string; text: string } | null;
  next: NextSpec;
  first?: Claim;
  /** The factory's threads still open on the PR when the next claim's cell started. */
  openAtNext?: string[];
  /** The first of the next claim's calls in PBI 128's addresserCalls. */
  addresserFrom: number;
  /** How many comments the PR's threads held when the next claim's cell started. */
  commentsAtNext?: number;
};

function cell(world: object): CellCtx {
  const w = world as { pbi18?: CellCtx };
  assert.ok(w.pbi18, "no run was set up");
  return w.pbi18;
}

function own(world: object): Ctx {
  const w = world as { pbi318?: Ctx };
  if (w.pbi318) return w.pbi318;
  const c = pr128(world);
  const o: Ctx = {
    reads: [], claimRounds: new Map(), seq: 0, postedBefore: 0, resolvedBefore: 0, claim: 1, addresserFrom: 0, limitAfterFix: false,
    expectFirstBlocked: false, nextDecision: null, next: { reviews: new Map(), addresses: [], heldFrom: [], last: null },
  };
  const read = c.host.openReviewComments.bind(c.host);
  c.host.openReviewComments = async (repo: string, prNumber: number) => {
    o.reads.push({ repo, prNumber, agentCalls: c.agentCalls.length, claim: o.claim });
    return read(repo, prNumber);
  };
  w.pbi318 = o;
  return o;
}

const comments = (c: PrCtx): Comment[] => c.host.reviewComments.get(KEY) ?? [];
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

function pr(c: PrCtx) {
  const p = c.host.prs.find((x) => x.repo === REPO && x.number === PR);
  assert.ok(p, "the repo host holds no PR #57");
  return p;
}

function lastRound(o: Ctx): number {
  return Math.max(0, ...[...o.claimRounds.values()].flat());
}

/** A review the factory posted in an earlier claim, as the PR holds it. */
function earlierReview(world: object, claim: string, round: number, comments: { path: string; line: number; body: string }[] = []) {
  const c = pr128(world);
  const o = own(world);
  const head = cell(world).lockSha ?? "0000000";
  const at = hoursAgo(10 - round);
  const body = reviewBody({ round, head, findings: comments.length, held: 0, inSummary: [], why: "diff" });
  pr(c).reviews.push({ state: "commented", submittedAt: at, author: BOT, body });
  c.host.postedReviews.push({ repo: REPO, prNumber: PR, commitSha: head, body, comments, event: "COMMENT" });
  o.claimRounds.set(claim, [...(o.claimRounds.get(claim) ?? []), round]);
  return c.host.postedReviews.at(-1)!;
}

/** A thread an earlier claim's review opened on the PR, under the trusted bot. */
function earlierThread(world: object, claim: string, body: string, line: number, path: string, resolved: boolean) {
  const c = pr128(world);
  const o = own(world);
  // The claim's review opened the thread: its first thread posts the claim's review, after every earlier round.
  if (!o.claimRounds.has(claim)) earlierReview(world, claim, lastRound(o) + 1);
  const round = o.claimRounds.get(claim)!.at(-1)!;
  const posted = c.host.postedReviews.find((r) => r.repo === REPO && r.prNumber === PR && roundOf(r.body) === round)!;
  posted.comments.push({ path, line, body });
  const threadId = `ET-${++o.seq}`;
  const list = comments(c);
  list.push({ threadId, path, line, author: BOT, body, submittedAt: hoursAgo(8), ...(resolved ? { resolved: true } : {}) });
  c.host.reviewComments.set(KEY, list);
  c.threads.push({ threadId, body, path, line });
  c.last = body;
}

function replyInThread(world: object, body: string) {
  const c = pr128(world);
  const t = threadFor(c, that(c));
  const list = comments(c);
  list.push({ threadId: t.threadId, path: t.path, line: t.line, author: BOT, body, submittedAt: hoursAgo(6) });
  c.host.reviewComments.set(KEY, list);
}

// ---- Background ----

Given("a run for item {int} whose scenarios were signed off and whose PR is open", function (_item: number) {
  const run = setUp(this, "pr-review", true);
  run.prNumber = PR;
});

// ---- Givens: the PR as earlier claims left it ----

Given("an earlier claim's PR review left an open thread {string} on line {int} of {string}", function (body: string, line: number, path: string) {
  earlierThread(this, "earlier", body, line, path, false);
});

Given("an earlier claim's PR review left a resolved thread {string} on line {int} of {string}", function (body: string, line: number, path: string) {
  earlierThread(this, "earlier", body, line, path, true);
});

Given("another, later claim's PR review left an open thread {string} on line {int} of {string}", function (body: string, line: number, path: string) {
  earlierThread(this, "later", body, line, path, false);
});

Given("the addresser replied {string} inside that thread", function (body: string) {
  replyInThread(this, body);
});

Given("the PR reviewer replied {string} inside that thread", function (body: string) {
  replyInThread(this, body);
});

Given("a trusted person's open thread {string} on line {int} of {string}", function (body: string, line: number, path: string) {
  const c = pr128(this);
  const threadId = `PT-${c.personThreads.length + 1}`;
  const list = comments(c);
  list.push({ threadId, path, line, author: PERSON, body, submittedAt: hoursAgo(9) });
  c.host.reviewComments.set(KEY, list);
  c.personThreads.push({ threadId, body });
});

Given("an earlier claim posted the factory's PR reviews for rounds {int} and {int} on the PR", function (a: number, b: number) {
  earlierReview(this, "earlier", a);
  earlierReview(this, "earlier", b);
});

Given("an earlier claim posted the factory's PR review for round {int} on the PR", function (n: number) {
  earlierReview(this, "earlier", n);
});

Given("another, later claim posted the factory's PR review for round {int} on the PR", function (n: number) {
  earlierReview(this, "later", n);
});

Given("a trusted person posted a review on the PR after it", function () {
  const c = pr128(this);
  // Its body names a round, as a person might, so only the factory's own reviews can count.
  pr(c).reviews.push({ state: "commented", submittedAt: hoursAgo(1), author: PERSON, body: "Round 4 of my reading: the PR review, round 4, looks fine to me." });
});

function factoryThreadsOpen(c: PrCtx): string[] {
  const first = new Map<string, Comment>();
  for (const x of comments(c)) if (!first.has(x.threadId)) first.set(x.threadId, x);
  const open: string[] = [];
  for (const [id, x] of first) {
    if (x.author !== BOT) continue;
    if (comments(c).filter((y) => y.threadId === id).some((y) => !y.resolved)) open.push(id);
  }
  return open;
}

// A Given before the cell runs, and a Then after it.
Given("no thread the factory's reviewer opened is open on the PR", function () {
  const c = pr128(this);
  const run = cell(this);
  if (run.result !== null || run.error !== null || run.calls.length) {
    done(this);
    reviewerCall(c, 1);
  }
  const open = factoryThreadsOpen(c);
  assert.deepEqual(open.map((id) => c.threads.find((t) => t.threadId === id)?.body ?? id), [], "the factory's threads still open on the PR");
});

// ---- Givens: the PR reviewer and the PR addresser ----

Given("the PR reviewer finds that thread fixed on its first review, and reports a finding {string} on line {int} of {string}", function (body: string, line: number, path: string) {
  const c = pr128(this);
  review(c, 1).verdicts.set(that(c), { settled: true, reason: "Fixed at this head." });
  raise(c, 1, { path, line, body });
});

Given(new RegExp(`^the PR reviewer finds "([^"]*)" fixed on its ${ORD} review, with no new finding$`), function (body: string, which: string) {
  const c = pr128(this);
  review(c, ordinal(which)).verdicts.set(body, { settled: true, reason: "Fixed at this head." });
  c.last = body;
});

Given(new RegExp(`^the PR reviewer finds "([^"]*)" fixed on its ${ORD} review, holds "([^"]*)", with no new finding$`), function (fixed: string, which: string, held: string) {
  const c = pr128(this);
  const r = review(c, ordinal(which));
  r.verdicts.set(fixed, { settled: true, reason: "Fixed at this head." });
  r.verdicts.set(held, { settled: false, reason: "VAT is still left out." });
  c.last = held;
});

Given("the PR reviewer holds both threads on its first review, with no new finding", function () {
  const c = pr128(this);
  const r = review(c, 1);
  for (const t of c.threads) r.verdicts.set(t.body, { settled: false, reason: "Still not fixed at this head." });
});

Given("the PR reviewer holds that thread on every review, with no new finding", function () {
  const c = pr128(this);
  c.heldFrom.push({ body: that(c), from: 1, reason: "VAT is still left out for exports." });
});

Given("the PR addresser replies {string} to that thread each time, with no code change", function (reply: string) {
  const c = pr128(this);
  c.replyEachTime.set(that(c), reply);
});

Given("the PR reviewer holds {string} on its first review, saying {string}, with no new finding", function (body: string, reason: string) {
  const c = pr128(this);
  review(c, 1).verdicts.set(body, { settled: false, reason });
  c.last = body;
});

Given("the PR reviewer holds that thread on its first review, saying {string}, and reports a finding {string} on line {int} of {string}", function (reason: string, body: string, line: number, path: string) {
  const c = pr128(this);
  const held = that(c);
  review(c, 1).verdicts.set(held, { settled: false, reason });
  raise(c, 1, { path, line, body });
});

Given("the PR addresser fixes {string} with a new commit, and doesn't fix {string}", function (fixed: string, left: string) {
  const pass = newPass(pr128(this));
  pass.actions.set(fixed, { kind: "fix" });
  pass.actions.set(left, { kind: "reply", body: "I'll come back to this one." });
});

// ---- Givens: two claims ----

Given("in the first claim the PR reviewer reports a finding {string} on line {int} of {string} on its first review", function (body: string, line: number, path: string) {
  raise(pr128(this), 1, { path, line, body });
});

Given("in the first claim the PR addresser fixes it with a new commit", function () {
  newPass(pr128(this));
});

Given("the first claim ends on a usage limit before the PR reviewer reviews the addresser's commit", function () {
  own(this).limitAfterFix = true;
});

Given("in the first claim the PR reviewer holds a finding {string} on line {int} of {string} until the PR review blocks", function (body: string, line: number, path: string) {
  const c = pr128(this);
  raise(c, 1, { path, line, body });
  c.heldFrom.push({ body, from: 2, reason: "VAT is still left out." });
});

Given("the item moves to NeedsInput at the end of the first claim, with that thread open on the PR", function () {
  own(this).expectFirstBlocked = true;
});

Given("the item's question is answered and the item is claimed again", function () {
  own(this).nextDecision = { kind: "answer", text: "Carry on with the PR review." };
});

function nextSpec(world: object): NextSpec {
  const o = own(world);
  o.next.last ??= pr128(world).last;
  return o.next;
}

const asCtx = (n: NextSpec) => n as unknown as PrCtx;

Given(new RegExp(`^in the next claim the PR reviewer finds that thread fixed on its ${ORD} review, with no new finding$`), function (which: string) {
  const n = nextSpec(this);
  assert.ok(n.last, "no finding was named before this step");
  review(asCtx(n), ordinal(which)).verdicts.set(n.last, { settled: true, reason: "Settled at this head." });
});

Given("in the next claim the PR reviewer holds that thread on its first review, saying {string}, with no new finding", function (reason: string) {
  const n = nextSpec(this);
  assert.ok(n.last, "no finding was named before this step");
  review(asCtx(n), 1).verdicts.set(n.last, { settled: false, reason });
});

Given("in the next claim the PR addresser fixes it with a new commit", function () {
  newPass(asCtx(nextSpec(this)));
});

// ---- Whens ----

function startClaim(world: object) {
  const c = pr128(world);
  const o = own(world);
  const run = cell(world);
  o.postedBefore = c.host.postedReviews.filter((r) => r.repo === REPO && r.prNumber === PR).length;
  o.resolvedBefore = c.host.resolvedThreads.length;
  run.context = { ...run.context, trustedBot: (world as { pbi130?: { bot: string } }).pbi130?.bot ?? BOT };
}

When("the cell runs from the PR review", LONG, async function () {
  own(this);
  startClaim(this);
  await runTheCell(this);
});

When("the first claim's cell runs", LONG, async function () {
  const o = own(this);
  const c = pr128(this);
  const run = cell(this);
  // The first claim is the one that opened the PR: it runs open-pr, then the PR review.
  run.nextStage = "open-pr";
  startClaim(this);
  const inner = run.wrapAgent!;
  if (o.limitAfterFix) {
    run.wrapAgent = (base) => {
      const f = inner(base);
      return async (a: { agent?: string; resume?: string; model: string }) => {
        if (a.agent === REVIEWER && !a.resume && c.addresserShas.length > 0) {
          return { ok: false, text: "Claude AI usage limit reached", costUsd: 0, tokensIn: 0, tokensOut: 0, model: a.model,
            limit: { resetsAt: Math.floor(Date.now() / 1000) + 3600 }, usage: null, transcript: "{}\n" };
        }
        return f(a);
      };
    };
  }
  try {
    await runTheCell(this);
  } finally {
    run.wrapAgent = inner;
  }
  o.first = {
    calls: run.calls, result: run.result, error: run.error,
    reviewerCalls: c.reviewerCalls, addresserCalls: [...c.addresserCalls], addresserShas: [...c.addresserShas],
  };
});

When("the next claim's cell runs from the PR review", LONG, async function () {
  const o = own(this);
  const c = pr128(this);
  const run = cell(this);
  assert.ok(o.first, "the first claim's cell never ran");
  // PBI 128's host answers postReview with an `FT-<n>` thread for each line comment, and the fake under it opens a
  // `review-thread-<n>` of its own for the same comment. Only the `FT-<n>` ones are the threads the first claim tracked,
  // so the fake's copies go, and the PR holds one thread per finding, as on GitHub.
  c.host.reviewComments.set(KEY, comments(c).filter((x) => !x.threadId.startsWith("review-thread-")));
  o.openAtNext = factoryThreadsOpen(c);
  o.commentsAtNext = comments(c).length;
  // The first claim's highest attempt per stage, as the cell API hands them to a later claim.
  const attempts: Record<string, number> = {};
  for (const x of o.first.calls) {
    if (x.route === "/stage" && x.body.status === "started") attempts[x.body.stageId] = Math.max(attempts[x.body.stageId] ?? 0, Number(x.body.attempt ?? 0));
  }
  // A fresh clone of the PR's branch, as a new cell makes.
  const dir = join(run.root, "work-next");
  execFileSync("git", ["clone", "-q", "-b", BRANCH, run.origin, dir]);
  execFileSync("git", ["config", "user.email", "cell@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "cell"], { cwd: dir });
  Object.assign(run, {
    dir, nextStage: "pr-review", decision: o.nextDecision, calls: [], agentCalls: [], stage: "", prBodies: [], result: null, error: null,
    startHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim(),
  });
  run.context = { ...run.context, stageAttempts: attempts };
  // PBI 128's addresser counts its passes across claims, so each commit it makes is a new one: the next claim's passes
  // follow the first claim's, and its own calls start at `addresserFrom`.
  o.addresserFrom = c.addresserCalls.length;
  const passes = Array.from({ length: o.addresserFrom }, (_, i) => c.addresses[i] ?? { actions: new Map() });
  Object.assign(c, {
    reviews: o.next.reviews, addresses: [...passes, ...o.next.addresses], heldFrom: o.next.heldFrom, replyEachTime: new Map(), newFindingsUpTo: 0,
    agentCalls: [], reviewerCalls: [], snapshots: new Map(), reviewerSessions: [], answers: [],
    firstChecked: null, failedShas: [], last: o.next.last ?? c.last,
  });
  o.claim = 2;
  startClaim(this);
  await runTheCell(this);
});

// ---- Thens: helpers ----

function nextClaim(world: object): { c: PrCtx; run: CellCtx; o: Ctx } {
  const o = own(world);
  assert.equal(o.claim, 2, "the next claim's cell never ran");
  const { c, run } = done(world);
  return { c, run, o };
}

/** The reviews the factory posted on the PR in this claim's cell. */
function postedHere(world: object) {
  const c = pr128(world);
  const o = own(world);
  return c.host.postedReviews.filter((r) => r.repo === REPO && r.prNumber === PR).slice(o.postedBefore);
}

function postedHereN(world: object, n: number) {
  const all = postedHere(world);
  const r = all[n - 1];
  assert.ok(r, `the factory posted ${all.length} reviews on the PR in this cell, so it has no review ${n}`);
  return r;
}

function roundOf(body: string): number | null {
  const m = /\bround (\d+)\b/i.exec(body);
  return m ? Number(m[1]) : null;
}

function anyThread(c: PrCtx, body: string): string {
  const t = c.threads.find((x) => x.body === body) ?? c.personThreads.find((x) => x.body === body);
  assert.ok(t, `no thread "${body}" on the PR`);
  return t.threadId;
}

/** The brief's JSON entry for the factory's thread, by its id. */
function entryFor(prompt: string, threadId: string) {
  return briefEntries(prompt).find((x) => x.threadId === threadId);
}

function holdsOwn(r: AgentRecord, c: PrCtx, body: string, place: string | undefined, who: string) {
  const t = threadFor(c, body);
  const e = entryFor(r.prompt, t.threadId);
  assert.ok(e, `${who} doesn't hold the thread ${t.threadId} for "${body}" as one of its own`);
  assert.equal(e.finding ?? e.body, body, `${who} holds the thread ${t.threadId} with another finding`);
  if (place) assert.equal(`${String(e.path)}:${String(e.line)}`, place, `${who} holds "${body}" at another place`);
  return e;
}

const strip = (s: string) => s.replace(/^Still open(?: at [0-9a-f]{7,40})?: /, "").trim();

function resolved(c: PrCtx, threadId: string, since = 0): boolean {
  return c.host.resolvedThreads.slice(since).some((r) => r.repo === REPO && r.threadId === threadId)
    && comments(c).filter((x) => x.threadId === threadId).every((x) => x.resolved);
}

function checkFirstClaim(world: object) {
  const o = own(world);
  if (!o.expectFirstBlocked) return;
  assert.ok(o.first, "the first claim's cell never ran");
  const t = o.first.calls.filter((x) => x.route === "/transition").at(-1);
  assert.equal(t?.body.event, "blocked", "the first claim didn't end in NeedsInput");
}

// ---- Thens: reading the PR's threads ----

Then("the factory read the PR's open review threads before the PR reviewer first ran", function () {
  const { c } = done(this);
  const first = reviewerCall(c, 1);
  const at = c.agentCalls.indexOf(first);
  const o = own(this);
  assert.ok(o.reads.some((x) => x.repo === REPO && x.prNumber === PR && x.claim === o.claim && x.agentCalls <= at),
    `the factory didn't read PR #${PR}'s open review threads before the PR reviewer first ran`);
});

Then(new RegExp(`^(the next claim's |the )PR reviewer's ${ORD} brief holds "([^"]*)"(?: on "([^"]*)")? as one of its own threads to check$`),
  function (who: string, which: string, body: string, place: string | undefined) {
    const { c } = who.startsWith("the next") ? nextClaim(this) : done(this);
    if (who.startsWith("the next")) checkFirstClaim(this);
    holdsOwn(reviewerCall(c, ordinal(which)), c, body, place, `the PR reviewer's ${which} brief`);
  });

Then("the PR reviewer's first brief holds {string} with this conversation, in order:", function (body: string, table: DataTable) {
  const { c } = done(this);
  const e = holdsOwn(reviewerCall(c, 1), c, body, undefined, "the PR reviewer's first brief");
  const conv = Array.isArray(e.conversation) ? e.conversation as { from?: string; body?: string }[] : [];
  const want = table.hashes().map((r) => ({ from: r.from.trim(), reply: r.reply.trim() }));
  assert.equal(conv.length, want.length, `the thread's conversation in the brief is ${JSON.stringify(conv)}`);
  want.forEach((w, i) => {
    const got = conv[i];
    const froms = w.from === "reviewer" ? ["you", "reviewer"] : [w.from];
    assert.ok(froms.includes(String(got.from)), `reply ${i + 1} is from ${String(got.from)}, not the ${w.from}: ${JSON.stringify(conv)}`);
    assert.equal(strip(String(got.body ?? "")), strip(w.reply), `reply ${i + 1} reads otherwise: ${JSON.stringify(conv)}`);
  });
});

Then(new RegExp(`^the PR reviewer's (first|second) brief doesn't hold "([^"]*)"$`), function (which: string, body: string) {
  const { c } = done(this);
  const r = reviewerCall(c, ordinal(which));
  const id = anyThread(c, body);
  assert.ok(!r.prompt.includes(id) && !r.prompt.includes(body), `the PR reviewer's ${which} brief holds "${body}"`);
});

Then("the PR reviewer's first brief doesn't hold {string} as one of its own threads", function (body: string) {
  const { c } = done(this);
  const p = c.personThreads.find((x) => x.body === body);
  assert.ok(p, `no person's thread "${body}"`);
  const r = reviewerCall(c, 1);
  assert.ok(!r.prompt.includes(p.threadId) && !r.prompt.includes(body), `the PR reviewer's first brief holds the person's thread ${p.threadId}`);
});

Then("the PR addresser's first brief holds {string} on {string} with {string}", function (body: string, place: string, reason: string) {
  const { c } = done(this);
  const a = c.addresserCalls[0];
  assert.ok(a, "the PR addresser never ran");
  const e = holdsOwn(a, c, body, place, "the PR addresser's first brief");
  assert.ok(JSON.stringify(e).includes(reason), `the PR addresser's first brief holds "${body}" without "${reason}": ${JSON.stringify(e)}`);
});

Then("the next claim's PR addresser's first brief holds {string} with {string}", function (body: string, reason: string) {
  const { c, o } = nextClaim(this);
  const a = c.addresserCalls[o.addresserFrom];
  assert.ok(a, "the PR addresser never ran in the next claim");
  const e = holdsOwn(a, c, body, undefined, "the next claim's PR addresser's first brief");
  assert.ok(JSON.stringify(e).includes(reason), `the next claim's PR addresser's first brief holds "${body}" without "${reason}": ${JSON.stringify(e)}`);
});

// ---- Thens: answering and resolving the threads ----

Then("the factory replied {string} inside that thread, naming the head the PR reviewer reviewed first", function (text: string) {
  const { c } = done(this);
  const head = reviewerCall(c, 1).head;
  const t = threadFor(c, that(c));
  const replies = comments(c).filter((x) => x.threadId === t.threadId).slice(1);
  assert.ok(replies.some((x) => x.author === BOT && x.body.includes(text) && x.body.includes(head)),
    `the thread's replies don't say "${text}" at ${head}: ${JSON.stringify(replies.map((x) => x.body))}`);
});

Then("in the next claim the factory replied {string} inside the thread {string}, naming the first claim addresser's commit", function (text: string, body: string) {
  const { c, o } = nextClaim(this);
  const sha = o.first!.addresserShas[0];
  assert.ok(sha, "the PR addresser made no commit in the first claim");
  const t = threadFor(c, body);
  const replies = comments(c).slice(o.commentsAtNext).filter((x) => x.threadId === t.threadId);
  assert.ok(replies.some((x) => x.author === BOT && x.body.includes(text) && x.body.includes(sha)),
    `the next claim's replies in the thread don't say "${text}" at ${sha}: ${JSON.stringify(replies.map((x) => x.body))}`);
});

Then("the factory resolved the thread {string}", function (body: string) {
  const { c } = done(this);
  reviewerCall(c, 1);
  assert.ok(resolved(c, threadFor(c, body).threadId, own(this).resolvedBefore), `the factory didn't resolve the thread "${body}"`);
});

Then("the factory resolved the thread {string} in the next claim", function (body: string) {
  const { c, o } = nextClaim(this);
  checkFirstClaim(this);
  reviewerCall(c, 1);
  assert.ok(resolved(c, threadFor(c, body).threadId, o.resolvedBefore), `the factory didn't resolve the thread "${body}" in the next claim`);
});

Then("the factory resolved the thread {string} after the first review", function (body: string) {
  const { c } = done(this);
  reviewerCall(c, 2);
  const t = threadFor(c, body);
  assert.ok(c.host.resolvedThreads.some((r) => r.threadId === t.threadId), `the factory didn't resolve the thread "${body}"`);
  assert.equal(c.snapshots.get(1)?.get(t.threadId)?.resolved, true, `the thread "${body}" was still open after the first review`);
});

Then("the thread {string} was still open on the PR when the next claim started", function (body: string) {
  const { c, o } = nextClaim(this);
  const t = threadFor(c, body);
  assert.ok(o.openAtNext?.includes(t.threadId), `the thread "${body}" wasn't open on the PR when the next claim started`);
});

// ---- Thens: the stage's end ----

Then("the PR review stage didn't pass after the first review", function () {
  const { c, run } = done(this);
  const second = reviewerCall(c, 2);
  const early = stageReports(run, "pr-review").filter((x) => x.body.status === "passed" && x.i < second.index);
  assert.deepEqual(early.map((x) => x.i), [], "the PR review stage passed after the first review");
  assert.ok(!run.calls.slice(0, second.index).some((x) => x.route === "/transition" && x.body.event === "pr_opened"), "the item moved to InReview after the first review");
});

Then("the PR review stage passed with the thread {string} still open on the PR", function (body: string) {
  const { run, c } = done(this);
  const reports = stageReports(run, "pr-review");
  assert.equal(reports.at(-1)?.body.status, "passed", "the PR review stage didn't pass");
  const p = c.personThreads.find((x) => x.body === body);
  assert.ok(p, `no person's thread "${body}"`);
  assert.ok(comments(c).filter((x) => x.threadId === p.threadId).every((x) => !x.resolved), `the thread "${body}" isn't open`);
});

Then("the PR review stage didn't pass in the next claim until the reviewer found that thread fixed", function () {
  const { c, run } = nextClaim(this);
  const fixedAt = reviewerCall(c, 2);
  const passed = stageReports(run, "pr-review").filter((x) => x.body.status === "passed");
  assert.ok(passed.length > 0, "the PR review stage never passed in the next claim");
  assert.ok(passed.every((x) => x.i > fixedAt.index), "the PR review stage passed in the next claim before the reviewer found the thread fixed");
});

Then("the factory's message names {string} as still open on the PR", function (body: string) {
  const { run } = done(this);
  const t = run.calls.filter((x) => x.route === "/transition").at(-1);
  assert.equal(t?.body.event, "blocked", "the cell asked no question");
  const q = String(t.body.question?.body ?? "");
  assert.ok(q.includes(body), `the factory's message doesn't name "${body}": ${q}`);
  assert.ok(q.includes(`#${PR}`), `the factory's message doesn't name PR #${PR}: ${q}`);
});

// ---- Thens: the review's summary and its round ----

Then(new RegExp(`^the ${ORD} review's summary says "([^"]*)"$`), function (which: string, text: string) {
  done(this);
  const r = postedHereN(this, ordinal(which));
  assert.ok(r.body.includes(text), `the ${which} review's summary says: ${r.body}`);
});

Then(new RegExp(`^the ${ORD} review the factory posted in this cell says it is round (\\d+)$`), function (which: string, n: string) {
  done(this);
  const r = postedHereN(this, ordinal(which));
  assert.equal(roundOf(r.body), Number(n), `the ${which} review the factory posted in this cell says: ${r.body}`);
});

Then("the next claim's first review says it is round {int}, with {string}", function (n: number, text: string) {
  nextClaim(this);
  const r = postedHereN(this, 1);
  assert.equal(roundOf(r.body), n, `the next claim's first review says: ${r.body}`);
  assert.ok(r.body.includes(text), `the next claim's first review says: ${r.body}`);
});

Then("the next claim's first review says {string}", function (text: string) {
  nextClaim(this);
  const r = postedHereN(this, 1);
  assert.ok(r.body.includes(text), `the next claim's first review says: ${r.body}`);
});

Then("the next claim's PR reviewer's first brief names the addresser's commit as the head to review", function () {
  const { c, o } = nextClaim(this);
  const sha = o.first!.addresserShas[0];
  assert.ok(sha, "the PR addresser made no commit in the first claim");
  const r = reviewerCall(c, 1);
  assert.equal(r.head, sha, `the next claim's PR reviewer ran at ${r.head}, not at the addresser's commit ${sha}`);
  assert.ok(r.prompt.includes(sha), `the next claim's PR reviewer's first brief doesn't name ${sha}`);
});
