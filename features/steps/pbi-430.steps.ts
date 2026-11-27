// Step definitions for features/pbi-430-floor-two-lists.feature.
//
// Every scenario runs PBI 89's control plane, its real handlers on a free port, on PBI 4's test database, with a fake
// board and a fake repo host, signed in as PBI 265's operator. PBI 265's, PBI 320's and PBI 378's items, priorities,
// final-stage items, dependencies, bug labels, board order, polls, ticks and Start now and Move up steps are reused, and
// so are PBI 140's "the operator opens Floor", PBI 265's "the operator opens Floor before the scheduler ticks", PBI
// 279's banner steps and PBI 364's `item {int} is InProgress`, each handing its work to this file through a hook on
// the world. An item the feature names by number is that issue on the board: item 41 is issue #41.
//
// The clock: the feature's time is "2026-11-27 12:00" UTC. The control plane runs on the real clock, so each time a
// step names is placed as far before the scenario's real start as it is before 2026-11-27 12:00, and a time a Then
// names is read at that same shift. "25 min" in stage and the order of "Waiting on you" come out as the feature says.
//
// The contract these steps set up, which the code reads:
// - Today's Floor and the SPA's Floor each show two lists, each a heading, "Waiting on you" and "Production Line",
//   and what follows it up to the next heading as high (PBI 279's sections). A list's rows are its outermost list
//   items and table rows that hold cells. A row is for the item its first link to a Run detail opens: /items/{id} on
//   today's Floor, /runs/{id} in the SPA. A list is read only from a Floor that shows both lists, since a Floor still
//   showing the eight sections has a "Waiting on you" of another kind.
// - A row in "Waiting on you" says why it waits: "sign-off" for a sign-off, the question's text for a question,
//   "review" and a link "PR #N" to the PR for an item in review, each failed readiness line for a Not ready item, and
//   "Failed on main" with "not yet re-checked" or "last re-checked at YYYY-MM-DD HH:MM" for one that failed on main.
// - A row in "Production Line" for an InProgress item shows In flight's columns: its state, stage, time in stage, cost
//   and last agent message, and "fixing CI" with the commit and the failed checks in place of "green". A row for an
//   item waiting on other PBIs shows "Waits on #12" or "Waits on #12 and #13", naming every open dependency.
// - Every row keeps today's badges and notes: "priority N", ", from #N" where the priority comes from a dependent,
//   "final-stage", "because of #N" where the group comes from one, "bug", "held" and "override".
// - A split child's row shows "part of #N", with a link to the parent's Run detail after its own.
// - Under "Production Line", a line says "N more items are queued", or "1 more item is queued", when more are queued
//   than fit. An empty list says "Nothing waits on you" or "Nothing is in production".
// - GET /v1/floor carries `waitingOnYou`, `productionLine` and `productionMore`, as web/src/api.ts's FloorData has them.
//   A row there is by `id`. `since` is when the row began waiting, `question` its question's text, and `waitsOn` the
//   external ids of the open dependencies it waits on.
// - The SPA's Floor is web/src/pages/Floor.tsx's Floor, rendered by PBI 279's Vite loader with the API's answer as its
//   data, as the BFF hands it over.
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { apiApp } from "../../src/api/main.ts";
import { setOverride } from "../../src/store/overrides.ts";
import type { ItemState } from "../../src/core/states.ts";
import type { FloorData } from "../../web/src/api.ts";
import { ctx as p17 } from "./pbi-17.steps.ts";
import { ctx as p89, headers } from "./pbi-89.steps.ts";
import { ctx as p265, inState, itemOf, newItem, openRun, orderBoard, press, seedBoard } from "./pbi-265.steps.ts";
import { all, banners, floorModule, parse, section, text, type El } from "./pbi-279.steps.ts";
import { finalStage, setPriority } from "./pbi-320.steps.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";

const REPO = "octo/repo";
const ISSUER = "https://issuer.pbi-430.test";
/** The feature's "now". */
const FEATURE_NOW = Date.parse("2026-11-27T12:00:00Z");
const OLD_HEADINGS = ["Next up", "Final stage", "Not ready", "Blocked", "Split", "Failed on main", "In flight"];
const WAITING = "Waiting on you";
const LINE = "Production Line";

