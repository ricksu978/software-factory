// Step definitions for features/pbi-227-split-parent-shown.feature. The Background is PBI 144's and PBI 225's: PBI
// 144's fake board, scripted repo writes, judge and coding model, with PBI 225's split of the parent into three. Here
// a parent named "#N Title" is issue N, and the repo files the children under the numbers the Background gives them.
//
// A poll is the real poller over Postgres, as in PBI 225, on each board the scenario has. Board mirroring is the real
// mirrorBoard, registered on the test pool, with each board's fake backlog as its adapter, so a parent's board status
// is the status its fake issue holds. Every setStatus the factory makes is logged with the state it mirrored.
//
// A viewer opens Run detail on the real dashboard routes, served by node:http on a free port, and Floor through PBI
// 131's "a viewer opens Floor". Both pages are recorded through PBI 19's recordResponse, where PBI 131's page() reads
// them back. "The page doesn't show" is PBI 145's step, which reads them there too.
//
// The page's contract these steps read. A Split parent's children are a list (<ol> or <ul>): on Run detail the first
// list after the text "Split into", and on Floor the first list after the text "Split into" that follows the
// parent's title. Each top-level <li> of that list is one child, in the order of the split. Its text holds "#N Title",
// it holds a link (<a href>) to the child's issue whose text holds "#N" or the title, and it shows the child's state,
// or "Not in the factory" for a child the factory doesn't hold.
import { After, Before, DataTable, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fakeRepoHost } from "../../src/adapters/fake.ts";
import type { BacklogAdapter, FactoryItem } from "../../src/adapters/types.ts";
import { mirrorBoard } from "../../src/control/board.ts";
import type { ItemState } from "../../src/core/states.ts";
import { SPLIT_HEADING } from "../../src/gate/split.ts";
import type { Policy } from "../../src/policy/policy.ts";
import { createAuth } from "../../src/http/auth.ts";
import { dashboardRoutes } from "../../src/http/routes.ts";
import { startServer } from "../../src/http/server.ts";
import { withTx } from "../../src/store/db.ts";
import { onTransition, overrideItem } from "../../src/store/items.ts";
import { pollOnce } from "../../src/watcher/poller.ts";
import { baseFiles } from "./pbi-12.steps.ts";
import { page, render, scope } from "./pbi-131.steps.ts";
import { recordResponse } from "./pbi-19.steps.ts";
import { agent, ctx as ctx144, poll, refuse, replaceItem, scriptedBoard, type Ctx as Ctx144 } from "./pbi-144.steps.ts";
import { countPass } from "./pbi-225.steps.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";

const HEADING = "Acceptance criteria";
const SPLIT_INTO = "Split into";
const NOT_IN = "Not in the factory";

type Host = ReturnType<typeof fakeRepoHost>;
/** One board: PBI 144's harness for it, its backlog_source row, and which of its issues the judge finds oversized. */
type Board = { c: Ctx144; sourceId: string; oversized: Set<string> };
/** A board status the factory set, with the state whose mirroring set it. */
type SetStatus = { sourceId: string; id: string; status: string; state: ItemState | "?" };

type Ctx = {
  host: Host;
  boards: Board[];
  sets: SetStatus[];
  off: (() => void)[];
  /** The state the transition being mirrored moved to, so each setStatus knows what it mirrors. */
  mirroring: ItemState | "?";
  server?: Server;
  close?: () => Promise<void>;
  origin?: string;
  heads: number;
  /** How many statuses the factory had set when the owner moved the parent's board status, once the owner has. */
  ownerMovedAt?: number;
};

function ctx(world: object): Ctx {
  const w = world as { pbi227?: Ctx };
  w.pbi227 ??= { host: fakeRepoHost(), boards: [], sets: [], off: [], mirroring: "?", heads: 0 };
  return w.pbi227;
}

const pool = () => need().pool;
const main = (world: object): Board => {
  const k = ctx(world);
  assert.ok(k.boards[0], "the factory's database wasn't set up");
  return k.boards[0];
};

async function newSource(fieldMap: object): Promise<string> {
  return (await pool().query<{ id: string }>(
    "insert into backlog_source (adapter, url, field_map) values ('fake', 'pbi-227:' || gen_random_uuid(), $1) returning id",
    [JSON.stringify(fieldMap)],
  )).rows[0].id;
}

