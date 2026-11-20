// Step definitions for features/pbi-221-outbox-retry-backoff-failed-rows.feature. The scenarios reuse PBI 218's items,
// and PBI 219's boards, people, moves, dashboard, webhook and worker, whose every pass through the outbox is logged with
// the outbox before and after it and the board calls asked in it, refused or not.
//
// The worker reads the time from the database (src/worker/outbox.ts's workOutbox compares next_attempt_at with now()),
// so that clock is the factory's. "Time moves on" moves it forward by moving every time in the outbox back by the same
// amount, and keeps the total in PBI 219's offsetMs, so a time on the factory's clock is a database time plus offsetMs.
// It jumps to each moment a row falls due within the stated time and works through the outbox there, so a row is tried
// as soon as its wait is up and never before.
//
// A board refuses what a scenario says it refuses through PBI 219's rules, which see every call the factory asks of the
// board. "The first 9 updates" counts the worker's attempts that asked for an update, so a row whose effects are several
// board calls fails nine attempts and succeeds on its tenth.
import { After, Before, Given, Then, When, type DataTable } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { CONSUMER, type Consumer } from "../../src/store/outbox.ts";
import { boardRepo, item, signOffByMove, outbox, REPO, type Row } from "./pbi-218.steps.ts";
import {
  boardNamed, ctx as p219, deliver, exactlyOne, factoryNow, MAIN, statusFor, triedIn, UPDATES, workPass, type Asked, type Pass,
} from "./pbi-219.steps.ts";
import { long, need } from "./pbi-8.steps.ts";

