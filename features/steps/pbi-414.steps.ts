// Step definitions for features/pbi-414-engine-decides-rules-line.feature.
//
// The feature runs on PBI 395's steps and contract (features/steps/pbi-395.steps.ts): its item, its repo with a dor.md,
// its rules on main, its fake judge whose last line names the rules it finds, its readiness check, its item page
// approval and its reading of what the check recorded. This file adds the wordings PBI 414 needs on top:
// - Every entry the steps build gives an After unless the step says "no After", and a Before unless it says "no Before".
// - "The readiness judge passes line 1, fails line 2 because ..." fails exactly line 2, the rules line, with that reason,
//   and "fails line 1 because ..., fails line 2 because ..." fails both. Every other line passes, with the fake judge's
//   reason "passed", which is what "with the judge's reason" reads.
// - "Line N" is the dor.md result of the item's last readiness check whose criterion_index is N.
// - The line's reason "says the engine held each entry to main and found every rule the judge named covered" when it
//   names the engine, main, and that the rules are covered, and isn't the judge's own reason.
// - A readiness comment "opens" a sentence when the comment's first line holds it, so the comment's lead, as "The
//   factory can't start this item yet.", may come first.
// - "That comment doesn't say ..." reads every new readiness comment.
// - Backlog item 414's After for spec §6 is quoted below as the item gives it. The spec on this branch is the working
//   tree's, read as prose the way the readiness check reads a section on main (ruleText in src/gate/rule-changes.ts), and
//   the After is held to it with its Markdown code marks dropped.
import { Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ruleText, SPEC_PATH } from "../../src/gate/rule-changes.ts";
import { ctx as pollCtx, polled } from "./pbi-12.steps.ts";
import { addEntry, ctx as ruleCtx, fresh, judge, lastResults, named, READINESS, type Result, showResults } from "./pbi-395.steps.ts";
import { long } from "./pbi-8.steps.ts";

/** Backlog item 414's After for spec §6, from its "## Changes the factory's rules" section. */
const ITEM_414_AFTERS: Record<string, string> = {
  "§6": "A rule it finds that the section doesn't cover fails the `dor.md` line about the factory's own rules, and the finding names each section the item's section should cover. For an item with the section, the engine alone decides that line: it passes when every entry holds against `main` and the section covers every rule the judge finds, whatever verdict the judge gave it.",
};

type Ctx = { line?: Result; after?: string; prose?: string | null };

function ctx(world: object): Ctx {
  const w = world as { pbi414?: Ctx };
  w.pbi414 ??= {};
  return w.pbi414;
}

// ---- the item's rules section ----

/** Adds an entry for `place` whose Before matches main, then sets or drops its Before and After as the step says. */
function entry(world: object, place: string, opts: { before?: string | null; after?: boolean } = {}): void {
  addEntry(world, place, opts.before ?? undefined);
  const e = ruleCtx(world).entries.at(-1)!;
  if (opts.before === null) delete e.before;
  if (opts.after === false) delete e.after;
}

Given("item {string}'s rules section changes spec section {string} with a Before that matches main word for word and an After", function (ext: string, section: string) {
  named(this, ext);
  entry(this, section);
});

Given("it changes the policy file {string} with a Before that matches main word for word and an After", function (path: string) {
  entry(this, path);
});

Given("item {string}'s rules section changes spec sections {string} and {string}, each with a Before that matches main word for word and an After",
  function (ext: string, a: string, b: string) {
    named(this, ext);
    entry(this, a);
    entry(this, b);
  });

Given("item {string}'s rules section changes spec section {string} with a Before that matches main word for word and no After", function (ext: string, section: string) {
  named(this, ext);
  entry(this, section, { after: false });
});

Given("item {string}'s rules section changes spec section {string} with an After and no Before", function (ext: string, section: string) {
  named(this, ext);
  entry(this, section, { before: null });
});

Given("item {string}'s rules section changes spec section {string} with the Before {string} and an After", function (ext: string, section: string, before: string) {
  named(this, ext);
  entry(this, section, { before });
});

Given("it changes the policy file {string} with the Before {string} and an After", function (path: string, before: string) {
  entry(this, path, { before });
});

// ---- the readiness judge ----

function rulesLine(n: number, m: number): void {
  assert.equal(n, 1, "the first line is the criteria line");
  assert.equal(m, 2, "the rules line is line 2");
}

Given("the readiness judge passes line {int}, fails line {int} because {string} and finds the item changes spec section {string}",
  function (n: number, m: number, reason: string, a: string) {
    rulesLine(n, m);
    judge(this, [a], [{ index: m, reason }]);
  });

Given("the readiness judge passes line {int}, fails line {int} because {string} and finds the item changes spec section {string} and the policy file {string}",
  function (n: number, m: number, reason: string, a: string, b: string) {
    rulesLine(n, m);
    judge(this, [a, b], [{ index: m, reason }]);
  });

Given("the readiness judge passes line {int}, fails line {int} because {string} and finds the item changes spec sections {string} and {string} and the policy file {string}",
  function (n: number, m: number, reason: string, a: string, b: string, c: string) {
    rulesLine(n, m);
    judge(this, [a, b, c], [{ index: m, reason }]);
  });

Given("the readiness judge passes line {int}, fails line {int} because {string} and finds the item changes no factory rule", function (n: number, m: number, reason: string) {
  rulesLine(n, m);
  judge(this, [], [{ index: m, reason }]);
});