Before({ tags: "@pbi-227 and @db", ...long }, async function () {
  const d = await testDb();
  assert.ok(d, "src/store/test-db.ts doesn't exist");
  await d.pool.query('truncate item, event, backlog_source, repo, "user", override cascade');
  const k = ctx(this);
  const c = ctx144(this);
  k.boards.push({ c, sourceId: await newSource({ optInLabel: "factory", statusFor: {} }), oversized: new Set() });
  // A board's adapter for mirroring logs each status the factory sets, then sets it on the fake issue.
  const backlogFor = (sourceId: string): BacklogAdapter => {
    const b = k.boards.find((x) => x.sourceId === sourceId);
    assert.ok(b, `no board ${sourceId}`);
    const a = b.c.fake.adapter;
    return {
      ...a,
      async setStatus(id: string, status: string) {
        k.sets.push({ sourceId, id, status, state: k.mirroring });
        return a.setStatus(id, status);
      },
    };
  };
  // Registered before mirroring, so it runs first for each transition and tags the setStatus calls that follow.
  k.off.push(onTransition(async (_id, _from, to) => {
    k.mirroring = to;
  }, d.pool));
  k.off.push(mirrorBoard({ pool: d.pool, backlogFor, repoHost: k.host }));
  const world = this;
  c.driver = async () => {
    await realPoll(world, main(world));
    countPass(world);
  };
});

After({ tags: "@pbi-227", ...long }, async function () {
  // This feature's own server, and PBI 131's when its "a viewer opens Floor" opened one, since PBI 131's After only
  // runs for its own scenarios.
  const w = this as { pbi227?: Ctx; pbi131?: { server?: Server; close?: () => Promise<void> } };
  for (const off of w.pbi227?.off ?? []) off();
  for (const s of [w.pbi227, w.pbi131]) {
    if (!s) continue;
    await s.close?.();
    if (s.server) {
      s.server.closeAllConnections();
      await new Promise<void>((resolve) => s.server!.close(() => resolve()));
    }
  }
});

// ---- the repos and the real poller ----

async function knowRepo(k: Ctx, repo: string): Promise<void> {
  if (!repo || k.host.heads.has(repo)) return;
  const sha = `c${++k.heads}`;
  for (const [path, text] of Object.entries(baseFiles)) k.host.files.set(`${repo}@${sha}:${path}`, text);
  k.host.heads.set(repo, sha);
  await pool().query("insert into repo (host_adapter, url) values ('fake', $1) on conflict (url) do nothing", [`https://github.com/${repo}`]);
}

/** One pass of the real poller over one board, filing splits on that board with its scripted repo writes. */
async function realPoll(world: object, b: Board): Promise<void> {
  const k = ctx(world);
  const c = b.c;
  await knowRepo(k, c.repo);
  const adapter = {
    ...c.fake.adapter,
    async comment(id: string, body: string, key: string) {
      if (id === c.parentId && !body.startsWith(SPLIT_HEADING)) refuse(c, "comment", "parent");
      return c.fake.adapter.comment(id, body, key);
    },
  };
  const judge = async (item: FactoryItem, dor: Policy) => [
    ...dor.criteria.map((cr) => JSON.stringify({ index: cr.index, status: "passed", reason: "ok" })),
    JSON.stringify({ flags: [], oversized: (c.oversized && item.externalId === c.parentId) || b.oversized.has(item.externalId) }),
  ].join("\n");
  const out = await pollOnce({
    pool: pool(), adapter, repoHost: k.host, judge, sourceId: b.sourceId,
    split: {
      sop: { models: { coding: "coding-model" } }, agent: agent(c), seen: c.seen,
      file: { board: scriptedBoard(c), optInLabel: c.label, backlogStatus: c.backlogStatus, criteriaHeading: HEADING },
    },
  });
  assert.ok(out && typeof out.seen === "number", "pollOnce returned no result for the source");
}

async function stateOf(sourceId: string, externalId: string): Promise<ItemState | null> {
  const r = await pool().query<{ state: ItemState }>("select state from item where source_id = $1 and external_id = $2", [sourceId, externalId]);
  return r.rows[0]?.state ?? null;
}

async function itemId(sourceId: string, externalId: string): Promise<string> {
  const r = await pool().query<{ id: string }>("select id from item where source_id = $1 and external_id = $2", [sourceId, externalId]);
  assert.ok(r.rows[0], `the factory doesn't hold #${externalId}`);
  return r.rows[0].id;
}

