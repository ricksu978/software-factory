// Step definitions for features/pbi-444-split-child-rule-change-waits-for-approval.feature.
//
// The Background is PBI 144's split harness with PBI 264's scripted judge and coding model, and PBI 395's rules on
// main. This file adds:
// - A judge that follows its prompt. It finds the factory rules a step says an item changes, by the item's title, and
//   names them in its last line's "rules". When it finds any, it raises APPROVAL_FLAG, unless the prompt it follows
//   says a rule change still waiting for the owner's approval is never a flag (neverAFlag below). The prompt it follows
//   is judgePrompt's for the item, or, in PBI 12's poller harness, the judge prompt of the readiness logic the factory
//   runs with, so a factory restarted with the old prompt gets the old judge.
// - The gate is given PBI 395's factory repo on main, so a proposed or filed child's rules section can be held to it.
// - "A child the factory filed from the parent's split" is filed as the split would file it: its body is childBody's,
//   with its split marker, it's a sub-issue of the parent, on the board, App-opened, and the parent has lost its label.
//   Those scenarios poll with the real poller on the test database over PBI 144's board, so the child has an item row,
//   a history and an item page; the item page and the owner's approval are PBI 395's, read the same way.
// - The judge prompt the factory shipped before this change is features/fixtures/pbi-444-judge-prompt-before.txt,
//   readinessLogic().judgePrompt as it was at the lock commit. "The old logic" is the current logic with that prompt.
// - A split proposal comment's part about child X is its "### N. X" section. The child's own body is quoted there as
//   "> " lines, so the lines that say anything about the child are the section's other lines.
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fakeRepoHost } from "../../src/adapters/fake.ts";
import { acceptanceCriteria } from "../../src/adapters/github/backlog.ts";
import type { BacklogAdapter, FactoryItem } from "../../src/adapters/types.ts";
import { judgePrompt, readinessLogic } from "../../src/agent/run.ts";
import { childBody } from "../../src/gate/file-split.ts";
import { gate } from "../../src/gate/readiness.ts";
import { SPLIT_HEADING, type SplitDeps } from "../../src/gate/split.ts";
import { createAuth } from "../../src/http/auth.ts";
import { dashboardRoutes } from "../../src/http/routes.ts";
import { startServer } from "../../src/http/server.ts";
import { loadPolicy, type Policy, type ReadinessLogic, type ReadinessTexts } from "../../src/policy/policy.ts";
import { ruleChangesChecked } from "../../src/store/rule-changes.ts";
import { ruleChangesHash } from "../../src/gate/rule-changes.ts";
import { pollOnce } from "../../src/watcher/poller.ts";
import { baseFiles, baseline, ctx as pollCtx, poll as poll12, setup, stateOf, type Ctx as PollCtx } from "./pbi-12.steps.ts";
import { ctx as itemCtx } from "./pbi-131.steps.ts";
import { ctx as ctx144, polled as polled144, replaceItem, scriptedBoard, type Ctx as Ctx144 } from "./pbi-144.steps.ts";
import { ctx as ctx149, gateIntoNotReady } from "./pbi-149.steps.ts";
import { text } from "./pbi-189.steps.ts";
import { ctx as ctx264 } from "./pbi-264.steps.ts";
import { ctx as ruleCtx, factoryRepo, onMain, ruleEntry, rulesPart, side, WAITS } from "./pbi-395.steps.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";

const HEADING = "Acceptance criteria";
const RULES_HEADING = "## Changes the factory's rules";
const OWNER = "pbi-444-owner";
/** The flag the judge raises for a rule change while its prompt doesn't say such a change is never a flag. */
export const APPROVAL_FLAG = "needs the owner's approval of its change to the factory's rules";
/** The After an item's rules section gives for spec §6 when the step names none. */
const AFTER_6 = "A lease lasts five minutes and the worker renews it every thirty seconds.";
const OLD_PROMPT = readFileSync(join(process.cwd(), "features/fixtures/pbi-444-judge-prompt-before.txt"), "utf8");

/** The readiness logic the factory shipped before this change: the current logic with the judge prompt it had then. */
const oldLogic = (): ReadinessLogic => ({ ...readinessLogic(), judgePrompt: OLD_PROMPT });

