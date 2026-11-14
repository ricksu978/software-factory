// Step definitions for features/pbi-218-outbox-rows-in-event-transaction.feature. The scenarios share PBI 8's
// database, which PBI 156's two-boards step empties. Rows are set up with plain SQL, so no setup writes an outbox row, and only
// the behaviour under test goes through transitionItem, overrideItem, decide and handleWebhook.
// A transaction that "fails and rolls back" reads the outbox on its own client just before it throws. A webhook intake
// fails through a deferred constraint trigger on its event: at commit it counts the event's outbox rows and raises an
// error carrying that count, so the intake rolls back after recording the event.
import { Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import type pg from "pg";
import type { FactoryWebhookEvent } from "../../src/adapters/types.ts";
import type { ItemEvent, ItemState } from "../../src/core/states.ts";
import { decide, type Outcome } from "../../src/control/decisions.ts";
import { withTx } from "../../src/store/db.ts";
import { IllegalTransition, overrideItem, transitionItem } from "../../src/store/items.ts";
import { CONSUMER } from "../../src/store/outbox.ts";
import { handleWebhook } from "../../src/watcher/webhook.ts";
import { ctx as p156 } from "./pbi-156.steps.ts";
import { long, need } from "./pbi-8.steps.ts";

type Row = { seq: string; consumer: string; event_id: string; item_id: string | null; attempts: number; failed_at: Date | null };
type Ctx = {
  /** The outbox rows the failing transaction saw just before it rolled back. */
  inside?: Row[];
  /** The id of the event the failing transaction wrote, read inside it. */
  insideEventId?: string;
  /** Each delivery's id by the issue its comment is on, in delivery order. */
  deliveries: { issue: string; id: string }[];
};

function ctx(world: object): Ctx {
  const w = world as { pbi218?: Ctx };
  w.pbi218 ??= { deliveries: [] };
  return w.pbi218;
}

const pool = () => need().pool;
const num = (issue: string) => issue.replace(/^#/, "");
const scheduler = { actor: "system", actorId: "scheduler" } as const;
const operator = { actor: "human", actorId: "operator" } as const;
const SECRET = "pbi-218-secret";
const REPO = "acme/app";

class RolledBack extends Error {
  override name = "RolledBack";
}

function board(world: object, name: string): string {
  const found = p156(world).boards.find((b) => b.name === name);
  assert.ok(found, `no board "${name}"`);
  return found.id;
}

async function item(world: object, issue: string, boardName: string): Promise<string> {
  const r = await pool().query<{ id: string }>("select id from item where source_id = $1 and external_id = $2", [board(world, boardName), num(issue)]);
  assert.ok(r.rows[0], `board "${boardName}" has no item ${issue}`);
  return r.rows[0].id;
}

async function newItem(world: object, issue: string, boardName: string, state: ItemState): Promise<string> {
  const r = await pool().query<{ id: string }>(
    "insert into item (source_id, external_id, title, state) values ($1, $2, $3, $4) returning id",
    [board(world, boardName), num(issue), `item ${issue}`, state],
  );
  return r.rows[0].id;
}

/** The user `name`, made by newUser here or by PBI 175's "{string} is an operator", which keys them on their GitHub login. */
async function user(name: string): Promise<string> {
  const r = await pool().query<{ id: string }>(`select id from "user" where github_login = $1`, [name]);
  assert.ok(r.rows[0], `no user "${name}"`);
  return r.rows[0].id;
}

async function newUser(name: string, role: "viewer" | "operator", productOwner: boolean): Promise<void> {
  await pool().query(
    `insert into "user" (provider, subject, github_login, role, product_owner) values ('dev', $1, $1, $2, $3)`,
    [name, role, productOwner],
  );
}

async function outbox(c: pg.Pool | pg.PoolClient = pool()): Promise<Row[]> {
  return (await c.query<Row>("select seq, consumer, event_id, item_id, attempts, failed_at from outbox order by seq")).rows;
}

async function eventOf(eventId: string): Promise<{ kind: string; actor_id: string; item_id: string | null; payload: Record<string, unknown> }> {
  const r = await pool().query("select kind, actor_id, item_id, payload from event where id = $1", [eventId]);
  assert.ok(r.rows[0], `no event ${eventId}`);
  return r.rows[0];
}

/** Runs fn in a transaction, reads the outbox and fn's latest event of `kind` on the same client, then rolls back. */
async function rolledBack(world: object, kind: string, fn: (c: pg.PoolClient) => Promise<unknown>): Promise<void> {
  const c = ctx(world);
  try {
    await withTx(pool(), async (client) => {
      await fn(client);
      c.inside = await outbox(client);
      c.insideEventId = (await client.query<{ id: string }>("select id from event where kind = $1 order by at desc limit 1", [kind])).rows[0]?.id;
      throw new RolledBack("the transaction fails");
    });
  } catch (e) {
    if (!(e instanceof RolledBack)) throw e;
  }
}

// ---- the background ----

// PBI 156's "a fresh factory database with two boards" makes the boards, and its truncate of item cascades to event and outbox.
Given("the outbox is empty", long, async function () {
  await pool().query("truncate outbox");
});

// ---- items and people ----

Given("item {string} on board {string} is {string}", long, async function (issue: string, boardName: string, state: ItemState) {
  await newItem(this, issue, boardName, state);
});

Given("item {string} on board {string} is waiting in {string} for its scenarios to be signed off", long, async function (issue: string, boardName: string, state: ItemState) {
  const id = await newItem(this, issue, boardName, state);
  await pool().query("insert into run (item_id, next_stage, scenarios_sha) values ($1, 'specify', 'abc123')", [id]);
  await pool().query("insert into question (item_id, kind, body) values ($1, 'sign_off', 'Please sign off the scenarios.')", [id]);
});

Given("item {string} on board {string} went to {string} after timing out on a question still waiting for an answer", long, async function (issue: string, boardName: string, state: ItemState) {
  const id = await newItem(this, issue, boardName, state);
  await pool().query("insert into run (item_id, next_stage) values ($1, 'green')", [id]);
  await pool().query("insert into question (item_id, kind, body) values ($1, 'needs_input', 'Which port?')", [id]);
  await pool().query(
    "insert into event (actor, actor_id, item_id, kind, payload) values ('system', 'scheduler', $1, 'transition', $2)",
    [id, JSON.stringify({ from: "NeedsInput", to: state, event: "timed_out" })],
  );
});

Given("{string} is a product owner", long, async function (name: string) {
  await newUser(name, "viewer", true);
});

Given("{string} is an operator but not a product owner", long, async function (name: string) {
  await newUser(name, "operator", false);
});

Given("item {string} exists on board {string} only", long, async function (issue: string, boardName: string) {
  await newItem(this, issue, boardName, "InReview");
});

Given("item {string} exists on board {string}", long, async function (issue: string, boardName: string) {
  await newItem(this, issue, boardName, "InReview");
});

Given("board {string} has no item {string}", long, async function (boardName: string, issue: string) {
  const r = await pool().query("select 1 from item where source_id = $1 and external_id = $2", [board(this, boardName), num(issue)]);
  assert.equal(r.rowCount, 0, `board "${boardName}" has item ${issue}`);
});

Given("no board has an item {string}", long, async function (issue: string) {
  const r = await pool().query("select 1 from item where external_id = $1", [num(issue)]);
  assert.equal(r.rowCount, 0, `a board has item ${issue}`);
});

// ---- transitions ----

const MOVES: Record<string, ItemEvent> = { "Queued>InProgress": "claimed" };

async function move(world: object, client: pg.PoolClient, issue: string, boardName: string, to: ItemState): Promise<void> {
  const id = await item(world, issue, boardName);
  const from = (await client.query<{ state: ItemState }>("select state from item where id = $1", [id])).rows[0].state;
  const event = MOVES[`${from}>${to}`];
  assert.ok(event, `no scheduler move from ${from} to ${to}`);
  await transitionItem(client, id, event, scheduler);
}

When("the scheduler moves item {string} on board {string} to {string} and the transaction commits", long, async function (issue: string, boardName: string, to: ItemState) {
  await withTx(pool(), (c) => move(this, c, issue, boardName, to));
});

When("the scheduler moves item {string} on board {string} to {string} in a transaction that then fails and rolls back", long, async function (issue: string, boardName: string, to: ItemState) {
  await rolledBack(this, "transition", (c) => move(this, c, issue, boardName, to));
});

When(
  "item {string} on board {string} moves to {string} on a merge and then to {string} on a verified definition of done, in one transaction that commits",
  long,
  async function (issue: string, boardName: string, first: string, second: string) {
    const id = await item(this, issue, boardName);
    await withTx(pool(), async (c) => {
      assert.equal(await transitionItem(c, id, "merged", { actor: "system", actorId: "github" }), first);
      assert.equal(await transitionItem(c, id, "dod_verified", scheduler), second);
    });
  },
);

When("the scheduler tries to move item {string} on board {string} along an edge that doesn't exist from {string}", long, async function (issue: string, boardName: string, from: ItemState) {
  const id = await item(this, issue, boardName);
  await assert.rejects(withTx(pool(), (c) => transitionItem(c, id, "dod_verified", scheduler)), IllegalTransition, `${from} has an edge on dod_verified`);
});

// ---- overrides ----

When("an operator overrides item {string} on board {string} to {string} with the reason {string} and the transaction commits", long, async function (issue: string, boardName: string, to: ItemState, reason: string) {
  const id = await item(this, issue, boardName);
  await withTx(pool(), (c) => overrideItem(c, id, to, operator, reason));
});

When("an operator overrides item {string} on board {string} to {string} in a transaction that then fails and rolls back", long, async function (issue: string, boardName: string, to: ItemState) {
  const id = await item(this, issue, boardName);
  await rolledBack(this, "override", (c) => overrideItem(c, id, to, operator, "stuck run"));
});

// ---- decisions ----

async function decision(world: object, client: pg.PoolClient, name: string, kind: "approve" | "answer", issue: string, boardName: string): Promise<Outcome> {
  const itemId = await item(world, issue, boardName);
  return decide(client, { itemId, userId: await user(name), kind, text: kind === "answer" ? "Port 8080." : "", via: "dashboard" });
}

When("{string} approves the scenarios of item {string} on board {string} and the transaction commits", long, async function (name: string, issue: string, boardName: string) {
  const outcome = await withTx(pool(), (c) => decision(this, c, name, "approve", issue, boardName));
  assert.equal(outcome, "applied", `${name}'s approval was ${outcome}`);
});

When("{string} approves the scenarios of item {string} on board {string} in a transaction that then fails and rolls back", long, async function (name: string, issue: string, boardName: string) {
  await rolledBack(this, "decision", async (c) => {
    const outcome = await decision(this, c, name, "approve", issue, boardName);
    assert.equal(outcome, "applied", `${name}'s approval was ${outcome}`);
  });
});

When("{string} answers the question of item {string} on board {string} and the transaction commits", long, async function (name: string, issue: string, boardName: string) {
  const outcome = await withTx(pool(), (c) => decision(this, c, name, "answer", issue, boardName));
  assert.equal(outcome, "applied", `${name}'s answer was ${outcome}`);
});

When("{string} tries to approve the scenarios of item {string} on board {string} and is refused", long, async function (name: string, issue: string, boardName: string) {
  const outcome = await withTx(pool(), (c) => decision(this, c, name, "approve", issue, boardName));
  assert.equal(outcome, "forbidden", `${name}'s approval was ${outcome}`);
});

// ---- webhook comments ----

async function deliver(world: object, issue: string, id: string, body: string): Promise<{ status: number }> {
  const raw = Buffer.from(JSON.stringify({ issue: { number: Number(num(issue)) }, comment: { id, body } }));
  const headers = {
    "x-github-delivery": id, "x-github-event": "issue_comment", "content-type": "application/json",
    "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`,
  };
  // Parsing GitHub's payload is the adapter's job, so a stub hands over the comment it names.
  const parse = (): FactoryWebhookEvent => ({ kind: "comment", externalId: num(issue), repo: REPO, login: "pat", body, commentId: id });
  ctx(world).deliveries.push({ issue, id });
  return handleWebhook({ pool: pool(), secret: SECRET, parse }, { headers, rawBody: raw });
}

function lastDelivery(world: object): string {
  const d = ctx(world).deliveries.at(-1);
  assert.ok(d, "nothing was delivered");
  return d.id;
}

function deliveryOn(world: object, issue: string): string {
  const d = ctx(world).deliveries.find((x) => x.issue === issue);
  assert.ok(d, `no comment was delivered on issue ${issue}`);
  return d.id;
}

async function webhookEvents(deliveryId: string): Promise<string[]> {
  return (await pool().query<{ id: string }>("select id from event where kind = 'webhook' and payload->>'deliveryId' = $1", [deliveryId])).rows.map((r) => r.id);
}

When("GitHub delivers a comment {string} on issue {string}", long, async function (body: string, issue: string) {
  assert.equal((await deliver(this, issue, randomUUID(), body)).status, 204);
});

When("GitHub then delivers a comment {string} on issue {string}", long, async function (body: string, issue: string) {
  assert.equal((await deliver(this, issue, randomUUID(), body)).status, 204);
});

When("GitHub redelivers the same delivery", long, async function () {
  const first = ctx(this).deliveries.at(-1);
  assert.ok(first, "nothing was delivered");
  assert.equal((await deliver(this, first.issue, first.id, "/approve")).status, 200);
});

When("GitHub delivers a comment {string} on issue {string} and the intake transaction fails after recording the event", long, async function (body: string, issue: string) {
  const c = ctx(this);
  const id = randomUUID();
  // Deferred, so it runs at commit, after the intake has written everything, and its error rolls the intake back.
  await pool().query(`
    create or replace function pbi218_fail_intake() returns trigger language plpgsql as $$
    begin
      if new.kind = 'webhook' and new.payload->>'deliveryId' = '${id}' then
        raise exception 'pbi218 outbox rows for %: %', new.id,
          (select coalesce(json_agg(json_build_object('seq', seq, 'consumer', consumer, 'event_id', event_id, 'item_id', item_id) order by seq), '[]') from outbox);
      end if;
      return null;
    end $$`);
  await pool().query(`drop trigger if exists pbi218_fail_intake on event;
    create constraint trigger pbi218_fail_intake after insert on event deferrable initially deferred
    for each row execute function pbi218_fail_intake()`);
  try {
    await assert.rejects(deliver(this, issue, id, body), (e: Error) => {
      const m = /^pbi218 outbox rows for ([0-9a-f-]+): (.*)$/s.exec(e.message);
      assert.ok(m, `the intake failed for another reason: ${e.message}`);
      c.insideEventId = m[1];
      c.inside = JSON.parse(m[2]) as Row[];
      return true;
    });
  } finally {
    await pool().query("drop trigger if exists pbi218_fail_intake on event; drop function if exists pbi218_fail_intake()");
  }
});

// ---- the outbox ----

const CONSUMERS: Record<string, string> = {
  "board mirror": CONSUMER.boardMirror,
  "decision announcement": CONSUMER.decisionAnnouncement,
  "comment command": CONSUMER.commentCommands,
  "comment commands": CONSUMER.commentCommands,
};

function consumer(name: string): string {
  const c = CONSUMERS[name];
  assert.ok(c, `no consumer "${name}"`);
  return c;
}

function describe(rows: Row[]): string {
  return JSON.stringify(rows.map((r) => ({ consumer: r.consumer, item: r.item_id, event: r.event_id })));
}

/** The one row of `consumer` in the outbox, which must hold nothing else. */
async function onlyRow(world: object, name: string, issue: string, boardName: string): Promise<Row> {
  const rows = await outbox();
  assert.equal(rows.length, 1, `the outbox holds ${rows.length} rows: ${describe(rows)}`);
  assert.equal(rows[0].consumer, consumer(name));
  assert.equal(rows[0].item_id, await item(world, issue, boardName), `the row isn't for item ${issue} on board "${boardName}"`);
  return rows[0];
}

Then("the outbox holds exactly one row for the board mirror, for item {string} on board {string}", long, async function (issue: string, boardName: string) {
  await onlyRow(this, "board mirror", issue, boardName);
});

Then("the outbox holds exactly one row for the decision announcement, for item {string} on board {string}", long, async function (issue: string, boardName: string) {
  await onlyRow(this, "decision announcement", issue, boardName);
});

Then("the outbox holds exactly one row, the board mirror row for item {string} on board {string}", long, async function (issue: string, boardName: string) {
  await onlyRow(this, "board mirror", issue, boardName);
});

Then("the outbox holds exactly one row, the decision announcement row for item {string} on board {string}", long, async function (issue: string, boardName: string) {
  await onlyRow(this, "decision announcement", issue, boardName);
});

Then("the outbox holds exactly one row for comment commands, for item {string} on board {string}", long, async function (issue: string, boardName: string) {
  const rows = (await outbox()).filter((r) => r.consumer === CONSUMER.commentCommands);
  assert.equal(rows.length, 1, `the outbox holds ${rows.length} comment command rows: ${describe(rows)}`);
  assert.equal(rows[0].item_id, await item(this, issue, boardName), `the row isn't for item ${issue} on board "${boardName}"`);
});

Then("that row points at the transition event from {string} to {string}", long, async function (from: string, to: string) {
  const [row] = await outbox();
  const e = await eventOf(row.event_id);
  assert.equal(e.kind, "transition");
  assert.equal(e.item_id, row.item_id, "the event is for another item");
  assert.deepEqual([e.payload.from, e.payload.to], [from, to]);
});

Then("that row has not been attempted yet and is not set aside", long, async function () {
  const [row] = await outbox();
  assert.equal(row.attempts, 0, "the row has been attempted");
  assert.equal(row.failed_at, null, "the row is set aside");
});

Then("that row points at the override event to {string} with the reason {string}", long, async function (to: string, reason: string) {
  const [row] = await outbox();
  const e = await eventOf(row.event_id);
  assert.equal(e.kind, "override");
  assert.equal(e.item_id, row.item_id, "the event is for another item");
  assert.deepEqual([e.payload.to, e.payload.reason], [to, reason]);
});

Then("that row points at the {string} decision event by {string}", long, async function (kind: string, name: string) {
  const [row] = await outbox();
  const e = await eventOf(row.event_id);
  assert.equal(e.kind, "decision");
  assert.equal(e.item_id, row.item_id, "the event is for another item");
  assert.equal(e.payload.kind, kind);
  assert.equal(e.actor_id, await user(name));
});

Then("that row points at the webhook event for that delivery", long, async function () {
  const [row] = (await outbox()).filter((r) => r.consumer === CONSUMER.commentCommands);
  assert.deepEqual([row.event_id], await webhookEvents(lastDelivery(this)));
});

Then("the outbox holds two board mirror rows for item {string} on board {string}", long, async function (issue: string, boardName: string) {
  const rows = await outbox();
  const id = await item(this, issue, boardName);
  assert.equal(rows.length, 2, `the outbox holds ${rows.length} rows: ${describe(rows)}`);
  for (const r of rows) assert.deepEqual([r.consumer, r.item_id], [CONSUMER.boardMirror, id]);
});

Then("the earlier row points at the move to {string} and the later row at the move to {string}", long, async function (first: string, second: string) {
  const rows = await outbox();
  assert.equal(rows.length, 2, `the outbox holds ${rows.length} rows`);
  const tos = [];
  for (const r of rows) {
    const e = await eventOf(r.event_id);
    assert.equal(e.kind, "transition");
    tos.push(e.payload.to);
  }
  assert.deepEqual(tos, [first, second]);
});

Then("the outbox holds one board mirror row for the move from {string} to {string}", long, async function (from: string, to: string) {
  const rows = (await outbox()).filter((r) => r.consumer === CONSUMER.boardMirror);
  assert.equal(rows.length, 1, `the outbox holds ${rows.length} board mirror rows`);
  const e = await eventOf(rows[0].event_id);
  assert.equal(e.kind, "transition");
  assert.deepEqual([e.payload.from, e.payload.to], [from, to]);
});

Then("the outbox holds one decision announcement row for the {string} decision event by {string}", long, async function (kind: string, name: string) {
  const rows = (await outbox()).filter((r) => r.consumer === CONSUMER.decisionAnnouncement);
  assert.equal(rows.length, 1, `the outbox holds ${rows.length} decision announcement rows`);
  const e = await eventOf(rows[0].event_id);
  assert.equal(e.kind, "decision");
  assert.equal(e.payload.kind, kind);
  assert.equal(e.actor_id, await user(name));
});

Then("both rows are for item {string} on board {string}", long, async function (issue: string, boardName: string) {
  const rows = await outbox();
  assert.equal(rows.length, 2, `the outbox holds ${rows.length} rows`);
  const id = await item(this, issue, boardName);
  for (const r of rows) assert.equal(r.item_id, id);
});

Then("inside that transaction, before it rolled back, the outbox held a {word} {word} row for the {word} event", long, async function (a: string, b: string, _event: string) {
  const c = ctx(this);
  assert.ok(c.inside, "nothing was read inside the transaction");
  assert.ok(c.insideEventId, "the transaction wrote no event");
  const rows = c.inside.filter((r) => r.event_id === c.insideEventId);
  assert.equal(rows.length, 1, `inside the transaction the outbox held ${rows.length} rows for its event: ${describe(c.inside)}`);
  assert.equal(rows[0].consumer, consumer(`${a} ${b}`));
});

Then("after the rollback the outbox holds no row", long, async function () {
  assert.deepEqual(await outbox(), []);
});

Then("item {string} on board {string} is still {string} with no {word} event recorded", long, async function (issue: string, boardName: string, state: string, kind: string) {
  const id = await item(this, issue, boardName);
  const r = await pool().query<{ state: string }>("select state from item where id = $1", [id]);
  assert.equal(r.rows[0].state, state);
  const events = await pool().query("select 1 from event where item_id = $1 and kind = $2", [id, kind]);
  assert.equal(events.rowCount, 0, `a ${kind} event is recorded`);
});

Then("no decision event is recorded for item {string} on board {string}", long, async function (issue: string, boardName: string) {
  const events = await pool().query("select 1 from event where item_id = $1 and kind = 'decision'", [await item(this, issue, boardName)]);
  assert.equal(events.rowCount, 0, "a decision event is recorded");
});

Then("the webhook event for that delivery is recorded", long, async function () {
  assert.equal((await webhookEvents(lastDelivery(this))).length, 1);
});

Then("no webhook event is recorded for that delivery", long, async function () {
  assert.deepEqual(await webhookEvents(lastDelivery(this)), []);
});

Then("exactly one webhook event is recorded for that delivery", long, async function () {
  assert.equal((await webhookEvents(lastDelivery(this))).length, 1);
});

Then("the outbox holds exactly two rows for comment commands", long, async function () {
  const rows = (await outbox()).filter((r) => r.consumer === CONSUMER.commentCommands);
  assert.equal(rows.length, 2, `the outbox holds ${rows.length} comment command rows: ${describe(rows)}`);
});

Then("one row is for item {string} on board {string} and the other for item {string} on board {string}", long, async function (i1: string, b1: string, i2: string, b2: string) {
  const rows = (await outbox()).filter((r) => r.consumer === CONSUMER.commentCommands);
  assert.deepEqual(rows.map((r) => r.item_id).sort(), [await item(this, i1, b1), await item(this, i2, b2)].sort());
});

Then("both rows point at the same webhook event for that delivery", long, async function () {
  const rows = (await outbox()).filter((r) => r.consumer === CONSUMER.commentCommands);
  const events = await webhookEvents(lastDelivery(this));
  assert.equal(events.length, 1);
  assert.equal(rows.length, 2);
  for (const r of rows) assert.equal(r.event_id, events[0]);
});

Then("the webhook events for both deliveries are recorded", long, async function () {
  const all = ctx(this).deliveries;
  assert.equal(all.length, 2);
  for (const d of all) assert.equal((await webhookEvents(d.id)).length, 1, `no webhook event for the comment on issue ${d.issue}`);
});

Then("no outbox row points at the webhook event for the comment on issue {string}", long, async function (issue: string) {
  const events = await webhookEvents(deliveryOn(this, issue));
  const rows = (await outbox()).filter((r) => events.includes(r.event_id));
  assert.deepEqual(rows, []);
});
