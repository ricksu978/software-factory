// Step definitions for features/pbi-439-proposed-rewrite-owner-accepts.feature.
//
// Everything runs on PBI 395's harness: PBI 131's item "512", Eligible, on a board that maps to "acme/widgets", on PBI 4's
// shared test database; PBI 348's dor.md; PBI 12's fake board, fake repo host and real pollOnce; and the dashboard's
// own item page, opened in UTC by a signed-in user. So PBI 395's "the readiness check checks item ...", "the factory
// holds item ... in state ...", "... opens item ...'s item page" and its rule-change approval Thens, PBI 12's "the
// poller runs once", PBI 260's "the poller has run once", PBI 149's "the board item has a new readiness comment saying
// ..." and PBI 105's "..., a viewer, is signed in" all read the same item. On top of it:
// - The item's body is PBI 395's: a lead, a "## Acceptance criteria" section with the Background's criteria, and any
//   rules section. "Item 512's body reads X" sets the lead, and "the issue body reads X" reads the issue body's text
//   before its first heading. A person's edit seeds the board item again, which bumps its updatedAt as GitHub does.
// - The readiness judge is scripted per version of the item's text: the text as first written, the text as "dana"
//   edited it, and the text the factory wrote over the issue when the owner accepted a rewrite. Each version fails
//   the lines its script names, with the reasons given, and may raise a credential flag, or find rules it changes.
//   Every ask is recorded with the version it was about, and whether it came while an acceptance was being answered.
// - The coding model is PBI 12's `split` dependency's agent. A rewrite request is a request whose prompt opens with
//   "Rewrite this" and carries the item as fenced JSON with its "title", as PBI 264's rewrite request does, and lists
//   each failed line as a JSON line with its "criterion" and "reason". It's answered {"body": ...} with the body the
//   scenario gave, or with a reply that carries no body.
//
// The contract these steps set up, which the code reads:
// - Each proposal that stands, neither accepted nor withdrawn, is in proposedRewrites in src/store/rewrites.ts: the
//   proposed issue body in full, and the body it rewrites as it read when the proposal was made.
// - The item page has a "Proposed rewrite" section (the content after its <h2> up to the next <h2>). It holds the
//   current body in an element with data-side="current" and, after it, the proposed body in an element with
//   data-side="proposed", each word that changes inside a <mark>. The owner alone sees a <button> reading "Accept
//   rewrite" in a form that posts to /items/<id>/rewrite-acceptance, its hidden fields naming the proposal. A user
//   accepts by posting that form: the owner's post answers 303, anyone else's 403, and one for a proposal that a
//   person's edit withdrew 409 with a reason that says it was withdrawn.
// - Accepting writes the proposed body over the issue with DashboardDeps.rewrites.editBody, queues its comment as a
//   rewrite_accepted outbox row, and runs the readiness check at once with DashboardDeps.rewrites.recheck, before it
//   answers. The steps then run that row's effect as the worker does, with the board's fake adapter.
//   Here, editBody seeds the board item with that body and the criteria it lists, and recheck runs the worker's
//   recheckAccepted with one poll. In production the acceptance's event wakes the worker, which runs the same call.
// - A person's edit withdrawing a proposal is an event of kind "rewrite_withdrawn" whose payload's cause is
//   "item_edited". The approval of a rules section is PBI 395's "rule_change_approved" event, its payload's `changes`
//   the section as accepted.
import { After, Before, BeforeStep, DataTable, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { FactoryItem } from "../../src/adapters/types.ts";
import type { AgentArgs, AgentResult } from "../../src/agent/run.ts";
import type { Policy } from "../../src/policy/policy.ts";
import { proposedRewrites, rechecksOwed, type ProposedRewrite } from "../../src/store/rewrites.ts";
import { CONSUMER } from "../../src/store/outbox.ts";
import { runRowEffects } from "../../src/worker/outbox.ts";
import { recheckAccepted } from "../../src/worker/rechecks.ts";
import { ctx as pollCtx, poll, polled } from "./pbi-12.steps.ts";
import { ctx as commentCtx } from "./pbi-149.steps.ts";
import { text } from "./pbi-189.steps.ts";
import {
  body as bodyOf, board, check, ctx as ctx395, dashboard, html, item, markComments, openPage, rulesAt, user, type Role,
} from "./pbi-395.steps.ts";
import { ctx as itemCtx, inGitHubRepo } from "./pbi-131.steps.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";

const OWNER = "olive";
const SCREEN_LINE = "The item names the screen it changes";
const NO_SCREEN = "No screen is named";
const LEAD = "Shoppers with a saved card pay at checkout without typing it again.";
const CREDENTIAL_ASK = "It needs the payment provider's live API key.";
/** The flag the judge raises for the credential ask. It names neither the owner nor what to do. */
const CREDENTIAL_FLAG = "asks for the payment provider's live API key";
const named = (screen: string) => `Shoppers with a saved card pay on ${screen} without typing it again.`;
/** What the coding model rewrites the body to when the scenario says nothing of it. */
const REWRITE = named("the checkout page");
const RULES_HEADING = "## Changes the factory's rules";
/** Spec §6 on main, which a rewrite's rules section quotes as its Before. */
const MAIN_6 = "A lease lasts ten minutes and the worker renews it every minute.";
const AFTER_6 = "A lease lasts five minutes and the worker renews it every thirty seconds.";
const ACCEPT = "Accept rewrite";

type Version = "original" | "edited" | "rewritten";
type Script = { fails: { line: string; reason: string }[]; credential: boolean; rules: string[] };
type Ask = { version: Version; body: string; accepting: boolean };

type Ctx = {
  author?: string;
  scripts: Partial<Record<Version, Script>>;
  /** The bodies a person wrote over the issue, and those the factory wrote. */
  edited: Set<string>;
  written: Set<string>;
  asks: Ask[];
  requests: AgentArgs[];
  /** The coding model's rewrite: a body, or a reply with none. */
  reply: { body: string } | { none: true };
  accepting: boolean;
  acceptance?: { status: number; text: string };
  /** The proposal the item had when the scenario set it up, for an acceptance sent after it was withdrawn. */
  proposalId?: string;
  /** The type of the step running now, so a step written as both a Given and a Then knows which it is. */
  stepType?: string;
  /** The comment the last comment step found, for a following "that comment". */
  comment?: string;
  heads: number;
};

function ctx(world: object): Ctx {
  const w = world as { pbi439?: Ctx };
  if (!w.pbi439) {
    w.pbi439 = { scripts: {}, edited: new Set(), written: new Set(), asks: [], requests: [], reply: { body: REWRITE }, accepting: false, heads: 1 };
    install(world, w.pbi439);
  }
  return w.pbi439;
}

const pool = () => need().pool;
const blank = (): Script => ({ fails: [], credential: false, rules: [] });
const script = (k: Ctx, v: Version): Script => (k.scripts[v] ??= blank());

function versionOf(k: Ctx, body: string): Version {
  if (k.edited.has(body)) return "edited";
  if (k.written.has(body)) return "rewritten";
  return "original";
}

/** The criteria a body lists under its "Acceptance criteria" heading, or null when it has none. */
function criteriaOf(body: string): string[] | null {
  const lines = section(body, "Acceptance criteria");
  return lines && lines.map((l) => /^\s*[-*]\s+(?:\[[ xX]\]\s+)?(.*\S)\s*$/.exec(l)?.[1]).filter((t): t is string => !!t);
}

/** The lines of `body` under the heading `name`, at any level, up to the next heading. Null when it has no such heading. */
function section(body: string, name: string): string[] | null {
  const lines = body.split(/\r?\n/);
  const at = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#+\s*/, "").trim().toLowerCase() === name.toLowerCase());
  if (at === -1) return null;
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((l) => /^#{1,6}\s/.test(l));
  return end === -1 ? rest : rest.slice(0, end);
}

/** A body's text before its first heading. */
const leadOf = (body: string) => body.split(/\r?\n(?=#{1,6}\s)/)[0].trim();

const isRewrite = (a: AgentArgs, title: string) =>
  /^Rewrite this\b/.test(a.prompt) && new RegExp(`"title":\\s*${JSON.stringify(title).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(a.prompt);

function rewriteRequests(world: object): AgentArgs[] {
  const title = item(world).title;
  return ctx(world).requests.filter((a) => isRewrite(a, title));
}

function install(world: object, k: Ctx): void {
  const p = pollCtx(world);
  p.judgeOverride = async (fi: FactoryItem, dor) => {
    const version = versionOf(k, fi.body);
    k.asks.push({ version, body: fi.body, accepting: k.accepting });
    const s = k.scripts[version] ?? (version === "edited" ? { ...blank(), rules: k.scripts.rewritten?.rules ?? [] } : blank());
    const verdicts = dor.criteria.map((cr) => {
      const f = s.fails.find((x) => x.line === cr.text);
      return JSON.stringify({ index: cr.index, status: f ? "failed" : "passed", reason: f ? f.reason : "ok" });
    });
    return [...verdicts, JSON.stringify({ flags: s.credential ? [CREDENTIAL_FLAG] : [], rules: s.rules })].join("\n");
  };
  p.split = {
    sop: { models: { coding: "coding-model" } },
    effort: async () => "medium",
    agent: async (a: AgentArgs): Promise<AgentResult> => {
      k.requests.push(a);
      const text = !isRewrite(a, item(world).title) ? JSON.stringify({ children: [] })
        : "none" in k.reply ? "I can't rewrite this item." : JSON.stringify({ body: k.reply.body });
      return { ok: true, text, costUsd: 0, tokensIn: 0, tokensOut: 0, model: a.model, limit: null, usage: null, transcript: "" };
    },
  };
  ctx395(world).dashboardDeps = {
    rewrites: {
      async editBody(externalId, body) {
        k.written.add(body);
        await reseed(world, externalId, body);
      },
      // The worker's own recheck, src/worker/rechecks.ts, with this board's poll: it finds the rewrite owed a
      // check, polls, and marks it rechecked, as the worker does when the acceptance's event wakes it.
      async recheck(itemId) {
        const source = (await pool().query<{ source_id: string }>("select source_id from item where id = $1", [itemId])).rows[0].source_id;
        await recheckAccepted(pool(), new Map([[source, () => poll(pollCtx(world))]]));
        assert.equal((await rechecksOwed(pool())).has(source), false, "the accepted rewrite is still owed its recheck");
      },
    },
  };
}

async function reseed(world: object, externalId: string, body: string): Promise<void> {
  const fake = ctx395(world).fake;
  assert.ok(fake, "the board wasn't set up");
  const fi = await fake.adapter.getItem(externalId);
  assert.ok(fi, `no board item ${externalId}`);
  await fake.seed({ ...fi, body, acceptanceCriteria: criteriaOf(body) ?? fi.acceptanceCriteria });
}

/** A person's edit: the board item's body becomes `body`. */
async function personEdit(world: object, body: string): Promise<void> {
  ctx(world).edited.add(body);
  await reseed(world, item(world).ext, body);
}

/** A person's edit to the lead, keeping the rest of PBI 395's body. */
async function editLead(world: object, lead: string): Promise<void> {
  const c = ctx395(world);
  c.lead = `${lead}\n`;
  await personEdit(world, bodyOf(c));
}

async function issueBody(world: object): Promise<string> {
  const fi = await ctx395(world).fake!.adapter.getItem(item(world).ext);
  assert.ok(fi, "the item isn't on the board");
  return fi.body;
}

function ext(world: object, e: string): void {
  assert.equal(item(world).ext, e, `the scenario's item is ${item(world).ext}, not ${e}`);
}

async function proposals(world: object): Promise<ProposedRewrite[]> {
  return proposedRewrites(pool(), item(world).id);
}

async function proposal(world: object): Promise<ProposedRewrite> {
  polled(pollCtx(world));
  const ps = await proposals(world);
  assert.equal(ps.length, 1, `item ${item(world).ext} has ${ps.length} proposed rewrites`);
  return ps[0];
}

Before({ tags: "@pbi-439", ...long }, async function () {
  const d = await testDb();
  assert.ok(d, "src/store/test-db.ts doesn't exist");
  await d.pool.query('truncate item, event, backlog_source, repo, "user", override cascade');
});

After({ tags: "@pbi-439", ...long }, async function () {
  const c = (this as { pbi395?: { server?: import("node:http").Server; close?: () => Promise<void> } }).pbi395;
  if (!c?.server) return;
  await c.close?.();
  c.server.closeAllConnections();
  await new Promise<void>((resolve) => c.server!.close(() => resolve()));
});

BeforeStep({ tags: "@pbi-439" }, function ({ pickleStep }) {
  ctx(this).stepType = pickleStep.type;
});

// ---- the Background ----

Given("item {string} titled {string} is an issue {string} wrote in the repo {string}", long, async function (e: string, title: string, author: string, repo: string) {
  await inGitHubRepo(itemCtx(this), e, title, repo);
  const k = ctx(this);
  k.author = author;
  ctx395(this).lead = `${LEAD}\n`;
});

Given("{string} is the owner of the factory", long, async function (login: string) {
  ctx395(this).roles.set(login, "owner");
  await user(login, "owner", true);
});

Given("item {string}'s body has these acceptance criteria:", long, async function (e: string, table: DataTable) {
  ext(this, e);
  ctx(this);
  ctx395(this).criteria = table.hashes().map((r) => r.text);
  // The board and repo host are made now, so a Given can change them before the first check.
  await board(this);
});

Given("item {string}'s body reads {string}", function (e: string, lead: string) {
  ext(this, e);
  ctx395(this).lead = `${lead}\n`;
});

// ---- the readiness judge ----

Given("the readiness judge fails item {string} on {string} because {string}", function (e: string, line: string, reason: string) {
  ext(this, e);
  script(ctx(this), "original").fails.push({ line, reason });
});

Given("the readiness judge flags item {string} as needing a new credential", function (e: string) {
  ext(this, e);
  script(ctx(this), "original").credential = true;
});

Given("the readiness judge flagged item {string} as needing a new credential when it was last checked", long, async function (e: string) {
  ext(this, e);
  const k = ctx(this);
  k.scripts.original = { fails: [{ line: SCREEN_LINE, reason: NO_SCREEN }], credential: true, rules: [] };
  ctx395(this).lead = `${LEAD} ${CREDENTIAL_ASK}\n`;
  await check(this);
});

Given("{string} has edited item {string} to take the credential ask out of its text", long, async function (_who: string, e: string) {
  ext(this, e);
  await editLead(this, LEAD);
});

Given("the readiness judge now fails item {string} only on {string} because {string}", function (e: string, line: string, reason: string) {
  ext(this, e);
  ctx(this).scripts.edited = { fails: [{ line, reason }], credential: false, rules: [] };
});

Given("the readiness judge fails item {string} as edited on {string} because {string}", function (e: string, line: string, reason: string) {
  ext(this, e);
  script(ctx(this), "edited").fails.push({ line, reason });
});

Given("the readiness judge passes item {string} on every line once it names {string}", function (e: string, _screen: string) {
  ext(this, e);
  ctx(this).scripts.edited = blank();
});

Given("the readiness judge passes the rewritten item {string} on every line", function (e: string) {
  ext(this, e);
  ctx(this).scripts.rewritten = blank();
});

Given("the readiness judge passes the rewritten item {string} on every line and finds it changes spec section {string}", function (e: string, place: string) {
  ext(this, e);
  ctx(this).scripts.rewritten = { ...blank(), rules: [place] };
});

Given("the readiness judge fails the rewritten item {string} on {string} because {string}", function (e: string, line: string, reason: string) {
  ext(this, e);
  script(ctx(this), "rewritten").fails.push({ line, reason });
});

Given("the factory's App lacks the {string} permission on {string}", function (permission: string, repo: string) {
  const host = ctx395(this).host;
  assert.ok(host, "the repo host wasn't set up");
  host.permissionsMissing.set(repo, [permission]);
});

// ---- the coding model ----

Given("the coding model will rewrite item {string}'s body to name {string}", function (e: string, screen: string) {
  ext(this, e);
  ctx(this).reply = { body: named(screen) };
});

Given("the coding model will rewrite item {string}'s body to read {string}", function (e: string, body: string) {
  ext(this, e);
  ctx(this).reply = { body };
});

Given("the coding model answers the rewrite request for item {string} with no body", function (e: string) {
  ext(this, e);
  ctx(this).reply = { none: true };
});

Given("the coding model will rewrite item {string}'s body and reword its criterion {string} to {string}", function (e: string, from: string, to: string) {
  ext(this, e);
  const criteria = (ctx395(this).criteria ?? []).map((c) => (c === from ? to : c));
  ctx(this).reply = { body: `${REWRITE}\n\n## Acceptance criteria\n\n${criteria.map((c) => `- ${c}`).join("\n")}\n` };
});

// ---- a proposal, set up ----

const rulesSection = (after: string) => `${RULES_HEADING}\n\n### Spec §6\n\n**Before**\n> ${MAIN_6}\n\n**After**\n> ${after}\n`;

function main6(world: object): void {
  rulesAt(ctx395(world), "main").set("§6", `<p>${MAIN_6}</p>`);
}

/**
 * The item checked with a judge that fails it only on a dor.md line, so the factory proposes the rewrite the coding
 * model answers. The proposal it made, if any, is kept for a later acceptance sent after it was withdrawn.
 */
async function propose(world: object, body?: string): Promise<void> {
  const k = ctx(world);
  if (body !== undefined) k.reply = { body };
  const s = script(k, "original");
  if (s.fails.length === 0) s.fails.push({ line: SCREEN_LINE, reason: NO_SCREEN });
  await check(world);
  k.proposalId = (await proposals(world))[0]?.id;
}

// "item ... has a proposed rewrite" is a Given in some scenarios and a Then in others.
Given("item {string} has a proposed rewrite", long, async function (e: string) {
  ext(this, e);
  if (ctx(this).stepType === "Outcome") {
    await proposal(this);
    return;
  }
  await propose(this);
});

Given("item {string} has a proposed rewrite that reads {string}", long, async function (e: string, body: string) {
  ext(this, e);
  await propose(this, body);
});

Given("item {string} has a proposed rewrite that adds a {string} section changing spec section {string}", long, async function (e: string, heading: string, place: string) {
  ext(this, e);
  assert.equal(heading, RULES_HEADING);
  assert.equal(place, "§6");
  main6(this);
  await propose(this, `${REWRITE}\n\n${rulesSection(AFTER_6)}`);
});

Given("item {string} has a proposed rewrite whose rules section changes spec section {string} with the After {string}", long, async function (e: string, place: string, after: string) {
  ext(this, e);
  assert.equal(place, "§6");
  main6(this);
  await propose(this, `${REWRITE}\n\n${rulesSection(after)}`);
});

Given("item {string} has a proposed rewrite with no {string} section", long, async function (e: string, heading: string) {
  ext(this, e);
  assert.equal(heading, RULES_HEADING);
  await propose(this, REWRITE);
});

Given("the rewrite's Before for spec section {string} matches main word for word", function (place: string) {
  assert.equal(place, "§6");
  const reply = ctx(this).reply;
  assert.ok("body" in reply && reply.body.includes(`> ${MAIN_6}`), "the rewrite doesn't quote spec section §6 as it reads on main");
});

Given("item {string}'s rules section changes spec section {string} with the After {string}", function (e: string, place: string, after: string) {
  ext(this, e);
  assert.equal(place, "§6");
  main6(this);
  const c = ctx395(this);
  c.section = undefined;
  c.entries.push({ place, before: MAIN_6, after });
});

Given("the readiness check has checked item {string} at {string}", long, async function (e: string, at: string) {
  ext(this, e);
  ctx395(this).clock = new Date(at);
  await check(this);
});

// ---- the checks and polls ----

When("the readiness check checks item {string} again with its text unchanged", long, async function (e: string) {
  ext(this, e);
  // A readiness input changes, so the poller checks the NotReady item again: the repo's dod.md, on a new head.
  const c = ctx395(this);
  const host = c.host!;
  const head = host.heads.get("acme/widgets")!;
  const next = `w${++ctx(this).heads}`;
  for (const [key, t] of [...host.files]) {
    if (!key.startsWith(`acme/widgets@${head}:`)) continue;
    const path = key.slice(`acme/widgets@${head}:`.length);
    host.files.set(`acme/widgets@${next}:${path}`, path === ".factory/dod.md" ? `${t}- [ ] The docs say what changed\n` : t);
  }
  host.heads.set("acme/widgets", next);
  await markComments(this);
  await poll(pollCtx(this));
});

When("the poller runs every hour until {string} with item {string}'s text unchanged", long, async function (until: string, e: string) {
  ext(this, e);
  const c = ctx395(this);
  assert.ok(c.clock, "no time was set for the readiness check");
  const hours = Math.round((Date.parse(until) - c.clock.getTime()) / 3_600_000);
  const p = pollCtx(this);
  for (let h = 1; h <= hours; h++) {
    c.clock = new Date(c.clock.getTime() + 3_600_000);
    await poll(p);
  }
  c.clock = new Date(until);
});

// ---- a person's edits ----

When("{string} edits item {string}'s body to name {string}", long, async function (_who: string, e: string, screen: string) {
  ext(this, e);
  await editLead(this, `Shoppers with a saved card pay at checkout, on ${screen}, without typing it again.`);
});

Given("{string} has edited item {string}'s body to read {string}", long, async function (_who: string, e: string, lead: string) {
  ext(this, e);
  await editLead(this, lead);
});

When("{string} edits item {string}'s body", long, async function (_who: string, e: string) {
  ext(this, e);
  await editLead(this, `${ctx395(this).lead.trim()} A shopper sees the card's last four digits.`);
});

When("{string} edits the After for spec section {string} in item {string}'s rules section", long, async function (_who: string, place: string, e: string) {
  ext(this, e);
  const lines = (await issueBody(this)).split("\n");
  const at = lines.findIndex((l) => new RegExp(`^###\\s+Spec\\s+${place}\\s*$`).test(l));
  const after = at === -1 ? -1 : lines.findIndex((l, i) => i > at && /^\*\*After\*\*/.test(l));
  const quote = after === -1 ? -1 : lines.findIndex((l, i) => i > after && l.startsWith("> "));
  // An issue with no such entry, as when no rewrite was applied, is still edited, so the scenario's Thens decide.
  if (quote === -1) lines.push("", "The lease is the worker's.");
  else lines[quote] = `${lines[quote]} A lost lease frees the slot at once.`;
  await personEdit(this, lines.join("\n"));
});

// ---- the item page and the acceptance ----

function roleOf(world: object, login: string): Role {
  return ctx395(world).roles.get(login) ?? (login === OWNER ? "owner" : "viewer");
}

async function postAcceptance(world: object, login: string, fields: Record<string, string>): Promise<void> {
  const c = await dashboard(world);
  await user(login, roleOf(world, login));
  const k = ctx(world);
  await markComments(world);
  k.accepting = true;
  try {
    const r = await fetch(`${c.origin}/items/${item(world).id}/rewrite-acceptance`, {
      method: "POST", redirect: "manual",
      headers: {
        "x-ms-client-principal-idp": "aad", "x-ms-client-principal-id": login, "x-ms-client-principal-name": login,
        origin: c.origin!, "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(fields).toString(),
    });
    k.acceptance = { status: r.status, text: await r.text() };
    await postAcceptedComments(world);
  } finally {
    k.accepting = false;
  }
}

/** The worker's pass over the acceptance's rewrite_accepted outbox rows, which posts its comment (src/worker/outbox.ts). */
async function postAcceptedComments(world: object): Promise<void> {
  const c = ctx395(world);
  const rows = await pool().query<{ seq: string; event_id: string; item_id: string }>(
    "select seq, event_id, item_id from outbox where consumer = $1 order by seq", [CONSUMER.rewriteAccepted],
  );
  for (const r of rows.rows) {
    await runRowEffects({ pool: pool(), backlogFor: () => c.fake!.adapter, repoHost: c.host! }, { seq: r.seq, consumer: CONSUMER.rewriteAccepted, eventId: r.event_id, itemId: r.item_id });
    await pool().query("delete from outbox where seq = $1", [r.seq]);
  }
}

/** The hidden fields of the page's "Accept rewrite" form, or null when the page shows none. */
function acceptForm(world: object): Record<string, string> | null {
  const form = [...html(world).matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)]
    .find((m) => /rewrite-acceptance/.test(m[1]) && [...m[2].matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi)].some((b) => text(b[1]) === ACCEPT));
  if (!form) return null;
  const fields: Record<string, string> = {};
  for (const m of form[2].matchAll(/<input\b[^>]*>/gi)) {
    const name = /\bname="([^"]*)"/.exec(m[0])?.[1];
    if (name) fields[name] = text(/\bvalue="([^"]*)"/.exec(m[0])?.[1] ?? "");
  }
  return fields;
}

