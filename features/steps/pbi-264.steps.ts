// Step definitions for features/pbi-264-split-children-gated-before-filing.feature. Everything runs on PBI 144's poll
// harness: its fake backlog and scripted SplitBoard, which also says who opened and edited an issue and records every
// body the factory writes over one. This file scripts the readiness judge per item, so a proposed child, a filed child,
// a rewritten child and any other issue can each pass or fail its own dor.md lines, and records each time the judge was
// asked. It scripts the coding model too: a request that opens with REWRITE_HEADING is a rewrite, answered with the
// body the scenario gave, and any other request is the split request, answered with the Background's split.
import { DataTable, Given, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { FactoryItem } from "../../src/adapters/types.ts";
import type { AgentArgs, AgentResult } from "../../src/agent/run.ts";
import { REWRITE_HEADING } from "../../src/gate/repair.ts";
import { SPLIT_HEADING } from "../../src/gate/split.ts";
import type { Policy } from "../../src/policy/policy.ts";
import { ctx as ctx144, polled, replaceItem, type Ctx as Ctx144 } from "./pbi-144.steps.ts";

const HEADING = "Acceptance criteria";
/** A flag the judge raises for a credential. It names neither the owner nor what to do, so the factory must say that. */
const CREDENTIAL_FLAG = "asks for the payment provider's live API key";
/** The permission the factory's App lacks in the permission scenario. */
const PERMISSION = "issues: write";

type Fail = { line: string; reason: string };
/** One item's script: the lines it fails, and whether the judge flags it as needing an owner-only credential. */
type Script = { fails: Fail[]; credential: boolean };
type Phase = "parent" | "proposed" | "filed" | "issue";
type Ask = { title: string; externalId: string; phase: Phase; rewritten: boolean; criteria: string[]; filedBefore: number };

type Ctx = {
  proposed: Map<string, Script>;
  filed: Map<string, Script>;
  /** A rewritten child's script, proposed or filed: the judge's answer once the coding model rewrote it. */
  rewritten: Map<string, Script>;
  /** Any other issue, by title. */
  issues: Map<string, Script>;
  /** The issues this file seeded that the factory didn't file, by title. */
  others: Map<string, string>;
  /** The body each rewrite of a child answers with, by title. */
  rewrites: Map<string, string>;
  /** The text a rewritten child's body must open with, by title, for a rewrite whose body had its own criteria section. */
  leads: Map<string, string>;
  /** The body a person wrote over a child, by title. */
  personBodies: Map<string, string>;
  asks: Ask[];
  installed: boolean;
};

function ctx(world: object): Ctx {
  const w = world as { pbi264?: Ctx };
  if (!w.pbi264) {
    w.pbi264 = {
      proposed: new Map(), filed: new Map(), rewritten: new Map(), issues: new Map(), others: new Map(), rewrites: new Map(),
      leads: new Map(), personBodies: new Map(), asks: [], installed: false,
    };
  }
  const k = w.pbi264;
  if (!k.installed) install(world, k);
  return k;
}

/**
 * The text the body of child `title` must open with when this scenario rewrote it with a body carrying its own criteria
 * section, so a Then about that child's criteria reads the rewritten body, not the one first filed. PBI 249's steps ask.
 */
export function rewrittenLead(world: object, title: string): string | undefined {
  return (world as { pbi264?: Ctx }).pbi264?.leads.get(title);
}

const proposedTitles = (c: Ctx144): string[] => {
  if (!c.reply) return [];
  return (JSON.parse(c.reply) as { children: { title: string }[] }).children.map((ch) => ch.title);
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The child a rewrite request is about: the one whose title its fenced JSON carries. */
const rewriteOf = (a: AgentArgs, title: string) =>
  a.prompt.startsWith(REWRITE_HEADING) && new RegExp(`"title":\\s*${escape(JSON.stringify(title))}`).test(a.prompt);

const rewriteRequests = (c: Ctx144, title?: string) =>
  c.requests.filter((a) => a.prompt.startsWith(REWRITE_HEADING) && (title === undefined || rewriteOf(a, title)));

function install(world: object, k: Ctx): void {
  k.installed = true;
  const c = ctx144(world);
  c.judgeOverride = async (item: FactoryItem, dor: Policy) => {
    const titles = proposedTitles(c);
    const isFiled = c.filed.some((i) => i.externalId === item.externalId);
    const phase: Phase = item.title === c.parentTitle && !isFiled ? "parent"
      : titles.includes(item.title) && !k.others.has(item.title) ? (isFiled ? "filed" : "proposed") : "issue";
    const rewritten = (phase === "proposed" || phase === "filed") && rewriteRequests(c, item.title).length > 0;
    k.asks.push({
      title: item.title, externalId: item.externalId, phase, rewritten, criteria: dor.criteria.map((cr) => cr.text),
      filedBefore: c.filed.filter((i) => i.repo === c.repo).length,
    });
    const script = phase === "parent" ? undefined
      : rewritten ? k.rewritten.get(item.title)
      : phase === "proposed" ? k.proposed.get(item.title)
      : phase === "filed" ? k.filed.get(item.title)
      : k.issues.get(item.title);
    const verdicts = dor.criteria.map((cr) => {
      const f = script?.fails.find((x) => x.line === cr.text);
      return JSON.stringify({ index: cr.index, status: f ? "failed" : "passed", reason: f ? f.reason : "ok" });
    });
    const oversized = phase === "parent" && c.oversized;
    return [...verdicts, JSON.stringify({ flags: script?.credential ? [CREDENTIAL_FLAG] : [], oversized })].join("\n");
  };
  c.agentOverride = async (a: AgentArgs): Promise<AgentResult> => {
    c.requests.push(a);
    let text = c.reply;
    if (a.prompt.startsWith(REWRITE_HEADING)) {
      const title = proposedTitles(c).find((t) => rewriteOf(a, t));
      const body = title ? (k.rewrites.get(title) ?? `${title} for ${c.parentTitle}, rewritten`) : "Rewritten";
      text = JSON.stringify({ body });
    }
    return { ok: true, text, costUsd: 0, tokensIn: 0, tokensOut: 0, model: a.model, limit: null, usage: null, transcript: "" };
  };
}

const script = (m: Map<string, Script>, title: string): Script => {
  let s = m.get(title);
  if (!s) m.set(title, (s = { fails: [], credential: false }));
  return s;
};

function filedChild(c: Ctx144, title: string) {
  polled(c);
  const found = c.filed.filter((i) => i.title === title);
  assert.equal(found.length, 1, `child "${title}" was filed ${found.length} times`);
  return found[0];
}

/** The external id of child or issue `title`: a child the factory filed, or an issue this file seeded. */
function idOf(world: object, title: string): string {
  const other = ctx(world).others.get(title);
  return other ?? filedChild(ctx144(world), title).externalId;
}

async function body(c: Ctx144, id: string): Promise<string> {
  const fi = await c.fake.adapter.getItem(id);
  assert.ok(fi, `no item ${id}`);
  return fi.body;
}

async function seedIssue(world: object, title: string, repo: string, label: string, text: string): Promise<string> {
  const c = ctx144(world);
  const body = `${text}\n\n## ${HEADING}\n\n- A shopper can save a card for next time\n`;
  const id = await c.fake.seed({ title, body, acceptanceCriteria: ["A shopper can save a card for next time"], labels: [label], repo, status: c.backlogStatus });
  c.board.set(id, c.backlogStatus);
  ctx(world).others.set(title, id);
  return id;
}

// --- Background ----------------------------------------------------------------------------------------------------

Given("the repo has a {string} with these criteria:", function (path: string, table: DataTable) {
  assert.equal(path, ".factory/dor.md");
  ctx(this);
  ctx144(this).dor = `# Definition of Ready\n\n${table.hashes().map((r) => `- [ ] ${r.text}`).join("\n")}\n`;
});

// --- The judge's script --------------------------------------------------------------------------------------------

Given("the readiness judge passes every proposed child on every line", function () {
  ctx(this);
});

Given("the readiness judge passes every other proposed child on every line", function () {
  ctx(this);
});

Given("the readiness judge passes proposed child {string} on every line", function (title: string) {
  ctx(this).proposed.set(title, { fails: [], credential: false });
});

Given("the readiness judge fails proposed child {string} on {string} because {string}", function (title: string, line: string, reason: string) {
  script(ctx(this).proposed, title).fails.push({ line, reason });
});

Given("the readiness judge flags proposed child {string} as needing a credential only the owner can grant", function (title: string) {
  script(ctx(this).proposed, title).credential = true;
});

Given("the readiness judge passes the rewritten child {string} on every line", function (title: string) {
  ctx(this).rewritten.set(title, { fails: [], credential: false });
});

Given("the readiness judge fails the rewritten child {string} on {string} because {string}", function (title: string, line: string, reason: string) {
  script(ctx(this).rewritten, title).fails.push({ line, reason });
});

Given("the readiness judge passes child {string} on every line", function (title: string) {
  ctx(this).filed.set(title, { fails: [], credential: false });
});

Given("the readiness judge fails child {string} on {string} because {string}", function (title: string, line: string, reason: string) {
  script(ctx(this).filed, title).fails.push({ line, reason });
});

Given("the readiness judge flags child {string} as needing a credential only the owner can grant", function (title: string) {
  script(ctx(this).filed, title).credential = true;
});

Given("the readiness judge fails issue {string} on {string} because {string}", function (title: string, line: string, reason: string) {
  script(ctx(this).issues, title).fails.push({ line, reason });
});

// --- The coding model's rewrites -----------------------------------------------------------------------------------

Given("the coding model rewrites child {string} with the body {string}", function (title: string, text: string) {
  ctx(this).rewrites.set(title, text);
});

Given("the coding model rewrites child {string} with a body that has its own reworded section under {string}", function (title: string, heading: string) {
  const k = ctx(this);
  const lead = `${title} on the payment screen for ${ctx144(this).parentTitle}.`;
  k.rewrites.set(title, `${lead}\n\n## ${heading}\n\n- ${title} works\n- ${title} errors are shown`);
  k.leads.set(title, lead);
});

// --- Who opened and edited an issue --------------------------------------------------------------------------------

Given("nobody has edited child {string} since the factory filed it", function (title: string) {
  const c = ctx144(this);
  ctx(this);
  const ch = filedChild(c, title);
  assert.ok(!c.personEdited.has(ch.externalId), `a person has edited child "${title}"`);
});

Given("a person has edited the body of child {string} since the factory filed it", async function (title: string) {
  const c = ctx144(this);
  const ch = filedChild(c, title);
  const was = await body(c, ch.externalId);
  const now = `A shopper pays by bank transfer through the bank's own page.\n\n${was}`;
  await replaceItem(c, ch.externalId, (fi) => ({ body: now, updatedAt: new Date(Date.parse(fi.updatedAt) + 1000).toISOString() }));
  c.personEdited.add(ch.externalId);
  ctx(this).personBodies.set(title, now);
});

Given("a person has filed an issue {string} in {string} as a sub-issue of the parent, carrying the label {string}", async function (title: string, repo: string, label: string) {
  const c = ctx144(this);
  const id = await seedIssue(this, title, repo, label, `${title} for ${c.parentTitle}`);
  c.subIssues.set(c.parentId!, [...(c.subIssues.get(c.parentId!) ?? []), id]);
});

Given("a person has filed an issue {string} in {string} whose body carries the split marker of child {string}, carrying the label {string}", async function (title: string, repo: string, child: string, label: string) {
  const c = ctx144(this);
  const marker = /factory-split-[0-9a-f]+-\d+/.exec(await body(c, filedChild(c, child).externalId))?.[0];
  assert.ok(marker, `child "${child}" carries no split marker`);
  await seedIssue(this, title, repo, label, `${title} for ${c.parentTitle}, copied from (${marker}).`);
});

Given("the factory's App has opened an issue {string} in {string} with no split marker, carrying the label {string}", async function (title: string, repo: string, label: string) {
  const c = ctx144(this);
  const id = await seedIssue(this, title, repo, label, `${title} for ${c.parentTitle}`);
  c.appOpened.add(id);
});

Given("the factory's App lacks a permission on {string} that only the owner can grant", function (repo: string) {
  const c = ctx144(this);
  assert.equal(repo, c.repo);
  c.gateExtras = { ...c.gateExtras, missingPermissions: [PERMISSION] };
});

// --- The judge's asks ----------------------------------------------------------------------------------------------

function proposedAsks(world: object): Ask[] {
  polled(ctx144(world));
  return ctx(world).asks.filter((a) => a.phase === "proposed" && !a.rewritten);
}

const showAsks = (asks: Ask[]) => asks.map((a) => `${a.title} (${a.phase}${a.rewritten ? ", rewritten" : ""})`).join(", ") || "none";

/** Checks the judge was asked about each proposed child at least once, and returns the asks. */
function everyProposed(world: object): Ask[] {
  const asks = proposedAsks(world);
  for (const t of proposedTitles(ctx144(world))) {
    assert.ok(asks.some((a) => a.title === t), `the readiness judge was never asked about proposed child "${t}"; asked about: ${showAsks(ctx(world).asks)}`);
  }
  return asks;
}

Then("the readiness judge was asked about each of the {int} proposed children once", function (n: number) {
  const titles = proposedTitles(ctx144(this));
  assert.equal(titles.length, n);
  const asks = proposedAsks(this);
  for (const t of titles) {
    const got = asks.filter((a) => a.title === t).length;
    assert.equal(got, 1, `the readiness judge was asked about proposed child "${t}" ${got} times; asked about: ${showAsks(ctx(this).asks)}`);
  }
});

Then("the readiness judge was asked about every proposed child before {string} held any new issue", function (repo: string) {
  assert.equal(repo, ctx144(this).repo);
  const asks = everyProposed(this);
  for (const t of proposedTitles(ctx144(this))) {
    assert.ok(asks.some((a) => a.title === t && a.filedBefore === 0), `the judge was first asked about "${t}" after a child was filed`);
  }
});

Then("the readiness judge was given these dor.md criteria for each proposed child, word for word:", function (table: DataTable) {
  const want = table.hashes().map((r) => r.text);
  for (const a of everyProposed(this)) assert.deepEqual(a.criteria, want, `the judge's dor.md criteria for "${a.title}"`);
});

Then("the criteria the judge was given for each proposed child are the ones it was given for the parent issue", function () {
  const parent = ctx(this).asks.find((a) => a.phase === "parent");
  assert.ok(parent, "the readiness judge was never asked about the parent issue");
  for (const a of everyProposed(this)) assert.deepEqual(a.criteria, parent.criteria, `the judge's dor.md criteria for "${a.title}"`);
});

function rewrittenAsks(world: object, title: string): Ask[] {
  polled(ctx144(world));
  return ctx(world).asks.filter((a) => a.title === title && a.rewritten);
}

Then("the readiness judge was asked about the rewritten child {string} once", function (title: string) {
  const got = rewrittenAsks(this, title).length;
  assert.equal(got, 1, `the judge was asked about the rewritten child "${title}" ${got} times; asked about: ${showAsks(ctx(this).asks)}`);
});

Then("the readiness judge was asked about the rewritten child {string}", function (title: string) {
  assert.ok(rewrittenAsks(this, title).length > 0, `the judge was never asked about the rewritten child "${title}"; asked about: ${showAsks(ctx(this).asks)}`);
});

// --- The rewrite requests ------------------------------------------------------------------------------------------

function rewritesOf(world: object, title?: string): AgentArgs[] {
  const c = ctx144(world);
  polled(c);
  return rewriteRequests(c, title);
}

Then("the coding model was asked to rewrite child {string} once", function (title: string) {
  const got = rewritesOf(this, title).length;
  assert.equal(got, 1, `the coding model was asked to rewrite child "${title}" ${got} times`);
});

Then("the coding model was not asked to rewrite child {string}", function (title: string) {
  assert.equal(rewritesOf(this, title).length, 0, `the coding model was asked to rewrite child "${title}"`);
});

Then("the coding model was not asked to rewrite child {string} or child {string}", function (a: string, b: string) {
  for (const t of [a, b]) assert.equal(rewritesOf(this, t).length, 0, `the coding model was asked to rewrite child "${t}"`);
});

Then("the coding model was not asked to rewrite issue {string}", function (title: string) {
  assert.equal(rewritesOf(this, title).length, 0, `the coding model was asked to rewrite issue "${title}"`);
});

Then("the coding model was not asked to rewrite any child", function () {
  assert.equal(rewritesOf(this).length, 0, "the coding model was asked for a rewrite");
});

function someRewriteSays(world: object, texts: string[]): void {
  const all = rewritesOf(world);
  assert.ok(all.length > 0, "the coding model was never asked for a rewrite");
  assert.ok(all.some((a) => texts.every((t) => a.prompt.includes(t))),
    `no rewrite request says ${texts.map((t) => `"${t}"`).join(" and ")}:\n${all.map((a) => a.prompt).join("\n-----\n")}`);
}

Then("the rewrite request names the line {string} and the reason {string}", function (line: string, reason: string) {
  someRewriteSays(this, [line, reason]);
});

Then("the rewrite request names the reasons {string} and {string}", function (a: string, b: string) {
  someRewriteSays(this, [a, b]);
});

Then("the rewrite request for child {string} lists the criterion {string} word for word", function (title: string, criterion: string) {
  const asked = rewritesOf(this, title);
  assert.ok(asked.length > 0, `the coding model was never asked to rewrite child "${title}"`);
  for (const a of asked) assert.ok(a.prompt.includes(criterion), `the rewrite request for "${title}" doesn't list "${criterion}":\n${a.prompt}`);
});

// --- Edits ---------------------------------------------------------------------------------------------------------

const editsOf = (world: object, title: string) => ctx144(world).edits.filter((e) => e.externalId === idOf(world, title));

Then("the factory edited the body of child {string}", function (title: string) {
  assert.ok(editsOf(this, title).length > 0, `the factory never edited child "${title}"`);
});

Then("the factory did not edit child {string}", function (title: string) {
  assert.equal(editsOf(this, title).length, 0, `the factory edited child "${title}"`);
});

Then("the factory did not edit issue {string}", function (title: string) {
  assert.equal(editsOf(this, title).length, 0, `the factory edited issue "${title}"`);
});

Then("the body of child {string} is the person's edit, unchanged", async function (title: string) {
  const want = ctx(this).personBodies.get(title);
  assert.ok(want, `no person edited child "${title}"`);
  assert.equal(await body(ctx144(this), idOf(this, title)), want);
});

// --- Filing --------------------------------------------------------------------------------------------------------

Then("{string} holds no new issues", function (repo: string) {
  const c = ctx144(this);
  polled(c);
  const filed = c.filed.filter((i) => i.repo === repo);
  assert.equal(filed.length, 0, `issues filed: ${filed.map((i) => i.title).join(", ")}`);
});

Then("the parent issue has no sub-issues", function () {
  const c = ctx144(this);
  polled(c);
  assert.deepEqual(c.subIssues.get(c.parentId!) ?? [], []);
});

Then("the factory has started no run for child {string}", function (title: string) {
  const c = ctx144(this);
  assert.ok(!c.runs.has(filedChild(c, title).externalId), `the factory took up child "${title}"`);
});

// --- Comments ------------------------------------------------------------------------------------------------------

async function readinessComments(world: object, title: string): Promise<string[]> {
  const c = ctx144(world);
  polled(c);
  return (await c.fake.comments(idOf(world, title))).filter((b) => !b.startsWith(SPLIT_HEADING));
}

async function hasReadinessComment(world: object, title: string, says: string): Promise<void> {
  const all = await readinessComments(world, title);
  assert.ok(all.some((b) => b.includes(says)), `no readiness comment on "${title}" says "${says}":\n${all.join("\n-----\n") || "none"}`);
}

Then("child {string} has a readiness comment saying {string}", async function (title: string, says: string) {
  await hasReadinessComment(this, title, says);
});

Then("issue {string} has a readiness comment saying {string}", async function (title: string, says: string) {
  await hasReadinessComment(this, title, says);
});

/** A line telling the owner what to do about `thing`: it names the owner, the thing, and what to do with it. */
const OWNER = /\bowner\b/i;
const credentialAction = (line: string) => OWNER.test(line) && /\b(credentials?|secrets?|keys?)\b/i.test(line)
  && /\b(grant|add|store|set|provide|give|save)s?\b/i.test(line);
const permissionAction = (line: string) => OWNER.test(line) && /\bpermissions?\b/i.test(line)
  && /\b(grant|approve|accept|give|allow|update)s?\b/i.test(line);

async function ownerComment(world: object, title: string, says: (line: string) => boolean, what: string): Promise<void> {
  const all = await readinessComments(world, title);
  assert.ok(all.some((b) => b.split(/\r?\n/).some(says)), `no readiness comment on "${title}" says what the owner has to do to grant the ${what}:\n${all.join("\n-----\n") || "none"}`);
}

Then("child {string} has a readiness comment that says what the owner has to do to grant the credential", async function (title: string) {
  await ownerComment(this, title, credentialAction, "credential");
});

Then("child {string} has a readiness comment that says what the owner has to do to grant the permission", async function (title: string) {
  await ownerComment(this, title, permissionAction, "permission");
});

async function proposals(world: object): Promise<string[]> {
  const c = ctx144(world);
  polled(c);
  const found = (await c.fake.comments(c.parentId!)).filter((b) => b.startsWith(SPLIT_HEADING));
  assert.ok(found.length > 0, "the parent issue has no split proposal comment");
  return found;
}

/**
 * The parts of a proposal comment that speak of child `title`: each line naming it, its own `###` section, and each
 * blank-line-separated block whose first line names it.
 */
function partsAbout(comment: string, title: string): string[] {
  const lines = comment.split(/\r?\n/);
  const parts = lines.filter((l) => l.includes(title));
  const sections = comment.split(/^(?=#{1,6}\s)/m).filter((s) => (s.split(/\r?\n/)[0] ?? "").includes(title) && /^#{1,6}\s/.test(s));
  const blocks = comment.split(/\n\s*\n/).filter((b) => (b.split(/\r?\n/)[0] ?? "").includes(title));
  return [...parts, ...sections, ...blocks];
}

const namesFailing = (comment: string, title: string, line: string) => partsAbout(comment, title).some((p) => p.includes(line));

async function proposalNames(world: object, title: string, line: string, which: "one" | "any"): Promise<void> {
  const all = await proposals(world);
  if (which === "one") assert.equal(all.length, 1, `split proposal comments: ${all.length}`);
  assert.ok(all.some((b) => namesFailing(b, title, line)), `no split proposal comment names child "${title}" as failing "${line}":\n${all.join("\n-----\n")}`);
}

Then("that comment names child {string} as failing {string}", async function (title: string, line: string) {
  await proposalNames(this, title, line, "one");
});

Then("the parent issue's split proposal comment names child {string} as failing {string}", async function (title: string, line: string) {
  await proposalNames(this, title, line, "any");
});

Then("that comment names neither child {string} nor child {string} as failing a line", async function (a: string, b: string) {
  const all = await proposals(this);
  assert.equal(all.length, 1, `split proposal comments: ${all.length}`);
  const dor = ["Names the screen it changes", "Says which payment provider it uses"];
  for (const title of [a, b]) {
    for (const line of dor) assert.ok(!namesFailing(all[0], title, line), `the proposal names child "${title}" as failing "${line}":\n${all[0]}`);
  }
});

Then("the parent issue's split proposal comment says what the owner has to do to grant the credential for child {string}", async function (title: string) {
  const all = await proposals(this);
  const says = (part: string) => part.split(/\r?\n/).some(credentialAction);
  assert.ok(all.some((b) => partsAbout(b, title).some(says)),
    `no split proposal comment says what the owner has to do to grant the credential for child "${title}":\n${all.join("\n-----\n")}`);
});