/** Polls every board until each of `parents` is Split, five polls at most. */
async function pollUntilSplit(world: object, parents: { b: Board; id: string }[]): Promise<void> {
  const k = ctx(world);
  for (let i = 0; i < 5; i++) {
    for (const b of k.boards) {
      if (b === k.boards[0]) await poll(b.c);
      else await realPoll(world, b);
    }
    const states = await Promise.all(parents.map((p) => stateOf(p.b.sourceId, p.id)));
    if (states.every((s) => s === "Split")) return;
  }
  const states = await Promise.all(parents.map(async (p) => `#${p.id}: ${await stateOf(p.b.sourceId, p.id)}`));
  assert.fail(`after five polls not every parent is Split: ${states.join(", ")}`);
}

const mainParent = (world: object) => {
  const b = main(world);
  assert.ok(b.c.parentId, "the parent issue wasn't seeded");
  return { b, id: b.c.parentId };
};

/** A parent body with `criteria` under the heading, and a split of it into `titles`, one criterion each. */
function splitOf(parentTitle: string, titles: string[]): { body: string; criteria: string[]; reply: string } {
  const criteria = titles.map((t) => `${t} works for a shopper`);
  const body = `${parentTitle}, in parts.\n\n## ${HEADING}\n\n${criteria.map((t) => `- ${t}`).join("\n")}\n`;
  const reply = JSON.stringify({
    children: titles.map((title, i) => ({ title, body: `${title} for ${parentTitle}`, criteria: [i + 1], needs: i === 0 ? [] : [i] })),
  });
  return { body, criteria, reply };
}

const issueNo = (s: string) => {
  const m = /^#(\d+)$/.exec(s);
  assert.ok(m, `"${s}" isn't an issue number`);
  return m[1];
};

const named = (s: string) => {
  const m = /^#(\d+) (.+)$/.exec(s);
  assert.ok(m, `"${s}" isn't "#N Title"`);
  return { n: m[1], title: m[2] };
};

// ---- the Background ----

Given("the repo files those children as issues {string}, {string} and {string}, in that order", function (a: string, b: string, d: string) {
  ctx144(this).ids = [a, b, d].map(issueNo);
});

Given("the coding model instead proposes a split whose first child is titled {string}", function (title: string) {
  const c = ctx144(this);
  const reply = JSON.parse(c.reply) as { children: { title: string; body: string }[] };
  reply.children[0].title = title;
  reply.children[0].body = `${title} for ${c.parentTitle}`;
  c.reply = JSON.stringify(reply);
});

// ---- the field maps and the boards ----

Given("the board's field map names the status {string} for Split", long, async function (status: string) {
  await pool().query("update backlog_source set field_map = $2 where id = $1", [main(this).sourceId, JSON.stringify({ optInLabel: "factory", statusFor: { Split: status } })]);
});

async function secondBoard(world: object, repo: string, status: string, statusFor: Record<string, string | null>): Promise<void> {
  const k = ctx(world);
  const c = ctx144({});
  c.repo = repo;
  c.backlogStatus = status;
  c.label = "factory";
  k.boards.push({ c, sourceId: await newSource({ optInLabel: "factory", statusFor }), oversized: new Set() });
}

Given("a second repo {string} on a board of its own whose backlog status is {string} and whose field map has no entry for Split", long, async function (repo: string, status: string) {
  await secondBoard(this, repo, status, { Eligible: status, NotReady: status });
});

Given("a second repo {string} on a board of its own whose backlog status is {string} and whose field map names no status for Split, leaving it null", long, async function (repo: string, status: string) {
  await secondBoard(this, repo, status, { Eligible: status, NotReady: status, Split: null });
});

Given("a parent issue {string} in {string} on that board, carrying the label {string}, that the readiness judge finds oversized and the coding model splits in two", long, async function (name: string, repo: string, label: string) {
  const k = ctx(this);
  const b = k.boards.at(-1)!;
  assert.ok(b !== k.boards[0] && b.c.repo === repo, `no board of its own for ${repo}`);
  const { n, title } = named(name);
  const s = splitOf(title, ["Invoice layout", "Invoice delivery"]);
  b.c.parentId = await b.c.fake.seed({ externalId: n, title, body: s.body, acceptanceCriteria: s.criteria, labels: [label], repo, status: b.c.backlogStatus });
  b.c.parentTitle = title;
  b.c.criteria = s.criteria;
  b.c.board.set(n, b.c.backlogStatus);
  b.c.reply = s.reply;
  b.oversized.add(n);
});

