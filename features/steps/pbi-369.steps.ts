// Step definitions for features/pbi-369-recheck-failed-items.feature.
//
// The scenarios reuse PBI 12's poller harness (its fake board and repo host), and PBI 255's steps for a commit's first
// parent, a failed check, "every check" passing, "item <n> waits on", "the factory has filed exactly one bug item", and
// PBI 168's "the factory holds item <n> in state". The items are held in PBI 255's context too, so its steps find them,
// and its repo follows the scenario's ("acme/widgets" unless the scenario says otherwise).
//
// The clock is a fake: "the poller runs at <time>" runs PBI 12's poll, then the scheduler's CI check on merged items,
// pollMergedCi, and then its re-check of Failed items, recheckFailed, both with `now` at that time. "Every 10 minutes
// from A to B" runs it at A, every 10 minutes after, and at B. Before each poll, every commit on each repo's main, and
// the ref "main", holds the repo's ".factory/config.yml": the factory's usual one, with `failed_recheck_hours` only when
// the scenario sets it.
//
// A re-check is one event of kind "recheck" on the item, whatever it finds, at the time the poller ran (event.at). A
// move is a "transition" or "override" event, its payload's `from`, `to` and `event`. The events the Givens write are
// the item's history before the scenario; a move "after" a time is one the factory made since.
//
// An item held Failed after "dod_failed" already has the comment the factory left when it failed. A new comment is one
// on the board item after that. "The comment" is the one new comment the last "has exactly one new comment" found.
//
// Floor and Run detail are the SPA's own pages, rendered from what PBI 89's control plane's API answered, opened by an
// operator with no `tz` cookie, so in UTC.
// Floor's row for an item is an <li> or <tr> whose text names it as "#<n>". It shows when the item was last re-checked
// with "re-checked" and the time, as "YYYY-MM-DD HH:MM", in that row; one not yet re-checked says "not yet re-checked"
// (or "never re-checked", "hasn't been re-checked") there. Run detail says "last re-checked" followed by the time, or
// that the item "hasn't been re-checked yet" (or "not yet re-checked", "never re-checked").
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { CheckRun } from "../../src/adapters/types.ts";
import { pollMergedCi, recheckFailed } from "../../src/scheduler/scheduler.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";
import { ctx as pollCtx, poll, polled, setup, type Ctx as PollCtx } from "./pbi-12.steps.ts";
import { ctx as ctx255 } from "./pbi-255.steps.ts";
import { ctx as p89, headers, open, startControlPlane } from "./pbi-89.steps.ts";
import { escapeRe, text } from "./pbi-175.steps.ts";

const MAIN = "main";
const LABEL = "factory";
const CONFIG = ".factory/config.yml";
const BASE_CONFIG = "bdd:\n  parse: npm run bdd -- --dry-run\n  run: npm run bdd\n  report: reports/bdd.ndjson\ncommands:\n  test: npm test\n  lint: npm run lint\n";

type Held = { id: string; ext: string; repo: string; failedAt: Date; seenComments: number };

type Ctx = {
  repo: string;
  /** The time the poller runs at now. */
  clock?: Date;
  /** The repo's `failed_recheck_hours`, when the scenario sets it. */
  hours?: number;
  repoIds: Map<string, string>;
  items: Map<number, Held>;
  /** The ids of the events the Givens wrote. */
  seeded: Set<string>;
  /** The one new comment the last "has exactly one new comment" found. */
  comment?: string;
  /** Run detail as the operator last opened it. */
  runDetail?: { status: number; html: string };
};

function ctx(world: object): Ctx {
  const w = world as { pbi369?: Ctx };
  w.pbi369 ??= { repo: "acme/widgets", repoIds: new Map(), items: new Map(), seeded: new Set() };
  return w.pbi369;
}

const pool = () => need().pool;
const utc = (t: string) => {
  assert.match(t, /^\d{4}-\d\d-\d\d \d\d:\d\d$/, `"${t}" isn't a time as "YYYY-MM-DD HH:MM"`);
  return new Date(`${t.replace(" ", "T")}:00Z`);
};
const shown = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");