type Subject = { title: string; repo: string; body: string };
type Real = { sourceId: string; host: ReturnType<typeof fakeRepoHost>; before: Map<string, number> };
type Ctx = {
  /** The factory rules the judge finds each item changes, by title. */
  rules: Map<string, string[]>;
  /** Each reply the judge gave, by title, in order. */
  replies: Map<string, string[]>;
  /** The "Changes the factory's rules" section each child's body carries, by title. */
  sections: Map<string, string>;
  wrapped: boolean;
  prompt?: string;
  subject?: Subject;
  real?: Real;
  server?: Server;
  close?: () => Promise<void>;
  origin?: string;
  /** The status the owner's last approval post answered. */
  approval?: number;
  /** The comment a "has a new readiness comment" step found, for a following "that comment". */
  comment?: string;
};

function ctx(world: object): Ctx {
  const w = world as { pbi444?: Ctx };
  w.pbi444 ??= { rules: new Map(), replies: new Map(), sections: new Map(), wrapped: false };
  return w.pbi444;
}

const pool = () => need().pool;

Before({ tags: "@pbi-444", ...long }, async function () {
  const d = await testDb();
  if (d) await d.pool.query('truncate item, event, override, backlog_source, repo, "user" cascade');
});

After({ tags: "@pbi-444", ...long }, async function () {
  const k = (this as { pbi444?: Ctx }).pbi444;
  if (!k?.server) return;
  await k.close?.();
  k.server.closeAllConnections();
  await new Promise<void>((resolve) => k.server!.close(() => resolve()));
});

// ---- what the judge's prompt says ----

const sentences = (prompt: string) => prompt.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);

/** Whether `prompt` says a change to the factory's rules that still needs the owner's approval is never a flag. */
export function neverAFlag(prompt: string): boolean {
  return sentences(prompt).some((s) => /\brules?\b/i.test(s) && /\bowner/i.test(s) && /\bapprov/i.test(s)
    && /\b(never|not|no)\b[^.]*\bflag\b/i.test(s));
}

/** Whether `prompt` gives the engine asking the owner for that approval as the reason. */
function engineAsks(prompt: string): boolean {
  return neverAFlag(prompt) && sentences(prompt).some((s) => /\bengine\b/i.test(s) && /\basks?\b/i.test(s) && /\bapprov/i.test(s));
}

// ---- the judge that follows its prompt ----

/** The judge's reply with its last line naming the rules it finds and, when its prompt says to, raising APPROVAL_FLAG. */
function following(k: Ctx, item: FactoryItem, reply: string, prompt: string): string {
  const lines = reply.split("\n");
  const last = JSON.parse(lines.at(-1)!) as { flags: string[]; rules?: string[] };
  const rules = k.rules.get(item.title) ?? [];
  last.rules = rules;
  if (rules.length > 0 && !neverAFlag(prompt)) last.flags = [...last.flags, APPROVAL_FLAG];
  const out = [...lines.slice(0, -1), JSON.stringify(last)].join("\n");
  k.replies.set(item.title, [...(k.replies.get(item.title) ?? []), out]);
  return out;
}

/** Wraps PBI 264's scripted judge on PBI 144's harness, and gives the gate the factory's rules on main. */
function wrap(world: object): void {
  const k = ctx(world);
  if (k.wrapped) return;
  ctx264(world);
  const c = ctx144(world);
  const inner = c.judgeOverride;
  assert.ok(inner, "PBI 264's scripted judge isn't installed");
  c.judgeOverride = async (item: FactoryItem, dor: Policy) => following(k, item, await inner(item, dor), judgePrompt(item, dor));
  const repo = factoryRepo(ruleCtx(world));
  c.gateExtras = { ...c.gateExtras, factoryRules: (path: string) => repo.readFile("main", path) };
  k.wrapped = true;
}

/** PBI 12's judge, following the judge prompt of the logic the factory runs with. */
function follow12(world: object, p: PollCtx): void {
  const k = ctx(world);
  p.lastLineFor = (item, dor) => {
    const prompt = p.logic ? p.logic.judgePrompt : judgePrompt(item, dor as Policy);
    const rules = k.rules.get(item.title) ?? [];
    const reply = following(k, item, JSON.stringify({ flags: [] }), prompt);
    return { rules, flags: (JSON.parse(reply) as { flags: string[] }).flags };
  };
}

