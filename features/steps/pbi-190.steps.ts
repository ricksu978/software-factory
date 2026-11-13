// Step definitions for features/pbi-190-pr-review-restate.feature.
//
// The engine scenarios run the cell through PBI 18's harness with PBI 128's fake repo host, CI, scripted PR reviewer
// and scripted PR addresser. Each review runs in a session of its own, `pr-reviewer-session-<n>`, whose id comes back
// as the answer's `sessionId`. A restate is a PR reviewer call that resumes one of those sessions, by AgentArgs'
// `resume`. These steps fill in PBI 128's two hooks:
//
// - `reword` replaces a review's answer, as the scenario writes it, so it can't be read. A review the scenario says
//   nothing about keeps the answer PBI 128's scripted reviewer works out.
// - `onRestate` answers a restate, by the review whose session it resumes: as the scenario writes it, or else with the
//   answer PBI 128's scripted reviewer worked out for that review, which reads correctly.
//
// A restate is never counted as a review: PBI 128's `reviewerCalls` holds only the calls that started a session.
//
// The stage's record of a restate is the `restates` list on the PR review stage's /stage report:
// `[{ round, reason }]`, with the reason the engine gives for the answer it couldn't read.
//
// Run detail runs the real cell API and the real dashboard on free ports, over PBI 4's shared test database. The
// Given posts the PR review stage's report, with its restate, through the cell API as the run's cell would. The page
// contract read here: a section is an <h2> and what follows it up to the next <h2>. In the "Stages" section, the
// row for the PR review stage's attempt 1 starts with "pr-review 1" and says it needed a "second ask", and why.
import { After, Given, Then, When, type DataTable } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fakeBacklog, fakeRepoHost } from "../../src/adapters/fake.ts";
import { cellApi, runToken } from "../../src/control/cell-api.ts";
import { createAuth } from "../../src/http/auth.ts";
import { dashboardRoutes } from "../../src/http/routes.ts";
import { startServer } from "../../src/http/server.ts";
import type { Ctx as CellCtx } from "./pbi-18.steps.ts";
import {
  ctx as pr128, done, posted, question, REVIEWER, reviewerCall, stageReports, that, threadFor, threadsInBrief,
  type AgentRecord, type Ctx as PrCtx,
} from "./pbi-128.steps.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";

const ORD = "(first|second|third|fourth|fifth|\\d+(?:st|nd|rd|th))";
const ORDINALS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };
function ordinal(word: string): number {
  const n = ORDINALS[word] ?? Number(/^(\d+)(st|nd|rd|th)$/.exec(word)?.[1]);
  assert.ok(Number.isInteger(n) && n > 0, `not an ordinal: ${word}`);
  return n;
}

type Restate = { of: number | null; resume: string; prompt: string; rec: AgentRecord };
type Ctx = {
  /** Review n's answer as the scenario writes it, in place of the scripted one. */
  reviews: Map<number, string>;
  /** Every review's answer loses its last line, so each needs a restate. */
  everyReview: boolean;
  /** The restate of review n, as the scenario writes it, from that review's call. */
  restated: Map<number, (original: AgentRecord) => string>;
  /** The answer to every restate, when the scenario gives one for all. */
  everyRestate: string | null;
  restates: Restate[];
  /** Run detail's servers, cleaned up after the scenario. */
  servers: Server[];
  closers: (() => Promise<void>)[];
  itemId?: string;
  /** The last line the recorded second ask names. */
  line?: string;
  page?: { status: number; html: string };
};

function own(world: object): Ctx {
  const w = world as { pbi190?: Ctx };
  w.pbi190 ??= { reviews: new Map(), everyReview: false, restated: new Map(), everyRestate: null, restates: [], servers: [], closers: [] };
  return w.pbi190;
}

/** PBI 128's context with this file's hooks in it. */
function hooked(world: object): { c: PrCtx; o: Ctx } {
  const c = pr128(world);
  const o = own(world);
  if (!c.reword) {
    c.reword = (n, answer) => {
      const given = o.reviews.get(n);
      if (given !== undefined) return given;
      if (o.everyReview) return [...answer.split("\n").slice(0, -1), "That's my review, see the lines above."].join("\n");
      return answer;
    };
    c.onRestate = (a, rec) => {
      const n = c.reviewerSessions.indexOf(a.resume) + 1;
      const of = n > 0 ? n : null;
      o.restates.push({ of, resume: a.resume, prompt: a.prompt, rec });
      if (of === null) return "APPROVED";
      const original = c.reviewerCalls[of - 1];
      const scripted = o.restated.get(of);
      if (scripted) return scripted(original);
      if (o.everyRestate !== null) return o.everyRestate;
      return c.answers[of - 1] ?? "APPROVED";
    };
  }
  return { c, o };
}

