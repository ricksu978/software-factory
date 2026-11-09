// Step definitions for features/pbi-128-pr-review-stage.feature. Every scenario runs the engine through PBI 18's
// harness (its Background step, "the cell runs" and runTheCell), with three things of its own:
//
// - A fake repo host: PBI 129's fakeRepoHost, holding the run's PR as #57. Each line comment in a review the factory
//   posts opens a thread, `FT-<n>` by the factory's bot, so openReviewComments, replyToThread and resolveThread act on
//   it. postReview also returns those threads, `{ threads: [{ threadId, path, line, body }] }`. Every PR body the
//   engine sends through openOrUpdatePr is kept, and the PR body Thens read the last.
// - A scripted PR reviewer, the agent call that names "factory-pr-reviewer". It judges each of the factory's open
//   threads whose id its brief holds, and reports its new findings, one JSON line each, then its verdict:
//     {"finding":"This misses the VAT.","path":"src/totals.ts","line":12}
//     {"thread":"FT-1","settled":false,"reason":"VAT is still left out for exports."}
//     OPEN: 1            (or APPROVED, when it has no new finding and settles every thread)
// - A scripted PR addresser, the agent call that names "factory-pr-addresser". For each of the factory's open threads
//   whose id its brief holds, it fixes the code, committing once per pass, or writes a reply line
//   {"threadId":"FT-1","body":"..."} to the reply file its brief names (`The reply file is \`<path>\`.`), as the
//   address stage's addresser does.
//
// A round is one call to the PR reviewer. CI answers from the scenario's rules, by the commit it's asked about.
import { Given, Then } from "@cucumber/cucumber";
import type { DataTable } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeRepoHost } from "../../src/adapters/fake.ts";
import type { LineComment } from "../../src/adapters/types.ts";
import type { Ctx as CellCtx } from "./pbi-18.steps.ts";

const REPO = "acme/app";
const BRANCH = "factory/pbi-482-r1";
const PR = 57;
const BOT = "factory[bot]";
const REVIEWER = "factory-pr-reviewer";
const ADDRESSER = "factory-pr-addresser";
const MAX_REVIEWS = 15; // a safety stop, so an engine that never ends the stage can't loop forever

type Finding = { path: string; line: number; body: string };
type Verdict = { settled: boolean; reason: string };
type ReviewSpec = { findings: Finding[]; verdicts: Map<string, Verdict>; clean: boolean };
type Action = { kind: "fix" } | { kind: "reply"; body: string };
type AddressSpec = { actions: Map<string, Action> };
type Host = ReturnType<typeof fakeRepoHost>;
type ThreadState = { threadId: string; resolved: boolean; bodies: string[] };
type AgentRecord = {
  stage: string; agent?: string; prompt: string; mode: string; index: number;
  head: string; originHead: string;
};

type Ctx = {
  host: Host;
  /** The factory's threads, in the order its reviews opened them. */
  threads: { threadId: string; body: string; path: string; line: number }[];
  personThreads: { threadId: string; body: string }[];
  reviews: Map<number, ReviewSpec>;
  /** Threads held from a review on, by finding text. */
  heldFrom: { body: string; from: number; reason: string }[];
  /** A new finding on every review up to this one. 0 when the scenario has none. */
  newFindingsUpTo: number;
  cleanAfterGreensFix: boolean;
  addresses: AddressSpec[];
  /** Replies the addresser gives on every pass, by finding text. */
  replyEachTime: Map<string, string>;
  /** The finding the last step named, which "that thread" and "it" mean. */
  last: string | null;
  /** Where each finding was first reported. */
  raisedAt: Map<string, number>;
  ci: { firstHeadFails: boolean; greensFailing: number; addresserFirstFails: boolean; addresserAllFail: boolean };
  firstChecked: string | null;
  /** The commit CI was told to fail, in the order it was asked about. */
  failedShas: string[];
  agentCalls: AgentRecord[];
  reviewerCalls: AgentRecord[];
  addresserCalls: AgentRecord[];
  addresserShas: string[];
  /** The factory's threads as they stood just before review n + 1, by n. */
  snapshots: Map<number, Map<string, ThreadState>>;
  /** The posted review "that review" means. */
  that: number | null;
};

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function cell(world: object): CellCtx {
  const w = world as { pbi18?: CellCtx };
  assert.ok(w.pbi18, "no run was set up");
  return w.pbi18;
}

function ctx(world: object): Ctx {
  const w = world as { pbi128?: Ctx };
  if (!w.pbi128) w.pbi128 = install(world);
  return w.pbi128;
}

const ORDINALS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };
function ordinal(word: string): number {
  const n = ORDINALS[word] ?? Number(/^(\d+)(st|nd|rd|th)$/.exec(word)?.[1]);
  assert.ok(Number.isInteger(n) && n > 0, `not an ordinal: ${word}`);
  return n;
}

