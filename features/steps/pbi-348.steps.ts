// Step definitions for features/pbi-348-readiness-check-verdicts.feature.
//
// PBI 131's steps make the item in its GitHub repo and serve the real dashboard on PBI 4's shared test database. The
// item page is the item's Run detail, /items/<id>, opened in UTC.
//
// Each "readiness judge call" Given scripts one reply (or one throw) of the judge. "When a viewer opens the item page"
// then runs PBI 13's real gate on the item for each scripted call, with the repo's dor.md, and the gate's recordCheck
// hands every check it records, unchanged, to the store's recordReadinessCheck against the item's row, as the poller
// does. Whatever the gate puts on a check is what the page reads back. Each gate call runs at its own minute (the
// scenario's time when it names one), so a row is found by its "Ran" cell.
//
// A split scenario runs one gate on the item with a judge that finds it too big for one Sprint and a coding model that
// proposes two children. When the scenario names a judge verdict for a child, the split is set up to be filed, so the
// gate judges each child, as the issue it would be filed as, and records that call against the parent. A child the
// scenario gives no verdict passes. A rewrite of a failing child gets no body back, so it isn't judged again.
//
// A check "recorded before the gate kept verdicts" goes in through recordReadinessCheck with only its spend and time.
//
// The page's contract these steps read, beyond PBI 189's: the Readiness checks table has a column headed "Verdict".
// A cell's text is its text with tags dropped and spaces collapsed.
// - A judge call that passed shows the word "Passed", and one that failed a line or raised a flag shows "Failed".
// - A failed call lists each failed dor.md line word for word, followed by the judge's reason for it, before the next
//   line it lists. It lists each flag's text word for word. It lists no line that passed.
// - A call whose reply couldn't be read says "unreadable". A call that threw says "failed" and "no verdict".
// - A check recorded before verdicts were kept says "no verdict was recorded".
// - A judge call on a split child names the child's title in the cell. A call on the item itself says no "child".
// - A split proposal's Verdict cell is empty.
import { After, Before, Given, Then, When, type DataTable } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BacklogAdapter, FactoryItem } from "../../src/adapters/types.ts";
import type { AgentArgs, AgentResult, JudgeSpend } from "../../src/agent/run.ts";
import type { SplitBoard } from "../../src/gate/file-split.ts";
import { gate, type GateContext } from "../../src/gate/readiness.ts";
import { parseCriteria, type Policy } from "../../src/policy/policy.ts";
import { recordReadinessCheck, type ReadinessCheck } from "../../src/store/readiness-checks.ts";
import { ctx as itemCtx, open, type Item } from "./pbi-131.steps.ts";
import { text } from "./pbi-189.steps.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";

type Result = { line: string; result: "passed" | "failed"; reason: string };
/** One scripted judge reply: each line's result (a line not named passes) and its flags, or a reply with no verdict. */
type Reply = { results: Result[]; flags: string[]; oversized?: boolean; unreadable?: boolean; throws?: boolean };
type Call = Reply & { at?: string };
/** A check the gate recorded, with what the steps know it was. */
type Recorded = { ranAt: Date; kind: "judge" | "split"; subject: string };

type Ctx = {
  dor?: Policy;
  /** The item's own judge calls, in order, each run through its own gate. */
  calls: Call[];
  /** The split scenario: set once the judge found the item too big. */
  split?: { children: string[]; childReplies: Map<string, Reply>; named: boolean };
  /** Checks recorded before verdicts were kept. */
  legacy: Date[];
  recorded: Recorded[];
  minute: number;
};

function ctx(world: object): Ctx {
  const w = world as { pbi348?: Ctx };
  w.pbi348 ??= { calls: [], legacy: [], recorded: [], minute: 0 };
  return w.pbi348;
}

const pool = () => need().pool;
const SPEND: JudgeSpend = { model: "claude-haiku-4-5", effort: "medium", tokensIn: 1000, tokensOut: 50, costUsd: 0.0031 };
const CRITERIA = ["Exports every row of the month", "Names the file after the month"];

