// Step definitions for features/pbi-255-red-main-bug-item.feature.
//
// The scenarios reuse PBI 12's poller harness: its fake board and repo host, and its "the poller runs once" step, with
// PBI 142's "the poller runs twice" and PBI 168's "the factory holds item <n> in state". Every poll here also runs the
// scheduler's CI check on merged items, pollMergedCi, through the harness's afterPoll, so "the poller" is everything the
// factory does on a poll and on its CI check of merged items, whichever of the two comes to do the work. The claims run
// claimNext, and the Floor is PBI 175's real dashboard, opened with PBI 215's step.
//
// The repo is "acme/widgets", known to the factory with that URL on github.com. Its main branch's commits are the fake
// repo host's `branches` entry "acme/widgets@main", oldest first, each one's first parent the one before it, in
// `parents` too. A commit's checks are its `runs`, and its overall status in `checks` follows them: failure when any
// failed, pending when any hasn't finished, success otherwise. "Every check" is test, bdd, lint and build. A check's log
// is a GitHub Actions job log of `npm test` on Node 26: each line after GitHub's timestamp, and node's spec reporter
// listing each failing test under `✖ failing tests:`, as CI prints it.
//
// A bug item is an item the factory filed on the board through fileItem, which the fake board lists in `filed`. What it
// names is read from its title and body together:
// - a commit, by its sha (each sha here is 7 characters, as the factory shortens them);
// - PR 57, as "PR 57", "PR #57" or the PR's URL;
// - item 482, as "#482" or "item 482";
// - a failed check, by a line that holds both the check's name and its URL. A check it doesn't name appears nowhere in it;
// - a failing test, by its name. It names no failing test when no line lists one: a list item (`- ` or `* `) under a
//   line that mentions "failing test", before the next blank line.
// The factory's own row for a bug item is main_break.bug_item_id, and a Given that puts one in place fills in the
// main_break row as the factory would.
//
// Floor's notice that main is red is the element with id="main-red", which says "main" and "red". It names a commit by
// its sha, and the bug item by "#" and its external id, as Floor names any item.
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { CheckRun } from "../../src/adapters/types.ts";
import { pollMergedCi } from "../../src/scheduler/scheduler.ts";
import { withTx } from "../../src/store/db.ts";
import { appendEvent } from "../../src/store/events.ts";
import { claimNext } from "../../src/store/items.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";
import { ctx as pollCtx, poll, polled, setup, type Ctx as PollCtx } from "./pbi-12.steps.ts";
import { scope } from "./pbi-131.steps.ts";
import { ctx as dashCtx, escapeRe, text } from "./pbi-175.steps.ts";

const REPO = "acme/widgets";
const REPO_URL = `https://github.com/${REPO}`;
const MAIN = "main";
const EVERY_CHECK = ["test", "bdd", "lint", "build"];
const LABEL = "factory";

type Ctx = {
  repoId?: string;
  /** Each item the scenario holds, by its number: its row's id. */
  items: Map<number, string>;
  /** The items claimed, in order: each one's row id, or null when nothing was claimed. */
  claims: (string | null)[];
  /** The bug item a Given put in place: its external id on the board and its row's id. */
  bug?: { externalId: string; itemId: string };
  nextUrl: number;
  /** PBI 369: the repo the scenario's commits and CI are on, when it isn't "acme/widgets". */
  repo?: string;
};

/** Exported for PBI 369's steps, which hold their items here so this file's "item <n> waits on" reads them. */
export function ctx(world: object): Ctx {
  const w = world as { pbi255?: Ctx };
  w.pbi255 ??= { items: new Map(), claims: [], nextUrl: 950 };
  return w.pbi255;
}

const pool = () => need().pool;

Before({ tags: "@pbi-255", ...long }, async function () {
  const d = await testDb();
  if (!d) return;
  await d.pool.query('truncate item, event, backlog_source, repo, "user", override cascade');
  await d.pool.query(
    `update wip_policy set mode = 'fixed', wip_min = 1, wip_max = 1, current_wip = 1, review_capacity = 3, usage_reserve_at = 0.7,
       usage_paused_until = null, daily_budget = null`,
  );
  const c = pollCtx(this);
  c.afterPoll = async () => {
    await pollMergedCi({ pool: pool(), repoHost: c.host!, backlogFor: () => c.fake!.adapter, now: new Date() });
  };
});

