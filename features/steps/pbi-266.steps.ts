// Step definitions for features/pbi-266-review-findings-outside-diff.feature. Every scenario runs the engine through
// PBI 18's harness and PBI 128's scripted PR reviewer, PR addresser and fake repo host, with these of its own:
//
// - The PR's diff. The fake repo host answers diffLines with the new-side line ranges the scenario gives for the commit
//   asked about, and records each read with the round it came in.
// - GitHub's 422. The fake repo host turns down, with an error whose status is 422, any review with a line comment on a
//   line outside the PR's diff at the review's commit, and any review the scenario says GitHub turns down. Each try is
//   recorded, landed or not. Only a review that lands opens threads and counts as posted, so "the first review" is the
//   first that landed.
// - Summary findings. A finding the factory puts in a review's summary has no thread on the PR. PBI 128's scripted
//   reviewer and addresser answer one by the id their brief's JSON gives it, as they answer a thread.
//
// A round is one call to the PR reviewer: a try or a diff read belongs to the round of the last review before it.
import { Given, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { DiffRange, LineComment } from "../../src/adapters/types.ts";
import {
  briefEntries, ctx as pr128, done, newPass, ordinal, posted, raise, review, reviewerCall, stageReports, that,
} from "./pbi-128.steps.ts";
import type { Ctx as Pr128 } from "./pbi-128.steps.ts";

type Range = DiffRange;
type Try = { round: number; seq: number; commitSha: string; body: string; comments: LineComment[]; landed: boolean };
type Read = { round: number; seq: number; sha: string };
type Ctx = {
  c: Pr128;
  every: Range[];
  atFirstHead: Range[] | null;
  alsoAtAddresserFirst: Range[];
  rejectFirst: boolean;
  rejectAll: boolean;
  tries: Try[];
  reads: Read[];
};

const ORD = "(first|second|third|fourth|fifth)";

function ctx(world: object): Ctx {
  const w = world as { pbi266?: Ctx };
  if (!w.pbi266) w.pbi266 = install(world);
  return w.pbi266;
}

function install(world: object): Ctx {
  const c = pr128(world);
  const run = (world as { pbi18?: { repoHost: unknown } }).pbi18!;
  const s: Ctx = { c, every: [], atFirstHead: null, alsoAtAddresserFirst: [], rejectFirst: false, rejectAll: false, tries: [], reads: [] };
  let seq = 0;
  const diffAt = (sha: string): Range[] => {
    let ranges = s.atFirstHead && sha === c.firstChecked ? s.atFirstHead : s.every;
    if (c.addresserShas[0] !== undefined && sha === c.addresserShas[0]) ranges = [...ranges, ...s.alsoAtAddresserFirst];
    return ranges.map((r) => ({ ...r }));
  };
  const placed = (sha: string, lc: LineComment) => diffAt(sha).some((r) => r.path === lc.path && lc.line >= r.from && lc.line <= r.to);
  const inner = run.repoHost as Record<string, unknown>;
  run.repoHost = new Proxy(inner, {
    get(target, key, receiver) {
      if (key === "diffLines") {
        return async (_repo: string, _prNumber: number, commitSha: string) => {
          s.reads.push({ round: c.reviewerCalls.length, seq: ++seq, sha: commitSha });
          return diffAt(commitSha);
        };
      }
      if (key === "postReview") {
        return async (p: { repo: string; prNumber: number; commitSha: string; body: string; comments: LineComment[] }) => {
          const forced = s.rejectAll || (s.rejectFirst && s.tries.length === 0);
          const off = (p.comments ?? []).filter((lc) => !placed(p.commitSha, lc));
          const t: Try = { round: c.reviewerCalls.length, seq: ++seq, commitSha: p.commitSha, body: p.body,
            comments: (p.comments ?? []).map(({ path, line, body }) => ({ path, line, body })), landed: false };
          s.tries.push(t);
          if (forced || off.length) {
            throw Object.assign(new Error(`Unprocessable Entity: "Line could not be resolved"${off.length ? ` for ${off.map((x) => `${x.path} line ${x.line}`).join(", ")}` : ""}`), { status: 422 });
          }
          const r = await (target.postReview as (x: typeof p) => Promise<unknown>)(p);
          t.landed = true;
          return r;
        };
      }
      return Reflect.get(target, key, receiver);
    },
  });
  return s;
}

const triesOf = (s: Ctx, round: number) => s.tries.filter((t) => t.round === round);

function landedFor(s: Ctx, round: number): Try {
  const t = triesOf(s, round).find((x) => x.landed);
  assert.ok(t, `no review landed for round ${round}; the tries were ${JSON.stringify(triesOf(s, round))}`);
  return t;
}

/**
 * Names the posted review "that review" means: PBI 128 keeps its 1-based place among the reviews that landed, and
 * PBI 129's "that review" Thens read it through `reviewUnderTest`, in GitHub's request shape.
 */
function setThat(world: object, s: Ctx, n: number) {
  s.c.that = n;
  (world as { reviewUnderTest?: () => Record<string, unknown> }).reviewUnderTest = () => {
    const r = nth(s, n);
    return { commit_id: r.commitSha, body: r.body, comments: r.comments, event: r.event };
  };
}

function nth(s: Ctx, n: number) {
  const all = posted(s.c);
  const r = all[n - 1];
  assert.ok(r, `${all.length} reviews landed on the PR, so it has no review ${n}`);
  return r;
}

function thatOne(s: Ctx) {
  assert.ok(s.c.that, "no review was named before this step");
  return nth(s, s.c.that);
}

function bullets(body: string): string[] {
  return body.split("\n").filter((l) => /^\s*[-*]\s+/.test(l));
}

function assertBullet(body: string, place: string, text: string) {
  assert.ok(bullets(body).some((b) => b.includes(place) && b.includes(text)),
    `the review's summary holds no bullet naming "${place}" and "${text}":\n${body}`);
}

function entryFor(prompt: string, text: string) {
  return briefEntries(prompt).filter((x) => x.finding === text || x.body === text);
}

function holdsAt(prompt: string, text: string, place: string, who: string) {
  const ok = entryFor(prompt, text).some((x) => `${String(x.path)}:${String(x.line)}` === place || JSON.stringify(x).includes(place));
  assert.ok(ok, `${who} doesn't hold "${text}" on "${place}"`);
}

function stageMessage(world: object): string {
  const { run } = done(world);
  const ended = stageReports(run, "pr-review").filter((x) => x.body.status !== "started").at(-1);
  assert.ok(ended, "the pr-review stage never ended");
  return String(ended.body.message ?? "");
}

/** The paragraphs of the stage message that speak of the review's summary. */
function summaryParts(msg: string): string[] {
  return msg.split(/\n\s*\n/).filter((p) => /summary/i.test(p));
}

// ---- Givens: the PR's diff ----

Given("the PR's diff at every head covers lines {int} to {int} of {string} and lines {int} to {int} of {string}, unless a scenario says otherwise",
  function (a1: number, a2: number, pa: string, b1: number, b2: number, pb: string) {
    ctx(this).every = [{ path: pa, from: a1, to: a2 }, { path: pb, from: b1, to: b2 }];
  });

Given("the PR's diff at the PR's first head covers lines {int} to {int} of {string}", function (from: number, to: number, path: string) {
  ctx(this).atFirstHead = [{ path, from, to }];
});

Given("the PR's diff at the addresser's first commit also covers lines {int} to {int} of {string}", function (from: number, to: number, path: string) {
  ctx(this).alsoAtAddresserFirst.push({ path, from, to });
});

// ---- Givens: GitHub's 422 ----

Given("GitHub turns down the first review the factory posts with a 422, though every finding's line is in the PR's diff", function () {
  ctx(this).rejectFirst = true;
});

Given("GitHub turns down every review the factory posts with a 422", function () {
  ctx(this).rejectAll = true;
});

// ---- Givens: the PR reviewer and the PR addresser ----

Given(new RegExp(`^the PR reviewer finds (that finding|all three|both) fixed on its ${ORD} review, with no new finding$`), function (what: string, which: string) {
  const s = ctx(this);
  const r = review(s.c, ordinal(which));
  // The scripted reviewer settles every finding no step holds, so "all three" and "both" need no verdict of their own.
  if (what === "that finding") r.verdicts.set(that(s.c), { settled: true, reason: "Fixed at this head." });
});

Given(new RegExp(`^the PR reviewer finds that finding fixed on its ${ORD} review, and reports a finding "([^"]*)" on line (\\d+) of "([^"]*)"$`),
  function (which: string, body: string, line: string, path: string) {
    const s = ctx(this);
    const n = ordinal(which);
    review(s.c, n).verdicts.set(that(s.c), { settled: true, reason: "Fixed at this head." });
    raise(s.c, n, { path, line: Number(line), body });
  });

Given(new RegExp(`^the PR reviewer holds that finding on its ${ORD} review, saying "([^"]*)", with no new finding$`), function (which: string, reason: string) {
  const s = ctx(this);
  review(s.c, ordinal(which)).verdicts.set(that(s.c), { settled: false, reason });
});

Given("the PR addresser fixes all three with a new commit", function () {
  newPass(ctx(this).c);
});

Given("the PR addresser replies {string} to that finding, with no code change", function (reply: string) {
  const s = ctx(this);
  newPass(s.c).actions.set(that(s.c), { kind: "reply", body: reply });
});

// ---- Thens: reading the diff ----

Then(new RegExp(`^before posting its ${ORD} review the factory read the PR's diff at (the commit the PR reviewer reviewed first|the addresser's (?:new|first) commit)$`),
  function (which: string, at: string) {
    const s = ctx(this);
    done(this);
    const n = ordinal(which);
    const sha = at.startsWith("the commit") ? reviewerCall(s.c, 1).head : s.c.addresserShas[0];
    assert.ok(sha, "the PR addresser made no commit");
    reviewerCall(s.c, n);
    const first = triesOf(s, n)[0];
    assert.ok(first, `the factory tried to post no review for round ${n}`);
    const read = s.reads.some((r) => r.round === n && r.sha === sha && r.seq < first.seq);
    assert.ok(read, `the factory didn't read the PR's diff at ${sha} before posting round ${n}'s review; its reads were ${JSON.stringify(s.reads)}`);
  });

// ---- Thens: the reviews ----

Then("the first review has exactly {int} line comment, {string}, on line {int} of {string}", function (n: number, body: string, line: number, path: string) {
  const s = ctx(this);
  done(this);
  setThat(this, s, 1);
  assert.deepEqual(nth(s, 1).comments, Array.from({ length: n }, () => ({ path, line, body })));
});

Then("the first review the factory posted has exactly {int} line comment, {string}, on line {int} of {string}", function (n: number, body: string, line: number, path: string) {
  const s = ctx(this);
  done(this);
  setThat(this, s, 1);
  assert.deepEqual(nth(s, 1).comments, Array.from({ length: n }, () => ({ path, line, body })));
});

Then("the first review the factory posted is at the commit the PR reviewer reviewed first", function () {
  const s = ctx(this);
  done(this);
  setThat(this, s, 1);
  assert.equal(nth(s, 1).commitSha, reviewerCall(s.c, 1).head);
});

Then("the factory posted a review on the PR at the commit the PR reviewer reviewed first", function () {
  const s = ctx(this);
  done(this);
  setThat(this, s, 1);
  assert.equal(nth(s, 1).commitSha, reviewerCall(s.c, 1).head);
});

Then("the first review the factory posted has no line comments", function () {
  const s = ctx(this);
  done(this);
  setThat(this, s, 1);
  assert.deepEqual(nth(s, 1).comments, []);
});

Then("the review that landed for the first round has no line comments", function () {
  const s = ctx(this);
  done(this);
  const t = landedFor(s, 1);
  setThat(this, s, s.tries.filter((x) => x.landed && x.seq <= t.seq).length);
  assert.deepEqual(thatOne(s).comments, []);
});

Then("that review has no line comment {string}", function (body: string) {
  const s = ctx(this);
  done(this);
  const cs = thatOne(s).comments;
  assert.ok(!cs.some((x) => x.body === body), `that review has a line comment "${body}"`);
});

Then("that review's summary holds a bullet naming {string} and {string}", function (place: string, text: string) {
  const s = ctx(this);
  done(this);
  assertBullet(thatOne(s).body, place, text);
});

Then("that review's summary doesn't hold a bullet for {string}", function (text: string) {
  const s = ctx(this);
  done(this);
  const body = thatOne(s).body;
  assert.ok(!bullets(body).some((b) => b.includes(text)), `that review's summary holds a bullet for "${text}":\n${body}`);
});

Then(new RegExp(`^the ${ORD} review's summary holds a bullet naming "([^"]*)" and "([^"]*)"$`), function (which: string, place: string, text: string) {
  const s = ctx(this);
  done(this);
  const n = ordinal(which);
  setThat(this, s, n);
  assertBullet(nth(s, n).body, place, text);
});

Then(new RegExp(`^the ${ORD} review's summary doesn't hold "([^"]*)"$`), function (which: string, text: string) {
  const s = ctx(this);
  done(this);
  const n = ordinal(which);
  setThat(this, s, n);
  assert.ok(!nth(s, n).body.includes(text), `the review's summary holds "${text}":\n${nth(s, n).body}`);
});

Then("the first review's summary says it is round {int} with {int} new finding", function (round: number, count: number) {
  const s = ctx(this);
  done(this);
  setThat(this, s, 1);
  const body = nth(s, 1).body;
  assert.match(body, new RegExp(`\\bround ${round}\\b`, "i"));
  assert.match(body, new RegExp(`\\b${count} new finding\\b`, "i"));
});

// ---- Thens: the tries ----

Then(/^the factory tried to post the first round's review (\d+) times?(, at the commit the PR reviewer reviewed first)?$/, function (count: string, atFirst: string | undefined) {
  const s = ctx(this);
  done(this);
  reviewerCall(s.c, 1);
  const tries = triesOf(s, 1);
  assert.equal(tries.length, Number(count), `the factory tried ${tries.length} times: ${JSON.stringify(tries)}`);
  if (atFirst) {
    const head = reviewerCall(s.c, 1).head;
    assert.ok(tries.every((t) => t.commitSha === head), `a try wasn't at ${head}: ${JSON.stringify(tries.map((t) => t.commitSha))}`);
  }
});

