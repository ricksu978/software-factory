// Step definitions for features/pbi-262-merge-while-needs-input.feature. The scenarios reuse PBI 181's merge harness
// (the background, the PR body, the hold, the second item and the merge event), PBI 194's question and dashboard steps,
// and PBI 12's poller.
//
// The factory's merge of a NeedsInput item closes its open question with a note naming the merge, kept in the
// question's `closed_note` column. The note names the PR number and the merge commit. The `factory_merged` event of an
// item that waited in NeedsInput holds `waitingIn: "NeedsInput"` and `question`, the body of the question it waited on.
// An InReview item's event holds neither.
import { Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { withTx } from "../../src/store/db.ts";
import { transitionItem } from "../../src/store/items.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";
import { ctx as pollCtx, polled, stateOf, type Ctx as PollCtx } from "./pbi-12.steps.ts";

const actor = { actor: "system", actorId: "pbi-262-steps" } as const;
const pool = () => need().pool;
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

/** PBI 181's context: the second item's external id and the merge event its Then found. */
type MergeCtx = { second?: string; event?: { payload: Record<string, unknown> } };
function mergeCtx(world: object): MergeCtx {
  const w = world as { pbi181?: MergeCtx };
  assert.ok(w.pbi181, "PBI 181's merge harness wasn't set up");
  return w.pbi181;
}

Before({ tags: "@pbi-262", ...long }, async function () {
  const d = await testDb();
  if (d) await d.pool.query('truncate item, event, backlog_source, repo, "user" cascade');
});

function prOf(world: object, n: number) {
  const found = pollCtx(world).host?.prs.find((p) => p.number === n);
  assert.ok(found, `the repo host has no PR ${n}`);
  return found;
}

async function idOf(c: PollCtx, ext: string): Promise<string> {
  const r = await pool().query<{ id: string }>("select id from item where source_id = $1 and external_id = $2", [c.sourceId, ext]);
  assert.ok(r.rows[0], `the factory doesn't hold item ${ext}`);
  return r.rows[0].id;
}

/** A criteria hash recorded at the run's start that the board's criteria no longer match. */
async function criteriaChanged(c: PollCtx, ext: string): Promise<void> {
  await pool().query("update item set criteria_hash = 'criteria-before-the-edit' where id = $1", [await idOf(c, ext)]);
}

// ---- approvals ----

Given("{string}, who maps to no allowlisted user, approves PR {int}", function (login: string, n: number) {
  prOf(this, n).reviews.push({ state: "approved", submittedAt: at(10), author: login });
});

// ---- the run asking ----

When("the run stops to ask {string} and the item moves to {string}", long, async function (body: string, state: string) {
  const c = pollCtx(this);
  const id = await idOf(c, c.extIds[0]);
  await withTx(pool(), async (tx) => {
    await tx.query("insert into question (item_id, kind, body) values ($1, 'needs_input', $2)", [id, body]);
    await transitionItem(tx, id, "blocked", actor);
  });
  assert.equal(await stateOf(c, c.extIds[0]), state);
});

// ---- criteria changes and holds ----

Given("the item's acceptance criteria on the board changed since its run started", long, async function () {
  const c = pollCtx(this);
  await criteriaChanged(c, c.extIds[0]);
});

Given("the second item's acceptance criteria on the board changed since its run started", long, async function () {
  const second = mergeCtx(this).second;
  assert.ok(second, "there is no second item");
  await criteriaChanged(pollCtx(this), second);
});

Given("an operator has held the second item from the dashboard", long, async function () {
  const second = mergeCtx(this).second;
  assert.ok(second, "there is no second item");
  await pool().query("update item set held = true where id = $1", [await idOf(pollCtx(this), second)]);
});

Then("the item's run that opened PR {int} has ended", long, async function (n: number) {
  const c = pollCtx(this);
  polled(c);
  const r = await pool().query<{ ended: boolean }>(
    "select ended_at is not null as ended from run where item_id = $1 and pr_number = $2", [await idOf(c, c.extIds[0]), n],
  );
  assert.equal(r.rows.length, 1, `the item has ${r.rows.length} runs with PR ${n}`);
  assert.ok(r.rows[0].ended, `the run that opened PR ${n} is still open`);
});

Then("the factory has closed PR {int} without merging it", function (n: number) {
  polled(pollCtx(this));
  const p = prOf(this, n);
  assert.equal(p.merged, false, `PR ${n} merged`);
  assert.equal(p.open, false, `PR ${n} is still open`);
});

// ---- the question's note ----

async function noteOf(world: object, body: string): Promise<string | null> {
  const c = pollCtx(world);
  polled(c);
  // Read through to_jsonb, so a missing column reads as no note.
  const r = await pool().query<{ note: string | null }>(
    "select to_jsonb(q)->>'closed_note' as note from question q where item_id = $1 and body = $2", [await idOf(c, c.extIds[0]), body],
  );
  assert.equal(r.rows.length, 1, `the item has ${r.rows.length} questions "${body}"`);
  return r.rows[0].note;
}

Then("the question {string} carries a note that the factory merged PR {int} as commit {string}", long, async function (body: string, n: number, sha: string) {
  const note = await noteOf(this, body);
  assert.ok(note, `the question "${body}" carries no note`);
  assert.match(note, /merg/i, `the note doesn't name a merge: ${note}`);
  assert.match(note, new RegExp(`(#|PR )${n}\\b`), `the note doesn't name PR ${n}: ${note}`);
  assert.ok(note.includes(sha), `the note doesn't name commit ${sha}: ${note}`);
});

Then("the question {string} carries no note about a merge", long, async function (body: string) {
  const note = await noteOf(this, body);
  assert.ok(note === null || !/merg/i.test(note), `the question "${body}" carries a note about a merge: ${note}`);
});

// ---- the item's history ----

Then("that move to {string} is from {string}", long, async function (state: string, from: string) {
  const c = pollCtx(this);
  polled(c);
  const r = await pool().query<{ from: string | null }>(
    `select payload->>'from' as from from event where item_id = $1 and kind in ('transition', 'override') and payload->>'to' = $2`,
    [await idOf(c, c.extIds[0]), state],
  );
  assert.deepEqual(r.rows.map((x) => x.from), [from]);
});

// ---- the merge event ----

function theEvent(world: object): Record<string, unknown> {
  const e = mergeCtx(world).event;
  assert.ok(e, "no merge event was found");
  return e.payload;
}

Then("that event says the item was waiting in {string}", function (state: string) {
  assert.equal(theEvent(this).waitingIn, state, `the event says: ${JSON.stringify(theEvent(this))}`);
});

Then("that event doesn't say the item was waiting in {string}", function (state: string) {
  assert.notEqual(theEvent(this).waitingIn, state, `the event says: ${JSON.stringify(theEvent(this))}`);
});

Then("that event names the question {string}", function (body: string) {
  assert.equal(theEvent(this).question, body, `the event says: ${JSON.stringify(theEvent(this))}`);
});

Then("that event names no question", function () {
  const q = theEvent(this).question;
  assert.ok(q === undefined || q === null, `the event names the question ${JSON.stringify(q)}`);
});