const pool = () => need().pool;
const re = (s: string) => new RegExp(`^${s}$`);
/** A list of numbers, as in "41, 42, 43 and 45" or "78 or 79". */
const NUMS = `(\\d+(?:(?:, | and | or )\\d+)*)`;
const nums = (list: string) => [...list.matchAll(/\d+/g)].map((m) => m[0]);
/** A list of quoted names, as in `"A", "C", "B"`. */
const QUOTED = `((?:"[^"]+"(?:, | and )?)+)`;
const quoted = (list: string) => [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const TITLE = `(?: "([^"]+)")?`;

type Floor = { kind: "today" | "spa"; root: El };
type Ctx = {
  /** The scenario's real start, which stands for the feature's 2026-11-27 12:00 UTC. */
  start: number;
  /** The SPA's Floor, once the operator opened it. */
  spa?: El;
  /** The API's last Floor answer. */
  answer?: FloorData & Record<string, unknown>;
  /** The token's age in days the control plane's environment was given, when a scenario names one. */
  tokenDays?: number;
};

function ctx(world: object): Ctx {
  const w = world as { pbi430?: Ctx };
  w.pbi430 ??= { start: Date.now() };
  return w.pbi430;
}

/** A time the feature names, "2026-11-27 09:00", on the scenario's clock. */
function at(world: object, when: string): Date {
  const t = Date.parse(`${when.replace(" ", "T")}:00Z`);
  assert.ok(!Number.isNaN(t), `"${when}" isn't a time`);
  return new Date(ctx(world).start - (FEATURE_NOW - t));
}

/** A time on the scenario's clock as a page shows it in UTC, to the minute. */
const shown = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");

/** The worker's own CLAUDE_TOKEN_CREATED_AT, put back after each scenario. */
const savedToken = new WeakMap<object, string | undefined>();

Before({ tags: "@pbi-430", ...long }, async function ({ pickle }) {
  const d = await testDb();
  if (!d) return;
  await d.pool.query(`truncate item, "user", backlog_source, repo, webhook_delivery, override cascade`);
  await d.pool.query("update wip_policy set mode = 'fixed', current_wip = 1, review_capacity = 10, usage_paused_until = null");
  const w = this as Record<string, unknown>;
  ctx(this).start = Date.now();
  p89(this).runTick = async (once) => {
    await once();
  };
  w.itemIs = (name: string, state: string) => inState(this, name, state);
  w.numberedIs = (n: number, state: string) => numbered(this, n, state);
  w.extByName = true;
  w.finishKeepsSlotFree = true;
  w.floorTree = () => floorOf(this).root;
  p17(this).ticked = true;
  p17(this).now = new Date();
  // The token's age is a setting the control plane reads from its environment when it starts, which the Background
  // does before any Given. This worker's environment gives it for the scenario, and After puts it back.
  savedToken.set(this, process.env.CLAUDE_TOKEN_CREATED_AT);
  delete process.env.CLAUDE_TOKEN_CREATED_AT;
  const token = pickle.steps.map((s) => /^the Claude token expires in (\d+) days$/.exec(s.text)).find(Boolean);
  if (token) {
    const days = Number(token[1]);
    ctx(this).tokenDays = days;
    // An hour to spare, so the whole days the banner counts are the scenario's.
    process.env.CLAUDE_TOKEN_CREATED_AT = new Date(Date.now() - (365 - days) * 86_400_000 + 3_600_000).toISOString();
  }
  w.controlEnv = { ...process.env };
  w.tokenExpiresIn = (days: number) => assert.equal(ctx(this).tokenDays, days, "the control plane was started with another token age");
});

After({ tags: "@pbi-430", ...long }, async function () {
  const token = savedToken.get(this);
  if (token === undefined) delete process.env.CLAUDE_TOKEN_CREATED_AT;
  else process.env.CLAUDE_TOKEN_CREATED_AT = token;
  const c = p89(this);
  await c.close?.();
  if (c.server) {
    c.server.closeAllConnections();
    await new Promise<void>((resolve) => c.server!.close(() => resolve()));
  }
});

// ---- items ----

const idOf = (world: object, n: string | number) => itemOf(world, String(n)).id;

/** Gives an item its title, on the board and in the factory. */
async function titled(world: object, n: string, title: string | undefined): Promise<void> {
  if (!title) return;
  const it = itemOf(world, n);
  const fi = await p89(world).fake!.adapter.getItem(it.ext);
  await seedBoard(world, n, it.ext, it.rank, { ...fi, title });
  await pool().query("update item set title = $2 where id = $1", [it.id, title]);
}

/** Puts a numbered item on the board and in the factory in a bare state. */
async function numbered(world: object, n: number | string, state: string): Promise<string> {
  const name = String(n);
  if (state === "InProgress") {
    await inState(world, name, "InProgress");
    return idOf(world, name);
  }
  return newItem(world, name, state as ItemState);
}

async function openRunId(id: string): Promise<string> {
  const r = (await pool().query<{ id: string }>("select id from run where item_id = $1 and ended_at is null order by started_at desc limit 1", [id])).rows[0];
  assert.ok(r, "the item has no open run");
  return r.id;
}

/** Records a move of the item to `to` at `when`, as the state machine logs it. */
async function moved(id: string, from: string, to: string, event: string, when: Date): Promise<void> {
  await pool().query(
    "insert into event (at, actor, actor_id, item_id, kind, payload) values ($1, 'system', 'pbi-430', $2, 'transition', $3)",
    [when, id, JSON.stringify({ from, to, event })],
  );
}

/** An item waiting on an open question of `kind`, asked at each of `asked`. */
async function asking(world: object, n: string, kind: "sign_off" | "needs_input", asked: Date[], body = "Which way?", extra: { baseFailure?: unknown } = {}): Promise<string> {
  const id = await newItem(world, n, kind === "sign_off" ? "SignOff" : "NeedsInput");
  await openRun(id, kind === "sign_off" ? "sign-off" : "green");
  for (const a of asked) {
    await pool().query("insert into question (item_id, kind, body, asked_at, base_failure) values ($1, $2, $3, $4, $5)",
      [id, kind, body, a, extra.baseFailure ? JSON.stringify(extra.baseFailure) : null]);
  }
  return id;
}

/** An item in review, with its open run's PR, since it moved to InReview at `since`. */
async function inReview(world: object, n: string, pr: number, since: Date): Promise<string> {
  const id = await newItem(world, n, "InReview");
  await openRun(id, "pr-review");
  await pool().query("update run set pr_number = $2, pr_url = $3 where item_id = $1", [id, pr, `https://github.com/${REPO}/pull/${pr}`]);
  await moved(id, "InProgress", "InReview", "pr_opened", since);
  return id;
}

/** An item the readiness gate turned down at `since`, failing each of `lines`. */
async function notReady(world: object, n: string, lines: string[], since: Date): Promise<string> {
  const id = await newItem(world, n, "NotReady");
  for (const [i, line] of lines.entries()) {
    await pool().query(
      `insert into policy_result (item_id, file, source, criterion_index, criterion, status, reason, at) values ($1, 'dor', 'default', $2, $3, 'failed', 'it does not', $4)`,
      [id, i + 1, line, since],
    );
  }
  await moved(id, "Eligible", "NotReady", "readiness_failed", since);
  return id;
}

/** An item that went to Failed after `event` at `since`, re-checked at `rechecked` when given. */
async function failed(world: object, n: string, event: string, since: Date, rechecked: Date | null = null): Promise<string> {
  const id = await newItem(world, n, "Failed");
  await moved(id, event === "dod_failed" ? "Accepted" : "InProgress", "Failed", event, since);
  if (rechecked) {
    await pool().query("insert into event (at, actor, actor_id, item_id, kind, payload) values ($1, 'system', 'pbi-430', $2, 'recheck', '{}')", [rechecked, id]);
  }
  return id;
}

/** An InProgress item whose open run is at `stage`, started at `since`. */
async function inProgressAt(world: object, n: string, stage: string, since: Date, ciFailure: unknown = null): Promise<string> {
  await inState(world, n, "InProgress");
  const id = idOf(world, n);
  const runId = await openRunId(id);
  await pool().query("update run set next_stage = $2 where id = $1", [runId, stage]);
  await pool().query("insert into stage_run (run_id, stage_id, attempt, status, started_at, ci_failure) values ($1, $2, 1, 'started', $3, $4)",
    [runId, stage, since, ciFailure ? JSON.stringify(ciFailure) : null]);
  return id;
}

const deps = new WeakMap<object, Map<string, string[]>>();
/** Each dependent's open dependencies on the board, by its external id, as these steps set them. */
function dependencies(world: object): Map<string, string[]> {
  if (!deps.has(world)) deps.set(world, new Map());
  return deps.get(world)!;
}

/** The item's dependencies on the board and in the factory, as a poll would copy them, each open one by issue number. */
async function dependsOn(world: object, n: string, open: string[]): Promise<void> {
  const it = itemOf(world, n);
  dependencies(world).set(it.ext, [...open]);
  p89(world).fake!.setDependencies(it.ext, open);
  await pool().query("update item set blocked_by = $2 where id = $1", [it.id, open]);
}

/** A split parent and its children, in order, each a board issue by number. */
async function split(world: object, n: string, children: string[]): Promise<string> {
  const id = await newItem(world, n, "Split");
  for (const [i, child] of children.entries()) {
    await pool().query("insert into split_child (parent_id, position, external_id, title, url) values ($1, $2, $3, $4, $5)",
      [id, i + 1, child, `Item ${child}`, `https://github.com/${REPO}/issues/${child}`]);
  }
  await moved(id, "NotReady", "Split", "split", new Date(ctx(world).start - 3_600_000));
  return id;
}

async function carriesBug(world: object, n: string): Promise<void> {
  const it = itemOf(world, n);
  const fi = await p89(world).fake!.adapter.getItem(it.ext);
  await seedBoard(world, n, it.ext, it.rank, { ...fi, labels: [...new Set([...(fi?.labels ?? []), "bug"])] });
  await pool().query("update item set bug_label = true where id = $1", [it.id]);
}

/** An hour before the feature's now, for a step that names no time. */
const anHourAgo = (world: object) => new Date(ctx(world).start - 3_600_000);

Given(re(`item ([0-9]+)${TITLE} is in SignOff, waiting on the owner's sign-off(?: of its scenarios)?`), async function (n: string, title?: string) {
  await asking(this, n, "sign_off", [anHourAgo(this)], "Sign off the scenarios");
  await titled(this, n, title);
});

Given(re(`item ([0-9]+)${TITLE} is in NeedsInput, waiting on (?:a question|the question "([^"]*)")`), async function (n: string, title?: string, q?: string) {
  await asking(this, n, "needs_input", [anHourAgo(this)], q ?? "Which way?");
  await titled(this, n, title);
});

Given(re(`item ([0-9]+) is in NeedsInput, waiting on a question that says the base fails in the cell`), async function (n: string) {
  await asking(this, n, "needs_input", [anHourAgo(this)], "The base fails in the cell.", { baseFailure: { sha: "0123456789abcdef0123456789abcdef01234567", tests: ["a test"] } });
});

Given(re(`item ([0-9]+) is in NeedsInput, waiting on a question, with priority ([0-9]+), and carries the "bug" label`), async function (n: string, p: string) {
  await asking(this, n, "needs_input", [anHourAgo(this)]);
  await setPriority(this, n, Number(p));
  await carriesBug(this, n);
});

Given(re(`item ([0-9]+) is in NeedsInput with two open questions(?:, asked at "([^"]+)" UTC and "([^"]+)" UTC)?`), async function (n: string, a?: string, b?: string) {
  const times = a && b ? [at(this, a), at(this, b)] : [new Date(ctx(this).start - 7_200_000), anHourAgo(this)];
  await asking(this, n, "needs_input", times);
});

Given(re(`item ([0-9]+) is in NeedsInput with its question answered`), async function (n: string) {
  await inState(this, n, "in NeedsInput with its question answered");
});

Given(re(`item ([0-9]+)${TITLE} has been in (SignOff|NeedsInput) since the factory asked (?:for sign-off|its question|"([^"]*)") at "([^"]+)" UTC`),
  async function (n: string, title: string | undefined, state: string, q: string | undefined, when: string) {
    await asking(this, n, state === "SignOff" ? "sign_off" : "needs_input", [at(this, when)], q ?? (state === "SignOff" ? "Sign off the scenarios" : "Which way?"));
    await titled(this, n, title);
  });

Given(re(`item ([0-9]+)${TITLE} is InReview with PR ([0-9]+) open`), async function (n: string, title: string | undefined, pr: string) {
  await inReview(this, n, Number(pr), anHourAgo(this));
  await titled(this, n, title);
});

Given(re(`item ([0-9]+) moved to InReview at "([^"]+)" UTC`), async function (n: string, when: string) {
  await inReview(this, n, 70 + Number(n) % 30, at(this, when));
});

Given(re(`item ([0-9]+) has an open PR and is InReview, with priority ([0-9]+)`), async function (n: string, p: string) {
  await finalStage(this, n, "InReview");
  await setPriority(this, n, Number(p));
});

Given(re(`item ([0-9]+) has an open PR and is Queued to address requested changes`), async function (n: string) {
  await finalStage(this, n, "Queued to address requested changes");
});

Given(re(`item ([0-9]+)${TITLE} is NotReady, having failed ((?:"[^"]+"(?: and )?)+)`), async function (n: string, title: string | undefined, lines: string) {
  await notReady(this, n, quoted(lines), anHourAgo(this));
  await titled(this, n, title);
});

Given(re(`item ([0-9]+) was turned down by the readiness gate and went NotReady at "([^"]+)" UTC(?:, having failed ((?:"[^"]+"(?: and )?)+))?`),
  async function (n: string, when: string, lines?: string) {
    await notReady(this, n, lines ? quoted(lines) : ["Has acceptance criteria"], at(this, when));
  });

Given(re(`item ([0-9]+)${TITLE} is Failed after the event "([^"]+)"(?: and (?:hasn't been re-checked yet|was last re-checked at "([^"]+)" UTC))?`),
  async function (n: string, title: string | undefined, event: string, rechecked?: string) {
    // PBI 369 counts only a re-check since the item's last move to Failed, so a named re-check comes an hour after it.
    const check = rechecked ? at(this, rechecked) : null;
    await failed(this, n, event, check ? new Date(check.getTime() - 3_600_000) : anHourAgo(this), check);
    await titled(this, n, title);
  });

Given(re(`item ([0-9]+) went to Failed after the event "([^"]+)" at "([^"]+)" UTC`), async function (n: string, event: string, when: string) {
  await failed(this, n, event, at(this, when));
});

Given(re(`item ([0-9]+) is (Done|Abandoned)`), async function (n: string, state: string) {
  await newItem(this, n, state as ItemState);
});

Given(re(`item ([0-9]+) is Accepted, waiting on main`), async function (n: string) {
  const id = await newItem(this, n, "Accepted");
  await openRun(id, "accepted");
});

Given(re(`item ([0-9]+)${TITLE} is InProgress in stage "([^"]+)"(?:, which started at "([^"]+)" UTC)?`), async function (n: string, title: string | undefined, stage: string, when?: string) {
  await inProgressAt(this, n, stage, when ? at(this, when) : new Date(ctx(this).start - 600_000));
  await titled(this, n, title);
});

Given(re(`item ([0-9]+) is InProgress in stage "([^"]+)", sent back to fix CI failing the check "([^"]+)" on commit "([0-9a-f]+)"`),
  async function (n: string, stage: string, check: string, sha: string) {
    const failure = { sha: sha.padEnd(40, "0"), checks: [{ name: check, url: `https://github.com/${REPO}/actions/runs/1`, failingTests: ["a test"] }] };
    await inProgressAt(this, n, stage, new Date(ctx(this).start - 600_000), failure);
  });

Given(re(`items ${NUMS} are InProgress`), async function (list: string) {
  for (const n of nums(list)) await numbered(this, n, "InProgress");
});

Given(re(`item ([0-9]+) is InProgress with a Start now override in force`), async function (n: string) {
  await numbered(this, n, "InProgress");
  // Start now is pressed on an item before its claim, and stays in force while it runs. The Controls refuse it on an
  // item already in progress, so the override that stays is written as the press left it.
  await setOverride(pool(), { scope: "item", targetId: idOf(this, n), kind: "start_now", reason: "the demo needs it", createdBy: p265(this).operator!, expiresAt: null });
});

Given(re(`item ([0-9]+)'s open run has cost \\$([\\d.]+) so far`), async function (n: string, usd: string) {
  const runId = await openRunId(idOf(this, n));
  await pool().query("update stage_run set cost_usd = $2 where run_id = $1", [runId, usd]);
});

Given(re(`item ([0-9]+)'s last agent message is "([^"]*)"`), async function (n: string, message: string) {
  const runId = await openRunId(idOf(this, n));
  await pool().query("update stage_run set message = $2 where run_id = $1", [runId, message]);
});

Given(re(`item ([0-9]+) is Queued`), async function (n: string) {
  await newItem(this, n, "Queued");
});

Given(re(`items ${NUMS} are Queued(?:, in that board order)?`), async function (list: string) {
  for (const n of nums(list)) await newItem(this, n, "Queued");
});

Given(re(`item ([0-9]+) is Queued, has priority ([0-9]+), and carries the "bug" label`), async function (n: string, p: string) {
  await newItem(this, n, "Queued");
  await setPriority(this, n, Number(p));
  await carriesBug(this, n);
});

Given(re(`item ([0-9]+) carries the "bug" label`), async function (n: string) {
  await carriesBug(this, n);
});

Given(re(`item ([0-9]+) is Queued and depends on items? ${NUMS}(?:, which (?:is|are both) still open)?`), async function (n: string, deps: string) {
  await newItem(this, n, "Queued");
  await dependsOn(this, n, nums(deps));
});

Given(re(`items ${NUMS} are Queued and each depends on item ([0-9]+), which is still open`), async function (list: string, dep: string) {
  for (const n of nums(list)) {
    await newItem(this, n, "Queued");
    await dependsOn(this, n, [dep]);
  }
});

Given(re(`item ([0-9]+) has closed and item ([0-9]+) is still open`), function (closed: string, open: string) {
  narrowDependencies(this, closed, open);
});

/** Drops a closed dependency from every item on the board that depended on it, which the next poll copies. */
function narrowDependencies(world: object, closed: string, stillOpen?: string): void {
  const fake = p89(world).fake!;
  const deps = dependencies(world);
  if (stillOpen) assert.ok([...deps.values()].some((l) => l.includes(stillOpen)), `no item depends on item ${stillOpen}`);
  for (const [ext, list] of deps) {
    const left = list.filter((d) => d !== closed);
    deps.set(ext, left);
    fake.setDependencies(ext, left);
  }
}


When(re(`item ([0-9]+) closes`), function (n: string) {
  narrowDependencies(this, n);
});

Given(re(`item ([0-9]+) "([^"]+)" is Split into items ([0-9]+) and ([0-9]+)(?:, neither of which the factory holds yet)?`), async function (n: string, title: string, a: string, b: string) {
  await split(this, n, [a, b]);
  await titled(this, n, title);
});

Given(re(`item ([0-9]+) is Split into items ([0-9]+) and ([0-9]+)`), async function (n: string, a: string, b: string) {
  await split(this, n, [a, b]);
});

Given(re(`item ([0-9]+) is Split into items ([0-9]+) and ([0-9]+), and item ([0-9]+) is Queued`), async function (n: string, a: string, b: string, q: string) {
  await split(this, n, [a, b]);
  await newItem(this, q, "Queued");
});

Given(re(`the board orders the items ${NUMS}`), async function (list: string) {
  await orderBoard(this, nums(list));
});

Given(re(`the operator has held item ([0-9]+) with the reason "([^"]*)"`), async function (n: string, reason: string) {
  await press(this, "hold", n, reason);
  assert.equal(p89(this).status, 303, `the hold was turned down with ${p89(this).status}`);
  // The scheduler's next tick takes up a hold, as PBI 265's "is on Hold" waits for. It's taken up here.
  await pool().query("update item set held = true where id = $1", [idOf(this, n)]);
});

Given(re(`the operator has pressed "([^"]+)" on item "([^"]+)" with the reason "([^"]*)"`), async function (control: string, name: string, reason: string) {
  const kinds: Record<string, string> = { "Start now": "start_now", "Move up": "move_up", "Move down": "move_down" };
  assert.ok(kinds[control], `no control "${control}"`);
  await press(this, kinds[control], name, reason);
  assert.equal(p89(this).status, 303, `"${control}" was turned down with ${p89(this).status}`);
});

Given(re(`the factory holds no items`), async function () {
  const n = (await pool().query<{ n: number }>("select count(*)::int as n from item")).rows[0].n;
  assert.equal(n, 0, "the factory holds items");
});

Given(re(`the factory is paused with the reason "([^"]*)"`), async function (reason: string) {
  const c = p89(this);
  const r = await fetch(`${c.origin}/overrides`, {
    method: "POST", redirect: "manual", body: new URLSearchParams({ kind: "pause", reason }).toString(),
    headers: { ...headers(c.login!), origin: c.origin!, "content-type": "application/x-www-form-urlencoded" },
  });
  await r.text();
  assert.equal(r.status, 303, `the pause was turned down with ${r.status}`);
});

// ---- opening Floor and reading the API ----

async function readAnswer(world: object): Promise<FloorData & Record<string, unknown>> {
  const login = p89(world).login!;
  await pool().query(`update "user" set issuer = $2 where github_login = $1`, [login, ISSUER]);
  const subject = (await pool().query<{ subject: string }>(`select subject from "user" where github_login = $1`, [login])).rows[0].subject;
  const { app, close } = apiApp({
    pool: pool(), issuer: ISSUER, audience: "pbi-430", webhookSecret: "unused", readBlob: async () => null,
    env: (world as { controlEnv?: Record<string, string | undefined> }).controlEnv ?? {},
    verify: async (h) => (h ? { issuer: ISSUER, subject } : null),
  });
  try {
    const r = await app.request("/v1/floor", { headers: { authorization: "Bearer pbi-430" } });
    const body = await r.json() as FloorData & Record<string, unknown>;
    assert.equal(r.status, 200, `GET /v1/floor answered ${r.status}: ${JSON.stringify(body).slice(0, 300)}`);
    return body;
  } finally {
    await close();
  }
}

When(re(`a client reads the API's Floor answer`), long, async function () {
  ctx(this).answer = await readAnswer(this);
});

When(re(`the operator opens today's Floor`), long, async function () {
  const c = p89(this);
  ctx(this).spa = undefined;
  const r = await fetch(`${c.origin}/`, { headers: headers(c.login!) });
  c.status = r.status;
  c.html = await r.text();
});

When(re(`the operator opens the SPA's Floor`), long, async function () {
  const data = await readAnswer(this);
  const { Floor } = await floorModule();
  ctx(this).spa = parse(renderToString(createElement(Floor, { data, zone: "UTC", now: new Date() })));
});

/** The Floor the operator last opened: the SPA's when they opened it, otherwise today's. */
function floorOf(world: object): Floor {
  const spa = ctx(world).spa;
  if (spa) return { kind: "spa", root: spa };
  const c = p89(world);
  assert.equal(c.status, 200, `Floor didn't open: ${String(c.html).slice(0, 300)}`);
  return { kind: "today", root: parse(c.html!) };
}

function named(world: object, which: string): Floor {
  const f = floorOf(world);
  assert.equal(f.kind, which === "the SPA's Floor" ? "spa" : "today", `${which} isn't the Floor open`);
  return f;
}

// ---- reading the two lists ----

const level = (e: El) => (/^h([1-6])$/.exec(e.tag) ? Number(e.tag[1]) : 0);
const headings = (root: El) => all(root).filter((e) => level(e) > 0).map(text);

type Row = { el: El; id: string | null; text: string };

const RUN_LINK = /^\/(?:items|runs)\/([0-9a-f-]{36})$/;
const runLinks = (e: El) => all(e).filter((x) => x.tag === "a" && RUN_LINK.test(x.attrs.href ?? ""));

/** The list's rows, in order, read from a Floor that shows both lists. */
function rows(world: object, list: string): Row[] {
  const root = floorOf(world).root;
  const hs = headings(root);
  assert.ok(hs.includes(WAITING) && hs.includes(LINE), `Floor doesn't show the two lists "${WAITING}" and "${LINE}": its headings are ${JSON.stringify(hs)}`);
  const s = section(root, list);
  const candidates = all(s).filter((e) => e.tag === "li" || (e.tag === "tr" && all(e).some((x) => x.tag === "td")));
  const set = new Set(candidates);
  const outer = candidates.filter((e) => {
    for (let p = e.parent; p; p = p.parent) if (set.has(p)) return false;
    return true;
  });
  return outer.map((el) => {
    const first = runLinks(el)[0];
    return { el, id: first ? RUN_LINK.exec(first.attrs.href)![1] : null, text: text(el) };
  });
}

/** The scenario's name for an item id, its number or its letter. */
function nameOf(world: object, id: string | null): string {
  for (const [name, it] of p265(world).items) if (it.id === id) return name;
  return id ?? "(a row for no item)";
}

const listed = (world: object, list: string) => rows(world, list).map((r) => nameOf(world, r.id));

function rowFor(world: object, list: string, name: string): Row {
  const id = idOf(world, name);
  const all = rows(world, list).filter((r) => r.id === id);
  assert.ok(all.length > 0, `"${list}" doesn't list item ${name}: it lists ${listed(world, list).join(", ") || "nothing"}`);
  return all[0];
}

function lists(world: object, list: string, names: string[]): void {
  const got = listed(world, list);
  for (const n of names) assert.ok(got.includes(n), `"${list}" doesn't list item ${n}: it lists ${got.join(", ") || "nothing"}`);
}

function listsInOrder(world: object, list: string, names: string[]): void {
  lists(world, list, names);
  const got = listed(world, list).filter((n) => names.includes(n));
  assert.deepEqual(got, names, `"${list}" lists them in another order`);
}

function listsNone(world: object, list: string, names: string[]): void {
  const got = listed(world, list);
  for (const n of names) assert.ok(!got.includes(n), `"${list}" lists item ${n}`);
}

function listsOnce(world: object, list: string, names: string[]): void {
  const got = listed(world, list);
  for (const n of names) assert.equal(got.filter((x) => x === n).length, 1, `"${list}" doesn't list item ${n} once: it lists ${got.join(", ")}`);
}

const ITEM = `(?:([0-9]+)|"([^"]+)")`;
const nameFrom = (num?: string, letter?: string) => num ?? letter!;
const LIST_NAME = `"(Waiting on you|Production Line)"`;

Then(re(`Floor shows a list headed ${LIST_NAME}`), function (list: string) {
  section(floorOf(this).root, list);
});

Then(re(`Floor shows a list headed "Waiting on you" that says nothing waits on you`), function () {
  const s = section(floorOf(this).root, WAITING);
  assert.match(text(s), /nothing waits on you/i, `"${WAITING}" doesn't say nothing waits on you: ${text(s).slice(0, 300)}`);
});

Then(re(`Floor shows a list headed "Production Line" that says nothing is in production`), function () {
  const s = section(floorOf(this).root, LINE);
  assert.match(text(s), /nothing is in production/i, `"${LINE}" doesn't say nothing is in production: ${text(s).slice(0, 300)}`);
});

function noOldHeadings(f: Floor, which: string): void {
  const hs = headings(f.root);
  const old = OLD_HEADINGS.filter((h) => hs.includes(h));
  assert.deepEqual(old, [], `${which} shows the headings ${old.join(", ")}`);
}

Then(re(`Floor shows none of the headings "Next up", "Final stage", "Not ready", "Blocked", "Split", "Failed on main" or "In flight"`), function () {
  noOldHeadings(floorOf(this), "Floor");
});

Then(re(`(today's Floor|the SPA's Floor) shows none of the headings "Next up", "Final stage", "Not ready", "Blocked", "Split", "Failed on main" or "In flight"`), function (which: string) {
  noOldHeadings(named(this, which), which);
});

Then(re(`Floor shows that the factory is paused with the reason "([^"]*)"`), function (reason: string) {
  const got = banners(floorOf(this).root).map(text);
  assert.ok(got.some((b) => b.includes(`Paused: ${reason}`)), `Floor shows no banner that the factory is paused: ${JSON.stringify(got)}`);
});

Then(re(`Floor shows the Controls form with its ${QUOTED} buttons`), function (list: string) {
  const s = section(floorOf(this).root, "Controls");
  const form = all(s).find((e) => e.tag === "form");
  assert.ok(form, "Floor's Controls have no form");
  const got = all(form).filter((e) => e.tag === "button").map(text);
  for (const b of quoted(list)) assert.ok(got.includes(b), `the Controls form has no "${b}" button: ${got.join(", ")}`);
});

Then(re(`Floor shows "Production Line" listing item ([0-9]+)`), function (n: string) {
  lists(this, LINE, [n]);
});

Then(re(`${LIST_NAME} lists item ${ITEM}(?: "([^"]+)")?`), function (list: string, num?: string, letter?: string, title?: string) {
  const r = rowFor(this, list, nameFrom(num, letter));
  if (title) assert.ok(r.text.includes(title), `item ${num}'s row doesn't show "${title}": ${r.text}`);
});

Then(re(`${LIST_NAME} lists item ${ITEM} once`), function (list: string, num?: string, letter?: string) {
  listsOnce(this, list, [nameFrom(num, letter)]);
});

Then(re(`${LIST_NAME} lists item ([0-9]+), showing "([^"]+)"`), function (list: string, n: string, what: string) {
  const r = rowFor(this, list, n);
  assert.ok(r.text.includes(what), `item ${n}'s row in "${list}" doesn't show "${what}": ${r.text}`);
});

Then(re(`${LIST_NAME} doesn't list item ${ITEM}`), function (list: string, num?: string, letter?: string) {
  listsNone(this, list, [nameFrom(num, letter)]);
});

Then(re(`${LIST_NAME} doesn't list items ${NUMS}`), function (list: string, ns: string) {
  listsNone(this, list, nums(ns));
});

Then(re(`neither "Waiting on you" nor "Production Line" lists items? ${NUMS}`), function (ns: string) {
  listsNone(this, WAITING, nums(ns));
  listsNone(this, LINE, nums(ns));
});

Then(re(`${LIST_NAME} lists items ${NUMS}`), function (list: string, ns: string) {
  lists(this, list, nums(ns));
});

Then(re(`${LIST_NAME} lists items ${NUMS}, in that order`), function (list: string, ns: string) {
  listsInOrder(this, list, nums(ns));
});

Then(re(`${LIST_NAME} lists ${QUOTED}, in that order`), function (list: string, ns: string) {
  listsInOrder(this, list, quoted(ns));
});

Then(re(`${LIST_NAME} lists items ${NUMS}, each once`), function (list: string, ns: string) {
  listsOnce(this, list, nums(ns));
});

Then(re(`${LIST_NAME} lists items ${NUMS}, and no others`), function (list: string, ns: string) {
  const got = listed(this, list);
  assert.deepEqual([...got].sort(), [...nums(ns)].sort(), `"${list}" lists ${got.join(", ") || "nothing"}`);
});

Then(re(`"Production Line" lists items ${NUMS} before items ${NUMS}`), function (first: string, then: string) {
  const got = listed(this, LINE);
  lists(this, LINE, [...nums(first), ...nums(then)]);
  const last = Math.max(...nums(first).map((n) => got.indexOf(n)));
  for (const n of nums(then)) assert.ok(got.indexOf(n) > last, `"${LINE}" lists item ${n} before one of ${first}: ${got.join(", ")}`);
});

Then(re(`"Production Line" lists items ${NUMS}, in that order, after them`), function (ns: string) {
  const got = listed(this, LINE);
  listsInOrder(this, LINE, nums(ns));
  const inProgress = rows(this, LINE).filter((r) => /\bInProgress\b/.test(r.text)).map((r) => nameOf(this, r.id));
  const last = Math.max(-1, ...inProgress.map((n) => got.indexOf(n)));
  for (const n of nums(ns)) assert.ok(got.indexOf(n) > last, `"${LINE}" lists item ${n} before an InProgress item: ${got.join(", ")}`);
});

Then(re(`"Production Line" lists item ([0-9]+) as the first item to claim`), async function (n: string) {
  const states = new Map((await pool().query<{ id: string; state: string }>("select id, state from item")).rows.map((r) => [r.id, r.state]));
  const first = rows(this, LINE).find((r) => states.get(r.id ?? "") !== "InProgress");
  assert.ok(first, `"${LINE}" lists no item to claim`);
  assert.equal(nameOf(this, first.id), n, `"${LINE}" lists another item first to claim`);
});

Then(re(`"Production Line" shows ([0-9]+) rows`), function (n: string) {
  const got = rows(this, LINE);
  assert.equal(got.length, Number(n), `"${LINE}" shows ${got.length} rows: ${got.map((r) => nameOf(this, r.id)).join(", ")}`);
});

Then(re(`no item appears in both lists`), function () {
  const waiting = new Set(listed(this, WAITING));
  const both = listed(this, LINE).filter((n) => waiting.has(n));
  assert.deepEqual(both, [], `items ${both.join(", ")} appear in both lists`);
});

// ---- what a row shows ----

const ROW = `item ${ITEM}'s row in ${LIST_NAME}`;
const row = (world: object, num: string | undefined, letter: string | undefined, list: string) => rowFor(world, list, nameFrom(num, letter));

function shows(r: Row, what: string | RegExp, label: string): void {
  const ok = typeof what === "string" ? r.text.includes(what) : what.test(r.text);
  assert.ok(ok, `the row doesn't show ${label}: ${r.text}`);
}

Then(re(`${ROW} says it waits on the owner's sign-off`), function (num?: string, letter?: string, list?: string) {
  shows(row(this, num, letter, list!), /\bsign-off\b/i, "that it waits on sign-off");
});

Then(re(`${ROW} shows the question "([^"]*)"`), function (num: string | undefined, letter: string | undefined, list: string, q: string) {
  shows(row(this, num, letter, list), q, `the question "${q}"`);
});

Then(re(`${ROW} says it waits on the review of "PR #([0-9]+)", which links to that PR`), async function (num: string | undefined, letter: string | undefined, list: string, pr: string) {
  const r = row(this, num, letter, list);
  shows(r, /\breview\b/i, "that it waits on review");
  const url = (await pool().query<{ pr_url: string }>("select pr_url from run where item_id = $1 and pr_number = $2", [idOf(this, nameFrom(num, letter)), Number(pr)])).rows[0]?.pr_url;
  assert.ok(url, `the item has no run with PR #${pr}`);
  const link = all(r.el).find((e) => e.tag === "a" && text(e) === `PR #${pr}`);
  assert.ok(link, `the row has no link "PR #${pr}": ${r.text}`);
  assert.equal(link.attrs.href, url, `"PR #${pr}" doesn't link to the PR`);
});

Then(re(`${ROW} shows the failed readiness lines? ((?:"[^"]+"(?: and )?)+)`), function (num: string | undefined, letter: string | undefined, list: string, lines: string) {
  const r = row(this, num, letter, list);
  for (const l of quoted(lines)) shows(r, l, `the failed readiness line "${l}"`);
});

Then(re(`${ROW} shows "Failed on main" with "([^"]+)"`), function (num: string | undefined, letter: string | undefined, list: string, detail: string) {
  const r = row(this, num, letter, list);
  shows(r, "Failed on main", `"Failed on main"`);
  // A time the feature names is read at the scenario's shift.
  const want = detail.replace(/\d{4}-\d\d-\d\d \d\d:\d\d/, (t) => shown(at(this, t)));
  shows(r, want, `"${want}"`);
});

Then(re(`${ROW} shows the state "([^"]+)", the stage "([^"]+)", "([^"]+)" in stage, the cost "([^"]+)" and the message "([^"]*)"`),
  function (num: string | undefined, letter: string | undefined, list: string, state: string, stage: string, inStage: string, cost: string, message: string) {
    const r = row(this, num, letter, list);
    const cells = all(r.el).filter((e) => e.tag === "td").map(text);
    const has = (what: string, label: string) => assert.ok(cells.length ? cells.some((c) => c === what || c.includes(what)) : r.text.includes(what), `the row doesn't show ${label} "${what}": ${r.text}`);
    has(state, "the state");
    has(stage, "the stage");
    has(inStage, "time in stage");
    has(cost, "the cost");
    has(message, "the message");
  });

Then(re(`${ROW} shows it is fixing CI on commit "([0-9a-f]+)", with the failed check "([^"]+)"`), function (num: string | undefined, letter: string | undefined, list: string, sha: string, check: string) {
  const r = row(this, num, letter, list);
  shows(r, /\bfixing CI\b/, "that it is fixing CI");
  shows(r, sha, `the commit ${sha}`);
  shows(r, new RegExp(`\\b${check}\\b failed`), `the failed check "${check}"`);
});

Then(re(`${ROW} shows "(Waits on [^"]+)"`), function (num: string | undefined, letter: string | undefined, list: string, what: string) {
  shows(row(this, num, letter, list), what, `"${what}"`);
});

Then(re(`${ROW} doesn't name "#([0-9]+)"`), function (num: string | undefined, letter: string | undefined, list: string, dep: string) {
  const r = row(this, num, letter, list);
  assert.ok(!new RegExp(`#${dep}\\b`).test(r.text), `the row names #${dep}: ${r.text}`);
});

Then(re(`${ROW} doesn't show "([^"]+)"`), function (num: string | undefined, letter: string | undefined, list: string, what: string) {
  const r = row(this, num, letter, list);
  assert.ok(!r.text.includes(what), `the row shows "${what}": ${r.text}`);
});

const priorityOf = (p: string) => new RegExp(`\\bpriority ${p}\\b`);
const marksBug = /\bbug\b/;

Then(re(`${ROW} shows priority ([0-9]+)`), function (num: string | undefined, letter: string | undefined, list: string, p: string) {
  shows(row(this, num, letter, list), priorityOf(p), `priority ${p}`);
});

Then(re(`${ROW} shows priority ([0-9]+), taken from "([^"]+)"`), function (num: string | undefined, letter: string | undefined, list: string, p: string, from: string) {
  const r = row(this, num, letter, list);
  shows(r, new RegExp(`\\bpriority ${p}, from #${itemOf(this, from).ext}\\b`), `priority ${p}, taken from "${from}"`);
});

Then(re(`${ROW} shows priority ([0-9]+) and marks it as a bug item`), function (num: string | undefined, letter: string | undefined, list: string, p: string) {
  const r = row(this, num, letter, list);
  shows(r, priorityOf(p), `priority ${p}`);
  shows(r, marksBug, "that it's a bug item");
});

Then(re(`${ROW} marks it as a bug item`), function (num: string | undefined, letter: string | undefined, list: string) {
  shows(row(this, num, letter, list), marksBug, "that it's a bug item");
});

Then(re(`${ROW} doesn't mark it as a bug item`), function (num: string | undefined, letter: string | undefined, list: string) {
  const r = row(this, num, letter, list);
  assert.ok(!marksBug.test(r.text), `the row marks it as a bug item: ${r.text}`);
});

Then(re(`${ROW} shows the "([^"]+)" badge`), function (num: string | undefined, letter: string | undefined, list: string, badge: string) {
  shows(row(this, num, letter, list), new RegExp(`(?:^|[^\\w-])${badge}(?![\\w-])`), `the "${badge}" badge`);
});

Then(re(`${ROW} shows the "final-stage" badge, taken from "([^"]+)"`), function (num: string | undefined, letter: string | undefined, list: string, from: string) {
  shows(row(this, num, letter, list), new RegExp(`final-stage[^#]*#${itemOf(this, from).ext}\\b`), `the "final-stage" badge, taken from "${from}"`);
});

Then(re(`${ROW} shows "part of #([0-9]+)"(?:, which opens item ([0-9]+)'s Run detail)?`), function (num: string | undefined, letter: string | undefined, list: string, parent: string, opens?: string) {
  const r = row(this, num, letter, list);
  shows(r, `part of #${parent}`, `"part of #${parent}"`);
  if (!opens) return;
  const id = idOf(this, parent);
  const link = runLinks(r.el).slice(1).find((a) => RUN_LINK.exec(a.attrs.href)![1] === id);
  assert.ok(link, `"part of #${parent}" doesn't link to item ${parent}'s Run detail: ${r.text}`);
});

Then(re(`${ROW} shows no "part of"`), function (num: string | undefined, letter: string | undefined, list: string) {
  const r = row(this, num, letter, list);
  assert.ok(!/part of/i.test(r.text), `the row shows "part of": ${r.text}`);
});

// ---- the line saying how many more ----

const moreLine = (n: number) => `${n} more ${n === 1 ? "item is" : "items are"} queued`;

function under(world: object, f: Floor): string {
  rows(world, LINE);
  return text(section(f.root, LINE));
}

Then(re(`under "Production Line" Floor shows a line saying ([0-9]+) more items? (?:is|are) queued`), function (n: string) {
  const t = under(this, floorOf(this));
  assert.ok(t.includes(moreLine(Number(n))), `under "${LINE}" Floor doesn't say "${moreLine(Number(n))}": ${t.slice(-300)}`);
});

Then(re(`under "Production Line" (today's Floor|the SPA's Floor) shows a line saying ([0-9]+) more items? (?:is|are) queued`), function (which: string, n: string) {
  const t = under(this, named(this, which));
  assert.ok(t.includes(moreLine(Number(n))), `under "${LINE}" ${which} doesn't say "${moreLine(Number(n))}": ${t.slice(-300)}`);
});

Then(re(`under "Production Line" Floor shows no line saying more items are queued`), function () {
  const t = under(this, floorOf(this));
  assert.ok(!/\bmore items? (?:is|are) queued\b/.test(t), `under "${LINE}" Floor says more are queued: ${t.slice(-300)}`);
});

// ---- the API's answer ----

type AnswerRow = { id: string; since?: string | null; question?: string | null; waitsOn?: string[] };

function answerList(world: object, list: string): AnswerRow[] {
  const a = ctx(world).answer;
  assert.ok(a, "no client read the API's Floor answer");
  const key = list === WAITING ? "waitingOnYou" : "productionLine";
  const got = a[key];
  assert.ok(Array.isArray(got), `the answer carries no "${list}" list as ${key}: its keys are ${Object.keys(a).join(", ")}`);
  return got as AnswerRow[];
}

function answerRow(world: object, list: string, n: string): AnswerRow {
  const id = idOf(world, n);
  const r = answerList(world, list).find((x) => x.id === id);
  assert.ok(r, `the answer's "${list}" list doesn't hold item ${n}`);
  return r;
}

Then(re(`the answer's ${LIST_NAME} list holds items ${NUMS}, in that order`), function (list: string, ns: string) {
  const got = answerList(this, list).map((r) => nameOf(this, r.id));
  for (const n of nums(ns)) assert.ok(got.includes(n), `the answer's "${list}" list doesn't hold item ${n}: it holds ${got.join(", ") || "nothing"}`);
  assert.deepEqual(got.filter((n) => nums(ns).includes(n)), nums(ns), `the answer's "${list}" list holds them in another order`);
});

Then(re(`the answer gives item ([0-9]+) as waiting on the question "([^"]*)" since "([^"]+)" UTC`), function (n: string, q: string, when: string) {
  const r = answerRow(this, WAITING, n);
  assert.equal(r.question, q, `the answer gives item ${n} another question`);
  assert.ok(r.since, `the answer gives no time item ${n} began waiting`);
  assert.ok(Math.abs(Date.parse(r.since) - at(this, when).getTime()) < 1000, `the answer gives item ${n} as waiting since ${r.since}`);
});

Then(re(`the answer gives item ([0-9]+) as waiting on "#([0-9]+)"`), function (n: string, dep: string) {
  const r = answerRow(this, LINE, n);
  assert.deepEqual(r.waitsOn, [dep], `the answer gives item ${n} as waiting on ${JSON.stringify(r.waitsOn)}`);
});

Then(re(`the answer says how many more queued items didn't fit, which is ([0-9]+)`), function (n: string) {
  const a = ctx(this).answer;
  assert.ok(a, "no client read the API's Floor answer");
  assert.equal(a.productionMore, Number(n), `the answer gives productionMore as ${JSON.stringify(a.productionMore)}`);
});

Then(re(`the SPA's ${LIST_NAME} lists the same items, in the same order, as the answer's ${LIST_NAME} list`), function (list: string, other: string) {
  assert.equal(list, other, "the step compares two different lists");
  const want = answerList(this, list).map((r) => r.id);
  assert.equal(floorOf(this).kind, "spa", "the SPA's Floor isn't open");
  const got = rows(this, list).map((r) => r.id);
  assert.deepEqual(got.map((id) => nameOf(this, id)), want.map((id) => nameOf(this, id)), `the SPA's "${list}" differs from the answer's`);
});
