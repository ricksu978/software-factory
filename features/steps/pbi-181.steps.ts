// Step definitions for features/pbi-181-factory-merges.feature. The scenarios reuse PBI 12's poller harness, so its
// "the poller runs once", "the factory holds the item in state" and "the item's run resumes from" steps, and PBI 142's
// "the poller runs twice" and "the item's run records the merge commit", read the same context.
//
// GitHub is PBI 12's fake repo host. Each PR here has a head, a passed check on it, a body with a Definition of Done
// section in the form the cell's open-pr writes, and a merge state the steps set. The factory's merge is read off the
// fake: the PR merged, and mergePr was asked for a squash merge. The factory logs its merge as a system event of kind
// "factory_merged" whose payload holds `prNumber`, `mergeSha` and `approvers`, and a refused merge as a system event
// whose payload holds `prNumber` and GitHub's message.
import { Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { MergeState } from "../../src/adapters/types.ts";
import { withTx } from "../../src/store/db.ts";
import { transitionItem } from "../../src/store/items.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";
import { ctx as pollCtx, polled, setup, stateOf, type Ctx as PollCtx } from "./pbi-12.steps.ts";

export const MERGE_EVENT = "factory_merged";
const REPO = "acme/widgets";
const actor = { actor: "system", actorId: "pbi-181-steps" } as const;

type DodLine = { text: string; ticked: boolean; person: boolean };
type PrBody = { dod: DodLine[]; outside: string[] };
type Ctx = { bodies: Map<number, PrBody>; second?: string; event?: { payload: Record<string, unknown> } };

function ctx(world: object): Ctx {
  const w = world as { pbi181?: Ctx };
  w.pbi181 ??= { bodies: new Map() };
  return w.pbi181;
}

Before({ tags: "@pbi-181", ...long }, async function () {
  const d = await testDb();
  if (d) await d.pool.query('truncate item, backlog_source, repo, "user" cascade');
});

function prOf(world: object, n: number) {
  const found = pollCtx(world).host?.prs.find((p) => p.number === n);
  assert.ok(found, `the repo host has no PR ${n}`);
  return found;
}

/** The PR body in the form open-pr writes it, with the Definition of Done section near its end. */
function writeBody(world: object, n: number): void {
  const b = ctx(world).bodies.get(n)!;
  const outside = b.outside.length ? `## Try it\n\n${b.outside.map((t) => `- [ ] ${t}`).join("\n")}\n\n` : "";
  const lines = b.dod.map((l) => l.person
    ? `- [${l.ticked ? "x" : " "}] ${l.text} *(for the person who merges to check)*`
    : `- [x] ${l.text}`);
  prOf(world, n).body = `Builds the item.\n\nRefs #1\n\n${outside}## Definition of Done\n\nThe factory checked these lines at c1.\n\n${lines.join("\n")}\n\n## Shadow risk tier\n\n**Low**. Recorded only, so a person still approves this PR.\n`;
}

function editBody(world: object, n: number, change: (b: PrBody) => void): void {
  change(ctx(world).bodies.get(n)!);
  writeBody(world, n);
}

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

/** An item in `state` on the board and in the factory, whose open run has PR `n` in REPO, approved by `approvers`. */
async function holdItem(world: object, c: PollCtx, state: string, n: number, approvers: string[]): Promise<string> {
  const ext = await c.fake!.seed({ labels: ["factory"], repo: REPO });
  const branch = `factory/pbi-${ext}-r1`;
  const headSha = `h${n}`;
  c.host!.prs.push({
    number: n, repo: REPO, branch, base: "main", title: `Item ${ext}`, body: "", headSha, open: true, merged: false,
    mergeSha: null, mergeable: true, reviewers: [], comments: [],
    reviews: approvers.map((author) => ({ state: "approved" as const, submittedAt: at(30), author })),
    mergeState: "unknown", refusals: [],
  });
  c.host!.checks.set(`${REPO}@${headSha}`, "success");
  ctx(world).bodies.set(n, { dod: [{ text: "Typecheck, unit tests and scenarios pass", ticked: true, person: false }], outside: [] });
  writeBody(world, n);
  const pool = need().pool;
  const item = await pool.query<{ id: string }>(
    `insert into item (source_id, external_id, title, state, repo, lease_generation, lease_owner, lease_expires)
     values ($1, $2, 'test item', $3, $4, 1, case when $3 = 'InProgress' then 'cell-a' end, case when $3 = 'InProgress' then now() + interval '5 minutes' end)
     returning id`,
    [c.sourceId, ext, state, REPO],
  );
  const repoId = (await pool.query<{ id: string }>("select id from repo where url = $1", [`https://github.com/${REPO}`])).rows[0]?.id ?? null;
  await pool.query(
    `insert into run (item_id, run_number, next_stage, branch, pr_number, pr_url, reviews_seen_at, repo_id)
     values ($1, 1, 'pr-review', $2, $3, $4, now() - interval '1 hour', $5)`,
    [item.rows[0].id, branch, n, `https://github.com/${REPO}/pull/${n}`, repoId],
  );
  return ext;
}

async function itemId(c: PollCtx, ext: string): Promise<string> {
  const r = await need().pool.query<{ id: string }>("select id from item where source_id = $1 and external_id = $2", [c.sourceId, ext]);
  assert.ok(r.rows[0], `the factory doesn't hold item ${ext}`);
  return r.rows[0].id;
}

async function systemEvents(c: PollCtx): Promise<{ kind: string; payload: Record<string, unknown>; text: string }[]> {
  const r = await need().pool.query<{ kind: string; payload: Record<string, unknown>; text: string }>(
    `select e.kind, e.payload, e.payload::text as text from event e
     where e.actor = 'system' and (e.item_id is null or e.item_id in (select id from item where source_id = $1)) order by e.at`,
    [c.sourceId],
  );
  return r.rows;
}

const namesPr = (payload: Record<string, unknown>, n: number) => Number(payload.prNumber) === n;

async function mergeEvents(c: PollCtx, n: number) {
  return (await systemEvents(c)).filter((e) => e.kind === MERGE_EVENT && namesPr(e.payload, n));
}

// ---- the background ----

Given("{string} and {string} are allowlisted users", long, async function (a: string, b: string) {
  const c = pollCtx(this);
  assert.ok(await setup(c), "the poller's fakes or database aren't available");
  for (const login of [a, b]) {
    await need().pool.query(`insert into "user" (provider, subject, role, github_login) values ('dev', $1, 'owner', $1)`, [login]);
  }
});

Given("the factory holds an item in state {string} whose open run has PR {int} in {string}", long, async function (state: string, n: number, repo: string) {
  assert.equal(repo, REPO);
  const c = pollCtx(this);
  assert.ok(await setup(c), "the poller's fakes or database aren't available");
  await need().pool.query("insert into repo (host_adapter, url) values ('fake', $1) on conflict do nothing", [`https://github.com/${REPO}`]);
  c.extIds = [await holdItem(this, c, state, n, [])];
  c.pr = n;
});

Given("{string} has approved PR {int}", function (login: string, n: number) {
  prOf(this, n).reviews.push({ state: "approved", submittedAt: at(20), author: login });
});

Given("{string} has also approved PR {int}", function (login: string, n: number) {
  prOf(this, n).reviews.push({ state: "approved", submittedAt: at(19), author: login });
});

Given("{string} has commented on PR {int} without approving it", function (login: string, n: number) {
  prOf(this, n).reviews.push({ state: "commented", submittedAt: at(18), author: login, body: "Looks interesting." });
});

Given("nobody has approved PR {int}", function (n: number) {
  const p = prOf(this, n);
  p.reviews = p.reviews.filter((r) => r.state !== "approved");
});

When("{string} approves PR {int}", function (login: string, n: number) {
  prOf(this, n).reviews.push({ state: "approved", submittedAt: at(1), author: login });
});

Given("every required check on PR {int} has passed", function (n: number) {
  const p = prOf(this, n);
  pollCtx(this).host!.checks.set(`${p.repo}@${p.headSha}`, "success");
});

Given(/^the required check "([^"]*)" on PR (\d+) is (pending|failing)$/, function (_check: string, n: string, status: string) {
  const p = prOf(this, Number(n));
  pollCtx(this).host!.checks.set(`${p.repo}@${p.headSha}`, status === "pending" ? "pending" : "failure");
});