After({ tags: "@pbi-255", ...long }, async function () {
  const dc = (this as { pbi175?: { server?: Server; close?: () => Promise<void> } }).pbi175;
  await dc?.close?.();
  if (dc?.server) {
    dc.server.closeAllConnections();
    await new Promise<void>((resolve) => dc.server!.close(() => resolve()));
  }
});

// ---- the board, the repo and its main branch ----

async function harness(world: object): Promise<{ c: PollCtx; mine: Ctx }> {
  const c = pollCtx(world);
  assert.ok(await setup(c), "the poller's fakes or database aren't available");
  const mine = ctx(world);
  mine.repoId ??= (await pool().query<{ id: string }>(
    "insert into repo (host_adapter, url) values ('fake', $1) on conflict (url) do update set url = excluded.url returning id", [REPO_URL],
  )).rows[0].id;
  return { c, mine };
}

function mainCommits(c: PollCtx, repo = REPO): string[] {
  const key = `${repo}@${MAIN}`;
  const list = c.host!.branches.get(key) ?? [];
  c.host!.branches.set(key, list);
  return list;
}

/** Puts `sha` on main right after `after`, its first parent, and makes it main's head when it's the newest. */
function land(c: PollCtx, sha: string, after: string): void {
  const list = mainCommits(c);
  const at = list.indexOf(after);
  assert.ok(at >= 0, `commit "${after}" isn't on main`);
  list.splice(at + 1, 0, sha);
  c.host!.parents.set(`${REPO}@${sha}`, after);
  c.host!.heads.set(REPO, list.at(-1)!);
}

/** Puts `parent` on main right before `sha`, as its first parent. */
function parentOf(c: PollCtx, sha: string, parent: string, repo = REPO): void {
  const list = mainCommits(c, repo);
  const at = list.indexOf(sha);
  assert.ok(at >= 0, `commit "${sha}" isn't on main`);
  const old = c.host!.parents.get(`${repo}@${sha}`);
  if (old) c.host!.parents.set(`${repo}@${parent}`, old);
  list.splice(at, 0, parent);
  c.host!.parents.set(`${repo}@${sha}`, parent);
}

async function holdItem(world: object, n: number, state: string, extra: { priority?: number; rank?: number; title?: string } = {}): Promise<string> {
  const { c, mine } = await harness(world);
  const ext = String(n);
  const title = extra.title ?? `Item ${n}`;
  await c.fake!.seed({ externalId: ext, title, labels: [LABEL], repo: REPO, rank: extra.rank ?? n });
  const id = (await pool().query<{ id: string }>(
    "insert into item (source_id, external_id, title, state, repo, priority, backlog_rank) values ($1, $2, $3, $4, $5, $6, $7) returning id",
    [c.sourceId, ext, title, state, REPO, extra.priority ?? 0, extra.rank ?? null],
  )).rows[0].id;
  mine.items.set(n, id);
  if (!c.extIds.includes(ext)) c.extIds.push(ext);
  return id;
}

/** An item whose PR merged into main as `sha`, held in `state`, its open run recording the merge as the factory does. */
async function merged(world: object, n: number, state: string, pr: number, sha: string): Promise<string> {
  const { c, mine } = await harness(world);
  const id = await holdItem(world, n, state);
  const branch = `factory/pbi-${n}-r1`;
  c.host!.prs.push({
    number: pr, repo: REPO, branch, base: MAIN, title: `Item ${n}`, body: "b", headSha: `head-${n}`, open: false, merged: true,
    mergeSha: sha, mergeable: true, reviewers: [], comments: [], reviews: [],
  });
  await pool().query(
    `insert into run (item_id, repo_id, run_number, next_stage, branch, pr_number, pr_url, merge_sha, config_sha)
     values ($1, $2, 1, 'open-pr', $3, $4, $5, $6, 'c1')`,
    [id, mine.repoId, branch, pr, `${REPO_URL}/pull/${pr}`, sha],
  );
  await withTx(pool(), (tx) => appendEvent(tx, { actor: "system", actorId: "poller", itemId: id, kind: "transition", payload: { from: "InReview", to: "Accepted", event: "merged" } }));
  if (state !== "Accepted") {
    await withTx(pool(), (tx) => appendEvent(tx, { actor: "system", actorId: "scheduler", itemId: id, kind: "transition", payload: { from: "Accepted", to: state, event: "dod_failed" } }));
  }
  return id;
}

