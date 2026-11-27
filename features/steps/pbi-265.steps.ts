// Step definitions for features/pbi-265-start-now-and-queue-moves.feature.
//
// Every scenario runs PBI 89's control plane, its real handlers on a free port, on PBI 4's test database, with a fake
// board and a fake repo host. PBI 89's "the control plane is running with a fake board", "the scheduler ticks once"
// and "the dashboard answers {int}" are reused. Its tick here keeps the WIP limit, through `runTick`, so the one free
// slot the feature's background gives claims an item. Its launcher only records the cells it starts.
//
// The contract these steps set up, which the code reads:
// - Start now, Move up and Move down are item overrides of kind `start_now`, `move_up` and `move_down`. An item's page
//   offers each as a button of that label in its Controls, posting to /overrides with `kind`, `itemId` and a
//   `reason`, as Hold does. Pressing one here posts that form as the signed-in person.
// - Each override is a row of the override table with `scope = 'item'`, its kind, the reason, and `created_by` the
//   person who set it. Active means not cleared and not past any expiry. When one ends, `cleared_at` records when.
// - While an item has an active `start_now` override, its page says it is "marked Start now", to anyone who opens it.
// - Floor's "Next up" lists the items in the order the next free slots claim them, each linking to its page.
// - The board is the fake board: its order is each issue's `rank`. The factory asks it to reorder nothing, so no
//   board call beyond reading it and commenting is made from the moment the operator signs in.
// - The readiness gate's verdicts are the state machine's own moves: passing sends an item to Queued, through
//   Eligible from NotReady, and turning it away sends it to NotReady. The judge itself isn't what's under test.
// - PBI 105's `item "A" is Queued`, PBI 17's `item "A" is "Queued"` and PBI 177's `items "B" and "C" are "Queued"`
//   match this feature's steps too. The first sets up the item here, through `itemIs`, and the other two read these
//   items' states from PBI 17's context, which these steps fill in.
// - An open blocker is the board's open dependency, which the poller copies into `item.blocked_by`.
// - An item that reaches Done, Failed, Abandoned or Split keeps the WIP slot it ran in until "a WIP slot frees up".
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { FactoryItem } from "../../src/adapters/types.ts";
import type { ItemEvent, ItemState } from "../../src/core/states.ts";
import { withTx } from "../../src/store/db.ts";
import { nextUp, overrideItem, transitionItem } from "../../src/store/items.ts";
import { pollOnce } from "../../src/watcher/poller.ts";
import { ctx as p17 } from "./pbi-17.steps.ts";
import { ctx as p89, headers } from "./pbi-89.steps.ts";
import { text } from "./pbi-175.steps.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";

const REPO = "octo/repo";
const KINDS: Record<string, string> = { "Start now": "start_now", "Move up": "move_up", "Move down": "move_down" };
/** The adapter calls that read the board, or only comment on it. Anything else could change the board. */
const READS = new Set(["listEligible", "getItem", "openDependencies", "parseWebhook", "comment", "capabilities"]);

type Ctx = {
  /** Each item's id, external id and board rank, by the feature's name for it. */
  items: Map<string, { id: string; ext: string; rank: number }>;
  nextRank: number;
  /** The board calls made since the operator signed in, by method name. */
  boardCalls: string[];
  /** The pages opened, by item name, and the last one opened. */
  pages: Map<string, string>;
  page?: string;
  /** The override the last override step read. */
  override?: { id: string; reason: string; created_by_login: string | null; cleared_at: Date | null };
  operator?: string;
};

export function ctx(world: object): Ctx {
  const w = world as { pbi265?: Ctx };
  w.pbi265 ??= { items: new Map(), nextRank: 1, boardCalls: [], pages: new Map() };
  return w.pbi265;
}