function review(c: Ctx, n: number): ReviewSpec {
  let r = c.reviews.get(n);
  if (!r) c.reviews.set(n, (r = { findings: [], verdicts: new Map(), clean: false }));
  return r;
}

function raise(c: Ctx, n: number, f: Finding) {
  review(c, n).findings.push(f);
  if (!c.raisedAt.has(f.body)) c.raisedAt.set(f.body, n);
  c.last = f.body;
}

function that(c: Ctx): string {
  assert.ok(c.last, "no finding was named before this step");
  return c.last;
}

function newPass(c: Ctx): AddressSpec {
  const a: AddressSpec = { actions: new Map() };
  c.addresses.push(a);
  return a;
}

function currentPass(c: Ctx): AddressSpec {
  return c.addresses.at(-1) ?? newPass(c);
}

function threadsNow(c: Ctx): Map<string, ThreadState> {
  const all = c.host.reviewComments.get(`${REPO}#${PR}`) ?? [];
  const out = new Map<string, ThreadState>();
  for (const t of c.threads) {
    const cs = all.filter((x) => x.threadId === t.threadId);
    out.set(t.threadId, { threadId: t.threadId, resolved: cs.length > 0 && cs.every((x) => x.resolved), bodies: cs.map((x) => x.body) });
  }
  return out;
}

/** The factory's open threads whose id the brief holds. */
function threadsInBrief(c: Ctx, prompt: string) {
  const now = threadsNow(c);
  return c.threads.filter((t) => !now.get(t.threadId)!.resolved && prompt.includes(t.threadId));
}

function greenStarts(run: CellCtx): number {
  return run.calls.filter((x) => x.route === "/stage" && x.body.stageId === "green" && x.body.status === "started").length;
}

// Sets up the repo host, CI and the scripted agents on PBI 18's run. Called by the first step that needs them.
function install(world: object): Ctx {
  const run = cell(world);
  const host = fakeRepoHost();
  host.prs.push({
    number: PR, repo: REPO, branch: BRANCH, base: "main", title: "Item 482", body: "", headSha: null, open: true, merged: false,
    mergeSha: null, mergeable: true, reviewers: [], comments: [], reviews: [],
  });
  const c: Ctx = {
    host, threads: [], personThreads: [], reviews: new Map(), heldFrom: [], newFindingsUpTo: 0, cleanAfterGreensFix: false,
    addresses: [], replyEachTime: new Map(), last: null, raisedAt: new Map(),
    ci: { firstHeadFails: false, greensFailing: 0, addresserFirstFails: false, addresserAllFail: false },
    firstChecked: null, failedShas: [], agentCalls: [], reviewerCalls: [], addresserCalls: [], addresserShas: [], snapshots: new Map(), that: null,
  };
  let seq = 0;
  run.repoHost = new Proxy(host, {
    get(target, key, receiver) {
      if (key === "openOrUpdatePr") {
        return async (p: Parameters<Host["openOrUpdatePr"]>[0]) => { run.prBodies.push(p.body); return target.openOrUpdatePr(p); };
      }
      if (key === "postReview") {
        return async (p: Parameters<Host["postReview"]>[0]) => {
          await target.postReview(p);
          const key = `${p.repo}#${p.prNumber}`;
          const list = target.reviewComments.get(key) ?? [];
          const opened = (p.comments ?? []).map((lc: LineComment) => {
            const t = { threadId: `FT-${++seq}`, path: lc.path, line: lc.line, body: lc.body };
            list.push({ ...t, author: BOT, submittedAt: new Date().toISOString() });
            if (p.repo === REPO && p.prNumber === PR) c.threads.push(t);
            return t;
          });
          target.reviewComments.set(key, list);
          return { threads: opened };
        };
      }
      return Reflect.get(target, key, receiver);
    },
  }) as unknown as Record<string, unknown>;

  run.checks = async (sha: string) => {
    c.firstChecked ??= sha;
    const fromAddresser = c.addresserShas.includes(sha);
    const fail = (c.ci.firstHeadFails && sha === c.firstChecked)
      || (c.ci.greensFailing > 0 && !fromAddresser && greenStarts(run) <= c.ci.greensFailing)
      || (c.ci.addresserFirstFails && sha === c.addresserShas[0])
      || (c.ci.addresserAllFail && fromAddresser);
    if (fail && !c.failedShas.includes(sha)) c.failedShas.push(sha);
    return fail ? "failure" : "success";
  };

  run.wrapAgent = (base) => async (a) => {
    const rec: AgentRecord = {
      stage: run.stage, agent: a.agent, prompt: a.prompt, mode: a.mode, index: run.calls.length,
      head: git(a.cwd, "rev-parse", "HEAD"), originHead: git(run.root, "--git-dir", run.origin, "rev-parse", BRANCH),
    };
    c.agentCalls.push(rec);
    const answer = (text: string) => ({ ok: true, text, costUsd: 0.5, tokensIn: 10, tokensOut: 5, model: a.model, limit: null, usage: null, transcript: "{}\n" });
    if (a.agent === REVIEWER) return answer(reviewer(c, run, rec));
    if (a.agent === ADDRESSER) return answer(addresser(c, rec, a.cwd));
    const r = await base(a);
    // Each Green attempt leaves a commit of its own, so a fix after failed CI has a new head.
    if (run.stage === "green" && a.mode !== "judge") writeFileSync(join(a.cwd, "green.txt"), `attempt ${greenStarts(run)}\n`);
    return r;
  };
  return c;
}