// ---- CI ----

function urlFor(mine: Ctx): string {
  return `${REPO_URL}/runs/${mine.nextUrl++}`;
}

/** Sets the named checks on `sha`, keeping its others, and its overall status from them all. */
function ci(world: object, sha: string, set: { name: string; status: CheckRun["status"]; url?: string }[]): void {
  const c = pollCtx(world);
  assert.ok(c.host, "the fake repo host isn't set up");
  const mine = ctx(world);
  const key = `${mine.repo ?? REPO}@${sha}`;
  const runs = c.host.runs.get(key) ?? [];
  for (const s of set) {
    const run: CheckRun = { name: s.name, status: s.status, url: s.url ?? urlFor(mine) };
    const at = runs.findIndex((r) => r.name === s.name);
    if (at >= 0) runs[at] = run;
    else runs.push(run);
  }
  c.host.runs.set(key, runs);
  const status = runs.some((r) => r.status === "failure") ? "failure" : runs.some((r) => r.status === "pending") ? "pending" : "success";
  c.host.checks.set(key, status);
}

const specLog = (passing: string[], failing: string[]) =>
  ["##[group]Run npm test", "> node --test \"src/**/*.test.ts\"", "##[endgroup]",
    ...passing.map((t) => `✔ ${t} (0.4ms)`), ...failing.map((t) => `✖ ${t} (1.2ms)`),
    `ℹ tests ${passing.length + failing.length}`, `ℹ pass ${passing.length}`, `ℹ fail ${failing.length}`, "", "✖ failing tests:", "",
    ...failing.flatMap((t, i) => [`test at src/board.test.ts:${10 * (i + 1)}:3`, `✖ ${t} (1.2ms)`, "  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:", ""]),
    "##[error]Process completed with exit code 1."]
    .map((l, i) => `2026-11-14T10:00:${String(i % 60).padStart(2, "0")}.1234567Z ${l}`).join("\n");

// ---- the background ----

Given("the factory holds item {int} in state {string} after its PR {int} merged into {string} as commit {string}", long, async function (n: number, state: string, pr: number, branch: string, sha: string) {
  assert.equal(branch, MAIN);
  await merged(this, n, state, pr, sha);
  const c = pollCtx(this);
  const list = mainCommits(c);
  list.push(sha);
  c.host!.heads.set(REPO, sha);
});

Given("the factory holds item {int} in state {string} after its PR {int} merged into {string} as commit {string} after commit {string}", long, async function (n: number, state: string, pr: number, branch: string, sha: string, after: string) {
  assert.equal(branch, MAIN);
  await merged(this, n, state, pr, sha);
  land(pollCtx(this), sha, after);
});

Given("commit {string}'s first parent on {string} is commit {string}", function (sha: string, branch: string, parent: string) {
  assert.equal(branch, MAIN);
  parentOf(pollCtx(this), sha, parent, ctx(this).repo);
});

Given("commit {string} lands on {string} after commit {string}", function (sha: string, branch: string, after: string) {
  assert.equal(branch, MAIN);
  land(pollCtx(this), sha, after);
});

Given("CI passed every check on commit {string}", function (sha: string) {
  ci(this, sha, EVERY_CHECK.map((name) => ({ name, status: "success" })));
});

Given("CI passed every check on commit {string}'s first parent {string}", function (sha: string, parent: string) {
  parentOf(pollCtx(this), sha, parent);
  ci(this, parent, EVERY_CHECK.map((name) => ({ name, status: "success" })));
});

Given("CI failed the check {string} on commit {string}, with the URL {string}", function (check: string, sha: string, url: string) {
  ci(this, sha, [{ name: check, status: "failure", url }]);
});

Given("CI failed the check {string} on commit {string}", function (check: string, sha: string) {
  ci(this, sha, [{ name: check, status: "failure" }]);
});

Given("CI failed the check {string} on commit {string} and passed the check {string}", function (failed: string, sha: string, passed: string) {
  ci(this, sha, [{ name: failed, status: "failure" }, { name: passed, status: "success" }]);
});

Given("CI failed the checks {string} and {string} on commit {string}", function (a: string, b: string, sha: string) {
  ci(this, sha, [{ name: a, status: "failure" }, { name: b, status: "failure" }]);
});

