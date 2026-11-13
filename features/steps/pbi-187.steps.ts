// Step definitions for features/pbi-187-run-detail-durations.feature. They build on PBI 131's steps: its Background
// step makes the item in a GitHub repo, and its "a viewer opens the item's Run detail" serves the real dashboard on
// PBI 4's shared test database. PBI 145's "the item is InReview" sets the item's state. This feature's Before starts
// that dashboard itself, before any step opens it, so the dashboard reads the scenario's clock through `now`.
//
// The history is set up the way the factory writes it: the issue's creation time in item.issue_created_at, each move
// between states as a `transition` event (payload from, to, event) at its time, each stage attempt as a stage_run row
// of a run, and each question as a question row with asked_at and answered_at, or closed_at when it closed unanswered.
// All times are UTC.
//
// The page's contract these steps read: Run detail has a "Time" section, the content after <h2>Time</h2> up to the
// next <h2>. In it, each figure is a <dt> label followed by a <dd> value: "Total", "Queued", "Sign-off", "Needs input",
// "In review", and "Waiting on a person" for the total waiting on a person. The time in each stage is a <table> in
// that section with one <tr> of <td> cells per stage that ran: the stage, its time and its attempt count.
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { fakeBacklog } from "../../src/adapters/fake.ts";
import { createAuth } from "../../src/http/auth.ts";
import { dashboardRoutes } from "../../src/http/routes.ts";
import { startServer } from "../../src/http/server.ts";
import type { ItemState } from "../../src/core/states.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";
import { ctx as issueCtx, open, page, placeText, render, scope } from "./pbi-131.steps.ts";

const pool = () => need().pool;

type Item = ReturnType<typeof issueCtx>["items"][number];
type Ctx = {
  /** The scenario's clock, or the system clock while no step has set it. */
  now?: Date;
  /** The state the item's last move left it in, so the next move starts from it. */
  last?: ItemState;
  /** The total time a viewer saw on an earlier visit, and the total the scenario said they saw, checked by the next Then. */
  earlier?: { said: string; saw: string | null };
};

function ctx(world: object): Ctx {
  const w = world as { pbi187?: Ctx };
  w.pbi187 ??= {};
  return w.pbi187;
}

Before({ tags: "@pbi-187 and @db", ...long }, async function () {
  const d = await testDb();
  if (!d) return;
  await d.pool.query('truncate item, event, backlog_source, repo, "user", override cascade');
  // PBI 131's dashboard, started here with this scenario's clock, so its "opens the item's Run detail" uses it.
  const c = issueCtx(this);
  const sourceId = (await d.pool.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'pbi-187:' || gen_random_uuid()) returning id")).rows[0].id;
  let handler: ReturnType<typeof dashboardRoutes> | undefined;
  c.server = await startServer([(req, res) => handler!(req, res)], { port: 0 });
  c.origin = `http://127.0.0.1:${(c.server.address() as AddressInfo).port}`;
  const world = this;
  handler = dashboardRoutes({
    pool: d.pool, auth: createAuth({ mode: "azure" }), origin: c.origin, adapter: fakeBacklog().adapter, sourceId,
    now: () => ctx(world).now ?? new Date(),
  });
  c.close = handler.close;
});

After({ tags: "@pbi-187", ...long }, async function () {
  const s = (this as { pbi131?: ReturnType<typeof issueCtx> }).pbi131;
  if (!s) return;
  await s.close?.();
  if (s.server) {
    s.server.closeAllConnections();
    await new Promise<void>((resolve) => s.server!.close(() => resolve()));
  }
});

// ---- times ----

const AT = String.raw`(\d{4}-\d{2}-\d{2} \d{2}:\d{2})`;

/** A time as the feature writes it, "2026-11-10 09:00", in UTC. */
function at(text: string): Date {
  const d = new Date(`${text.replace(" ", "T")}:00Z`);
  assert.ok(!Number.isNaN(d.getTime()), `"${text}" isn't a time`);
  return d;
}

const UNIT: Record<string, number> = { day: 86_400_000, hour: 3_600_000, minute: 60_000, second: 1_000 };

/** A length as the feature writes it, such as "6 hours 45 minutes 59 seconds", in milliseconds. */
function length(text: string): number {
  const parts = [...text.matchAll(/(\d+)\s+(day|hour|minute|second)s?/g)];
  assert.ok(parts.length && parts.map((m) => m[0]).join(" ") === text.trim(), `"${text}" isn't a length`);
  return parts.reduce((ms, m) => ms + Number(m[1]) * UNIT[m[2]], 0);
}