Before({ tags: "@pbi-348", ...long }, async function () {
  const d = await testDb();
  assert.ok(d, "src/store/test-db.ts doesn't exist");
  await d.pool.query('truncate item, event, backlog_source, repo, "user", override cascade');
});

After({ tags: "@pbi-348", ...long }, async function () {
  // PBI 131's After only closes its server for its own scenarios.
  const s = (this as { pbi131?: { server?: import("node:http").Server; close?: () => Promise<void> } }).pbi131;
  if (!s) return;
  await s.close?.();
  if (s.server) {
    s.server.closeAllConnections();
    await new Promise<void>((resolve) => s.server!.close(() => resolve()));
  }
});

function item(world: object): Item {
  const c = itemCtx(world);
  const it = c.the ?? c.items.at(-1);
  assert.ok(it, "no item was set up");
  return it;
}

/** The next default time a call runs: a minute after the last. */
function nextMinute(c: Ctx): Date {
  return new Date(Date.parse("2026-11-09T07:00:00Z") + c.minute++ * 60_000);
}

const ranText = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");

// ---- the repo's dor.md ----

Given("the repo has a {string} with these lines:", function (path: string, table: DataTable) {
  assert.equal(path, ".factory/dor.md");
  const lines = table.hashes().map((r) => r.text);
  const md = `# Definition of Ready\n\n${lines.map((l) => `- [ ] ${l}`).join("\n")}\n`;
  ctx(this).dor = { name: "dor", source: "repo", sha: "pbi-348-dor", text: md, criteria: parseCriteria(md) };
});

function dor(c: Ctx): Policy {
  assert.ok(c.dor, "the repo's dor.md wasn't set up");
  return c.dor;
}

function results(c: Ctx, table: DataTable): Result[] {
  const lines = new Set(dor(c).criteria.map((k) => k.text));
  return table.hashes().map((r) => {
    assert.ok(lines.has(r.line), `"${r.line}" isn't a line of the repo's dor.md`);
    assert.ok(r.result === "passed" || r.result === "failed", `unknown result "${r.result}"`);
    return { line: r.line, result: r.result, reason: r.reason ?? "" };
  });
}

// ---- the item's own judge calls ----

const passing = (): Call => ({ results: [], flags: [] });

Given("the item had a readiness judge call that passed every dor.md line and raised no flag", function () {
  ctx(this).calls.push(passing());
});

Given("the item had a readiness judge call on the item itself that passed every dor.md line and raised no flag", function () {
  ctx(this).calls.push(passing());
});

Given("the item had a readiness judge call that passed every dor.md line", function () {
  ctx(this).calls.push(passing());
});

Given("the item had a readiness judge call at {string} that passed every dor.md line and raised no flag", function (at: string) {
  ctx(this).calls.push({ ...passing(), at });
});

Given("the item had a readiness judge call with these results:", function (table: DataTable) {
  const c = ctx(this);
  c.calls.push({ results: results(c, table), flags: [] });
});

Given("the item had a readiness judge call at {string} with these results:", function (at: string, table: DataTable) {
  const c = ctx(this);
  c.calls.push({ results: results(c, table), flags: [], at });
});

Given("that call raised the readiness flag {string}", function (flag: string) {
  const call = ctx(this).calls.at(-1);
  assert.ok(call, "no judge call was set up");
  call.flags.push(flag);
});

Given("the item had a readiness judge call whose reply the gate couldn't read", function () {
  ctx(this).calls.push({ ...passing(), unreadable: true });
});

Given("the item had a readiness judge call that ended in an API error before it replied", function () {
  ctx(this).calls.push({ ...passing(), throws: true });
});

Given("the item had a readiness check recorded before the gate kept verdicts", long, async function () {
  const c = ctx(this);
  const ranAt = nextMinute(c);
  await recordReadinessCheck(pool(), item(this).id, { ...SPEND, ranAt });
  c.legacy.push(ranAt);
  c.recorded.push({ ranAt, kind: "judge", subject: item(this).title });
});

// ---- a proposed split ----

Given("the readiness judge found the item too big for one Sprint", function () {
  ctx(this).split = { children: ["Export the rows", "Name the file"], childReplies: new Map(), named: false };
});