Given("CI ran these checks on commit {string}:", function (sha: string, table: { hashes(): { check: string; result: string; url: string }[] }) {
  ci(this, sha, table.hashes().map((r) => {
    assert.ok(["success", "failure", "pending"].includes(r.result), `unknown result "${r.result}"`);
    return { name: r.check, status: r.result as CheckRun["status"], url: r.url };
  }));
});

Given("the log of the check {string} on commit {string} names the failing tests {string} and {string}", function (check: string, sha: string, a: string, b: string) {
  const host = pollCtx(this).host;
  assert.ok(host, "the fake repo host isn't set up");
  host.logs.set(`${REPO}@${sha}:${check}`, specLog(["loads the policy"], [a, b]));
});

Given("the log of the check {string} on commit {string} names no failing test", function (check: string, sha: string) {
  const host = pollCtx(this).host;
  assert.ok(host, "the fake repo host isn't set up");
  host.logs.set(`${REPO}@${sha}:${check}`, ["> tsc --noEmit", "src/main.ts(3,1): error TS1005: ';' expected.", "npm error code 2"].join("\n"));
});

// ---- items already waiting, broken or queued ----

async function waits(world: object, ns: number[]): Promise<void> {
  const mine = ctx(world);
  for (const n of ns) {
    const id = mine.items.get(n);
    assert.ok(id, `item ${n} isn't held`);
    await pool().query("update run set waits_on_branch = $2 where item_id = $1 and ended_at is null", [id, MAIN]);
  }
}

Given("item {int} waits on {string} because commit {string} failed the same checks", long, async function (n: number, branch: string, _sha: string) {
  assert.equal(branch, MAIN);
  await waits(this, [n]);
});

Given("items {int} and {int} wait on {string} because commit {string} failed the same checks", long, async function (a: number, b: number, branch: string, _sha: string) {
  assert.equal(branch, MAIN);
  await waits(this, [a, b]);
});

/** A bug item the factory filed because `sha`, item `n`'s merge commit, broke main: on the board, held Queued, and its break recorded. */
async function bugFiled(world: object, sha: string, n: number, pr: number): Promise<{ externalId: string; itemId: string }> {
  const { c, mine } = await harness(world);
  const charged = mine.items.get(n);
  assert.ok(charged, `item ${n} isn't held`);
  const title = `main is red: commit ${sha} broke it`;
  const failed = [{ name: "test", url: `${REPO_URL}/runs/900`, tests: [] as string[] }];
  const body = [
    `CI failed on main for commit ${sha}, the merge of PR #${pr} for item #${n}, after it passed on the commit's first parent.`,
    "", "Failed checks:", ...failed.map((f) => `- ${f.name}: ${f.url}`),
  ].join("\n");
  const externalId = await c.fake!.adapter.fileItem({ title, body, labels: [LABEL], repo: REPO }, `main-break:${sha}`);
  const itemId = (await pool().query<{ id: string }>(
    "insert into item (source_id, external_id, title, state, repo, backlog_rank) values ($1, $2, $3, 'Queued', $4, 3) returning id",
    [c.sourceId, externalId, title, REPO],
  )).rows[0].id;
  await pool().query(
    `insert into main_break (repo_id, branch, merge_sha, item_id, pr_number, failed_checks, bug_external_id, bug_item_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [mine.repoId, MAIN, sha, charged, pr, JSON.stringify(failed), externalId, itemId],
  );
  if (!c.extIds.includes(externalId)) c.extIds.push(externalId);
  return { externalId, itemId };
}

Given("item {int}'s merge commit {string} broke {string} and the factory filed a bug item for it", long, async function (n: number, sha: string, branch: string) {
  assert.equal(branch, MAIN);
  const c = pollCtx(this);
  await merged(this, n, "Failed", 56, sha);
  assert.ok(mainCommits(c).includes(sha), `commit "${sha}" isn't on main`);
  ctx(this).bug = await bugFiled(this, sha, n, 56);
});

Given("the factory holds, in state {string}, the bug item it filed because commit {string} broke {string}", long, async function (state: string, sha: string, branch: string) {
  assert.equal(state, "Queued");
  assert.equal(branch, MAIN);
  const mine = ctx(this);
  const row = (await pool().query<{ item_id: string; pr_number: number; external_id: string }>(
    "select r.item_id, r.pr_number, i.external_id from run r join item i on i.id = r.item_id where r.merge_sha = $1", [sha],
  )).rows[0];
  assert.ok(row, `no item merged as commit "${sha}"`);
  // The break charged the item whose merge it was.
  await pool().query("update item set state = 'Failed' where id = $1", [row.item_id]);
  mine.bug = await bugFiled(this, sha, Number(row.external_id), row.pr_number);
});