// ---- the item and its history ----

function theItem(world: object): Item {
  const it = issueCtx(world).items[0];
  assert.ok(it, "no item was set up");
  return it;
}

async function setState(it: Item, state: ItemState): Promise<void> {
  await pool().query("update item set state = $2 where id = $1", [it.id, state]);
}

/** The state machine's event for a move, so the log reads as the factory writes it. */
function eventFor(from: ItemState, to: ItemState): string {
  if (to === "Queued") return from === "Eligible" ? "ready" : from === "InReview" ? "changes_requested" : from === "InProgress" ? "lease_expired" : "requeued";
  if (to === "InProgress") return "claimed";
  if (to === "SignOff") return "scenarios_written";
  if (to === "NeedsInput") return "blocked";
  if (to === "InReview") return "pr_opened";
  if (to === "Accepted") return "merged";
  if (to === "Done") return "dod_verified";
  if (to === "Failed") return from === "Accepted" ? "dod_failed" : "retries_exhausted";
  if (to === "Abandoned") return "withdrawn";
  return "returned";
}

/** Moves the item to `to` at `when`: a transition event from the state its last move left it in, and its state. */
async function move(world: object, to: ItemState, when: Date, from?: ItemState): Promise<void> {
  const it = theItem(world);
  const c = ctx(world);
  const was = from ?? c.last ?? "Eligible";
  await pool().query(
    "insert into event (actor, actor_id, item_id, kind, payload, at) values ('system', 'pbi-187', $1, 'transition', $2, $3)",
    [it.id, JSON.stringify({ from: was, to, event: eventFor(was, to) }), when],
  );
  c.last = to;
  await setState(it, to);
}

/** The time of the item's last move, or null when it hasn't moved. */
async function lastMove(it: Item): Promise<Date | null> {
  return (await pool().query<{ at: Date | null }>("select max(at) as at from event where item_id = $1 and kind in ('transition', 'override')", [it.id])).rows[0].at;
}

Given(new RegExp(`^the item's issue was created at ${AT}$`), long, async function (when: string) {
  await pool().query("update item set issue_created_at = $2 where id = $1", [theItem(this).id, at(when)]);
});

Given(new RegExp(`^the item reached (Done|Failed|Abandoned) at ${AT}$`), long, async function (end: ItemState, when: string) {
  const t = at(when);
  if (end === "Done") {
    // Done comes through Accepted, as a merged PR passes its definition of done.
    if (ctx(this).last !== "Accepted") await move(this, "Accepted", t, ctx(this).last === "InReview" ? "InReview" : "InProgress");
    await move(this, "Done", t);
  } else {
    await move(this, end, t, ctx(this).last ?? "InProgress");
  }
});

Given(/^the item reached Done ((?:\d+ (?:day|hour|minute|second)s? ?)+) after its issue was created$/, long, async function (len: string) {
  const it = theItem(this);
  const created = (await pool().query<{ at: Date | null }>("select issue_created_at as at from item where id = $1", [it.id])).rows[0].at;
  assert.ok(created, "the item's issue has no creation time");
  const done = new Date(created.getTime() + length(len));
  await move(this, "Accepted", done, "InProgress");
  await move(this, "Done", done);
});

Given(new RegExp(`^the time now is ${AT}$`), function (when: string) {
  ctx(this).now = at(when);
});

Given(/^the item is (InProgress|Eligible and has never been Queued|InProgress with no questions and no time InReview)$/, long, async function (what: string) {
  const it = theItem(this);
  if (what.startsWith("Eligible")) {
    await setState(it, "Eligible");
    return;
  }
  // An item Queued again, by a requeue, is claimed when it next runs, so it stops counting as Queued.
  if (ctx(this).last === "Queued") await move(this, "InProgress", (await lastMove(it))!);
  else await setState(it, "InProgress");
});

Given(new RegExp(`^an operator re-queued the item at ${AT}$`), long, async function (when: string) {
  await move(this, "Queued", at(when), ctx(this).last ?? "Failed");
});

Given(new RegExp(`^the item was (Queued|InReview) from ${AT} to ${AT}$`), long, async function (state: ItemState, from: string, to: string) {
  await move(this, state, at(from), state === "InReview" ? "InProgress" : undefined);
  if (state === "InReview") {
    // A review that asks for changes sends the item back to Queued, and the factory claims it to address them.
    await move(this, "Queued", at(to));
  }
  await move(this, "InProgress", at(to));
});