const pool = () => need().pool;
const names = (list: string) => [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const LIST = `((?:"[^"]+"(?:, | and )?)+)`;
const re = (s: string) => new RegExp(`^${s}$`);

function kindOf(control: string): string {
  const k = KINDS[control];
  assert.ok(k, `no control "${control}"`);
  return k;
}

export function itemOf(world: object, name: string) {
  const it = ctx(world).items.get(name);
  assert.ok(it, `no item "${name}" was set up`);
  return it;
}

Before({ tags: "@pbi-265", ...long }, async function () {
  const d = await testDb();
  if (!d) return;
  await d.pool.query(`truncate item, "user", backlog_source, repo, webhook_delivery, override cascade`);
  await d.pool.query("update wip_policy set mode = 'fixed', current_wip = 1, review_capacity = 3, usage_paused_until = null");
  // PBI 89's "the scheduler ticks once" keeps the WIP limit through here, so a free slot claims an item.
  p89(this).runTick = async (once) => {
    await once();
  };
  // PBI 105's `item "A" is Queued` sets up the item here instead.
  (this as { itemIs?: (name: string, state: string) => Promise<void> }).itemIs = (name, state) => inState(this, name, state);
  // PBI 17's `item "A" is "Queued"` and PBI 177's `items "B" and "C" are "Queued"` read these items' states. They need
  // a tick only to know the scheduler exists, which here it does.
  p17(this).ticked = true;
});

After({ tags: "@pbi-265", ...long }, async function () {
  // PBI 89 closes its control plane only in its own scenarios.
  const c = p89(this);
  await c.close?.();
  if (c.server) {
    c.server.closeAllConnections();
    await new Promise<void>((resolve) => c.server!.close(() => resolve()));
  }
});

// ---- people ----

async function user(login: string, role: string): Promise<string> {
  return (await pool().query<{ id: string }>(
    `insert into "user" (provider, subject, github_login, role) values ('microsoft', $1, $1, $2)
     on conflict (provider, subject) do update set role = excluded.role returning id`,
    [login, role],
  )).rows[0].id;
}

Given(re(`an operator "([^"]+)" is signed in`), async function (login: string) {
  const c = p89(this);
  assert.ok(c.fake && c.host, "the control plane isn't running");
  const m = ctx(this);
  m.operator = await user(login, "operator");
  c.login = login;
  // Claims pin the repo, so it's configured and has a default branch head.
  await pool().query("insert into repo (host_adapter, url) values ('fake', $1) on conflict (url) do nothing", [`https://github.com/${REPO}`]);
  c.host.heads.set(REPO, "0123456789abcdef0123456789abcdef01234567");
  // Every board call from here on is recorded, so a step can tell whether the factory asked the board to change.
  const adapter = c.fake.adapter as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(adapter)) {
    if (typeof value !== "function") continue;
    adapter[key] = (...args: unknown[]) => {
      m.boardCalls.push(key);
      return (value as (...a: unknown[]) => unknown).apply(adapter, args);
    };
  }
});

// ---- items ----

export async function seedBoard(world: object, name: string, ext: string, rank: number, extra: Partial<FactoryItem> = {}): Promise<void> {
  await p89(world).fake!.seed({ externalId: ext, title: `Item ${name}`, repo: REPO, rank, acceptanceCriteria: ["it works"], ...extra });
}

/** Puts an item on the board and in the factory's database in `state`, below every item already there. */
export async function newItem(world: object, name: string, state: ItemState): Promise<string> {
  const c = p89(world);
  const m = ctx(world);
  assert.ok(!m.items.has(name), `item "${name}" was set up twice`);
  const rank = m.nextRank++;
  // PBI 430's scenarios name their items by issue number, so an item named "41" is issue #41 on the board.
  const ext = (world as { extByName?: boolean }).extByName && /^\d+$/.test(name) ? name : String(100 + rank);
  await seedBoard(world, name, ext, rank);
  const id = (await pool().query<{ id: string }>(
    `insert into item (source_id, external_id, title, state, backlog_rank, repo) values ($1, $2, $3, $4, $5, $6) returning id`,
    [c.sourceId, ext, `Item ${name}`, state, rank, REPO],
  )).rows[0].id;
  m.items.set(name, { id, ext, rank });
  p17(world).items[name] = id;
  return id;
}

export async function openRun(id: string, stage: string): Promise<void> {
  await pool().query(
    "insert into run (item_id, run_number, next_stage, config_sha, sop_version, scenarios_sha) values ($1, 1, $2, 'pinned', 'default@1', 'scen')",
    [id, stage],
  );
}

