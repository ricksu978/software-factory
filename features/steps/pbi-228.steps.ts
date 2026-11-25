// Step definitions for features/pbi-228-abandoned-split-parents-to-split.feature. Every scenario runs on PBI 225's
// harness: the real poller over Postgres on PBI 144's fake board, its scripted judge and coding model, and PBI 12's fake
// repo host. PBI 225's Before hook covers @pbi-228 too. PBI 226's steps hold a child in a state and read the parent's
// comments, close and history.
// A parent "split before PBI 225" is split by the real poller as it is today: the judge finds it oversized, the coding
// model proposes the split, the factory keeps it in item_split and files every child with its split marker, and takes
// the parent's label off. Its history is then put back as it was before PBI 225 and PBI 226: the "split_filed" move,
// and the children it recorded, are deleted and the parent is NotReady again, so the next poll before PBI 225 would
// withdraw it. The withdrawal itself is the poller's move "withdrawn", from NotReady to Abandoned.
// "The factory starts" runs the factory's migrations, as a deploy does before the control plane starts. A migration
// that makes this item's move, one whose file name carries "228", already ran on the empty test database before the
// Background seeded anything, so a first start applies it again, as a deploy over the real database would. A restart
// runs the migrations as they stand, which applies none again.
import { DataTable, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { ItemEvent, ItemState } from "../../src/core/states.ts";
import { migrate, withTx } from "../../src/store/db.ts";
import { transitionItem, upsertItem } from "../../src/store/items.ts";
import { ctx as ctx144, polled, replaceItem } from "./pbi-144.steps.ts";
import { ctx as ctx225, moves, parentId, pollMore, show } from "./pbi-225.steps.ts";
import { long, need } from "./pbi-8.steps.ts";

const HEADING = "Acceptance criteria";
const MIGRATIONS = join(import.meta.dirname, "..", "..", "db", "migrations");
const system = { actor: "system", actorId: "poller" } as const;

type Ctx = {
  /** The other parents split before PBI 225, by title. */
  parents: Map<string, string>;
  /** Issues the factory never split, by title. */
  others: Map<string, string>;
  started: boolean;
  /** The judge's asks and the coding model's requests about the parent when the factory first started. */
  askedAtStart?: number;
  requestsAtStart?: number;
};

function ctx(world: object): Ctx {
  const w = world as { pbi228?: Ctx };
  w.pbi228 ??= { parents: new Map(), others: new Map(), started: false };
  return w.pbi228;
}

async function rowOf(world: object, externalId: string): Promise<{ id: string; state: ItemState } | null> {
  const k = ctx225(world);
  const r = await need().pool.query<{ id: string; state: ItemState }>("select id, state from item where source_id = $1 and external_id = $2", [k.sourceId, externalId]);
  return r.rows[0] ?? null;
}

async function held(world: object, externalId: string, what: string): Promise<{ id: string; state: ItemState }> {
  const r = await rowOf(world, externalId);
  assert.ok(r, `the factory doesn't hold ${what}`);
  return r;
}

async function moveItem(itemId: string, event: ItemEvent): Promise<void> {
  await withTx(need().pool, (c) => transitionItem(c, itemId, event, system));
}

type Move = { id: string; from: string; to: string; event: string };

async function movesOf(itemId: string): Promise<Move[]> {
  const r = await need().pool.query<Move>(
    `select id::text, payload->>'from' as from, payload->>'to' as to, payload->>'event' as event from event
     where item_id = $1 and kind in ('transition', 'override') order by at, id`,
    [itemId],
  );
  return r.rows;
}

/** A body with one criterion per child, and the coding model's reply splitting it into `children`, each needing the one before. */
function splitOf(title: string, children: string[]): { body: string; criteria: string[]; reply: string } {
  const criteria = children.map((ch) => `A shopper can use ${ch.toLowerCase()}`);
  const body = `${title} for every shopper.\n\n## ${HEADING}\n\n${criteria.map((t) => `- ${t}`).join("\n")}\n`;
  const reply = JSON.stringify({
    children: children.map((ch, i) => ({ title: ch, body: `${ch} for ${title}`, criteria: [i + 1], needs: i === 0 ? [] : [i] })),
  });
  return { body, criteria, reply };
}

/**
 * Puts a parent the factory split today back as it was before PBI 225: its "split_filed" move, and the children that
 * move recorded, are gone, and it is NotReady again, as the poll that filed its last child left it.
 */
async function asBefore225(world: object, externalId: string, what: string): Promise<string> {
  const r = await held(world, externalId, what);
  assert.equal(r.state, "Split", `${what} isn't Split after its split was filed: ${show(await movesOf(r.id))}`);
  const pool = need().pool;
  const filed = "select id from event where item_id = $1 and kind = 'transition' and payload->>'event' = 'split_filed'";
  // Its board write waiting in the outbox goes with it.
  await pool.query(`delete from outbox where event_id in (${filed})`, [r.id]);
  await pool.query(`delete from event where id in (${filed})`, [r.id]);
  await pool.query("update item set state = 'NotReady' where id = $1", [r.id]);
  return r.id;
}

async function kept(itemId: string): Promise<number> {
  return (await need().pool.query("select 1 from item_split where item_id = $1", [itemId])).rowCount ?? 0;
}

// ---- the Background ----

Given("a parent issue {string} in {string} on that board", async function (title: string, repo: string) {
  const c = ctx144(this);
  assert.equal(repo, c.repo, `the parent issue is in "${repo}", not the repo on that board, "${c.repo}"`);
  c.parentTitle = title;
  // The factory split it, so it carried the opt-in label until the split was filed.
  c.parentId = await c.fake.seed({ title, body: `${title} for every shopper.`, acceptanceCriteria: [], labels: [c.label], repo, status: c.backlogStatus });
  c.board.set(c.parentId, c.backlogStatus);
});

Given("the factory split the parent issue before PBI 225, into {string}, {string} and {string}", long, async function (a: string, b: string, d: string) {
  const c = ctx144(this);
  assert.ok(c.parentId && c.parentTitle, "the parent issue wasn't seeded");
  const s = splitOf(c.parentTitle, [a, b, d]);
  c.criteria = s.criteria;
  await replaceItem(c, c.parentId, () => ({ body: s.body, acceptanceCriteria: s.criteria }));
  c.oversized = true;
  c.reply = s.reply;
  await pollMore(this, 2);
  await asBefore225(this, c.parentId, "the parent issue");
});

Given("the factory kept that split for the parent issue", long, async function () {
  assert.ok(await kept(await parentId(this)) > 0, "the factory kept no split for the parent issue");
});

Given("the parent issue has {int} sub-issues, one for each child of that split", long, async function (n: number) {
  const c = ctx144(this);
  polled(c);
  const id = await parentId(this);
  const split = (await need().pool.query<{ children: { title: string }[] }>("select children from item_split where item_id = $1", [id])).rows;
  assert.equal(split.length, 1, `the factory kept ${split.length} splits for the parent issue`);
  const titles = (c.subIssues.get(c.parentId!) ?? []).map((ext) => c.filed.find((f) => f.externalId === ext)?.title);
  assert.equal(titles.length, n, `the parent has ${titles.length} sub-issues`);
  assert.deepEqual(titles, split[0].children.map((ch) => ch.title), "the parent's sub-issues aren't the children of its split");
});

Given("the parent's history shows a move {string}, from {string} to {string}", long, async function (event: ItemEvent, from: string, to: string) {
  const id = await parentId(this);
  const r = await need().pool.query<{ state: string }>("select state from item where id = $1", [id]);
  assert.equal(r.rows[0].state, from, `the parent is ${r.rows[0].state}, not ${from}`);
  await moveItem(id, event);
  const all = await moves(this);
  const last = all.at(-1);
  assert.deepEqual(last && { event: last.event, from: last.from, to: last.to }, { event, from, to }, `moves: ${show(all)}`);
});

Given("these parent issues in {string} were also split before PBI 225 and are held in state {string}:", long, async function (repo: string, state: string, table: DataTable) {
  const c = ctx144(this);
  const s = ctx(this);
  assert.equal(repo, c.repo, `the parents are in "${repo}", not the repo on that board, "${c.repo}"`);
  assert.equal(state, "Abandoned");
  const rows = table.hashes();
  for (const r of rows) {
    const children = r.children.split(",").map((t) => t.trim()).filter(Boolean);
    const split = splitOf(r.parent, children);
    const id = await c.fake.seed({ title: r.parent, body: split.body, acceptanceCriteria: split.criteria, labels: [c.label], repo, status: c.backlogStatus });
    c.board.set(id, c.backlogStatus);
    (c.alsoOversized ??= new Set()).add(id);
    (c.replies ??= []).push({ title: r.parent, reply: split.reply });
    s.parents.set(r.parent, id);
  }
  await pollMore(this, 2);
  for (const r of rows) {
    const ext = s.parents.get(r.parent)!;
    const kids = c.subIssues.get(ext) ?? [];
    assert.equal(kids.length, r.children.split(",").length, `parent "${r.parent}" has ${kids.length} sub-issues`);
    const fi = await c.fake.adapter.getItem(ext);
    assert.ok(fi && !fi.labels.includes(c.label), `parent "${r.parent}" still carries "${c.label}"`);
    const id = await asBefore225(this, ext, `parent "${r.parent}"`);
    assert.ok(await kept(id) > 0, `the factory kept no split for parent "${r.parent}"`);
    await moveItem(id, "withdrawn");
    assert.equal((await held(this, ext, `parent "${r.parent}"`)).state, "Abandoned");
  }
});

// ---- items the factory never split ----

Given("an issue {string} in {string} on that board that the factory never split", async function (title: string, repo: string) {
  const c = ctx144(this);
  assert.equal(repo, c.repo, `"${title}" is in "${repo}", not the repo on that board, "${c.repo}"`);
  const id = await c.fake.seed({ title, body: `${title} for every shopper.`, acceptanceCriteria: [], labels: [c.label], repo, status: c.backlogStatus });
  c.board.set(id, c.backlogStatus);
  ctx(this).others.set(title, id);
});

function other(world: object, title: string): string {
  const id = ctx(world).others.get(title);
  assert.ok(id, `there's no issue "${title}"`);
  return id;
}

/** Holds the issue `title` in `state`, written straight to its item row, as the poller would have left it. */
async function holdOther(world: object, title: string, state: ItemState): Promise<string> {
  const c = ctx144(world);
  const k = ctx225(world);
  assert.ok(k.sourceId, "the factory's database wasn't set up");
  const id = await upsertItem(need().pool, { sourceId: k.sourceId, externalId: other(world, title), title, repo: c.repo });
  await need().pool.query("update item set state = $2 where id = $1", [id, state]);
  return id;
}

Given("a person took the label {string} off {string} while the factory held it in state {string}", long, async function (label: string, title: string, state: ItemState) {
  await holdOther(this, title, state);
  await replaceItem(ctx144(this), other(this, title), (fi) => ({ labels: fi.labels.filter((l) => l !== label) }));
});

Given("the factory holds {string} in state {string}", long, async function (title: string, state: ItemState) {
  const r = await held(this, other(this, title), `"${title}"`);
  // A person took its label off, so the poll before this item withdrew it.
  if (r.state !== state && state === "Abandoned") await moveItem(r.id, "withdrawn");
  assert.equal((await held(this, other(this, title), `"${title}"`)).state, state);
});

Given("the factory holds {string} in state {string} after it timed out in state {string}", long, async function (title: string, state: ItemState, from: ItemState) {
  const id = await holdOther(this, title, from);
  await moveItem(id, "timed_out");
  assert.equal((await held(this, other(this, title), `"${title}"`)).state, state);
});

// ---- starting and polling ----

async function start(world: object): Promise<void> {
  const s = ctx(world);
  const pool = need().pool;
  if (!s.started) {
    const c = ctx144(world);
    s.askedAtStart = ctx225(world).asked.get(c.parentId!) ?? 0;
    s.requestsAtStart = splitRequests(world);
    const mine = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && f.includes("228"));
    if (mine.length > 0) await pool.query("delete from schema_migrations where name = any($1)", [mine]);
    s.started = true;
  }
  await migrate(pool);
}

