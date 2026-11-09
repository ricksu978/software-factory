// Step definitions for features/pbi-144-file-split-children.feature. No model, no database and no network: the board
// is PBI 10's fake backlog plus a scripted SplitBoard over it, the judge and the coding model are scripted, and a poll
// is an in-memory pass over the board that gates each Eligible item with the real readiness gate, as the poller does.
// A filed child is a fake backlog item, so the factory reads its criteria back with the GitHub adapter's own parser.
import { DataTable, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { fakeBacklog } from "../../src/adapters/fake.ts";
import { acceptanceCriteria } from "../../src/adapters/github/backlog.ts";
import type { FactoryItem } from "../../src/adapters/types.ts";
import type { AgentArgs, AgentResult } from "../../src/agent/run.ts";
import type { ItemState } from "../../src/core/states.ts";
import type { ChildIssue, FileSplitDeps, SplitBoard } from "../../src/gate/file-split.ts";
import { gate } from "../../src/gate/readiness.ts";
import { SPLIT_HEADING, type SplitOutcome } from "../../src/gate/split.ts";
import { loadPolicy, type Policy } from "../../src/policy/policy.ts";
import { readinessItemHash } from "../../src/watcher/poller.ts";

const HEADING = "Acceptance criteria";
export const DOR = "- [ ] Has a title\n";

type Fake = ReturnType<typeof fakeBacklog>;
/** The item's state in the state machine, and the readiness item hash (open dependencies included) it was gated at. */
type State = { state: ItemState; hash: string };
export type Issue = ChildIssue & { repo: string; labels: string[] };
type Refusal = "file" | "sub-issue" | "board" | "block" | "comment";

export type Ctx = {
  fake: Fake;
  repo: string;
  label: string;
  backlogStatus: string;
  parentId?: string;
  parentTitle?: string;
  criteria: string[];
  oversized: boolean;
  reply: string;
  /** The coding model's split reply for a child, by the child's title (PBI 153). A child without one gets no split. */
  childReplies: Map<string, string>;
  /** Children the judge finds oversized, by title, and children it fails, by title, with the reason (PBI 153). */
  oversizedChildren: Set<string>;
  failedChildren: Map<string, string>;
  /** Every item the judge was asked about, with the definition of ready it was given (PBI 153). */
  judged: { id: string; dor: Policy }[];
  requests: AgentArgs[];
  /** The poller's item rows: what survives a restart. */
  states: Map<string, State>;
  /** The coding model's answers by item text hash, which a restart loses. */
  seen: Map<string, SplitOutcome>;
  /** Every item the factory took up (gated ready and queued), by external id. */
  runs: Set<string>;
  /** Every item the scheduler started a run for, by external id, and the stages each run has done (PBI 153). */
  started: Set<string>;
  stages: Map<string, string[]>;
  /** The factory's WIP limit: how many items may be InProgress at once. The factory's default is 1. */
  wip: number;
  /** The issues filed in the repo through the board, in order. */
  filed: Issue[];
  subIssues: Map<string, string[]>;
  board: Map<string, string>;
  blocks: Map<string, string[]>;
  /** One-shot refusals: a write of this kind on this child (or "parent" for the link comment) throws once. */
  refusals: { kind: Refusal; title: string; blocker?: string }[];
  /** A step's setting that waits for its child to exist, such as the owner labelling a child that wasn't filed. */
  errors: unknown[];
  polls: number;
};

export function ctx(world: object): Ctx {
  const w = world as { pbi144?: Ctx };
  w.pbi144 ??= {
    fake: fakeBacklog(), repo: "", label: "factory", backlogStatus: "Backlog", criteria: [], oversized: false, reply: "",
    childReplies: new Map(), oversizedChildren: new Set(), failedChildren: new Map(), judged: [],
    requests: [], states: new Map(), seen: new Map(), runs: new Set(), started: new Set(), stages: new Map(), wip: 1,
    filed: [], subIssues: new Map(), board: new Map(), blocks: new Map(), refusals: [], errors: [], polls: 0,
  };
  return w.pbi144;
}

const indices = (cell: string) => cell.split(",").map((s) => s.trim()).filter(Boolean).map(Number);

export function splitReply(table: DataTable): string {
  const rows = table.hashes().sort((a, b) => Number(a.child) - Number(b.child));
  return JSON.stringify({ children: rows.map((r) => ({ title: r.title, body: r.body, criteria: indices(r.criteria), needs: indices(r.needs) })) });
}

export const titleOf = (c: Ctx, id: string) => c.filed.find((i) => i.externalId === id)?.title ?? `#${id}`;

/** Throws once for the first matching refusal, then forgets it. */
function refuse(c: Ctx, kind: Refusal, title: string, blocker?: string): void {
  const at = c.refusals.findIndex((r) => r.kind === kind && r.title === title && (r.blocker === undefined || r.blocker === blocker));
  if (at === -1) return;
  c.refusals.splice(at, 1);
  throw new Error(`the repo refused a ${kind} write for "${title}"`);
}

export async function replaceItem(c: Ctx, id: string, change: (fi: FactoryItem) => Partial<FactoryItem>): Promise<void> {
  const fi = await c.fake.adapter.getItem(id);
  assert.ok(fi, `no item ${id}`);
  await c.fake.seed({ ...fi, ...change(fi), externalId: id });
}

function scriptedBoard(c: Ctx): SplitBoard {
  const issue = (id: string): ChildIssue => {
    const found = c.filed.find((i) => i.externalId === id);
    assert.ok(found, `no filed issue ${id}`);
    return { externalId: found.externalId, title: found.title, url: found.url };
  };
  return {
    async subIssues(parentId) {
      return (c.subIssues.get(parentId) ?? []).map(issue);
    },
    async findIssues(repo, text) {
      const out: ChildIssue[] = [];
      for (const i of c.filed.filter((f) => f.repo === repo)) {
        const fi = await c.fake.adapter.getItem(i.externalId);
        if (i.title.includes(text) || fi?.body.includes(text)) out.push(issue(i.externalId));
      }
      return out;
    },
    // A label filed with the issue (PBI 153) is the issue's from the start, so the next listing sees it.
    async createIssue(repo: string, title: string, body: string, labels: string[] = []) {
      refuse(c, "file", title);
      const externalId = await c.fake.seed({
        title, body, acceptanceCriteria: acceptanceCriteria(body, HEADING), labels: [...labels], repo, status: "", fields: {},
      });
      const url = `https://github.com/${repo}/issues/${externalId}`;
      c.filed.push({ externalId, title, url, repo, labels: [...labels] });
      return { externalId, title, url };
    },
    async addSubIssue(parentId, childId) {
      refuse(c, "sub-issue", titleOf(c, childId));
      const list = c.subIssues.get(parentId) ?? [];
      if (list.includes(childId)) throw new Error(`#${childId} is already a sub-issue of #${parentId}`);
      for (const [other, kids] of c.subIssues) if (kids.includes(childId)) throw new Error(`#${childId} is already a sub-issue of #${other}`);
      c.subIssues.set(parentId, [...list, childId]);
    },
    async boardStatus(id) {
      return c.board.get(id) ?? null;
    },
    async addToBoard(id, status) {
      refuse(c, "board", titleOf(c, id));
      c.board.set(id, status);
      await c.fake.adapter.setStatus(id, status);
    },
    async blockedBy(id) {
      return [...(c.blocks.get(id) ?? [])];
    },
    async addBlockedBy(id, blockerId) {
      refuse(c, "block", titleOf(c, id), titleOf(c, blockerId));
      const list = c.blocks.get(id) ?? [];
      if (!list.includes(blockerId)) c.blocks.set(id, [...list, blockerId]);
    },
    async removeLabel(id, label) {
      await replaceItem(c, id, (fi) => ({ labels: fi.labels.filter((l) => l !== label) }));
    },
  };
}

/** The coding model answers the parent's split with `reply`, and a child's with that child's own reply, if any. */
function agent(c: Ctx, fi: FactoryItem) {
  const text = fi.externalId === c.parentId ? c.reply : (c.childReplies.get(fi.title) ?? "");
  return async (a: AgentArgs): Promise<AgentResult> => {
    c.requests.push(a);
    return { ok: true, text, costUsd: 0, tokensIn: 0, tokensOut: 0, model: a.model, limit: null, usage: null, transcript: "" };
  };
}

/**
 * The judge passes every dor.md line and raises no flag; only the parent, once set so, is oversized. A child set
 * oversized is oversized too, and a child set to fail fails line 1 for its reason (PBI 153).
 */
function judge(c: Ctx) {
  return async (item: FactoryItem, dor: Policy) => {
    c.judged.push({ id: item.externalId, dor });
    const fails = item.externalId === c.parentId ? undefined : c.failedChildren.get(item.title);
    const oversized = item.externalId === c.parentId ? c.oversized : c.oversizedChildren.has(item.title);
    return [
      ...dor.criteria.map((cr) => JSON.stringify(
        cr.index === 1 && fails !== undefined ? { index: cr.index, status: "failed", reason: fails } : { index: cr.index, status: "passed", reason: "ok" },
      )),
      JSON.stringify({ flags: [], oversized }),
    ].join("\n");
  };
}

/** The items `id` is blocked by that are still open, as the adapter's openDependencies reads them. */
async function openDepsOf(c: Ctx, id: string): Promise<string[]> {
  const open: string[] = [];
  for (const b of c.blocks.get(id) ?? []) if (!(await c.fake.adapter.getItem(b))?.closed) open.push(b);
  return open;
}

/**
 * One poll. As in the poller, an item that leaves the backlog is dropped (here every state counts, so putting the
 * label back always re-gates the item), a NotReady item whose text or open dependencies changed is gated again, and
 * every Eligible item is gated. A gate that throws leaves its item Eligible for the next poll, as the poller's `each`
 * does.
 */
export async function poll(c: Ctx): Promise<void> {
  const dor = await loadPolicy(async (p) => (p === ".factory/dor.md" ? DOR : null), "dor");
  // The board's issues are the parent and every filed child. They're read one by one rather than through the fake's
  // listEligible, which knows only its own opt-in label, so a repo's own label (PBI 153) is the one that counts.
  const board: FactoryItem[] = [];
  for (const id of [c.parentId!, ...c.filed.map((i) => i.externalId)]) board.push(await item(c, id));
  const listed = board.filter((fi) => !fi.closed && fi.labels.includes(c.label));
  const ids = new Set(listed.map((fi) => fi.externalId));
  for (const id of [...c.states.keys()]) if (!ids.has(id)) c.states.delete(id);
  for (const fi of listed) {
    const st = c.states.get(fi.externalId);
    if (!st) c.states.set(fi.externalId, { state: "Eligible", hash: "" });
    else if (st.state === "NotReady" && st.hash !== readinessItemHash(fi, await openDepsOf(c, fi.externalId))) st.state = "Eligible";
  }
  const file: FileSplitDeps = { board: scriptedBoard(c), optInLabel: c.label, backlogStatus: c.backlogStatus, criteriaHeading: HEADING };
  const adapter = {
    ...c.fake.adapter,
    async comment(id: string, body: string, key: string) {
      if (id === c.parentId && !body.startsWith(SPLIT_HEADING)) refuse(c, "comment", "parent");
      return c.fake.adapter.comment(id, body, key);
    },
  };
  for (const fi of listed) {
    const st = c.states.get(fi.externalId)!;
    if (st.state !== "Eligible") continue;
    try {
      const openDeps = await openDepsOf(c, fi.externalId);
      const out = await gate(fi, {
        readinessSha: "policy-1", dor, dodExists: true, configValid: true, repoKnown: true, openDeps,
        judge: judge(c), adapter, split: { sop: { models: { coding: "coding-model" } }, agent: agent(c, fi), seen: c.seen, file },
      });
      st.state = out.ready ? "Queued" : "NotReady";
      st.hash = readinessItemHash(fi, openDeps);
      if (out.ready) c.runs.add(fi.externalId);
    } catch (e) {
      c.errors.push(e);
    }
  }
  c.polls++;
}

export function polled(c: Ctx): void {
  assert.ok(c.polls > 0, "the factory never polled");
}

export function child(c: Ctx, title: string): Issue {
  polled(c);
  const found = c.filed.filter((i) => i.title === title);
  assert.ok(found.length > 0, `no child "${title}" was filed`);
  assert.equal(found.length, 1, `child "${title}" was filed ${found.length} times`);
  return found[0];
}

export async function item(c: Ctx, id: string): Promise<FactoryItem> {
  const fi = await c.fake.adapter.getItem(id);
  assert.ok(fi, `no item ${id}`);
  return fi;
}

async function subIssueTitles(c: Ctx): Promise<string[]> {
  polled(c);
  return (c.subIssues.get(c.parentId!) ?? []).map((id) => titleOf(c, id));
}

/** An item's comments that link to any filed child, by its URL. The item is the parent unless one is named. */
export const links = (body: string, url: string) => new RegExp(`${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\d)`).test(body);

export async function linkComments(c: Ctx, id = c.parentId!): Promise<string[]> {
  polled(c);
  const all = await c.fake.comments(id);
  return all.filter((b) => c.filed.some((i) => links(b, i.url)));
}

/**
 * PBI 153: the parent's link comment says its children went into the factory. A scenario tagged @pbi-153 holds the
 * comment it links each child from to that, since the feature's comment does both.
 */
export const SAYS_ENTERED = /\b(?:went|gone|go|goes|sent|put) (?:straight )?into the factory\b|\bentered the factory\b|\bare (?:now )?in the factory\b/i;

async function blockerTitles(c: Ctx, title: string): Promise<string[]> {
  const ch = child(c, title);
  return (c.blocks.get(ch.externalId) ?? []).map((id) => titleOf(c, id)).sort();
}

// --- Background --------------------------------------------------------------------------------------------------

Given("a repo {string} whose board's backlog status is {string} and whose opt-in label is {string}", function (repo: string, status: string, label: string) {
  const c = ctx(this);
  c.repo = repo;
  c.backlogStatus = status;
  c.label = label;
});

Given("a parent issue {string} in {string} on that board, carrying the label {string}", async function (title: string, repo: string, label: string) {
  const c = ctx(this);
  c.parentTitle = title;
  c.parentId = await c.fake.seed({ title, body: `Redesign the checkout so a shopper can pay more ways.`, acceptanceCriteria: [], labels: [label], repo, status: c.backlogStatus });
  c.board.set(c.parentId, c.backlogStatus);
});

Given("the parent issue has these acceptance criteria:", async function (table: DataTable) {
  const c = ctx(this);
  c.criteria = table.hashes().sort((a, b) => Number(a.index) - Number(b.index)).map((r) => r.text);
  const body = `Redesign the checkout so a shopper can pay more ways.\n\n## ${HEADING}\n\n${c.criteria.map((t) => `- ${t}`).join("\n")}\n`;
  await replaceItem(c, c.parentId!, () => ({ body, acceptanceCriteria: c.criteria }));
});

Given("the readiness judge finds the parent issue oversized", function () {
  ctx(this).oversized = true;
});

Given("the coding model proposes this split of the parent issue:", function (table: DataTable) {
  ctx(this).reply = splitReply(table);
});

Given("the coding model instead proposes this split of the parent issue:", function (table: DataTable) {
  ctx(this).reply = splitReply(table);
});

// --- Polling and what happens between polls ----------------------------------------------------------------------

When("the factory polls the backlog", async function () {
  await poll(ctx(this));
});

When("the factory polls the backlog again", async function () {
  await poll(ctx(this));
});

Given("the factory has polled the backlog once", async function () {
  await poll(ctx(this));
});

Given("the factory has restarted", function () {
  // The item rows stay in the database; the coding model's cached answers were in memory.
  ctx(this).seen = new Map();
});

Given("the owner has added the label {string} to child {string}", async function (label: string, title: string) {
  const c = ctx(this);
  // A child that was never filed can't be labelled; the Then that looks for it fails instead.
  for (const i of c.filed.filter((f) => f.title === title)) await replaceItem(c, i.externalId, (fi) => ({ labels: [...fi.labels, label] }));
});

Given("the owner has put the label {string} back on the parent issue", async function (label: string) {
  const c = ctx(this);
  await replaceItem(c, c.parentId!, (fi) => ({ labels: fi.labels.includes(label) ? fi.labels : [...fi.labels, label] }));
});

Given("the parent issue's body has since changed", async function () {
  const c = ctx(this);
  await replaceItem(c, c.parentId!, (fi) => ({
    body: `The order summary stays on screen while a shopper pays.\n\n${fi.body}`,
    updatedAt: new Date(Date.now() + 60_000).toISOString(),
  }));
});

Given("the repo refuses the next filing of child {string} once", function (title: string) {
  ctx(this).refusals.push({ kind: "file", title });
});

Given("the repo refuses to make child {string} a sub-issue once", function (title: string) {
  ctx(this).refusals.push({ kind: "sub-issue", title });
});

Given("the board refuses to add child {string} once", function (title: string) {
  ctx(this).refusals.push({ kind: "board", title });
});

Given("the repo refuses to mark child {string} blocked by {string} once", function (title: string, blocker: string) {
  ctx(this).refusals.push({ kind: "block", title, blocker });
});

Given("the repo refuses to comment on the parent issue once", function () {
  ctx(this).refusals.push({ kind: "comment", title: "parent" });
});

// --- The filed issues ----------------------------------------------------------------------------------------------

Then(/^"([^"]*)" holds (?:exactly )?(\d+) new issues$/, function (repo: string, n: string) {
  const c = ctx(this);
  polled(c);
  assert.equal(c.filed.filter((i) => i.repo === repo).length, Number(n), `issues filed: ${c.filed.map((i) => i.title).join(", ") || "none"}`);
});