function lastFlags(world: object, title: string): string[] {
  const replies = ctx(world).replies.get(title) ?? [];
  assert.ok(replies.length > 0, `the readiness judge was never asked about "${title}"`);
  return (JSON.parse(replies.at(-1)!.split("\n").at(-1)!) as { flags: string[] }).flags;
}

Given("the readiness judge flags an item that changes the factory's rules as needing the owner's approval, unless its prompt says such a change is never a flag", function () {
  wrap(this);
});

// ---- the judge's prompt ----

When("the factory builds the readiness judge's prompt for an item", async function () {
  const c = ctx144(this);
  const dor = await loadPolicy(async (p) => (p === ".factory/dor.md" ? c.dor : null), "dor");
  assert.ok(dor, "the repo's dor.md didn't load");
  const item: FactoryItem = {
    sourceId: "", externalId: "1", title: "Card payments", body: "Card payments for Checkout redesign", acceptanceCriteria: ["A shopper can pay by card"],
    labels: [], status: "Backlog", rank: 1, repo: c.repo, fields: {}, closed: false, updatedAt: new Date(0).toISOString(),
  };
  ctx(this).prompt = judgePrompt(item, dor);
});

function prompt(world: object): string {
  const p = ctx(world).prompt;
  assert.ok(p, "no prompt was built");
  return p;
}

Then("the prompt says a change to the factory's rules that still needs the owner's approval is never a flag", function () {
  assert.ok(neverAFlag(prompt(this)), `the prompt doesn't say a rule change awaiting the owner's approval is never a flag:\n${prompt(this)}`);
});

Then("the prompt says the engine asks the owner for the approval of a change to the factory's rules", function () {
  assert.ok(engineAsks(prompt(this)), `the prompt doesn't say the engine asks the owner for that approval:\n${prompt(this)}`);
});

// ---- an item with a rules section ----

const section = (before: string, after: string) => `${RULES_HEADING}\n\n### Spec §6\n**Before**\n> ${before}\n\n**After**\n> ${after}\n`;

Given("an item {string} in {string} whose body has a rules section changing spec section {string} from its text on main", function (title: string, repo: string, place: string) {
  assert.equal(place, "§6", "these steps write a rules section for spec §6");
  const body = `${title}, so a stuck cell frees its slot sooner.\n\n## ${HEADING}\n\n- A lease lasts five minutes\n\n${section(onMain(ruleCtx(this), place), AFTER_6)}`;
  ctx(this).subject = { title, repo, body };
});

function subject(world: object, title: string): Subject {
  const s = ctx(world).subject;
  assert.ok(s && s.title === title, `no item "${title}" was set up`);
  return s;
}

Given("the readiness judge passes item {string} on every dor.md line and finds it changes spec section {string}", function (title: string, place: string) {
  subject(this, title);
  ctx(this).rules.set(title, [place]);
  pollCtx(this).judge = "pass";
});

When("the readiness judge checks item {string}", async function (title: string) {
  const s = subject(this, title);
  wrap(this);
  const c = ctx144(this);
  const ext = await c.fake.seed({ title, body: s.body, acceptanceCriteria: acceptanceCriteria(s.body, HEADING), labels: [], repo: s.repo, status: c.backlogStatus });
  const item = await c.fake.adapter.getItem(ext);
  assert.ok(item);
  const dor = await loadPolicy(async (p) => (p === ".factory/dor.md" ? c.dor : null), "dor");
  await gate(item, {
    readinessSha: "policy-1", dor, dodExists: true, configValid: true, repoKnown: true, judge: c.judgeOverride!, adapter: c.fake.adapter, ...c.gateExtras,
  });
});

Then("the readiness judge raised no flag for item {string}", function (title: string) {
  const flags = lastFlags(this, title);
  assert.deepEqual(flags, [], `the readiness judge flagged item "${title}": ${flags.join("; ")}`);
});

// ---- a proposed child with a rules section ----

type Proposal = { children: { title: string; body: string; criteria: number[]; needs: number[] }[] };