Given("the factory holds item {int} in state {string} with priority {int} and backlog rank {int}", long, async function (n: number, state: string, priority: number, rank: number) {
  await holdItem(this, n, state, { priority, rank });
});

// ---- polls and claims ----

When("the poller runs {int} times", long, async function (times: number) {
  assert.ok(times > 0, "the poller must run at least once");
  const c = pollCtx(this);
  for (let i = 0; i < times; i++) await poll(c);
  // A poll that failed fails here, so no Then reads the state a broken poll left.
  polled(c);
  assert.equal(c.polls, times, `the poller ran ${c.polls} times, not ${times}`);
});

// "the poller has run once" is PBI 260's step, which polls through the same harness and checks the poll didn't fail.

Given("the poller has run again", long, async function () {
  const c = pollCtx(this);
  await poll(c);
  // As PBI 260's "the poller has run once" does: the Floor's Thens read no poll, so a failed poll here must fail now.
  polled(c);
});

async function claim(world: object): Promise<void> {
  const mine = ctx(world);
  pollCtx(world).ranOther = "the scheduler's claim";
  const claimed = await withTx(pool(), (tx) => claimNext(tx, "scheduler", new Date()));
  mine.claims.push(claimed?.itemId ?? null);
  // Every scenario that claims has an item queued to claim, so a claim that took none fails here.
  assert.ok(claimed, "the scheduler claimed no item");
  // A claimed item is leased to the scheduler, so the claim really took it.
  const r = await pool().query<{ state: string }>("select state from item where id = $1", [claimed.itemId]);
  assert.equal(r.rows[0]?.state, "InProgress", `the claimed item is in state ${r.rows[0]?.state}, not InProgress`);
}

When("the scheduler claims the next item", long, async function () {
  await claim(this);
});

When("the scheduler claims the next item again", long, async function () {
  await claim(this);
});

// ---- the bug item ----

function filed(world: object): string[] {
  const c = pollCtx(world);
  polled(c);
  return c.fake!.filed;
}

/** The one bug item the factory filed: its labels, and its title and body together. Exported for PBI 354's steps. */
export async function bugItem(world: object): Promise<{ labels: string[]; text: string }> {
  const ids = filed(world);
  assert.ok(ids.length > 0, "the factory has filed no bug item");
  assert.equal(ids.length, 1, `the factory has filed ${ids.length} bug items`);
  const item = await pollCtx(world).fake!.adapter.getItem(ids[0]);
  assert.ok(item, `the filed item ${ids[0]} isn't on the board`);
  return { labels: item.labels, text: `${item.title}\n${item.body}` };
}

/** The tests the bug item lists: the list items under a line that mentions "failing test", up to the next blank line. */
export function listedTests(body: string): string[] {
  const tests: string[] = [];
  let under = false;
  for (const line of body.split("\n")) {
    if (/failing test/i.test(line) && !/^\s*[-*]\s/.test(line)) under = true;
    else if (line.trim() === "" || /^\s*#/.test(line)) under = false;
    else if (under && /^\s*[-*]\s+\S/.test(line)) tests.push(line.replace(/^\s*[-*]\s+/, "").trim());
  }
  return tests;
}

Then("the factory has filed exactly one bug item", function () {
  const ids = filed(this);
  assert.equal(ids.length, 1, `the factory has filed ${ids.length} bug items`);
});

Then("the factory has filed no bug item", function () {
  const ids = filed(this);
  assert.deepEqual(ids, [], `the factory filed ${ids.length} bug items`);
});

Then("the bug item carries the {string} label", long, async function (label: string) {
  const bug = await bugItem(this);
  assert.ok(bug.labels.includes(label), `the bug item's labels are ${JSON.stringify(bug.labels)}`);
});

Then(/^(?:that|the) bug item names the merge commit "([^"]+)"$/, long, async function (sha: string) {
  const bug = await bugItem(this);
  assert.ok(bug.text.includes(sha), `the bug item doesn't name commit ${sha}:\n${bug.text}`);
});

Then("the bug item names PR {int}", long, async function (pr: number) {
  const bug = await bugItem(this);
  const re = new RegExp(`\\bPR #?${pr}\\b|${escapeRe(`${REPO_URL}/pull/${pr}`)}\\b`);
  assert.match(bug.text, re, `the bug item doesn't name PR ${pr}:\n${bug.text}`);
});