/** An item waiting on a question, answered `agoMs` ago, or not answered when `agoMs` is null. */
async function waiting(world: object, name: string, kind: "needs_input" | "sign_off", agoMs: number | null): Promise<void> {
  const id = await newItem(world, name, kind === "sign_off" ? "SignOff" : "NeedsInput");
  await openRun(id, kind === "sign_off" ? "red" : "green");
  const answeredAt = agoMs === null ? null : new Date(Date.now() - agoMs);
  const askedAt = new Date((answeredAt ?? new Date()).getTime() - 3_600_000);
  await pool().query(
    `insert into question (item_id, kind, body, asked_at, answer, answered_by, answered_at, decision) values ($1, $2, 'which way?', $3, $4, $5, $6, $7)`,
    [id, kind, askedAt, agoMs === null ? null : kind === "sign_off" ? "approved" : "this way", agoMs === null ? null : ctx(world).operator, answeredAt,
      agoMs === null ? null : kind === "sign_off" ? "approve" : "answer"],
  );
}

export async function inState(world: object, name: string, state: string): Promise<void> {
  switch (state) {
    case "in NeedsInput with its question answered": return waiting(world, name, "needs_input", 60_000);
    case "in NeedsInput with its question unanswered": return waiting(world, name, "needs_input", null);
    case "in SignOff with its sign-off answered": return waiting(world, name, "sign_off", 60_000);
  }
  const id = await newItem(world, name, state as ItemState);
  if (state === "InProgress") {
    await openRun(id, "green");
    await pool().query("update item set lease_generation = 1, lease_owner = 'scheduler', lease_expires = now() + interval '5 minutes' where id = $1", [id]);
  } else if (state === "InReview") {
    await openRun(id, "pr-review");
  }
}

Given(
  re(`item "([^"]+)" is (in NeedsInput with its question answered|in SignOff with its sign-off answered|in NeedsInput with its question unanswered)`),
  async function (name: string, state: string) {
    await inState(this, name, state);
  },
);

Given(re(`item "([^"]+)" is in (NeedsInput with its question|SignOff with its sign-off) answered (\\d+) (hours?|minutes?) ago`), async function (name: string, what: string, n: string, unit: string) {
  const ms = Number(n) * (unit.startsWith("hour") ? 3_600_000 : 60_000);
  await waiting(this, name, what.startsWith("SignOff") ? "sign_off" : "needs_input", ms);
});

// An item a step before already set up Queued, as PBI 320's scenarios do, keeps its place, so long as the board order holds.
Given(re(`items ${LIST} are Queued, in that board order`), async function (list: string) {
  const all = names(list);
  for (const name of all) {
    if (ctx(this).items.has(name)) assert.equal(await stateOf(this, name), "Queued", `item "${name}" isn't Queued`);
    else await newItem(this, name, "Queued");
  }
  const ranks = all.map((n) => itemOf(this, n).rank);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), `items ${list} aren't in that board order`);
});

Given(re(`items ${LIST} are Queued, and item "([^"]+)" is NotReady, in the board order ${LIST}`), async function (queued: string, notReady: string, order: string) {
  const states = new Map<string, ItemState>([...names(queued).map((n) => [n, "Queued"] as [string, ItemState]), [notReady, "NotReady"]]);
  const all = names(order);
  assert.deepEqual([...all].sort(), [...states.keys()].sort(), "the board order names other items");
  for (const name of all) await newItem(this, name, states.get(name)!);
});

export async function orderBoard(world: object, order: string[]): Promise<void> {
  const m = ctx(world);
  for (const [i, name] of order.entries()) {
    const it = itemOf(world, name);
    it.rank = i + 1;
    const fi = await p89(world).fake!.adapter.getItem(it.ext);
    await seedBoard(world, name, it.ext, it.rank, { ...fi, rank: it.rank });
    await pool().query("update item set backlog_rank = $2 where id = $1", [it.id, it.rank]);
  }
  m.nextRank = order.length + 1;
}

Given(re(`the board orders the items ${LIST}`), async function (list: string) {
  await orderBoard(this, names(list));
});

Given(re(`item "([^"]+)" is Eligible, below item "([^"]+)" on the board`), async function (name: string, above: string) {
  itemOf(this, above);
  await newItem(this, name, "Eligible");
  assert.ok(itemOf(this, name).rank > itemOf(this, above).rank);
});