Given("proposed child {string} has this section in its body:", function (title: string, rules: string) {
  const c = ctx144(this);
  const split = JSON.parse(c.reply) as Proposal;
  const child = split.children.find((ch) => ch.title === title);
  assert.ok(child, `the proposed split has no child "${title}"`);
  child.body = `${child.body}\n\n${rules}`;
  c.reply = JSON.stringify(split);
  ctx(this).sections.set(title, rules);
  // A rewrite of this child names its screen and keeps its rules section as it was.
  ctx264(this).rewrites.set(title, `${title} on the payment screen for ${c.parentTitle}.\n\n${rules}`);
});

Given("the coding model's rewrite of child {string} leaves its rules section as it was", function (title: string) {
  const rules = ctx(this).sections.get(title);
  assert.ok(rules, `proposed child "${title}" has no rules section`);
  ctx264(this).rewrites.set(title, `${title} on the payment screen for ${ctx144(this).parentTitle}.\n\n${rules}`);
});

Given("the readiness judge passes every proposed child on every dor.md line", function () {
  wrap(this);
});

Given("the readiness judge finds proposed child {string} changes spec section {string}", function (title: string, place: string) {
  ctx(this).rules.set(title, [place]);
});

Given("the readiness judge finds proposed child {string} changes spec section {string} and the policy file {string}", function (title: string, place: string, path: string) {
  ctx(this).rules.set(title, [place, path]);
});

// ---- the filed child and the split proposal ----

Then("the filed child {string} has that {string} section in its body word for word", async function (title: string, heading: string) {
  assert.equal(`## ${heading}`, RULES_HEADING);
  const c = ctx144(this);
  polled144(c);
  const rules = ctx(this).sections.get(title);
  assert.ok(rules, `proposed child "${title}" has no rules section`);
  const filed = c.filed.filter((i) => i.title === title);
  assert.equal(filed.length, 1, `child "${title}" was filed ${filed.length} times`);
  const body = (await c.fake.adapter.getItem(filed[0].externalId))?.body ?? "";
  assert.ok(body.includes(rules.trim()), `the filed child's body doesn't carry its rules section word for word:\n${body}`);
});

async function proposals(world: object): Promise<string[]> {
  const c = ctx144(world);
  polled144(c);
  const found = (await c.fake.comments(c.parentId!)).filter((b) => b.startsWith(SPLIT_HEADING));
  assert.ok(found.length > 0, "the parent issue has no split proposal comment");
  return found;
}

