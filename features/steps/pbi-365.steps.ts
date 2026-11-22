// Step definitions for features/pbi-365-feature-change-approve-or-changes.feature.
//
// Each scenario sets up item 482 the way PBI 364 leaves it. The repo is PBI 18's harness, a bare origin with a working
// clone. PBI 152's steps lock "features/pbi-482-orders.feature" (and the refunds file, when the scenario names both) at
// a fresh sign-off commit on the run's branch, factory/pbi-482-r1. The control plane runs on PBI 4's shared test
// database. Item 482 is stored InProgress, with its run at the stage that asked and that stage's attempt 1 failed. Its
// request then goes through requestFeatureChange in src/store/feature-change.ts, as the cell API stores it, which moves
// the item to FeatureChangeRequest. The board is a fake that holds issue "482" in "acme/app". "pia" is a viewer who is
// the Product Owner.
//
// The contract these steps set up, which the code reads:
// - A comment goes through applyComment in src/control/decisions.ts, with `repoHost` among its deps. The /approve and
//   /changes that sign-off uses answer a feature change request too, and only a product owner's apply.
// - /approve commits each file's proposed version to the run's branch with the repo host's commitFiles (src/adapters/
//   types.ts): one commit on top of the branch's head, holding every file of the request. These steps' repo host
//   writes that commit to the scenario's origin. The run's features_lock_sha moves to that commit.
// - A decision on the request is an event of kind "decision", whose actor_id is the deciding user's id and whose
//   payload has `about: "feature_change"` and `kind` "approve" or "changes".
// - After either decision the item is Queued, and the run's next claim resumes at the stage that asked. The steps claim
//   it in SQL, read the cell API's GET context as a new cell would, then put the item back as it was. That context's
//   nextStage is the stage that asked, and a /changes note reaches that stage as one of the findings in its `retry`:
//   `retry.stageId` is the stage, and one finding holds the note, whole.
// - On the item page, a product owner gets the decision as a form next to the Feature change request section. Its
//   buttons read "Approve the change" and "Ask for changes", and it has a <textarea> for the note. Pressing a button
//   posts that form with its fields, the note in the textarea and the button's own name and value. A decision sent
//   from any other login posts `decision=approve` or `decision=changes`, with `note`, to /items/<id>/feature-change,
//   and gets 403.
// - "The cell runs the green stage again" runs PBI 18's engine from the context GET context gave, in a checkout reset
//   to the origin's branch, with PBI 152's scripted agent.
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fakeBacklog } from "../../src/adapters/fake.ts";
import { loadSop, stageAfter } from "../../src/config/sop.ts";
import { cellApi, runToken } from "../../src/control/cell-api.ts";
import { applyComment } from "../../src/control/decisions.ts";
import type { FeatureChangeFile } from "../../src/core/feature-change.ts";
import { createAuth } from "../../src/http/auth.ts";
import { dashboardRoutes } from "../../src/http/routes.ts";
import { startServer } from "../../src/http/server.ts";
import { withTx } from "../../src/store/db.ts";
import { requestFeatureChange } from "../../src/store/feature-change.ts";
import { runTheCell, setUp, type Ctx as CellCtx } from "./pbi-18.steps.ts";
import { at, commit, ensure, featureText, mine as pbi152, pushedHead, ranClean } from "./pbi-152.steps.ts";
import { text } from "./pbi-189.steps.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";

const BRANCH = "factory/pbi-482-r1";
const REPO = "acme/app";
const ORDERS = "features/pbi-482-orders.feature";
const REFUSED = "Then the order is refused";
const HELD = "Then the order is held for review";
const CODE = "export const holdEmptyOrders = true;\n";
const OWNER = "pia";
const SECRET = "pbi-365-cell-secret";
const STAGES = ["red", "green", "self-review", "open-pr", "address"];

type Answer = { status: number; html: string };

type Ctx = {
  /** The stage that asked, and what the scenario's Givens add before the item is built. */
  stage: string;
  greenPushed: string | null;
  built: boolean;
  /** The sign-off commit, and the branch's head when the stage asked. */
  signOff: string;
  askedHead: string;
  files: FeatureChangeFile[];
  itemId: string;
  sourceId: string;
  runId: string;
  board: ReturnType<typeof fakeBacklog>;
  comments: { login: string; body: string; commentId: string }[];
  /** The dashboard, and who is signed in to it. */
  dashboard?: { server: Server; origin: string; close?: () => Promise<void> };
  signedIn: string | null;
  page: Answer | null;
  sent: Answer | null;
  /** The button a press looked for and didn't find, so the Thens can say so. */
  missing: string | null;
  cellApi?: { server: Server; origin: string };
  /** What GET context gave the run's next claim, or why no claim could happen. */
  context?: Record<string, any> | { notResumed: string };
  ran: boolean;
  notRun: string | null;
};

