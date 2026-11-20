// Step definitions for features/pbi-287-api-github-webhook-intake.feature. The API runs in this process from
// src/api/main.ts's startApi on port 7402, on PBI 4's shared test database, through PBI 284's "the API starts" step,
// with PBI 284's fake issuer standing in for the sign-in provider. GitHub's deliveries carry no bearer token, so the
// issuer only lets the API start. PBI 222's "a fresh factory database" empties the database, and its truncate of item
// cascades to event and outbox. PBI 284's "the API answers {int}" and "no webhook event is recorded" read the last
// reply and delivery these steps store in PBI 284's context.
//
// Items are set up with plain SQL, one backlog_source per board. An item's issue number is its external_id.
// "The factory database refuses new events" puts a trigger on event that raises on every insert, dropped after the
// scenario.
//
// The API's contract these steps read:
// - A delivery is recorded as a webhook_delivery row with the delivery id, and one event of kind 'webhook' whose
//   actor is 'system', actor_id 'github', and whose payload carries deliveryId, githubEvent (X-GitHub-Event) and the
//   parsed event: for a comment, kind 'comment', externalId, login and body.
// - A comment-command entry is an outbox row whose consumer is CONSUMER.commentCommands, whose item_id is the item
//   and whose event_id is the webhook event's id.
import { After, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { CONSUMER } from "../../src/store/outbox.ts";
import { long, need } from "./pbi-8.steps.ts";
import { ctx as api, startIssuer, stopAll, type Reply } from "./pbi-284.steps.ts";

const PORT = 7402;
const REPO = "octo/repo";

type Delivery = { event: string; deliveryId: string | null; body: Buffer; reply: Reply };

type Ctx = {
  /** Each board's backlog_source id, by "first" or "second". */
  boards: Map<string, string>;
  /** Each item's id, by its name. */
  items: Map<string, string>;
  /** Every delivery sent, in the order sent. Deliveries sent at the same moment go in the order they were made. */
  deliveries: Delivery[];
  /** The last delivery made, so "the same comment" can be sent again. */
  last?: { event: string; body: Buffer };
  refusesEvents: boolean;
};

function ctx(world: object): Ctx {
  const w = world as { pbi287?: Ctx };
  w.pbi287 ??= { boards: new Map(), items: new Map(), deliveries: [], refusesEvents: false };
  return w.pbi287;
}

const pool = () => need().pool;

After({ tags: "@pbi-287", ...long }, async function () {
  await stopAll(this);
  if (ctx(this).refusesEvents) {
    await pool().query("drop trigger if exists pbi287_refuse_events on event; drop function if exists pbi287_refuse_events()");
  }
});

// ---- the API's settings ----

Given("the API is configured with the webhook secret {string}", long, async function (secret: string) {
  const c = api(this);
  await startIssuer(c);
  c.audience = "factory-api";
  c.webhookSecret = secret;
  c.db = true;
});

// ---- items on boards ----

async function board(world: object, which: "first" | "second"): Promise<string> {
  const c = ctx(world);
  let id = c.boards.get(which);
  if (!id) {
    id = (await pool().query<{ id: string }>(
      "insert into backlog_source (adapter, url) values ('fake', 'pbi-287:' || gen_random_uuid()) returning id")).rows[0].id;
    c.boards.set(which, id);
  }
  return id;
}

async function item(world: object, name: string, issue: number, which: "first" | "second" = "first", state = "InProgress"): Promise<string> {
  const id = (await pool().query<{ id: string }>(
    "insert into item (source_id, external_id, title, state) values ($1, $2, $3, $4) returning id",
    [await board(world, which), String(issue), `item ${name}`, state])).rows[0].id;
  ctx(world).items.set(name, id);
  return id;
}

function itemId(world: object, name: string): string {
  const id = ctx(world).items.get(name);
  assert.ok(id, `no item "${name}"`);
  return id;
}

Given("item {string} on a board has issue number {int}", long, async function (name: string, issue: number) {
  await item(this, name, issue);
});

Given("item {string} on the first board has issue number {int}", long, async function (name: string, issue: number) {
  await item(this, name, issue, "first");
});

Given("item {string} on a second board also has issue number {int}", long, async function (name: string, issue: number) {
  await item(this, name, issue, "second");
});

Given("item {string} has issue number {int}", long, async function (name: string, issue: number) {
  await item(this, name, issue);
});

Given("item {string} has issue number {int} and waits for the owner's sign-off", long, async function (name: string, issue: number) {
  const id = await item(this, name, issue, "first", "SignOff");
  await pool().query("insert into run (item_id, next_stage, scenarios_sha) values ($1, 'sign-off', 'abc123')", [id]);
  await pool().query("insert into question (item_id, kind, body) values ($1, 'sign_off', 'Please sign off the scenarios.')", [id]);
});

Given("{string} is the owner with GitHub login {string}", long, async function (name: string, login: string) {
  const c = api(this);
  assert.ok(c.issuerUrl, "the API isn't configured with an issuer");
  await pool().query(
    `insert into "user" (issuer, subject, github_login, role, product_owner) values ($1, $2, $3, 'owner', true)`,
    [c.issuerUrl, name, login]);
});

Given("the factory database refuses new events", long, async function () {
  ctx(this).refusesEvents = true;
  await pool().query(`
    create or replace function pbi287_refuse_events() returns trigger language plpgsql as $$
    begin
      raise exception 'pbi287: the factory database refuses new events';
    end $$`);
  await pool().query(`drop trigger if exists pbi287_refuse_events on event;
    create trigger pbi287_refuse_events before insert on event for each row execute function pbi287_refuse_events()`);
});

// ---- deliveries ----

const comment = (issue: number, body = "Looks good.", login = "someone") => Buffer.from(JSON.stringify({
  action: "created", repository: { full_name: REPO }, issue: { number: issue, title: `Issue ${issue}` },
  comment: { id: 287_000 + issue, body, user: { login, type: "User" } },
  sender: { login, type: "User" },
}));

const issueChange = (issue: number) => Buffer.from(JSON.stringify({
  action: "edited", repository: { full_name: REPO }, issue: { number: issue, title: `Issue ${issue}, retitled` },
  changes: { title: { from: `Issue ${issue}` } }, sender: { login: "someone", type: "User" },
}));

const sha256 = (secret: string, body: Buffer) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const sha1 = (secret: string, body: Buffer) => `sha1=${createHmac("sha1", secret).update(body).digest("hex")}`;

type Send = { event: string; deliveryId: string | null; body: Buffer; signature: Record<string, string>; sent?: Buffer };

/** Posts one delivery to the API, with no bearer token, and records what it answered. */
async function post(world: object, s: Send): Promise<Delivery> {
  const headers: Record<string, string> = { "content-type": "application/json", "x-github-event": s.event, ...s.signature };
  if (s.deliveryId !== null) headers["x-github-delivery"] = s.deliveryId;
  let reply: Reply;
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/webhooks/github`, { method: "POST", headers, body: new Uint8Array(s.sent ?? s.body) });
    reply = { status: r.status, text: await r.text() };
  } catch (e) {
    // Nothing answered. The Then that reads the reply fails on it.
    reply = { status: null, text: "", error: String((e as Error).cause ?? e) };
  }
  return { event: s.event, deliveryId: s.deliveryId, body: s.body, reply };
}

/** Sends the deliveries at once, then makes the last of them PBI 284's last reply and delivery. */
async function deliver(world: object, ...sends: Send[]): Promise<void> {
  const c = ctx(world);
  const done = await Promise.all(sends.map((s) => post(world, s)));
  c.deliveries.push(...done);
  const last = sends.at(-1)!;
  c.last = { event: last.event, body: last.body };
  const a = api(world);
  a.reply = done.at(-1)!.reply;
  a.delivery = last.deliveryId ?? undefined;
}

const signed = (secret: string, body: Buffer) => ({ "x-hub-signature-256": sha256(secret, body) });

When("GitHub delivers a comment on issue {int} to port {int} as delivery {string}, signed with {string}", long, async function (issue: number, _port: number, id: string, secret: string) {
  const body = comment(issue);
  await deliver(this, { event: "issue_comment", deliveryId: id, body, signature: signed(secret, body) });
});

When("GitHub delivers a comment on issue {int} to port {int} as delivery {string}, with no signature", long, async function (issue: number, _port: number, id: string) {
  await deliver(this, { event: "issue_comment", deliveryId: id, body: comment(issue), signature: {} });
});

When("GitHub delivers a comment on issue {int} to port {int} as delivery {string}, with only a SHA-1 signature made with {string}", long, async function (issue: number, _port: number, id: string, secret: string) {
  const body = comment(issue);
  await deliver(this, { event: "issue_comment", deliveryId: id, body, signature: { "x-hub-signature": sha1(secret, body) } });
});

When("GitHub delivers a comment on issue {int} to port {int} as delivery {string}, signed with {string}, and the body is altered in transit", long, async function (issue: number, _port: number, id: string, secret: string) {
  const body = comment(issue);
  // The same comment saying something else, still valid JSON, under the original body's signature.
  const altered = comment(issue, "Looks bad.");
  await deliver(this, { event: "issue_comment", deliveryId: id, body, signature: signed(secret, body), sent: altered });
});

When("GitHub delivers a comment on issue {int} to port {int} with no delivery id, signed with {string}", long, async function (issue: number, _port: number, secret: string) {
  const body = comment(issue);
  await deliver(this, { event: "issue_comment", deliveryId: null, body, signature: signed(secret, body) });
});

When("GitHub delivers a body that isn't JSON to port {int} as delivery {string}, signed with {string}", long, async function (_port: number, id: string, secret: string) {
  const body = Buffer.from("action=created&issue=42");
  await deliver(this, { event: "issue_comment", deliveryId: id, body, signature: signed(secret, body) });
});

function same(world: object): { event: string; body: Buffer } {
  const last = ctx(world).last;
  assert.ok(last, "nothing was delivered before");
  return last;
}

When("GitHub delivers the same comment to port {int} again as delivery {string}, signed with {string}", long, async function (_port: number, id: string, secret: string) {
  const { event, body } = same(this);
  await deliver(this, { event, deliveryId: id, body, signature: signed(secret, body) });
});

When("GitHub delivers the same comment to port {int} as delivery {string}, signed with {string}", long, async function (_port: number, id: string, secret: string) {
  const { event, body } = same(this);
  await deliver(this, { event, deliveryId: id, body, signature: signed(secret, body) });
});

When("GitHub delivers a comment on issue {int} to port {int} as delivery {string} twice at the same moment, both signed with {string}", long, async function (issue: number, _port: number, id: string, secret: string) {
  const body = comment(issue);
  const send = { event: "issue_comment", deliveryId: id, body, signature: signed(secret, body) };
  await deliver(this, send, { ...send });
});

When("GitHub delivers a comment {string} by {string} on issue {int} to port {int} as delivery {string}, signed with {string}", long, async function (text: string, login: string, issue: number, _port: number, id: string, secret: string) {
  const body = comment(issue, text, login);
  await deliver(this, { event: "issue_comment", deliveryId: id, body, signature: signed(secret, body) });
});

When("GitHub delivers a change to issue {int} to port {int} as delivery {string}, signed with {string}", long, async function (issue: number, _port: number, id: string, secret: string) {
  const body = issueChange(issue);
  await deliver(this, { event: "issues", deliveryId: id, body, signature: signed(secret, body) });
});

// ---- what the API answered ----

const said = (r: Reply) => `${r.status ?? r.error}: ${r.text.slice(0, 300)}`;

function started(world: object): void {
  const a = api(world);
  assert.ok(a.started, "the API wasn't started");
  assert.ok(!a.startError, `the API didn't start: ${String((a.startError as Error)?.message ?? a.startError)}`);
}

function nth(world: object, i: number): Reply {
  started(world);
  const d = ctx(world).deliveries[i];
  assert.ok(d, `there was no delivery ${i + 1}`);
  return d.reply;
}

Then("the API answers {int} to the first delivery", function (status: number) {
  const r = nth(this, 0);
  assert.equal(r.status, status, `the API answered the first delivery ${said(r)}`);
});

Then("the API answers {int} to the second delivery", function (status: number) {
  const r = nth(this, 1);
  assert.equal(r.status, status, `the API answered the second delivery ${said(r)}`);
});

Then("the API answers {int} to both deliveries", function (status: number) {
  assert.deepEqual([nth(this, 0).status, nth(this, 1).status], [status, status],
    `the API answered ${said(nth(this, 0))} and ${said(nth(this, 1))}`);
});

Then("one delivery is answered {int} and the other {int}", function (one: number, other: number) {
  const got = [nth(this, 0).status, nth(this, 1).status].sort();
  assert.deepEqual(got, [one, other].sort(), `the API answered ${said(nth(this, 0))} and ${said(nth(this, 1))}`);
});

Then("the API answers with a server error", function () {
  started(this);
  const r = api(this).reply;
  assert.ok(r, "nothing was delivered");
  assert.ok(r.status !== null && r.status >= 500 && r.status < 600, `the API answered ${said(r)}`);
});

// ---- what the API recorded ----

type WebhookEvent = { id: string; actor: string; actor_id: string; item_id: string | null; payload: Record<string, any> };

async function eventsFor(deliveryId: string): Promise<WebhookEvent[]> {
  return (await pool().query<WebhookEvent>(
    "select id, actor, actor_id, item_id, payload from event where kind = 'webhook' and payload->>'deliveryId' = $1", [deliveryId])).rows;
}

async function theEvent(deliveryId: string): Promise<WebhookEvent> {
  const events = await eventsFor(deliveryId);
  assert.equal(events.length, 1, `delivery "${deliveryId}" has ${events.length} webhook events`);
  return events[0];
}

Then("one webhook event is recorded for delivery {string}", long, async function (deliveryId: string) {
  await theEvent(deliveryId);
  const remembered = (await pool().query("select count(*)::int as n from webhook_delivery where id = $1", [deliveryId])).rows[0].n;
  assert.equal(remembered, 1, `delivery "${deliveryId}" isn't remembered as received`);
});

Then("delivery {string} is not remembered as received", long, async function (deliveryId: string) {
  const remembered = (await pool().query("select count(*)::int as n from webhook_delivery where id = $1", [deliveryId])).rows[0].n;
  assert.equal(remembered, 0, `delivery "${deliveryId}" is remembered as received`);
});

Then("that event is GitHub's, names the GitHub event {string}, and carries the comment {string} by {string} on issue {int}", long, async function (githubEvent: string, text: string, login: string, issue: number) {
  const deliveryId = api(this).delivery;
  assert.ok(deliveryId, "no delivery was made");
  const e = await theEvent(deliveryId);
  assert.deepEqual({ actor: e.actor, actorId: e.actor_id }, { actor: "system", actorId: "github" });
  assert.equal(e.payload.githubEvent, githubEvent);
  const c = e.payload.event ?? {};
  assert.deepEqual({ kind: c.kind, body: c.body, login: c.login, externalId: c.externalId },
    { kind: "comment", body: text, login, externalId: String(issue) }, `the event carries ${JSON.stringify(e.payload)}`);
});

type Entry = { event_id: string; item_id: string | null };

async function entries(itemId?: string): Promise<Entry[]> {
  return (await pool().query<Entry>(
    "select event_id, item_id from outbox where consumer = $1 and ($2::uuid is null or item_id = $2) order by seq",
    [CONSUMER.commentCommands, itemId ?? null])).rows;
}

Then("no comment-command entry is queued", long, async function () {
  const rows = await entries();
  assert.equal(rows.length, 0, `comment-command entries are queued: ${JSON.stringify(rows)}`);
});

Then("no comment-command entry is queued for item {string}", long, async function (name: string) {
  const rows = await entries(itemId(this, name));
  assert.equal(rows.length, 0, `item "${name}" has comment-command entries: ${JSON.stringify(rows)}`);
});

Then("one comment-command entry is queued for item {string}", long, async function (name: string) {
  const rows = await entries(itemId(this, name));
  assert.equal(rows.length, 1, `item "${name}" has ${rows.length} comment-command entries`);
});

Then("one comment-command entry is queued for item {string}, caused by the webhook event for delivery {string}", long, async function (name: string, deliveryId: string) {
  const rows = await entries(itemId(this, name));
  assert.equal(rows.length, 1, `item "${name}" has ${rows.length} comment-command entries`);
  const e = await theEvent(deliveryId);
  assert.equal(rows[0].event_id, e.id, `item "${name}"'s entry was caused by event ${rows[0].event_id}, not delivery "${deliveryId}"'s`);
});

Then("item {string} still waits for the owner's sign-off", long, async function (name: string) {
  const s = (await pool().query<{ state: string; answer: string | null; next_stage: string | null }>(
    `select i.state, q.answer, (select next_stage from run where item_id = i.id and ended_at is null order by started_at desc limit 1) as next_stage
     from item i join question q on q.item_id = i.id and q.kind = 'sign_off' where i.id = $1`, [itemId(this, name)])).rows[0];
  assert.deepEqual(s, { state: "SignOff", answer: null, next_stage: "sign-off" }, `item "${name}" is ${JSON.stringify(s)}`);
});