function splitRequests(world: object): number {
  const c = ctx144(world);
  return c.requests.filter((a) => a.prompt.includes(JSON.stringify(c.parentTitle))).length;
}

When("the factory starts and polls the backlog once", long, async function () {
  await start(this);
  await pollMore(this, 1);
});

When("the factory starts and polls the backlog twice", long, async function () {
  await start(this);
  await pollMore(this, 2);
});

When("the factory restarts and polls the backlog three more times", long, async function () {
  await start(this);
  await pollMore(this, 3);
});

// ---- outcomes ----

Then("the factory holds parent {string} in state {string}", long, async function (title: string, state: string) {
  const ext = ctx(this).parents.get(title);
  assert.ok(ext, `there's no parent "${title}"`);
  const r = await held(this, ext, `parent "${title}"`);
  assert.equal(r.state, state, `moves: ${show(await movesOf(r.id))}`);
});

Then("the history of {string} shows no move to {string}", long, async function (title: string, to: string) {
  const r = await held(this, other(this, title), `"${title}"`);
  const all = await movesOf(r.id);
  assert.equal(all.filter((m) => m.to === to).length, 0, `moves: ${show(all)}`);
});

Then("the parent's history shows the move to {string} before the move to {string}", long, async function (first: string, second: string) {
  const all = await moves(this);
  const a = all.findIndex((m) => m.to === first);
  const b = all.findIndex((m) => m.to === second);
  assert.ok(a !== -1, `the parent's history shows no move to "${first}": ${show(all)}`);
  assert.ok(b !== -1, `the parent's history shows no move to "${second}": ${show(all)}`);
  assert.ok(a < b, `moves: ${show(all)}`);
});

Then("the readiness judge was not asked about the parent issue", function () {
  const c = ctx144(this);
  polled(c);
  const s = ctx(this);
  assert.ok(s.askedAtStart !== undefined, "the factory never started");
  const asked = (ctx225(this).asked.get(c.parentId!) ?? 0) - s.askedAtStart;
  assert.equal(asked, 0, `the readiness judge was asked about the parent ${asked} times`);
});

Then("the coding model was not asked to split the parent issue", function () {
  const s = ctx(this);
  assert.ok(s.requestsAtStart !== undefined, "the factory never started");
  const asked = splitRequests(this) - s.requestsAtStart;
  assert.equal(asked, 0, `the coding model was asked to split the parent ${asked} times`);
});