export const isPbi365 = (world: object): boolean => (world as { pbi365?: Ctx }).pbi365 !== undefined;

function mine(world: object): Ctx {
  const x = (world as { pbi365?: Ctx }).pbi365;
  assert.ok(x, "the PBI 365 scenario wasn't set up");
  return x;
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const pool = () => need().pool;
const headers = (login: string) => ({ "x-ms-client-principal-idp": "aad", "x-ms-client-principal-id": login, "x-ms-client-principal-name": login });

Before({ tags: "@pbi-365", ...long }, async function () {
  const d = await testDb();
  assert.ok(d, "src/store/test-db.ts doesn't exist");
  await d.pool.query('truncate item, event, backlog_source, repo, "user", override cascade');
  (this as { pbi365?: Ctx }).pbi365 = {
    stage: "green", greenPushed: null, built: false, signOff: "", askedHead: "", files: [], itemId: "", sourceId: "", runId: "",
    board: fakeBacklog(), comments: [], signedIn: null, page: null, sent: null, missing: null, ran: false, notRun: null,
  };
  await person(this, OWNER, "viewer", true);
});

After({ tags: "@pbi-365", ...long }, async function () {
  const x = (this as { pbi365?: Ctx }).pbi365;
  if (!x) return;
  await x.dashboard?.close?.();
  for (const s of [x.dashboard?.server, x.cellApi?.server]) {
    if (!s) continue;
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  const c = (this as { pbi18?: CellCtx }).pbi18;
  if (c?.root) rmSync(c.root, { recursive: true, force: true });
});

// ---- people ----

/** A user known by their GitHub login, who signs in to the dashboard under the same name. */
export async function person(world: object, login: string, role: string, productOwner: boolean): Promise<void> {
  mine(world);
  await pool().query(
    `insert into "user" (provider, subject, github_login, role, product_owner) values ('microsoft', $1, $1, $2, $3)`,
    [login, role, productOwner]);
}

async function userId(login: string): Promise<string | null> {
  return (await pool().query<{ id: string }>(`select id from "user" where lower(github_login) = lower($1)`, [login])).rows[0]?.id ?? null;
}

Given("{string} is an operator who isn't the Product Owner", long, async function (login: string) {
  await person(this, login, "operator", false);
});

Given("{string} has no account on the factory", long, async function (login: string) {
  mine(this);
  assert.equal(await userId(login), null, `"${login}" has an account on the factory`);
});

// ---- the request, as PBI 364 leaves it ----

Given("the feature change request on item {int} was asked by the {word} stage", function (_item: number, stage: string) {
  assert.ok(STAGES.includes(stage), `${stage} isn't a stage after sign-off`);
  mine(this).stage = stage;
});

Given("the green stage pushed its change to {string} before it asked", function (path: string) {
  mine(this).greenPushed = path;
});

Given("the green stage asked to change both files", function () {
  // PBI 152's step locked both files. The request names each file the run locked.
  assert.equal(pbi152(this).lockedFiles.length, 2, "two feature files weren't locked at sign-off");
});

/** The lock commit's text of `path` with its first Then line changed, as the stage proposed it. */
function proposed(path: string): string {
  const after = path.includes("refunds") ? "Then the refund needs the order's number" : HELD;
  return featureText(path).replace(/^( {4})Then .*$/m, `$1${after}`);
}

/** The repo host's commitFiles, onto the scenario's origin: one commit on top of the branch's head, pushed. */
function repoHost(world: object) {
  const c = cell(world);
  return {
    async commitFiles(p: { repo: string; branch: string; message: string; files: { path: string; text: string }[] }): Promise<string> {
      assert.equal(p.repo.toLowerCase(), REPO, `commitFiles was asked to commit to ${p.repo}`);
      const dir = mkdtempSync(join(c.root, "control-"));
      git(c.root, "clone", "-q", "-b", p.branch, c.origin, dir);
      git(dir, "config", "user.email", "factory@example.com");
      git(dir, "config", "user.name", "factory");
      for (const f of p.files) {
        mkdirSync(dirname(join(dir, f.path)), { recursive: true });
        writeFileSync(join(dir, f.path), f.text);
      }
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "--allow-empty", "-m", p.message);
      git(dir, "push", "-q", "origin", `HEAD:refs/heads/${p.branch}`);
      return git(dir, "rev-parse", "HEAD");
    },
    async readFile(_repo: string, ref: string, path: string) {
      return at(c.dir, ref, path) ?? (() => {
        try {
          return execFileSync("git", ["--git-dir", c.origin, "show", `${ref}:${path}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        } catch {
          return null;
        }
      })();
    },
    async openReviewComments() { return []; },
  };
}

function cell(world: object): CellCtx {
  const c = (world as { pbi18?: CellCtx }).pbi18;
  assert.ok(c, "no repo was set up");
  return c;
}

/**
 * Builds item 482 as it waits in FeatureChangeRequest, once, after the scenario's Givens have said which stage asked,
 * which files were locked and what the stage pushed.
 */
async function built(world: object): Promise<Ctx> {
  const x = mine(world);
  if (x.built) return x;
  x.built = true;
  setUp(world, x.stage, true);
  const { c } = ensure(world);
  x.signOff = c.lockSha!;
  if (x.greenPushed) {
    mkdirSync(dirname(join(c.dir, x.greenPushed)), { recursive: true });
    writeFileSync(join(c.dir, x.greenPushed), CODE);
    commit(c.dir, "green: hold empty orders");
    git(c.dir, "push", "-q", "origin", `HEAD:refs/heads/${BRANCH}`);
  }
  x.askedHead = pushedHead(c);
  x.files = c.lockedFiles.map((path) => ({
    path, reason: path.includes("refunds") ? "A refund needs the order's number" : "An empty order is held, not refused",
    before: featureText(path), after: proposed(path),
  }));

  await x.board.seed({ externalId: "482", title: "Orders", repo: REPO });
  x.sourceId = (await pool().query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'test:' || gen_random_uuid()) returning id")).rows[0].id;
  const repoId = (await pool().query<{ id: string }>(
    `insert into repo (host_adapter, url) values ('github', 'https://github.com/${REPO}') returning id`)).rows[0].id;
  x.itemId = (await pool().query<{ id: string }>(
    `insert into item (source_id, external_id, title, state, lease_generation) values ($1, '482', 'Orders', 'InProgress', 1) returning id`,
    [x.sourceId])).rows[0].id;
  const pr = x.stage === "address" ? 7 : null;
  x.runId = (await pool().query<{ id: string }>(
    `insert into run (item_id, repo_id, run_number, sop_version, config_sha, branch, next_stage, scenarios_sha, features_lock_sha, locked_files,
       signed_off_by, signed_off_at, pr_number, pr_url)
     values ($1, $2, 1, '0.1.0', 'c0ffee', $3, $4, $5, $5, $6, (select id from "user" where github_login = $7), now(), $8, $9) returning id`,
    [x.itemId, repoId, BRANCH, x.stage, x.signOff, c.lockedFiles, OWNER, pr, pr ? `https://github.com/${REPO}/pull/7` : null])).rows[0].id;
  await pool().query(
    `insert into stage_run (run_id, stage_id, attempt, model, status, ended_at, message)
     values ($1, $2, 1, 'claude-opus-5-5', 'failed', now(), 'The stage asks to change a locked feature file.')`, [x.runId, x.stage]);
  await withTx(pool(), (t) => requestFeatureChange(t, x.runId, x.files));
  assert.equal(await state(x), "FeatureChangeRequest", "item 482 didn't move to FeatureChangeRequest");
  return x;
}

async function state(x: Ctx): Promise<string> {
  return (await pool().query<{ state: string }>("select state from item where id = $1", [x.itemId])).rows[0].state;
}

async function lock(x: Ctx): Promise<string | null> {
  return (await pool().query<{ sha: string | null }>("select features_lock_sha as sha from run where id = $1", [x.runId])).rows[0].sha;
}

// ---- comments ----

async function comment(world: object, login: string, body: string, again = false): Promise<void> {
  const x = await built(world);
  const e = again ? x.comments.at(-1) : { login, body, commentId: `c${x.comments.length + 1}` };
  assert.ok(e, "no comment was made");
  if (!again) x.comments.push(e);
  x.context = undefined;
  await applyComment(
    { pool: pool(), adapter: x.board.adapter, sourceId: x.sourceId, repoHost: repoHost(world) } as Parameters<typeof applyComment>[0],
    { externalId: "482", repo: REPO, login: e.login, body: e.body, commentId: e.commentId },
    new Date(),
  );
}

When("{string} comments {string} on item {int}", long, async function (login: string, body: string, _item: number) {
  await comment(this, login, body);
});

Given("{string} has commented {string} on item {int}", long, async function (login: string, body: string, _item: number) {
  await comment(this, login, body);
});

When("{string} comments on item {int}:", long, async function (login: string, _item: number, body: string) {
  await comment(this, login, body);
});

When("the factory handles that comment a second time", long, async function () {
  await comment(this, "", "", true);
});

Then("{string} gets a reply saying only the Product Owner can decide", long, async function (login: string) {
  const x = mine(this);
  const all = await x.board.comments("482");
  const replies = all.filter((b) => b.startsWith(`@${login} `));
  assert.ok(replies.length > 0, `"${login}" got no reply; item 482's comments: ${all.join(" | ") || "none"}`);
  assert.ok(replies.some((b) => /only (?:a|the) product owner/i.test(b)), `the reply to "${login}" doesn't say only the Product Owner can decide: ${replies.join(" | ")}`);
});

// ---- where the item stands ----

Then("item {int} is no longer in FeatureChangeRequest", long, async function (_item: number) {
  const x = await built(this);
  assert.notEqual(await state(x), "FeatureChangeRequest", "item 482 is still in FeatureChangeRequest");
});

Then("item {int} is still in FeatureChangeRequest", long, async function (_item: number) {
  const x = await built(this);
  assert.equal(await state(x), "FeatureChangeRequest");
});

async function decisions(x: Ctx): Promise<{ kind: string; actor_id: string; about: string | null }[]> {
  return (await pool().query<{ kind: string; actor_id: string; about: string | null }>(
    `select payload->>'kind' as kind, actor_id, payload->>'about' as about from event
     where item_id = $1 and kind = 'decision' order by at`, [x.itemId])).rows;
}

async function recorded(world: object, kind: "approve" | "changes", login: string) {
  const x = await built(world);
  const id = await userId(login);
  assert.ok(id, `"${login}" has no account`);
  const all = (await decisions(x)).filter((d) => d.about === "feature_change");
  assert.ok(all.length > 0, "no decision on the feature change request is recorded");
  assert.deepEqual(all.map((d) => ({ kind: d.kind, by: d.actor_id })), [{ kind, by: id }],
    `the decisions recorded on the feature change request aren't one ${kind} by "${login}"`);
}

Then("the feature change request on item {int} is recorded as approved by {string}", long, async function (_item: number, login: string) {
  await recorded(this, "approve", login);
});

Then("the feature change request on item {int} is recorded as turned down by {string}", long, async function (_item: number, login: string) {
  await recorded(this, "changes", login);
});

// ---- the branch and the lock ----

function head(world: object): string {
  return pushedHead(cell(world));
}

function newCommits(world: object, x: Ctx): string[] {
  const out = git(cell(world).root, "--git-dir", cell(world).origin, "rev-list", `${x.askedHead}..${head(world)}`);
  return out ? out.split("\n") : [];
}

function theNewCommit(world: object, x: Ctx): string {
  const added = newCommits(world, x);
  assert.ok(added.length > 0, "the item's branch has no new commit");
  return head(world);
}

const show = (world: object, rev: string, path: string) => {
  try {
    return execFileSync("git", ["--git-dir", cell(world).origin, "show", `${rev}:${path}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
};

const holds = (text: string | null, step: string) => (text ?? "").split("\n").some((l) => l.trim() === step);

Then("the lock of item {int} is still the sign-off commit", long, async function (_item: number) {
  const x = await built(this);
  assert.equal(await lock(x), x.signOff, "the lock moved from the sign-off commit");
});

Then("the lock of item {int} moves to a new commit", long, async function (_item: number) {
  const x = await built(this);
  const l = await lock(x);
  assert.notEqual(l, x.signOff, "the lock is still the sign-off commit");
  assert.equal(l, head(this), "the lock isn't the head of the item's branch");
});

Then("the lock of item {int} is the new commit on the item's branch", long, async function (_item: number) {
  const x = await built(this);
  const sha = theNewCommit(this, x);
  assert.equal(await lock(x), sha, "the lock isn't the new commit on the item's branch");
});

Then("the lock of item {int} is that commit", long, async function (_item: number) {
  const x = await built(this);
  const sha = theNewCommit(this, x);
  assert.equal(await lock(x), sha, "the lock isn't the new commit");
});

Then("the item's branch has a new commit", long, async function () {
  theNewCommit(this, await built(this));
});

Then("the item's branch has exactly one new commit", long, async function () {
  const x = await built(this);
  const added = newCommits(this, x);
  assert.equal(added.length, 1, `the item's branch has ${added.length} new commits`);
});

Then("the item's branch has no new commit", long, async function () {
  const x = await built(this);
  assert.deepEqual(newCommits(this, x), [], "the item's branch has a new commit");
});

Then("at that commit {string} holds the step {string}", long, async function (path: string, step: string) {
  const x = await built(this);
  const text = show(this, theNewCommit(this, x), path);
  assert.ok(holds(text, step), `${path} at the new commit doesn't hold "${step}":\n${text}`);
});

Then("at that commit {string} no longer holds the step {string}", long, async function (path: string, step: string) {
  const x = await built(this);
  const text = show(this, theNewCommit(this, x), path);
  assert.ok(text !== null, `the new commit holds no ${path}`);
  assert.ok(!holds(text, step), `${path} at the new commit still holds "${step}"`);
});

Then("at that commit both files hold the versions the green stage proposed", long, async function () {
  const x = await built(this);
  const sha = theNewCommit(this, x);
  assert.equal(x.files.length, 2, "the request doesn't name two files");
  for (const f of x.files) assert.equal(show(this, sha, f.path), f.after, `${f.path} at the new commit isn't the version the green stage proposed`);
});

Then("{string} at the lock holds the step {string}", long, async function (path: string, step: string) {
  const x = await built(this);
  const l = await lock(x);
  assert.ok(l, "item 482 has no lock");
  const text = show(this, l, path);
  assert.ok(holds(text, step), `${path} at the lock ${l.slice(0, 7)} doesn't hold "${step}"`);
});

Then("the new commit's parent is the head of the branch the green stage pushed", long, async function () {
  const x = await built(this);
  const sha = theNewCommit(this, x);
  assert.equal(git(cell(this).root, "--git-dir", cell(this).origin, "rev-parse", `${sha}^`), x.askedHead, "the new commit doesn't go on top of the green stage's work");
});

Then("the green stage's change to {string} is still on the item's branch", long, async function (path: string) {
  await built(this);
  assert.equal(show(this, head(this), path), CODE, `${path} on the item's branch doesn't hold the green stage's change`);
});

Then("{string} on the item's branch holds the step {string}", long, async function (path: string, step: string) {
  await built(this);
  assert.ok(holds(show(this, head(this), path), step), `${path} on the item's branch doesn't hold "${step}"`);
});

// ---- the next claim ----

function cellApiOrigin(world: object, x: Ctx): Promise<string> | string {
  if (x.cellApi) return x.cellApi.origin;
  const sop = loadSop(readFileSync(join(process.cwd(), "sop/default.yml"), "utf8"));
  return startServer([cellApi({
    pool: pool(), secret: SECRET, repoHost: repoHost(world) as never, backlogFor: () => x.board.adapter,
    stageAfter: (_version, stageId) => stageAfter(sop, stageId), uploadUrl: async (path) => `http://blob.test/${path}`,
    gateway: { upstream: "http://model.test", ownerToken: () => "unused" }, webToolsOf: () => [],
  })], { port: 0 }).then((server) => {
    x.cellApi = { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
    return x.cellApi.origin;
  });
}

/**
 * What the run's next claim gets: the item claimed from Queued, as the scheduler claims it, and GET context read as the
 * new cell reads it. The item is put back as it was after, so the Thens that follow see it as the decision left it.
 */
async function nextClaim(world: object): Promise<Record<string, any> | { notResumed: string }> {
  const x = await built(world);
  if (x.context) return x.context;
  const now = await state(x);
  if (now !== "Queued") return (x.context = { notResumed: `item 482 is ${now}, not Queued, so no cell resumes it` });
  const g = (await pool().query<{ generation: number }>(
    `update item set state = 'InProgress', lease_generation = lease_generation + 1, lease_owner = 'cell-365', lease_expires = now() + interval '5 minutes'
     where id = $1 returning lease_generation as generation`, [x.itemId])).rows[0].generation;
  try {
    const r = await fetch(`${await cellApiOrigin(world, x)}/internal/cells/${x.runId}/context`, { headers: { authorization: `Bearer ${runToken(SECRET, x.runId, g)}` } });
    const body = await r.text();
    assert.equal(r.status, 200, `the cell API's context answered ${r.status}: ${body}`);
    x.context = JSON.parse(body) as Record<string, any>;
  } finally {
    await pool().query("update item set state = $2, lease_owner = null, lease_expires = null where id = $1", [x.itemId, now]);
  }
  return x.context;
}

function resumed(c: Record<string, any> | { notResumed: string }): Record<string, any> {
  assert.ok(!("notResumed" in c), (c as { notResumed: string }).notResumed);
  return c;
}

Then(/^item (\d+)'s run resumes at (red|green|self-review|open-pr|address)$/, long, async function (_item: string, stage: string) {
  const c = resumed(await nextClaim(this));
  assert.equal(c.nextStage, stage, `the run's next claim resumes at ${c.nextStage}`);
});

function findingsOf(c: Record<string, any>, stage: string): string[] {
  const r = c.retry as { stageId?: string; findings?: string[] } | null | undefined;
  return r?.stageId === stage ? r.findings ?? [] : [];
}

Then(/^the (red|green|self-review|open-pr|address) stage's findings hold the note "([^"]*)"$/, long, async function (stage: string, note: string) {
  const c = resumed(await nextClaim(this));
  const found = findingsOf(c, stage);
  assert.ok(found.some((f) => f.includes(note)), `the ${stage} stage's findings don't hold "${note}": ${JSON.stringify(c.retry ?? null)}`);
});

Then("the green stage's findings don't hold the note {string}", long, async function (note: string) {
  const c = await nextClaim(this);
  if ("notResumed" in c) return;
  const found = findingsOf(c, "green");
  assert.ok(!found.some((f) => f.includes(note)), `the green stage's findings hold "${note}"`);
});

Then("the green stage's findings hold the note's lines {string} and {string}, in that order", long, async function (a: string, b: string) {
  const c = resumed(await nextClaim(this));
  const found = findingsOf(c, "green");
  const whole = found.find((f) => f.includes(a) && f.includes(b));
  assert.ok(whole, `no finding of the green stage holds both "${a}" and "${b}": ${JSON.stringify(found)}`);
  assert.ok(whole.indexOf(a) < whole.indexOf(b), `the finding holds "${b}" before "${a}"`);
});

// ---- the resumed cell ----

async function runAgain(world: object, edit: string | null) {
  const x = await built(world);
  const ctx = await nextClaim(world);
  if ("notResumed" in ctx) {
    x.notRun = ctx.notResumed;
    return;
  }
  const { c, m } = ensure(world);
  // A new cell clones the branch as the origin holds it.
  git(c.dir, "fetch", "-q", "origin");
  git(c.dir, "checkout", "-q", "-B", BRANCH, `origin/${BRANCH}`);
  git(c.dir, "reset", "-q", "--hard", `origin/${BRANCH}`);
  c.nextStage = ctx.nextStage;
  c.lockSha = ctx.lockSha;
  c.lockedFiles = ctx.lockedFiles;
  c.decision = ctx.decision;
  c.prNumber = ctx.prNumber;
  c.startHead = pushedHead(c);
  c.context = { retry: ctx.retry ?? null, stageAttempts: ctx.stageAttempts ?? {}, resume: ctx.resume ?? null, scenarioNotes: ctx.scenarioNotes ?? [] };
  if (edit) {
    m.actions.push({ role: "green", n: 1, act: (cwd) => {
      const file = join(cwd, edit);
      writeFileSync(file, readFileSync(file, "utf8").replace(/^( {4})Then .*$/m, "$1Then the order is saved as a draft"));
    } });
  }
  await runTheCell(world);
  x.ran = true;
}

When("the cell runs the green stage again", { timeout: 120_000 }, async function () {
  await runAgain(this, null);
});

When("the cell runs the green stage again and the green agent leaves {string} alone", { timeout: 120_000 }, async function (_path: string) {
  await runAgain(this, null);
});

When("the cell runs the green stage again and the green agent edits {string} without asking", { timeout: 120_000 }, async function (path: string) {
  await runAgain(this, path);
});

When("the factory takes item {int} through the rest of its run to its pull request", { timeout: 120_000 }, async function (_item: number) {
  await runAgain(this, null);
});

function ran(world: object): CellCtx {
  const x = mine(world);
  assert.ok(x.ran, `the cell never ran again: ${x.notRun}`);
  const c = cell(world);
  ranClean(c);
  return c;
}

Then("{string} on the pushed branch holds the step {string}", long, async function (path: string, step: string) {
  const c = ran(this);
  assert.ok(holds(at(c.dir, pushedHead(c), path), step), `${path} on the pushed branch doesn't hold "${step}"`);
});

Then("{string} on the pushed branch matches the new lock", long, async function (path: string) {
  const c = ran(this);
  const x = mine(this);
  const l = await lock(x);
  assert.notEqual(l, x.signOff, "the lock never moved from the sign-off commit");
  assert.equal(at(c.dir, pushedHead(c), path), show(this, l!, path), `${path} on the pushed branch differs from the new lock`);
});

Then("{string} on the pushed branch matches the sign-off commit", long, async function (path: string) {
  const c = ran(this);
  assert.equal(at(c.dir, pushedHead(c), path), show(this, mine(this).signOff, path), `${path} on the pushed branch differs from the sign-off commit`);
});

Then("the green stage doesn't restore {string}", long, async function (path: string) {
  const c = ran(this);
  const touched = git(c.root, "--git-dir", c.origin, "log", "--format=%s", `${c.startHead}..${pushedHead(c)}`, "--", path);
  assert.equal(touched, "", `the run changed ${path} after the new lock: ${touched}`);
});

Then("the green agent's brief holds the note {string}", long, async function (note: string) {
  ran(this);
  const briefs = pbi152(this).seen.filter((s) => s.role === "green");
  assert.ok(briefs.length > 0, "the green agent never ran");
  assert.ok(briefs[0].prompt.includes(note), `the green agent's brief doesn't hold "${note}"`);
});

Then("{string} in the PR holds the step {string}", long, async function (path: string, step: string) {
  const c = ran(this);
  const opened = pbi152(this).openedAt.at(-1);
  assert.ok(opened, "no PR was opened");
  assert.ok(holds(at(c.dir, opened, path), step), `${path} in the PR doesn't hold "${step}"`);
});

Then("the owner is asked no question about a locked feature file", long, async function () {
  const c = ran(this);
  const moves = c.calls.filter((y) => y.route === "/transition").map((y) => y.body);
  const asked = moves.filter((b) => b.event === "feature_change_requested" || /feature file|locked/i.test(String(b.question?.body ?? "")));
  assert.deepEqual(asked.map((b) => b.event), [], "the owner was asked about a locked feature file");
});

// ---- the item page ----

async function dashboard(world: object): Promise<NonNullable<Ctx["dashboard"]>> {
  const x = await built(world);
  if (x.dashboard) return x.dashboard;
  let handler: ReturnType<typeof dashboardRoutes> | undefined;
  const server = await startServer([(req, res) => handler!(req, res)], { port: 0 });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  handler = dashboardRoutes({
    pool: pool(), auth: createAuth({ mode: "azure" }), origin, adapter: x.board.adapter, sourceId: x.sourceId, repoHost: repoHost(world) as never,
  });
  x.dashboard = { server, origin, close: handler.close };
  return x.dashboard;
}

Given("{string} is signed in", long, async function (login: string) {
  await dashboard(this);
  mine(this).signedIn = login;
});

export async function openPage(world: object, login: string): Promise<void> {
  const x = await built(world);
  const d = await dashboard(world);
  const r = await fetch(`${d.origin}/items/${x.itemId}`, { headers: { ...headers(login), cookie: "tz=UTC" }, redirect: "manual" });
  x.page = { status: r.status, html: await r.text() };
}

function page(world: object): string {
  const p = mine(world).page;
  assert.ok(p, "no item page was opened");
  assert.equal(p.status, 200, `the item page answered ${p.status}: ${p.html.slice(0, 300)}`);
  return p.html;
}

type Button = { label: string; index: number; name: string | null; value: string | null };
type Form = { action: string; html: string; index: number; buttons: Button[] };

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? (m[2] ?? m[3] ?? "").replace(/&amp;/g, "&").replace(/&quot;/g, '"') : null;
};

function buttons(html: string, offset = 0): Button[] {
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)]
    .map((m) => ({ label: text(m[2]), index: offset + m.index!, name: attr(m[1], "name"), value: attr(m[1], "value") }));
}

function forms(html: string): Form[] {
  return [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)]
    .map((m) => ({ action: attr(m[1], "action") ?? "", html: m[2], index: m.index!, buttons: buttons(m[2], m.index!) }));
}

Then("the page shows the {string} button and the {string} button", function (a: string, b: string) {
  const all = buttons(page(this)).map((x) => x.label);
  for (const label of [a, b]) assert.ok(all.includes(label), `the page shows no "${label}" button; its buttons: ${all.join(", ") || "none"}`);
});

Then("the page doesn't show the {string} button", function (label: string) {
  const all = buttons(page(this)).map((x) => x.label);
  assert.ok(!all.includes(label), `the page shows the "${label}" button`);
});

Then("the page shows a box for a note for the factory", function () {
  const f = forms(page(this)).find((y) => y.buttons.some((b) => b.label === "Ask for changes"));
  assert.ok(f, "no form on the page has an \"Ask for changes\" button");
  assert.match(f.html, /<textarea\b[^>]*\bname="note"/i, "the form with \"Ask for changes\" has no box for a note");
});

Then("the change to {string} and its reason come before the {string} button", function (path: string, label: string) {
  const html = page(this);
  const x = mine(this);
  const button = buttons(html).find((b) => b.label === label);
  assert.ok(button, `the page shows no "${label}" button`);
  const heading = [...html.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi)].find((m) => text(m[1]) === path);
  assert.ok(heading, `the page has no heading "${path}"`);
  const reason = x.files.find((f) => f.path === path)!.reason;
  const at = html.indexOf(reason, heading.index);
  assert.ok(at >= 0, `the page doesn't give the reason "${reason}" after ${path}`);
  assert.ok(heading.index! < button.index && at < button.index, `the change to ${path} and its reason don't come before the "${label}" button`);
});

Then("the page shows the change to {string}", function (path: string) {
  const html = page(this);
  const section = html.split(/<h2\b[^>]*>/i).slice(1).find((p) => text(p.slice(0, p.search(/<\/h2>/i))) === "Feature change request");
  assert.ok(section, "the item page has no Feature change request section");
  const parts = section.split(/<h3\b[^>]*>/i).slice(1);
  const entry = parts.find((p) => text(p.slice(0, p.search(/<\/h3>/i))) === path);
  assert.ok(entry, `the Feature change request section doesn't name ${path}`);
  assert.match(entry, /data-side="before"/, `the entry for ${path} shows no line before`);
  assert.match(entry, /data-side="after"/, `the entry for ${path} shows no line after`);
});

Then("the page says {string} approved the feature change request", function (login: string) {
  const all = text(page(this));
  const said = all.split(/(?<=[.!?])\s+|\n+/).some((s) => new RegExp(`\\b${login}\\b`).test(s) && /\bapproved\b/i.test(s) && /feature change/i.test(s));
  assert.ok(said, `the page doesn't say "${login}" approved the feature change request: ${all.slice(0, 600)}`);
});

async function post(world: object, login: string, action: string, fields: Record<string, string>): Promise<Answer> {
  const d = await dashboard(world);
  const r = await fetch(`${d.origin}${action}`, {
    method: "POST", redirect: "manual", body: new URLSearchParams(fields).toString(),
    headers: { ...headers(login), origin: d.origin, cookie: "tz=UTC", "content-type": "application/x-www-form-urlencoded" },
  });
  const answer = { status: r.status, html: await r.text() };
  mine(world).sent = answer;
  mine(world).context = undefined;
  return answer;
}

/** Presses the button on the page the login has open: posts its form, the note in the form's textarea. */
async function press(world: object, login: string, label: string, note: string | null) {
  await openPage(world, login);
  const x = mine(world);
  const f = forms(page(world)).find((y) => y.buttons.some((b) => b.label === label));
  if (!f) {
    x.missing = label;
    return;
  }
  const fields: Record<string, string> = {};
  for (const m of f.html.matchAll(/<input\b([^>]*)>/gi)) {
    const name = attr(m[1], "name");
    if (name && (attr(m[1], "type") ?? "text").toLowerCase() === "hidden") fields[name] = attr(m[1], "value") ?? "";
  }
  for (const m of f.html.matchAll(/<textarea\b([^>]*)>/gi)) {
    const name = attr(m[1], "name");
    if (name) fields[name] = note ?? "";
  }
  const b = f.buttons.find((y) => y.label === label)!;
  if (b.name) fields[b.name] = b.value ?? "";
  await post(world, login, f.action, fields);
}

const signedIn = (world: object, login: string) => {
  const x = mine(world);
  assert.equal(x.signedIn, login, `"${login}" isn't signed in`);
};

When("{string} presses {string} on item {int}'s page", long, async function (login: string, label: string, _item: number) {
  signedIn(this, login);
  await press(this, login, label, null);
});

Given("{string} has pressed {string} on item {int}'s page", long, async function (login: string, label: string, _item: number) {
  mine(this).signedIn = login;
  await press(this, login, label, null);
});

When("{string} writes the note {string} and presses {string} on item {int}'s page", long, async function (login: string, note: string, label: string, _item: number) {
  signedIn(this, login);
  await press(this, login, label, note);
});

Given("{string} has written the note {string} and pressed {string} on item {int}'s page", long, async function (login: string, note: string, label: string, _item: number) {
  mine(this).signedIn = login;
  await press(this, login, label, note);
});

When("{string} writes this note and presses {string} on item {int}'s page:", long, async function (login: string, label: string, _item: number, note: string) {
  signedIn(this, login);
  await press(this, login, label, note);
});

When("{string} sends an Approve of the feature change request on item {int}", long, async function (login: string, _item: number) {
  const x = await built(this);
  await post(this, login, `/items/${x.itemId}/feature-change`, { decision: "approve", note: "" });
});

When("{string} sends an Ask for changes with the note {string} on item {int}", long, async function (login: string, note: string, _item: number) {
  const x = await built(this);
  await post(this, login, `/items/${x.itemId}/feature-change`, { decision: "changes", note });
});

Then("the decision is refused", function () {
  const s = mine(this).sent;
  assert.ok(s, "no decision was sent");
  assert.equal(s.status, 403, `the decision got ${s.status}, not a refusal: ${s.html.slice(0, 300)}`);
});
