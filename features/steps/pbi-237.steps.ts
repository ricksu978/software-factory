// Step definitions for features/pbi-237-split-children-opted-in.feature. The Background is PBI 144's: its fake board,
// its scripted SplitBoard (sub-issues, the board's statuses, blocks and one-shot refusals) and its link-comment steps.
// What this item adds is about the factory's own records, the item rows, their history, the dashboard and the
// scheduler, so here a poll is the real poller, on the cell's database, over that same board: a Before hook gives PBI
// 144's harness a driver, and every "the factory polls the backlog" step shared with PBI 144 runs pollOnce. The judge
// and the coding model are scripted, the repo host is the in-memory fake, and the scheduler starts cells through a
// recorder, so no model, no container and no network is needed.
//
// A step that both features word the same way, such as "the factory holds child X as an item" or "child X carries the
// label", is a precondition in a Given and an outcome in a Then. Cucumber ignores the keyword, so a BeforeStep hook
// records the step's type. In a Given it checks only that the child was filed; the outcome it sets up is checked by the
// scenario's Thens.
import { Before, BeforeStep, DataTable, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { fakeBacklog, fakeRepoHost } from "../../src/adapters/fake.ts";
import type { BacklogAdapter, FactoryItem } from "../../src/adapters/types.ts";
import type { AgentArgs, AgentResult } from "../../src/agent/run.ts";
import { SPLIT_HEADING, type SplitDeps } from "../../src/gate/split.ts";
import { createAuth } from "../../src/http/auth.ts";
import { dashboardRoutes } from "../../src/http/routes.ts";
import { startServer } from "../../src/http/server.ts";
import type { Policy } from "../../src/policy/policy.ts";
import { tick } from "../../src/scheduler/scheduler.ts";
import { pollOnce } from "../../src/watcher/poller.ts";
import { baseFiles } from "./pbi-12.steps.ts";
import { scope } from "./pbi-131.steps.ts";
import { ctx as ctx144, polled, refuse, scriptedBoard, type Ctx as Ctx144 } from "./pbi-144.steps.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";

const REPO = "acme/shop";
const HEADING = "Acceptance criteria";
const VIEWER = "pbi-237-viewer";

type Host = ReturnType<typeof fakeRepoHost>;

type Ctx = {
  sourceId: string;
  host: Host;
  /** The repo's dor.md lines, which a Given may add to before the first poll. */
  dor: string[];
  /** How many repo commits the scenario has made, so a changed dor.md lands at a new head. */
  commits: number;
  /** How often the judge was asked about each item, by external id. */
  asked: Map<string, number>;
  /** Children the judge finds oversized, by title. */
  oversized: Set<string>;
  /** The one dor.md line the judge fails for a child, by title. */
  fails: Map<string, string>;
  /** The coding model's split of a child, by the child's title. Any other item gets PBI 144's split of the parent. */
  replies: Map<string, string>;
  /** The item whose link comment "that comment" means. Unset, the parent's. */
  subject?: string;
  /** The type of the step running now: "Context" for a Given, "Outcome" for a Then. */
  stepType?: string;
  looked: boolean;
};

function ctx(world: object): Ctx {
  const w = world as { pbi237?: Ctx };
  assert.ok(w.pbi237, "the PBI 237 harness wasn't set up");
  return w.pbi237;
}

const pool = () => need().pool;

function commit(k: Ctx): void {
  const sha = `c${++k.commits}`;
  const files = { ...baseFiles, ".factory/dor.md": `${k.dor.map((l) => `- [ ] ${l}`).join("\n")}\n` };
  for (const [path, text] of Object.entries(files)) k.host.files.set(`${REPO}@${sha}:${path}`, text);
  k.host.heads.set(REPO, sha);
}

Before({ tags: "@pbi-237", ...long }, async function () {
  const d = await testDb();
  assert.ok(d, "no test database");
  await d.pool.query('truncate item, event, override, backlog_source, repo, "user" cascade');
  await d.pool.query("update wip_policy set mode = 'fixed', current_wip = 3, review_capacity = 3, usage_paused_until = null");
  const sourceId = (await d.pool.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'test:' || gen_random_uuid()) returning id")).rows[0].id;
  await d.pool.query("insert into repo (host_adapter, url) values ('fake', $1)", [`https://github.com/${REPO}`]);
  const k: Ctx = {
    sourceId, host: fakeRepoHost(), dor: ["Has a title"], commits: 0, asked: new Map(), oversized: new Set(), fails: new Map(),
    replies: new Map(), looked: false,
  };
  commit(k);
  (this as { pbi237?: Ctx }).pbi237 = k;
  ctx144(this).driver = (c) => realPoll(k, c);
});

BeforeStep({ tags: "@pbi-237" }, function ({ pickleStep }) {
  ctx(this).stepType = pickleStep.type;
});

const given = (k: Ctx) => k.stepType === "Context";

// --- The real poller over PBI 144's board --------------------------------------------------------------------------

/** The judge passes every dor.md line but the one a step fails for a child, and finds the items set oversized. */
function judge(k: Ctx, c: Ctx144) {
  return async (item: FactoryItem, dor: { criteria: { index: number }[] }) => {
    k.asked.set(item.externalId, (k.asked.get(item.externalId) ?? 0) + 1);
    const fail = k.fails.get(item.title);
    const lines = (dor as Policy).criteria.map((cr) => {
      const failed = fail === cr.text;
      return JSON.stringify({ index: cr.index, status: failed ? "failed" : "passed", reason: failed ? `The item doesn't: ${cr.text}` : "ok" });
    });
    const oversized = (c.oversized && item.externalId === c.parentId) || k.oversized.has(item.title);
    return [...lines, JSON.stringify({ flags: [], oversized })].join("\n");
  };
}

/** The coding model answers a child's split for a request about that child, and the parent's split otherwise. */
function agent(k: Ctx, c: Ctx144) {
  return async (a: AgentArgs): Promise<AgentResult> => {
    c.requests.push(a);
    const own = [...k.replies].find(([title]) => a.prompt.includes(JSON.stringify(title)));
    return { ok: true, text: own ? own[1] : c.reply, costUsd: 0, tokensIn: 0, tokensOut: 0, model: a.model, limit: null, usage: null, transcript: "" };
  };
}

async function realPoll(k: Ctx, c: Ctx144): Promise<void> {
  assert.equal(c.repo, REPO, `the scenario's repo is ${c.repo}`);
  const adapter: BacklogAdapter = {
    ...c.fake.adapter,
    // A child's open blockers, as GitHub's blocked-by relation reads them.
    async openDependencies(id: string) {
      const open: string[] = [];
      for (const b of c.blocks.get(id) ?? []) if (!(await c.fake.adapter.getItem(b))?.closed) open.push(b);
      return open;
    },
    async comment(id: string, body: string, key: string) {
      if (id === c.parentId && !body.startsWith(SPLIT_HEADING)) refuse(c, "comment", "parent");
      return c.fake.adapter.comment(id, body, key);
    },
  };
  const split: SplitDeps = {
    sop: { models: { coding: "coding-model" } }, agent: agent(k, c), seen: c.seen,
    file: { board: scriptedBoard(c), optInLabel: c.label, backlogStatus: c.backlogStatus, criteriaHeading: HEADING },
  };
  try {
    await pollOnce({ pool: pool(), adapter, repoHost: k.host, judge: judge(k, c), sourceId: k.sourceId, split });
  } catch (e) {
    c.errors.push(e);
  }
  c.polls++;
}

// --- Lookups -------------------------------------------------------------------------------------------------------

function filed(c: Ctx144, title: string) {
  const found = c.filed.filter((i) => i.title === title);
  assert.ok(found.length > 0, `no child "${title}" was filed`);
  assert.equal(found.length, 1, `child "${title}" was filed ${found.length} times`);
  return found[0];
}

function child(world: object, title: string) {
  const c = ctx144(world);
  polled(c);
  return filed(c, title);
}

async function boardItem(c: Ctx144, id: string): Promise<FactoryItem> {
  const fi = await c.fake.adapter.getItem(id);
  assert.ok(fi, `no issue ${id} on the board`);
  return fi;
}

async function row(k: Ctx, ext: string): Promise<{ id: string; state: string } | undefined> {
  return (await pool().query<{ id: string; state: string }>("select id, state from item where source_id = $1 and external_id = $2", [k.sourceId, ext])).rows[0];
}

async function held(world: object, title: string): Promise<{ id: string; state: string }> {
  const ch = child(world, title);
  const r = await row(ctx(world), ch.externalId);
  assert.ok(r, `the factory holds no item for child "${title}"`);
  return r;
}

async function labelled(world: object, title: string, label: string): Promise<boolean> {
  const c = ctx144(world);
  return (await boardItem(c, child(world, title).externalId)).labels.includes(label);
}

const titleOf = (c: Ctx144, id: string) => c.filed.find((i) => i.externalId === id)?.title ?? `#${id}`;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const links = (body: string, url: string) => new RegExp(`${escape(url)}(?!\\d)`).test(body);

/** The item's comments that link to a filed issue other than itself. */
async function linkComments(c: Ctx144, id: string): Promise<string[]> {
  return (await c.fake.comments(id)).filter((b) => c.filed.some((i) => i.externalId !== id && links(b, i.url)));
}

async function thatComment(world: object): Promise<string> {
  const c = ctx144(world);
  polled(c);
  const found = await linkComments(c, ctx(world).subject ?? c.parentId!);
  assert.equal(found.length, 1, `comments linking to a child: ${found.length}`);
  return found[0];
}

const sentences = (body: string) => body.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
const negated = (s: string) => /\b(none|no|not|never|without|nor)\b|n't\b/i.test(s);
const namesLabel = (s: string, label: string) => s.includes(label) && /\blabel/i.test(s);

/** Floor's "Not ready" section as the dashboard renders it now. */
async function notReadyList(k: Ctx): Promise<string> {
  await pool().query(
    `insert into "user" (provider, subject, github_login, role) values ('microsoft', $1, $1, 'viewer') on conflict (provider, subject) do nothing`,
    [VIEWER],
  );
  let handler: ReturnType<typeof dashboardRoutes> | undefined;
  const server = await startServer([(req, res) => handler!(req, res)], { port: 0 });
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    handler = dashboardRoutes({ pool: pool(), auth: createAuth({ mode: "azure" }), origin, adapter: fakeBacklog().adapter, sourceId: k.sourceId });
    try {
      const r = await fetch(`${origin}/`, {
        headers: { "x-ms-client-principal-idp": "aad", "x-ms-client-principal-id": VIEWER, "x-ms-client-principal-name": VIEWER },
      });
      const html = await r.text();
      assert.equal(r.status, 200, `Floor answered ${r.status}: ${html.slice(0, 300)}`);
      return scope(html, '"Not ready"');
    } finally {
      await handler.close();
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const indices = (cell: string) => cell.split(",").map((s) => s.trim()).filter(Boolean).map(Number);

function splitReply(table: DataTable): string {
  const rows = table.hashes().sort((a, b) => Number(a.child) - Number(b.child));
  return JSON.stringify({ children: rows.map((r) => ({ title: r.title, body: r.body, criteria: indices(r.criteria), needs: indices(r.needs) })) });
}

async function setLabels(c: Ctx144, id: string, change: (labels: string[]) => string[]): Promise<void> {
  const fi = await boardItem(c, id);
  await c.fake.seed({ ...fi, labels: change(fi.labels), externalId: id });
}

// --- Background ----------------------------------------------------------------------------------------------------

Given("the owner filed the parent issue by hand", async function () {
  const c = ctx144(this);
  assert.ok(c.parentId, "no parent issue");
  const fi = await boardItem(c, c.parentId);
  assert.ok(!/factory-split-/.test(fi.body), "the parent's body says the factory filed it");
});

// --- The judge and the coding model --------------------------------------------------------------------------------

Given("the readiness judge passes every line for child {string}", function (title: string) {
  ctx(this).fails.delete(title);
});

Given("the readiness judge passes every line for every child", function () {
  ctx(this).fails.clear();
});

Given("the readiness judge fails child {string} on the line {string}", function (title: string, line: string) {
  const k = ctx(this);
  assert.equal(ctx144(this).polls, 0, "the dor.md changed after a poll");
  if (!k.dor.includes(line)) {
    k.dor.push(line);
    commit(k);
  }
  k.fails.set(title, line);
});

Given("the readiness judge finds child {string} oversized", function (title: string) {
  ctx(this).oversized.add(title);
});

Given("the coding model proposes this split of child {string}:", function (title: string, table: DataTable) {
  ctx(this).replies.set(title, splitReply(table));
});

// --- Polls, the board and the scheduler ----------------------------------------------------------------------------

const pollN = async (world: object, n: number) => {
  const c = ctx144(world);
  for (let i = 0; i < n; i++) await c.driver!(c);
};

Given("the factory has polled the backlog twice", long, async function () {
  await pollN(this, 2);
});

Given("the factory has polled the backlog twice more", long, async function () {
  await pollN(this, 2);
});

When("the factory polls the backlog {int} more times", long, async function (n: number) {
  await pollN(this, n);
});

When("the scheduler looks for work", long, async function () {
  const c = ctx144(this);
  const k = ctx(this);
  const started: Record<string, string>[] = [];
  await tick({
    pool: pool(), now: new Date(), killFlag: false, repoHost: k.host, backlogFor: () => c.fake.adapter,
    launcher: { async start(env) { started.push(env); return `exec-${started.length}`; }, async stop() {} },
    secret: "scenario-secret", controlUrl: "http://control.test:7400", sopVersion: "default@1",
  });
  for (const env of started) {
    const r = await pool().query<{ external_id: string }>("select external_id from item where id = $1", [env.ITEM_ID]);
    if (r.rows[0]) c.runs.add(r.rows[0].external_id);
  }
  k.looked = true;
});

Given("the issue of child {string} has closed", async function (title: string) {
  await ctx144(this).fake.adapter.close(child(this, title).externalId);
});

Given("the issue of child {string} is still open", async function (title: string) {
  const c = ctx144(this);
  assert.ok(!(await boardItem(c, child(this, title).externalId)).closed, `the issue of child "${title}" is closed`);
});

async function removeLabel(world: object, label: string, title: string): Promise<void> {
  const c = ctx144(world);
  // A child that doesn't carry the label has nothing to remove; the Thens that follow judge the outcome.
  await setLabels(c, child(world, title).externalId, (ls) => ls.filter((l) => l !== label));
}

When("the owner removes the label {string} from child {string}", async function (label: string, title: string) {
  await removeLabel(this, label, title);
});

Given("the owner has removed the label {string} from child {string}", async function (label: string, title: string) {
  await removeLabel(this, label, title);
});

// --- Items the factory holds ---------------------------------------------------------------------------------------

Then("the factory holds child {string} as an item", long, async function (title: string) {
  if (given(ctx(this))) {
    child(this, title);
    return;
  }
  await held(this, title);
});

Then("the factory holds child {string} in state {string}", long, async function (title: string, state: string) {
  assert.equal((await held(this, title)).state, state, `child "${title}"'s state`);
});

Then("the factory holds child {string} in a state other than {string}", long, async function (title: string, state: string) {
  assert.notEqual((await held(this, title)).state, state, `child "${title}"'s state`);
});

Then("the factory holds no item for {string} or {string}", long, async function (a: string, b: string) {
  const c = ctx144(this);
  polled(c);
  const k = ctx(this);
  const ids = c.filed.filter((i) => i.title === a || i.title === b).map((i) => i.externalId);
  const r = await pool().query<{ title: string }>(
    "select title from item where source_id = $1 and (external_id = any($2) or title = any($3))",
    [k.sourceId, ids, [a, b]],
  );
  assert.deepEqual(r.rows.map((x) => x.title), [], "the factory holds items for the grandchildren");
});

Then("each child's history starts with a move to {string}", long, async function (state: string) {
  const c = ctx144(this);
  polled(c);
  const kids = c.subIssues.get(c.parentId!) ?? [];
  assert.ok(kids.length > 0, "the parent has no sub-issues");
  for (const id of kids) {
    const r = await row(ctx(this), id);
    assert.ok(r, `the factory holds no item for child "${titleOf(c, id)}"`);
    const first = (await pool().query<{ from: string | null; to: string }>(
      `select payload->>'from' as from, payload->>'to' as to from event
       where item_id = $1 and kind in ('transition', 'override') order by at, id limit 1`,
      [r.id],
    )).rows[0];
    assert.ok(first, `child "${titleOf(c, id)}" has no history`);
    // Intake itself isn't logged as a move, so a history that starts with the item's first move out of Eligible
    // started there too.
    assert.ok(first.to === state || first.from === state,
      `child "${titleOf(c, id)}"'s history starts with a move from ${first.from} to ${first.to}`);
  }
});

Then("the readiness judge was asked about child {string}", function (title: string) {
  const ch = child(this, title);
  assert.ok((ctx(this).asked.get(ch.externalId) ?? 0) > 0, `the readiness judge was never asked about child "${title}"`);
});

Then("the dashboard's \"Not ready\" list shows child {string}", long, async function (title: string) {
  child(this, title);
  assert.ok((await notReadyList(ctx(this))).includes(title), `the "Not ready" list doesn't show child "${title}"`);
});

Then("the factory has started no run for child {string}", function (title: string) {
  const c = ctx144(this);
  assert.ok(ctx(this).looked, "the scheduler never looked for work");
  assert.ok(!c.runs.has(child(this, title).externalId), `the factory took up child "${title}"`);
});

// --- Labels --------------------------------------------------------------------------------------------------------

Then("child {string} carries the label {string}", async function (title: string, label: string) {
  if (given(ctx(this))) {
    child(this, title);
    return;
  }
  assert.ok(await labelled(this, title, label), `child "${title}" doesn't carry "${label}"`);
});

Then(/^child "([^"]*)" (?:doesn't|no longer) carr(?:y|ies) the label "([^"]*)"$/, async function (title: string, label: string) {
  assert.ok(!(await labelled(this, title, label)), `child "${title}" carries "${label}"`);
});

Then("none of child {string}'s sub-issues carries the label {string}", async function (title: string, label: string) {
  const c = ctx144(this);
  const kids = c.subIssues.get(child(this, title).externalId) ?? [];
  assert.ok(kids.length > 0, `child "${title}" has no sub-issues`);
  for (const id of kids) assert.ok(!(await boardItem(c, id)).labels.includes(label), `"${titleOf(c, id)}" carries "${label}"`);
});

// --- A child's own split -------------------------------------------------------------------------------------------

Then(/^child "([^"]*)" has (\d+) sub-issues?$/, function (title: string, n: string) {
  const c = ctx144(this);
  const kids = (c.subIssues.get(child(this, title).externalId) ?? []).map((id) => titleOf(c, id));
  assert.equal(kids.length, Number(n), `child "${title}"'s sub-issues: ${kids.join(", ") || "none"}`);
});