Then("the second try had no line comments and held {string} in its summary", function (text: string) {
  const s = ctx(this);
  done(this);
  const t = triesOf(s, 1)[1];
  assert.ok(t, "the factory tried to post the first round's review only once");
  assert.deepEqual(t.comments, []);
  assert.ok(t.body.includes(text), `the second try's summary lacks "${text}":\n${t.body}`);
});

// ---- Thens: the briefs ----

Then("the PR addresser's brief holds {string} on {string}", function (text: string, place: string) {
  const s = ctx(this);
  done(this);
  const a = s.c.addresserCalls[0];
  assert.ok(a, "the PR addresser never ran");
  holdsAt(a.prompt, text, place, "the PR addresser's brief");
});

Then("the PR reviewer's second brief holds {string} on {string} as one of its own findings to check", function (text: string, place: string) {
  const s = ctx(this);
  done(this);
  const r = reviewerCall(s.c, 2);
  holdsAt(r.prompt, text, place, "the PR reviewer's second brief");
  assert.ok(entryFor(r.prompt, text).some((x) => typeof x.threadId === "string" && x.threadId !== ""),
    `the PR reviewer's second brief holds "${text}" with no id to answer it by`);
});

Then("the PR reviewer's second brief holds {string} with the reply {string}", function (text: string, reply: string) {
  const s = ctx(this);
  done(this);
  const r = reviewerCall(s.c, 2);
  assert.ok(entryFor(r.prompt, text).some((x) => JSON.stringify(x).includes(JSON.stringify(reply).slice(1, -1))),
    `the PR reviewer's second brief doesn't hold "${text}" with the reply "${reply}"`);
});