Given(re(`item "([^"]+)" is on Hold`), long, async function (name: string) {
  await press(this, "hold", name, "on hold for the scenario");
  assert.equal(p89(this).status, 303, `the hold was turned down with ${p89(this).status}`);
  await tickWithoutSlot(this);
  const held = (await pool().query<{ held: boolean }>("select held from item where id = $1", [itemOf(this, name).id])).rows[0].held;
  assert.equal(held, true, "the hold didn't take effect");
});

Given(re(`item "([^"]+)" is blocked by an open issue`), async function (name: string) {
  const it = itemOf(this, name);
  p89(this).fake!.setDependencies(it.ext, ["999"]);
  await pool().query("update item set blocked_by = '{999}' where id = $1", [it.id]);
});

// ---- the operator's controls ----

/** Posts an override form, as the page's Controls do, as the signed-in person. The status is PBI 89's. */
export async function press(world: object, kind: string, name: string, reason: string): Promise<void> {
  const c = p89(world);
  const r = await fetch(`${c.origin}/overrides`, {
    method: "POST", redirect: "manual", body: new URLSearchParams({ kind, itemId: itemOf(world, name).id, reason }).toString(),
    headers: { ...headers(c.login!), origin: c.origin!, "content-type": "application/x-www-form-urlencoded" },
  });
  c.status = r.status;
  await r.text();
}

Given(re(`the operator (?:presses|pressed) "([^"]+)" on item "([^"]+)" with the reason "([^"]*)"`), async function (control: string, name: string, reason: string) {
  await press(this, kindOf(control), name, reason);
});

When(re(`the operator releases the hold on item "([^"]+)"`), async function (name: string) {
  await press(this, "unhold", name, "released for the scenario");
});

When(re(`the operator re-queues item "([^"]+)" with the reason "([^"]*)"`), async function (name: string, reason: string) {
  await press(this, "requeue", name, reason);
});

// ---- pages ----

export async function fetchPage(world: object, path: string, login: string): Promise<string> {
  const c = p89(world);
  const r = await fetch(`${c.origin}${path}`, { headers: headers(login), redirect: "manual" });
  const page = await r.text();
  assert.equal(r.status, 200, `${path} answered ${r.status}: ${page.slice(0, 300)}`);
  return page;
}

export async function openItem(world: object, name: string, login: string): Promise<string> {
  const page = await fetchPage(world, `/items/${itemOf(world, name).id}`, login);
  const m = ctx(world);
  m.pages.set(name, page);
  m.page = page;
  return page;
}

When(re(`the operator opens item "([^"]+)"'s page`), async function (name: string) {
  await openItem(this, name, p89(this).login!);
});

When(re(`"([^"]+)", a viewer, opens item "([^"]+)"'s page`), async function (login: string, name: string) {
  await user(login, "viewer");
  await openItem(this, name, login);
});

When(re(`the operator opens Floor before the scheduler ticks`), async function () {
  // Kept as PBI 140's "the operator opens Floor" keeps it, for the Thens that read the page opened.
  const c = p89(this);
  c.html = await fetchPage(this, "/", c.login!);
  c.status = 200;
});

/** The page's Controls section, from its heading to the next one. */
function controls(page: string): string {
  const start = page.indexOf("<h2>Controls</h2>");
  if (start < 0) return "";
  const end = page.indexOf("<h2>", start + 1);
  return page.slice(start, end < 0 ? undefined : end);
}

/** Each form on the page holding a button labelled `label`, and whether that form has a box for the reason. */
function buttons(html: string, label: string): { reason: boolean }[] {
  return [...html.matchAll(/<form\b[\s\S]*?<\/form>/gi)].flatMap((f) => {
    const has = [...f[0].matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi)].filter((b) => text(b[1]) === label);
    const reason = /<(input|textarea)\b[^>]*\bname="reason"/i.test(f[0]);
    return has.map(() => ({ reason }));
  });
}

function offered(page: string, label: string): boolean {
  return buttons(controls(page), label).length > 0;
}

function lastPage(world: object): string {
  const p = ctx(world).page;
  assert.ok(p, "no page was opened");
  return p;
}