function reviewer(c: Ctx, run: CellCtx, rec: AgentRecord): string {
  const n = c.reviewerCalls.length + 1;
  if (n > MAX_REVIEWS) throw new Error(`the PR reviewer was asked for a review ${n} times`);
  if (n > 1) c.snapshots.set(n - 1, threadsNow(c));
  c.reviewerCalls.push(rec);
  const spec = c.reviews.get(n);
  const clean = (spec?.clean ?? false) || (c.cleanAfterGreensFix && greenStarts(run) >= 2);
  const lines: string[] = [];
  let open = 0;
  for (const t of threadsInBrief(c, rec.prompt)) {
    const held = clean ? undefined : spec?.verdicts.get(t.body) ?? (() => {
      const rule = c.heldFrom.find((h) => h.body === t.body && n >= h.from);
      return rule ? { settled: false, reason: rule.reason } : undefined;
    })();
    const v: Verdict = held ?? { settled: true, reason: "The head settles this." };
    if (!v.settled) open++;
    lines.push(JSON.stringify({ thread: t.threadId, settled: v.settled, reason: v.reason }));
  }
  const findings = clean ? [] : [...(spec?.findings ?? [])];
  if (!clean && n <= c.newFindingsUpTo && !spec?.findings.length) findings.push({ path: `src/part${n}.ts`, line: n, body: `Round ${n}: this case isn't handled.` });
  for (const f of findings) lines.push(JSON.stringify({ finding: f.body, path: f.path, line: f.line }));
  open += findings.length;
  lines.push(open === 0 ? "APPROVED" : `OPEN: ${open}`);
  return lines.join("\n");
}

function addresser(c: Ctx, rec: AgentRecord, cwd: string): string {
  const k = c.addresserCalls.length;
  c.addresserCalls.push(rec);
  const spec = c.addresses[k];
  const replyFile = /reply file is `([^`]+)`/.exec(rec.prompt)?.[1];
  const fixed: string[] = [];
  for (const t of threadsInBrief(c, rec.prompt)) {
    const action: Action = spec?.actions.get(t.body)
      ?? (c.replyEachTime.has(t.body) ? { kind: "reply", body: c.replyEachTime.get(t.body)! } : { kind: "fix" });
    if (action.kind === "fix") fixed.push(t.body);
    else if (replyFile) appendFileSync(replyFile, JSON.stringify({ threadId: t.threadId, body: action.body }) + "\n");
  }
  if (fixed.length) {
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", `fix-${k + 1}.txt`), fixed.join("\n") + "\n");
    git(cwd, "add", "-A");
    git(cwd, "commit", "-q", "-m", `address the PR review, pass ${k + 1}`);
    c.addresserShas.push(git(cwd, "rev-parse", "HEAD"));
  }
  return fixed.length ? `Fixed: ${fixed.join("; ")}` : "Replied on each thread.";
}

// ---- Givens: CI ----

Given("CI passes on every commit unless a scenario says otherwise", function () {
  ctx(this);
});

Given("CI fails on the PR's first head and passes after Green's fix", function () {
  ctx(this).ci.firstHeadFails = true;
});

Given("CI fails on the PR's head after each of Green's first {int} attempts, and passes after its 4th", function (n: number) {
  ctx(this).ci.greensFailing = n;
});

Given("CI fails on the addresser's first fix", function () {
  ctx(this).ci.addresserFirstFails = true;
});

Given("CI fails on every commit the PR addresser makes, and passes on every other", function () {
  ctx(this).ci.addresserAllFail = true;
});

// ---- Givens: a person's thread ----

Given("a trusted person has an open thread {string} on the PR", function (body: string) {
  const c = ctx(this);
  const threadId = `PT-${c.personThreads.length + 1}`;
  const list = c.host.reviewComments.get(`${REPO}#${PR}`) ?? [];
  list.push({ threadId, path: "src/totals.ts", line: 3, author: "owner", body, submittedAt: new Date(Date.now() - 3_600_000).toISOString() });
  c.host.reviewComments.set(`${REPO}#${PR}`, list);
  c.personThreads.push({ threadId, body });
});