async function acceptOnPage(world: object, login: string, at?: string): Promise<void> {
  const c = ctx395(world);
  if (at) c.clock = new Date(at);
  await openPage(world, login);
  // A page that shows no form is answered as one the owner sent for the proposal the item has, if any.
  const fields = acceptForm(world) ?? { rewrite: (await proposals(world))[0]?.id ?? "" };
  await postAcceptance(world, login, fields);
}

When("{string} accepts item {string}'s proposed rewrite on its item page", long, async function (login: string, e: string) {
  ext(this, e);
  await acceptOnPage(this, login);
});

When("{string} accepts item {string}'s proposed rewrite on its item page at {string}", long, async function (login: string, e: string, at: string) {
  ext(this, e);
  await acceptOnPage(this, login, at);
});

When("{string} sends an acceptance of item {string}'s proposed rewrite", long, async function (login: string, e: string) {
  ext(this, e);
  await postAcceptance(this, login, { rewrite: (await proposals(this))[0]?.id ?? ctx(this).proposalId ?? "" });
});

When("{string} sends an acceptance of the proposal item {string} had before the edit", long, async function (login: string, e: string) {
  ext(this, e);
  await postAcceptance(this, login, { rewrite: ctx(this).proposalId ?? "" });
});

Then("the acceptance is refused", function () {
  const a = ctx(this).acceptance;
  assert.ok(a, "no acceptance was sent");
  assert.equal(a.status, 403, `the acceptance answered ${a.status}: ${a.text.slice(0, 200)}`);
});