Then("{string} holds exactly {int} issue titled {string}", function (repo: string, n: number, title: string) {
  const c = ctx(this);
  polled(c);
  assert.equal(c.filed.filter((i) => i.repo === repo && i.title === title).length, n);
});

Then("the new issues are titled {string}, {string} and {string}", function (a: string, b: string, d: string) {
  const c = ctx(this);
  polled(c);
  assert.deepEqual(c.filed.map((i) => i.title), [a, b, d]);
});

Then("the body of child {string} starts with {string}", async function (title: string, start: string) {
  const c = ctx(this);
  const body = (await item(c, child(c, title).externalId)).body;
  assert.ok(body.startsWith(start), `child "${title}"'s body doesn't start with "${start}":\n${body}`);
});

Then("child {string} lists under its acceptance criteria heading, in order:", async function (title: string, table: DataTable) {
  const c = ctx(this);
  const body = (await item(c, child(c, title).externalId)).body;
  assert.deepEqual(acceptanceCriteria(body, HEADING), table.hashes().map((r) => r.text), `child "${title}"'s body:\n${body}`);
});

Then(/^the factory reads child "([^"]*)" as having (\d+) acceptance criteri(?:a|on)$/, async function (title: string, n: string) {
  const c = ctx(this);
  const fi = await item(c, child(c, title).externalId);
  assert.equal(fi.acceptanceCriteria.length, Number(n), `the factory reads: ${JSON.stringify(fi.acceptanceCriteria)}`);
});