// ---- Givens: the PR reviewer ----

const ORD = "(first|second|third|fourth|fifth|\\d+(?:st|nd|rd|th))";

Given(new RegExp(`^the PR reviewer finds nothing on its ${ORD} review$`), function (which: string) {
  review(ctx(this), ordinal(which)).clean = true;
});

Given("the PR reviewer finds nothing new and every thread fixed on its {int}th review", function (n: number) {
  review(ctx(this), n).clean = true;
});

Given("the PR reviewer reports these findings on its first review:", function (table: DataTable) {
  const c = ctx(this);
  for (const r of table.hashes()) raise(c, 1, { path: r.path, line: Number(r.line), body: r.finding });
});

Given(new RegExp(`^the PR reviewer reports a finding "([^"]*)" on line (\\d+) of "([^"]*)" on its ${ORD} review$`),
  function (body: string, line: string, path: string, which: string) {
    raise(ctx(this), ordinal(which), { path, line: Number(line), body });
  });

Given(new RegExp(`^the PR reviewer reports a finding "([^"]*)" on line (\\d+) of "([^"]*)" on its ${ORD} review, and finds the first one fixed$`),
  function (body: string, line: string, path: string, which: string) {
    const c = ctx(this);
    const n = ordinal(which);
    const first = [...c.raisedAt.entries()].find(([, at]) => at < n)?.[0];
    assert.ok(first, "no earlier finding to find fixed");
    review(c, n).verdicts.set(first, { settled: true, reason: "Fixed at this head." });
    raise(c, n, { path, line: Number(line), body });
  });

Given(new RegExp(`^the PR reviewer (?:finds that thread fixed|accepts that reply) on its ${ORD} review, with no new finding$`), function (which: string) {
  const c = ctx(this);
  review(c, ordinal(which)).verdicts.set(that(c), { settled: true, reason: "Settled at this head." });
});

Given("the PR reviewer finds both threads fixed on its second review, with no new finding", function () {
  // Every thread is settled unless a step holds it, so "both" needs no verdict of its own.
  review(ctx(this), 2);
});

Given(new RegExp(`^the PR reviewer holds that thread on its ${ORD} review, saying "([^"]*)"(?:, with no new finding)?$`), function (which: string, reason: string) {
  const c = ctx(this);
  review(c, ordinal(which)).verdicts.set(that(c), { settled: false, reason });
});

Given("the PR reviewer holds that thread on every later review, saying {string}", function (reason: string) {
  const c = ctx(this);
  const body = that(c);
  c.heldFrom.push({ body, from: (c.raisedAt.get(body) ?? 1) + 1, reason });
});

Given("on its second review the PR reviewer finds {string} fixed, accepts the reply on {string}, and holds {string}, saying {string}",
  function (fixed: string, accepted: string, held: string, reason: string) {
    const r = review(ctx(this), 2);
    r.verdicts.set(fixed, { settled: true, reason: "Fixed at this head." });
    r.verdicts.set(accepted, { settled: true, reason: "The reply holds." });
    r.verdicts.set(held, { settled: false, reason });
    ctx(this).last = held;
  });

Given("the PR reviewer finds {string} fixed on its second review, and holds {string} on every review, with no new finding", function (fixed: string, held: string) {
  const c = ctx(this);
  review(c, 2).verdicts.set(fixed, { settled: true, reason: "Fixed at this head." });
  c.heldFrom.push({ body: held, from: 2, reason: "The name still hides that it's net of VAT." });
  c.last = held;
});

Given("the PR reviewer reports a new finding on every review, and the PR addresser fixes each one with a new commit", function () {
  ctx(this).newFindingsUpTo = MAX_REVIEWS;
});

Given("the PR reviewer reports a new finding on each of its first {int} reviews, and the PR addresser fixes each one with a new commit", function (n: number) {
  ctx(this).newFindingsUpTo = n;
});

Given("the PR reviewer finds nothing open on its review after Green's fix", function () {
  ctx(this).cleanAfterGreensFix = true;
});

// ---- Givens: the PR addresser ----

Given(/^the PR addresser (?:fixes it|fixes both|fixes it again|then fixes it) with a new commit$/, function () {
  newPass(ctx(this));
});

Given(/^the PR addresser fixes "([^"]*)"(?: and "([^"]*)")?(?: again)? with a new commit$/, function (a: string, b: string | undefined) {
  const pass = newPass(ctx(this));
  for (const body of [a, b]) if (body) pass.actions.set(body, { kind: "fix" });
});

Given(/^the PR addresser replies "([^"]*)" on that thread(?:, with no code change)?$/, function (reply: string) {
  const c = ctx(this);
  newPass(c).actions.set(that(c), { kind: "reply", body: reply });
});