When("the required check {string} on PR {int} passes", function (_check: string, n: number) {
  const p = prOf(this, n);
  pollCtx(this).host!.checks.set(`${p.repo}@${p.headSha}`, "success");
});

Given("GitHub would merge PR {int} as commit {string}", function (n: number, sha: string) {
  prOf(this, n).mergeAs = sha;
});

Given("GitHub reports PR {int} as {string}", function (n: number, state: string) {
  prOf(this, n).mergeState = state as MergeState;
});

Given("GitHub refuses the next merge of PR {int} with {string}", function (n: number, message: string) {
  const p = prOf(this, n);
  (p.refusals ??= []).push(message);
});

// ---- the PR body ----

Given("PR {int}'s Definition of Done leaves no line for the person who merges", function (n: number) {
  editBody(this, n, (b) => { b.dod = b.dod.filter((l) => !l.person); });
});

Given("PR {int}'s Definition of Done leaves the line {string} unticked for the person who merges", function (n: number, text: string) {
  editBody(this, n, (b) => { b.dod.push({ text, ticked: false, person: true }); });
});

Given("PR {int}'s Definition of Done leaves these lines unticked for the person who merges:", function (n: number, table: { hashes(): { line: string }[] }) {
  editBody(this, n, (b) => { for (const { line } of table.hashes()) b.dod.push({ text: line, ticked: false, person: true }); });
});

