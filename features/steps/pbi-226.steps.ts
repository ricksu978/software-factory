// Step definitions for features/pbi-226-split-parent-done.feature. Every scenario runs on PBI 225's harness: the real
// poller over Postgres on PBI 144's fake board, its scripted judge and coding model, and PBI 12's fake repo host. PBI
// 225's Before hook covers @pbi-226 too, and records each comment and close the poller makes through the backlog.
// A second parent is a second fake issue that PBI 144's judge also finds oversized, with its own coding model reply.
// The factory "holds" a child in a state by its item row, written straight to the database, with a run carrying the
// child's PR and that PR in the fake repo host, as the cell and the scheduler would have left them. A Done child's
// issue is closed, as its merged PR closed it. A person closing an issue closes the fake issue; the fake backlog keeps
// no close reason, and a person's close goes through no factory write.
// Since PBI 237 the factory files each child with the opt-in label, so it enters the factory on the next poll. A
// scenario about a child that never carried the label, or that a person closed before it entered the factory, has the
// board file that child without labels, as every child was filed before PBI 237 shipped. A Before hook reads which
// child from the scenario's steps, since the Background files the children before the scenario's own steps run.
// "The factory holds child X in state Y" is PBI 237's and PBI 444's wording too. Here it sets the state; in PBI 237 and
// PBI 444 it checks it.
import { Before, DataTable, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { ItemState } from "../../src/core/states.ts";
import { SPLIT_DONE_HEADING } from "../../src/gate/split-done.ts";
import { upsertItem } from "../../src/store/items.ts";
import { ctx as ctx144, polled, replaceItem, type Ctx as Ctx144 } from "./pbi-144.steps.ts";
import { ctx as ctx225, moves, pollMore, show } from "./pbi-225.steps.ts";
import { heldIn as pbi237HeldIn } from "./pbi-237.steps.ts";
import { heldIn as pbi444HeldIn, realPolled as pbi444Real } from "./pbi-444.steps.ts";
import { long, need } from "./pbi-8.steps.ts";

const HEADING = "Acceptance criteria";

type Ctx = { secondId?: string; secondTitle?: string };

function ctx(world: object): Ctx {
  const w = world as { pbi226?: Ctx };
  w.pbi226 ??= {};
  return w.pbi226;
}

/** The one issue titled `title` the factory filed. */
function child(c: Ctx144, title: string): string {
  polled(c);
  const found = c.filed.filter((i) => i.title === title);
  assert.equal(found.length, 1, `child "${title}" was filed ${found.length} times`);
  return found[0].externalId;
}

async function row(world: object, externalId: string): Promise<{ id: string; state: ItemState } | null> {
  const k = ctx225(world);
  const r = await need().pool.query<{ id: string; state: ItemState }>("select id, state from item where source_id = $1 and external_id = $2", [k.sourceId, externalId]);
  return r.rows[0] ?? null;
}

type Pr = { number: number; open: boolean };

/**
 * Has the factory hold child `title` in `state`: the child carries the opt-in label, its item row is in `state`, and
 * its open run carries `pr` when there is one. A merged PR gives the run its merge commit and closes the child's issue.
 */
async function hold(world: object, title: string, state: ItemState, pr?: Pr): Promise<void> {
  const c = ctx144(world);
  const k = ctx225(world);
  assert.ok(k.sourceId, "the factory's database wasn't set up");
  const ext = child(c, title);
  await replaceItem(c, ext, (fi) => ({ labels: fi.labels.includes(c.label) ? fi.labels : [...fi.labels, c.label] }));
  const pool = need().pool;
  const id = await upsertItem(pool, { sourceId: k.sourceId, externalId: ext, title, repo: c.repo });
  await pool.query("update item set state = $2 where id = $1", [id, state]);
  const repoId = (await pool.query<{ id: string }>("select id from repo where url = $1", [`https://github.com/${c.repo}`])).rows[0]?.id;
  assert.ok(repoId, `the factory doesn't know the repo ${c.repo}`);
  const branch = `factory/pbi-${ext}-r1`;
  let runId = (await pool.query<{ id: string }>("select id from run where item_id = $1 and ended_at is null order by started_at desc limit 1", [id])).rows[0]?.id;
  runId ??= (await pool.query<{ id: string }>("insert into run (item_id, repo_id, run_number, branch) values ($1, $2, 1, $3) returning id", [id, repoId, branch])).rows[0].id;
  if (!pr) return;
  const merged = !pr.open;
  const mergeSha = merged ? `merge-${pr.number}` : null;
  let p = k.host.prs.find((x) => x.repo === c.repo && x.number === pr.number);
  if (!p) {
    p = {
      number: pr.number, repo: c.repo, branch, base: "main", title, body: `Closes #${ext}`, headSha: `head-${pr.number}`, open: true,
      merged: false, mergeSha: null, mergeable: true, reviewers: [], comments: [], reviews: [],
    };
    k.host.prs.push(p);
  }
  Object.assign(p, { open: pr.open, merged, mergeSha });
  await pool.query("update run set pr_number = $2, pr_url = $3, merge_sha = $4 where id = $1", [runId, pr.number, `https://github.com/${c.repo}/pull/${pr.number}`, mergeSha]);
  if (merged) await c.fake.adapter.close(ext);
}

async function secondParent(world: object): Promise<string> {
  const id = ctx(world).secondId;
  assert.ok(id, "there's no second parent issue");
  return id;
}

async function heldState(world: object, externalId: string, what: string): Promise<ItemState> {
  const r = await row(world, externalId);
  assert.ok(r, `the factory doesn't hold ${what}`);
  return r.state;
}

async function doneComments(c: Ctx144): Promise<string[]> {
  polled(c);
  return (await c.fake.comments(c.parentId!)).filter((b) => b.startsWith(SPLIT_DONE_HEADING));
}

async function parentClosed(c: Ctx144): Promise<boolean> {
  polled(c);
  const fi = await c.fake.adapter.getItem(c.parentId!);
  assert.ok(fi, "the parent issue is gone");
  return fi.closed;
}

const UNLABELLED = [/^child "(.+)" has never carried the label /, /^a person closed child "(.+)" as .+ before it entered the factory$/];

Before({ tags: "@pbi-226" }, function ({ pickle }) {
  for (const step of pickle.steps) {
    for (const re of UNLABELLED) {
      const m = re.exec(step.text);
      if (m) (ctx144(this).unlabelled ??= new Set()).add(m[1]);
    }
  }
});

// ---- the second parent ----

Given("a second parent issue {string} in {string} on that board, carrying the label {string}", async function (title: string, repo: string, label: string) {
  const c = ctx144(this);
  const s = ctx(this);
  assert.equal(repo, c.repo, `the second parent issue is in "${repo}", not the repo on that board, "${c.repo}"`);
  s.secondTitle = title;
  s.secondId = await c.fake.seed({ title, body: "Let a shopper earn and spend loyalty points.", acceptanceCriteria: [], labels: [label], repo, status: c.backlogStatus });
  c.board.set(s.secondId, c.backlogStatus);
  const fi = await c.fake.adapter.getItem(s.secondId);
  assert.ok(fi, "the second parent issue wasn't seeded");
  assert.equal(fi.repo, repo, `the second parent issue reads back in "${fi.repo}"`);
  assert.ok(fi.labels.includes(label), `the second parent issue doesn't carry "${label}"`);
});

Given("the readiness judge finds the second parent issue oversized", async function () {
  const c = ctx144(this);
  (c.alsoOversized ??= new Set()).add(await secondParent(this));
});

Given("the coding model proposes a split of the second parent issue into {string} and {string}", async function (a: string, b: string) {
  const c = ctx144(this);
  const s = ctx(this);
  const id = await secondParent(this);
  const criteria = ["A shopper earns points on every order", "A shopper can spend points at checkout"];
  const body = `Let a shopper earn and spend loyalty points.\n\n## ${HEADING}\n\n${criteria.map((t) => `- ${t}`).join("\n")}\n`;
  await replaceItem(c, id, () => ({ body, acceptanceCriteria: criteria }));
  const reply = JSON.stringify({
    children: [a, b].map((title, i) => ({ title, body: `${title} for ${s.secondTitle}`, criteria: [i + 1], needs: i === 0 ? [] : [i] })),
  });
  (c.replies ??= []).push({ title: s.secondTitle!, reply });
});

Given("the factory has polled the backlog twice more, filing every child of the second parent and taking its label off", long, async function () {
  await pollMore(this, 2);
  const c = ctx144(this);
  const id = await secondParent(this);
  const kids = c.subIssues.get(id) ?? [];
  assert.equal(kids.length, 2, `the second parent has ${kids.length} sub-issues after two more polls`);
  const fi = await c.fake.adapter.getItem(id);
  assert.ok(fi && !fi.labels.includes(c.label), `the second parent still carries "${c.label}" after two more polls`);
});

Then("the factory holds the second parent issue in state {string}", long, async function (state: string) {
  assert.equal(await heldState(this, await secondParent(this), "the second parent issue"), state);
});

// ---- the children ----

Given("the factory holds child {string} in state {string}, closed by PR {int}", long, async function (title: string, state: ItemState, pr: number) {
  await hold(this, title, state, { number: pr, open: false });
});

When("the factory now holds child {string} in state {string}, closed by PR {int}", long, async function (title: string, state: ItemState, pr: number) {
  await hold(this, title, state, { number: pr, open: false });
});

Given("the factory holds child {string} in state {string} with PR {int} open", long, async function (title: string, state: ItemState, pr: number) {
  await hold(this, title, state, { number: pr, open: true });
});

Given("the factory holds child {string} in state {string}", long, async function (title: string, state: ItemState) {
  if ((this as { pbi237?: unknown }).pbi237) return pbi237HeldIn(this, title, state);
  if (pbi444Real(this)) return pbi444HeldIn(this, title, state);
  await hold(this, title, state);
});

Given("child {string} has never carried the label {string}", long, async function (title: string, label: string) {
  const c = ctx144(this);
  const ext = child(c, title);
  const fi = await c.fake.adapter.getItem(ext);
  assert.ok(fi && !fi.labels.includes(label), `child "${title}" carries "${label}"`);
  assert.equal(await row(this, ext), null, `the factory holds child "${title}"`);
});

When("the owner adds the label {string} to child {string}", async function (label: string, title: string) {
  const c = ctx144(this);
  await replaceItem(c, child(c, title), (fi) => ({ labels: fi.labels.includes(label) ? fi.labels : [...fi.labels, label] }));
});

async function personCloses(world: object, title: string): Promise<void> {
  const c = ctx144(world);
  await c.fake.adapter.close(child(c, title));
}

Given("a person closed child {string} as not planned before it entered the factory", long, async function (title: string) {
  const c = ctx144(this);
  assert.equal(await row(this, child(c, title)), null, `the factory holds child "${title}"`);
  await personCloses(this, title);
});

Given("a person closed child {string} as completed before it entered the factory", long, async function (title: string) {
  const c = ctx144(this);
  assert.equal(await row(this, child(c, title)), null, `the factory holds child "${title}"`);
  await personCloses(this, title);
});

Given("a person closed child {string} as completed while the factory held it in state {string}", long, async function (title: string, state: ItemState) {
  await hold(this, title, state);
  await personCloses(this, title);
});

Given("a person has added an open issue {string} to the parent issue as a sub-issue", async function (title: string) {
  const c = ctx144(this);
  polled(c);
  const externalId = await c.fake.seed({ title, body: `${title} at checkout.`, acceptanceCriteria: [], labels: [], repo: c.repo, status: "" });
  // Kept with the repo's issues so the fake board can name it as a sub-issue; the factory filed no split child by it.
  c.filed.push({ externalId, title, url: `https://github.com/${c.repo}/issues/${externalId}`, repo: c.repo });
  c.subIssues.set(c.parentId!, [...(c.subIssues.get(c.parentId!) ?? []), externalId]);
});

// ---- polling ----

Given("the factory has polled the backlog once more", long, async function () {
  await pollMore(this, 1);
});

// ---- the parent's history ----

Then("the parent's history shows exactly one move from {string} to {string}", long, async function (from: string, to: string) {
  const all = await moves(this);
  assert.equal(all.filter((m) => m.from === from && m.to === to).length, 1, `moves: ${show(all)}`);
});

Then("the parent's history shows no move after its move to {string}", long, async function (to: string) {
  const all = await moves(this);
  const at = all.findIndex((m) => m.to === to);
  assert.ok(at !== -1, `the parent's history shows no move to "${to}": ${show(all)}`);
  assert.deepEqual(all.slice(at + 1).map((m) => `${m.from} -${m.event}-> ${m.to}`), [], `moves: ${show(all)}`);
});

// ---- the parent issue ----

Then("the parent issue is still open", async function () {
  assert.equal(await parentClosed(ctx144(this)), false, "the parent issue is closed");
});

Then("the parent issue is closed as completed", async function () {
  const c = ctx144(this);
  const k = ctx225(this);
  assert.equal(await parentClosed(c), true, "the parent issue is still open");
  // The backlog adapter's close is GitHub's close as completed.
  assert.ok(k.writes.some((w) => w.kind === "close" && w.id === c.parentId), "the factory didn't close the parent issue");
});

Then("the parent issue has one comment saying its children are done", async function () {
  const found = await doneComments(ctx144(this));
  assert.equal(found.length, 1, `comments saying the children are done: ${found.length}`);
});

Then("the parent issue has no comment saying its children are done", async function () {
  assert.deepEqual(await doneComments(ctx144(this)), []);
});

Then("that comment pairs each child with the PR that closed it:", async function (table: DataTable) {
  const c = ctx144(this);
  const found = await doneComments(c);
  assert.equal(found.length, 1, `comments saying the children are done: ${found.length}`);
  const lines = found[0].split("\n");
  const rows = table.hashes();
  const names = (ext: string, title: string) => (l: string) => l.includes(title) || new RegExp(`/issues/${ext}(?!\\d)|#${ext}(?!\\d)`).test(l);
  const cites = (pr: string) => (l: string) => new RegExp(`/pull/${pr}(?!\\d)|#${pr}(?!\\d)`).test(l);
  for (const r of rows) {
    const ext = child(c, r.child);
    const mine = lines.filter(names(ext, r.child));
    assert.ok(mine.some(cites(r.PR)), `no line pairs child "${r.child}" with PR ${r.PR}:\n${found[0]}`);
    for (const other of rows.filter((o) => o.PR !== r.PR)) {
      assert.ok(!mine.some(cites(other.PR)), `a line pairs child "${r.child}" with PR ${other.PR}:\n${found[0]}`);
    }
  }
});

Then("the parent issue was closed after the comment saying its children are done was posted", function () {
  const c = ctx144(this);
  const k = ctx225(this);
  polled(c);
  const commented = k.writes.findIndex((w) => w.kind === "comment" && w.id === c.parentId && w.body?.startsWith(SPLIT_DONE_HEADING));
  const closed = k.writes.findIndex((w) => w.kind === "close" && w.id === c.parentId);
  assert.ok(commented !== -1, "the factory posted no comment saying the children are done");
  assert.ok(closed !== -1, "the factory didn't close the parent issue");
  assert.ok(closed > commented, "the factory closed the parent issue before its comment");
});