Given("the PR addresser replies {string} on the thread for {string}", function (reply: string, body: string) {
  currentPass(ctx(this)).actions.set(body, { kind: "reply", body: reply });
});

Given("the PR addresser replies {string} on that thread each time, with no code change", function (reply: string) {
  const c = ctx(this);
  c.replyEachTime.set(that(c), reply);
});

Given("the PR addresser replies {string} on the thread for {string} each time, with no code change", function (reply: string, body: string) {
  ctx(this).replyEachTime.set(body, reply);
});

// ---- Thens ----

function done(world: object): { c: Ctx; run: CellCtx } {
  const run = cell(world);
  assert.equal(run.error, null, `the cell failed: ${String(run.error)}`);
  return { c: ctx(world), run };
}

function reviewerCall(c: Ctx, n: number): AgentRecord {
  const r = c.reviewerCalls[n - 1];
  assert.ok(r, `the PR reviewer ran ${c.reviewerCalls.length} times, so it has no review ${n}`);
  return r;
}

function posted(c: Ctx) {
  return c.host.postedReviews.filter((r) => r.repo === REPO && r.prNumber === PR);
}

function postedReview(c: Ctx, n: number) {
  const all = posted(c);
  const r = all[n - 1];
  assert.ok(r, `the factory posted ${all.length} reviews on the PR, so it has no review ${n}`);
  return r;
}

function choose(world: object, c: Ctx, n: number) {
  c.that = n;
  (world as { reviewUnderTest?: () => Record<string, unknown> }).reviewUnderTest = () => {
    const r = postedReview(c, n);
    return { commit_id: r.commitSha, body: r.body, comments: r.comments, event: r.event };
  };
}

function thatReview(c: Ctx) {
  assert.ok(c.that, "no review was named before this step");
  return postedReview(c, c.that);
}

function threadFor(c: Ctx, body: string) {
  const t = c.threads.find((x) => x.body === body);
  assert.ok(t, `the factory opened no thread for "${body}"; its threads are ${JSON.stringify(c.threads.map((x) => x.body))}`);
  return t;
}

function stateAt(c: Ctx, after: number, threadId: string): ThreadState {
  return (c.snapshots.get(after) ?? threadsNow(c)).get(threadId)!;
}

function stageReports(run: CellCtx, stageId: string) {
  return run.calls.map((x, i) => ({ ...x, i })).filter((x) => x.route === "/stage" && x.body.stageId === stageId);
}

function question(run: CellCtx): string {
  const t = run.calls.filter((x) => x.route === "/transition").at(-1);
  assert.ok(t, "the cell sent no transition");
  assert.equal(t.body.event, "blocked", `the last transition is ${t.body.event}, not a move to NeedsInput`);
  return String(t.body.question?.body ?? "");
}

const greenBriefs = (c: Ctx) => c.agentCalls.filter((a) => a.stage === "green" && a.mode !== "judge" && !a.prompt.startsWith("# Definition of Done"));

Then("the PR review ran the agent {string}", function (name: string) {
  const { c } = done(this);
  const calls = c.agentCalls.filter((a) => a.stage === "pr-review");
  assert.ok(calls.length > 0, "the PR review stage made no agent call");
  assert.ok(calls.some((a) => a.agent === name), `the PR review's agents are ${JSON.stringify(calls.map((a) => a.agent))}`);
});

Then("the PR reviewer's brief names the PR's head commit as the one to review", function () {
  const { c } = done(this);
  const r = reviewerCall(c, 1);
  assert.equal(r.head, r.originHead, "the PR reviewer ran at a commit that wasn't the PR's pushed head");
  assert.ok(r.prompt.includes(r.originHead), `the PR reviewer's brief doesn't name the PR's head ${r.originHead}`);
});

Then("the PR reviewer's brief names the PR it reviews", function () {
  const { c } = done(this);
  assert.match(reviewerCall(c, 1).prompt, new RegExp(`(#|PR |pull/)${PR}(?!\\d)`), `the PR reviewer's brief doesn't name PR #${PR}`);
});

Then("the item was still InProgress when the PR reviewer ran", function () {
  const { c, run } = done(this);
  const r = reviewerCall(c, 1);
  const moved = run.calls.slice(0, r.index).filter((x) => x.route === "/transition");
  assert.deepEqual(moved.map((x) => x.body.event), [], "the item had moved before the PR reviewer ran");
});

Then("the item moved to InReview after the PR review stage ended", function () {
  const { run } = done(this);
  const ended = stageReports(run, "pr-review").filter((x) => x.body.status === "passed").at(-1);
  assert.ok(ended, "the PR review stage never passed");
  const moves = run.calls.map((x, i) => ({ ...x, i })).filter((x) => x.route === "/transition" && x.body.event === "pr_opened");
  assert.ok(moves.length > 0, "the item never moved to InReview");
  assert.ok(moves.every((m) => m.i > ended.i), "the item moved to InReview before the PR review stage ended");
});