Given("the readiness judge fails line {int} because {string}, fails line {int} because {string} and finds the item changes spec section {string}",
  function (n: number, first: string, m: number, second: string, a: string) {
    rulesLine(n, m);
    judge(this, [a], [{ index: n, reason: first }, { index: m, reason: second }]);
  });

// ---- what the readiness check recorded on a line ----

async function lineOf(world: object, ext: string, n: number): Promise<Result> {
  polled(pollCtx(world));
  const rs = await lastResults(world, ext);
  const r = rs.find((x) => x.criterion_index === n);
  assert.ok(r, `the last readiness check of item ${ext} has no result on line ${n}:\n${showResults(rs)}`);
  ctx(world).line = r;
  return r;
}

Then("the readiness check recorded line {int} as passed for item {string}", long, async function (n: number, ext: string) {
  const r = await lineOf(this, ext, n);
  assert.equal(r.status, "passed", `line ${n}, "${r.criterion}", ${r.status}: ${r.reason ?? ""}`);
});

Then("the readiness check recorded line {int} as passed for item {string} with the judge's reason", long, async function (n: number, ext: string) {
  const r = await lineOf(this, ext, n);
  assert.equal(r.status, "passed", `line ${n}, "${r.criterion}", ${r.status}: ${r.reason ?? ""}`);
  assert.equal(r.reason, "passed", `line ${n}'s reason isn't the judge's`);
});

Then("the readiness check failed item {string} on line {int}", long, async function (ext: string, n: number) {
  const r = await lineOf(this, ext, n);
  assert.equal(r.status, "failed", `line ${n}, "${r.criterion}", ${r.status}: ${r.reason ?? ""}`);
  ruleCtx(this).finding = { reason: r.reason };
});

Then("the readiness check failed item {string} on line {int} because {string}", long, async function (ext: string, n: number, reason: string) {
  const r = await lineOf(this, ext, n);
  assert.equal(r.status, "failed", `line ${n}, "${r.criterion}", ${r.status}: ${r.reason ?? ""}`);
  assert.ok((r.reason ?? "").includes(reason), `line ${n}'s reason "${r.reason ?? ""}" isn't the judge's "${reason}"`);
  ruleCtx(this).finding = { reason: r.reason };
});

function line(world: object): Result {
  const r = ctx(world).line;
  assert.ok(r, "no line's result was read");
  return r;
}

Then("that line's reason says the engine held each entry to main and found every rule the judge named covered", function () {
  const reason = line(this).reason ?? "";
  assert.notEqual(reason, "passed", "the line's reason is the judge's");
  assert.match(reason, /\bengine\b/i, `the line's reason doesn't name the engine: ${reason}`);
  assert.match(reason, /\bmain\b/, `the line's reason doesn't say each entry was held to main: ${reason}`);
  assert.match(reason, /\bcover(s|ed)?\b/i, `the line's reason doesn't say every rule the judge named is covered: ${reason}`);
});

Then("that line's reason doesn't say {string}", function (said: string) {
  const reason = line(this).reason ?? "";
  assert.ok(!reason.includes(said), `the line's reason says "${said}": ${reason}`);
});

function finding(world: object): string {
  const f = ruleCtx(world).finding;
  assert.ok(f, "no finding was read");
  return f.reason ?? "";
}

Then("that finding names spec section {string} and the policy file {string}", function (section: string, path: string) {
  const f = finding(this);
  for (const place of [section, path]) assert.ok(f.includes(place), `the finding "${f}" doesn't name ${place}`);
});

Then("that finding doesn't name spec section {string} as one to cover", function (section: string) {
  const f = finding(this);
  assert.ok(!f.includes(section), `the finding names ${section}, which the section covers: ${f}`);
});

// ---- the readiness comment ----

async function readinessComments(world: object): Promise<string[]> {
  const all = (await fresh(world)).filter((b) => READINESS.test(b));
  assert.ok(all.length > 0, "the board item has no new readiness comment");
  return all;
}

Then("the board item has a new readiness comment that opens {string}", long, async function (opening: string) {
  const all = await readinessComments(this);
  assert.ok(all.some((b) => b.split("\n")[0].includes(opening)), `no new readiness comment opens "${opening}":\n${all.join("\n---\n")}`);
});

Then("that comment doesn't say {string}", long, async function (said: string) {
  for (const b of await readinessComments(this)) assert.ok(!b.includes(said), `the readiness comment says "${said}":\n${b}`);
});

// ---- spec §6 ----

Given("the After that backlog item {int}'s {string} section gives for spec section {string}", function (n: number, heading: string, section: string) {
  assert.equal(n, 414);
  assert.equal(heading, "Changes the factory's rules");
  const after = ITEM_414_AFTERS[section];
  assert.ok(after, `backlog item 414 gives no After for spec section ${section}`);
  ctx(this).after = after;
});

When("the design spec on this branch is read as prose", async function () {
  const html = await readFile(join(process.cwd(), SPEC_PATH), "utf8");
  ctx(this).prose = html;
});

Then("spec section {string} holds that After word for word", function (section: string) {
  const c = ctx(this);
  assert.ok(c.after && typeof c.prose === "string", "no After or spec was read");
  const prose = ruleText(c.prose, { kind: "spec", section });
  assert.ok(prose !== null, `the spec has no section ${section}`);
  const after = c.after.replace(/`/g, "").replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
  assert.ok(prose.includes(after), `spec section ${section} doesn't hold the After word for word:\n${after}`);
});
