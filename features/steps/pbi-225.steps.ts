// Step definitions for features/pbi-225-split-state.feature. The @ac-1 scenario without @db is PBI 7's state machine
// steps. The Background is PBI 144's: its fake board, its scripted repo writes and refusals, its judge and its coding
// model. For the @db scenarios a Before hook swaps PBI 144's in-memory poll for the real poller over Postgres, so PBI
// 144's "the factory has polled the backlog once" and "again" run pollOnce too, with that same board as the backlog
// adapter and the board's writes as the split filing deps. The repo's readiness files sit in PBI 12's fake repo host.
// A restart is PBI 149's: a new readiness logic in PBI 12's context, which every later poll here passes to the poller.
import { Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { fakeRepoHost } from "../../src/adapters/fake.ts";
import type { FactoryItem } from "../../src/adapters/types.ts";
import type { Policy } from "../../src/policy/policy.ts";
import { SPLIT_HEADING } from "../../src/gate/split.ts";
import { pollOnce } from "../../src/watcher/poller.ts";
import { baseFiles, ctx as ctx12 } from "./pbi-12.steps.ts";
import { agent, ctx as ctx144, judge as judge144, poll, polled, refuse, replaceItem, scriptedBoard, type Ctx as Ctx144 } from "./pbi-144.steps.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";

const HEADING = "Acceptance criteria";

type Host = ReturnType<typeof fakeRepoHost>;
type Ctx = {
  host: Host;
  sourceId?: string;
  /** How often the readiness judge was asked about each item, by external id. */
  asked: Map<string, number>;
  /** The judge's asks about the parent when the setup ended, so "again" counts only what came after. */
  askedBefore?: number;
  heads: number;
};

function ctx(world: object): Ctx {
  const w = world as { pbi225?: Ctx };
  w.pbi225 ??= { host: fakeRepoHost(), asked: new Map(), heads: 0 };
  return w.pbi225;
}

/** Commits `files` over the repo's current readiness files as a new head of `repo`. */
function commit(k: Ctx, repo: string, files: Record<string, string>): void {
  const head = k.host.heads.get(repo);
  const now: Record<string, string> = {};
  if (head) for (const [key, text] of k.host.files) if (key.startsWith(`${repo}@${head}:`)) now[key.slice(`${repo}@${head}:`.length)] = text;
  const sha = `c${++k.heads}`;
  for (const [path, text] of Object.entries({ ...now, ...files })) k.host.files.set(`${repo}@${sha}:${path}`, text);
  k.host.heads.set(repo, sha);
}

/** One pass of the real poller over PBI 144's board, with the scenario's refusals and the running readiness logic. */
async function realPoll(world: object): Promise<void> {
  const c = ctx144(world);
  const k = ctx(world);
  assert.ok(k.sourceId, "the factory's database wasn't set up");
  await knowRepo(world, c);
  const adapter = {
    ...c.fake.adapter,
    async comment(id: string, body: string, key: string) {
      if (id === c.parentId && !body.startsWith(SPLIT_HEADING)) refuse(c, "comment", "parent");
      return c.fake.adapter.comment(id, body, key);
    },
  };
  const scripted = judge144(c);
  const judge = async (item: FactoryItem, dor: Policy) => {
    k.asked.set(item.externalId, (k.asked.get(item.externalId) ?? 0) + 1);
    return scripted(item, dor);
  };
  const logic = ctx12(world).logic;
  await pollOnce({
    pool: need().pool, adapter, repoHost: k.host, judge, sourceId: k.sourceId,
    split: {
      sop: { models: { coding: "coding-model" } }, agent: agent(c), seen: c.seen,
      file: { board: scriptedBoard(c), optInLabel: c.label, backlogStatus: c.backlogStatus, criteriaHeading: HEADING },
    },
    ...(logic ? { logic } : {}),
  });
}

Before({ tags: "@pbi-225 and @db", ...long }, async function () {
  const d = await testDb();
  assert.ok(d, "src/store/test-db.ts doesn't exist");
  await d.pool.query('truncate item, event, backlog_source, repo, "user" cascade');
  const k = ctx(this);
  k.sourceId = (await d.pool.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'test:' || gen_random_uuid()) returning id")).rows[0].id;
  const world = this;
  ctx144(this).driver = () => realPoll(world);
});

/** The repo is known only once the Background names it, so its row and readiness files are added then. */
async function knowRepo(world: object, c: Ctx144): Promise<void> {
  const k = ctx(world);
  if (!k.sourceId || k.host.heads.has(c.repo)) return;
  commit(k, c.repo, baseFiles);
  await need().pool.query("insert into repo (host_adapter, url) values ('fake', $1)", [`https://github.com/${c.repo}`]);
}

async function pollTimes(world: object, n: number): Promise<void> {
  const c = ctx144(world);
  for (let i = 0; i < n; i++) await poll(c);
}

async function parentId(world: object): Promise<string> {
  const c = ctx144(world);
  polled(c);
  const k = ctx(world);
  const r = await need().pool.query<{ id: string }>("select id from item where source_id = $1 and external_id = $2", [k.sourceId, c.parentId]);
  assert.ok(r.rows[0], "the factory doesn't hold the parent issue");
  return r.rows[0].id;
}

type Move = { id: string; from: string; to: string; event: string };

/** The parent's moves, oldest first, transitions and overrides both. */
async function moves(world: object): Promise<Move[]> {
  const id = await parentId(world);
  const r = await need().pool.query<Move>(
    `select id::text, payload->>'from' as from, payload->>'to' as to, payload->>'event' as event from event
     where item_id = $1 and kind in ('transition', 'override') order by at, id`,
    [id],
  );
  return r.rows;
}

const show = (ms: Move[]) => ms.map((m) => `${m.from} -${m.event}-> ${m.to}`).join(", ") || "none";

// ---- the Background ----

Given("the coding model proposes a split of the parent issue into {string}, {string} and {string}", async function (a: string, b: string, d: string) {
  const c = ctx144(this);
  assert.ok(c.parentId, "the parent issue wasn't seeded");
  // One criterion per child, each child needing the one before it, so the split is valid whatever it's checked against.
  c.criteria = ["A shopper can pay by card", "A shopper can pay by bank transfer", "A receipt is emailed after every payment"];
  const body = `Redesign the checkout so a shopper can pay more ways.\n\n## ${HEADING}\n\n${c.criteria.map((t) => `- ${t}`).join("\n")}\n`;
  await replaceItem(c, c.parentId, () => ({ body, acceptanceCriteria: c.criteria }));
  c.reply = JSON.stringify({
    children: [a, b, d].map((title, i) => ({ title, body: `${title} for ${c.parentTitle}`, criteria: [i + 1], needs: i === 0 ? [] : [i] })),
  });
});

// ---- polling ----

Given("the factory has polled the backlog twice, filing every child and taking the parent's label off", long, async function () {
  await pollTimes(this, 2);
  const c = ctx144(this);
  polled(c);
  const kids = c.subIssues.get(c.parentId!) ?? [];
  assert.equal(kids.length, 3, `the parent has ${kids.length} sub-issues after two polls`);
  const parent = await c.fake.adapter.getItem(c.parentId!);
  assert.ok(parent && !parent.labels.includes(c.label), `the parent still carries "${c.label}" after two polls`);
  const k = ctx(this);
  k.askedBefore = k.asked.get(c.parentId!) ?? 0;
});

When("the factory polls the backlog once more", long, async function () {
  await pollTimes(this, 1);
});

When("the factory polls the backlog twice more", long, async function () {
  await pollTimes(this, 2);
});

When("the factory polls the backlog three more times", long, async function () {
  await pollTimes(this, 3);
});

Given("the repo's Definition of Ready changes", function () {
  const c = ctx144(this);
  const k = ctx(this);
  assert.ok(k.host.heads.has(c.repo), "the repo has no readiness files yet");
  commit(k, c.repo, { ".factory/dor.md": "- [ ] Has a title\n- [ ] Names the people it serves\n" });
});

// ---- outcomes ----

Then("the factory holds the parent issue in state {string}", long, async function (state: string) {
  const id = await parentId(this);
  const r = await need().pool.query<{ state: string }>("select state from item where id = $1", [id]);
  assert.equal(r.rows[0].state, state, `moves: ${show(await moves(this))}`);
});

Then("the parent's history shows exactly one move {string}, from {string} to {string}", long, async function (event: string, from: string, to: string) {
  const all = await moves(this);
  const found = all.filter((m) => m.event === event);
  assert.equal(found.length, 1, `moves: ${show(all)}`);
  assert.deepEqual({ from: found[0].from, to: found[0].to }, { from, to }, `moves: ${show(all)}`);
});

Then("the parent's history shows exactly one move {string}", long, async function (event: string) {
  const all = await moves(this);
  assert.equal(all.filter((m) => m.event === event).length, 1, `moves: ${show(all)}`);
});

Then("the parent's history shows no move {string}", long, async function (event: string) {
  const all = await moves(this);
  assert.equal(all.filter((m) => m.event === event).length, 0, `moves: ${show(all)}`);
});

Then("the parent's history shows no move to {string}", long, async function (to: string) {
  const all = await moves(this);
  assert.equal(all.filter((m) => m.to === to).length, 0, `moves: ${show(all)}`);
});

Then("the parent's history shows no move after {string}", long, async function (event: string) {
  const all = await moves(this);
  const at = all.findIndex((m) => m.event === event);
  assert.ok(at !== -1, `the parent's history shows no move "${event}": ${show(all)}`);
  assert.deepEqual(all.slice(at + 1).map((m) => `${m.from} -${m.event}-> ${m.to}`), [], `moves: ${show(all)}`);
});

Then("the readiness judge was not asked about the parent issue again", function () {
  const c = ctx144(this);
  polled(c);
  const k = ctx(this);
  assert.ok(k.askedBefore !== undefined, "the setup didn't count the judge's asks");
  const asked = (k.asked.get(c.parentId!) ?? 0) - k.askedBefore;
  assert.equal(asked, 0, `the readiness judge was asked about the parent ${asked} more times`);
});
