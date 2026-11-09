// Step definitions for features/pbi-153-split-children-enter-factory.feature. They share PBI 144's harness: the board
// is PBI 10's fake backlog plus a scripted SplitBoard, the judge and the coding model are scripted per item, and a poll
// is an in-memory pass over the board that gates each Eligible item with the real readiness gate, as the poller does.
// Scheduling is the scheduler's rule over the poll's item states: while fewer items are InProgress than the WIP limit,
// the first Queued item is claimed. A run moves through the real state machine, so a child waits at SignOff for its
// scenarios' sign-off like any other item. The steps whose text PBI 144's feature shares are defined there.
import { Before, DataTable, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { next, type ItemEvent } from "../../src/core/states.ts";
import { SPLIT_HEADING } from "../../src/gate/split.ts";
import { parseCriteria } from "../../src/policy/policy.ts";
import {
  child, ctx, DOR, item, linkComments, poll, polled, replaceItem, SAYS_ENTERED, splitReply, titleOf, type Ctx,
} from "./pbi-144.steps.ts";

/** How the gate says why an oversized item's split wasn't proposed, as PBI 143's readiness comment words it. */
const NO_SPLIT = /\bsplit (?:couldn't|could not|can't|cannot|wasn't|was not) (?:be )?proposed because\b/i;

// The parent's link comment, in this feature, is the one that says its children went into the factory.
Before({ tags: "@pbi-153" }, function () {
  (this as { pbi153?: boolean }).pbi153 = true;
});

/** The scheduler: claims the first Queued item while fewer than the WIP limit are InProgress, one per tick. */
function schedule(c: Ctx): void {
  for (;;) {
    const states = [...c.states.entries()];
    if (states.filter(([, s]) => s.state === "InProgress").length >= c.wip) return;
    const queued = states.find(([, s]) => s.state === "Queued");
    if (!queued) return;
    move(c, queued[0], "claimed");
    c.started.add(queued[0]);
    c.stages.set(queued[0], []);
  }
}

/** Moves an item along the state machine's edge for `event`, as a cell reports it. */
function move(c: Ctx, id: string, event: ItemEvent): void {
  const st = c.states.get(id);
  assert.ok(st, `the factory holds no item ${id}`);
  const to = next(st.state, event);
  assert.ok(to, `no ${event} edge from ${st.state}`);
  st.state = to;
}

/** The child's run, when the scheduler started one; a step that acts through a run does nothing without one. */
function runOf(c: Ctx, title: string): string | null {
  const found = c.filed.filter((i) => i.title === title);
  if (found.length !== 1) return null;
  const id = found[0].externalId;
  return c.started.has(id) && c.states.has(id) ? id : null;
}

/** The run writes its scenarios at specify and stops for the owner's sign-off, as a cell does. */
function writeScenarios(c: Ctx, title: string): void {
  const id = runOf(c, title);
  if (!id || c.states.get(id)!.state !== "InProgress") return;
  c.stages.get(id)!.push("specify");
  move(c, id, "scenarios_written");
}

async function labelsOf(c: Ctx, id: string): Promise<string[]> {
  return (await item(c, id)).labels;
}

async function subIssuesOf(c: Ctx, id: string): Promise<string[]> {
  polled(c);
  return c.subIssues.get(id) ?? [];
}

/** A child's readiness comments: every comment but a split proposal and a comment linking to children it filed. */
async function readinessComments(c: Ctx, title: string): Promise<string[]> {
  const ch = child(c, title);
  const linking = new Set(await linkComments(c, ch.externalId));
  return (await c.fake.comments(ch.externalId)).filter((b) => !b.startsWith(SPLIT_HEADING) && !linking.has(b));
}

async function theLinkComment(c: Ctx): Promise<string> {
  const found = await linkComments(c);
  assert.equal(found.length, 1, `comments linking to a child: ${found.length}`);
  return found[0];
}

async function everyCarries(c: Ctx, parentId: string, label: string): Promise<void> {
  const subs = await subIssuesOf(c, parentId);
  assert.ok(subs.length > 0, `#${parentId} has no sub-issues`);
  for (const id of subs) {
    const labels = await labelsOf(c, id);
    assert.ok(labels.includes(label), `child "${titleOf(c, id)}" doesn't carry "${label}", only: ${labels.join(", ") || "no label"}`);
  }
}

// --- Background and setup --------------------------------------------------------------------------------------------

Given("the readiness judge finds every child ready and not oversized", function () {
  const c = ctx(this);
  c.oversizedChildren.clear();
  c.failedChildren.clear();
});

Given("the repo's opt-in label is {string} instead", function (label: string) {
  ctx(this).label = label;
});

Given("the parent issue carries the label {string} instead of {string}", async function (label: string, old: string) {
  const c = ctx(this);
  await replaceItem(c, c.parentId!, (fi) => ({ labels: [...fi.labels.filter((l) => l !== old), label] }));
});

Given("the owner has done nothing since", function () {
  // Nothing: no label, no status, no comment from the owner between the polls.
});

Given("the factory has polled the backlog twice", async function () {
  const c = ctx(this);
  await poll(c);
  await poll(c);
});

Given("the factory's WIP limit is {int}", function (n: number) {
  ctx(this).wip = n;
});

Given("the readiness judge instead fails child {string} because {string}", function (title: string, reason: string) {
  ctx(this).failedChildren.set(title, reason);
});

Given("the readiness judge instead finds child {string} oversized", function (title: string) {
  ctx(this).oversizedChildren.add(title);
});

Given("the coding model proposes this split of child {string}:", function (title: string, table: DataTable) {
  ctx(this).childReplies.set(title, splitReply(table));
});

Given("the coding model proposes a split of child {string} that leaves criterion {int} uncovered", function (title: string, n: number) {
  // Every criterion but n goes to a child, and a split needs two children, so the second takes the first's again.
  const c = ctx(this);
  // The child isn't filed yet: its criteria are the ones the parent's proposed split gives it.
  const proposed = (JSON.parse(c.reply) as { children: { title: string; criteria: number[] }[] }).children.find((ch) => ch.title === title);
  assert.ok(proposed, `the parent's split proposes no child "${title}"`);
  const count = proposed.criteria.length;
  const taken = Array.from({ length: count }, (_, i) => i + 1).filter((i) => i !== n);
  const kids = taken.map((i) => [i]);
  while (kids.length < 2) kids.push([taken[0]]);
  c.childReplies.set(title, JSON.stringify({
    children: kids.map((criteria, i) => ({ title: `${title} part ${i + 1}`, body: `Part ${i + 1} of ${title}`, criteria, needs: [] })),
  }));
});

Given("child {string} is done", async function (title: string) {
  const c = ctx(this);
  const ch = child(c, title);
  await replaceItem(c, ch.externalId, () => ({ closed: true }));
});

Given("child {string} is still open", async function (title: string) {
  const c = ctx(this);
  assert.ok(!(await item(c, child(c, title).externalId)).closed, `child "${title}" is closed`);
});

// --- Polling, scheduling and runs ----------------------------------------------------------------------------------

When("the factory polls the backlog again and schedules its work", async function () {
  const c = ctx(this);
  await poll(c);
  schedule(c);
});

Given("the factory has polled the backlog again and scheduled its work", async function () {
  const c = ctx(this);
  await poll(c);
  schedule(c);
});

When("the run for child {string} writes its scenarios", function (title: string) {
  writeScenarios(ctx(this), title);
});

Given("the run for child {string} has written its scenarios", function (title: string) {
  writeScenarios(ctx(this), title);
});

When("the owner signs off the scenarios of child {string}", function (title: string) {
  // The sign-off answers the run's question, and the scheduler claims the item again to go on from green.
  const c = ctx(this);
  const id = runOf(c, title);
  if (!id || c.states.get(id)!.state !== "SignOff") return;
  move(c, id, "claimed");
  c.stages.get(id)!.push("red", "green");
});

// --- Thens ---------------------------------------------------------------------------------------------------------

Then("every one of the parent's sub-issues carries the label {string}", async function (label: string) {
  const c = ctx(this);
  await everyCarries(c, c.parentId!, label);
});

Then("every one of child {string}'s sub-issues carries the label {string}", async function (title: string, label: string) {
  const c = ctx(this);
  await everyCarries(c, child(c, title).externalId, label);
});

Then("the factory starts a run for child {string}", function (title: string) {
  const c = ctx(this);
  const id = child(c, title).externalId;
  assert.ok(c.started.has(id), `the factory started no run for child "${title}"; runs: ${[...c.started].map((i) => titleOf(c, i)).join(", ") || "none"}`);
});

Then("the factory has started no run for child {string}", function (title: string) {
  const c = ctx(this);
  const id = child(c, title).externalId;
  assert.ok(!c.started.has(id) && !c.runs.has(id), `the factory took up child "${title}"`);
});

Then("the readiness gate has checked child {string} against the repo's definition of ready", function (title: string) {
  const c = ctx(this);
  const id = child(c, title).externalId;
  const checks = c.judged.filter((j) => j.id === id);
  assert.ok(checks.length > 0, `the readiness gate never checked child "${title}"`);
  const want = parseCriteria(DOR).map((cr) => cr.text);
  for (const j of checks) assert.deepEqual(j.dor.criteria.map((cr) => cr.text), want);
});

Then("child {string} has a readiness comment that quotes {string}", async function (title: string, quote: string) {
  const found = await readinessComments(ctx(this), title);
  assert.equal(found.length, 1, `readiness comments on child "${title}": ${found.length}`);
  assert.ok(found[0].includes(quote), `the readiness comment doesn't quote "${quote}":\n${found[0]}`);
});

Then("child {string} has a readiness comment that says why its split was not proposed", async function (title: string) {
  const found = await readinessComments(ctx(this), title);
  assert.equal(found.length, 1, `readiness comments on child "${title}": ${found.length}`);
  assert.match(found[0], NO_SPLIT, `the readiness comment doesn't say why the split wasn't proposed:\n${found[0]}`);
});

Then("child {string} waits for sign-off on its scenarios", function (title: string) {
  const c = ctx(this);
  const id = child(c, title).externalId;
  assert.equal(c.states.get(id)?.state ?? "not held", "SignOff", `child "${title}" isn't waiting for sign-off`);
});

Then("the run for child {string} builds nothing before the owner signs off", function (title: string) {
  const c = ctx(this);
  const id = child(c, title).externalId;
  assert.ok(c.started.has(id), `the factory started no run for child "${title}"`);
  assert.deepEqual(c.stages.get(id), ["specify"], `child "${title}"'s run did more than write its scenarios`);
});

Then("the run for child {string} goes on to build child {string}", function (title: string, built: string) {
  const c = ctx(this);
  const id = child(c, title).externalId;
  assert.equal(child(c, built).externalId, id);
  assert.equal(c.states.get(id)?.state ?? "not held", "InProgress", `child "${title}"'s run isn't building`);
  assert.deepEqual(c.stages.get(id), ["specify", "red", "green"], `child "${title}"'s run didn't go on to build after sign-off`);
});

Then("that comment says the children went into the factory", async function () {
  const body = await theLinkComment(ctx(this));
  assert.match(body, SAYS_ENTERED, `the comment doesn't say the children went into the factory:\n${body}`);
});

Then("that comment does not say any child lacks the label {string}", async function (label: string) {
  const body = await theLinkComment(ctx(this));
  const lacks = new RegExp(`\\b(?:none of them|no child|not one)\\b[^.]*\\b(?:carries|carry|has|have)\\b[^.]*${label}|\\b(?:lacks?|without)\\b[^.]*${label}`, "i");
  assert.doesNotMatch(body, lacks, `the comment says a child lacks "${label}":\n${body}`);
});

Then("that comment does not ask the owner to add the label {string} to a child", async function (label: string) {
  const body = await theLinkComment(ctx(this));
  const asks = new RegExp(`\\badd (?:it|the [\`'"]?${label}[\`'"]? label)\\b|\\badd[^.]*\\blabel\\b`, "i");
  assert.doesNotMatch(body, asks, `the comment asks the owner to add "${label}":\n${body}`);
});

Then("child {string} has these sub-issues, in order:", async function (title: string, table: DataTable) {
  const c = ctx(this);
  const subs = await subIssuesOf(c, child(c, title).externalId);
  assert.deepEqual(subs.map((id) => titleOf(c, id)), table.hashes().map((r) => r.title));
});

Then("child {string} has no sub-issues", async function (title: string) {
  const c = ctx(this);
  const subs = await subIssuesOf(c, child(c, title).externalId);
  assert.deepEqual(subs.map((id) => titleOf(c, id)), []);
});

Then("child {string} no longer carries the label {string}", async function (title: string, label: string) {
  const c = ctx(this);
  assert.ok(!(await labelsOf(c, child(c, title).externalId)).includes(label), `child "${title}" still carries "${label}"`);
});

Then("child {string} has one comment linking to its children", async function (title: string) {
  const c = ctx(this);
  const found = await linkComments(c, child(c, title).externalId);
  assert.equal(found.length, 1, `comments on child "${title}" linking to a child: ${found.length}`);
});