const finding = (body: string, path: string, line?: number) =>
  JSON.stringify(line === undefined ? { finding: body, path } : { finding: body, path, line });

// ---- Givens: the reviews ----

Given(new RegExp(`^the PR reviewer's ${ORD} review ends with the line "([^"]*)"$`), function (which: string, line: string) {
  hooked(this).o.reviews.set(ordinal(which), `I read the diff at the head this brief names.\n${line}`);
});

Given("the PR reviewer's first review reports a finding {string} in {string} with no line, ending {string}", function (body: string, path: string, ending: string) {
  hooked(this).o.reviews.set(1, `${finding(body, path)}\n${ending}`);
});

Given("the PR reviewer's first review reports no finding and ends {string}", function (ending: string) {
  hooked(this).o.reviews.set(1, ending);
});

Given("the PR reviewer's every review needs a restate, and each restate reads correctly", function () {
  hooked(this).o.everyReview = true;
});

// ---- Givens: the restates ----

Given("the PR reviewer restates its answer as APPROVED", function () {
  hooked(this).o.restated.set(1, () => "APPROVED");
});

Given("the PR reviewer restates its answer ending with the line {string}", function (line: string) {
  hooked(this).o.restated.set(1, () => `As I said, I read the diff.\n${line}`);
});

Given("the PR reviewer answers every restate request ending with the line {string}", function (line: string) {
  hooked(this).o.everyRestate = `As I said, I read the diff.\n${line}`;
});

Given("the PR reviewer restates its answer with a finding {string} in {string} with no line, ending {string}", function (body: string, path: string, ending: string) {
  hooked(this).o.restated.set(1, () => `${finding(body, path)}\n${ending}`);
});

Given("the PR reviewer restates its answer with the finding {string} on line {int} of {string}, ending {string}", function (body: string, line: number, path: string, ending: string) {
  const { c, o } = hooked(this);
  o.restated.set(1, () => `${finding(body, path, line)}\n${ending}`);
  c.last = body;
});

Given("the PR reviewer restates its answer with these findings, ending {string}:", function (ending: string, table: DataTable) {
  const { c, o } = hooked(this);
  const rows = table.hashes().map((r) => ({ body: r.finding.trim(), path: r.path.trim(), line: Number(r.line) }));
  o.restated.set(1, () => [...rows.map((r) => finding(r.body, r.path, r.line)), ending].join("\n"));
  c.last = rows.at(-1)?.body ?? null;
});

Given(new RegExp(`^the PR reviewer restates its ${ORD} review as finding that thread fixed, with no new finding, ending APPROVED$`), function (which: string) {
  const { c, o } = hooked(this);
  const body = that(c);
  o.restated.set(ordinal(which), () =>
    `${JSON.stringify({ thread: threadFor(c, body).threadId, settled: true, reason: "Fixed at this head." })}\nAPPROVED`);
});

Given(new RegExp(`^the PR reviewer restates its ${ORD} review as finding every thread fixed, with no new finding, ending APPROVED$`), function (which: string) {
  const { c, o } = hooked(this);
  o.restated.set(ordinal(which), (original) => [
    ...threadsInBrief(c, original.prompt).map((t) => JSON.stringify({ thread: t.threadId, settled: true, reason: "Fixed at this head." })),
    "APPROVED",
  ].join("\n"));
});

// ---- Thens: the restate requests ----

function ran(world: object): { c: PrCtx; o: Ctx; run: CellCtx } {
  const { c, run } = done(world);
  return { c, run, o: hooked(world).o };
}

function onlyRestate(o: Ctx): Restate {
  assert.equal(o.restates.length, 1, `the factory asked the PR reviewer to restate ${o.restates.length} times`);
  return o.restates[0];
}

Then("the factory asked the PR reviewer to restate its answer once", function () {
  onlyRestate(ran(this).o);
});

Then(new RegExp(`^the factory asked the PR reviewer to restate its ${ORD} review once$`), function (which: string) {
  const r = onlyRestate(ran(this).o);
  assert.equal(r.of, ordinal(which), `the restate resumed ${r.resume}, not the session of the ${which} review`);
});

Then("the factory asked the PR reviewer to restate {int} times, once per round", function (n: number) {
  const { o } = ran(this);
  assert.deepEqual(o.restates.map((r) => r.of), Array.from({ length: n }, (_, i) => i + 1),
    `the factory asked the PR reviewer to restate ${o.restates.length} times, for reviews ${JSON.stringify(o.restates.map((r) => r.of))}`);
});

