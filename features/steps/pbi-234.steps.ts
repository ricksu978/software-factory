// Step definitions for features/pbi-234-pending-ci-cap.feature. Every scenario runs the engine through PBI 18's
// harness (its Background step, "the cell runs" and runTheCell), with PBI 128's fake repo host, PR reviewer and PR
// addresser where the run reaches the PR review, and three things of its own:
//
// - A fake clock. The engine's `now` reads it and its `sleep` moves it on, so an hour of polling CI passes at once.
// - Fake CI, by check. Each commit the cell asks about is one of four: the PR's head (the first commit open-pr asks
//   about), Green's fix (a later commit open-pr asks about), the PR addresser's fix (a commit PBI 128's addresser made)
//   or the fix pushed in address (a commit asked about in the address stage). A check the scenario names for that
//   commit stays pending for its minutes, counted from when the cell first asked about the commit, then passes or
//   fails. A commit the scenario says nothing about has one check, "ci", which passes. The cell API's `checks`
//   answers failure when any check failed, pending when any is still pending, and success otherwise, and its
//   `pendingChecks` answers the names of the checks still pending.
// - A safety stop: a commit still pending 4 hours after the cell first asked about it fails the cell with an error,
//   so an engine with no cap ends instead of polling forever.
import { Given, Then } from "@cucumber/cucumber";
import type { DataTable } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { Ctx as CellCtx } from "./pbi-18.steps.ts";
import { ctx as review, done, question, raise, type Ctx as ReviewCtx } from "./pbi-128.steps.ts";

const MIN = 60_000;
const CAP_MS = 60 * MIN;
const POLL_MS = 60_000; // the engine polls CI once a minute
const SAFETY_MS = 4 * 60 * MIN;

type Target = "head" | "green" | "addresser" | "fix";
type Rule = { pendingFor: number; then: "passed" | "failed" };
type Asked = { target: Target; firstAt: number };
type Ctx = {
  run: CellCtx;
  t: number;
  rules: Map<Target, Map<string, Rule>>;
  asked: Map<string, Asked>;
};

const TARGETS: Record<string, Target> = {
  "the PR's head": "head", "Green's fix": "green", "the PR addresser's fix": "addresser", "the fix": "fix",
};

function cell(world: object): CellCtx {
  const w = world as { pbi18?: CellCtx };
  assert.ok(w.pbi18, "no run was set up");
  return w.pbi18;
}

// Installs the clock and CI on the run the scenario set up last. A step that sets up a new run, as "an item 482 in
// review whose run resumes at address" does after the Background, gets them installed again.
function ctx(world: object): Ctx {
  const w = world as { pbi234?: Ctx };
  const run = cell(world);
  if (w.pbi234?.run === run) return w.pbi234;
  const c: Ctx = { run, t: Date.now(), rules: new Map(), asked: new Map() };
  w.pbi234 = c;
  run.now = () => new Date(c.t);
  run.sleep = async (ms: number) => { c.t += ms; };
  const reviewCtx = () => (world as { pbi128?: ReviewCtx }).pbi128;
  const ask = (sha: string): Asked => {
    let a = c.asked.get(sha);
    if (a) return a;
    const fromOpenPr = [...c.asked.values()].some((x) => x.target === "head");
    const target: Target = run.stage === "address" ? "fix"
      : reviewCtx()?.addresserShas.includes(sha) ? "addresser"
      : fromOpenPr ? "green" : "head";
    c.asked.set(sha, (a = { target, firstAt: c.t }));
    return a;
  };
  const statuses = (sha: string): Map<string, "pending" | "passed" | "failed"> => {
    const a = ask(sha);
    const rules = c.rules.get(a.target) ?? new Map([["ci", { pendingFor: 0, then: "passed" as const }]]);
    const elapsed = c.t - a.firstAt;
    return new Map([...rules].map(([name, r]) => [name, elapsed < r.pendingFor ? "pending" : r.then]));
  };
  run.checks = async (sha: string) => {
    const s = [...statuses(sha).values()];
    if (s.includes("failed")) return "failure";
    if (s.includes("pending")) {
      const waited = c.t - ask(sha).firstAt;
      if (waited > SAFETY_MS) throw new Error(`the fake CI was asked about ${sha} for ${waited / MIN} minutes: the cell never stopped waiting`);
      return "pending";
    }
    return "success";
  };
  run.apiExtra = {
    async pendingChecks(sha: string) {
      return [...statuses(sha)].filter(([, s]) => s === "pending").map(([name]) => name);
    },
  };
  return c;
}

function rule(c: Ctx, target: Target, check: string, r: Rule) {
  let m = c.rules.get(target);
  if (!m) c.rules.set(target, (m = new Map()));
  m.set(check, r);
}

function target(words: string): Target {
  const t = TARGETS[words];
  assert.ok(t, `no commit called ${words}`);
  return t;
}