Then("the PR addresser's second brief holds {string} with {string}", function (text: string, reason: string) {
  const s = ctx(this);
  done(this);
  const a = s.c.addresserCalls[1];
  assert.ok(a, `the PR addresser ran ${s.c.addresserCalls.length} times`);
  assert.ok(entryFor(a.prompt, text).some((x) => JSON.stringify(x).includes(JSON.stringify(reason).slice(1, -1))),
    `the PR addresser's second brief doesn't hold "${text}" with "${reason}"`);
});

Then("the PR reviewer's third brief doesn't hold {string}", function (text: string) {
  const s = ctx(this);
  done(this);
  assert.ok(!reviewerCall(s.c, 3).prompt.includes(text), `the PR reviewer's third brief holds "${text}"`);
});

// ---- Thens: the stage's end ----

Then("the pr-review stage's message names {string} and {string} as moved to the review's summary", function (a: string, b: string) {
  const parts = summaryParts(stageMessage(this));
  for (const place of [a, b]) assert.ok(parts.some((p) => p.includes(place)), `the stage message doesn't name "${place}" as moved to the summary:\n${parts.join("\n\n")}`);
});

Then("the pr-review stage's message names {string} as moved to the review's summary", function (place: string) {
  const msg = stageMessage(this);
  assert.ok(summaryParts(msg).some((p) => p.includes(place)), `the stage message doesn't name "${place}" as moved to the summary:\n${msg}`);
});

Then("the pr-review stage's message doesn't name {string} as moved to the review's summary", function (place: string) {
  const msg = stageMessage(this);
  assert.ok(summaryParts(msg).length > 0, `the stage message says nothing of the review's summary:\n${msg}`);
  assert.ok(!summaryParts(msg).some((p) => p.includes(place)), `the stage message names "${place}" as moved to the summary:\n${msg}`);
});

Then("the pr-review stage's message says their lines aren't in the PR's diff", function () {
  const msg = stageMessage(this);
  assert.ok(summaryParts(msg).some((p) => /\bdiff\b/i.test(p)), `the stage message doesn't say the lines aren't in the PR's diff:\n${msg}`);
});

Then("the pr-review stage's message says GitHub turned the review down with a 422", function () {
  const msg = stageMessage(this);
  assert.ok(summaryParts(msg).some((p) => /\b422\b/.test(p) && /GitHub/.test(p)), `the stage message doesn't say GitHub turned the review down with a 422:\n${msg}`);
});

Then("the pr-review stage's message doesn't say any finding moved to the review's summary", function () {
  const msg = stageMessage(this);
  assert.deepEqual(summaryParts(msg), [], `the stage message speaks of the review's summary:\n${msg}`);
});