Then("the PR reviewer never reviewed the commit CI failed on", function () {
  const { c } = done(this);
  const failed = c.failedShas[0];
  assert.ok(failed, "CI failed on no commit");
  assert.ok(c.reviewerCalls.length > 0, "the PR reviewer never ran");
  assert.ok(c.reviewerCalls.every((r) => r.head !== failed && !r.prompt.includes(failed)), `the PR reviewer reviewed ${failed}, which CI failed on`);
});

// ---- the reviews the factory posts ----

Then("the first review the factory posted on the PR is at the commit the PR reviewer reviewed first", function () {
  const { c } = done(this);
  choose(this, c, 1);
  assert.equal(postedReview(c, 1).commitSha, reviewerCall(c, 1).head);
});

Then("that review has exactly {int} line comments", function (n: number) {
  const { c } = done(this);
  assert.equal(thatReview(c).comments.length, n, `that review's line comments are ${JSON.stringify(thatReview(c).comments)}`);
});

Then("that review only comments", function () {
  const { c } = done(this);
  assert.equal(thatReview(c).event, "COMMENT");
});

Then("the factory posted one review per round on the PR", function () {
  const { c } = done(this);
  assert.ok(c.reviewerCalls.length > 0, "the PR reviewer never ran");
  assert.equal(posted(c).length, c.reviewerCalls.length, `the PR reviewer ran ${c.reviewerCalls.length} times`);
});

Then("each review the factory posted is at the commit that round reviewed", function () {
  const { c } = done(this);
  assert.deepEqual(posted(c).map((r) => r.commitSha), c.reviewerCalls.map((r) => r.head));
});

Then("the second review is at the addresser's new commit, not at the PR's first head", function () {
  const { c } = done(this);
  const fix = c.addresserShas[0];
  assert.ok(fix, "the PR addresser made no commit");
  assert.equal(postedReview(c, 2).commitSha, fix);
  assert.notEqual(postedReview(c, 2).commitSha, reviewerCall(c, 1).head);
});

Then("the second review has exactly {int} line comment, {string}, on line {int} of {string}", function (n: number, body: string, line: number, path: string) {
  const { c } = done(this);
  assert.deepEqual(postedReview(c, 2).comments, Array.from({ length: n }, () => ({ path, line, body })));
});

Then("the factory posted one review on the PR, at the commit the PR reviewer reviewed", function () {
  const { c } = done(this);
  choose(this, c, 1);
  assert.equal(posted(c).length, 1, `the factory posted ${posted(c).length} reviews on the PR`);
  assert.equal(postedReview(c, 1).commitSha, reviewerCall(c, 1).head);
});

// ---- the addresser and the reviewer's later briefs ----

Then("the PR addresser ran in this cell, after the first review", function () {
  const { c } = done(this);
  const first = reviewerCall(c, 1);
  assert.ok(c.addresserCalls.some((a) => a.index >= first.index && c.agentCalls.indexOf(a) > c.agentCalls.indexOf(first)), "the PR addresser didn't run after the first review");
});

Then("the PR addresser's brief holds {string}", function (text: string) {
  const { c } = done(this);
  assert.ok(c.addresserCalls.length > 0, "the PR addresser never ran");
  assert.ok(c.addresserCalls[0].prompt.includes(text), `the PR addresser's brief lacks "${text}"`);
});

Then("the addresser ran the agent {string}", function (name: string) {
  const { c } = done(this);
  // Any call the PR review stage makes, other than the PR reviewer's and a Definition of Done judge's, is the addresser's.
  const calls = c.agentCalls.filter((a) => a.stage === "pr-review" && a.agent !== REVIEWER && a.mode !== "judge" && !a.prompt.startsWith("# Definition of Done"));
  assert.ok(calls.length > 0, "the PR review stage ran no addresser");
  assert.ok(calls.every((a) => a.agent === name), `the addresser ran as ${JSON.stringify(calls.map((a) => a.agent))}`);
});

Then("the item never left InProgress between the first review and the addresser's fix", function () {
  const { c, run } = done(this);
  const first = reviewerCall(c, 1);
  const fixed = reviewerCall(c, 2);
  assert.ok(c.addresserCalls.length > 0, "the PR addresser never ran");
  const moved = run.calls.slice(first.index, fixed.index).filter((x) => x.route === "/transition");
  assert.deepEqual(moved.map((x) => x.body.event), []);
});

