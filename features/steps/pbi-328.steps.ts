// Step definitions for features/pbi-328-trusted-reply-in-factory-thread.feature.
//
// Every scenario runs the engine through PBI 18's harness with PBI 128's fake repo host, CI, scripted PR reviewer and
// scripted PR addresser, resuming at "open-pr" as PBI 318's scenarios do, whose steps set up the run, the earlier
// claim's factory thread and the cell's run. This file adds:
//
// - The allowlist, on the cell's context as `trustedLogins`, each login as the allowlist stores it, as the cell API
//   hands it to a claim. PBI 130's "is an allowlisted user" and PBI 79's "login is stored as" steps write there,
//   through `pbi328Cell`, instead of to the database. "is not an allowlisted user" leaves the login off it.
// - A person's reply inside a factory thread: a comment by that login in the thread, on the fake repo host, as
//   GitHub holds a reply. PBI 130's "replied ... inside that thread" steps post it here. A reply in a resolved thread
//   is resolved with it. The factory's own replies (PBI 318's steps) are comments by the trusted bot.
// - A conversation entry's writer: the PR reviewer's replies are `you` (or `reviewer`), the addresser's `author` (or
//   `addresser`), as the briefs mark them today, and a person's is their login as their comment carries it.
import { Before, Given, Then, type DataTable } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { Ctx as CellCtx } from "./pbi-18.steps.ts";
import {
  briefEntries, ctx as pr128, done, newPass, reviewerCall, that, threadFor, type AgentRecord, type Ctx as PrCtx,
} from "./pbi-128.steps.ts";

const KEY = "acme/app#57";
const BOT = "factory[bot]";

type Comment = { threadId: string; path: string | null; line: number | null; author: string; body: string; resolved?: boolean; submittedAt?: string };

function cell(world: object): CellCtx {
  const w = world as { pbi18?: CellCtx };
  assert.ok(w.pbi18, "no run was set up");
  return w.pbi18;
}

const comments = (c: PrCtx): Comment[] => c.host.reviewComments.get(KEY) ?? [];

function allowlist(world: object): string[] {
  return ((cell(world).context?.trustedLogins as string[] | undefined) ?? []);
}

Before({ tags: "@pbi-328" }, function () {
  const world = this as { pbi328Cell?: unknown };
  let seq = 0;
  world.pbi328Cell = {
    allow(login: string) {
      const run = cell(world);
      run.context = { ...run.context, trustedLogins: [...allowlist(world), login] };
    },
    reply(login: string, body: string, thread: string | null) {
      const c = pr128(world);
      const t = threadFor(c, thread ?? that(c));
      const list = comments(c);
      const resolved = list.filter((x) => x.threadId === t.threadId).every((x) => x.resolved);
      // After the thread's finding and before the cell starts, in the order the scenario gives them.
      const at = new Date(Date.now() - 5 * 3_600_000 + ++seq * 60_000).toISOString();
      list.push({ threadId: t.threadId, path: t.path, line: t.line, author: login, body, submittedAt: at, ...(resolved ? { resolved: true } : {}) });
      c.host.reviewComments.set(KEY, list);
    },
  };
});

/** Whether a conversation entry's `from` marks the writer a scenario names. */
export function sameWriter(got: unknown, want: string): boolean {
  const w = want.trim();
  const g = String(got);
  if (["reviewer", "the PR reviewer"].includes(w)) return ["you", "reviewer", "the PR reviewer", "factory-pr-reviewer"].includes(g);
  if (["author", "the addresser"].includes(w)) return ["author", "addresser", "the addresser", "factory-pr-addresser"].includes(g);
  return g === w;
}

const strip = (s: string) => s.replace(/^Still open(?: at [0-9a-f]{7,40})?: /, "").trim();

function conversation(r: AgentRecord, c: PrCtx, thread: string, who: string): { from?: unknown; body?: unknown }[] {
  const t = threadFor(c, thread);
  const e = briefEntries(r.prompt).find((x) => x.threadId === t.threadId);
  assert.ok(e, `${who} doesn't hold the thread ${t.threadId} for "${thread}"`);
  return Array.isArray(e.conversation) ? e.conversation as { from?: unknown; body?: unknown }[] : [];
}

function holdsBy(r: AgentRecord, c: PrCtx, text: string, writer: string, thread: string, who: string) {
  const conv = conversation(r, c, thread, who);
  assert.ok(conv.some((x) => sameWriter(x.from, writer) && strip(String(x.body ?? "")) === strip(text)),
    `${who} doesn't hold "${text}" by ${writer} in the thread "${thread}": ${JSON.stringify(conv)}`);
}

function addresserCall(c: PrCtx, n: number): AgentRecord {
  const a = c.addresserCalls[n - 1];
  assert.ok(a, `the PR addresser ran ${c.addresserCalls.length} times, so it has no brief ${n}`);
  return a;
}

const ORDINALS: Record<string, number> = { first: 1, second: 2 };

// ---- Givens ----

Given("{string} is not an allowlisted user", function (login: string) {
  assert.ok(!allowlist(this).some((x) => x.toLowerCase() === login.toLowerCase()), `"${login}" is on the allowlist`);
});

Given("the PR addresser replies {string} to that thread, with a new commit", function (reply: string) {
  const c = pr128(this);
  newPass(c).actions.set(that(c), { kind: "fix", reply });
});

// ---- Thens: what the briefs hold ----