const pool = () => need().pool;
const num = (issue: string) => issue.replace(/^#/, "");
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
/** How long "time moves on until" may move the clock before it gives up. */
const UNTIL_AT_MOST = 24 * HOUR;

// Each board's item #11 is in a repo of its own, so a comment in one board's repo answers only that board's item. An
// item waiting for sign-off got there by the cell's move, and that move's board mirror row is still in the outbox, as
// "the outbox still holds the board mirror row" in the scenario of a failing board mirror row and an announcement says.
Before({ tags: "@pbi-221" }, function () {
  boardRepo(this, MAIN, REPO);
  boardRepo(this, "side", "acme/side");
  signOffByMove(this);
});

// PBI 219's After closes the servers its steps start only for its own tag, so this closes them here.
After({ tags: "@pbi-221" }, async function () {
  for (const close of p219(this).closers.reverse()) await close();
});

// ---- the outbox rows ----

type Found = Row & { kind: string; payload: Record<string, unknown> };

/** The item's outbox rows for `consumer`, in seq order, with their event's kind and payload. */
async function rows(world: object, issue: string, consumer: Consumer, boardName = MAIN): Promise<Found[]> {
  const id = await item(world, issue, boardName);
  const r = await pool().query<{ id: string; kind: string; payload: Record<string, unknown> }>(
    "select e.id, e.kind, e.payload from event e join outbox o on o.event_id = e.id where o.item_id = $1", [id],
  );
  const events = new Map(r.rows.map((e) => [e.id, e]));
  return (await outbox())
    .filter((x) => x.item_id === id && x.consumer === consumer)
    .map((x) => ({ ...x, kind: events.get(x.event_id)!.kind, payload: events.get(x.event_id)!.payload }));
}

async function oneRow(world: object, issue: string, consumer: Consumer, what: string, boardName = MAIN): Promise<Found> {
  const found = await rows(world, issue, consumer, boardName);
  assert.equal(found.length, 1, `the outbox holds ${found.length} ${what} rows for item ${issue}`);
  return found[0];
}

const NAMES: Record<string, Consumer> = {
  "board mirror": CONSUMER.boardMirror,
  "decision announcement": CONSUMER.decisionAnnouncement,
  "comment command": CONSUMER.commentCommands,
};

function consumerNamed(what: string): Consumer {
  const consumer = NAMES[what];
  assert.ok(consumer, `no outbox consumer "${what}"`);
  return consumer;
}

/** The passes in which the worker tried the row `seq`, in order. */
const triesOf = (world: object, seq: string): Pass[] => p219(world).passes.filter((p) => triedIn(p, seq));

/** The row's next attempt on the factory's clock. */
async function dueAt(world: object, seq: string): Promise<number> {
  const r = await pool().query<{ t: Date }>("select next_attempt_at as t from outbox where seq = $1", [seq]);
  assert.ok(r.rows[0], `the outbox holds no row ${seq}`);
  return r.rows[0].t.getTime() + p219(world).offsetMs;
}

function hasFailed(row: Row, times: number, what: string): void {
  assert.equal(row.attempts, times, `the ${what} row has failed ${row.attempts} times, not ${times}`);
}

function setAside(row: Row, what: string): void {
  assert.ok(row.failed_at, `the ${what} row (failed ${row.attempts} times) isn't marked failed`);
}

/** Asserts the row's next attempt is `waitMs` after the pass in which it failed for the `nth` time. */
async function dueAfterFailure(world: object, row: Row, nth: number, waitMs: number, what: string): Promise<void> {
  assert.equal(row.failed_at, null, `the ${what} row is marked failed`);
  const failure = triesOf(world, row.seq)[nth - 1];
  assert.ok(failure, `the ${what} row hasn't been tried ${nth} times`);
  const due = await dueAt(world, row.seq);
  assert.ok(
    due >= failure.start + waitMs - SECOND && due <= failure.end + waitMs + SECOND,
    `the ${what} row is due ${Math.round((due - failure.start) / SECOND)} seconds after its failure ${nth}, not ${waitMs / SECOND}`,
  );
}

// ---- the board ----

function rule(world: object, r: (call: Asked) => string | null): void {
  p219(world).rules.push(r);
}

const on = (call: Asked, boardName: string, issue: string) => call.board === boardName && call.id === num(issue);

Given("the board refuses to set item {string} to the status for {string}", long, async function (issue: string, state: string) {
  const status = await statusFor(this, state);
  rule(this, (call) => on(call, MAIN, issue) && call.method === "setStatus" && call.args[1] === status
    ? `the board refuses to set item ${issue} to "${status}"` : null);
});

Given("the board refuses every update to item {string} but accepts comments on it", function (issue: string) {
  rule(this, (call) => on(call, MAIN, issue) && UPDATES.has(call.method) && call.method !== "comment"
    ? `the board refuses every update to item ${issue}` : null);
});

Given("the board refuses the first {int} updates to item {string} and accepts the ones after", function (n: number, issue: string) {
  // Counted by the worker's attempts: every update in one pass is part of the same attempt.
  const attempts = new Set<number | null>();
  rule(this, (call) => {
    if (!on(call, MAIN, issue) || !UPDATES.has(call.method)) return null;
    attempts.add(call.pass);
    return attempts.size <= n ? `the board refuses update ${attempts.size} of item ${issue}` : null;
  });
});

Given("the board fails every time the factory reads item {string}", function (issue: string) {
  rule(this, (call) => on(call, MAIN, issue) && call.method === "getItem" ? `the board fails to read item ${issue}` : null);
});

Given("the board {string} fails the next {int} times the factory reads item {string} and works after", function (boardName: string, n: number, issue: string) {
  let reads = 0;
  rule(this, (call) => {
    if (!on(call, boardName, issue) || call.method !== "getItem") return null;
    reads += 1;
    return reads <= n ? `board ${boardName} fails read ${reads} of item ${issue}` : null;
  });
});

/** The worker's passes in which the factory asked the board for a call on the item that `matches`. */
function attemptsAsking(world: object, issue: string, matches: (call: Asked) => boolean): number {
  const passes = new Set(p219(world).asked.filter((c) => c.pass !== null && on(c, MAIN, issue) && matches(c)).map((c) => c.pass));
  return passes.size;
}

Then("the board was asked to update item {string} on exactly {int} attempts in all", long, function (issue: string, n: number) {
  assert.equal(attemptsAsking(this, issue, (c) => UPDATES.has(c.method)), n, `the board was asked to update item ${issue} on another number of attempts`);
});

Then("the board was asked to post the approval announcement on item {string} on exactly {int} attempts in all", long, function (issue: string, n: number) {
  const asked = attemptsAsking(this, issue, (c) => c.method === "comment" && /Scenarios signed off/.test(String(c.args[1])));
  assert.equal(asked, n, `the board was asked to post the approval announcement on item ${issue} on ${asked} attempts`);
});

Then("the board does not show item {string} with the status for {string}", long, async function (issue: string, state: string) {
  const found = await boardNamed(this, MAIN).fake.adapter.getItem(num(issue));
  assert.ok(found, `the board holds no item ${issue}`);
  assert.notEqual(found.status, await statusFor(this, state), `the board shows item ${issue} with the status for ${state}`);
});

Then("item {string} on the board still has exactly one comment saying the scenarios were signed off", long, async function (issue: string) {
  await exactlyOne(this, issue, "the scenarios were signed off", (b) => /Scenarios signed off/.test(b));
});

// ---- GitHub's webhook ----

When(
  "GitHub delivers a comment {string} by {string} on issue {string} on board {string} in its repo",
  long,
  async function (body: string, login: string, issue: string, boardName: string) {
    const found = await boardNamed(this, boardName).fake.adapter.getItem(num(issue));
    assert.ok(found?.repo, `item ${issue} on board "${boardName}" names no repo`);
    await deliver(this, issue, login, body, found.repo);
  },
);

// ---- time ----

/** Moves the factory's clock on by `ms`: every time in the outbox moves back by it. */
async function shift(world: object, ms: number): Promise<void> {
  await pool().query(
    `update outbox set next_attempt_at = next_attempt_at - $1 * interval '1 millisecond',
       failed_at = failed_at - $1 * interval '1 millisecond'`,
    [ms],
  );
  p219(world).offsetMs += ms;
}

/**
 * Moves the factory's clock on by `ms`, and works through the outbox at each moment within it that a row falls due.
 * With `until`, it stops as soon as `until` holds, and fails if it doesn't hold within UNTIL_AT_MOST.
 */
async function moveOn(world: object, ms: number, until?: () => Promise<boolean>): Promise<void> {
  const end = (await factoryNow(world)) + ms;
  for (;;) {
    if (until && (await until())) return;
    const r = await pool().query<{ wait: number | null; due: Date | null }>(
      `select extract(epoch from min(next_attempt_at) - clock_timestamp()) * 1000 as wait, min(next_attempt_at) as due
       from outbox where failed_at is null and next_attempt_at > clock_timestamp()`,
    );
    const { wait, due } = r.rows[0];
    if (wait === null || !due || due.getTime() + p219(world).offsetMs > end) break;
    await shift(world, Math.ceil(Number(wait)) + 1);
    await workPass(world);
  }
  assert.ok(!until, "the condition didn't come about in time");
  const rest = end - (await factoryNow(world));
  if (rest > 0) await shift(world, rest);
}

const WITH_WORKER = ", with the worker working through the outbox whenever a row falls due";

for (const [phrase, ms] of [["three hours", 3 * HOUR], ["two hours", 2 * HOUR], ["another hour", HOUR], ["a day", 24 * HOUR]] as const) {
  When(`time moves on for ${phrase}${WITH_WORKER}`, long, async function () {
    await moveOn(this, ms);
  });
}

When(`time moves on for {int} minutes${WITH_WORKER}`, long, async function (minutes: number) {
  await moveOn(this, minutes * MINUTE);
});

When(
  `time moves on until the board mirror row for item {string} has failed {int} times${WITH_WORKER}`,
  long,
  async function (issue: string, times: number) {
    await moveOn(this, UNTIL_AT_MOST, async () => {
      const found = await rows(this, issue, CONSUMER.boardMirror);
      return found.length === 1 && found[0].attempts >= times;
    });
  },
);

// ---- what the outbox holds ----

for (const what of Object.keys(NAMES)) {
  for (const times of ["time", "times"]) {
    Then(`the outbox still holds the ${what} row for item {string}, having failed {int} ${times}`, long, async function (issue: string, n: number) {
      hasFailed(await oneRow(this, issue, consumerNamed(what), what), n, what);
    });
  }

  Then(`the ${what} row for item {string} is due again {int} seconds after it failed`, long, async function (issue: string, seconds: number) {
    const row = await oneRow(this, issue, consumerNamed(what), what);
    await dueAfterFailure(this, row, row.attempts, seconds * SECOND, what);
  });

  Then(`the ${what} row for item {string} is marked failed and set aside`, long, async function (issue: string) {
    setAside(await oneRow(this, issue, consumerNamed(what), what), what);
  });
}

Then("the outbox still holds the board mirror row for item {string}, marked failed", long, async function (issue: string) {
  setAside(await oneRow(this, issue, CONSUMER.boardMirror, "board mirror"), "board mirror");
});

Then("the board mirror row for item {string} is marked failed and set aside, having failed {int} times", long, async function (issue: string, n: number) {
  const row = await oneRow(this, issue, CONSUMER.boardMirror, "board mirror");
  setAside(row, "board mirror");
  hasFailed(row, n, "board mirror");
});

Then("the board mirror row for item {string} is not marked failed and is due again {int} minutes after its ninth failure", long, async function (issue: string, minutes: number) {
  const row = await oneRow(this, issue, CONSUMER.boardMirror, "board mirror");
  hasFailed(row, 9, "board mirror");
  await dueAfterFailure(this, row, 9, minutes * MINUTE, "board mirror");
});

function waitIn(text: string): number {
  const m = /^(\d+) (second|minute)s?$/.exec(text.trim());
  assert.ok(m, `no wait "${text}"`);
  return Number(m[1]) * (m[2] === "second" ? SECOND : MINUTE);
}

Then("the board mirror row for item {string} was tried again after each failure, after these waits:", long, async function (issue: string, table: DataTable) {
  const row = await oneRow(this, issue, CONSUMER.boardMirror, "board mirror");
  const tries = triesOf(this, row.seq);
  for (const { failure, "tried again after": after } of table.hashes()) {
    const n = Number(failure);
    assert.ok(tries[n], `the board mirror row wasn't tried again after failure ${n}`);
    const waited = Math.round((tries[n].start - tries[n - 1].start) / SECOND) * SECOND;
    assert.equal(waited / SECOND, waitIn(after) / SECOND, `the board mirror row was tried again ${waited / SECOND} seconds after failure ${n}`);
  }
});

Then("the comment command row for item {string} was tried on exactly {int} attempts in all", long, async function (issue: string, n: number) {
  const row = await oneRow(this, issue, CONSUMER.commentCommands, "comment command");
  assert.equal(triesOf(this, row.seq).length, n, `the comment command row for item ${issue} was tried on another number of attempts`);
});

Then("the outbox holds no decision announcement row for item {string}", long, async function (issue: string) {
  assert.deepEqual(await rows(this, issue, CONSUMER.decisionAnnouncement), []);
});

// ---- one item's rows, one behind another ----

async function moveRows(world: object, issue: string, to: string): Promise<{ move: Found; override: Found }> {
  const found = await rows(world, issue, CONSUMER.boardMirror);
  assert.equal(found.length, 2, `the outbox holds ${found.length} board mirror rows for item ${issue}`);
  const move = found.find((r) => r.kind === "transition" && r.payload.to === "InProgress");
  const override = found.find((r) => r.kind === "override" && r.payload.to === to);
  assert.ok(move, `no board mirror row for item ${issue}'s move to InProgress`);
  assert.ok(override, `no board mirror row for item ${issue}'s override to ${to}`);
  return { move, override };
}

Then(
  "the outbox holds two board mirror rows for item {string}, the move to {string} having failed {int} time and the override to {string} having failed no times",
  long,
  async function (issue: string, moveTo: string, n: number, to: string) {
    assert.equal(moveTo, "InProgress");
    const { move, override } = await moveRows(this, issue, to);
    hasFailed(move, n, "move");
    hasFailed(override, 0, "override");
  },
);

Then("the override to {string} for item {string} has still failed no times and has not reached the board", long, async function (to: string, issue: string) {
  const override = (await rows(this, issue, CONSUMER.boardMirror)).find((r) => r.kind === "override" && r.payload.to === to);
  assert.ok(override, `the outbox holds no board mirror row for item ${issue}'s override to ${to}`);
  hasFailed(override, 0, "override");
  assert.equal(triesOf(this, override.seq).length, 0, "the worker tried the override");
  const status = await statusFor(this, to);
  const set = p219(this).asked.filter((c) => on(c, MAIN, issue) && c.method === "setStatus" && c.args[1] === status);
  assert.deepEqual(set, [], `the board was asked to set item ${issue} to "${status}"`);
  const found = await boardNamed(this, MAIN).fake.adapter.getItem(num(issue));
  assert.notEqual(found?.status, status, `the board shows item ${issue} as "${status}"`);
});

Then("the board mirror row for item {string}'s move to {string} is marked failed and set aside", long, async function (issue: string, to: string) {
  const move = (await rows(this, issue, CONSUMER.boardMirror)).find((r) => r.kind === "transition" && r.payload.to === to);
  assert.ok(move, `the outbox holds no board mirror row for item ${issue}'s move to ${to}`);
  setAside(move, "move");
});

Then("the outbox holds no row for item {string} other than the one set aside", long, async function (issue: string) {
  const id = await item(this, issue, MAIN);
  const left = (await outbox()).filter((r) => r.item_id === id);
  assert.equal(left.length, 1, `the outbox holds ${left.length} rows for item ${issue}`);
  setAside(left[0], "remaining");
});

/** The item's comment command rows, with the comment's body. */
async function commandRows(world: object, issue: string, boardName: string): Promise<(Found & { body: string })[]> {
  const found = await rows(world, issue, CONSUMER.commentCommands, boardName);
  return found.map((r) => ({ ...r, body: String((r.payload.event as { body?: unknown } | undefined)?.body ?? "") }));
}

Then("the later comment command row for item {string} on board {string} has failed no times", long, async function (issue: string, boardName: string) {
  const found = await commandRows(this, issue, boardName);
  assert.ok(found.length >= 2, `the outbox holds ${found.length} comment command rows for item ${issue} on board "${boardName}"`);
  for (const later of found.slice(1)) {
    hasFailed(later, 0, `later comment command (${later.body})`);
    assert.equal(triesOf(this, later.seq).length, 0, `the worker tried the later comment command "${later.body}"`);
  }
});

Then(
  "the comment command row for {string} on item {string} on board {string} is marked failed and set aside",
  long,
  async function (body: string, issue: string, boardName: string) {
    const found = (await commandRows(this, issue, boardName)).filter((r) => r.body === body);
    assert.equal(found.length, 1, `the outbox holds ${found.length} comment command rows for "${body}" on item ${issue} on board "${boardName}"`);
    setAside(found[0], `comment command (${body})`);
  },
);