Before({ tags: "@pbi-369", ...long }, async function () {
  const d = await testDb();
  if (!d) return;
  await d.pool.query('truncate item, event, backlog_source, repo, "user", override cascade');
  await d.pool.query(
    `update wip_policy set mode = 'fixed', wip_min = 1, wip_max = 1, current_wip = 1, review_capacity = 3, usage_reserve_at = 0.7,
       usage_paused_until = null, daily_budget = null`,
  );
  const c = pollCtx(this);
  const mine = ctx(this);
  c.beforePoll = async () => writeConfig(c, mine);
  c.afterPoll = async () => {
    assert.ok(mine.clock, "the poller ran with no time set");
    const deps = { pool: pool(), repoHost: c.host!, backlogFor: () => c.fake!.adapter, now: mine.clock };
    await pollMergedCi(deps);
    await recheckFailed(deps);
  };
});

After({ tags: "@pbi-369", ...long }, async function () {
  const c = p89(this);
  await c.close?.();
  if (c.server) {
    c.server.closeAllConnections();
    await new Promise<void>((resolve) => c.server!.close(() => resolve()));
  }
});

// ---- the repo, its main branch and its config ----

async function harness(world: object): Promise<{ c: PollCtx; mine: Ctx; repoId: string }> {
  const c = pollCtx(world);
  assert.ok(await setup(c), "the poller's fakes or database aren't available");
  const mine = ctx(world);
  let repoId = mine.repoIds.get(mine.repo);
  if (!repoId) {
    repoId = (await pool().query<{ id: string }>(
      "insert into repo (host_adapter, url) values ('fake', $1) on conflict (url) do update set url = excluded.url returning id", [`https://github.com/${mine.repo}`],
    )).rows[0].id;
    mine.repoIds.set(mine.repo, repoId);
  }
  return { c, mine, repoId };
}

function mainCommits(c: PollCtx, repo: string): string[] {
  const key = `${repo}@${MAIN}`;
  const list = c.host!.branches.get(key) ?? [];
  c.host!.branches.set(key, list);
  return list;
}

/** Puts the repo's config.yml on every commit of each repo's main, and on the ref "main". */
function writeConfig(c: PollCtx, mine: Ctx): void {
  if (!c.host) return;
  const text = BASE_CONFIG + (mine.hours === undefined ? "" : `failed_recheck_hours: ${mine.hours}\n`);
  for (const repo of new Set([...mine.repoIds.keys(), ...[...mine.items.values()].map((i) => i.repo)])) {
    for (const ref of [...mainCommits(c, repo), MAIN]) c.host.files.set(`${repo}@${ref}:${CONFIG}`, text);
  }
}

Given("the repo is {string}", function (repo: string) {
  assert.match(repo, /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/, `"${repo}" isn't an "owner/name" repo`);
  ctx(this).repo = repo;
  ctx255(this).repo = repo;
});

Given("the repo's {string} sets `failed_recheck_hours` to {int}", function (path: string, hours: number) {
  assert.equal(path, CONFIG);
  ctx(this).hours = hours;
});

// ---- the items ----

async function event(itemId: string, actorId: string, payload: object, at: Date, mine: Ctx): Promise<void> {
  const id = (await pool().query<{ id: string }>(
    "insert into event (actor, actor_id, item_id, kind, payload, at) values ('system', $1, $2, 'transition', $3, $4) returning id",
    [actorId, itemId, JSON.stringify(payload), at],
  )).rows[0].id;
  mine.seeded.add(id);
}

const FROM: Record<string, string> = { dod_failed: "Accepted", retries_exhausted: "InProgress" };

Given("the factory holds item {int} in state {string} after the event {string} at {string} UTC", long, async function (n: number, state: string, ev: string, t: string) {
  assert.equal(state, "Failed");
  const from = FROM[ev];
  assert.ok(from, `no move to Failed with the event "${ev}"`);
  const { c, mine } = await harness(this);
  const ext = String(n);
  const title = `Item ${n}`;
  await c.fake!.seed({ externalId: ext, title, labels: [LABEL], repo: mine.repo, rank: n });
  const id = (await pool().query<{ id: string }>(
    "insert into item (source_id, external_id, title, state, repo) values ($1, $2, $3, $4, $5) returning id",
    [c.sourceId, ext, title, state, mine.repo],
  )).rows[0].id;
  const at = utc(t);
  await event(id, ev === "dod_failed" ? "scheduler" : "cell-api", { from, to: state, event: ev }, at, mine);
  if (ev === "dod_failed") {
    await c.fake!.adapter.comment(ext, `CI failed on ${MAIN} for the item's merge commit, so the item failed its Definition of Done.`, `dod-failed:${n}`);
  }
  mine.items.set(n, { id, ext, repo: mine.repo, failedAt: at, seenComments: (await c.fake!.comments(ext)).length });
  ctx255(this).items.set(n, id);
  if (!c.extIds.includes(ext)) c.extIds.push(ext);
});

