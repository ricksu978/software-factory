// Step definitions for features/pbi-233-rerun-failed-ci-once.feature.
//
// The scenarios run the engine through PBI 18's harness, with PBI 128's fake repo host, PR reviewer and PR addresser,
// PBI 130's person's thread and PBI 292's fake CI, by commit and by check, and its commit labels ("the PR's first
// head", "address pushes the commit <label>"). On top of PBI 292's CI, these steps put in, just before the cell runs:
//
// - Re-runs. The cell API's `rerunFailedChecks(sha, checks)` re-runs the named checks on a commit. Each call is
//   recorded as a "/rerun-checks" call with the commit and the checks. A check the scenario says GitHub refuses to
//   re-run makes the call reject, and the call is recorded as refused.
// - What a re-run check reports. Once a check was re-run on a commit, CI on that commit reports the check as the
//   scenario says: it passes, fails again at a new URL with its failing tests, or is still running for its first n
//   reads of `checks` on the commit after the re-run and then passes. A re-run check the scenario says nothing about
//   fails again just as it did. A check that wasn't re-run reports as PBI 292's CI says. `checks` answers failure when
//   any check failed, pending when any is still running, and success otherwise. `ciChecks` gives the same checks, with
//   a running check's conclusion "pending", and isn't counted as a read. `pendingChecks` names the checks still running.
//
// What the Thens read:
// - The factory "re-ran the check on a commit n times" when n accepted "/rerun-checks" calls on the commit name it.
// - An attempt's message is the message of the /stage report that ended it, as PBI 292 reads it. A message says
//   something of a check when one of its sentences (or lines) names the check as a word of its own and says it:
//   - "was re-run on <commit>": the sentence says "re-run" or "re-ran" and holds the commit's first 7 characters;
//   - "passed on the re-run": it says "re-run" or "re-ran", and "pass";
//   - "was re-run … and failed again": it says "re-run" or "re-ran", and "again";
//   - "couldn't be re-run on <commit>": it says "re-run", says "couldn't", "could not", "can't", "cannot" or
//     "refused", and holds the commit's first 7 characters.
// - "That attempt" is the one attempt in the run whose message says CI failed on the commit.
import { BeforeStep, Given, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { CiCheck } from "../../src/adapters/types.ts";
import type { Ctx as CellCtx } from "./pbi-18.steps.ts";
import { ctx as pr128 } from "./pbi-128.steps.ts";
import {
  brief, checksAt, ctx as ci292, ended, install as install292, keyOf, namesWord, saysFailedOn, settled, shaOf, tddPrompt,
} from "./pbi-292.steps.ts";

const MAX_READS = 40;
const RERUN = "/rerun-checks";

type Rerun =
  | { then: "passed"; runningReads: number }
  | { then: "failed"; url: string; failingTests: string[] };
type Ctx = {
  /** What each check reports once it is re-run, by the label of the commit and the check's name. */
  reruns: Map<string, Map<string, Rerun>>;
  /** The checks GitHub refuses to re-run, by the label of the commit. */
  refused: Map<string, Set<string>>;
  /** The reads of `checks` on each re-run check since its re-run, by commit and check. */
  readsSince: Map<string, number>;
  /** The checks re-run on each commit. */
  rerun: Map<string, Set<string>>;
  reads: number;
  installedOn: CellCtx | null;
};

function ctx(world: object): Ctx {
  const w = world as { pbi233?: Ctx };
  w.pbi233 ??= { reruns: new Map(), refused: new Map(), readsSince: new Map(), rerun: new Map(), reads: 0, installedOn: null };
  return w.pbi233;
}

function cell(world: object): CellCtx {
  const w = world as { pbi18?: CellCtx };
  assert.ok(w.pbi18, "no run was set up");
  return w.pbi18;
}

const quoted = (s: string) => [...s.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

/** Whether the label names a commit an earlier step gave a role. */
function known(world: object, label: string) {
  assert.ok(ci292(world).roles.has(label), `no commit is labelled "${label}"`);
}

function onRerun(world: object, label: string, check: string, r: Rerun) {
  known(world, label);
  const c = ctx(world);
  const m = c.reruns.get(label) ?? new Map<string, Rerun>();
  m.set(check, r);
  c.reruns.set(label, m);
}

/** The labels whose commit is `sha`, once CI was asked about it. */
function labelsOf(world: object, sha: string): string[] {
  const c = ci292(world);
  return [...c.roles].filter(([, role]) => (role.kind === "sha" ? role.sha : c.shas.get(keyOf(role))) === sha).map(([l]) => l);
}

function rerunRule(world: object, sha: string, check: string): Rerun | null {
  const c = ctx(world);
  for (const l of labelsOf(world, sha)) {
    const r = c.reruns.get(l)?.get(check);
    if (r) return r;
  }
  return null;
}

function isRefused(world: object, sha: string, check: string): boolean {
  const c = ctx(world);
  return labelsOf(world, sha).some((l) => c.refused.get(l)?.has(check));
}

/** The checks CI reports on `sha`, with each re-run check as its re-run left it. A read moves running re-runs on. PBI 423's steps read it too. */
export function checksNow(world: object, sha: string, read: boolean): CiCheck[] {
  const c = ctx(world);
  const rerun = c.rerun.get(sha) ?? new Set<string>();
  return checksAt(world, sha).map((x): CiCheck => {
    const base: CiCheck = { name: x.name, conclusion: x.conclusion, url: x.url, failingTests: [...x.failingTests] };
    if (!rerun.has(x.name)) return base;
    const r = rerunRule(world, sha, x.name);
    if (!r) return base;
    if (r.then === "failed") return { name: x.name, conclusion: "failure", url: r.url, failingTests: [...r.failingTests] };
    const k = `${sha}#${x.name}`;
    const n = c.readsSince.get(k) ?? 0;
    if (read) c.readsSince.set(k, n + 1);
    // A re-run is a new run on GitHub, so it has its own URL.
    const url = `${x.url}/rerun`;
    return n < r.runningReads ? { ...base, url, conclusion: "pending", failingTests: [] } : { ...base, url, conclusion: "success", failingTests: [] };
  });
}

/** PBI 423's steps put these re-runs on their runs too. */
export function install(world: object) {
  const c = ctx(world);
  const run = (world as { pbi18?: CellCtx }).pbi18;
  if (!run || c.installedOn === run) return;
  c.installedOn = run;
  run.checks = async (sha: string) => {
    if (++c.reads > MAX_READS) throw new Error(`CI was read ${c.reads} times: the cell never stopped reading it`);
    const list = checksNow(world, sha, true);
    return list.some((x) => x.conclusion === "failure") ? "failure" : list.some((x) => x.conclusion === "pending") ? "pending" : "success";
  };
  run.apiExtra = {
    ...run.apiExtra,
    async ciChecks(sha: string): Promise<CiCheck[]> {
      run.calls.push({ route: "/ci-checks", body: { sha } });
      return checksNow(world, sha, false);
    },
    async pendingChecks(sha: string): Promise<string[]> {
      return checksNow(world, sha, false).filter((x) => x.conclusion === "pending").map((x) => x.name);
    },
    async rerunFailedChecks(sha: string, checks: string[]): Promise<void> {
      const refused = checks.filter((x) => isRefused(world, sha, x));
      run.calls.push({ route: RERUN, body: { sha, checks: [...checks], refused: refused.length > 0 } });
      if (refused.length) throw new Error(`GitHub refused to re-run ${refused.join(", ")} on ${sha}`);
      const set = c.rerun.get(sha) ?? new Set<string>();
      for (const x of checks) {
        set.add(x);
        c.readsSince.set(`${sha}#${x}`, 0);
      }
      c.rerun.set(sha, set);
    },
  };
}

BeforeStep({ tags: "@pbi-233" }, function ({ pickleStep }) {
  if (pickleStep.text !== "the cell runs") return;
  const w = this as { pbi128Later?: boolean; pbi128?: unknown; pbi18?: unknown };
  if (w.pbi128Later && !w.pbi128 && w.pbi18) pr128(this);
  // PBI 292's CI first, so its checks are the ones a re-run lays over.
  ci292(this);
  install292(this);
  install(this);
});

// ---- Givens ----

Given("the check {string} passes when it is re-run on {string}", function (check: string, label: string) {
  onRerun(this, label, check, { then: "passed", runningReads: 0 });
});

Given("the checks {string} and {string} pass when they are re-run on {string}", function (a: string, b: string, label: string) {
  for (const check of [a, b]) onRerun(this, label, check, { then: "passed", runningReads: 0 });
});

Given(/^the check "([^"]+)" fails again when it is re-run on "([^"]+)" at "([^"]+)", failing the tests? (.+)$/,
  function (check: string, label: string, url: string, tests: string) {
    onRerun(this, label, check, { then: "failed", url, failingTests: quoted(tests) });
  });