Given("PR {int}'s Definition of Done has the factory's ticked line {string}", function (n: number, text: string) {
  editBody(this, n, (b) => { if (!b.dod.some((l) => l.text === text)) b.dod.push({ text, ticked: true, person: false }); });
});

Given("PR {int}'s body has an unticked box {string} outside its Definition of Done", function (n: number, text: string) {
  editBody(this, n, (b) => { b.outside.push(text); });
});

When("a person ticks {string} in PR {int}'s body", function (text: string, n: number) {
  editBody(this, n, (b) => {
    const line = b.dod.find((l) => l.text === text && l.person);
    assert.ok(line, `PR ${n}'s body has no line "${text}" for the person who merges`);
    line.ticked = true;
  });
});

// ---- reviews asking for changes ----

Given("{string}, an allowlisted user, requests changes on PR {int}", function (login: string, n: number) {
  prOf(this, n).reviews.push({ state: "changes_requested", submittedAt: at(5), author: login, body: "Please rename this function." });
});

Given("{string}, who maps to no allowlisted user, requests changes on PR {int}", function (login: string, n: number) {
  prOf(this, n).reviews.push({ state: "changes_requested", submittedAt: at(5), author: login, body: "Please rename this function." });
});

When("the factory addresses kim's review and the item returns to {string}", long, async function (state: string) {
  const c = pollCtx(this);
  const id = await itemId(c, c.extIds[0]);
  // The address stage answers the review and the PR review passes again, which brings the item back to InReview with
  // the review seen.
  await withTx(need().pool, async (tx) => {
    await transitionItem(tx, id, "claimed", actor);
    await transitionItem(tx, id, "pr_opened", actor);
    await tx.query("update run set reviews_seen_at = now(), next_stage = 'pr-review' where item_id = $1 and ended_at is null", [id]);
  });
  assert.equal(await stateOf(c, c.extIds[0]), state);
});

// ---- InProgress and held items ----

Given("the factory holds the item in state {string}, with its run in {string}", long, async function (state: string, stage: string) {
  const c = pollCtx(this);
  const id = await itemId(c, c.extIds[0]);
  const pool = need().pool;
  await pool.query(
    `update item set state = $2, lease_owner = case when $2 = 'InProgress' then 'cell-a' end,
            lease_expires = case when $2 = 'InProgress' then now() + interval '5 minutes' end where id = $1`,
    [id, state],
  );
  await pool.query("update run set next_stage = $2 where item_id = $1 and ended_at is null", [id, stage]);
});

When("the run finishes and the item moves to {string}", long, async function (state: string) {
  const c = pollCtx(this);
  const id = await itemId(c, c.extIds[0]);
  await withTx(need().pool, (tx) => transitionItem(tx, id, "pr_opened", actor));
  assert.equal(await stateOf(c, c.extIds[0]), state);
});

Given("an operator has held the item from the dashboard", long, async function () {
  const c = pollCtx(this);
  await need().pool.query("update item set held = true where id = $1", [await itemId(c, c.extIds[0])]);
});

When("the operator lifts the hold", long, async function () {
  const c = pollCtx(this);
  await need().pool.query("update item set held = false where id = $1", [await itemId(c, c.extIds[0])]);
});

// ---- a second item ----