function split(c: Ctx): NonNullable<Ctx["split"]> {
  assert.ok(c.split, "the judge didn't find the item too big");
  return c.split;
}

Given("the coding model proposed a split of the item", function () {
  split(ctx(this));
});

Given("the coding model proposed a split of the item with the children {string} and {string}", function (a: string, b: string) {
  split(ctx(this)).children = [a, b];
});

Given("the gate's judge call on the child {string} passed every dor.md line and raised no flag", function (child: string) {
  const s = split(ctx(this));
  assert.ok(s.children.includes(child), `"${child}" isn't a proposed child`);
  s.childReplies.set(child, passing());
  s.named = true;
});

Given("the gate's judge call on the child {string} failed the line {string} with the reason {string}", function (child: string, line: string, reason: string) {
  const c = ctx(this);
  const s = split(c);
  assert.ok(s.children.includes(child), `"${child}" isn't a proposed child`);
  assert.ok(dor(c).criteria.some((k) => k.text === line), `"${line}" isn't a line of the repo's dor.md`);
  s.childReplies.set(child, { results: [{ line, result: "failed", reason }], flags: [] });
  s.named = true;
});

// ---- running the gate ----

/** The judge's reply text for `r`: one JSON line per dor.md line, then its flags line. */
function replyText(r: Reply, policy: Policy): string {
  if (r.unreadable) return "I looked at the item and it seems mostly fine, but I can't give a verdict in that format.";
  const lines = policy.criteria.map((k) => {
    const mine = r.results.find((x) => x.line === k.text);
    return JSON.stringify(mine?.result === "failed"
      ? { index: k.index, status: "failed", reason: mine.reason }
      : { index: k.index, status: "passed", reason: "Met." });
  });
  return [...lines, JSON.stringify({ flags: r.flags, oversized: r.oversized === true })].join("\n");
}

function factoryItem(it: Item): FactoryItem {
  return {
    sourceId: it.sourceId, externalId: it.ext, title: it.title,
    body: "Export a month of rows as a file.\n\n## Acceptance criteria\n\n" + CRITERIA.map((a) => `- ${a}`).join("\n"),
    acceptanceCriteria: CRITERIA, labels: ["factory"], status: "Backlog", rank: 1, repo: "acme/widgets",
    fields: {}, closed: false, updatedAt: "2026-11-09T06:00:00Z",
  };
}

const quietAdapter = { comment: async () => {} } as unknown as BacklogAdapter;

function board(): SplitBoard {
  let n = 1000;
  return {
    subIssues: async () => [],
    findIssues: async () => [],
    createIssue: async (repo, title) => {
      const id = String(n++);
      return { externalId: id, title, url: `https://github.com/${repo}/issues/${id}` };
    },
    addSubIssue: async () => {},
    boardStatus: async () => null,
    addToBoard: async () => {},
    blockedBy: async () => [],
    addBlockedBy: async () => {},
    removeLabel: async () => {},
  };
}

function agentResult(text: string, model: string): AgentResult {
  return { ok: true, text, model, costUsd: 0.0412, tokensIn: 4000, tokensOut: 600, limit: null, usage: null, transcript: "" };
}

/** Runs the gate once on the item, the judge answering through `answer`, the calls running from `start` a minute apart. */
async function runGate(world: object, answer: (subject: FactoryItem) => Reply, start: () => Date, extra: Partial<GateContext> = {}): Promise<void> {
  const c = ctx(world);
  const it = item(world);
  const policy = dor(c);
  let subject = "";
  let first = true;
  const now = () => {
    const d = first ? start() : nextMinute(c);
    first = false;
    return d;
  };
  const gctx: GateContext = {
    readinessSha: "pbi-348", dor: policy, dodExists: true, configValid: true, repoKnown: true, adapter: quietAdapter,
    now,
    judge: async (fi, _dor, spent) => {
      subject = fi.title;
      spent?.(SPEND);
      const r = answer(fi);
      if (r.throws) throw new Error("API Error: 529 Overloaded");
      return replyText(r, policy);
    },
    recordCheck: async (_fi, check: ReadinessCheck) => {
      c.recorded.push({ ranAt: check.ranAt, kind: check.kind ?? "judge", subject: check.kind === "split" ? "split" : subject });
      await recordReadinessCheck(pool(), it.id, check);
    },
    log: (line) => { throw new Error(line); },
    ...extra,
  };
  try {
    await gate(factoryItem(it), gctx);
  } catch (e) {
    // A judge that throws makes the gate throw, as the poller sees it. Anything else is a broken setup.
    if (!(e instanceof Error && e.message.startsWith("API Error"))) throw e;
  }
}

