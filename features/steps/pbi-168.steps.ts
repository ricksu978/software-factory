// Step definitions for features/pbi-168-withdraw-before-queue.feature. The scenarios reuse PBI 12's poller harness, so
// its "the poller runs once", "a person removes the item's label", "a person closes the item" and "the factory holds
// the item in state" steps, and PBI 142's "the poller runs twice" and "the item still carries its label", read the same
// context. Items are put in their starting state with plain SQL, since no move the factory makes today reaches them:
// a withdrawal from NotReady or Eligible is what this item adds, so a Given can't ask the poller for one. The
// dashboard's "Not ready" list is read from Floor as the real dashboard renders it, on a free port.
import { Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { fakeBacklog } from "../../src/adapters/fake.ts";
import { createAuth } from "../../src/http/auth.ts";
import { dashboardRoutes } from "../../src/http/routes.ts";
import { startServer } from "../../src/http/server.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";
import { ctx as pollCtx, polled, REPO, setup, stateOf, type Ctx as PollCtx } from "./pbi-12.steps.ts";
import { scope } from "./pbi-131.steps.ts";

type Move = { from: string; to: string };
/** The move a "after it" step follows. */
type Ctx = { last?: Move; checksBefore: number };

function ctx(world: object): Ctx {
  const w = world as { pbi168?: Ctx };
  w.pbi168 ??= { checksBefore: 0 };
  return w.pbi168;
}

const pool = () => need().pool;
const LABEL = "factory";
const title = (ext: string) => `Withdrawn before the queue ${ext}`;
const VIEWER = "pbi-168-viewer";

Before({ tags: "@pbi-168 and @db", ...long }, async function () {
  const d = await testDb();
  if (d) await d.pool.query('truncate item, event, backlog_source, repo, "user" cascade');
});

async function itemId(c: PollCtx, ext: string): Promise<string> {
  const r = await pool().query<{ id: string }>("select id from item where source_id = $1 and external_id = $2", [c.sourceId, ext]);
  assert.ok(r.rows[0], `the factory doesn't hold item ${ext}`);
  return r.rows[0].id;
}

/** A labelled board item in REPO that the factory holds in `state`, with a judge that reports its spend. */
async function hold(world: object, state: string, ext?: string): Promise<PollCtx> {
  const c = pollCtx(world);
  assert.ok(await setup(c), "the poller's fakes or database aren't available");
  c.spend = true;
  const id = await c.fake!.seed({ ...(ext ? { externalId: ext } : {}), labels: [LABEL], repo: REPO });
  await c.fake!.seed({ externalId: id, title: title(id), labels: [LABEL], repo: REPO });
  c.extIds = [id];
  await pool().query("insert into item (source_id, external_id, title, state, repo) values ($1, $2, $3, $4, $5)", [c.sourceId, id, title(id), state, REPO]);
  return c;
}

async function unlabel(c: PollCtx): Promise<void> {
  const item = await c.fake!.adapter.getItem(c.extIds[0]);
  assert.ok(item, "the item isn't on the board");
  await c.fake!.seed({ ...item, labels: item.labels.filter((l) => l !== LABEL) });
}

/** Floor's "Not ready" section as the dashboard renders it now. */
async function notReadyList(sourceId: string): Promise<string> {
  await pool().query(
    `insert into "user" (provider, subject, github_login, role) values ('microsoft', $1, $1, 'viewer') on conflict (provider, subject) do nothing`,
    [VIEWER],
  );
  let handler: ReturnType<typeof dashboardRoutes> | undefined;
  const server = await startServer([(req, res) => handler!(req, res)], { port: 0 });
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    handler = dashboardRoutes({ pool: pool(), auth: createAuth({ mode: "azure" }), origin, adapter: fakeBacklog().adapter, sourceId });
    try {
      const r = await fetch(`${origin}/`, {
        headers: { "x-ms-client-principal-idp": "aad", "x-ms-client-principal-id": VIEWER, "x-ms-client-principal-name": VIEWER },
      });
      const html = await r.text();
      assert.equal(r.status, 200, `Floor answered ${r.status}: ${html.slice(0, 300)}`);
      return scope(html, '"Not ready"');
    } finally {
      await handler.close();
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function shows(c: PollCtx, ext: string): Promise<boolean> {
  return (await notReadyList(c.sourceId!)).includes(title(ext));
}

/** The item's moves from `from` to `to`, oldest first, transitions and overrides both. */
async function movesOf(c: PollCtx, from: string, to: string, onlyWithdrawals = false) {
  const r = await pool().query<{ at: Date; actor: string; kind: string; event: string | null }>(
    `select e.at, e.actor, e.kind, e.payload->>'event' as event from event e join item i on i.id = e.item_id
     where i.source_id = $1 and i.external_id = $2 and e.kind in ('transition', 'override')
       and e.payload->>'from' = $3 and e.payload->>'to' = $4 ${onlyWithdrawals ? "and e.payload->>'event' = 'withdrawn'" : ""}
     order by e.at`,
    [c.sourceId, c.extIds[0], from, to],
  );
  return r.rows;
}

async function checks(c: PollCtx): Promise<number> {
  const r = await pool().query<{ n: number }>(
    "select count(*)::int as n from readiness_check k join item i on i.id = k.item_id where i.source_id = $1 and i.external_id = $2",
    [c.sourceId, c.extIds[0]],
  );
  return r.rows[0].n;
}

// ---- the item's starting state ----

Given("the factory holds an item in state {string}", long, async function (state: string) {
  await hold(this, state);
});

// One step for both: Cucumber ignores the keyword. Before the scenario holds the item it's the setup, and after, the
// outcome, which needs a poll to have run.
Given("the factory holds item {int} in state {string}", long, async function (n: number, state: string) {
  const c = pollCtx(this);
  if (!c.extIds.includes(String(n))) {
    await hold(this, state, String(n));
    return;
  }
  polled(c);
  assert.equal(await stateOf(c, String(n)), state);
});

Given("item {int}'s {string} label was removed on the board while earlier polls left it NotReady", long, async function (n: number, label: string) {
  const c = pollCtx(this);
  assert.equal(c.extIds[0], String(n), `the scenario holds item ${c.extIds[0]}`);
  assert.equal(label, LABEL);
  await unlabel(c);
  assert.equal(await stateOf(c, String(n)), "NotReady", "the item isn't held as NotReady");
});

Given(
  "the factory held an item in state {string} and withdrew it to {string} when its label was removed",
  long,
  async function (state: string, to: string) {
    const c = await hold(this, state);
    await unlabel(c);
    // The withdrawal as the poller logs one, written directly: no edge leads there from NotReady or Eligible today.
    const id = await itemId(c, c.extIds[0]);
    await pool().query("update item set state = $2 where id = $1", [id, to]);
    await pool().query(
      "insert into event (actor, actor_id, item_id, kind, payload) values ('system', 'poller', $1, 'transition', $2)",
      [id, JSON.stringify({ from: state, to, event: "withdrawn" })],
    );
    ctx(this).checksBefore = await checks(c);
  },
);

Given("the dashboard's \"Not ready\" list shows the item", long, async function () {
  const c = pollCtx(this);
  assert.ok(await shows(c, c.extIds[0]), `the "Not ready" list doesn't show item ${c.extIds[0]}`);
});

Given("the readiness judge passes every line", function () {
  pollCtx(this).judge = "pass";
});

Given("the readiness judge fails one line of the item's Definition of Ready", function () {
  // The repo's dor.md has one line, so a judge that fails every line fails exactly that one.
  const c = pollCtx(this);
  c.judge = "fail";
  c.failLine = undefined;
});

// ---- what a person does on the board ----

When("a person adds the {string} label back to the item on the board", async function (label: string) {
  const c = pollCtx(this);
  const item = await c.fake!.adapter.getItem(c.extIds[0]);
  assert.ok(item, "the item isn't on the board");
  assert.ok(!item.labels.includes(label), `the item already carries "${label}"`);
  await c.fake!.seed({ ...item, labels: [...item.labels, label] });
});

// ---- outcomes ----


Then("the dashboard's \"Not ready\" list doesn't show the item", long, async function () {
  const c = pollCtx(this);
  polled(c);
  assert.ok(!(await shows(c, c.extIds[0])), `the "Not ready" list still shows item ${c.extIds[0]}`);
});

Then("the dashboard's \"Not ready\" list doesn't show item {int}", long, async function (n: number) {
  const c = pollCtx(this);
  polled(c);
  assert.ok(!(await shows(c, String(n))), `the "Not ready" list still shows item ${n}`);
});

Then("the readiness judge was not asked about the item", function () {
  const c = pollCtx(this);
  polled(c);
  assert.equal(c.asked.get(c.extIds[0]) ?? 0, 0);
});

Then("the item has a new readiness check recorded", long, async function () {
  const c = pollCtx(this);
  polled(c);
  const n = await checks(c);
  assert.ok(n > ctx(this).checksBefore, `the item has ${n} readiness checks, as it had before the poll`);
});

Then("the item's history shows a move from {string} to {string}", long, async function (from: string, to: string) {
  const c = pollCtx(this);
  polled(c);
  assert.ok((await movesOf(c, from, to)).length > 0, `the item's history shows no move from ${from} to ${to}`);
  ctx(this).last = { from, to };
});

Then("the item's history shows a move from {string} to {string} after it", long, async function (from: string, to: string) {
  const c = pollCtx(this);
  polled(c);
  const last = ctx(this).last;
  assert.ok(last, "no earlier move to follow");
  const before = (await movesOf(c, last.from, last.to))[0];
  assert.ok(before, `the item's history shows no move from ${last.from} to ${last.to}`);
  const after = (await movesOf(c, from, to)).filter((m) => m.at.getTime() > before.at.getTime());
  assert.ok(after.length > 0, `the item's history shows no move from ${from} to ${to} after its move from ${last.from} to ${last.to}`);
});

Then("the item's history shows no move from {string} to {string}", long, async function (from: string, to: string) {
  const c = pollCtx(this);
  polled(c);
  assert.equal((await movesOf(c, from, to)).length, 0, `the item's history shows a move from ${from} to ${to}`);
});

Then(
  "the item's history shows one withdrawal from {string} to {string}, made by the system",
  long,
  async function (from: string, to: string) {
    const c = pollCtx(this);
    polled(c);
    const moves = await movesOf(c, from, to, true);
    assert.equal(moves.length, 1, `the item's history shows ${moves.length} withdrawals from ${from} to ${to}`);
    assert.equal(moves[0].kind, "transition", "the withdrawal isn't logged as a transition");
    assert.equal(moves[0].actor, "system", `the withdrawal was made by ${moves[0].actor}`);
  },
);

Then("the item's history shows one move from {string} to {string}, made by the system", long, async function (from: string, to: string) {
  const c = pollCtx(this);
  polled(c);
  const moves = await movesOf(c, from, to);
  assert.equal(moves.length, 1, `the item's history shows ${moves.length} moves from ${from} to ${to}`);
  assert.equal(moves[0].kind, "transition", "the move isn't logged as a transition");
  assert.equal(moves[0].actor, "system", `the move was made by ${moves[0].actor}`);
});