Given("a second parent issue {string} in {string}, carrying the label {string}, that the factory has split into {string} and {string}", long, async function (name: string, repo: string, label: string, a: string, d: string) {
  const b = main(this);
  const { n, title } = named(name);
  const kids = [named(a), named(d)];
  const s = splitOf(title, kids.map((x) => x.title));
  await b.c.fake.seed({ externalId: n, title, body: s.body, acceptanceCriteria: s.criteria, labels: [label], repo, status: b.c.backlogStatus });
  b.c.board.set(n, b.c.backlogStatus);
  b.c.reply = s.reply;
  b.c.ids = kids.map((x) => x.n);
  b.oversized.add(n);
  await pollUntilSplit(this, [{ b, id: n }]);
});

// ---- polling ----

When("the factory polls the backlog until the parent issue is Split", long, async function () {
  await pollUntilSplit(this, [mainParent(this)]);
});

Given("the factory has polled the backlog until the parent issue is Split", long, async function () {
  await pollUntilSplit(this, [mainParent(this)]);
});

When("the factory polls the backlog until both parent issues are Split", long, async function () {
  const k = ctx(this);
  const second = k.boards[1];
  assert.ok(second?.c.parentId, "there's no second parent issue");
  await pollUntilSplit(this, [mainParent(this), { b: second, id: second.c.parentId }]);
});

Given("the owner has moved the parent issue's board status to {string}", async function (status: string) {
  const c = main(this).c;
  ctx(this).ownerMovedAt = ctx(this).sets.length;
  await c.fake.adapter.setStatus(c.parentId!, status);
  c.board.set(c.parentId!, status);
});

// ---- the children in the factory ----

async function holdChildIn(world: object, n: string, state: ItemState): Promise<void> {
  const b = main(world);
  const sourceId = b.sourceId;
  if ((await stateOf(sourceId, n)) === null) await poll(b.c);
  const id = await itemId(sourceId, n);
  if ((await stateOf(sourceId, n)) !== state) {
    await withTx(pool(), (c) => overrideItem(c, id, state, { actor: "human", actorId: "pbi-227-owner" }, `the scenario holds #${n} in ${state}`));
  }
  assert.equal(await stateOf(sourceId, n), state, `the factory holds #${n} in another state`);
}

Given("the owner has put the label {string} on child {string} and the factory holds it in state {string}", long, async function (label: string, child: string, state: string) {
  const c = main(this).c;
  const n = issueNo(child);
  assert.ok(await c.fake.adapter.getItem(n), `child ${child} was never filed`);
  await replaceItem(c, n, (fi) => ({ labels: fi.labels.includes(label) ? fi.labels : [...fi.labels, label] }));
  await holdChildIn(this, n, state as ItemState);
});

When("child {string} moves to {string}", long, async function (child: string, state: string) {
  await holdChildIn(this, issueNo(child), state as ItemState);
});

// ---- the board ----

async function boardStatus(c: Ctx144, id: string): Promise<string> {
  const fi = await c.fake.adapter.getItem(id);
  assert.ok(fi, `no issue #${id} on the board`);
  return fi.status;
}

function parentNamed(world: object, name: string): Board {
  const { n, title } = named(name);
  const b = ctx(world).boards.find((x) => x.c.parentId === n && x.c.parentTitle === title);
  assert.ok(b, `no parent issue ${name}`);
  return b;
}

const setsOf = (k: Ctx, b: Board, id: string) => k.sets.filter((s) => s.sourceId === b.sourceId && s.id === id);
const showSets = (ss: SetStatus[]) => ss.map((s) => `"${s.status}" for ${s.state}`).join(", ") || "none";

Then("the parent issue's board status is {string}", long, async function (status: string) {
  const k = ctx(this);
  const b = main(this);
  const all = setsOf(k, b, b.c.parentId!);
  assert.equal(await boardStatus(b.c, b.c.parentId!), status, `statuses the factory set: ${showSets(all)}`);
  // After the owner moved it, the status stands only because the factory set the Split status once, before that move,
  // and never again: the scenario's "set once, not again on every later poll".
  if (k.ownerMovedAt !== undefined) {
    const before = setsOf({ ...k, sets: k.sets.slice(0, k.ownerMovedAt) }, b, b.c.parentId!).filter((s) => s.state === "Split");
    const after = setsOf({ ...k, sets: k.sets.slice(k.ownerMovedAt) }, b, b.c.parentId!);
    assert.equal(before.length, 1, `the factory didn't set the parent's Split status once before the owner moved it; statuses it set: ${showSets(all)}`);
    assert.deepEqual(after, [], `the factory set the parent's status again after the owner moved it: ${showSets(after)}`);
  }
});

