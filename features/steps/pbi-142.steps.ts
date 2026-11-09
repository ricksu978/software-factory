// Step definitions for features/pbi-142-merged-pr-while-in-progress.feature. The @db scenarios reuse PBI 12's poller
// harness, so its "the poller runs once" and "the factory holds the item in state" steps read the same context. The
// cell scenarios reuse PBI 18's engine harness, with a repo host of their own that holds a merged PR or fails a call.
import { Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { fakeRepoHost } from "../../src/adapters/fake.ts";
import { load, long, need, testDb } from "./pbi-8.steps.ts";
import { ctx as pollCtx, poll, polled, REPO, setup } from "./pbi-12.steps.ts";
import { runTheCell, setUp, type Ctx as CellCtx } from "./pbi-18.steps.ts";

type Host = ReturnType<typeof fakeRepoHost>;
type Ctx = { opened: unknown[]; reviewersAsked: unknown[] };

function ctx(world: object): Ctx {
  const w = world as { pbi142?: Ctx };
  w.pbi142 ??= { opened: [], reviewersAsked: [] };
  return w.pbi142;
}

function cell(world: object): CellCtx {
  const w = world as { pbi18?: CellCtx };
  assert.ok(w.pbi18, "no run was set up");
  return w.pbi18;
}

const BRANCH = "factory/pbi-482-r1";
const CELL_REPO = "acme/app";

Before({ tags: "@pbi-142 and @db", ...long }, async function () {
  const d = await testDb();
  if (d) await d.pool.query('truncate item, backlog_source, repo, "user" cascade');
});

function prOf(world: object, n: number) {
  const found = pollCtx(world).host?.prs.find((p) => p.number === n);
  assert.ok(found, `the repo host has no PR ${n}`);
  return found;
}

async function runRow(world: object): Promise<{ merge_sha: string | null } | undefined> {
  const c = pollCtx(world);
  const r = await need().pool.query<{ merge_sha: string | null }>(
    "select r.merge_sha from run r join item i on i.id = r.item_id where i.source_id = $1 and i.external_id = $2 order by r.run_number desc limit 1",
    [c.sourceId, c.extIds[0]],
  );
  return r.rows[0];
}

// ---- the poller ----

Given("the factory holds an item in state {string} whose open run has PR {int}", long, async function (state: string, n: number) {
  const c = pollCtx(this);
  assert.ok(await setup(c), "the poller's fakes or database aren't available");
  const ext = await c.fake!.seed({ labels: ["factory"], repo: REPO });
  c.extIds = [ext];
  c.pr = n;
  const branch = `factory/pbi-${ext}-r1`;
  c.host!.prs.push({
    number: n, repo: REPO, branch, base: "main", title: "t", body: "b", headSha: null, open: true, merged: false,
    mergeSha: null, mergeable: true, reviewers: [], comments: [], reviews: [],
  });
  const pool = need().pool;
  const item = await pool.query<{ id: string }>(
    `insert into item (source_id, external_id, title, state, lease_generation, lease_owner, lease_expires)
     values ($1, $2, 'test item', $3, 1, case when $3 = 'InProgress' then 'cell-a' end, case when $3 = 'InProgress' then now() + interval '5 minutes' end)
     returning id`,
    [c.sourceId, ext, state],
  );
  await pool.query(
    `insert into run (item_id, run_number, next_stage, branch, pr_number, pr_url, reviews_seen_at)
     values ($1, 1, 'address', $2, $3, $4, now() - interval '1 hour')`,
    [item.rows[0].id, branch, n, `https://github.com/${REPO}/pull/${n}`],
  );
});

Given("a person merged PR {int} as commit {string}, and no webhook said so", function (n: number, sha: string) {
  Object.assign(prOf(this, n), { open: false, merged: true, mergeSha: sha });
});

Given("a person closed PR {int} without merging it, and no webhook said so", function (n: number) {
  Object.assign(prOf(this, n), { open: false, merged: false, mergeSha: null });
});

Given("the merge closed the item on the board", async function () {
  const c = pollCtx(this);
  await c.fake!.adapter.close(c.extIds[0]);
});

Given("the item still carries its {string} label on the board", async function (label: string) {
  const c = pollCtx(this);
  const item = await c.fake!.adapter.getItem(c.extIds[0]);
  assert.ok(item?.labels.includes(label), `the item has no "${label}" label`);
});

When("the poller runs twice", long, async function () {
  const c = pollCtx(this);
  await poll(c);
  await poll(c);
});

Then("the item's run records the merge commit {string}", long, async function (sha: string) {
  polled(pollCtx(this));
  assert.equal((await runRow(this))?.merge_sha, sha);
});

Then("the item's run records no merge commit", long, async function () {
  polled(pollCtx(this));
  const row = await runRow(this);
  assert.ok(row, "the item has no run");
  assert.equal(row.merge_sha, null);
});

Then("the item's history shows exactly one move to {string}", long, async function (state: string) {
  const c = pollCtx(this);
  polled(c);
  const r = await need().pool.query<{ n: number }>(
    `select count(*)::int as n from event e join item i on i.id = e.item_id
     where i.source_id = $1 and i.external_id = $2 and e.kind in ('transition', 'override') and e.payload->>'to' = $3`,
    [c.sourceId, c.extIds[0], state],
  );
  assert.equal(r.rows[0].n, 1);
});

// ---- the cell ----

Given("a run for item {int} that resumes at open-pr", function (_item: number) {
  const run = setUp(this, "open-pr", true);
  const mine = ctx(this);
  run.repoHost = {
    async openOrUpdatePr(p: { body: string }) { mine.opened.push(p); run.prBodies.push(p.body); return { number: 7, url: `https://github.com/${CELL_REPO}/pull/7` }; },
    async requestReviewers(...a: unknown[]) { mine.reviewersAsked.push(a); return []; },
    async openReviewComments() { return []; },
  };
});

Given("the run's branch has PR {int}, which a person has already merged", async function (n: number) {
  const run = cell(this);
  const mine = ctx(this);
  const mod = await load<{ fakeRepoHost: () => Host }>("src/adapters/fake.ts");
  assert.ok(mod, "the fake repo host doesn't exist");
  const host = mod.fakeRepoHost();
  host.prs.push({
    number: n, repo: CELL_REPO, branch: BRANCH, base: "main", title: "Item 482", body: "the merged PR", headSha: null, open: false,
    merged: true, mergeSha: "m57", mergeable: null, reviewers: [], comments: [], reviews: [],
  });
  run.prNumber = n;
  // The fake itself, so whatever the engine asks about the branch's PR it answers from the merged one. Its writes are
  // recorded as well, so the Thens can tell whether one happened.
  run.repoHost = new Proxy(host, {
    get(target, key, receiver) {
      if (key === "openOrUpdatePr") return async (p: { body: string }) => { mine.opened.push(p); run.prBodies.push(p.body); return target.openOrUpdatePr(p as never); };
      if (key === "requestReviewers") return async (...a: [string, number, string[]]) => { mine.reviewersAsked.push(a); return target.requestReviewers(...a); };
      return Reflect.get(target, key, receiver);
    },
  }) as unknown as Record<string, unknown>;
});

Given(/^the repo host fails with "([^"]*)" when the cell is (opening the PR|asking for reviewers|reading the PR's CI checks)$/, function (message: string, step: string) {
  const run = cell(this);
  const fail = async () => { throw new Error(message); };
  if (step === "reading the PR's CI checks") run.checks = fail;
  else run.repoHost = { ...run.repoHost, [step === "opening the PR" ? "openOrUpdatePr" : "requestReviewers"]: fail };
});