Then("the bug item names item {int}", long, async function (n: number) {
  const bug = await bugItem(this);
  assert.match(bug.text, new RegExp(`(?:#|\\bitem )${n}\\b`, "i"), `the bug item doesn't name item ${n}:\n${bug.text}`);
});

Then("the bug item names the failed check {string} with the URL {string}", long, async function (check: string, url: string) {
  const bug = await bugItem(this);
  const named = new RegExp(`\\b${escapeRe(check)}\\b`);
  assert.ok(bug.text.split("\n").some((l) => l.includes(url) && named.test(l.replace(url, ""))),
    `no line of the bug item names the check "${check}" with ${url}:\n${bug.text}`);
});

Then("the bug item names the failed check {string}", long, async function (check: string) {
  const bug = await bugItem(this);
  const url = pollCtx(this).host!.runs.get(`${REPO}@m3rg001`)?.find((r) => r.name === check)?.url;
  assert.ok(url, `the scenario gave the check "${check}" no URL`);
  const named = new RegExp(`\\b${escapeRe(check)}\\b`);
  assert.ok(bug.text.split("\n").some((l) => l.includes(url) && named.test(l.replace(url, ""))),
    `no line of the bug item names the failed check "${check}" with ${url}:\n${bug.text}`);
});

Then("the bug item doesn't name the check {string}", long, async function (check: string) {
  const bug = await bugItem(this);
  assert.doesNotMatch(bug.text, new RegExp(`\\b${escapeRe(check)}\\b`), `the bug item names the check "${check}":\n${bug.text}`);
  const url = pollCtx(this).host!.runs.get(`${REPO}@m3rg001`)?.find((r) => r.name === check)?.url;
  if (url) assert.ok(!bug.text.includes(url), `the bug item holds the URL of the check "${check}"`);
});

Then("the bug item names the failing test {string}", long, async function (test: string) {
  const bug = await bugItem(this);
  assert.ok(bug.text.includes(test), `the bug item doesn't name the failing test "${test}":\n${bug.text}`);
});

Then("the bug item names no failing test", long, async function () {
  const bug = await bugItem(this);
  assert.deepEqual(listedTests(bug.text), [], `the bug item lists failing tests:\n${bug.text}`);
});

// ---- the charged and the waiting items ----

async function movesTo(world: object, n: number, state: string): Promise<number> {
  const c = pollCtx(world);
  polled(c);
  const id = ctx(world).items.get(n);
  assert.ok(id, `item ${n} isn't held`);
  return (await pool().query<{ n: number }>(
    "select count(*)::int as n from event where item_id = $1 and kind in ('transition', 'override') and payload->>'to' = $2", [id, state],
  )).rows[0].n;
}

Then("item {int}'s history shows exactly one move to {string}", long, async function (n: number, state: string) {
  assert.equal(await movesTo(this, n, state), 1);
});

Then("item {int}'s history shows no move to {string}", long, async function (n: number, state: string) {
  assert.equal(await movesTo(this, n, state), 0);
});

Then("item {int} waits on {string}", long, async function (n: number, branch: string) {
  polled(pollCtx(this));
  const id = ctx(this).items.get(n);
  assert.ok(id, `item ${n} isn't held`);
  const r = await pool().query<{ waits_on_branch: string | null }>("select waits_on_branch from run where item_id = $1 and ended_at is null", [id]);
  assert.equal(r.rows[0]?.waits_on_branch, branch, `item ${n} doesn't wait on "${branch}"`);
});

Then("item {int} has no comment saying it failed its Definition of Done", long, async function (n: number) {
  const c = pollCtx(this);
  polled(c);
  const said = (await c.fake!.comments(String(n))).filter((b) => /Definition of Done/i.test(b));
  assert.deepEqual(said, [], `item ${n} has a comment saying it failed its Definition of Done`);
});

// ---- the claims ----

function claimed(world: object, which: number): string | null {
  const claims = ctx(world).claims;
  assert.ok(claims.length > which, `only ${claims.length} claims ran`);
  return claims[which];
}

function bugId(world: object): string {
  const bug = ctx(world).bug;
  assert.ok(bug, "no bug item was put in place");
  return bug.itemId;
}

