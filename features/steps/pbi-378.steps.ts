// Step definitions for features/pbi-378-bug-items-first-within-priority.feature.
//
// Every scenario runs PBI 89's control plane on PBI 4's test database, with a fake board and a fake repo host, set up
// as PBI 265's and PBI 320's scenarios set theirs up. Their items, priorities, final-stage items, dependencies, board
// order, polls, ticks, Next up and Move up steps are reused, and so are PBI 140's "the operator opens Floor" and
// "the operator opens item {string}'s Run detail", which record the page they open.
//
// The contract these steps set up, which the code reads:
// - The board's "bug" label reaches the factory in the board item's `labels`, beside the factory's own opt-in label.
//   The fake board holds it there.
// - The poller writes whether the item carries the label to `item.bug_label` on every poll, as it writes
//   `board_priority`. A step that gives an item the label "on the board" sets only the board's labels, and one that
//   says the item carries it sets the board's labels and the column alike, as a poll would.
// - Floor marks a bug item in each list entry or table row that links to its page with the word "bug". Run detail, the
//   item's page, says "bug" where it marks one. Neither page has the word "bug" for an item without the label.
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { ctx as p17 } from "./pbi-17.steps.ts";
import { ctx as p89 } from "./pbi-89.steps.ts";
import { text } from "./pbi-175.steps.ts";
import { inState, itemOf, newItem } from "./pbi-265.steps.ts";
import { depend, finalStage, setPriority } from "./pbi-320.steps.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";

const BUG = "bug";