// --- Sub-issues, the board and blocks ------------------------------------------------------------------------------

Then("the parent issue has these sub-issues, in order:", async function (table: DataTable) {
  assert.deepEqual(await subIssueTitles(ctx(this)), table.hashes().map((r) => r.title));
});

Then(/^the parent issue has (?:exactly )?(\d+) sub-issues?$/, async function (n: string) {
  const titles = await subIssueTitles(ctx(this));
  assert.equal(titles.length, Number(n), `sub-issues: ${titles.join(", ") || "none"}`);
});

Then("child {string} is on the parent's board with status {string}", async function (title: string, status: string) {
  const c = ctx(this);
  const ch = child(c, title);
  assert.equal(c.board.get(ch.externalId) ?? null, status, `child "${title}" isn't on the board with status "${status}"`);
  assert.equal((await item(c, ch.externalId)).status, status);
});

Then("child {string} is blocked by nothing", async function (title: string) {
  assert.deepEqual(await blockerTitles(ctx(this), title), []);
});

Then("child {string} is blocked by {string} only", async function (title: string, a: string) {
  assert.deepEqual(await blockerTitles(ctx(this), title), [a]);
});

Then("child {string} is blocked by {string} and {string} only", async function (title: string, a: string, b: string) {
  assert.deepEqual(await blockerTitles(ctx(this), title), [a, b].sort());
});

