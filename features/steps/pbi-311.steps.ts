// Step definitions for features/pbi-311-queue-move-survives-board-insert.feature.
//
// Every scenario runs PBI 89's control plane on PBI 4's test database, with a fake board and a fake repo host, set up
// as PBI 265's scenarios set theirs up. PBI 265's items, Move up and Move down, the items Production Line lists to
// claim, board order, override and readiness gate steps are reused, and so is its poll, whose judge is never asked: a
// new issue the poll reads stays Eligible until "the readiness gate passes" it.
//
// The contract these steps set up, which the code reads:
// - The board's order is each issue's `rank` on the fake board, its place from 1 down. A change to the board's order,
//   a new issue landing on it or a person reordering it, gives every issue on the board its new place, and only the
//   board changes: the factory sees it when the poller reads the board.
// - A new issue is put on the board opted in, in the same repo as the scenario's other items, with its own external
//   id. Once a poll has read it, the steps know it by its name.
// - PBI 320's "the poller reads the board" is reused. It calls the world's `afterPoll`, which here learns the new issues.
// - Floor's "Production Line" shows up to ten rows (PBI 430), more than any scenario here names, so PBI 265's step
//   reads every item to claim from Floor.
// - An issue taken off the board is closed there, and the issues left on it close up, taking places 1, 2, 3 and so on.
// - A move ends when its override is cleared: `cleared_at` records when. When a board change ends it, the item's page
//   says so, in a sentence naming the control: `Move up ended by a change to the board's order`, or `Move down ...`.
import { After, Before, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { withTx } from "../../src/store/db.ts";
import { transitionItem } from "../../src/store/items.ts";
import type { ItemEvent, ItemState } from "../../src/core/states.ts";
import { ctx as p17 } from "./pbi-17.steps.ts";
import { ctx as p89 } from "./pbi-89.steps.ts";
import { text } from "./pbi-175.steps.ts";
import { ctx as p265, inState, itemOf, nextUpNames, openItem } from "./pbi-265.steps.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";

const REPO = "octo/repo";
const pool = () => need().pool;
const names = (list: string) => [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const LIST = `((?:"[^"]+"(?:, | and )?)+)`;
const re = (s: string) => new RegExp(`^${s}$`);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Ctx = {
  /** New issues put on the board that no poll has read yet, by name, with their external ids. */
  landed: Map<string, string>;
  nextExt: number;
};

function ctx(world: object): Ctx {
  const w = world as { pbi311?: Ctx };
  w.pbi311 ??= { landed: new Map(), nextExt: 900 };
  return w.pbi311;
}

Before({ tags: "@pbi-311", ...long }, async function () {
  const d = await testDb();
  if (!d) return;
  await d.pool.query(`truncate item, "user", backlog_source, repo, webhook_delivery, override cascade`);
  await d.pool.query("update wip_policy set mode = 'fixed', current_wip = 1, review_capacity = 3, usage_paused_until = null");
  p89(this).runTick = async (once) => {
    await once();
  };
  (this as { itemIs?: (name: string, state: string) => Promise<void> }).itemIs = (name, state) => inState(this, name, state);
  p17(this).ticked = true;
  (this as { afterPoll?: () => Promise<void> }).afterPoll = () => learnLanded(this);
});

After({ tags: "@pbi-311", ...long }, async function () {
  const c = p89(this);
  await c.close?.();
  if (c.server) {
    c.server.closeAllConnections();
    await new Promise<void>((resolve) => c.server!.close(() => resolve()));
  }
});

// ---- the board ----

/** The external id of an issue the scenario named, whether or not a poll has read it yet. */
function extOf(world: object, name: string): string {
  const landed = ctx(world).landed.get(name);
  if (landed) return landed;
  return itemOf(world, name).ext;
}

/** Gives every named issue its place on the board, 1 first, changing the board alone. */
async function reorderBoard(world: object, order: string[]): Promise<void> {
  const fake = p89(world).fake!;
  for (const [i, name] of order.entries()) {
    const ext = extOf(world, name);
    const fi = await fake.adapter.getItem(ext);
    assert.ok(fi, `the board has no issue "${name}"`);
    await fake.seed({ ...fi, rank: i + 1 });
    const known = p265(world).items.get(name);
    if (known) known.rank = i + 1;
  }
}

async function land(world: object, added: string[], order: string[]): Promise<void> {
  const m = ctx(world);
  for (const name of added) {
    assert.ok(!p265(world).items.has(name) && !m.landed.has(name), `issue "${name}" is already on the board`);
    const ext = String(m.nextExt++);
    await p89(world).fake!.seed({ externalId: ext, title: `Item ${name}`, repo: REPO, rank: order.length, acceptanceCriteria: ["it works"] });
    m.landed.set(name, ext);
  }
  const all = new Set([...p265(world).items.keys(), ...m.landed.keys()]);
  assert.deepEqual([...order].sort(), [...all].sort(), "the board's new order doesn't name every issue on it");
  await reorderBoard(world, order);
}

When(re(`a new issue "([^"]+)" lands on the board, which then orders the items ${LIST}`), async function (name: string, list: string) {
  await land(this, [name], names(list));
});

When(re(`new issues ${LIST} land on the board, which then orders the items ${LIST}`), async function (added: string, list: string) {
  await land(this, names(added), names(list));
});

When(re(`(?:a|A) person reorders the board to ${LIST}`), async function (list: string) {
  const order = names(list);
  assert.deepEqual([...order].sort(), [...p265(this).items.keys()].sort(), "the board's new order doesn't name every issue on it");
  await reorderBoard(this, order);
});

When(re(`a person takes issue "([^"]+)" off the board`), async function (gone: string) {
  const fake = p89(this).fake!;
  const it = itemOf(this, gone);
  const fi = await fake.adapter.getItem(it.ext);
  assert.ok(fi, `the board has no issue "${gone}"`);
  await fake.seed({ ...fi, closed: true });
  // The issues left on the board close up behind it.
  const left: { name: string; rank: number }[] = [];
  for (const [name, i] of p265(this).items) {
    if (name === gone) continue;
    left.push({ name, rank: (await fake.adapter.getItem(i.ext))!.rank });
  }
  await reorderBoard(this, left.sort((a, b) => a.rank - b.rank).map((l) => l.name));
});

/** After PBI 320's "the poller reads the board": a new issue the poll read is the factory's item now, known by its name. */
async function learnLanded(world: object): Promise<void> {
  const m = ctx(world);
  const c = p89(world);
  for (const [name, ext] of m.landed) {
    const row = (await pool().query<{ id: string; backlog_rank: number | null }>(
      "select id, backlog_rank from item where source_id = $1 and external_id = $2", [c.sourceId, ext],
    )).rows[0];
    assert.ok(row, `the poll didn't read the new issue "${name}"`);
    p265(world).items.set(name, { id: row.id, ext, rank: row.backlog_rank ?? 0 });
    p17(world).items[name] = row.id;
    m.landed.delete(name);
  }
}

// ---- the readiness gate ----

async function pass(world: object, name: string): Promise<void> {
  const it = itemOf(world, name);
  const s = (await pool().query<{ state: ItemState }>("select state from item where id = $1", [it.id])).rows[0].state;
  const events: ItemEvent[] = s === "NotReady" ? ["item_edited", "ready"] : ["ready"];
  await withTx(pool(), async (c) => {
    for (const e of events) await transitionItem(c, it.id, e, { actor: "system", actorId: "poller" });
  });
}

When(re(`the readiness gate passes items ${LIST}`), async function (list: string) {
  for (const name of names(list)) await pass(this, name);
});

// ---- Floor ----

Then(re(`Floor's "Production Line" lists "([^"]+)" to claim (ahead of|behind) "([^"]+)"`), async function (a: string, where: string, b: string) {
  const listed = await nextUpNames(this);
  const ia = listed.indexOf(a), ib = listed.indexOf(b);
  assert.ok(ia >= 0 && ib >= 0, `Floor's Production Line doesn't list both "${a}" and "${b}" to claim: ${listed.join(", ")}`);
  assert.ok(where === "ahead of" ? ia < ib : ia > ib, `Floor's Production Line doesn't list "${a}" ${where} "${b}" to claim: ${listed.join(", ")}`);
});

// ---- the item's page ----

Then(re(`item "([^"]+)"'s page says its "(Move up|Move down)" was ended by a change to the board's order`), async function (name: string, control: string) {
  const page = text(await openItem(this, name, p89(this).login!));
  const says = new RegExp(`${escape(control)}\\b[^.]*\\bended by a change to the board's order`, "i");
  assert.ok(says.test(page), `item "${name}"'s page doesn't say its "${control}" was ended by a change to the board's order: ${page.slice(0, 600)}`);
});