Then("the parent issue's board status was never set to {string}", function (status: string) {
  const b = main(this);
  const all = setsOf(ctx(this), b, b.c.parentId!);
  assert.deepEqual(all.filter((s) => s.status === status), [], `statuses the factory set: ${showSets(all)}`);
});

Then("children {string}, {string} and {string} each have board status {string}", long, async function (a: string, d: string, e: string, status: string) {
  const c = main(this).c;
  for (const child of [a, d, e]) assert.equal(await boardStatus(c, issueNo(child)), status, `child ${child}`);
});

Then("the parent issue {string} has board status {string}", long, async function (name: string, status: string) {
  const b = parentNamed(this, name);
  assert.equal(await boardStatus(b.c, b.c.parentId!), status, `statuses the factory set: ${showSets(setsOf(ctx(this), b, b.c.parentId!))}`);
});

Then("the parent issue {string} still has board status {string}", long, async function (name: string, status: string) {
  const b = parentNamed(this, name);
  assert.equal(await boardStatus(b.c, b.c.parentId!), status, `statuses the factory set: ${showSets(setsOf(ctx(this), b, b.c.parentId!))}`);
});

Then("the factory never set the board status of {string} when it moved to Split", function (name: string) {
  const b = parentNamed(this, name);
  const all = setsOf(ctx(this), b, b.c.parentId!);
  assert.deepEqual(all.filter((s) => s.state === "Split"), [], `statuses the factory set: ${showSets(all)}`);
});

// ---- opening the pages ----

async function open(world: object, path: string): Promise<void> {
  const k = ctx(world);
  const b = main(world);
  await pool().query(`insert into "user" (provider, subject, github_login, role) values ('microsoft', 'viewer', 'viewer', 'viewer') on conflict (provider, subject) do nothing`);
  if (!k.server) {
    let handler: ReturnType<typeof dashboardRoutes> | undefined;
    k.server = await startServer([(req, res) => handler!(req, res)], { port: 0 });
    k.origin = `http://127.0.0.1:${(k.server.address() as AddressInfo).port}`;
    handler = dashboardRoutes({ pool: pool(), auth: createAuth({ mode: "azure" }), origin: k.origin, adapter: b.c.fake.adapter, sourceId: b.sourceId });
    k.close = handler.close;
  }
  const login = "viewer";
  const r = await fetch(`${k.origin}${path}`, {
    headers: { "x-ms-client-principal-idp": "aad", "x-ms-client-principal-id": login, "x-ms-client-principal-name": login }, redirect: "manual",
  });
  const text = await r.text();
  // PBI 131's page() and PBI 145's "the page doesn't show" read the page from here.
  recordResponse(world, r.status, text);
}

const parentDetail = async (world: object) => open(world, `/items/${await itemId(main(world).sourceId, main(world).c.parentId!)}`);

When("a viewer opens the parent's Run detail", long, async function () {
  await parentDetail(this);
});

When("a viewer opens the parent's Run detail again", long, async function () {
  await parentDetail(this);
});

// The viewer has the page open before the child moves. What it showed then isn't checked here: the Thens that follow
// check what it shows after, so the scenario fails on them, not on this setup, while no "Split into" shows.
Given("a viewer has seen child {string} show the state {string} on the parent's Run detail", long, async function (_child: string, _state: string) {
  await parentDetail(this);
});

When("a viewer opens the Run detail of child {string}", long, async function (child: string) {
  const { n } = named(child);
  await open(this, `/items/${await itemId(main(this).sourceId, n)}`);
});

// ---- reading the pages ----

/** The <main> of the last page opened, here or by PBI 131's "a viewer opens Floor". */
function pageHtml(world: object): string {
  return scope(page(world), "the page");
}