Then(new RegExp(`^the restate went to the same PR reviewer session as its ${ORD} review$`), function (which: string) {
  const { c, o } = ran(this);
  const n = ordinal(which);
  reviewerCall(c, n);
  const restate = o.restates.find((r) => r.of === n) ?? o.restates[0];
  assert.ok(restate, "the factory asked the PR reviewer for no restate");
  assert.equal(restate.resume, c.reviewerSessions[n - 1], `the restate resumed ${restate.resume}, not the ${which} review's session`);
  assert.equal(restate.rec.agent, REVIEWER);
});

Then("the restate request quotes why the answer couldn't be read, naming the last line {string}", function (line: string) {
  const r = onlyRestate(ran(this).o);
  assert.ok(r.prompt.includes(line), `the restate request doesn't quote the last line "${line}": ${r.prompt}`);
  assert.match(r.prompt, /last line/i, `the restate request doesn't say the last line is why: ${r.prompt}`);
});

Then("the restate request quotes why the answer couldn't be read, saying a finding needs its text, a path and a line", function () {
  const r = onlyRestate(ran(this).o);
  assert.ok(r.prompt.includes("a finding needs its text, a path and a line"), `the restate request doesn't say why: ${r.prompt}`);
});

Then("the restate request quotes why the answer couldn't be read, saying it answered {string} with no new finding and no thread held", function (verdict: string) {
  const r = onlyRestate(ran(this).o);
  assert.ok(r.prompt.includes(verdict) && r.prompt.includes("with no new finding and no thread held"), `the restate request doesn't say why: ${r.prompt}`);
});

Then("the restate request asks for the answer again in the required format, ending in APPROVED or {string}", function (open: string) {
  const r = onlyRestate(ran(this).o);
  assert.ok(r.prompt.includes("APPROVED") && r.prompt.includes(open), `the restate request doesn't ask for APPROVED or ${open}: ${r.prompt}`);
});

// The review brief's own words: the first paragraph of the PR review prompt, after its heading.
function briefMark(): string {
  const text = readFileSync(new URL("../../sop/prompts/pr-review.md", import.meta.url), "utf8");
  const para = text.split(/\r?\n\s*\r?\n/).map((p) => p.trim()).find((p) => p && !p.startsWith("#"));
  assert.ok(para, "the PR review prompt has no paragraph");
  return para;
}

Then("the PR reviewer was given the review brief once", function () {
  const { c } = ran(this);
  const mark = briefMark();
  const given = c.agentCalls.filter((a) => a.agent === REVIEWER && a.prompt.includes(mark));
  assert.equal(given.length, 1, `the PR reviewer was given the review brief ${given.length} times`);
});

Then("the restate request doesn't hold the review brief again", function () {
  const { c, o } = ran(this);
  const r = onlyRestate(o);
  assert.ok(!r.prompt.includes(briefMark()), "the restate request holds the review brief");
  const first = reviewerCall(c, 1);
  assert.ok(!r.prompt.includes(`Review its head \`${first.head}\``), "the restate request names the head to review again");
});

Then("the factory started no new PR reviewer session for the restate", function () {
  const { c, o } = ran(this);
  const r = onlyRestate(o);
  assert.ok(r.of !== null, `the restate resumed ${r.resume}, which is no PR reviewer session`);
  assert.equal(c.reviewerCalls.length, 1, `the factory started ${c.reviewerCalls.length} PR reviewer sessions`);
});

// ---- Thens: the PR and the item ----

Then("the factory posted one review on the PR, at the commit the PR reviewer reviewed, with no line comments", function () {
  const { c } = ran(this);
  const all = posted(c);
  assert.equal(all.length, 1, `the factory posted ${all.length} reviews on the PR`);
  assert.equal(all[0].commitSha, reviewerCall(c, 1).head);
  assert.deepEqual(all[0].comments, []);
});

Then("the factory posted exactly one review on the PR", function () {
  const { c } = ran(this);
  assert.equal(posted(c).length, 1, `the factory posted ${posted(c).length} reviews on the PR`);
});

Then("the factory posted no review on the PR", function () {
  const { c } = ran(this);
  assert.equal(posted(c).length, 0, `the factory posted ${posted(c).length} reviews on the PR`);
});