/** Whether the question names the check as a word of its own, so "ci" isn't found inside "decision". */
function names(q: string, check: string): boolean {
  const esc = check.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w-])${esc}([^\\w-]|$)`).test(q);
}

// ---- Givens ----

const COMMIT = "(the PR's head|Green's fix|the PR addresser's fix|the fix)";

Given(new RegExp(`^the check "([^"]+)" stays pending on ${COMMIT}$`), function (check: string, on: string) {
  rule(ctx(this), target(on), check, { pendingFor: Infinity, then: "passed" });
});

Given(new RegExp(`^the checks "([^"]+)" and "([^"]+)" stay pending on ${COMMIT}$`), function (a: string, b: string, on: string) {
  const c = ctx(this);
  for (const check of [a, b]) rule(c, target(on), check, { pendingFor: Infinity, then: "passed" });
});

Given(new RegExp(`^the check "([^"]+)" stays pending on ${COMMIT} for (\\d+) minutes and then (passes|fails)$`),
  function (check: string, on: string, minutes: string, then: string) {
    rule(ctx(this), target(on), check, { pendingFor: Number(minutes) * MIN, then: then === "passes" ? "passed" : "failed" });
  });

Given(new RegExp(`^these checks report on ${COMMIT}:$`), function (on: string, table: DataTable) {
  const c = ctx(this);
  for (const r of table.hashes()) {
    assert.ok(["passed", "failed", "pending"].includes(r.status), `not a check status: ${r.status}`);
    rule(c, target(on), r.check, r.status === "pending" ? { pendingFor: Infinity, then: "passed" } : { pendingFor: 0, then: r.status as "passed" | "failed" });
  }
});

Given("CI passes after Green's fix", function () {
  // A commit the scenario says nothing about passes, so Green's fix needs no rule. The clock and CI still go on.
  ctx(this);
});

Given("the PR reviewer finds {string} on its first review", function (body: string) {
  ctx(this);
  raise(review(this), 1, { path: "src/totals.ts", line: 12, body });
});

// ---- Thens ----

function shaOf(c: Ctx, t: Target): string {
  const found = [...c.asked].filter(([, a]) => a.target === t).map(([sha]) => sha);
  assert.ok(found.length > 0, `the cell never waited for CI on ${Object.keys(TARGETS).find((k) => TARGETS[k] === t)}`);
  return found[0];
}

Then(new RegExp(`^the cell stopped waiting for CI (\\d+) minutes after it began waiting on ${COMMIT}$`), function (minutes: string, on: string) {
  const c = ctx(this);
  assert.equal(c.run.error, null, `the cell failed: ${String(c.run.error)}`);
  const sha = shaOf(c, target(on));
  const began = c.asked.get(sha)!.firstAt;
  const asks = c.run.calls.filter((x) => x.route === "/checks" && x.body.sha === sha);
  const lastAsk = asks.at(-1)!.at!;
  const moved = c.run.calls.filter((x) => x.route === "/transition").at(-1);
  assert.ok(moved, "the cell sent no transition");
  assert.equal(moved.body.event, "blocked", `the cell's last transition is ${moved.body.event}, not a move to NeedsInput`);
  assert.ok(moved.at! >= lastAsk, "the cell asked about the commit's CI after it stopped waiting");
  const waited = moved.at! - began;
  const want = Number(minutes) * MIN;
  assert.ok(waited >= want && waited <= want + POLL_MS,
    `the cell stopped waiting ${waited / MIN} minutes after it began waiting on ${sha}, not ${minutes}`);
});

Then("the item moves to NeedsInput, with a question that names the check {string}", function (check: string) {
  const { run } = done(this);
  const q = question(run);
  assert.ok(names(q, check), `the question doesn't name the check "${check}": ${q}`);
});

Then("the item moves to NeedsInput, with a question that names the checks {string} and {string}", function (a: string, b: string) {
  const { run } = done(this);
  const q = question(run);
  for (const check of [a, b]) assert.ok(names(q, check), `the question doesn't name the check "${check}": ${q}`);
});

Then("the question doesn't name the check {string}", function (check: string) {
  const { run } = done(this);
  const q = question(run);
  assert.ok(!names(q, check), `the question names the check "${check}": ${q}`);
});

Then("no reviewers were asked to look at the PR", function () {
  const { c } = done(this);
  const asked = c.host.prs.flatMap((p) => p.reviewers);
  assert.deepEqual(asked, [], `reviewers were asked: ${JSON.stringify(asked)}`);
});

Then("the PR reviewer never reviewed the PR addresser's fix", function () {
  const { c } = done(this);
  const fix = c.addresserShas[0];
  assert.ok(fix, "the PR addresser made no commit");
  assert.ok(c.reviewerCalls.length > 0, "the PR reviewer never ran");
  assert.ok(c.reviewerCalls.every((r) => r.head !== fix && !r.prompt.includes(fix)), `the PR reviewer reviewed ${fix}, the PR addresser's fix`);
});

Then("address ran {int} time", function (n: number) {
  const run = cell(this);
  assert.equal(run.error, null, `the cell failed: ${String(run.error)}`);
  const starts = run.calls.filter((x) => x.route === "/stage" && x.body.status === "started" && x.body.stageId === "address");
  assert.equal(starts.length, n);
});