Given(new RegExp(`^the item has been (Queued|InReview) since ${AT}$`), long, async function (state: ItemState, since: string) {
  await move(this, state, at(since), state === "InReview" ? "InProgress" : undefined);
});

Given(new RegExp(`^the item entered SignOff at ${AT}$`), long, async function (when: string) {
  await move(this, "SignOff", at(when), "InProgress");
});

Given(new RegExp(`^the item left SignOff at ${AT}$`), long, async function (when: string) {
  await move(this, "InProgress", at(when), "SignOff");
});

// ---- runs and stages ----

/** The item's run numbered `n`, made when it doesn't exist yet. An earlier run is ended once a later one starts. */
async function run(it: Item, n: number): Promise<string> {
  const known = (await pool().query<{ id: string }>("select id from run where item_id = $1 and run_number = $2", [it.id, n])).rows[0];
  if (known) return known.id;
  await pool().query("update run set ended_at = coalesce(ended_at, started_at), outcome = coalesce(outcome, 'failed') where item_id = $1 and run_number < $2", [it.id, n]);
  return (await pool().query<{ id: string }>(
    "insert into run (item_id, repo_id, run_number, started_at, branch) values ($1, $2, $3, '2026-11-10T09:00:00Z', $4) returning id",
    [it.id, it.repoId, n, `factory/pbi-${it.ext}-r${n}`],
  )).rows[0].id;
}

async function stage(runId: string, stageId: string, attempt: number | null, started: Date, ended: Date | null): Promise<void> {
  const n = attempt ?? (await pool().query<{ n: number }>("select count(*)::int + 1 as n from stage_run where run_id = $1 and stage_id = $2", [runId, stageId])).rows[0].n;
  await pool().query(
    "insert into stage_run (run_id, stage_id, attempt, model, status, started_at, ended_at) values ($1, $2, $3, 'claude-opus-5-5', $4, $5, $6)",
    [runId, stageId, n, ended ? "passed" : "running", started, ended],
  );
}

type Row = { stage: string; attempt: string; started: string; ended: string };

async function ranStages(world: object, n: number, rows: Row[]): Promise<void> {
  const id = await run(theItem(world), n);
  for (const r of rows) await stage(id, r.stage, Number(r.attempt), at(r.started), at(r.ended));
}

Given("the item's run ran these stages:", long, async function (table: { hashes(): Row[] }) {
  await ranStages(this, 1, table.hashes());
});

Given(/^the item's (first|second) run ran these stages:$/, long, async function (which: string, table: { hashes(): Row[] }) {
  await ranStages(this, which === "first" ? 1 : 2, table.hashes());
});

Given(new RegExp(`^the item's run started the ([a-z-]+) stage at ${AT} and it hasn't ended$`), long, async function (stageId: string, when: string) {
  await stage(await run(theItem(this), 1), stageId, null, at(when), null);
});

Given(new RegExp(`^the item's run ran the ([a-z-]+) stage from ${AT} to ${AT}$`), long, async function (stageId: string, from: string, to: string) {
  await stage(await run(theItem(this), 1), stageId, null, at(from), at(to));
});

// ---- questions ----

const KIND: Record<string, string> = { "sign-off": "sign_off", "needs-input": "needs_input" };