async function runCalls(world: object): Promise<void> {
  const c = ctx(world);
  for (const call of c.calls) {
    await runGate(world, () => call, () => (call.at ? new Date(call.at) : nextMinute(c)));
  }
  const s = c.split;
  if (!s) return;
  const it = item(world);
  const agent = async (a: AgentArgs): Promise<AgentResult> => {
    if (!a.prompt.includes("Propose splitting")) return agentResult("I can't improve this child.", a.model);
    const children = s.children.map((title, i) => ({ title, body: `Part of "${it.title}". Implements spec §9.${i + 1}.`, criteria: [i + 1], needs: [] }));
    return agentResult(JSON.stringify({ children }), a.model);
  };
  const file = s.named ? { board: board(), optInLabel: "factory", backlogStatus: "Backlog", criteriaHeading: "Acceptance criteria" } : undefined;
  await runGate(world, (fi) => (fi.externalId === it.ext ? { ...passing(), oversized: true } : s.childReplies.get(fi.title) ?? passing()),
    () => nextMinute(c), { split: { sop: { models: { coding: "claude-sonnet-4-6" } }, agent, file, effort: async () => "medium" } });
}

When("a viewer opens the item page", long, async function () {
  await runCalls(this);
  itemCtx(this).viewerZone = "UTC";
  await open(this, `/items/${item(this).id}`);
});

// ---- reading the page ----

type Table = { headings: string[]; rows: { cells: string[]; html: string[] }[] };