function offersWithReason(page: string, label: string): void {
  const found = buttons(controls(page), label);
  assert.ok(found.length > 0, `the page's Controls offer no "${label}": ${text(controls(page)) || "(no Controls)"}`);
  assert.ok(found.every((f) => f.reason), `the page's "${label}" has no box for the reason`);
}

Then(re(`the page's Controls offer "([^"]+)", with a box for the reason`), function (label: string) {
  offersWithReason(lastPage(this), label);
});

Then(re(`the page's Controls offer "([^"]+)" and "([^"]+)", each with a box for the reason`), function (a: string, b: string) {
  const page = lastPage(this);
  offersWithReason(page, a);
  offersWithReason(page, b);
});

function pageOf(world: object, name: string): string {
  const p = ctx(world).pages.get(name);
  assert.ok(p, `item "${name}"'s page wasn't opened`);
  return p;
}

Then(re(`item "([^"]+)"'s page offers "([^"]+)"`), function (name: string, label: string) {
  assert.ok(offered(pageOf(this, name), label), `item "${name}"'s page doesn't offer "${label}": ${text(controls(pageOf(this, name))) || "(no Controls)"}`);
});

Then(re(`item "([^"]+)"'s page doesn't offer "([^"]+)"`), function (name: string, label: string) {
  assert.ok(!offered(pageOf(this, name), label), `item "${name}"'s page offers "${label}"`);
});

Then(re(`the page offers no ${LIST} or "([^"]+)" control`), function (list: string, last: string) {
  const page = lastPage(this);
  for (const label of [...names(list), last]) assert.equal(buttons(page, label).length, 0, `the page offers "${label}"`);
});

const marked = (page: string, label: string) => new RegExp(`\\bmarked\\W+${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text(page));

Then(re(`the page shows item "([^"]+)" is marked "([^"]+)"`), function (name: string, label: string) {
  const page = pageOf(this, name);
  assert.ok(marked(page, label), `item "${name}"'s page doesn't show it is marked "${label}"`);
});

Then(re(`item "([^"]+)"'s page shows it is marked "([^"]+)"`), async function (name: string, label: string) {
  const page = await openItem(this, name, p89(this).login!);
  assert.ok(marked(page, label), `item "${name}"'s page doesn't show it is marked "${label}"`);
});

Then(re(`item "([^"]+)"'s page no longer shows it is marked "([^"]+)"`), async function (name: string, label: string) {
  const page = await openItem(this, name, p89(this).login!);
  assert.ok(!marked(page, label), `item "${name}"'s page still shows it is marked "${label}"`);
});

// ---- Floor ----

export async function nextUpNames(world: object): Promise<string[]> {
  const page = await fetchPage(world, "/", p89(world).login!);
  const start = page.indexOf("<h2>Next up</h2>");
  assert.ok(start >= 0, "Floor has no Next up");
  const end = page.indexOf("<h2>", start + 1);
  const section = page.slice(start, end < 0 ? undefined : end);
  const byId = new Map([...ctx(world).items.entries()].map(([n, it]) => [it.id, n]));
  const ids = [...section.matchAll(/href="\/items\/([0-9a-f-]{36})"/g)].map((h) => h[1]);
  // Floor shows the first FLOOR_NEXT_UP items of the claim order. PBI 311's scenarios name more, so for them the rest
  // is read from the claim order Floor shows, once Floor's own list is found to be its head.
  if ((world as { nextUpBeyondFloor?: boolean }).nextUpBeyondFloor && ids.length === FLOOR_NEXT_UP) {
    const all = (await nextUp(pool(), 100)).map((r) => r.id);
    assert.deepEqual(ids, all.slice(0, FLOOR_NEXT_UP), "Floor's Next up isn't the head of the claim order");
    ids.push(...all.slice(FLOOR_NEXT_UP));
  }
  return ids.map((id) => byId.get(id) ?? id);
}

/** How many items Floor's "Next up" shows. */
const FLOOR_NEXT_UP = 5;

Then(re(`Floor's "Next up" lists ${LIST}, in that order`), async function (list: string) {
  assert.deepEqual(await nextUpNames(this), names(list), "Floor's Next up");
});