Then("no review or comment on the PR holds {string}", function (text: string) {
  const { c } = ran(this);
  const reviews = posted(c).flatMap((r) => [r.body, ...r.comments.map((x) => x.body)]);
  const threads = [...c.host.reviewComments.values()].flat().map((x) => x.body);
  const comments = c.host.prs.flatMap((p) => p.comments);
  const holding = [...reviews, ...threads, ...comments].filter((b) => b.includes(text));
  assert.deepEqual(holding, [], `the PR holds "${text}"`);
});

Then("the PR addresser's brief holds {string} and {string}", function (a: string, b: string) {
  const { c } = ran(this);
  assert.ok(c.addresserCalls.length > 0, "the PR addresser never ran");
  for (const t of [a, b]) assert.ok(c.addresserCalls[0].prompt.includes(t), `the PR addresser's brief lacks "${t}"`);
});

Then("the item never moved to NeedsInput", function () {
  const { run } = ran(this);
  const blocked = run.calls.filter((x) => x.route === "/transition" && x.body.event === "blocked");
  assert.deepEqual(blocked.map((x) => x.body.question?.body), [], "the item moved to NeedsInput");
});

Then("the question says the PR review couldn't read the PR reviewer's answer", function () {
  const q = question(ran(this).run);
  assert.ok(q.includes("couldn't read the PR reviewer's answer"), `the question: ${q}`);
});

Then("the question names the last line {string}", function (line: string) {
  const q = question(ran(this).run);
  assert.ok(q.includes(line), `the question doesn't name "${line}": ${q}`);
});

Then("the question doesn't name the line {string}", function (line: string) {
  const q = question(ran(this).run);
  assert.ok(!q.includes(line), `the question names "${line}": ${q}`);
});

Then("the question says a finding needs its text, a path and a line", function () {
  const q = question(ran(this).run);
  assert.ok(q.includes("a finding needs its text, a path and a line"), `the question: ${q}`);
});

// ---- Thens: the stage ----

Then("the PR review stage ran {int} attempt(s)", function (n: number) {
  const { run } = ran(this);
  assert.equal(stageReports(run, "pr-review").filter((x) => x.body.status === "started").length, n);
});

function restateLogged(run: CellCtx, round: number): { round: number; reason: string } {
  const logged = stageReports(run, "pr-review").filter((x) => x.body.status !== "started")
    .flatMap((x) => (Array.isArray(x.body.restates) ? x.body.restates : []) as { round: number; reason: string }[]);
  const r = logged.find((x) => x.round === round);
  assert.ok(r, `the PR review stage's record logs second asks in rounds ${JSON.stringify(logged.map((x) => x.round))}`);
  return r;
}

Then("the PR review stage's record says the PR reviewer needed a second ask in round {int}", function (round: number) {
  restateLogged(ran(this).run, round);
});

Then("that record gives why its first answer couldn't be read, naming the last line {string}", function (line: string) {
  const r = restateLogged(ran(this).run, 1);
  assert.ok(typeof r.reason === "string" && r.reason.includes(line), `the record's reason doesn't name "${line}": ${r.reason}`);
});

// ---- Run detail ----

const REPO_URL = "https://github.com/acme/app";
const SECRET = "pbi-190-cell-secret";
const OPERATOR = { "x-ms-client-principal-idp": "aad", "x-ms-client-principal-id": "operator", "x-ms-client-principal-name": "operator" };

