// Step definitions for features/pbi-220-outbox-row-twice.feature. The scenarios reuse PBI 219's database, boards, cell
// API, moves and outbox steps, and add a row handled twice: the worker runs that one row's effects through
// src/worker/outbox.ts's runRowEffects, then runs them again before the row is removed, as it would after a crash.
// PBI 156's recording board counts each call the factory made on an item, so "once" counts every setStatus, claim,
// release and close the worker made, a repeat of the same status included. A person's change on the board goes to the
// board's fake directly, so it isn't counted as the factory's.
import { After, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { CLAIM_MARKER } from "../../src/adapters/contract.ts";
import type { ItemState } from "../../src/core/states.ts";
import { withTx } from "../../src/store/db.ts";
import * as items from "../../src/store/items.ts";
import { CONSUMER, type Consumer } from "../../src/store/outbox.ts";
import { runRowEffects, type OutboxRow } from "../../src/worker/outbox.ts";
import { item, newItem, outbox, REPO } from "./pbi-218.steps.ts";
import { boardNamed, callsOn, ctx as p219, exactlyOne, host, MAIN, repoId, statusFor, workerDeps } from "./pbi-219.steps.ts";
import { long, need } from "./pbi-8.steps.ts";

type Ctx = { /** The board mirror row the worker handled last, so a step can handle that same row again. */ row?: OutboxRow };

function ctx(world: object): Ctx {
  const w = world as { pbi220?: Ctx };
  w.pbi220 ??= {};
  return w.pbi220;
}

// PBI 219's After closes the servers its steps start only for its own tag, so this closes them here.
After({ tags: "@pbi-220" }, async function () {
  for (const close of p219(this).closers.reverse()) await close();
});

const pool = () => need().pool;
const num = (issue: string) => issue.replace(/^#/, "");

/** The one board mirror row in the outbox for the item. */
async function mirrorRow(world: object, issue: string): Promise<OutboxRow> {
  const id = await item(world, issue, MAIN);
  const rows = (await outbox()).filter((r) => r.consumer === CONSUMER.boardMirror && r.item_id === id);
  assert.equal(rows.length, 1, `the outbox holds ${rows.length} board mirror rows for item ${issue}`);
  const r = rows[0];
  return { seq: r.seq, consumer: r.consumer as Consumer, eventId: r.event_id, itemId: r.item_id };
}

// ---- items ----

Given("item {string} on board {string} is {string} with a merged PR", long, async function (issue: string, boardName: string, state: ItemState) {
  const id = await newItem(this, issue, boardName, state);
  const ext = num(issue);
  const branch = `factory/pbi-${ext}-r1`;
  await pool().query(
    "insert into run (item_id, run_number, next_stage, pr_number, pr_url, branch, repo_id) values ($1, 1, 'dod', 41, $2, $3, $4)",
    [id, `https://github.com/${REPO}/pull/41`, branch, await repoId(REPO)],
  );
  host(this).prs.push({
    number: 41, repo: REPO, branch, base: "main", title: `item ${issue}`, body: "", headSha: "head-41", open: false,
    merged: true, mergeSha: "merge-41", mergeable: true, reviewers: [], comments: [], reviews: [],
  });
  // The factory claimed it when it started the run, and keeps the claim until the item is done.
  const adapter = boardNamed(this, boardName).fake.adapter;
  await adapter.claim(ext);
  const run = await pool().query("select pr_number from run where item_id = $1", [id]);
  assert.deepEqual(run.rows.map((r) => r.pr_number), [41], `item ${issue} has no run for PR 41`);
  const found = await adapter.getItem(ext);
  assert.ok(found, `board "${boardName}" holds no item ${issue}`);
  assert.ok(found.labels.includes(CLAIM_MARKER), `board item ${issue} isn't claimed`);
});

// ---- moves ----

When("item {string} on board {string} moves to {string} on a verified definition of done", long, async function (issue: string, boardName: string, to: string) {
  const id = await item(this, issue, boardName);
  const state = await withTx(pool(), (c) => items.transitionItem(c, id, "dod_verified", { actor: "system", actorId: "scheduler" }));
  assert.equal(state, to);
});

When("a person moves item {string} to the status {string} on the board", long, async function (issue: string, status: string) {
  const adapter = boardNamed(this, MAIN).fake.adapter;
  await adapter.setStatus(num(issue), status);
  const found = await adapter.getItem(num(issue));
  assert.ok(found, `the board holds no item ${issue}`);
  assert.equal(found.status, status, `the board shows item ${issue} as "${found.status}", not "${status}"`);
});

// ---- the worker ----

When("the worker handles item {string}'s board mirror row twice, as it would after a crash before removing it", long, async function (issue: string) {
  const row = await mirrorRow(this, issue);
  ctx(this).row = row;
  await runRowEffects(workerDeps(this), row);
  await runRowEffects(workerDeps(this), row);
});

When("the worker handles item {string}'s board mirror row", long, async function (issue: string) {
  const row = await mirrorRow(this, issue);
  ctx(this).row = row;
  await runRowEffects(workerDeps(this), row);
});

When("the worker handles that same board mirror row again, as it would after a crash before removing it", long, async function () {
  const row = ctx(this).row;
  assert.ok(row, "the worker has handled no board mirror row yet");
  await runRowEffects(workerDeps(this), row);
});

// ---- the board ----

Then("the board was set to the status for {string} on item {string} once", long, async function (state: string, issue: string) {
  const status = await statusFor(this, state);
  const sets = callsOn(this, issue, "setStatus").filter((call) => call.args[1] === status);
  assert.equal(sets.length, 1, `the board was set to "${status}" on item ${issue} ${sets.length} times`);
});

for (const [word, method] of [["claimed", "claim"], ["released", "release"], ["closed", "close"]] as const) {
  Then(`the board ${word} item {string} once`, long, async function (issue: string) {
    const calls = callsOn(this, issue, method);
    assert.equal(calls.length, 1, `the board ${word} item ${issue} ${calls.length} times`);
  });
}

Then("the board shows item {string} with the status {string}", long, async function (issue: string, status: string) {
  const found = await boardNamed(this, MAIN).fake.adapter.getItem(num(issue));
  assert.ok(found, `the board holds no item ${issue}`);
  assert.equal(found.status, status);
});

// ---- comments on the board item ----

Then("item {string} on the board has exactly one comment saying it waits for sign-off on the scenarios", long, async function (issue: string) {
  await exactlyOne(this, issue, "it waits for sign-off", (b) => /Waiting for sign-off on the scenarios/.test(b));
});

Then("item {string} on the board has exactly one comment saying it failed and waits for an operator to re-queue it", long, async function (issue: string) {
  await exactlyOne(this, issue, "it failed and waits to be re-queued", (b) => /Failed\./.test(b) && /operator to re-queue/.test(b));
});