Then(/^the (PR reviewer|PR addresser)'s (first|second) brief holds "([^"]*)" by "([^"]*)" in the thread "([^"]*)"$/,
  function (agent: string, which: string, text: string, writer: string, thread: string) {
    const { c } = done(this);
    const n = ORDINALS[which];
    const r = agent === "PR reviewer" ? reviewerCall(c, n) : addresserCall(c, n);
    holdsBy(r, c, text, writer, thread, `the ${agent}'s ${which} brief`);
  });

Then("every brief the PR reviewer was given holds {string} by {string} in the thread {string}", function (text: string, writer: string, thread: string) {
  const { c } = done(this);
  reviewerCall(c, 1);
  c.reviewerCalls.forEach((r, i) => holdsBy(r, c, text, writer, thread, `the PR reviewer's brief ${i + 1}`));
});

Then(/^no brief the (PR reviewer|PR addresser) was given holds "([^"]*)"$/, function (agent: string, text: string) {
  const { c } = done(this);
  const calls = agent === "PR reviewer" ? c.reviewerCalls : c.addresserCalls;
  assert.ok(calls.length > 0, `the ${agent} never ran`);
  calls.forEach((r, i) => assert.ok(!r.prompt.includes(text), `the ${agent}'s brief ${i + 1} holds "${text}"`));
});

Then("the PR addresser's first brief holds {string} with this conversation, in order:", function (thread: string, table: DataTable) {
  const { c } = done(this);
  const conv = conversation(addresserCall(c, 1), c, thread, "the PR addresser's first brief");
  const want = table.hashes().map((r) => ({ from: r.from.trim(), reply: r.reply.trim() }));
  assert.equal(conv.length, want.length, `the thread's conversation in the brief is ${JSON.stringify(conv)}`);
  want.forEach((w, i) => {
    assert.ok(sameWriter(conv[i].from, w.from), `reply ${i + 1} is from ${String(conv[i].from)}, not ${w.from}: ${JSON.stringify(conv)}`);
    assert.equal(strip(String(conv[i].body ?? "")), strip(w.reply), `reply ${i + 1} reads otherwise: ${JSON.stringify(conv)}`);
  });
});

// ---- Thens: what the PR reviewer's brief tells it ----

const sentences = (text: string) => text.split(/(?<=[.!?])\s+|\n+/);
const NOT_FIXED = /\b(isn't|is not|not|hasn't been|wasn't)\s+fixed\b/i;

Then("the PR reviewer's first brief says a trusted person's reply that a finding isn't fixed counts in its verdict on that thread", function () {
  const { c } = done(this);
  const said = sentences(reviewerCall(c, 1).prompt).some((s) => /\btrusted\b/i.test(s) && /\b(person|people|someone|human)('s)?\b/i.test(s)
    && /\brepl(y|ies)\b/i.test(s) && NOT_FIXED.test(s) && /\bverdict\b/i.test(s));
  assert.ok(said, "the PR reviewer's first brief doesn't say a trusted person's \"not fixed\" counts in its verdict on the thread");
});

Then("the PR reviewer's first brief says to hold such a thread unless the head it reviews fixes what the reply names", function () {
  const { c } = done(this);
  const said = sentences(reviewerCall(c, 1).prompt).some((s) => /\bhold\b/i.test(s) && /\b(unless|until|only when|only if)\b/i.test(s)
    && /\bhead\b/i.test(s) && /\bfix(es)?\b/i.test(s) && /\brepl(y|ies)\b/i.test(s));
  assert.ok(said, "the PR reviewer's first brief doesn't say to hold such a thread unless the head fixes what the reply names");
});

// ---- Thens: the head, the replies and the threads ----

Then("the PR reviewer's second brief names the addresser's commit as the head to review", function () {
  const { c } = done(this);
  const sha = c.addresserShas[0];
  assert.ok(sha, "the PR addresser made no commit");
  const r = reviewerCall(c, 2);
  assert.equal(r.head, sha, `the PR reviewer's second review ran at ${r.head}, not at the addresser's commit ${sha}`);
  assert.ok(r.prompt.includes(sha), `the PR reviewer's second brief doesn't name ${sha}`);
});

Then("the factory didn't resolve the thread {string} after the first review", function (thread: string) {
  const { c } = done(this);
  reviewerCall(c, 2);
  const t = threadFor(c, thread);
  assert.notEqual(c.snapshots.get(1)?.get(t.threadId)?.resolved, true, `the factory resolved the thread "${thread}" after the first review`);
});

Then("the factory resolved the thread {string} after the second review", function (thread: string) {
  const { c } = done(this);
  reviewerCall(c, 2);
  const t = threadFor(c, thread);
  assert.notEqual(c.snapshots.get(1)?.get(t.threadId)?.resolved, true, `the thread "${thread}" was resolved after the first review already`);
  assert.ok(c.host.resolvedThreads.some((r) => r.threadId === t.threadId)
    && comments(c).filter((x) => x.threadId === t.threadId).every((x) => x.resolved), `the factory didn't resolve the thread "${thread}"`);
});

Then("the factory replied {string} inside the thread {string}", function (text: string, thread: string) {
  const { c } = done(this);
  const t = threadFor(c, thread);
  const replies = comments(c).filter((x) => x.threadId === t.threadId).slice(1);
  assert.ok(replies.some((x) => x.author === BOT && x.body.includes(text)),
    `the factory's replies in the thread don't say "${text}": ${JSON.stringify(replies.map((x) => `${x.author}: ${x.body}`))}`);
});