function held(world: object, n: number): Held {
  const item = ctx(world).items.get(n);
  assert.ok(item, `item ${n} isn't held`);
  return item;
}

Given("item {int}'s PR {int} merged into {string} as commit {string}", long, async function (n: number, pr: number, branch: string, sha: string) {
  assert.equal(branch, MAIN);
  const { c, mine } = await harness(this);
  const item = held(this, n);
  const repoId = mine.repoIds.get(item.repo)!;
  const prBranch = `factory/pbi-${n}-r1`;
  c.host!.prs.push({
    number: pr, repo: item.repo, branch: prBranch, base: MAIN, title: `Item ${n}`, body: "b", headSha: `head-${n}`, open: false, merged: true,
    mergeSha: sha, mergeable: true, reviewers: [], comments: [], reviews: [],
  });
  await pool().query(
    `insert into run (item_id, repo_id, run_number, next_stage, branch, pr_number, pr_url, merge_sha, config_sha)
     values ($1, $2, 1, 'open-pr', $3, $4, $5, $6, 'c1')`,
    [item.id, repoId, prBranch, pr, `https://github.com/${item.repo}/pull/${pr}`, sha],
  );
  await event(item.id, "poller", { from: "InReview", to: "Accepted", event: "merged" }, new Date(item.failedAt.getTime() - 60 * 60_000), mine);
  const list = mainCommits(c, item.repo);
  if (!list.includes(sha)) list.push(sha);
  c.host!.heads.set(item.repo, list.at(-1)!);
});

Given("{string} gains commit {string}, which contains {string}", function (branch: string, sha: string, merged: string) {
  assert.equal(branch, MAIN);
  const c = pollCtx(this);
  const repo = ctx(this).repo;
  const list = mainCommits(c, repo);
  assert.ok(list.includes(merged), `commit "${merged}" isn't on ${branch}`);
  c.host!.parents.set(`${repo}@${sha}`, list.at(-1)!);
  list.push(sha);
  c.host!.heads.set(repo, sha);
});