Given("the check {string} is still running on its first {int} reads after it is re-run on {string}, then passes",
  function (check: string, n: number, label: string) {
    onRerun(this, label, check, { then: "passed", runningReads: n });
  });

Given("GitHub refuses to re-run the check {string} on {string}", function (check: string, label: string) {
  known(this, label);
  const c = ctx(this);
  const set = c.refused.get(label) ?? new Set<string>();
  set.add(check);
  c.refused.set(label, set);
});

// ---- Thens ----

function reruns(world: object, label: string, check: string): number {
  const run = cell(world);
  settled(run);
  const sha = shaOf(world, label);
  return run.calls.filter((x) => x.route === RERUN && x.body.sha === sha && !x.body.refused && (x.body.checks as string[]).includes(check)).length;
}

Then("the factory re-ran the check {string} on {string} {int} time(s)", function (check: string, label: string, n: number) {
  const got = reruns(this, label, check);
  assert.equal(got, n, `the factory re-ran the check "${check}" on ${shaOf(this, label).slice(0, 7)} ${got} time(s), not ${n}`);
});

Then("the factory didn't re-run the check {string} on {string}", function (check: string, label: string) {
  const got = reruns(this, label, check);
  assert.equal(got, 0, `the factory re-ran the check "${check}" on ${shaOf(this, label).slice(0, 7)} ${got} time(s)`);
});