function nameOf(world: object, id: string | null): string {
  if (id === null) return "nothing";
  for (const [n, item] of ctx(world).items) if (item === id) return `item ${n}`;
  return id === ctx(world).bug?.itemId ? "the bug item" : id;
}

Then("the bug item is the item claimed", function () {
  const got = claimed(this, 0);
  assert.equal(got, bugId(this), `the scheduler claimed ${nameOf(this, got)}`);
});

Then("the first item claimed is the bug item", function () {
  const got = claimed(this, 0);
  assert.equal(got, bugId(this), `the scheduler claimed ${nameOf(this, got)} first`);
});

Then("the second item claimed is item {int}", function (n: number) {
  const got = claimed(this, 1);
  assert.equal(got, ctx(this).items.get(n), `the scheduler claimed ${nameOf(this, got)} second`);
});

// ---- the Floor ----

function floorPage(world: object): string {
  const c = dashCtx(world);
  assert.equal(c.status, 200, `the Floor answered ${c.status}: ${String(c.page).slice(0, 300)}`);
  return c.page!;
}

/** The text of each item Floor's "Production Line" lists to claim, in order: its rows past the InProgress ones (PBI 430). */
function nextUp(world: object): string[] {
  const section = scope(floorPage(world), '"Production Line"');
  return [...section.matchAll(/<tr><td>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]).filter((r) => !/<td>InProgress<\/td>/.test(r)).map(text);
}

const names = (line: string, ext: string) => new RegExp(`#${escapeRe(ext)}\\b`).test(line);

Then("the first item to claim in the Floor's \"Production Line\" list is the bug item", function () {
  const bug = ctx(this).bug;
  assert.ok(bug, "no bug item was put in place");
  const list = nextUp(this);
  assert.ok(list.length > 0, "Floor's \"Production Line\" list is empty");
  assert.ok(names(list[0], bug.externalId), `Floor's "Production Line" list starts with "${list[0]}", not the bug item #${bug.externalId}`);
});

Then("item {int} comes after it", function (n: number) {
  const bug = ctx(this).bug!;
  const list = nextUp(this);
  const at = list.findIndex((l) => names(l, String(n)));
  const bugAt = list.findIndex((l) => names(l, bug.externalId));
  assert.ok(at >= 0, `Floor's "Production Line" list doesn't show item ${n}: ${JSON.stringify(list)}`);
  assert.ok(bugAt >= 0 && at > bugAt, `item ${n} doesn't come after the bug item: ${JSON.stringify(list)}`);
});

/** The markup of the first element with the given id, up to its matching close tag. */
function elementById(html: string, id: string): string | null {
  const open = new RegExp(`<([a-zA-Z][\\w-]*)\\b[^>]*\\bid\\s*=\\s*["']${escapeRe(id)}["'][^>]*>`, "i").exec(html);
  if (!open) return null;
  const tag = open[1].toLowerCase();
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  re.lastIndex = open.index + open[0].length;
  let depth = 1;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(open.index, m.index + m[0].length);
  }
  return html.slice(open.index);
}

function notice(world: object): string {
  const page = floorPage(world);
  const el = elementById(page, "main-red");
  assert.ok(el, `the Floor doesn't say main is red: ${text(page).slice(0, 500)}`);
  return text(el);
}

Then("the Floor says {string} is red", function (branch: string) {
  const said = notice(this);
  assert.ok(said.includes(branch) && /\bred\b/i.test(said), `the notice doesn't say "${branch}" is red: ${said}`);
});

Then("the Floor doesn't say {string} is red", function (_branch: string) {
  const page = floorPage(this);
  const el = elementById(page, "main-red");
  assert.equal(el, null, `the Floor still says main is red: ${el ? text(el) : ""}`);
});

Then("that notice names the commit {string}", function (sha: string) {
  const said = notice(this);
  assert.ok(said.includes(sha), `the notice doesn't name commit ${sha}: ${said}`);
});

Then("that notice doesn't name the commit {string}", function (sha: string) {
  const said = notice(this);
  assert.ok(!said.includes(sha), `the notice names commit ${sha}: ${said}`);
});

Then("that notice names the bug item", function () {
  const said = notice(this);
  const ids = pollCtx(this).fake!.filed;
  assert.equal(ids.length, 1, `the factory has filed ${ids.length} bug items`);
  assert.ok(names(said, ids[0]), `the notice doesn't name the bug item #${ids[0]}: ${said}`);
});