Given("the factory filed one bug item for the break at {string} when item {int} failed", long, async function (sha: string, n: number) {
  const { c, mine } = await harness(this);
  const item = held(this, n);
  const pr = (await pool().query<{ pr_number: number }>("select pr_number from run where item_id = $1 and merge_sha = $2", [item.id, sha])).rows[0]?.pr_number;
  assert.ok(pr, `item ${n} didn't merge as commit "${sha}"`);
  const failed = (c.host!.runs.get(`${item.repo}@${sha}`) ?? []).filter((r) => r.status === "failure").map((r) => ({ name: r.name, url: r.url, tests: [] as string[] }));
  const title = `main is red: commit ${sha} broke it`;
  const body = [`CI failed on main for commit ${sha}, the merge of PR #${pr} for item #${n}, after it passed on the commit's first parent.`,
    "", "Failed checks:", ...failed.map((f) => `- ${f.name}: ${f.url}`)].join("\n");
  const externalId = await c.fake!.adapter.fileItem({ title, body, labels: [LABEL], repo: item.repo }, `main-break:${sha}`);
  const bugId = (await pool().query<{ id: string }>(
    "insert into item (source_id, external_id, title, state, repo, backlog_rank) values ($1, $2, $3, 'Queued', $4, 3) returning id",
    [c.sourceId, externalId, title, item.repo],
  )).rows[0].id;
  await pool().query(
    `insert into main_break (repo_id, branch, merge_sha, item_id, pr_number, failed_checks, bug_external_id, bug_item_id, at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [mine.repoIds.get(item.repo), MAIN, sha, item.id, pr, JSON.stringify(failed), externalId, bugId, item.failedAt],
  );
  if (!c.extIds.includes(externalId)) c.extIds.push(externalId);
});

// ---- CI ----

/** Sets the named checks on `sha`, keeping its others unless `only`, and its overall status as GitHub reads it. */
function ci(world: object, sha: string, set: { name: string; status: CheckRun["status"] }[], only = false): void {
  const c = pollCtx(world);
  assert.ok(c.host, "the fake repo host isn't set up");
  const repo = ctx(world).repo;
  const key = `${repo}@${sha}`;
  const runs = only ? [] : c.host.runs.get(key) ?? [];
  for (const s of set) {
    const run: CheckRun = { name: s.name, status: s.status, url: `https://github.com/${repo}/runs/${sha}-${s.name}` };
    const at = runs.findIndex((r) => r.name === s.name);
    if (at >= 0) runs[at] = run;
    else runs.push(run);
  }
  c.host.runs.set(key, runs);
  // GitHub's checksOnSha counts a cancelled run as failed, as it does any completed run that didn't pass.
  const status = runs.some((r) => r.status === "failure" || r.status === "cancelled") ? "failure" : runs.some((r) => r.status === "pending") ? "pending" : "success";
  c.host.checks.set(key, status);
}

Given("CI passed the check {string} on commit {string}", function (check: string, sha: string) {
  ci(this, sha, [{ name: check, status: "success" }]);
});

Given("CI on commit {string} was run again and passed every check", function (sha: string) {
  const c = pollCtx(this);
  const names = (c.host?.runs.get(`${ctx(this).repo}@${sha}`) ?? []).map((r) => r.name);
  ci(this, sha, (names.length ? names : ["ci"]).map((name) => ({ name, status: "success" })), true);
});

Given("CI's check {string} on commit {string} was cancelled, and no check failed on it", function (check: string, sha: string) {
  ci(this, sha, [{ name: check, status: "cancelled" }], true);
});

// ---- the poller ----

async function pollAt(world: object, at: Date): Promise<void> {
  const c = pollCtx(world);
  ctx(world).clock = at;
  const before = c.polls;
  await poll(c);
  // A poll that failed fails here, so no Then reads the state a broken poll left.
  polled(c);
  assert.equal(c.polls, before + 1, "the poller didn't run");
}

When("the poller runs at {string} UTC", long, async function (t: string) {
  await pollAt(this, utc(t));
});

Given("the poller ran at {string} UTC", long, async function (t: string) {
  await pollAt(this, utc(t));
});

When("the poller runs every {int} minutes from {string} to {string} UTC", long, async function (minutes: number, from: string, to: string) {
  const end = utc(to).getTime();
  for (let at = utc(from).getTime(); at <= end; at += minutes * 60_000) await pollAt(this, new Date(at));
});

// ---- re-checks ----

async function rechecks(world: object, n: number): Promise<Date[]> {
  polled(pollCtx(world));
  const r = await pool().query<{ at: Date }>("select at from event where item_id = $1 and kind = 'recheck' order by at", [held(world, n).id]);
  return r.rows.map((row) => row.at);
}

Then("item {int} has been re-checked exactly once", long, async function (n: number) {
  const got = await rechecks(this, n);
  assert.equal(got.length, 1, `item ${n} was re-checked ${got.length} times: ${got.map(shown).join(", ")}`);
});

Then("item {int} has been re-checked exactly {int} times", long, async function (n: number, times: number) {
  const got = await rechecks(this, n);
  assert.equal(got.length, times, `item ${n} was re-checked ${got.length} times: ${got.map(shown).join(", ")}`);
});

Then("item {int} has never been re-checked", long, async function (n: number) {
  const got = await rechecks(this, n);
  assert.deepEqual(got.map(shown), [], `item ${n} was re-checked`);
});

Then("item {int} was last re-checked at {string} UTC", long, async function (n: number, t: string) {
  const got = await rechecks(this, n);
  assert.ok(got.length > 0, `item ${n} was never re-checked`);
  assert.equal(shown(got.at(-1)!), shown(utc(t)), `item ${n} was last re-checked at ${shown(got.at(-1)!)}`);
});

Then("item {int} was re-checked at {string}, {string} and {string} UTC", long, async function (n: number, a: string, b: string, c: string) {
  const got = await rechecks(this, n);
  assert.deepEqual(got.map(shown), [a, b, c].map((t) => shown(utc(t))));
});

// ---- the item's history ----

type Move = { id: string; from: string; to: string; event: string | null; at: Date };

/** The moves the factory made on the item since the Givens. */
async function newMoves(world: object, n: number): Promise<Move[]> {
  polled(pollCtx(world));
  const r = await pool().query<{ id: string; payload: { from: string; to: string; event?: string }; at: Date }>(
    "select id, payload, at from event where item_id = $1 and kind in ('transition', 'override') order by at, id", [held(world, n).id],
  );
  const seeded = ctx(world).seeded;
  return r.rows.filter((row) => !seeded.has(row.id)).map((row) => ({ id: row.id, from: row.payload.from, to: row.payload.to, event: row.payload.event ?? null, at: row.at }));
}

const describe = (moves: Move[]) => JSON.stringify(moves.map((m) => `${m.from} -> ${m.to} (${m.event})`));

Then("item {int}'s history shows a move from {string} to {string} with the event {string}", long, async function (n: number, from: string, to: string, ev: string) {
  const moves = await newMoves(this, n);
  assert.ok(moves.some((m) => m.from === from && m.to === to && m.event === ev), `item ${n}'s new moves are ${describe(moves)}`);
});

Then("item {int}'s history shows exactly one move with the event {string}", long, async function (n: number, ev: string) {
  const moves = await newMoves(this, n);
  assert.equal(moves.filter((m) => m.event === ev).length, 1, `item ${n}'s new moves are ${describe(moves)}`);
});

Then("item {int}'s history shows no move after {string} UTC", long, async function (n: number, t: string) {
  const moves = await newMoves(this, n);
  assert.deepEqual(describe(moves), "[]", `item ${n} moved after ${t}`);
});

Then("item {int}'s history shows the moves {string} to {string} to {string}, in that order", long, async function (n: number, a: string, b: string, c: string) {
  const moves = await newMoves(this, n);
  // Each move starts where the one before it ended, from the state the item was held in.
  const chain: string[] = [a];
  const left = [...moves];
  for (let i = left.findIndex((m) => m.from === chain.at(-1)); i >= 0; i = left.findIndex((m) => m.from === chain.at(-1))) {
    chain.push(left[i].to);
    left.splice(i, 1);
  }
  assert.deepEqual(chain, [a, b, c], `item ${n}'s new moves are ${describe(moves)}`);
  assert.deepEqual(left, [], `item ${n}'s new moves are ${describe(moves)}`);
});

// ---- comments ----

async function newComments(world: object, n: number): Promise<string[]> {
  const c = pollCtx(world);
  polled(c);
  const item = held(world, n);
  return (await c.fake!.comments(item.ext)).slice(item.seenComments);
}

Then("item {int} has exactly one new comment", long, async function (n: number) {
  const got = await newComments(this, n);
  assert.equal(got.length, 1, `item ${n} has ${got.length} new comments: ${JSON.stringify(got)}`);
  ctx(this).comment = got[0];
});

Then("item {int} has no new comment", long, async function (n: number) {
  const got = await newComments(this, n);
  assert.deepEqual(got, [], `item ${n} has new comments`);
});

function theComment(world: object): string {
  const said = ctx(world).comment;
  assert.ok(said !== undefined, "no one new comment was found");
  return said;
}

Then("the comment says the re-check found {string} was already red", function (branch: string) {
  const said = theComment(this);
  assert.match(said, /re-?check/i, `the comment doesn't say it's from a re-check: ${said}`);
  assert.match(said, new RegExp(`\\b${escapeRe(branch)}\\b[^.]*\\balready red\\b`, "i"), `the comment doesn't say "${branch}" was already red: ${said}`);
});

Then("the comment names the merge commit {string} and its first parent {string}", function (sha: string, parent: string) {
  const said = theComment(this);
  assert.ok(said.includes(sha) && said.includes(parent), `the comment doesn't name ${sha} and ${parent}: ${said}`);
});

Then("the comment says the item is Accepted and waits on {string}", function (branch: string) {
  const said = theComment(this);
  assert.match(said, /\bAccepted\b/, `the comment doesn't say the item is Accepted: ${said}`);
  assert.match(said, new RegExp(`\\bwaits on ${escapeRe(branch)}\\b`, "i"), `the comment doesn't say the item waits on "${branch}": ${said}`);
});

async function aNewComment(world: object, n: number, test: (body: string) => boolean, what: string): Promise<void> {
  const got = await newComments(world, n);
  assert.ok(got.some(test), `no new comment on item ${n} ${what}: ${JSON.stringify(got)}`);
}

Then("item {int} has a new comment that says CI now passes on the merge commit {string}", long, async function (n: number, sha: string) {
  await aNewComment(this, n, (b) => b.includes(sha) && /\bpass(es|ed)?\b/i.test(b), `says CI now passes on ${sha}`);
});

Then("item {int} has a new comment that says CI on the merge commit {string} was cancelled and no check failed", long, async function (n: number, sha: string) {
  await aNewComment(this, n, (b) => b.includes(sha) && /\bcancel/i.test(b) && /\bno check failed\b/i.test(b), `says CI on ${sha} was cancelled and no check failed`);
});

Then("item {int} has a new comment that names the merge commit {string} and its first parent {string}", long, async function (n: number, sha: string, parent: string) {
  await aNewComment(this, n, (b) => b.includes(sha) && b.includes(parent), `names ${sha} and ${parent}`);
});

// ---- Floor and Run detail ----

Given("an operator whose time zone is UTC is signed in", long, async function () {
  const c = p89(this);
  if (!c.server) await startControlPlane(this);
  await pool().query(
    `insert into "user" (provider, subject, github_login, role) values ('microsoft', 'op', 'op', 'operator') on conflict (provider, subject) do nothing`,
  );
  // No tz cookie: the dashboard shows times in UTC.
  c.login = "op";
  assert.ok(c.origin, "the control plane didn't start");
  const role = (await pool().query<{ role: string }>(
    `select role from "user" where provider = 'microsoft' and subject = 'op'`,
  )).rows[0]?.role;
  assert.equal(role, "operator", "the signed-in user isn't an operator");
  assert.ok(!("cookie" in headers(c.login)), "the operator's requests send a cookie, so maybe a tz one");
});

When("the operator opens item {int}'s Run detail", long, async function (n: number) {
  const c = p89(this);
  assert.ok(c.origin && c.login, "no operator is signed in");
  // Run detail is kept apart from the page PBI 89's open() last read, so a Floor opened before it still reads as Floor.
  const floor = { status: c.status, html: c.html, json: c.json };
  await open(c, `/items/${held(this, n).id}`);
  ctx(this).runDetail = { status: c.status!, html: c.html! };
  Object.assign(c, floor);
});

function floorRows(world: object, n: number): string[] {
  const c = p89(world);
  assert.equal(c.status, 200, `Floor answered ${c.status}`);
  // React marks where two pieces of text meet with an empty comment, which isn't text.
  const rows = [...c.html!.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<(li|tr)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => text(m[2]));
  const mine = rows.filter((r) => new RegExp(`#${n}\\b`).test(r));
  assert.ok(mine.length > 0, `Floor doesn't show item ${n}`);
  return mine;
}

Then("Floor shows item {int} as last re-checked at {string}", function (n: number, t: string) {
  const rows = floorRows(this, n);
  assert.ok(rows.some((r) => new RegExp(`re-checked[\\s\\S]*${escapeRe(t)}|${escapeRe(t)}[\\s\\S]*re-checked`, "i").test(r)),
    `Floor doesn't show item ${n} as last re-checked at ${t}: ${JSON.stringify(rows)}`);
});

const NOT_YET = /not yet re-checked|never re-checked|(hasn't|has not) (yet )?been re-checked/i;

Then("Floor shows item {int} as not yet re-checked", function (n: number) {
  const rows = floorRows(this, n);
  assert.ok(rows.some((r) => NOT_YET.test(r)), `Floor doesn't show item ${n} as not yet re-checked: ${JSON.stringify(rows)}`);
});

function runDetail(world: object): string {
  const page = ctx(world).runDetail;
  assert.ok(page, "Run detail wasn't opened");
  assert.equal(page.status, 200, `Run detail answered ${page.status}: ${page.html.slice(0, 300)}`);
  return text(page.html.replace(/<!--[\s\S]*?-->/g, ""));
}

Then("Run detail shows the item was last re-checked at {string}", function (t: string) {
  const said = runDetail(this);
  assert.match(said, new RegExp(`last re-checked\\W{0,5}(at |on )?${escapeRe(t)}`, "i"), `Run detail doesn't say the item was last re-checked at ${t}`);
});

Then("Run detail shows the item hasn't been re-checked yet", function () {
  const said = runDetail(this);
  assert.match(said, NOT_YET, "Run detail doesn't say the item hasn't been re-checked yet");
});
