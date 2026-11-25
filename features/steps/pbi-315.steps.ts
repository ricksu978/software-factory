// Step definitions for features/pbi-315-ci-failed-head-stays-failed-across-claims.feature.
//
// Every scenario runs the engine through PBI 18's harness (its run and runTheCell), with PBI 128's fake repo host and
// scripted PR reviewer, and PBI 292's fake CI by commit and by check. On top of them:
//
// - Two claims of the same run. The first claim runs from Red, as a run whose scenarios were signed off does: it opens
//   the PR, CI fails on its first head, and Green's fix leaves that head unchanged, so the claim ends on the question
//   the factory asks after giving up on a CI failure. The owner's answer is the next claim's decision, `answer`.
//   The next claim runs the engine again from Green, in a fresh clone of the same origin, against the same repo host
//   and CI, so it finds the branch and the PR as the first claim left them, plus whatever a scenario pushed in between.
//   Its context carries, as the cell API's would: the PR's number from the first claim's `/pr`, the first claim's
//   highest attempt per stage, and `failedCiHeads`, the `ciFailure` of each `/stage` report the first claim sent, by
//   the commit it names, oldest first. PBI 18's and PBI 292's records of calls and briefs start again for the next
//   claim; the first claim's calls are kept as the run's `earlierCalls`, so Thens about "the run" read both.
// - Green's commits, per claim. Each Green attempt makes a commit of its own (PBI 128's agent writes green.txt), unless
//   the scenario says that attempt makes none: "Green makes no commit" is the claim's first Green attempt, "Green's fix
//   for the CI failure" its second and "Green's next fix" its third. An attempt that makes none leaves the checkout as
//   it found it. A label that attempt's commit is given is the next fix in PBI 292's sense, the next new commit CI is
//   asked about after the PR's first head.
// - A person's push while the item waits: a commit on the item's branch, made on origin just before the next claim's
//   cell starts. "main" getting a new commit is made on origin's main at the same moment, so the next claim's base
//   merge makes a merge commit.
//
// What the Thens read:
// - The commit a claim "started on" is the head when the claim's first Green call ran, after the claim's base merge.
// - The factory "read CI on" a commit once per `/checks` call for it. `/ci-checks` gives a read's detail and isn't one.
// - A claim "ended on the question saying the factory gave up fixing CI on" a commit when its last transition asks a
//   question that says "gave up" and names the commit by its first 7 characters.
// - An attempt "says CI failed on" a commit as in PBI 292: a line of its message says "CI failed" and holds the commit.
import { Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CiFailure } from "../../src/cell/ci-failure.ts";
import { runTheCell, type Ctx as CellCtx } from "./pbi-18.steps.ts";
import { ctx as pr128 } from "./pbi-128.steps.ts";
import { brief, ctx as ci292, install as installCi, keyOf, namesWord, saysFailedOn, settled, shaOf } from "./pbi-292.steps.ts";

const BRANCH = "factory/pbi-482-r1";
const LONG = { timeout: 180_000 };

type Calls = CellCtx["calls"];
type Claim = { calls: Calls; error: unknown; startedOn: string | null };
type Ctx = {
  /** The Green attempts, by their number in the claim, that make no commit, per claim. */
  noCommit: { first: Set<number>; next: Set<number> };
  /** The fixes the next claim's Green makes commits for, so far. */
  nextFixes: number;
  /** The claim running now: 1 or 2. */
  claim: number;
  first: Claim | null;
  next: Claim | null;
  /** The head at the claim's first Green call. */
  startedOn: string | null;
  answer: string | null;
  /** The person's commit to push to the branch before the next claim, by its label. */
  personPush: string | null;
  baseMoves: boolean;
};

function cell(world: object): CellCtx {
  const w = world as { pbi18?: CellCtx };
  assert.ok(w.pbi18, "no run was set up");
  return w.pbi18;
}

function own(world: object): Ctx {
  const w = world as { pbi315?: Ctx };
  w.pbi315 ??= {
    noCommit: { first: new Set(), next: new Set() }, nextFixes: 0, claim: 0, first: null, next: null, startedOn: null,
    answer: null, personPush: null, baseMoves: false,
  };
  return w.pbi315;
}