// --- Labels and runs -----------------------------------------------------------------------------------------------

Then("none of the parent's sub-issues carries the label {string}", async function (label: string) {
  const c = ctx(this);
  polled(c);
  for (const id of c.subIssues.get(c.parentId!) ?? []) {
    assert.ok(!(await item(c, id)).labels.includes(label), `child "${titleOf(c, id)}" carries "${label}"`);
  }
});

Then("the factory has started no run for any of the parent's sub-issues", function () {
  const c = ctx(this);
  polled(c);
  const started = (c.subIssues.get(c.parentId!) ?? []).filter((id) => c.runs.has(id));
  assert.deepEqual(started.map((id) => titleOf(c, id)), []);
});

Then("the factory takes up child {string}", function (title: string) {
  const c = ctx(this);
  assert.ok(c.runs.has(child(c, title).externalId), `the factory didn't take up child "${title}"`);
});

Then("the factory has started no run for child {string} or child {string}", function (a: string, b: string) {
  const c = ctx(this);
  for (const title of [a, b]) {
    const id = child(c, title).externalId;
    assert.ok(!c.runs.has(id) && !c.started.has(id), `the factory took up child "${title}"`);
  }
});

Then("the parent issue no longer carries the label {string}", async function (label: string) {
  const c = ctx(this);
  polled(c);
  assert.ok(!(await item(c, c.parentId!)).labels.includes(label), `the parent still carries "${label}"`);
});

