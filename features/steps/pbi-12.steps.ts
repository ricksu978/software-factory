import { Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type pg from "pg";
import type { fakeBacklog, fakeRepoHost } from "../../src/adapters/fake.ts";
import type { BacklogAdapter, FactoryItem, RepoHost } from "../../src/adapters/types.ts";
import { load, long, need, testDb } from "./pbi-8.steps.ts";

// Shares PBI 4's database. Each scenario starts with empty item, source, repo and user tables, a fake board, a fake
// repo host holding one repo with valid readiness files, and a judge whose answer the steps set. The poller loads
// lazily, so while it doesn't exist every scenario fails on its first Then, which checks that a poll ran. PBI 142's
// steps reuse this harness through the exports.
export const REPO = "octo/repo";
export { baseFiles };

type Fake = ReturnType<typeof fakeBacklog>;
type Host = ReturnType<typeof fakeRepoHost>;
type Judge = (item: FactoryItem, dor: { criteria: { index: number }[] }) => Promise<string>;
export type Logic = { judgePrompt: string; version: number };
type Poller = {
  pollOnce?: (deps: { pool: pg.Pool; adapter: BacklogAdapter; repoHost: RepoHost; judge: Judge; sourceId: string; logic?: Logic }) => Promise<unknown>;
};
export type Ctx = {
  fake?: Fake;
  host?: Host;
  sourceId?: string;
  extIds: string[];
  pr?: number;
  judge: "pass" | "fail" | "throw";
  /** PBI 149: a judge that fails only this line, with this reason. Only read while `judge` is "fail". */
  failLine?: { index: number; reason: string };
  /** PBI 149: how often the judge was asked about each item, by external id. */
  asked: Map<string, number>;
  /** PBI 149: the readiness logic the factory runs with. Unset, the poller uses its own. */
  logic?: Logic;
  polls: number;
  error?: unknown;
};

export function ctx(world: object): Ctx {
  const w = world as { pbi12?: Ctx };
  w.pbi12 ??= { extIds: [], judge: "pass", asked: new Map(), polls: 0 };
  return w.pbi12;
}

const judge = (c: Ctx): Judge => async (item, dor) => {
  c.asked.set(item.externalId, (c.asked.get(item.externalId) ?? 0) + 1);
  if (c.judge === "throw") throw new Error("usage limit reached");
  const line = (index: number) => {
    const failed = c.judge === "fail" && (!c.failLine || c.failLine.index === index);
    const reason = failed ? (c.failLine?.reason ?? "failed") : "passed";
    return JSON.stringify({ index, status: failed ? "failed" : "passed", reason });
  };
  return [...dor.criteria.map((cr) => line(cr.index)), JSON.stringify({ flags: [] })].join("\n");
};

const baseFiles: Record<string, string> = {
  ".factory/config.yml": "bdd:\n  parse: npm run bdd -- --dry-run\n  run: npm run bdd\n  report: reports/bdd.ndjson\ncommands:\n  test: npm test\n  lint: npm run lint\n",
  ".factory/dod.md": "- [ ] Tests pass\n",
  ".factory/dor.md": "- [ ] Has a title\n",
};

function commit(host: Host, sha: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) host.files.set(`${REPO}@${sha}:${path}`, text);
  host.heads.set(REPO, sha);
}

/** A fake board and repo host, one source row and one known repo. Null while the fake adapter doesn't exist. */
export async function setup(c: Ctx): Promise<boolean> {
  if (c.fake) return true;
  const mod = await load<{ fakeBacklog: () => Fake; fakeRepoHost: () => Host }>("src/adapters/fake.ts");
  const d = await testDb();
  if (!mod || !d) return false;
  c.fake = mod.fakeBacklog();
  c.host = mod.fakeRepoHost();
  commit(c.host, "c1", baseFiles);
  c.sourceId = (await d.pool.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'test:' || gen_random_uuid()) returning id")).rows[0].id;
  await d.pool.query("insert into repo (host_adapter, url) values ('fake', $1)", [`https://github.com/${REPO}`]);
  return true;
}

export async function poll(c: Ctx): Promise<void> {
  const poller = await load<Poller>("src/watcher/poller.ts");
  if (!poller?.pollOnce || !c.fake || !c.host || !c.sourceId) return;
  try {
    await poller.pollOnce({ pool: need().pool, adapter: c.fake.adapter, repoHost: c.host, judge: judge(c), sourceId: c.sourceId, ...(c.logic ? { logic: c.logic } : {}) });
    c.polls++;
  } catch (e) {
    c.error = e;
  }
}

export function polled(c: Ctx): void {
  assert.equal(c.error, undefined, `the poll failed: ${String(c.error)}`);
  assert.ok(c.polls > 0, "the poller didn't run");
}

export async function stateOf(c: Ctx, extId: string): Promise<string | undefined> {
  const r = await need().pool.query<{ state: string }>("select state from item where source_id = $1 and external_id = $2", [c.sourceId, extId]);
  return r.rows[0]?.state;
}

function pr(c: Ctx) {
  const found = c.host?.prs.find((p) => p.number === c.pr);
  assert.ok(found, "the item has no PR");
  return found;
}

Before({ tags: "@pbi-12", ...long }, async function () {
  const d = await testDb();
  if (d) await d.pool.query('truncate item, backlog_source, repo, "user" cascade');
});

Given("a board item labelled {string} that the factory has never seen", long, async function (label: string) {
  const c = ctx(this);
  if (await setup(c)) c.extIds = [await c.fake!.seed({ labels: [label], repo: REPO })];
});

Given("a board item with no {string} label", long, async function (_label: string) {
  const c = ctx(this);
  if (await setup(c)) c.extIds = [await c.fake!.seed({ labels: [], repo: REPO })];
});