Then("the addresser's fix is pushed", function () {
  const { c, run } = done(this);
  const fix = c.addresserShas[0];
  assert.ok(fix, "the PR addresser made no commit");
  const pushed = git(run.root, "--git-dir", run.origin, "rev-parse", BRANCH);
  execFileSync("git", ["--git-dir", run.origin, "merge-base", "--is-ancestor", fix, pushed]);
});

Then("the PR reviewer's second brief names the addresser's new commit as the head to review", function () {
  const { c } = done(this);
  const fix = c.addresserShas[0];
  assert.ok(fix, "the PR addresser made no commit");
  const r = reviewerCall(c, 2);
  assert.equal(r.head, fix);
  assert.ok(r.prompt.includes(fix), `the PR reviewer's second brief doesn't name ${fix}`);
});

Then("the PR reviewer's second brief holds both of its threads, {string} and {string}", function (a: string, b: string) {
  const { c } = done(this);
  const r = reviewerCall(c, 2);
  for (const body of [a, b]) {
    const t = threadFor(c, body);
    assert.ok(r.prompt.includes(t.threadId) && r.prompt.includes(body), `the PR reviewer's second brief lacks the thread for "${body}"`);
  }
});

Then("the thread for {string} holds the reply {string}", function (body: string, reply: string) {
  const { c } = done(this);
  const t = threadFor(c, body);
  const bodies = threadsNow(c).get(t.threadId)!.bodies.slice(1);
  assert.ok(bodies.some((x) => x.includes(reply)), `the thread's replies are ${JSON.stringify(bodies)}`);
});

Then("the PR reviewer's second brief holds that thread with the reply {string}", function (reply: string) {
  const { c } = done(this);
  const r = reviewerCall(c, 2);
  const t = c.threads[0];
  assert.ok(t, "the factory opened no thread");
  assert.ok(r.prompt.includes(t.threadId) && r.prompt.includes(t.body), "the PR reviewer's second brief lacks the thread");
  assert.ok(r.prompt.includes(reply), `the PR reviewer's second brief lacks the reply "${reply}"`);
});

Then("the PR reviewer ran once", function () {
  const { c } = done(this);
  assert.equal(c.reviewerCalls.length, 1);
});

Then("the PR reviewer ran {int} times", function (n: number) {
  const { c } = done(this);
  assert.equal(c.reviewerCalls.length, n);
});

Then("the PR addresser didn't run", function () {
  const { c } = done(this);
  assert.equal(c.addresserCalls.length, 0);
});

Then("the PR reviewer's second brief holds the thread {string} as one of its own", function (body: string) {
  const { c } = done(this);
  const t = threadFor(c, body);
  const r = reviewerCall(c, 2);
  assert.ok(r.prompt.includes(t.threadId) && r.prompt.includes(body), `the PR reviewer's second brief lacks its thread for "${body}"`);
});

Then("the PR reviewer's second brief doesn't hold {string} as one of its own threads", function (body: string) {
  const { c } = done(this);
  const p = c.personThreads.find((x) => x.body === body);
  assert.ok(p, `no person's thread "${body}"`);
  assert.ok(!reviewerCall(c, 2).prompt.includes(p.threadId), `the PR reviewer's second brief holds the person's thread ${p.threadId}`);
});

// ---- resolving threads ----

function resolved(c: Ctx, threadId: string): boolean {
  return c.host.resolvedThreads.some((r) => r.repo === REPO && r.threadId === threadId) && threadsNow(c).get(threadId)?.resolved === true;
}

Then("the factory resolved the thread for {string}", function (body: string) {
  const { c } = done(this);
  assert.ok(resolved(c, threadFor(c, body).threadId), `the thread for "${body}" isn't resolved`);
});

Then("after the second review the thread for {string} was still open", function (body: string) {
  const { c } = done(this);
  reviewerCall(c, 2);
  c.last = body;
  assert.equal(stateAt(c, 2, threadFor(c, body).threadId).resolved, false, `the thread for "${body}" was resolved after the second review`);
});

Then("that thread holds a reply from the factory saying {string}", function (reason: string) {
  const { c } = done(this);
  const t = threadFor(c, that(c));
  const replies = (c.host.reviewComments.get(`${REPO}#${PR}`) ?? []).filter((x) => x.threadId === t.threadId).slice(1);
  assert.ok(replies.some((x) => x.author === BOT && x.body.includes(reason)), `the thread's replies are ${JSON.stringify(replies.map((x) => x.body))}`);
});

Then("the factory resolved that thread only after the third review", function () {
  const { c } = done(this);
  const t = threadFor(c, that(c));
  reviewerCall(c, 3);
  assert.equal(stateAt(c, 2, t.threadId).resolved, false, "the thread was resolved before the third review");
  assert.ok(resolved(c, t.threadId), "the thread was never resolved");
});