Then("the parent issue still carries the label {string}", async function (label: string) {
  const c = ctx(this);
  polled(c);
  assert.ok((await item(c, c.parentId!)).labels.includes(label), `the parent lost "${label}"`);
});

// --- Comments on the parent ----------------------------------------------------------------------------------------

Then("the parent issue has one comment linking to its children", async function () {
  const found = await linkComments(ctx(this));
  assert.equal(found.length, 1, `comments linking to a child: ${found.length}`);
});

Then("the parent issue has no comment linking to a child", async function () {
  assert.deepEqual(await linkComments(ctx(this)), []);
});

Then("that comment links to child {string}, child {string} and child {string}", async function (a: string, b: string, d: string) {
  const c = ctx(this);
  const found = await linkComments(c);
  assert.equal(found.length, 1, `comments linking to a child: ${found.length}`);
  for (const title of [a, b, d]) assert.ok(links(found[0], child(c, title).url), `the comment doesn't link to child "${title}":\n${found[0]}`);
  if ((this as { pbi153?: boolean }).pbi153) assert.match(found[0], SAYS_ENTERED, `the comment linking the children doesn't say they went into the factory:\n${found[0]}`);
});

Then("the parent issue has one split proposal comment", async function () {
  const c = ctx(this);
  polled(c);
  const proposals = (await c.fake.comments(c.parentId!)).filter((b) => b.startsWith(SPLIT_HEADING));
  assert.equal(proposals.length, 1, `split proposal comments: ${proposals.length}`);
});