async function serve(o: Ctx, handler: Parameters<typeof startServer>[0][number]): Promise<string> {
  const s = await startServer([handler], { port: 0 });
  o.servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

After({ tags: "@pbi-190" }, async function () {
  const o = (this as { pbi190?: Ctx }).pbi190;
  if (!o) return;
  for (const c of o.closers) await c();
  for (const s of o.servers) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

Given("item {int}'s PR review stage, attempt {int}, recorded that the PR reviewer needed a second ask in round {int} because its last line was {string}",
  long, async function (item: number, attempt: number, round: number, line: string) {
    const o = own(this);
    await testDb();
    const pool = need().pool;
    await pool.query('truncate item, event, backlog_source, repo, "user", override cascade');
    const source = (await pool.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'pbi-190:' || gen_random_uuid()) returning id")).rows[0].id;
    const itemId = (await pool.query<{ id: string }>(
      `insert into item (source_id, external_id, title, state, lease_generation, lease_owner, lease_expires)
       values ($1, $2, $3, 'InProgress', 1, 'cell-a', now() + interval '5 minutes') returning id`,
      [source, String(item), `Item ${item}`],
    )).rows[0].id;
    const repoId = (await pool.query<{ id: string }>("insert into repo (host_adapter, url, trusted_bot) values ('github', $1, 'factory[bot]') returning id", [REPO_URL])).rows[0].id;
    const runId = (await pool.query<{ id: string }>(
      `insert into run (item_id, run_number, next_stage, branch, repo_id, config_sha, sop_version)
       values ($1, 1, 'pr-review', $2, $3, 'c0ffee', '0.1.0') returning id`,
      [itemId, `factory/pbi-${item}-r1`, repoId],
    )).rows[0].id;
    o.itemId = itemId;
    o.line = line;

    // The PR review stage's attempt reports itself through the real cell API, as the run's cell does.
    const api = cellApi({
      pool, secret: SECRET, repoHost: fakeRepoHost(), backlogFor: () => fakeBacklog().adapter, stageAfter: () => null,
      uploadUrl: async (path: string) => path, gateway: { upstream: "http://127.0.0.1:1", ownerToken: () => "owner-secret" }, webToolsOf: () => [],
    });
    const origin = await serve(o, api);
    const post = async (body: Record<string, unknown>) => {
      const r = await fetch(`${origin}/internal/cells/${runId}/stage`, {
        method: "POST", headers: { authorization: `Bearer ${runToken(SECRET, runId, 1)}`, "content-type": "application/json" }, body: JSON.stringify(body),
      });
      assert.equal(r.status, 200, `the cell API answered ${r.status}: ${await r.text()}`);
    };
    const report = { stageId: "pr-review", attempt, model: "claude-opus-5-5", tokensIn: 0, tokensOut: 0, costUsd: 0 };
    await post({ ...report, status: "started" });
    await post({ ...report, status: "passed", tokensIn: 5000, tokensOut: 900, costUsd: 0.42,
      restates: [{ round, reason: `its last line is neither APPROVED nor OPEN: <n>: ${line}` }] });
  });

When("an operator opens Run detail for item {int}", long, async function (_item: number) {
  const o = own(this);
  assert.ok(o.itemId, "no item was set up");
  const pool = need().pool;
  await pool.query(`insert into "user" (provider, subject, github_login, role) values ('microsoft', 'operator', 'operator', 'operator') on conflict (provider, subject) do nothing`);
  const source = (await pool.query<{ source_id: string }>("select source_id from item where id = $1", [o.itemId])).rows[0].source_id;
  let handler: ReturnType<typeof dashboardRoutes> | undefined;
  const origin = await serve(o, (req, res) => handler!(req, res));
  handler = dashboardRoutes({ pool, auth: createAuth({ mode: "azure" }), origin, adapter: fakeBacklog().adapter, sourceId: source });
  o.closers.push(handler.close);
  const r = await fetch(`${origin}/items/${o.itemId}`, { headers: OPERATOR, redirect: "manual" });
  o.page = { status: r.status, html: await r.text() };
});

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
const text = (h: string) => h.replace(/<[^>]*>/g, " ").replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e] ?? e).replace(/\s+/g, " ").trim();

function stagesSection(o: Ctx): string {
  assert.ok(o.page, "no page came back");
  assert.equal(o.page.status, 200, `the page answered ${o.page.status}: ${o.page.html.slice(0, 300)}`);
  const parts = o.page.html.split(/<h2\b[^>]*>/i).slice(1).map((p) => {
    const end = p.search(/<\/h2>/i);
    return { name: text(p.slice(0, end)), body: p.slice(end + 5) };
  });
  const s = parts.find((x) => x.name === "Stages");
  assert.ok(s, `the page has no "Stages" section; it has: ${parts.map((x) => x.name).join(", ")}`);
  return s.body;
}

function prReviewRow(o: Ctx, attempt: number): string {
  const rows = [...stagesSection(o).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]).filter((r) => !/<th\b/i.test(r)).map(text);
  const row = rows.find((r) => r.startsWith(`pr-review ${attempt} `));
  assert.ok(row, `the "Stages" section has no row for the PR review stage's attempt ${attempt}: ${JSON.stringify(rows)}`);
  return row;
}

Then("the \"Stages\" section shows that the PR review stage's attempt {int} needed a second ask of the PR reviewer", function (attempt: number) {
  const row = prReviewRow(own(this), attempt);
  assert.match(row, /second ask/i, `the PR review stage's row doesn't show a second ask: ${row}`);
});

Then("it shows why the first answer couldn't be read", function () {
  const o = own(this);
  assert.ok(o.line, "no second ask was recorded");
  const row = prReviewRow(o, 1);
  assert.ok(row.includes(o.line), `the PR review stage's row doesn't show why: ${row}`);
});