Then("child {string} has these sub-issues, in order:", function (title: string, table: DataTable) {
  const c = ctx144(this);
  const kids = (c.subIssues.get(child(this, title).externalId) ?? []).map((id) => titleOf(c, id));
  assert.deepEqual(kids, table.hashes().map((r) => r.title));
});

Then("child {string} has one split proposal comment", async function (title: string) {
  const c = ctx144(this);
  const proposals = (await c.fake.comments(child(this, title).externalId)).filter((b) => b.startsWith(SPLIT_HEADING));
  assert.equal(proposals.length, 1, `split proposal comments on child "${title}": ${proposals.length}`);
});

Then("child {string} has one comment linking to its children", async function (title: string) {
  const c = ctx144(this);
  const ch = child(this, title);
  const found = await linkComments(c, ch.externalId);
  assert.equal(found.length, 1, `comments on child "${title}" linking to a child: ${found.length}`);
  ctx(this).subject = ch.externalId;
});

// --- What the link comment says ------------------------------------------------------------------------------------

Then("that comment says the children carry the label {string} and have entered the factory", async function (label: string) {
  const body = await thatComment(this);
  const carry = sentences(body).some((s) => namesLabel(s, label) && /\b(carr(y|ies)|ha(s|ve))\b/i.test(s) && !negated(s));
  assert.ok(carry, `the comment doesn't say the children carry "${label}":\n${body}`);
  assert.ok(/\bentered the factory\b/i.test(body), `the comment doesn't say the children have entered the factory:\n${body}`);
});

Then("that comment says removing the label {string} from a child withdraws that child", async function (label: string) {
  const body = await thatComment(this);
  const says = sentences(body).some((s) => /\bremov(e|es|ing|ed)\b/i.test(s) && namesLabel(s, label) && /\bwithdraw/i.test(s) && /\bchild\b/i.test(s));
  assert.ok(says, `the comment doesn't say removing "${label}" from a child withdraws it:\n${body}`);
});

Then("that comment doesn't ask the owner to add the label {string} to a child", async function (label: string) {
  const body = await thatComment(this);
  const asks = sentences(body).filter((s) => /\badd\b/i.test(s) && /\bchild\b/i.test(s) && !negated(s));
  assert.deepEqual(asks, [], `the comment asks the owner to add "${label}" to a child:\n${body}`);
});

Then("that comment says none of the children carries the label {string}", async function (label: string) {
  const body = await thatComment(this);
  const says = sentences(body).some((s) => namesLabel(s, label) && /\b(carr(y|ies)|ha(s|ve))\b/i.test(s) && negated(s));
  assert.ok(says, `the comment doesn't say none of the children carries "${label}":\n${body}`);
});