async function question(it: Item, kind: string, asked: Date, end: { answered?: Date; decision?: string; closed?: Date }): Promise<void> {
  const k = KIND[kind];
  const decision = end.answered ? (end.decision ?? (k === "sign_off" ? "approve" : "answer")) : null;
  await pool().query(
    `insert into question (item_id, kind, body, asked_at, answer, answered_at, decision, closed_at) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [it.id, k, k === "sign_off" ? "Sign off the scenarios." : "Which month does the export cover?", asked,
      end.answered ? (decision === "changes" ? "Rename the export column." : "Looks right.") : null, end.answered ?? null, decision, end.closed ?? null],
  );
}

Given(new RegExp(`^an? (sign-off|needs-input) question was asked at ${AT} and answered at ${AT}$`), long, async function (kind: string, asked: string, answered: string) {
  await question(theItem(this), kind, at(asked), { answered: at(answered) });
});

Given(new RegExp(`^an? (sign-off|needs-input) question was asked at ${AT} and answered with a request for changes at ${AT}$`), long, async function (kind: string, asked: string, answered: string) {
  await question(theItem(this), kind, at(asked), { answered: at(answered), decision: "changes" });
});

Given(new RegExp(`^an? (sign-off|needs-input) question was asked at ${AT} and is still open$`), long, async function (kind: string, asked: string) {
  await question(theItem(this), kind, at(asked), {});
});

Given(new RegExp(`^an? (sign-off|needs-input) question was asked at ${AT} and closed unanswered at ${AT}$`), long, async function (kind: string, asked: string, closed: string) {
  await question(theItem(this), kind, at(asked), { closed: at(closed) });
});

// ---- opening Run detail ----

Given("a viewer opened the item's Run detail and saw a total time of {string}", long, async function (said: string) {
  await open(this, `/items/${theItem(this).id}`);
  // What the viewer saw is checked by the scenario's Then, so a missing figure fails there and not here.
  ctx(this).earlier = { said, saw: figureOrNull(this, "Total") };
});

When("the viewer opens the item's Run detail again", long, async function () {
  await open(this, `/items/${theItem(this).id}`);
});

// ---- reading the page ----

/** The html of Run detail's "Time" section. */
function timeSection(world: object): string {
  const html = scope(page(world), "the page");
  const start = html.search(/<h2\b[^>]*>\s*Time\s*<\/h2>/i);
  assert.ok(start >= 0, `Run detail has no "Time" section: ${placeText(render(html))}`);
  const rest = html.slice(start).replace(/^<h2\b[^>]*>[\s\S]*?<\/h2>/i, "");
  const end = rest.search(/<h2\b/i);
  return end < 0 ? rest : rest.slice(0, end);
}

const text = (html: string) => render(html).text.replace(/\s+/g, " ").trim();

/** The Time section's figures, each <dt> label with the <dd> after it. */
function figures(world: object): Map<string, string> {
  const html = timeSection(world);
  const out = new Map<string, string>();
  for (const m of html.matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi)) out.set(text(m[1]).toLowerCase(), text(m[2]));
  return out;
}

function figure(world: object, label: string): string {
  const fs = figures(world);
  const v = fs.get(label.toLowerCase());
  assert.ok(v !== undefined, `Run detail's "Time" section shows no "${label}": ${JSON.stringify(Object.fromEntries(fs))}`);
  return v;
}

function figureOrNull(world: object, label: string): string | null {
  try {
    return figure(world, label);
  } catch {
    return null;
  }
}

/** The stage table's rows, each its <td> cells' text: stage, time, attempts. */
function stageRows(world: object): string[][] {
  const html = timeSection(world);
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((m) => [...m[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => text(c[1])))
    .filter((cells) => cells.length > 0);
}

function stageRow(world: object, stageId: string): string[] | undefined {
  return stageRows(world).find((cells) => cells[0] === stageId);
}

Then("Run detail shows a total time of {string}", function (shown: string) {
  const earlier = ctx(this).earlier;
  if (earlier) assert.equal(earlier.saw, earlier.said, `on the earlier visit Run detail showed a total time of ${JSON.stringify(earlier.saw)}`);
  assert.equal(figure(this, "Total"), shown, "Run detail's total time");
});

Then("Run detail shows these stage times:", function (table: { hashes(): { stage: string; time: string; attempts: string }[] }) {
  const want = table.hashes().map((r) => [r.stage, r.time, r.attempts]);
  assert.deepEqual(stageRows(this).map((cells) => cells.slice(0, 3)), want, "Run detail's stage times");
});

Then(/^Run detail shows the ([a-z-]+) stage took "([^"]*)" over (\d+) attempts?$/, function (stageId: string, time: string, attempts: string) {
  const row = stageRow(this, stageId);
  assert.ok(row, `Run detail shows no stage time for ${stageId}: ${JSON.stringify(stageRows(this))}`);
  assert.deepEqual(row.slice(0, 3), [stageId, time, String(attempts)], `Run detail's time for the ${stageId} stage`);
});

Then(/^Run detail shows no stage time for ([a-z-]+)$/, function (stageId: string) {
  // The Time section must be there, with the stages that ran, for "no time" to mean something.
  assert.ok(stageRows(this).length > 0, "Run detail shows no stage times at all");
  assert.equal(stageRow(this, stageId), undefined, `Run detail shows a stage time for ${stageId}`);
});

const WAIT: Record<string, string> = { "for sign-off": "Sign-off", "for needs input": "Needs input", "in review": "In review", "in total": "Waiting on a person" };

Then(/^Run detail shows waiting on a person (for sign-off|for needs input|in review|in total) as "([^"]*)"$/, function (which: string, shown: string) {
  assert.equal(figure(this, WAIT[which]), shown, `Run detail's time waiting on a person ${which}`);
});

Then("Run detail shows the time Queued as {string}", function (shown: string) {
  assert.equal(figure(this, "Queued"), shown, "Run detail's time Queued");
});