Then("no attempt in the run says CI failed on {string}", function (label: string) {
  const sha = shaOf(this, label);
  const saying = ended(this).filter((a) => saysFailedOn(a.message, sha));
  assert.deepEqual(saying, [], `attempts say CI failed on ${sha.slice(0, 7)}: ${JSON.stringify(saying)}`);
});

Then("Green didn't run", function () {
  const run = cell(this);
  settled(run);
  const greens = run.calls.filter((x) => x.route === "/stage" && x.body.status === "started" && x.body.stageId === "green");
  assert.equal(greens.length, 0, `Green ran ${greens.length} time(s)`);
});

Then("Green's second brief doesn't name the check {string}", function (check: string) {
  // "CI failed on <commit>" opens every CI finding (PBI 292) and names CI, not a check, so a check called "ci" isn't
  // named by it.
  const b = brief(this, "second ").replace(tddPrompt(), "").replace(/\bCI failed on [0-9a-f]{7,40}\b/g, "");
  assert.ok(!namesWord(b, check), `Green's second brief names the check "${check}":\n${b}`);
});

// ---- the attempts' messages ----

const sentences = (t: string) => t.split(/\n|(?<=[.!?;])\s+/);
const RERUN_WORD = /re-?r[ua]n/i;

function says(message: string, what: string, check: string, test: (s: string) => boolean) {
  assert.ok(sentences(message).some((s) => namesWord(s, check) && test(s)), `the message doesn't say the check "${check}" ${what}: ${message}`);
}

function lastMessage(world: object, stageId: string): string {
  const a = ended(world).filter((x) => x.stageId === stageId).at(-1);
  assert.ok(a, `no ${stageId} attempt ended`);
  return a.message;
}

function theFailingAttempt(world: object, label: string): string {
  const sha = shaOf(world, label);
  const saying = ended(world).filter((a) => saysFailedOn(a.message, sha));
  assert.equal(saying.length, 1, `${saying.length} attempts say CI failed on ${sha.slice(0, 7)}: ${JSON.stringify(saying)}`);
  return saying[0].message;
}

function saysRerunOn(world: object, message: string, check: string, label: string) {
  const sha = shaOf(world, label).slice(0, 7);
  says(message, `was re-run on ${sha}`, check, (s) => RERUN_WORD.test(s) && s.includes(sha));
}

Then("the open-pr stage's last attempt's message says the check {string} was re-run on {string}", function (check: string, label: string) {
  saysRerunOn(this, lastMessage(this, "open-pr"), check, label);
});

Then("the open-pr stage's last attempt's message says the checks {string} and {string} were re-run on {string}", function (a: string, b: string, label: string) {
  const m = lastMessage(this, "open-pr");
  for (const check of [a, b]) saysRerunOn(this, m, check, label);
});

Then("the open-pr stage's last attempt's message says the check {string} passed on the re-run", function (check: string) {
  says(lastMessage(this, "open-pr"), "passed on the re-run", check, (s) => RERUN_WORD.test(s) && /pass/i.test(s));
});

Then("the address attempt's message says the check {string} was re-run on {string}", function (check: string, label: string) {
  saysRerunOn(this, lastMessage(this, "address"), check, label);
});

Then("that attempt's message says the check {string} was re-run on {string} and failed again", function (check: string, label: string) {
  const m = theFailingAttempt(this, label);
  saysRerunOn(this, m, check, label);
  says(m, "failed again on the re-run", check, (s) => RERUN_WORD.test(s) && /again/i.test(s));
});

Then("that attempt's message says the check {string} couldn't be re-run on {string}", function (check: string, label: string) {
  const sha = shaOf(this, label).slice(0, 7);
  says(theFailingAttempt(this, label), `couldn't be re-run on ${sha}`, check,
    (s) => RERUN_WORD.test(s) && s.includes(sha) && /couldn't|could not|can't|cannot|refused/i.test(s));
});