/** Whether this scenario's claims are PBI 315's, so PBI 318's "the first claim's cell runs" hands them here. */
export function ownsClaims(world: object): boolean {
  return !!(world as { pbi315?: Ctx }).pbi315;
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const short = (sha: string) => sha.slice(0, 7);

function greenStarts(run: CellCtx): number {
  return run.calls.filter((x) => x.route === "/stage" && x.body.stageId === "green" && x.body.status === "started").length;
}

/** Puts CI and Green's commits on the run, once. PBI 128's fakes are already on it, from the Background. */
function prepare(world: object) {
  const o = own(world);
  const run = cell(world);
  const w = world as { pbi128Later?: boolean; pbi128?: unknown };
  if (w.pbi128Later && !w.pbi128) pr128(world);
  ci292(world);
  installCi(world);
  if ((run as { pbi315Agent?: boolean }).pbi315Agent) return;
  (run as { pbi315Agent?: boolean }).pbi315Agent = true;
  const prev = run.agent;
  run.agent = async (a, base) => {
    const judge = a.mode === "judge" || String(a.prompt).startsWith("# Definition of Done");
    if (run.stage === "green" && !judge && o.startedOn === null) o.startedOn = git(a.cwd, "rev-parse", "HEAD");
    const r = prev ? await prev(a, base) : await base(a);
    const skip = o.claim === 2 ? o.noCommit.next : o.noCommit.first;
    if (run.stage === "green" && !judge && skip.has(greenStarts(run))) {
      git(a.cwd, "checkout", "-q", "--", ".");
      git(a.cwd, "clean", "-fdq");
    }
    return r;
  };
}

// ---- Givens ----

Given("in the first claim CI reports the check {string} failed on the PR's first head {string} at {string}, failing the test {string}",
  function (check: string, label: string, url: string, test: string) {
    own(this);
    const c = ci292(this);
    const role = { kind: "head" } as const;
    c.roles.set(label, role);
    const list = c.rules.get(keyOf(role)) ?? [];
    list.push({ name: check, conclusion: "failure", url, failingTests: [test] });
    c.rules.set(keyOf(role), list);
  });

Given("in the first claim Green's fix for the CI failure makes no commit", function () {
  own(this).noCommit.first.add(2);
});

Given("in the next claim Green makes no commit", function () {
  own(this).noCommit.next.add(1);
});

Given("in the next claim Green's fix for the CI failure makes no commit", function () {
  own(this).noCommit.next.add(2);
});

/** The next claim's Green commits on its nth attempt, as PBI 292's next fix. */
function nextFix(world: object, label: string) {
  const o = own(world);
  const c = ci292(world);
  o.nextFixes++;
  const n = [...c.roles.values()].filter((r) => r.kind === "fix").length + 1;
  c.roles.set(label, { kind: "fix", n });
}

Given("in the next claim Green's fix for the CI failure makes the commit {string}", function (label: string) {
  nextFix(this, label);
});

Given("in the next claim Green's next fix for the CI failure makes the commit {string}", function (label: string) {
  assert.equal(own(this).nextFixes, 1, "no earlier fix in the next claim was named");
  nextFix(this, label);
});

Given("CI passes on {string}", function (label: string) {
  // A commit the scenario names no failed check on passes, so this needs no rule. It must be one the scenario named.
  const c = ci292(this);
  assert.ok(c.roles.has(label), `no commit is labelled "${label}"`);
  assert.ok(!c.rules.get(keyOf(c.roles.get(label)!))?.some((x) => x.conclusion === "failure"), `CI fails on "${label}"`);
});

Given("CI passes on the next claim's merge of the base", function () {
  // The merge commit is unlabelled, so CI passes on it.
  assert.ok(own(this).baseMoves, "the base doesn't move, so the next claim makes no merge commit");
});

Given("a person pushes the commit {string} to the item's branch while the item waits on the question", function (label: string) {
  const o = own(this);
  o.personPush = label;
  // The commit is made just before the next claim. Until then its role holds a placeholder, which the push replaces,
  // carrying over any checks a later step names on it.
  ci292(this).roles.set(label, { kind: "sha", sha: `pending:${label}` });
});

Given("{string} gets a new commit while the item waits on the question", function (branch: string) {
  assert.equal(branch, "main", "only the base, main, moves");
  own(this).baseMoves = true;
});

// ---- Whens ----

export async function runFirstClaim(world: object): Promise<void> {
  const o = own(world);
  const run = cell(world);
  prepare(world);
  o.claim = 1;
  o.startedOn = null;
  await runTheCell(world);
  o.first = { calls: run.calls, error: run.error, startedOn: o.startedOn };
}

When("the owner answers the question {string}", function (answer: string) {
  own(this).answer = answer;
});

/** What happens on origin while the item waits on the question. */
function meanwhile(world: object) {
  const o = own(world);
  const run = cell(world);
  if (o.personPush) {
    const tmp = mkdtempSync(join(run.root, "person-"));
    git(run.root, "clone", "-q", "-b", BRANCH, run.origin, tmp);
    git(tmp, "config", "user.email", "person@example.com");
    git(tmp, "config", "user.name", "person");
    writeFileSync(join(tmp, "person-fix.txt"), "fixed by hand\n");
    git(tmp, "add", "-A");
    git(tmp, "commit", "-q", "-m", "fix CI by hand");
    git(tmp, "push", "-q", "origin", BRANCH);
    const sha = git(tmp, "rev-parse", "HEAD");
    const c = ci292(world);
    const role = c.roles.get(o.personPush)!;
    assert.equal(role.kind, "sha");
    const rules = c.rules.get(keyOf(role));
    c.rules.delete(keyOf(role));
    (role as { sha: string }).sha = sha;
    if (rules) c.rules.set(keyOf(role), rules);
  }
  if (o.baseMoves) {
    const tmp = mkdtempSync(join(run.root, "main-"));
    git(run.root, "clone", "-q", "-b", "main", run.origin, tmp);
    git(tmp, "config", "user.email", "seed@example.com");
    git(tmp, "config", "user.name", "seed");
    writeFileSync(join(tmp, "base.txt"), "moved on\n");
    git(tmp, "add", "-A");
    git(tmp, "commit", "-q", "-m", "main moves on");
    git(tmp, "push", "-q", "origin", "main");
  }
}

When("the next claim's cell runs from Green", LONG, async function () {
  const o = own(this);
  const run = cell(this);
  assert.ok(o.first, "the first claim's cell never ran");
  assert.ok(o.answer !== null, "the owner never answered the question");
  meanwhile(this);
  const first = o.first.calls;
  // What the cell API hands the next claim: the PR, the highest attempt per stage, and the CI failures the run's
  // attempts reported, by the commit each names.
  const attempts: Record<string, number> = {};
  for (const x of first) {
    if (x.route === "/stage" && x.body.status === "started") attempts[x.body.stageId] = Math.max(attempts[x.body.stageId] ?? 0, Number(x.body.attempt ?? 0));
  }
  const failedCiHeads: CiFailure[] = [];
  for (const x of first) {
    const f = x.route === "/stage" ? (x.body.ciFailure as CiFailure | undefined) : undefined;
    if (f && !failedCiHeads.some((g) => g.sha === f.sha)) failedCiHeads.push(f);
  }
  const pr = first.filter((x) => x.route === "/pr").at(-1);
  // A fresh clone of the item's branch, as a new cell makes.
  const dir = join(run.root, "work-next");
  git(run.root, "clone", "-q", "-b", BRANCH, run.origin, dir);
  git(dir, "config", "user.email", "cell@example.com");
  git(dir, "config", "user.name", "cell");
  Object.assign(run, {
    dir, nextStage: "green", decision: { kind: "answer", text: o.answer },
    prNumber: pr ? Number(pr.body.prNumber) : run.prNumber,
    calls: [], agentCalls: [], stage: "", prBodies: [], result: null, error: null, earlierCalls: first,
    startHead: git(dir, "rev-parse", "HEAD"),
  });
  run.context = { ...run.context, stageAttempts: attempts, failedCiHeads };
  o.claim = 2;
  o.startedOn = null;
  await runTheCell(this);
  o.next = { calls: run.calls, error: run.error, startedOn: o.startedOn };
});

// ---- Thens ----

function nextClaim(world: object): Claim {
  const o = own(world);
  assert.ok(o.next, "the next claim's cell never ran");
  settled(cell(world));
  return o.next;
}

function firstClaim(world: object): Claim {
  const o = own(world);
  assert.ok(o.first, "the first claim's cell never ran");
  assert.equal(o.first.error, null, `the first claim's cell failed: ${o.first.error instanceof Error ? o.first.error.stack : String(o.first.error)}`);
  return o.first;
}

function assertGaveUp(calls: Calls, sha: string, which: string) {
  const t = calls.filter((x) => x.route === "/transition").at(-1);
  assert.ok(t, `the ${which} claim sent no transition`);
  assert.ok(t.body.question, `the ${which} claim's last transition, ${t.body.event}, asks no question`);
  const q = String(t.body.question.body ?? "");
  assert.ok(/gave up/i.test(q) && q.includes(short(sha)), `the ${which} claim's question doesn't say the factory gave up fixing CI on ${short(sha)}: ${q}`);
}

Then("the first claim ended on the question saying the factory gave up fixing CI on {string}", function (label: string) {
  assertGaveUp(firstClaim(this).calls, shaOf(this, label), "first");
});

Then("the next claim ended on the question saying the factory gave up fixing CI on {string}", function (label: string) {
  assertGaveUp(nextClaim(this).calls, shaOf(this, label), "next");
});

Then("the next claim started on the commit {string}", function (label: string) {
  const at = nextClaim(this).startedOn;
  assert.ok(at, "Green never ran in the next claim");
  const sha = shaOf(this, label);
  assert.equal(at, sha, `the next claim started on ${short(at)}, not ${short(sha)}`);
});

Then("the next claim started on a merge commit other than {string}", function (label: string) {
  const at = nextClaim(this).startedOn;
  assert.ok(at, "Green never ran in the next claim");
  const run = cell(this);
  const parents = git(run.dir, "rev-list", "--parents", "-n", "1", at).split(" ").slice(1);
  assert.ok(parents.length >= 2, `the next claim started on ${short(at)}, which isn't a merge commit`);
  assert.notEqual(at, shaOf(this, label), `the next claim started on ${short(at)}`);
});

const reads = (calls: Calls, sha: string) => calls.filter((x) => x.route === "/checks" && x.body.sha === sha).length;

Then("in the next claim the factory read CI on {string} {int} times", function (label: string, n: number) {
  const sha = shaOf(this, label);
  const got = reads(nextClaim(this).calls, sha);
  assert.equal(got, n, `in the next claim the factory read CI on ${short(sha)} ${got} times`);
});

Then("the factory read CI on {string}", function (label: string) {
  nextClaim(this);
  const sha = shaOf(this, label);
  const all = [...firstClaim(this).calls, ...nextClaim(this).calls];
  assert.ok(reads(all, sha) > 0, `the factory never read CI on ${short(sha)}`);
});

Then("the factory read CI on the next claim's merge of the base", function () {
  const at = nextClaim(this).startedOn;
  assert.ok(at, "Green never ran in the next claim");
  assert.ok(reads(nextClaim(this).calls, at) > 0, `the factory never read CI on the next claim's merge of the base, ${short(at)}`);
});

Then("in the next claim Green ran {int} times", function (n: number) {
  const got = nextClaim(this).calls.filter((x) => x.route === "/stage" && x.body.stageId === "green" && x.body.status === "started").length;
  assert.equal(got, n, `in the next claim Green ran ${got} times`);
});

const BRIEF = "in the next claim Green's (second |third )brief";

Then(new RegExp(`^${BRIEF} says CI failed on "([^"]+)"$`), function (which: string, label: string) {
  nextClaim(this);
  const b = brief(this, which);
  const sha = shaOf(this, label);
  assert.ok(saysFailedOn(b, sha), `Green's brief doesn't say CI failed on ${short(sha)}:\n${b}`);
});

Then(new RegExp(`^${BRIEF} names the check "([^"]+)" and "([^"]+)"$`), function (which: string, check: string, url: string) {
  nextClaim(this);
  const b = brief(this, which);
  assert.ok(namesWord(b, check), `Green's brief doesn't name the check "${check}":\n${b}`);
  assert.ok(b.includes(url), `Green's brief doesn't name the URL ${url}:\n${b}`);
});

Then(new RegExp(`^${BRIEF} names the test "([^"]+)"$`), function (which: string, test: string) {
  nextClaim(this);
  const b = brief(this, which);
  assert.ok(b.includes(test), `Green's brief doesn't name the test "${test}":\n${b}`);
});

Then("no attempt in the next claim says CI failed on {string}", function (label: string) {
  const sha = shaOf(this, label);
  const saying = nextClaim(this).calls
    .filter((x) => x.route === "/stage" && x.body.status !== "started" && saysFailedOn(String(x.body.message ?? ""), sha))
    .map((x) => ({ stageId: x.body.stageId, attempt: x.body.attempt, message: x.body.message }));
  assert.deepEqual(saying, [], `attempts in the next claim say CI failed on ${short(sha)}: ${JSON.stringify(saying)}`);
});