/** The lines of a proposal's section on child `title` that aren't its quoted body: what the comment says of it. */
function about(comment: string, title: string): string[] {
  const part = comment.split(/^(?=### )/m).find((s) => new RegExp(`^### \\d+\\. ${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m").test(s.split("\n")[0]));
  assert.ok(part, `the split proposal comment has no section on child "${title}":\n${comment}`);
  return part.split("\n").slice(1).filter((l) => !l.startsWith(">"));
}

function childTitles(world: object): string[] {
  return (JSON.parse(ctx144(world).reply) as Proposal).children.map((ch) => ch.title);
}

function dorLines(world: object): string[] {
  return ctx144(world).dor.split("\n").map((l) => /^- \[ \] (.+)$/.exec(l)?.[1]).filter((l): l is string => !!l);
}

Then("the parent issue's split proposal comment names no child as failing a line", async function () {
  for (const comment of await proposals(this)) {
    for (const title of childTitles(this)) {
      const says = about(comment, title);
      for (const line of dorLines(this)) assert.ok(!says.some((l) => l.includes(line)), `the proposal names child "${title}" as failing "${line}":\n${comment}`);
    }
  }
});

async function noFlag(world: object, title: string): Promise<void> {
  for (const comment of await proposals(world)) {
    assert.ok(!about(comment, title).some((l) => l.includes(APPROVAL_FLAG)), `the proposal raises a flag for child "${title}":\n${comment}`);
  }
}

Then("the parent issue's split proposal comment raises no flag for child {string}", async function (title: string) {
  await noFlag(this, title);
});

Then("that comment raises no flag for child {string}", async function (title: string) {
  await noFlag(this, title);
});

const MISMATCH = /isn['’]t on main|not on main|doesn['’]t match|does not match|isn['’]t what|differs/i;

async function namesBefore(world: object, title: string, place: string): Promise<void> {
  const all = await proposals(world);
  const says = (l: string) => l.includes(place) && /Before/i.test(l) && /\bmain\b/.test(l) && MISMATCH.test(l);
  assert.ok(all.some((b) => about(b, title).some(says)),
    `no split proposal comment names child "${title}" as failing because its Before for ${place} isn't on main:\n${all.join("\n-----\n")}`);
}

Then("that comment names child {string} as failing because its Before for spec section {string} isn't on main word for word", async function (title: string, place: string) {
  await namesBefore(this, title, place);
});

Then("the parent issue's split proposal comment names child {string} as failing because its Before for spec section {string} isn't on main word for word", async function (title: string, place: string) {
  await namesBefore(this, title, place);
});

Then("the parent issue's split proposal comment names child {string} as failing because its Before for the policy file {string} isn't on main word for word", async function (title: string, path: string) {
  await namesBefore(this, title, path);
});

Then("that comment doesn't name child {string} as failing over spec section {string}", async function (title: string, place: string) {
  for (const comment of await proposals(this)) {
    const over = about(comment, title).filter((l) => l.includes(place));
    assert.deepEqual(over, [], `the proposal names child "${title}" as failing over ${place}:\n${comment}`);
  }
});

Then("the parent issue's split proposal comment names child {string} as having to cover the policy file {string} in its rules section", async function (title: string, path: string) {
  const all = await proposals(this);
  const says = (l: string) => l.includes(path) && /\bcover/i.test(l) && /rules|section/i.test(l);
  assert.ok(all.some((b) => about(b, title).some(says)),
    `no split proposal comment names child "${title}" as having to cover ${path} in its rules section:\n${all.join("\n-----\n")}`);
});

// ---- a filed child, polled by the real poller ----

/** Polls with the real poller on the test database over PBI 144's board, PBI 264's judge following its prompt. */
async function realPoll(world: object, real: Real, c: Ctx144): Promise<void> {
  for (const i of c.filed) real.before.set(i.externalId, (await c.fake.comments(i.externalId)).length);
  const adapter: BacklogAdapter = {
    ...c.fake.adapter,
    async openDependencies() {
      return [];
    },
  };
  const split: SplitDeps = {
    sop: { models: { coding: "coding-model" } }, agent: c.agentOverride!, seen: c.seen, effort: async () => "medium",
    file: { board: scriptedBoard(c), optInLabel: c.label, backlogStatus: c.backlogStatus, criteriaHeading: HEADING },
  };
  try {
    await pollOnce({ pool: pool(), adapter, repoHost: real.host, judge: c.judgeOverride!, sourceId: real.sourceId, split, factoryRepo: factoryRepo(ruleCtx(world)) });
  } catch (e) {
    c.errors.push(e);
  }
  c.polls++;
}

Given("a child {string} the factory filed from the parent's split, whose body has this section:", long, async function (title: string, rules: string) {
  wrap(this);
  const k = ctx(this);
  const c = ctx144(this);
  const d = await testDb();
  assert.ok(d, "no test database");
  const sourceId = (await pool().query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'test:' || gen_random_uuid()) returning id")).rows[0].id;
  await pool().query("insert into repo (host_adapter, url) values ('fake', $1)", [`https://github.com/${c.repo}`]);
  const host = fakeRepoHost();
  for (const [path, t] of Object.entries({ ...baseFiles, ".factory/dor.md": c.dor })) host.files.set(`${c.repo}@s1:${path}`, t);
  host.heads.set(c.repo, "s1");
  const real: Real = { sourceId, host, before: new Map() };
  k.real = real;
  c.driver = (cc) => realPoll(this, real, cc);

  // The child as the split filed it: child 2, needing child 1, with its criterion and its split marker.
  const parent = await c.fake.adapter.getItem(c.parentId!);
  assert.ok(parent);
  const body = childBody(parent, { title, body: `${title} for ${c.parentTitle}\n\n${rules}`, criteria: [2], needs: [1] }, 2, HEADING);
  const ext = await c.fake.seed({ title, body, acceptanceCriteria: acceptanceCriteria(body, HEADING), labels: [], repo: c.repo, status: c.backlogStatus });
  c.filed.push({ externalId: ext, title, url: `https://github.com/${c.repo}/issues/${ext}`, repo: c.repo });
  c.subIssues.set(c.parentId!, [...(c.subIssues.get(c.parentId!) ?? []), ext]);
  c.board.set(ext, c.backlogStatus);
  await replaceItem(c, c.parentId!, (fi) => ({ labels: fi.labels.filter((l) => l !== c.label) }));
  k.sections.set(title, rules);
});

function filedId(world: object, title: string): string {
  const found = ctx144(world).filed.filter((i) => i.title === title);
  assert.equal(found.length, 1, `child "${title}" was filed ${found.length} times`);
  return found[0].externalId;
}

Given("the readiness judge passes child {string} on every dor.md line and finds it changes spec section {string}", function (title: string, place: string) {
  filedId(this, title);
  ctx(this).rules.set(title, [place]);
});

Given("the owner has put the label {string} on child {string}", async function (label: string, title: string) {
  const c = ctx144(this);
  await replaceItem(c, filedId(this, title), (fi) => ({ labels: fi.labels.includes(label) ? fi.labels : [...fi.labels, label] }));
});

function realOf(world: object): Real {
  const r = ctx(world).real;
  assert.ok(r, "the filed child wasn't set up");
  return r;
}

function polledReal(world: object): void {
  const c = ctx144(world);
  polled144(c);
  assert.deepEqual(c.errors, [], "a poll raised an error");
}

async function rowOf(world: object, title: string): Promise<{ id: string; state: string }> {
  const r = await pool().query<{ id: string; state: string }>("select id, state from item where source_id = $1 and external_id = $2",
    [realOf(world).sourceId, filedId(world, title)]);
  assert.ok(r.rows[0], `the factory holds no item for child "${title}"`);
  return r.rows[0];
}

/** Whether this scenario polls a filed child with the real poller, so PBI 226's "the factory holds child" checks it here. */
export const realPolled = (world: object): boolean => !!(world as { pbi444?: Ctx }).pbi444?.real;

/** "The factory holds child X in state Y", as a Then: PBI 226's step hands it here for these scenarios. */
export async function heldIn(world: object, title: string, state: string): Promise<void> {
  polledReal(world);
  assert.equal((await rowOf(world, title)).state, state);
}

Then("child {string} is no longer in state {string}", long, async function (title: string, state: string) {
  polledReal(this);
  const k = ctx(this);
  assert.equal(k.approval, 303, `the owner's approval answered ${k.approval ?? "nothing"}`);
  assert.notEqual((await rowOf(this, title)).state, state);
});

Then("child {string} has a new readiness comment saying it waits for the owner to approve its change to spec section {string}", long, async function (title: string, place: string) {
  polledReal(this);
  const k = ctx(this);
  const c = ctx144(this);
  const ext = filedId(this, title);
  const all = (await c.fake.comments(ext)).slice(realOf(this).before.get(ext) ?? 0);
  const found = all.find((b) => b.split("\n").some((l) => l.includes(place) && WAITS.test(l)));
  assert.ok(found, `no new readiness comment on child "${title}" says it waits for the owner to approve its change to ${place}:\n${all.join("\n---\n") || "(no new comment)"}`);
  if (k.approval !== undefined) assert.equal(k.approval, 303, `the owner's earlier approval answered ${k.approval}`);
  k.comment = found;
});

Then("that comment raises no flag", function () {
  const comment = ctx(this).comment;
  assert.ok(comment, "no comment was found");
  assert.ok(!comment.includes(APPROVAL_FLAG), `the comment raises a flag:\n${comment}`);
});

// ---- the filed child's item page and the owner's approval ----

const headers = (login: string) => ({ "x-ms-client-principal-idp": "aad", "x-ms-client-principal-id": login, "x-ms-client-principal-name": login });

async function dashboard(world: object): Promise<Ctx> {
  const k = ctx(world);
  if (k.server) return k;
  let handler: ReturnType<typeof dashboardRoutes> | undefined;
  k.server = await startServer([(req, res) => handler!(req, res)], { port: 0 });
  k.origin = `http://127.0.0.1:${(k.server.address() as AddressInfo).port}`;
  handler = dashboardRoutes({ pool: pool(), auth: createAuth({ mode: "azure" }), origin: k.origin, adapter: ctx144(world).fake.adapter, sourceId: realOf(world).sourceId });
  k.close = handler.close;
  await pool().query(
    `insert into "user" (provider, subject, github_login, role) values ('microsoft', $1, $1, 'owner') on conflict (provider, subject) do nothing`, [OWNER]);
  return k;
}

async function openPage(world: object, title: string): Promise<void> {
  polledReal(world);
  const k = await dashboard(world);
  const { id } = await rowOf(world, title);
  const r = await fetch(`${k.origin}/items/${id}`, { headers: { ...headers(OWNER), cookie: "tz=UTC" }, redirect: "manual" });
  // PBI 395's item page steps read the page from its context.
  ruleCtx(world).page = { status: r.status, html: await r.text() };
}

async function approve(world: object, title: string): Promise<void> {
  polledReal(world);
  const k = await dashboard(world);
  const { id } = await rowOf(world, title);
  const shown = ruleChangesHash((await ruleChangesChecked(pool(), id)) ?? []);
  const r = await fetch(`${k.origin}/items/${id}/rule-approval`, {
    method: "POST", redirect: "manual",
    headers: { ...headers(OWNER), origin: k.origin!, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ruleChangesHash: shown }).toString(),
  });
  await r.text();
  // Whether the item page took the approval is read by the Thens, so a refusal fails there.
  k.approval = r.status;
}

When("the owner approves the rule change on child {string}'s item page", long, async function (title: string) {
  await approve(this, title);
});

Given("the owner has approved the rule change on child {string}'s item page", long, async function (title: string) {
  await approve(this, title);
});

Given("child {string}'s After has since been edited to {string}", async function (title: string, after: string) {
  const c = ctx144(this);
  const ext = filedId(this, title);
  const was = (await c.fake.adapter.getItem(ext))?.body ?? "";
  const old = /\*\*After\*\*\n> (.+)/.exec(ctx(this).sections.get(title) ?? "")?.[1];
  assert.ok(old && was.includes(`> ${old}`), `child "${title}"'s body has no After to edit`);
  const body = was.replace(`> ${old}`, `> ${after}`);
  await replaceItem(c, ext, (fi) => ({ body, updatedAt: new Date(Date.parse(fi.updatedAt) + 1000).toISOString() }));
});

Then("the item page says child {string} waits for the owner to approve its rule changes", long, async function (title: string) {
  await openPage(this, title);
  const part = text(rulesPart(this));
  assert.match(part, WAITS, `the Rule changes section doesn't say child "${title}" waits for the owner's approval: ${part}`);
});

Then("the item page for child {string} shows spec section {string} with Before {string} and After {string}", long, async function (title: string, place: string, before: string, after: string) {
  await openPage(this, title);
  const entry = ruleEntry(this, place);
  assert.equal(text(side(entry, "before")), before, `the Before shown for ${place}`);
  assert.equal(text(side(entry, "after")), after, `the After shown for ${place}`);
});

Then("child {string}'s history shows the owner's approval of its rule change", long, async function (title: string) {
  polledReal(this);
  const { id } = await rowOf(this, title);
  const r = await pool().query("select 1 from event where item_id = $1 and kind = 'rule_change_approved' and actor = 'human'", [id]);
  assert.ok((r.rowCount ?? 0) > 0, `child "${title}"'s history shows no approval of its rule change`);
});

// ---- the new judge prompt as a readiness logic change ----

const files: ReadinessTexts = {
  dor: "- [ ] Names the screen it changes\n", scenarios: "Keep each scenario short.\n", "pr-review": "- [ ] The change is correct.\n",
  risk: "Low means docs only.\n", dod: "- [ ] Tests pass\n", config: "bdd: {}\n",
};

Given("one readiness check that reads a set of repo files with the judge prompt the factory shipped before this change", function () {
  ctx149(this).checks.push({ texts: { ...files }, logic: oldLogic() });
});

Given("another that reads the same files with the factory's current logic", function () {
  ctx149(this).checks.push({ texts: { ...files }, logic: readinessLogic() });
});

/** Holds `n` fresh items in `state` in PBI 12's harness, checked with the old judge prompt. */
async function holdOld(world: object, n: number, state: string): Promise<void> {
  const c = pollCtx(world);
  assert.ok(await setup(c), "PBI 12's harness couldn't be set up");
  c.extIds = [];
  for (let i = 0; i < n; i++) c.extIds.push(await c.fake!.seed({ labels: ["factory"], repo: "octo/repo" }));
  c.logic = oldLogic();
  follow12(world, c);
  await gateIntoNotReady(world, c, state);
}

Given("the factory holds two items in state {string}, checked with the judge prompt the factory shipped before this change", long, async function (state: string) {
  await holdOld(this, 2, state);
});

Given("the factory holds an item in state {string}, checked with the judge prompt the factory shipped before this change", long, async function (state: string) {
  await holdOld(this, 1, state);
});

Given("the factory holds item {string} in state {string}, checked with the judge prompt the factory shipped before this change, because the judge flagged its rule change",
  long, async function (title: string, state: string) {
    const s = subject(this, title);
    const k = ctx(this);
    const c = pollCtx(this);
    assert.ok(await setup(c), "PBI 12's harness couldn't be set up");
    const host = c.host!;
    for (const [path, t] of Object.entries({ ...baseFiles, ".factory/dor.md": ctx144(this).dor })) host.files.set(`${s.repo}@c1:${path}`, t);
    host.heads.set(s.repo, "c1");
    await pool().query("insert into repo (host_adapter, url) values ('fake', $1)", [`https://github.com/${s.repo}`]);
    const ext = await c.fake!.seed({ title, body: s.body, acceptanceCriteria: acceptanceCriteria(s.body, HEADING), labels: ["factory"], repo: s.repo });
    c.extIds = [ext];
    c.deps = { ...c.deps, factoryRepo: factoryRepo(ruleCtx(this)) };
    c.logic = oldLogic();
    c.judge = "pass";
    k.rules.set(title, ["§6"]);
    follow12(this, c);
    await poll12(c);
    assert.equal(c.error, undefined, `the poll failed: ${String(c.error)}`);
    assert.equal(await stateOf(c, ext), state, "setup didn't reach the expected state");
    assert.ok(lastFlags(this, title).includes(APPROVAL_FLAG), "the judge didn't flag the item's rule change");
    // PBI 395's "the factory holds item ... in state" reads the item by the name the scenario gives it.
    const id = (await pool().query<{ id: string }>("select id from item where source_id = $1 and external_id = $2", [c.sourceId, ext])).rows[0].id;
    itemCtx(this).items.push({ id, ext: title, title, sourceId: c.sourceId!, repoId: null });
    c.asked.clear();
    // The comments the next polls post are the new ones.
    c.beforePoll = async () => {
      ctx149(this).commentsBefore.set(ext, (await c.fake!.comments(ext)).length);
    };
    c.baseline = await baseline(c);
  });

Given("the factory restarts with its current logic", function () {
  pollCtx(this).logic = readinessLogic();
});

function heldBy(world: object, title: string): { c: PollCtx; ext: string } {
  const c = pollCtx(world);
  assert.equal(c.error, undefined, `the poll failed: ${String(c.error)}`);
  assert.ok(c.polls > 0, "the poller didn't run");
  subject(world, title);
  assert.equal(c.extIds.length, 1, `the scenario holds ${c.extIds.length} items`);
  return { c, ext: c.extIds[0] };
}

Then("item {string}'s history shows one move {string}", long, async function (title: string, event: string) {
  const { c, ext } = heldBy(this, title);
  const r = await pool().query<{ n: number }>(
    `select count(*)::int as n from event e join item i on i.id = e.item_id
     where i.source_id = $1 and i.external_id = $2 and e.kind = 'transition' and e.payload->>'event' = $3`,
    [c.sourceId, ext, event],
  );
  assert.equal(r.rows[0].n, 1, `item "${title}"'s history shows ${r.rows[0].n} moves "${event}"`);
});

Then("the board item {string} has a new readiness comment saying it waits for the owner to approve its change to spec section {string}", long, async function (title: string, place: string) {
  const { c, ext } = heldBy(this, title);
  const all = (await c.fake!.comments(ext)).slice(ctx149(this).commentsBefore.get(ext) ?? 0);
  const found = all.find((b) => b.split("\n").some((l) => l.includes(place) && WAITS.test(l)));
  assert.ok(found, `no new readiness comment on "${title}" says it waits for the owner to approve its change to ${place}:\n${all.join("\n---\n") || "(no new comment)"}`);
  ctx(this).comment = found;
});