function table(world: object): Table {
  const c = itemCtx(world);
  assert.ok(c.page !== undefined, "no page came back");
  assert.equal(c.status, 200, `the page answered ${c.status}: ${c.page.slice(0, 300)}`);
  let body: string | null = null;
  for (const part of c.page.split(/<h2\b[^>]*>/i).slice(1)) {
    const end = part.search(/<\/h2>/i);
    if (text(part.slice(0, end)) === "Readiness checks") body = part.slice(end + 5).split(/<h2\b/i)[0];
  }
  assert.ok(body !== null, "the page has no \"Readiness checks\" section");
  const t = /<table\b[^>]*>([\s\S]*?)<\/table>/i.exec(body);
  assert.ok(t, `the Readiness checks section has no table: ${text(body)}`);
  const headings = [...t[1].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => text(m[1]));
  const rows = [...t[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((m) => m[1])
    .filter((r) => !/<th\b/i.test(r))
    .map((r) => {
      const html = [...r.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
      return { cells: html.map(text), html };
    });
  return { headings, rows };
}

const show = (t: Table) => [t.headings.join(" | "), ...t.rows.map((r) => r.cells.join(" | "))].join("\n");

function col(t: Table, heading: RegExp): number {
  const i = t.headings.findIndex((h) => heading.test(h));
  assert.ok(i >= 0, `the Readiness checks table has no ${heading} column; its headings are: ${t.headings.join(" | ")}`);
  return i;
}

const VERDICT = /^Verdict$/i;
const RAN = /^Ran\b/i;

/** The Verdict cell, text and html, of the row for the check that ran at `ranAt`. */
function verdictAt(world: object, ranAt: Date): { text: string; html: string; table: string } {
  const t = table(world);
  const v = col(t, VERDICT);
  const ran = col(t, RAN);
  const rows = t.rows.filter((r) => r.cells[ran] === ranText(ranAt));
  assert.equal(rows.length, 1, `the Readiness checks table has ${rows.length} rows that ran at ${ranText(ranAt)}:\n${show(t)}`);
  return { text: rows[0].cells[v] ?? "", html: rows[0].html[v] ?? "", table: show(t) };
}

/** "that call": the scenario's last judge call on the item itself. */
function thatCall(world: object): ReturnType<typeof verdictAt> {
  const c = ctx(world);
  const title = item(world).title;
  const r = c.recorded.filter((x) => x.kind === "judge" && x.subject === title).at(-1);
  assert.ok(r, "no judge call on the item was recorded");
  return verdictAt(world, r.ranAt);
}

function callAt(world: object, at: string): ReturnType<typeof verdictAt> {
  const want = Date.parse(at);
  assert.ok(ctx(world).recorded.some((x) => x.ranAt.getTime() === want), `no check was recorded at ${at}`);
  return verdictAt(world, new Date(want));
}

function callOn(world: object, child: string): ReturnType<typeof verdictAt> {
  const r = ctx(world).recorded.filter((x) => x.kind === "judge" && x.subject === child).at(-1);
  assert.ok(r, `no judge call on "${child}" was recorded`);
  return verdictAt(world, r.ranAt);
}

const words = (w: string) => new RegExp(`(^|[^\\p{L}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}])`, "u");

function shows(cell: ReturnType<typeof verdictAt>, verdict: string): void {
  assert.match(cell.text, words(verdict), `the row's verdict "${cell.text}" doesn't show "${verdict}":\n${cell.table}`);
}

function notShows(cell: ReturnType<typeof verdictAt>, verdict: string): void {
  assert.doesNotMatch(cell.text, words(verdict), `the row's verdict "${cell.text}" shows "${verdict}":\n${cell.table}`);
}

function listsLine(world: object, cell: ReturnType<typeof verdictAt>, line: string, reason: string): void {
  const at = cell.text.indexOf(line);
  assert.ok(at >= 0, `the row's verdict "${cell.text}" doesn't list the line "${line}":\n${cell.table}`);
  // The reason follows its line, before the next dor.md line the row lists.
  const rest = cell.text.slice(at + line.length);
  const others = dor(ctx(world)).criteria.map((k) => rest.indexOf(k.text)).filter((i) => i >= 0);
  const upTo = others.length ? rest.slice(0, Math.min(...others)) : rest;
  assert.ok(upTo.includes(reason), `the row's verdict "${cell.text}" doesn't give the reason "${reason}" for "${line}":\n${cell.table}`);
}

function notLists(cell: ReturnType<typeof verdictAt>, line: string): void {
  assert.ok(!cell.text.includes(line), `the row's verdict "${cell.text}" lists "${line}":\n${cell.table}`);
}

/** The cell the last "row for ..." step read, for a following "that row ...". */
function last(world: object): ReturnType<typeof verdictAt> {
  const w = world as { pbi348Row?: () => ReturnType<typeof verdictAt> };
  return (w.pbi348Row ?? (() => thatCall(world)))();
}

function remember(world: object, read: () => ReturnType<typeof verdictAt>): ReturnType<typeof verdictAt> {
  (world as { pbi348Row?: () => ReturnType<typeof verdictAt> }).pbi348Row = read;
  return read();
}

Then("the Readiness checks table's row for that call shows the verdict {string}", function (verdict: string) {
  shows(remember(this, () => thatCall(this)), verdict);
});

Then("the Readiness checks table's row for that call doesn't show the verdict {string}", function (verdict: string) {
  notShows(remember(this, () => thatCall(this)), verdict);
});

Then("that row's verdict lists no dor.md line and no flag", function () {
  const cell = last(this);
  for (const k of dor(ctx(this)).criteria) notLists(cell, k.text);
  assert.doesNotMatch(cell.text, /flag/i, `the row's verdict "${cell.text}" lists a flag:\n${cell.table}`);
});

Then("that row lists the failed line {string} with the reason {string}", function (line: string, reason: string) {
  listsLine(this, last(this), line, reason);
});

Then("the Readiness checks table's row for that call lists the failed line {string} with the reason {string}", function (line: string, reason: string) {
  listsLine(this, remember(this, () => thatCall(this)), line, reason);
});

Then("that row doesn't list the line {string}", function (line: string) {
  notLists(last(this), line);
});

Then("the reason shows as text, not as bold", function () {
  const cell = last(this);
  assert.doesNotMatch(cell.html, /<b\b/i, `the row's verdict holds a <b> element: ${cell.html}`);
  assert.ok(cell.text.includes("<b>§9</b>"), `the row's verdict doesn't show "<b>§9</b>" as text: "${cell.text}"`);
});

Then("that row lists the flag {string}", function (flag: string) {
  const cell = last(this);
  assert.ok(cell.text.includes(flag), `the row's verdict "${cell.text}" doesn't list the flag "${flag}":\n${cell.table}`);
});

Then("the Readiness checks table's row for that call says the judge's output was unreadable", function () {
  const cell = remember(this, () => thatCall(this));
  assert.match(cell.text, /unreadable/i, `the row's verdict "${cell.text}" doesn't say the output was unreadable:\n${cell.table}`);
});

Then("that row doesn't show the verdict {string}", function (verdict: string) {
  notShows(last(this), verdict);
});

Then("the Readiness checks table's row for that call says the call failed with no verdict", function () {
  const cell = remember(this, () => thatCall(this));
  assert.match(cell.text, /\bfailed\b/i, `the row's verdict "${cell.text}" doesn't say the call failed:\n${cell.table}`);
  assert.match(cell.text, /\bno verdict\b/i, `the row's verdict "${cell.text}" doesn't say there's no verdict:\n${cell.table}`);
});

Then("that row doesn't say the judge's output was unreadable", function () {
  const cell = last(this);
  assert.doesNotMatch(cell.text, /unreadable/i, `the row's verdict "${cell.text}" says the output was unreadable:\n${cell.table}`);
});

Then("the Readiness checks table's row for the call at {string} shows the verdict {string}", function (at: string, verdict: string) {
  shows(remember(this, () => callAt(this, at)), verdict);
});

Then("the row for the call at {string} doesn't list the line {string}", function (at: string, line: string) {
  notLists(remember(this, () => callAt(this, at)), line);
});

Then("the Readiness checks table's row for the judge call on {string} shows the verdict {string}", function (child: string, verdict: string) {
  shows(remember(this, () => callOn(this, child)), verdict);
});

Then("that row names the child {string} beside its verdict", function (child: string) {
  const cell = last(this);
  assert.ok(cell.text.includes(child), `the row's verdict "${cell.text}" doesn't name the child "${child}":\n${cell.table}`);
});

Then("the Readiness checks table's row for the judge call on {string} names the child {string} and shows the verdict {string}",
  function (on: string, child: string, verdict: string) {
    const cell = remember(this, () => callOn(this, on));
    assert.ok(cell.text.includes(child), `the row's verdict "${cell.text}" doesn't name the child "${child}":\n${cell.table}`);
    shows(cell, verdict);
  });

Then("the row for the judge call on {string} doesn't name the child {string}", function (on: string, child: string) {
  const cell = remember(this, () => callOn(this, on));
  assert.ok(!cell.text.includes(child), `the row's verdict "${cell.text}" names the child "${child}":\n${cell.table}`);
});

Then("that row names no child", function () {
  const cell = last(this);
  assert.doesNotMatch(cell.text, /\bchild\b/i, `the row's verdict "${cell.text}" names a child:\n${cell.table}`);
});

Then("the Readiness checks table's row for that check says no verdict was recorded", function () {
  const at = ctx(this).legacy.at(-1);
  assert.ok(at, "no check was recorded before verdicts were kept");
  const cell = remember(this, () => verdictAt(this, at));
  assert.match(cell.text, /no verdict was recorded/i, `the row's verdict "${cell.text}" doesn't say no verdict was recorded:\n${cell.table}`);
});

Then("the Readiness checks table has a Verdict column", function () {
  col(table(this), VERDICT);
});

Then("the Readiness checks table's row for the split proposal has an empty Verdict cell", function () {
  const r = ctx(this).recorded.filter((x) => x.kind === "split");
  assert.equal(r.length, 1, `the gate recorded ${r.length} split proposals`);
  const cell = verdictAt(this, r[0].ranAt);
  assert.equal(cell.text, "", `the split proposal's verdict cell says "${cell.text}":\n${cell.table}`);
});