Then("the acceptance is refused because the proposal was withdrawn", function () {
  const a = ctx(this).acceptance;
  assert.ok(a, "no acceptance was sent");
  assert.equal(a.status, 409, `the acceptance answered ${a.status}: ${a.text.slice(0, 200)}`);
  assert.match(a.text, /withdrawn/i, "the refusal doesn't say the proposal was withdrawn");
});

// ---- reading the item page ----

function rewritePart(world: object): string {
  const page = html(world);
  for (const part of page.split(/<h2\b[^>]*>/i).slice(1)) {
    const end = part.search(/<\/h2>/i);
    if (text(part.slice(0, end)) === "Proposed rewrite") return part.slice(end + 5).split(/<h2\b/i)[0];
  }
  assert.fail(`the item page has no "Proposed rewrite" section: ${text(page).slice(0, 600)}`);
}

/** The HTML of one side of the proposal, from its data-side element up to the next one or the section's end. */
function side(world: object, which: "current" | "proposed"): string {
  const part = rewritePart(world);
  const starts = [...part.matchAll(/<[a-z][a-z0-9]*\b[^>]*\bdata-side="([^"]*)"[^>]*>/gi)];
  const i = starts.findIndex((m) => m[1] === which);
  assert.ok(i >= 0, `the Proposed rewrite section shows no ${which} body; it shows: ${starts.map((m) => m[1]).join(", ") || "none"}`);
  return part.slice(starts[i].index, starts[i + 1]?.index ?? part.length);
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const word = (w: string) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

/** Each word of `h`, in order, and whether a <mark> holds it. */
function words(h: string): { w: string; marked: boolean }[] {
  return h.split(/(<mark\b[^>]*>[\s\S]*?<\/mark>)/i).flatMap((seg) => {
    const marked = /^<mark\b/i.test(seg);
    return text(seg).split(/\s+/).map(word).filter(Boolean).map((w) => ({ w, marked }));
  });
}

/** Each place `phrase` stands in `h`, as the marks on its words. */
function occurrences(h: string, phrase: string): boolean[][] {
  const ws = words(h);
  const want = phrase.split(/\s+/).map(word).filter(Boolean);
  const found: boolean[][] = [];
  for (let i = 0; i + want.length <= ws.length; i++) {
    if (want.every((w, j) => ws[i + j].w === w)) found.push(want.map((_, j) => ws[i + j].marked));
  }
  return found;
}

function expectedProposal(world: object): string {
  const reply = ctx(world).reply;
  assert.ok("body" in reply, "the coding model gave no rewrite");
  return leadOf(reply.body);
}

Then("the item page shows item {string}'s current body beside its proposed rewrite", function (e: string) {
  ext(this, e);
  const current = norm(text(side(this, "current")));
  const proposed = norm(text(side(this, "proposed")));
  const lead = norm(ctx395(this).lead);
  assert.ok(current.includes(lead), `the current body shown doesn't read "${lead}": ${current}`);
  const want = norm(expectedProposal(this));
  assert.ok(proposed.includes(want), `the proposed rewrite shown doesn't read "${want}": ${proposed}`);
});

Then("the item page shows the proposed rewrite {string}", function (want: string) {
  const proposed = norm(text(side(this, "proposed")));
  assert.ok(proposed.includes(norm(want)), `the proposed rewrite shown doesn't read "${want}": ${proposed}`);
});

Then("the proposed rewrite marks {string} and {string} as words that change", function (a: string, b: string) {
  const h = side(this, "proposed");
  for (const w of [a, b]) {
    assert.ok(occurrences(h, w).some((o) => o.every(Boolean)), `the proposed rewrite doesn't mark "${w}": ${words(h).filter((x) => x.marked).map((x) => x.w).join(", ") || "it marks nothing"}`);
  }
});

function unmarked(world: object, phrase: string): void {
  for (const which of ["current", "proposed"] as const) {
    const found = occurrences(side(world, which), phrase);
    assert.ok(found.length > 0, `the ${which} body shown doesn't hold "${phrase}"`);
    assert.ok(found.every((o) => o.every((m) => !m)), `the ${which} body marks "${phrase}", which doesn't change`);
  }
}

Then("neither side marks {string} or {string} as words that change", function (a: string, b: string) {
  unmarked(this, a);
  unmarked(this, b);
});

Then("neither side marks {string} as words that change", function (phrase: string) {
  unmarked(this, phrase);
});

Then("the current body marks the criterion {string} as words that change", function (criterion: string) {
  const found = occurrences(side(this, "current"), criterion);
  assert.ok(found.some((o) => o.every(Boolean)), `the current body shown doesn't mark the criterion "${criterion}"`);
});

function hasAccept(world: object): boolean {
  return acceptForm(world) !== null;
}

Then("the item page shows the {string} button", function (name: string) {
  assert.equal(name, ACCEPT);
  assert.ok(hasAccept(this), `the item page shows no "${name}" button posting to /items/${item(this).id}/rewrite-acceptance: ${text(html(this)).slice(0, 600)}`);
});

Then("the item page doesn't show the {string} button", function (name: string) {
  assert.equal(name, ACCEPT);
  assert.ok(!/<button\b[^>]*>\s*Accept rewrite\s*<\/button>/i.test(html(this)), `the item page shows the "${name}" button`);
});

Then("{string} doesn't see the {string} button on item {string}'s item page", long, async function (login: string, name: string, e: string) {
  ext(this, e);
  assert.equal(name, ACCEPT);
  await openPage(this, login);
  assert.ok(!/<button\b[^>]*>\s*Accept rewrite\s*<\/button>/i.test(html(this)), `${login}'s item page shows the "${name}" button`);
});

// ---- the coding model's requests ----

Then("the coding model was asked to rewrite item {string} once", function (e: string) {
  ext(this, e);
  polled(pollCtx(this));
  assert.equal(rewriteRequests(this).length, 1, `the coding model was asked to rewrite item ${e} ${rewriteRequests(this).length} times`);
});

Then("the coding model was asked to rewrite item {string} twice in all", function (e: string) {
  ext(this, e);
  polled(pollCtx(this));
  assert.equal(rewriteRequests(this).length, 2, `the coding model was asked to rewrite item ${e} ${rewriteRequests(this).length} times`);
});

Then("the coding model was never asked to rewrite item {string}", function (e: string) {
  ext(this, e);
  polled(pollCtx(this));
  assert.equal(rewriteRequests(this).length, 0, `the coding model was asked to rewrite item ${e} ${rewriteRequests(this).length} times`);
});

function request(world: object): string {
  const rs = rewriteRequests(world);
  assert.equal(rs.length, 1, `the coding model was asked to rewrite item ${item(world).ext} ${rs.length} times`);
  return rs[0].prompt;
}

Then("the rewrite request for item {string} lists the criterion {string} with the reason {string}", function (e: string, criterion: string, reason: string) {
  ext(this, e);
  const prompt = request(this);
  const listed = prompt.split("\n").some((l) => {
    try {
      const o = JSON.parse(l) as { criterion?: unknown; reason?: unknown };
      return o.criterion === criterion && o.reason === reason;
    } catch {
      return false;
    }
  });
  assert.ok(listed, `the rewrite request doesn't list "${criterion}" with the reason "${reason}":\n${prompt}`);
});

Then("the rewrite request for item {string} carries the repo's dor.md word for word", function (e: string) {
  ext(this, e);
  const dor = (this as { pbi348?: { dor?: Policy } }).pbi348?.dor;
  assert.ok(dor, "the repo's dor.md wasn't set up");
  const prompt = request(this);
  assert.ok(prompt.includes(dor.text.trim()), `the rewrite request doesn't carry the repo's dor.md:\n${prompt}`);
});

// ---- the proposal ----

Then("item {string} has no proposed rewrite", long, async function (e: string) {
  ext(this, e);
  polled(pollCtx(this));
  const ps = await proposals(this);
  assert.equal(ps.length, 0, `item ${e} has ${ps.length} proposed rewrites`);
});

Then("item {string} still has a proposed rewrite", long, async function (e: string) {
  ext(this, e);
  await proposal(this);
});

Then("item {string} has one proposed rewrite, made for its text as {string} edited it", long, async function (e: string, _who: string) {
  ext(this, e);
  const p = await proposal(this);
  const now = await issueBody(this);
  assert.ok(ctx(this).edited.has(now), "the issue body isn't the one the person wrote");
  assert.equal(p.current, now, "the proposal wasn't made for the item's text as the person edited it");
});

Then("item {string}'s proposed rewrite has these acceptance criteria, word for word:", long, async function (e: string, table: DataTable) {
  ext(this, e);
  const p = await proposal(this);
  assert.deepEqual(criteriaOf(p.body), table.hashes().map((r) => r.text), `the proposed rewrite:\n${p.body}`);
});

async function notes(world: object): Promise<string[]> {
  const p = await proposal(world);
  const n = section(p.body, "Notes");
  assert.ok(n, `the proposed rewrite has no Notes:\n${p.body}`);
  return n;
}

Then("item {string}'s proposed rewrite has {string} under its Notes", long, async function (e: string, criterion: string) {
  ext(this, e);
  const n = await notes(this);
  assert.ok(n.some((l) => l.includes(criterion)), `the proposed rewrite's Notes don't hold "${criterion}":\n${n.join("\n")}`);
});

Then("the proposed rewrite's Notes say {string} moved there because {string}", long, async function (criterion: string, reason: string) {
  const n = await notes(this);
  assert.ok(n.some((l) => l.includes(criterion) && l.includes(reason)), `no line of the proposed rewrite's Notes says "${criterion}" moved there because "${reason}":\n${n.join("\n")}`);
});

// ---- the issue ----

Then("item {string}'s issue body is unchanged", long, async function (e: string) {
  ext(this, e);
  polled(pollCtx(this));
  assert.equal(await issueBody(this), bodyOf(ctx395(this)), "the issue body changed");
});

Then("item {string}'s issue body reads {string}", long, async function (e: string, lead: string) {
  ext(this, e);
  assert.equal(leadOf(await issueBody(this)), lead);
});

async function fresh(world: object): Promise<string[]> {
  const it = item(world);
  const all = await ctx395(world).fake!.comments(it.ext);
  return all.slice(commentCtx(world).commentsBefore.get(it.ext) ?? 0);
}

const applied = (c: string) => /\bappl(ied|ies)\b/i.test(c) && /rewrite/i.test(c) && /accept/i.test(c);

Then("item {string}'s issue has exactly one new comment", long, async function (e: string) {
  ext(this, e);
  const all = await fresh(this);
  assert.equal(all.length, 1, `item ${e}'s issue has ${all.length} new comments:\n${all.join("\n---\n")}`);
  ctx(this).comment = all[0];
});

Then("that comment says the factory applied the rewrite {string}, the owner, accepted", function (login: string) {
  const c = ctx(this).comment;
  assert.ok(c, "no comment was found");
  assert.ok(applied(c) && c.includes(login) && /owner/i.test(c), `the comment doesn't say the factory applied the rewrite ${login}, the owner, accepted:\n${c}`);
});

Then("item {string}'s issue has exactly one comment saying the factory applied an accepted rewrite", long, async function (e: string) {
  ext(this, e);
  polled(pollCtx(this));
  const all = (await ctx395(this).fake!.comments(e)).filter(applied);
  assert.equal(all.length, 1, `item ${e}'s issue has ${all.length} comments saying the factory applied an accepted rewrite:\n${all.join("\n---\n")}`);
});

Then("the board item has a new readiness comment saying a rewrite is proposed on the item's page for the owner to accept", long, async function () {
  polled(pollCtx(this));
  const all = await fresh(this);
  const ok = all.some((c) => /rewrite/i.test(c) && /propos/i.test(c) && /item['’]?s page|item page/i.test(c) && /owner/i.test(c) && /accept/i.test(c));
  assert.ok(ok, `no new comment says a rewrite is proposed on the item's page for the owner to accept:\n${all.join("\n---\n") || "(no new comment)"}`);
});

Then("the board item has a new readiness comment saying the owner has to add the credential outside the factory", long, async function () {
  polled(pollCtx(this));
  const all = await fresh(this);
  const ok = all.some((c) => c.split("\n").some((l) => /owner has to/i.test(l) && /outside the factory/i.test(l) && /credential/i.test(l)));
  assert.ok(ok, `no new comment says the owner has to add the credential outside the factory:\n${all.join("\n---\n") || "(no new comment)"}`);
});

Then("the board item has a new readiness comment saying the owner has to grant the factory's App the {string} permission", long, async function (permission: string) {
  polled(pollCtx(this));
  const all = await fresh(this);
  const ok = all.some((c) => c.split("\n").some((l) => /owner has to grant/i.test(l) && l.includes(`the factory's App the ${JSON.stringify(permission)} permission`)));
  assert.ok(ok, `no new comment says the owner has to grant the factory's App the "${permission}" permission:\n${all.join("\n---\n") || "(no new comment)"}`);
});

// ---- the judge's asks ----

Then("the readiness judge was asked about the rewritten item {string} without waiting for the poller", function (e: string) {
  ext(this, e);
  const asks = ctx(this).asks.filter((a) => a.version === "rewritten");
  assert.ok(asks.some((a) => a.accepting), `the readiness judge wasn't asked about the rewritten item while the acceptance was answered (asked ${asks.length} times about it in all)`);
});

Then("the readiness judge was asked about item {string} as {string} edited it", function (e: string, _who: string) {
  ext(this, e);
  polled(pollCtx(this));
  assert.ok(ctx(this).asks.some((a) => a.version === "edited"), "the readiness judge was never asked about the item as the person edited it");
});

// ---- the history ----

Then("item {string}'s history shows its proposed rewrite was withdrawn by {string}'s edit", long, async function (e: string, _who: string) {
  ext(this, e);
  polled(pollCtx(this));
  const r = await pool().query("select 1 from event where item_id = $1 and kind = 'rewrite_withdrawn' and payload->>'cause' = 'item_edited'", [item(this).id]);
  assert.equal(r.rowCount, 1, `item ${e}'s history shows ${r.rowCount} withdrawals of a proposed rewrite by a person's edit`);
});

Then("the approval recorded on item {string} is for spec section {string} with the After {string}", long, async function (e: string, place: string, after: string) {
  ext(this, e);
  polled(pollCtx(this));
  const r = await pool().query<{ payload: { changes?: { place: { kind: string; section?: string }; after: string | null }[] } }>(
    "select payload from event where item_id = $1 and kind = 'rule_change_approved' order by at desc, id desc limit 1", [item(this).id]);
  const changes = r.rows[0]?.payload.changes;
  assert.ok(changes, `item ${e} has no rule change approval`);
  const ch = changes.find((x) => x.place.kind === "spec" && x.place.section === place);
  assert.ok(ch, `the approval doesn't cover spec section ${place}: ${JSON.stringify(changes)}`);
  assert.equal(ch.after, after);
});