/** The index in `html` of the text `text` outside any tag, at or after `from`, or -1. */
function textAt(html: string, text: string, from = 0): number {
  for (let at = html.indexOf(text, from); at >= 0; at = html.indexOf(text, at + 1)) {
    const open = html.lastIndexOf("<", at);
    if (open < html.lastIndexOf(">", at) || open === -1) return at;
  }
  return -1;
}

type Child = { html: string; text: string; links: { href: string; text: string }[] };

type List = { kids: Child[]; start: number; end: number };

/** The first <ol> or <ul> at or after `from`: its top-level <li>s, and where it starts and ends in `html`. */
function list(html: string, from: number): List | null {
  const tags = /<(\/?)(ol|ul|li)\b[^>]*>/gi;
  tags.lastIndex = from;
  let depth = 0;
  let start = -1;
  let item = -1;
  const items: string[] = [];
  for (let m = tags.exec(html); m; m = tags.exec(html)) {
    const close = m[1] === "/";
    const tag = m[2].toLowerCase();
    if (tag === "ol" || tag === "ul") {
      if (close) depth--;
      else if (depth++ === 0) start = m.index;
      if (close && depth === 0) {
        if (item >= 0) items.push(html.slice(item, m.index));
        const kids = items.map((h) => {
          const r = render(h);
          return { html: h, text: r.text.replace(/\s+/g, " ").trim(), links: r.links };
        });
        return { kids, start, end: m.index + m[0].length };
      }
    } else if (depth === 1) {
      if (item >= 0) items.push(html.slice(item, m.index));
      item = close ? -1 : m.index + m[0].length;
    }
  }
  return null;
}

const listAfter = (html: string, from: number) => list(html, from)?.kids ?? null;

/** Run detail's children: the first list after the text "Split into". */
function detailChildren(world: object): Child[] {
  const html = pageHtml(world);
  const at = textAt(html, SPLIT_INTO);
  assert.ok(at >= 0, `the page doesn't show "${SPLIT_INTO}"`);
  const kids = listAfter(html, at);
  assert.ok(kids, `the page shows "${SPLIT_INTO}" with no list of children`);
  return kids;
}

const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Floor's children of a parent: the first list after the text "Split into" that follows the parent's title. */
function floorChildren(world: object, parent: string): Child[] {
  const html = pageHtml(world);
  const { title } = named(parent);
  const p = textAt(html, escapeText(title));
  assert.ok(p >= 0, `Floor doesn't show ${parent}`);
  const at = textAt(html, SPLIT_INTO, p);
  assert.ok(at >= 0, `Floor doesn't show ${parent} as "${SPLIT_INTO}"`);
  const kids = listAfter(html, at);
  assert.ok(kids, `Floor shows "${SPLIT_INTO}" after ${parent} with no list of children`);
  return kids;
}

const show = (kids: Child[]) => kids.map((k) => `[${k.text}]`).join(" ") || "none";

function childIn(kids: Child[], child: string): Child {
  const found = kids.filter((k) => k.text.includes(child));
  assert.equal(found.length, 1, `children shown: ${show(kids)}`);
  return found[0];
}

const hasWord = (text: string, word: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "u").test(text);

function linksTo(kid: Child, child: string, url: string): boolean {
  const { n, title } = named(child);
  return kid.links.some((l) => l.href === url && (l.text.includes(`#${n}`) || l.text.includes(title)));
}

function inOrder(kids: Child[], table: DataTable): void {
  const rows = table.hashes();
  assert.equal(kids.length, rows.length, `children shown: ${show(kids)}`);
  rows.forEach((r, i) => {
    assert.ok(kids[i].text.includes(r.child), `child ${i + 1} isn't ${r.child}: ${show(kids)}`);
    assert.ok(linksTo(kids[i], r.child, r.link), `${r.child} doesn't link to ${r.link}: ${JSON.stringify(kids[i].links)}`);
  });
}

Then("the page shows {string} with these children, in order:", function (_label: string, table: DataTable) {
  inOrder(detailChildren(this), table);
});

Then("the page shows {string} with {int} children", function (_label: string, n: number) {
  const kids = detailChildren(this);
  assert.equal(kids.length, n, `children shown: ${show(kids)}`);
});

Then("under {string}, child {string} shows the state {string}", function (_label: string, child: string, state: string) {
  const kid = childIn(detailChildren(this), child);
  assert.ok(hasWord(kid.text.replace(child, ""), state), `child ${child} doesn't show "${state}": ${kid.text}`);
});