Then("after the second review the threads for {string} and {string} were resolved", function (a: string, b: string) {
  const { c } = done(this);
  reviewerCall(c, 2);
  for (const body of [a, b]) assert.equal(stateAt(c, 2, threadFor(c, body).threadId).resolved, true, `the thread for "${body}" was open after the second review`);
});

Then("after the second review the thread for {string} was still open, with a reply from the factory saying {string}", function (body: string, reason: string) {
  const { c } = done(this);
  reviewerCall(c, 2);
  const s = stateAt(c, 2, threadFor(c, body).threadId);
  assert.equal(s.resolved, false, `the thread for "${body}" was resolved after the second review`);
  assert.ok(s.bodies.slice(1).some((x) => x.includes(reason)), `the thread's replies are ${JSON.stringify(s.bodies.slice(1))}`);
});

Then("the thread {string} is still open", function (body: string) {
  const { c } = done(this);
  const p = c.personThreads.find((x) => x.body === body);
  assert.ok(p, `no person's thread "${body}"`);
  assert.ok(!c.host.resolvedThreads.some((r) => r.threadId === p.threadId), "the factory resolved the person's thread");
  assert.ok((c.host.reviewComments.get(`${REPO}#${PR}`) ?? []).filter((x) => x.threadId === p.threadId).every((x) => !x.resolved));
});

Then("the thread for {string} is still open", function (body: string) {
  const { c } = done(this);
  const t = threadFor(c, body);
  assert.equal(threadsNow(c).get(t.threadId)!.resolved, false, `the thread for "${body}" is resolved`);
});

// ---- the stage's end ----

Then("the PR review stage passed", function () {
  const { run } = done(this);
  const reports = stageReports(run, "pr-review");
  assert.ok(reports.length > 0, "the PR review stage never ran");
  assert.equal(reports.at(-1)!.body.status, "passed");
});

Then("the PR body still holds {string}", function (text: string) {
  const { run } = done(this);
  assert.ok(run.prBodies.length > 0, "no PR was opened");
  assert.ok(run.prBodies.at(-1)!.includes(text), `the PR body lacks "${text}"`);
});

Then("the PR addresser replied on that thread {int} times", function (n: number) {
  const { c } = done(this);
  const body = that(c);
  const reply = c.replyEachTime.get(body) ?? [...c.addresses.flatMap((a) => [...a.actions.entries()])].find(([b, x]) => b === body && x.kind === "reply")?.[1];
  const text = typeof reply === "string" ? reply : reply && "body" in reply ? reply.body : null;
  assert.ok(text, "the scenario gave the addresser no reply on that thread");
  const replies = threadsNow(c).get(threadFor(c, body).threadId)!.bodies.slice(1).filter((x) => x.includes(text));
  assert.equal(replies.length, n);
});

Then("the item moves to NeedsInput, with a question that names the thread for {string}", function (body: string) {
  const { c, run } = done(this);
  threadFor(c, body);
  const q = question(run);
  assert.ok(q.includes(body), `the question doesn't name the thread for "${body}": ${q}`);
});

Then("the question doesn't name the thread for {string}", function (body: string) {
  const { c, run } = done(this);
  const t = threadFor(c, body);
  const q = question(run);
  assert.ok(!q.includes(body) && !q.includes(t.threadId), `the question names the thread for "${body}": ${q}`);
});

Then("the item moves to NeedsInput, with a question that names each of the factory's threads still open", function () {
  const { c, run } = done(this);
  const now = threadsNow(c);
  const open = c.threads.filter((t) => !now.get(t.threadId)!.resolved);
  assert.ok(open.length > 0, "none of the factory's threads is open");
  const q = question(run);
  for (const t of open) assert.ok(q.includes(t.body), `the question doesn't name the thread for "${t.body}": ${q}`);
});

Then("the item never moved to InReview", function () {
  const { run } = done(this);
  assert.ok(!run.calls.some((x) => x.route === "/transition" && x.body.event === "pr_opened"), "the item moved to InReview");
});

// ---- CI on the addresser's fix ----

Then("Green's second brief says CI failed on the addresser's fix", function () {
  const { c } = done(this);
  const fix = c.addresserShas[0];
  assert.ok(fix, "the PR addresser made no commit");
  const second = greenBriefs(c)[1];
  assert.ok(second, `Green had ${greenBriefs(c).length} briefs`);
  assert.match(second.prompt, /CI failed/i, "Green's second brief doesn't say CI failed");
  assert.ok(second.prompt.includes(fix), `Green's second brief doesn't name the addresser's fix ${fix}`);
});

Then("the factory posted no review at the commit CI failed on", function () {
  const { c } = done(this);
  const fix = c.addresserShas[0];
  assert.ok(fix && c.failedShas.includes(fix), "CI failed on no fix of the addresser's");
  assert.ok(!posted(c).some((r) => r.commitSha === fix), `the factory posted a review at ${fix}, which CI failed on`);
});
