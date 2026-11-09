// Step definitions for features/pbi-137-item-repo-at-intake.feature. They join two harnesses: PBI 12's poller, with its
// fake board and repo host, and PBI 131's dashboard, which runs as the real node:http server and reads the page back.
// "When the poller runs once" is PBI 12's step, and "a viewer opens ...", "the item is <state>", "both items are
// queued" and the link Thens are PBI 131's, so every item these steps hold goes in PBI 131's context too.
//
// There's one board: PBI 12's backlog_source row, which the poller polls. "A board that maps to" sets its repo_map to
// github repo rows, as migrate-cli seeds them. "The factory serves" is the set of repo rows. An item's stored repo is
// the item's `repo` column, as owner/name. The database holds one item per number on a board row, so a second held
// item with a number already on the board goes on a twin row with the same repo_map, which reads the same to the
// dashboard.
import { After, Before, Given, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { OPT_IN_LABEL } from "../../src/adapters/contract.ts";
import { issueRepos } from "../../src/store/issues.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";
import { baseFiles, ctx as pollCtx, polled, setup, type Ctx as PollCtx } from "./pbi-12.steps.ts";
import { issueHref, ctx as pageCtx, type Item } from "./pbi-131.steps.ts";

const pool = () => need().pool;

Before({ tags: "@pbi-137 and @db", ...long }, async function () {
  const d = await testDb();
  if (d) await d.pool.query('truncate item, event, backlog_source, repo, "user", override cascade');
});

After({ tags: "@pbi-137", ...long }, async function () {
  // PBI 131's server and PBI 105's, since their own Afters only run for their own scenarios.
  const w = this as { pbi131?: { server?: Server; close?: () => Promise<void> }; pbi105?: { server?: Server; close?: () => Promise<void> } };
  for (const s of [w.pbi131, w.pbi105]) {
    if (!s) continue;
    await s.close?.();
    if (s.server) {
      s.server.closeAllConnections();
      await new Promise<void>((resolve) => s.server!.close(() => resolve()));
    }
  }
});

/** PBI 12's fake board, repo host and board row, made once per scenario. */
async function board(world: object): Promise<PollCtx> {
  const c = pollCtx(world);
  assert.ok(await setup(c), "the fake board or the test database isn't there");
  return c;
}

/** A github repo row for `fullName`, with valid readiness files on the fake host. */
async function serve(c: PollCtx, fullName: string): Promise<string> {
  for (const [path, text] of Object.entries(baseFiles)) c.host!.files.set(`${fullName}@c1:${path}`, text);
  c.host!.heads.set(fullName, "c1");
  return (await pool().query<{ id: string }>(
    "insert into repo (host_adapter, url) values ('github', $1) on conflict (url) do update set host_adapter = 'github' returning id",
    [`https://github.com/${fullName}`],
  )).rows[0].id;
}

async function mapsTo(world: object, repos: string[]): Promise<void> {
  const c = await board(world);
  const map: Record<string, string> = {};
  for (const r of repos) map[r] = await serve(c, r);
  await pool().query("update backlog_source set repo_map = $2 where id = $1", [c.sourceId, JSON.stringify(map)]);
}

Given("a board that maps to the one repo {string}", long, async function (repo: string) {
  await mapsTo(this, [repo]);
});

Given("a board that maps to the repos {string} and {string}", long, async function (a: string, b: string) {
  await mapsTo(this, [a, b]);
});

Given("the factory serves only the repo {string}", long, async function (repo: string) {
  const c = await board(this);
  await pool().query("delete from repo");
  await serve(c, repo);
});

// ---- the board's issues ----

async function list(world: object, ext: string, title: string, repo: string | null): Promise<void> {
  const c = await board(world);
  await c.fake!.seed({ externalId: ext, title, repo, labels: [OPT_IN_LABEL] });
  if (!c.extIds.includes(ext)) c.extIds.push(ext);
}

Given("the board lists a new issue {string} titled {string} from the repo {string}", long, async function (ext: string, title: string, repo: string) {
  await list(this, ext, title, repo);
});

Given("the board lists a new item {string} titled {string} that is not in any repo", long, async function (ext: string, title: string) {
  await list(this, ext, title, null);
});

Given("the board's issue {string} is in the repo {string}", long, async function (ext: string, repo: string) {
  const held = pageCtx(this).items.find((i) => i.ext === ext);
  assert.ok(held, `the factory holds no item "${ext}"`);
  await list(this, ext, held.title, repo);
});

Given("the board fails to return issue {string}", async function (ext: string) {
  const adapter = (await board(this)).fake!.adapter;
  const { getItem, listEligible } = adapter;
  adapter.getItem = async (id) => {
    if (id === ext) throw new Error(`the board failed to return issue ${ext}`);
    return getItem(id);
  };
  adapter.listEligible = async (cursor) => {
    const out = await listEligible(cursor);
    return { ...out, items: out.items.filter((i) => i.externalId !== ext) };
  };
});

// ---- the items the factory holds ----

async function hold(world: object, ext: string, title: string, repo: string | null): Promise<Item> {
  const c = await board(world);
  const page = pageCtx(world);
  let sourceId = c.sourceId!;
  if (page.items.some((i) => i.ext === ext)) {
    sourceId = (await pool().query<{ id: string }>(
      "insert into backlog_source (adapter, url, repo_map) select adapter, url || ':twin', repo_map from backlog_source where id = $1 returning id",
      [c.sourceId],
    )).rows[0].id;
  }
  const id = (await pool().query<{ id: string }>(
    "insert into item (source_id, external_id, title, state, repo) values ($1, $2, $3, 'Eligible', $4) returning id",
    [sourceId, ext, title, repo],
  )).rows[0].id;
  // No run points at a repo, so a run never decides where "#N" links.
  const it: Item = { id, ext, title, sourceId, repoId: null };
  page.items.push(it);
  return it;
}

Given("the factory holds item {string} titled {string} with the repo {string}", long, async function (ext: string, title: string, repo: string) {
  await hold(this, ext, title, repo);
});

Given("the factory holds item {string} titled {string} from that board with the repo {string}", long, async function (ext: string, title: string, repo: string) {
  await hold(this, ext, title, repo);
});

Given("the factory holds item {string} titled {string} from that board with no repo", long, async function (ext: string, title: string) {
  await hold(this, ext, title, null);
});

Given("the factory holds item {string} titled {string} with no repo, from before repos were stored", long, async function (ext: string, title: string) {
  await hold(this, ext, title, null);
});

Given("the factory holds item {string} titled {string} from that board with no repo, from before repos were stored",
  long, async function (ext: string, title: string) {
    await hold(this, ext, title, null);
  });

async function runs(items: Item[]): Promise<number> {
  return (await pool().query<{ n: number }>("select count(*)::int as n from run where item_id = any($1::uuid[])", [items.map((i) => i.id)])).rows[0].n;
}

Given("the item has no run", long, async function () {
  const items = pageCtx(this).items;
  assert.ok(items.length, "no item was set up");
  assert.equal(await runs(items.slice(-1)), 0, "the item has a run");
});

Given("neither item has a run", long, async function () {
  const items = pageCtx(this).items;
  assert.equal(items.length, 2, `expected two items, found ${items.length}`);
  assert.equal(await runs(items), 0, "an item has a run");
});

// ---- what the factory holds ----

async function heldItem(ext: string): Promise<{ id: string; repo: string | null }> {
  const rows = (await pool().query<{ id: string; repo: string | null }>("select id, repo from item where external_id = $1", [ext])).rows;
  assert.equal(rows.length, 1, `the factory holds ${rows.length} items "${ext}"`);
  return rows[0];
}

Then("the factory holds item {string} with the repo {string}", long, async function (ext: string, repo: string) {
  polled(pollCtx(this));
  assert.equal((await heldItem(ext)).repo, repo, `item "${ext}" isn't stored with the repo ${repo}`);
});

Then("the factory holds item {string} with no repo", long, async function (ext: string) {
  polled(pollCtx(this));
  const it = await heldItem(ext);
  assert.equal(it.repo, null, `item "${ext}" is stored with the repo ${it.repo}`);
  // Nor does the factory take one from the item's board: the repo it gives the item's issue is none.
  const given = (await issueRepos(pool(), [it.id])).get(it.id) ?? null;
  assert.equal(given, null, `the factory gives item "${ext}" the repo ${given}`);
});

Then("{string} in {string} links to {string}", function (n: string, section: string, url: string) {
  const held = pageCtx(this).items.find((i) => `#${i.ext}` === n);
  assert.ok(held, `the factory holds no item "${n}"`);
  assert.equal(issueHref(this, `"${section}"`, n, held.title), url, `"${n}" in "${section}" doesn't link to ${url}`);
});