Then(re(`Floor's "Next up" doesn't list "([^"]+)"`), async function (name: string) {
  const listed = await nextUpNames(this);
  assert.ok(!listed.includes(name), `Floor's Next up lists "${name}": ${listed.join(", ")}`);
});

// ---- the board ----

async function boardOrder(world: object): Promise<string[]> {
  const fake = p89(world).fake!;
  const ranked: { name: string; rank: number }[] = [];
  for (const [name, it] of ctx(world).items) {
    const fi = await fake.adapter.getItem(it.ext);
    assert.ok(fi, `the board has no item "${name}"`);
    ranked.push({ name, rank: fi.rank });
  }
  return ranked.sort((a, b) => a.rank - b.rank).map((r) => r.name);
}

Then(re(`the board still orders the items ${LIST}`), async function (list: string) {
  assert.deepEqual(await boardOrder(this), names(list), "the board's order changed");
});

Then(re(`the factory asked the board to reorder nothing`), function () {
  // The board's own reads, done here, are recorded too, so only a change counts.
  const changes = ctx(this).boardCalls.filter((k) => !READS.has(k));
  assert.deepEqual(changes, [], `the factory asked the board for ${changes.join(", ")}`);
});

When(re(`the poller reads the board, still ordered ${LIST}`), long, async function (list: string) {
  assert.deepEqual(await boardOrder(this), names(list), "the board isn't in the order the step names");
  await poll(this);
});

export async function poll(world: object): Promise<void> {
  const c = p89(world);
  await pollOnce({
    pool: pool(), adapter: c.fake!.adapter, repoHost: c.host!, sourceId: c.sourceId!,
    judge: async () => {
      throw new Error("the judge isn't asked in this feature");
    },
  });
}

When(re(`the issue blocking item "([^"]+)" closes and the poller reads it`), long, async function (name: string) {
  const it = itemOf(this, name);
  p89(this).fake!.setDependencies(it.ext, []);
  await poll(this);
});

// ---- the scheduler and the readiness gate ----

async function tickWithoutSlot(world: object): Promise<void> {
  const before = (await pool().query<{ current_wip: number }>("select current_wip from wip_policy limit 1")).rows[0].current_wip;
  await pool().query("update wip_policy set current_wip = 0");
  try {
    const c = p89(world);
    const { tick } = await import("../../src/scheduler/scheduler.ts");
    const { fakeLauncher } = await import("../../src/scheduler/launcher.ts");
    await tick({ pool: pool(), launcher: fakeLauncher(), now: new Date(), killFlag: false, repoHost: c.host!, backlogFor: () => c.fake!.adapter,
      secret: "pbi-265-secret", controlUrl: "http://control.test", sopVersion: "default@1" });
  } finally {
    await pool().query("update wip_policy set current_wip = $1", [before]);
  }
}

When(re(`the scheduler ticks once with no free WIP slot`), long, async function () {
  await tickWithoutSlot(this);
});

When(re(`a WIP slot frees up`), async function () {
  await pool().query("update wip_policy set current_wip = current_wip + 1");
});

const gateActor = { actor: "system", actorId: "poller" } as const;

async function moves(world: object, name: string, events: ItemEvent[]): Promise<void> {
  const it = itemOf(world, name);
  await withTx(pool(), async (c) => {
    for (const e of events) await transitionItem(c, it.id, e, gateActor);
  });
}

export async function stateOf(world: object, name: string): Promise<ItemState> {
  return (await pool().query<{ state: ItemState }>("select state from item where id = $1", [itemOf(world, name).id])).rows[0].state;
}

When(re(`the readiness gate passes item "([^"]+)"`), async function (name: string) {
  const s = await stateOf(this, name);
  await moves(this, name, s === "NotReady" ? ["item_edited", "ready"] : ["ready"]);
});

When(re(`the readiness gate turns item "([^"]+)" away again`), async function (name: string) {
  const s = await stateOf(this, name);
  await moves(this, name, s === "NotReady" ? ["item_edited", "readiness_failed"] : ["readiness_failed"]);
});