const pool = () => need().pool;
const names = (list: string) => [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const LIST = `((?:"[^"]+"(?:, | and )?)+)`;
const re = (s: string) => new RegExp(`^${s}$`);
const CARRIES = `,? and carr(?:y|ies) the "bug" label`;

Before({ tags: "@pbi-378", ...long }, async function () {
  const d = await testDb();
  if (!d) return;
  await d.pool.query(`truncate item, "user", backlog_source, repo, webhook_delivery, override cascade`);
  await d.pool.query("update wip_policy set mode = 'fixed', current_wip = 1, review_capacity = 3, usage_paused_until = null");
  p89(this).runTick = async (once) => {
    await once();
  };
  (this as { itemIs?: (name: string, state: string) => Promise<void> }).itemIs = (name, state) => inState(this, name, state);
  (this as { finishKeepsSlotFree?: boolean }).finishKeepsSlotFree = true;
  p17(this).ticked = true;
  p17(this).now = new Date();
});

After({ tags: "@pbi-378", ...long }, async function () {
  const c = p89(this);
  await c.close?.();
  if (c.server) {
    c.server.closeAllConnections();
    await new Promise<void>((resolve) => c.server!.close(() => resolve()));
  }
});

// ---- the board's labels ----

/** Adds a label to the item on the board, or removes it. */
async function boardLabel(world: object, name: string, label: string, on: boolean): Promise<void> {
  const fake = p89(world).fake!;
  const it = itemOf(world, name);
  const fi = await fake.adapter.getItem(it.ext);
  assert.ok(fi, `the board has no item "${name}"`);
  const labels = on ? [...new Set([...fi.labels, label])] : fi.labels.filter((l) => l !== label);
  await fake.seed({ ...fi, labels });
}

/** Gives an item the "bug" label on the board and in the factory, as a poll reading the board would. */
async function carriesBug(world: object, name: string): Promise<void> {
  await boardLabel(world, name, BUG, true);
  await pool().query("update item set bug_label = true where id = $1", [itemOf(world, name).id]);
}

Given(re(`item "([^"]+)" is Queued and carries the "([^"]+)" label on the board`), async function (name: string, label: string) {
  await newItem(this, name, "Queued");
  await boardLabel(this, name, label, true);
});

Given(re(`items ${LIST} are Queued and carry the "bug" label on the board`), async function (list: string) {
  for (const name of names(list)) {
    await newItem(this, name, "Queued");
    await boardLabel(this, name, BUG, true);
  }
});

Given(re(`item "([^"]+)" is Queued with no "bug" label on the board`), async function (name: string) {
  await newItem(this, name, "Queued");
  const fi = await p89(this).fake!.adapter.getItem(itemOf(this, name).ext);
  assert.ok(fi && !fi.labels.includes(BUG), `item "${name}" carries the "bug" label on the board`);
});

Given(re(`item "([^"]+)" is Queued with the Priority (\\d+) on the board and carries the "bug" label`), async function (name: string, p: string) {
  await newItem(this, name, "Queued");
  const fake = p89(this).fake!;
  const fi = await fake.adapter.getItem(itemOf(this, name).ext);
  assert.ok(fi, `the board has no item "${name}"`);
  await fake.seed({ ...fi, fields: { ...fi.fields, Priority: p }, labels: [...new Set([...fi.labels, BUG])] });
});

When(re(`someone adds the "bug" label to item "([^"]+)" on the board`), async function (name: string) {
  await boardLabel(this, name, BUG, true);
});

When(re(`someone removes the "bug" label from item "([^"]+)" on the board`), async function (name: string) {
  await boardLabel(this, name, BUG, false);
});

// ---- items ----

const STAGES = "Queued|InProgress in Green, with no PR yet|in NeedsInput with its question answered|InReview with an open PR";

/** Sets up an item at one of the stages the feature's outlines name. */
async function atStage(world: object, name: string, stage: string): Promise<void> {
  switch (stage) {
    case "Queued": return void (await newItem(world, name, "Queued"));
    case "InProgress in Green, with no PR yet": return inState(world, name, "InProgress");
    case "in NeedsInput with its question answered": return inState(world, name, stage);
    case "InReview with an open PR": return finalStage(world, name, "InReview");
  }
  throw new Error(`no stage "${stage}"`);
}

Given(re(`item "([^"]+)" is InReview with an open PR`), async function (name: string) {
  await atStage(this, name, "InReview with an open PR");
});

Given(re(`item "([^"]+)" is (${STAGES}) and carries the "bug" label`), async function (name: string, stage: string) {
  await atStage(this, name, stage);
  await carriesBug(this, name);
});

Given(re(`item "([^"]+)" carries the "bug" label`), async function (name: string) {
  await carriesBug(this, name);
});

Given(re(`item "([^"]+)" is Queued, has priority (\\d+)${CARRIES}`), async function (name: string, p: string) {
  await newItem(this, name, "Queued");
  await setPriority(this, name, Number(p));
  await carriesBug(this, name);
});

Given(re(`items ${LIST} are Queued, with priority (\\d+)${CARRIES}`), async function (list: string, p: string) {
  for (const name of names(list)) {
    await newItem(this, name, "Queued");
    await setPriority(this, name, Number(p));
    await carriesBug(this, name);
  }
});

Given(re(`item "([^"]+)" is in NeedsInput with its question answered, has priority (\\d+)${CARRIES}`), async function (name: string, p: string) {
  await inState(this, name, "in NeedsInput with its question answered");
  await setPriority(this, name, Number(p));
  await carriesBug(this, name);
});

Given(re(`item "([^"]+)" has an open PR and is InReview, with priority (\\d+)${CARRIES}`), async function (name: string, p: string) {
  await finalStage(this, name, "InReview");
  await setPriority(this, name, Number(p));
  await carriesBug(this, name);
});

Given(re(`item "([^"]+)" has an open PR, is Queued to address requested changes, has priority (\\d+)${CARRIES}`), async function (name: string, p: string) {
  await finalStage(this, name, "Queued to address requested changes");
  await setPriority(this, name, Number(p));
  await carriesBug(this, name);
});

Given(
  re(`items ${LIST} each have an open PR, are Queued to address requested changes, have priority (\\d+)${CARRIES}`),
  async function (list: string, p: string) {
    for (const name of names(list)) {
      await finalStage(this, name, "Queued to address requested changes");
      await setPriority(this, name, Number(p));
      await carriesBug(this, name);
    }
  },
);

Given(re(`item "([^"]+)" depends on items ${LIST} on the board`), function (dependent: string, list: string) {
  for (const on of names(list)) depend(this, dependent, on);
});

// ---- what the factory holds ----

async function bugLabel(world: object, name: string): Promise<boolean> {
  const r = (await pool().query<{ bug_label: boolean }>("select bug_label from item where id = $1", [itemOf(world, name).id])).rows[0];
  assert.ok(r, `the factory has no item "${name}"`);
  return r.bug_label;
}

Then(re(`the factory holds item "([^"]+)" as a bug item`), async function (name: string) {
  assert.equal(await bugLabel(this, name), true, `the factory doesn't hold item "${name}" as a bug item`);
});

Then(re(`the factory doesn't hold item "([^"]+)" as a bug item`), async function (name: string) {
  assert.equal(await bugLabel(this, name), false, `the factory holds item "${name}" as a bug item`);
});

// ---- Floor and Run detail ----

const marksBug = (t: string) => /\bbug\b/i.test(t);

/** The page the operator last opened, through PBI 140's steps. */
function opened(world: object): string {
  const c = p89(world);
  assert.equal(c.status, 200, "the page didn't open");
  return c.html!;
}

/** The text of each list entry and table row on Floor that links to the item's page. */
function floorEntries(world: object, name: string): string[] {
  const link = `href="/runs/${encodeURIComponent(itemOf(world, name).id)}"`;
  return [...opened(world).matchAll(/<(li|tr)\b[^>]*>([\s\S]*?)<\/\1>/gi)].filter((m) => m[2].includes(link)).map((m) => text(m[2]));
}

Then(re(`Floor marks item "([^"]+)" as a bug item`), function (name: string) {
  const entries = floorEntries(this, name);
  assert.ok(entries.length > 0, `Floor doesn't list item "${name}"`);
  assert.ok(entries.some(marksBug), `Floor doesn't mark item "${name}" as a bug item: ${entries.join(" | ")}`);
});

Then(re(`Floor doesn't mark item "([^"]+)" as a bug item`), function (name: string) {
  const entries = floorEntries(this, name);
  assert.ok(!entries.some(marksBug), `Floor marks item "${name}" as a bug item: ${entries.join(" | ")}`);
});

/** The Run detail the operator last opened, which must be the item's own. */
function runDetail(world: object, name: string): string {
  const page = opened(world);
  assert.ok(page.includes(itemOf(world, name).id) || page.includes(`Item ${name}`), `the page opened isn't item "${name}"'s Run detail`);
  return text(page);
}

Then(re(`Run detail marks item "([^"]+)" as a bug item`), function (name: string) {
  const t = runDetail(this, name);
  assert.ok(marksBug(t), `Run detail doesn't mark item "${name}" as a bug item: ${t.slice(0, 400)}`);
});

Then(re(`Run detail doesn't mark item "([^"]+)" as a bug item`), function (name: string) {
  const t = runDetail(this, name);
  assert.ok(!marksBug(t), `Run detail marks item "${name}" as a bug item: ${t.slice(0, 400)}`);
});