Then("under {string}, child {string} doesn't show the state {string}", function (_label: string, child: string, state: string) {
  const kid = childIn(detailChildren(this), child);
  assert.ok(!hasWord(kid.text.replace(child, ""), state), `child ${child} shows "${state}": ${kid.text}`);
});

Then("under {string}, child {string} shows {string}", function (_label: string, child: string, text: string) {
  const kid = childIn(detailChildren(this), child);
  assert.ok(kid.text.replace(child, "").includes(text), `child ${child} doesn't show "${text}": ${kid.text}`);
});

Then("the line with the item's state shows {string}", function (state: string) {
  const html = pageHtml(this);
  const line = /<\/h1>\s*<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(html);
  assert.ok(line, "Run detail has no line under its heading");
  assert.ok(hasWord(render(line[1]).text, state), `the state line reads: ${render(line[1]).text.trim()}`);
});

Then("Floor shows {string} as {string} these children, in order:", function (parent: string, _label: string, table: DataTable) {
  inOrder(floorChildren(this, parent), table);
});

Then("under {string} on Floor, child {string} shows the state {string}", function (parent: string, child: string, state: string) {
  const kid = childIn(floorChildren(this, parent), child);
  assert.ok(hasWord(kid.text.replace(child, ""), state), `child ${child} doesn't show "${state}": ${kid.text}`);
});

Then("under {string} on Floor, child {string} shows {string}", function (parent: string, child: string, text: string) {
  const kid = childIn(floorChildren(this, parent), child);
  assert.ok(kid.text.replace(child, "").includes(text), `child ${child} doesn't show "${text}": ${kid.text}`);
});

function onlyChildren(world: object, parent: string, ns: string[]): void {
  const kids = floorChildren(world, parent);
  assert.equal(kids.length, ns.length, `children shown under ${parent}: ${show(kids)}`);
  ns.forEach((n, i) => assert.ok(new RegExp(`${n}(?!\\d)`).test(kids[i].text), `child ${i + 1} under ${parent} isn't ${n}: ${show(kids)}`));
}

Then("Floor shows {string} as {string} {string}, {string} and {string}, and nothing else", function (parent: string, _label: string, a: string, b: string, d: string) {
  onlyChildren(this, parent, [a, b, d]);
});

Then("Floor shows {string} as {string} {string} and {string}, and nothing else", function (parent: string, _label: string, a: string, b: string) {
  onlyChildren(this, parent, [a, b]);
});

Then("{string} under {string} links to {string}", function (child: string, parent: string, url: string) {
  const kid = childIn(floorChildren(this, parent), child);
  assert.ok(linksTo(kid, child, url), `${child} doesn't link to ${url}: ${JSON.stringify(kid.links)}`);
});

/** Floor's text and links outside every "Split into" list, so a parent's own links aren't read from a child's. */
function floorOutsideSplits(world: object): ReturnType<typeof render> {
  let html = pageHtml(world);
  for (let at = textAt(html, SPLIT_INTO); at >= 0; at = textAt(html, SPLIT_INTO, at)) {
    const l = list(html, at);
    if (!l) break;
    html = html.slice(0, at) + html.slice(l.end);
  }
  return render(html);
}

Then("{string} on Floor still links to {string}", function (ref: string, url: string) {
  const r = floorOutsideSplits(this);
  assert.ok(r.links.some((l) => l.href === url && l.text.includes(ref)), `no "${ref}" on Floor links to ${url}: ${JSON.stringify(r.links)}`);
});

Then("{string} on Floor still links to the parent's Run detail", long, async function (title: string) {
  const b = main(this);
  const url = `/items/${await itemId(b.sourceId, b.c.parentId!)}`;
  const r = floorOutsideSplits(this);
  assert.ok(r.links.some((l) => l.href === url && l.text.includes(title)), `no "${title}" on Floor links to ${url}: ${JSON.stringify(r.links)}`);
});

Then("Floor shows the child {string} under {string} as written", function (child: string, _label: string) {
  const c = main(this).c;
  childIn(floorChildren(this, `#${c.parentId} ${c.parentTitle}`), child);
});

Then("the page shows the child {string} under {string} as written", function (child: string, _label: string) {
  childIn(detailChildren(this), child);
});

Then("the page has no bold element from the child's title", function () {
  assert.ok(!/<b\b[^>]*>\s*payments\s*<\/b>/i.test(pageHtml(this)), "the child's title shows as markup");
});