When(re(`the item's author fixes item "([^"]+)" and the readiness gate passes it`), async function (name: string) {
  const it = itemOf(this, name);
  const fi = await p89(this).fake!.adapter.getItem(it.ext);
  await seedBoard(this, name, it.ext, it.rank, { ...fi, body: "Fixed so it meets the Definition of Ready." });
  const s = await stateOf(this, name);
  await moves(this, name, s === "NotReady" ? ["item_edited", "ready"] : ["ready"]);
});

// An item reaches Done, Failed, Abandoned or Split by running in the scenario's free WIP slot, and the slot it ran in
// doesn't free up for another item until a scenario says "a WIP slot frees up", as the readiness rule's scenarios do.
// So the tick after it only ends the item's overrides, and an item re-queued afterwards is seen in Next up beside the
// items it was queued with.
When(re(`item "([^"]+)" reaches (Done|Failed|Abandoned|Split)`), async function (name: string, state: ItemState) {
  const it = itemOf(this, name);
  await withTx(pool(), (c) => overrideItem(c, it.id, state, { actor: "system", actorId: "pbi-265" }, `the scenario moves it to ${state}`));
  // PBI 320's items reach Done from InReview, outside any WIP slot, so the slot stays free for the next claim.
  if ((this as { finishKeepsSlotFree?: boolean }).finishKeepsSlotFree) return;
  await pool().query("update wip_policy set current_wip = greatest(current_wip - 1, 0)");
});

// ---- states ----

Then(re(`item "([^"]+)" is "([^"]+)" and still on Hold`), async function (name: string, state: string) {
  const r = (await pool().query<{ state: string; held: boolean }>("select state, held from item where id = $1", [itemOf(this, name).id])).rows[0];
  assert.deepEqual(r, { state, held: true }, `item "${name}"`);
});

Then(re(`item "([^"]+)" is still in NeedsInput with its question answered`), async function (name: string) {
  const id = itemOf(this, name).id;
  assert.equal(await stateOf(this, name), "NeedsInput", `item "${name}"`);
  const q = (await pool().query("select 1 from question where item_id = $1 and answer is not null", [id])).rowCount;
  assert.ok(q, `item "${name}"'s question isn't answered`);
});

// ---- overrides ----

type OverrideRow = { id: string; reason: string; created_by_login: string | null; cleared_at: Date | null; active: boolean };

async function overridesOf(world: object, name: string, control: string): Promise<OverrideRow[]> {
  return (await pool().query<OverrideRow>(
    `select o.id, o.reason, u.github_login as created_by_login, o.cleared_at,
       (o.cleared_at is null and (o.expires_at is null or o.expires_at > now())) as active
     from override o left join "user" u on u.id = o.created_by
     where o.scope = 'item' and o.target_id = $1 and o.kind::text = $2 order by o.created_at, o.id`,
    [itemOf(world, name).id, kindOf(control)],
  )).rows;
}

Then(re(`item "([^"]+)" has an active "([^"]+)" override`), async function (name: string, control: string) {
  const active = (await overridesOf(this, name, control)).filter((o) => o.active);
  assert.ok(active.length > 0, `item "${name}" has no active "${control}" override`);
  ctx(this).override = active.at(-1);
});

Then(re(`item "([^"]+)" has no active "([^"]+)" override`), async function (name: string, control: string) {
  const all = await overridesOf(this, name, control);
  assert.equal(all.filter((o) => o.active).length, 0, `item "${name}" has an active "${control}" override`);
  ctx(this).override = all.at(-1);
});

Then(re(`item "([^"]+)" has no "([^"]+)" override`), async function (name: string, control: string) {
  const all = await overridesOf(this, name, control);
  assert.equal(all.length, 0, `item "${name}" has ${all.length} "${control}" overrides`);
});

function theOverride(world: object) {
  const o = ctx(world).override;
  assert.ok(o, "no override was read");
  return o;
}

Then(re(`the override records "([^"]+)" as the person who set it`), function (login: string) {
  assert.equal(theOverride(this).created_by_login, login);
});

Then(re(`the override records the reason "([^"]*)"`), function (reason: string) {
  assert.equal(theOverride(this).reason, reason);
});

Then(re(`the override records when it ended`), function () {
  assert.ok(theOverride(this).cleared_at instanceof Date, "the override doesn't record when it ended");
});