Given("the readiness judge is unavailable", function () {
  ctx(this).judge = "throw";
});

Given("the readiness judge now passes every line", function () {
  ctx(this).judge = "pass";
});

Given("the factory holds an item in state {string} with an open PR", long, async function (state: string) {
  const c = ctx(this);
  if (!(await setup(c))) return;
  const ext = await c.fake!.seed({ labels: ["factory"], repo: REPO });
  c.extIds = [ext];
  const branch = `factory/pbi-${ext}-r1`;
  c.pr = (await c.host!.openOrUpdatePr({ repo: REPO, branch, base: "main", title: "t", body: "b" })).number;
  const pool = need().pool;
  const item = await pool.query<{ id: string }>(
    `insert into item (source_id, external_id, title, state, lease_generation, lease_owner, lease_expires)
     values ($1, $2, 'test item', $3, 1, case when $3 = 'InProgress' then 'cell-a' end, case when $3 = 'InProgress' then now() + interval '5 minutes' end)
     returning id`,
    [c.sourceId, ext, state],
  );
  await pool.query(
    `insert into run (item_id, run_number, next_stage, branch, pr_number, pr_url, reviews_seen_at)
     values ($1, 1, 'open-pr', $2, $3, $4, now() - interval '1 hour')`,
    [item.rows[0].id, branch, c.pr, `https://github.com/${REPO}/pull/${c.pr}`],
  );
});

Given("the factory holds two items in state {string}, checked against the repo's current readiness files", long, async function (state: string) {
  const c = ctx(this);
  if (!(await setup(c))) return;
  c.extIds = [await c.fake!.seed({ labels: ["factory"], repo: REPO }), await c.fake!.seed({ labels: ["factory"], repo: REPO })];
  // A failing judge gates both into NotReady, which records the readiness files they were checked against.
  c.judge = "fail";
  await poll(c);
  if (c.polls > 0) for (const ext of c.extIds) assert.equal(await stateOf(c, ext), state, "setup didn't reach the expected state");
});

When("the poller runs once", long, async function () {
  await poll(ctx(this));
});

When("a person removes the item's {string} label on the board", async function (label: string) {
  const c = ctx(this);
  if (!c.fake) return;
  const item = await c.fake.adapter.getItem(c.extIds[0]);
  if (item) await c.fake.seed({ ...item, labels: item.labels.filter((l) => l !== label) });
});

When("a person closes the item on the board", async function () {
  const c = ctx(this);
  if (c.fake) await c.fake.adapter.close(c.extIds[0]);
});

When("{string} changes on the repo's default branch", function (path: string) {
  const c = ctx(this);
  if (!c.host) return;
  const files: Record<string, string> = {};
  for (const [key, text] of c.host.files) if (key.startsWith(`${REPO}@c1:`)) files[key.slice(`${REPO}@c1:`.length)] = text;
  const additions: Record<string, string> = {
    ".factory/scenarios.md": "Keep each scenario short.\n",
    ".factory/pr-review.md": "- [ ] The change is correct.\n",
    ".factory/risk.md": "Low means docs only.\n",
  };
  files[path] = path in files ? `${files[path]}${path.endsWith(".yml") ? "# edited\n" : "\nEdited by the team.\n"}` : additions[path];
  commit(c.host, "c2", files);
});

When("a person closes the item's PR without merging it", function () {
  const c = ctx(this);
  if (c.host && c.pr) pr(c).open = false;
});

When("a person merges the item's PR", function () {
  const c = ctx(this);
  if (!c.host || !c.pr) return;
  Object.assign(pr(c), { open: false, merged: true, mergeSha: "m1" });
});

When("{string}, who maps to no allowlisted user, requests changes on the item's PR", function (login: string) {
  const c = ctx(this);
  if (c.host && c.pr) pr(c).reviews.push({ state: "changes_requested", submittedAt: new Date().toISOString(), author: login });
});

When("{string}, an allowlisted user, requests changes on the item's PR", long, async function (login: string) {
  const c = ctx(this);
  if (!c.host || !c.pr) return;
  await need().pool.query(`insert into "user" (provider, subject, role, github_login) values ('dev', $1, 'owner', $1)`, [login]);
  pr(c).reviews.push({ state: "changes_requested", submittedAt: new Date().toISOString(), author: login });
});

Then("the factory holds the item in state {string}", long, async function (state: string) {
  const c = ctx(this);
  polled(c);
  assert.equal(await stateOf(c, c.extIds[0]), state);
});

Then("the factory doesn't hold the item", long, async function () {
  const c = ctx(this);
  polled(c);
  assert.equal(await stateOf(c, c.extIds[0]), undefined);
});

Then("the board item has no comment", async function () {
  const c = ctx(this);
  polled(c);
  assert.deepEqual(await c.fake!.comments(c.extIds[0]), []);
});

Then("the item's PR is closed", function () {
  const c = ctx(this);
  polled(c);
  assert.equal(pr(c).open, false);
});

Then("both items are in state {string}", long, async function (state: string) {
  const c = ctx(this);
  polled(c);
  assert.equal(c.extIds.length, 2);
  for (const ext of c.extIds) assert.equal(await stateOf(c, ext), state, `item ${ext}`);
});

Then("the item's run resumes from {string}", long, async function (stage: string) {
  const c = ctx(this);
  polled(c);
  const r = await need().pool.query(
    "select r.next_stage from run r join item i on i.id = r.item_id where i.source_id = $1 and i.external_id = $2 and r.ended_at is null",
    [c.sourceId, c.extIds[0]],
  );
  assert.deepEqual(r.rows, [{ next_stage: stage }]);
});