Given("the factory holds a second item in state {string} whose open run has PR {int} in {string}, approved by {string}", long, async function (state: string, n: number, repo: string, login: string) {
  assert.equal(repo, REPO);
  const c = pollCtx(this);
  ctx(this).second = await holdItem(this, c, state, n, [login]);
  prOf(this, n).mergeAs = `m${n}`;
});

Then("the second item is in state {string}", long, async function (state: string) {
  const c = pollCtx(this);
  polled(c);
  const second = ctx(this).second;
  assert.ok(second, "there is no second item");
  assert.equal(await stateOf(c, second), state);
});

Then("the factory holds the first item in state {string}", long, async function (state: string) {
  const c = pollCtx(this);
  polled(c);
  assert.equal(await stateOf(c, c.extIds[0]), state);
});

// ---- the merge ----

Then("the factory has merged PR {int} with a squash merge", function (n: number) {
  const c = pollCtx(this);
  polled(c);
  const p = prOf(this, n);
  assert.ok(p.merged, `PR ${n} isn't merged`);
  const made = c.host!.mergeCalls.filter((m) => m.prNumber === n && m.merged);
  assert.equal(made.length, 1, `the factory made ${made.length} merges of PR ${n}`);
  assert.equal(made[0].method, "squash");
});

Then("the factory hasn't merged PR {int}", function (n: number) {
  const c = pollCtx(this);
  polled(c);
  assert.equal(prOf(this, n).merged, false, `PR ${n} merged`);
});

Then("the factory asked GitHub to merge PR {int} exactly once", function (n: number) {
  const c = pollCtx(this);
  polled(c);
  assert.equal(c.host!.mergeCalls.filter((m) => m.prNumber === n).length, 1);
});

Then("the item's history shows exactly one move to {string}, by the {string} event", long, async function (state: string, event: string) {
  const c = pollCtx(this);
  polled(c);
  const r = await need().pool.query<{ event: string | null }>(
    `select e.payload->>'event' as event from event e join item i on i.id = e.item_id
     where i.source_id = $1 and i.external_id = $2 and e.kind in ('transition', 'override') and e.payload->>'to' = $3`,
    [c.sourceId, c.extIds[0], state],
  );
  assert.deepEqual(r.rows.map((x) => x.event), [event]);
});

// ---- system events ----

Then("a system event names PR {int} and the reason {string}", long, async function (n: number, reason: string) {
  const c = pollCtx(this);
  polled(c);
  const found = (await systemEvents(c)).filter((e) => e.kind !== MERGE_EVENT && namesPr(e.payload, n) && e.text.includes(JSON.stringify(reason).slice(1, -1)));
  assert.ok(found.length > 0, `no system event names PR ${n} and "${reason}"`);
});

Then("a system event records the factory's merge of PR {int}", long, async function (n: number) {
  const c = pollCtx(this);
  polled(c);
  const found = await mergeEvents(c, n);
  assert.equal(found.length, 1, `${found.length} system events record the factory's merge of PR ${n}`);
  ctx(this).event = found[0];
});

Then("exactly one system event records the factory's merge of PR {int}", long, async function (n: number) {
  const c = pollCtx(this);
  polled(c);
  assert.equal((await mergeEvents(c, n)).length, 1);
});

Then("no system event records a merge of PR {int}", long, async function (n: number) {
  const c = pollCtx(this);
  polled(c);
  assert.deepEqual(await mergeEvents(c, n), []);
});

function theEvent(world: object): Record<string, unknown> {
  const e = ctx(world).event;
  assert.ok(e, "no merge event was found");
  return e.payload;
}

Then("that event names the merge commit {string}", function (sha: string) {
  assert.equal(theEvent(this).mergeSha, sha);
});

Then("that event names {string} as an approving reviewer", function (login: string) {
  const approvers = theEvent(this).approvers;
  assert.ok(Array.isArray(approvers) && approvers.includes(login), `the event's approvers are ${JSON.stringify(approvers)}`);
});

Then("that event names {string} and {string} as the approving reviewers", function (a: string, b: string) {
  const approvers = theEvent(this).approvers;
  assert.ok(Array.isArray(approvers), `the event names no approvers: ${JSON.stringify(theEvent(this))}`);
  assert.deepEqual([...approvers].sort(), [a, b].sort());
});

Then("that event doesn't name {string}", function (login: string) {
  assert.ok(!JSON.stringify(theEvent(this)).includes(login), `the event names "${login}"`);
});