function openPrStages(world: object): Record<string, any>[] {
  return cell(world).calls.filter((x) => x.route === "/stage" && x.body.stageId === "open-pr").map((x) => x.body);
}

function lastOpenPr(world: object): Record<string, any> {
  const all = openPrStages(world);
  assert.ok(all.length > 0, "open-pr never started");
  return all.at(-1)!;
}

Then("no PR is opened or updated for the run's branch", function () {
  assert.equal(ctx(this).opened.length, 0, "a PR was opened or updated");
});

Then("no reviewers are requested", function () {
  assert.equal(ctx(this).reviewersAsked.length, 0, "reviewers were requested");
});

Then("the open-pr stage's last attempt ends failed", function () {
  const last = lastOpenPr(this);
  assert.equal(last.status, "failed", `the last open-pr report is ${last.status}, attempt ${last.attempt}`);
});

Then("that attempt's message names PR {int} as already merged", function (n: number) {
  const message = String(lastOpenPr(this).message ?? "");
  assert.match(message, new RegExp(`(#|PR )${n}(?!\\d)`), `the message doesn't name PR ${n}: ${message}`);
  assert.match(message, /merged/i, `the message doesn't say the PR merged: ${message}`);
});

Then("that attempt's message holds {string}", function (text: string) {
  const message = String(lastOpenPr(this).message ?? "");
  assert.ok(message.includes(text), `the message lacks "${text}": ${message}`);
});

Then("no open-pr attempt is left started", function () {
  const all = openPrStages(this);
  const started = new Set(all.filter((s) => s.status === "started").map((s) => s.attempt));
  for (const s of all) if (s.status !== "started") started.delete(s.attempt);
  assert.deepEqual([...started], [], `open-pr attempts left started: ${[...started].join(", ")}`);
});

Then("the item doesn't move to InReview", function () {
  const c = cell(this);
  assert.ok(!c.calls.some((x) => x.route === "/transition" && x.body.event === "pr_opened"), "the item moved to InReview");
});
