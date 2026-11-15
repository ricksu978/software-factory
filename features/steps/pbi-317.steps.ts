// Step definitions for features/pbi-317-old-ci-failed-question-back-to-green.feature.
//
// Every scenario runs on PBI 4's test database with PBI 12's poller harness, as PBI 305's do, and its items are set up
// by PBI 305's `waits`: a board item labelled "factory" in "acme/widgets", held in NeedsInput with an open run stopped
// at address whose PR is open in the fake repo host, on base "main", and an open needs_input question with the body
// the scenario names. Unlike PBI 305's items, these see no poll while they're set up: the poll that first sees an older
// CI-failed question answers it, so the scenario's own poll, Hold or answer comes first. PBI 305's steps supply "waits in NeedsInput on the question <text>", the red base's question and
// "two polls run at the same time". PBI 260's supply the scheduler, the Hold and release, the question Thens, "the
// event's actor is the system", the dashboard and "the scheduler claims the item and its cell runs". PBI 12's "the
// poller runs once" and "the item's run resumes from", PBI 142's "the poller runs twice" and PBI 168's "the factory
// holds item ... in state" read the same harness.
//
// The first item a scenario sets up also has a cell behind it: PBI 18's engine harness through PBI 215's `prepare`, at
// address, with PR 57. Its main starts at b4se001 and then gains b4se002, as PBI 260's "the item stopped at the address
// stage" does, so the claim has a base to merge. When the scheduler's claim starts a cell for the item, the harness
// runs the engine from the stage the claim resumes at, with the run's PR and the latest answer on the item as its
// decision. Just before it runs, PBI 292's fake CI goes on the cell: CI by commit and by check, with each failed
// check's URL and failing tests through the cell API's `ciChecks`. PBI 292's Givens and its Green's brief Thens read it.
//
// The contract these steps set up, which the factory meets:
// - An older "Address failed" question is the body "Address failed:" followed by one finding per line, each "- <text>".
//   A line naming a CI failure reads "CI failed on <commit>", perhaps followed by ", <what the commit was>".
// - The factory's answer leaves `answered_by` null and says the factory sends the item back to Green to fix the CI
//   failure: it names Green, says CI failed, and says the item is sent back to fix it. The re-queue is one event of
//   kind REQUEUED_FOR_GREEN, by the system, on the item, whose payload holds `questionId` and `prNumber`. The activity
//   log lists it as a row naming the item and that kind. The run's next stage is green, where the scheduler claims it.
// - "PR 57's head" is the item's branch as the cell finds it on origin, before the claim merges the base: the commit
//   PBI 292's fake CI calls "the PR's first head", the first commit CI is asked about outside the address stage. "Has
//   since moved to" puts a new commit on the branch after the one the question named.
// - Green's first attempt "was reported as fixing CI" when a /stage report for its first attempt carries `ciFailure`,
//   as PBI 292 reports it.
// - "Just before the poller answers it" is the poller's prState call for that item's PR, which every poll makes for a
//   NeedsInput item with a PR before it answers the item's question.
import { After, Before, BeforeStep, Given, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { ciQuestion } from "../../src/cell/ci-failure.ts";
import { REQUEUED_FOR_GREEN } from "../../src/watcher/poller.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";
import { ctx as pollCtx, polled } from "./pbi-12.steps.ts";
import type { Ctx as CellCtx } from "./pbi-18.steps.ts";
import { prepare } from "./pbi-215.steps.ts";
import { ctx as base260 } from "./pbi-260.steps.ts";
import { ctx as ci292, install as installCi, shaOf } from "./pbi-292.steps.ts";
import { answer, waits } from "./pbi-305.steps.ts";

const REPO = "acme/widgets";
const PR = 57;
const BRANCH = "factory/pbi-482-r1";
const pool = () => need().pool;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

Before({ tags: "@pbi-317 and @db", ...long }, async function () {
  const d = await testDb();
  if (!d) return;
  await d.pool.query('truncate item, event, backlog_source, repo, "user", override cascade');
  await d.pool.query("update wip_policy set mode = 'fixed', current_wip = 2, review_capacity = 3, usage_paused_until = null");
});

After({ tags: "@pbi-317", ...long }, async function () {
  // PBI 175's dashboard and PBI 105's activity log close their servers only in their own scenarios.
  for (const key of ["pbi175", "pbi105"] as const) {
    const s = (this as Record<string, { server?: Server; close?: () => Promise<void> } | undefined>)[key];
    if (!s) continue;
    await s.close?.();
    if (s.server) {
      s.server.closeAllConnections();
      await new Promise<void>((resolve) => s.server!.close(() => resolve()));
    }
  }
});

// ---- the items ----

function cellOf(world: object): CellCtx {
  const w = world as { pbi18?: CellCtx };
  assert.ok(w.pbi18, "no cell was set up behind the item");
  return w.pbi18;
}

/** The cell behind the scenario's first item: at address with PR 57, its main gaining b4se002 after b4se001. */
function cellBehind(world: object): void {
  if ((world as { pbi18?: CellCtx }).pbi18) return;
  prepare(world, "address", "main");
  const cell = cellOf(world);
  cell.prNumber = PR;
  const m = base260(world);
  m.shas.set("b4se001", git(cell.dir, "rev-parse", "origin/main"));
  const seed = join(cell.root, "seed");
  git(seed, "checkout", "-q", "main");
  writeFileSync(join(seed, "app.txt"), "base\n");
  git(seed, "commit", "-q", "-am", "b4se002: fix main");
  git(seed, "push", "-q", "origin", "main");
  m.shas.set("b4se002", git(seed, "rev-parse", "HEAD"));
  git(cell.dir, "fetch", "-q", "origin");
  assert.notEqual(m.shas.get("b4se001"), m.shas.get("b4se002"), "main didn't move on to b4se002");
}

async function waitsOn(world: object, n: number, body: string, pr?: number): Promise<void> {
  // Its first poll is the scenario's own, since the poll that first sees an older CI-failed question answers it.
  await waits(world, n, body, pr === undefined ? { poll: false } : { pr, poll: false });
  if (pr === undefined || pr === PR) cellBehind(world);
  const q = (await pool().query<{ body: string; state: string }>(
    "select q.body, i.state from question q join item i on i.id = q.item_id where q.id = $1", [base260(world).items.get(n)!.question],
  )).rows[0];
  assert.equal(q.body, body, `item ${n}'s question isn't the scenario's`);
  assert.equal(q.state, "NeedsInput", `item ${n} is ${q.state}`);
}

Given("item {int} waits in NeedsInput on the question:", long, async function (n: number, body: string) {
  await waitsOn(this, n, body);
});

Given(
  "item {int}, with PR {int} in {string}, waits in NeedsInput on an {string} question naming only the CI failure on {string}",
  long,
  async function (n: number, pr: number, repo: string, kind: string, sha: string) {
    assert.equal(repo, REPO, `the scenarios' PRs are all in ${REPO}`);
    await waitsOn(this, n, `${kind}:\n- CI failed on ${sha}`, pr);
  },
);

Given(
  "item {int}, with PR {int} in {string}, waits in NeedsInput on an {string} question naming the CI failure on {string} and a changed locked scenario file",
  long,
  async function (n: number, pr: number, repo: string, kind: string, sha: string) {
    assert.equal(repo, REPO, `the scenarios' PRs are all in ${REPO}`);
    await waitsOn(this, n, `${kind}:\n- CI failed on ${sha}\n- the locked scenario file "features/pbi-12-poller.feature" changed`, pr);
  },
);

Given(
  "item {int} waits in NeedsInput on the question Green asks after leaving commit {string}, which CI failed on, unchanged",
  long,
  async function (n: number, sha: string) {
    const body = ciQuestion([{ sha, checks: [{ name: "ci", url: "https://github.com/acme/widgets/actions/runs/7101", failingTests: ["parses the config"] }] }]);
    assert.ok(body.includes(sha) && /unchanged/.test(body), `Green's question doesn't say it left ${sha} unchanged: ${body}`);
    await waitsOn(this, n, body);
  },
);

// ---- the PR's head ----

function pollPr(world: object, n: number) {
  const found = pollCtx(world).host?.prs.find((p) => p.repo === REPO && p.number === n);
  assert.ok(found, `no PR ${n} in ${REPO}`);
  return found;
}

Given("PR {int}'s head is commit {string}", function (n: number, label: string) {
  assert.equal(n, PR, `the cell's PR is ${PR}`);
  cellOf(this);
  pollPr(this, n).headSha = label;
  ci292(this).roles.set(label, { kind: "head" });
});

Given("PR {int}'s head has since moved to commit {string}", long, async function (n: number, label: string) {
  assert.equal(n, PR, `the cell's PR is ${PR}`);
  const cell = cellOf(this);
  const c = ci292(this);
  // The commit the question named is the branch's head as it was. A new commit on the branch is the PR's head now.
  const body = (await pool().query<{ body: string }>("select body from question where id = $1", [first(this).question])).rows[0]?.body ?? "";
  const named = /CI failed on (\S+)/.exec(body)?.[1];
  assert.ok(named, "the question names no commit CI failed on");
  const before = git(cell.dir, "rev-parse", "HEAD");
  c.roles.set(named, { kind: "sha", sha: before });
  writeFileSync(join(cell.dir, "moved.txt"), "the PR moved on\n");
  git(cell.dir, "add", "moved.txt");
  git(cell.dir, "commit", "-q", "-m", "the PR moves on");
  git(cell.dir, "push", "-q", "origin", `HEAD:refs/heads/${BRANCH}`);
  assert.notEqual(git(cell.root, "--git-dir", cell.origin, "rev-parse", BRANCH), before, "the PR's head didn't move");
  pollPr(this, n).headSha = label;
  c.roles.set(label, { kind: "head" });
});

/** The scenario's first item, which has the cell behind it. */
function first(world: object): { id: string; question: string } {
  const f = base260(world).items.values().next().value;
  assert.ok(f, "no item was set up");
  return f;
}

// The cell the claim runs resumes with the run's PR and the latest answer on the item as its decision, as GET context
// gives them, and with PBI 292's fake CI on it.
BeforeStep({ tags: "@pbi-317", ...long }, async function ({ pickleStep }) {
  if (pickleStep.text !== "the scheduler claims the item and its cell runs") return;
  const cell = (this as { pbi18?: CellCtx }).pbi18;
  if (!cell) return;
  const item = first(this).id;
  const d = (await pool().query<{ decision: string; answer: string | null }>(
    "select decision, answer from question where item_id = $1 and decision is not null order by answered_at desc nulls last limit 1", [item],
  )).rows[0];
  cell.context = { ...cell.context, prNumber: PR, decision: d ? { kind: d.decision, text: d.answer ?? "" } : null };
  ci292(this);
  installCi(this);
});

// ---- people and the poller ----

Given("the owner answers item {int}'s question {string} just before the poller answers it", long, async function (n: number, text: string) {
  const host = pollCtx(this).host;
  assert.ok(host, "the poller's fake repo host isn't set up");
  const item = base260(this).items.get(n);
  assert.ok(item, `no item ${n} was set up`);
  const pr = (await pool().query<{ pr_number: number | null }>("select pr_number from run where item_id = $1 and ended_at is null", [item.id])).rows[0]?.pr_number;
  assert.ok(pr, `item ${n}'s run has no PR`);
  pollPr(this, pr);
  const open = (await pool().query<{ answer: string | null }>("select answer from question where id = $1", [item.question])).rows[0];
  assert.equal(open?.answer, null, `item ${n}'s question is already answered`);
  const read = host.prState.bind(host);
  let answered = false;
  host.prState = async (repo, number, ...rest) => {
    if (!answered && repo === REPO && number === pr) {
      answered = true;
      await answer(this, n, text);
    }
    return read(repo, number, ...rest);
  };
});

// ---- the answer and the events ----

Then("the answer says the factory sends the item back to Green to fix the CI failure", long, async function () {
  polled(pollCtx(this));
  const m = base260(this);
  const n = m.lastAsked ?? [...m.items.keys()][0];
  const q = (await pool().query<{ answer: string | null }>("select answer from question where id = $1", [m.items.get(n)!.question])).rows[0];
  const a = q?.answer;
  assert.ok(a, `item ${n}'s question has no answer`);
  assert.match(a, /\bGreen\b/, `the answer doesn't say the item goes back to Green: ${a}`);
  assert.match(a, /\bCI fail/i, `the answer doesn't name the CI failure: ${a}`);
  assert.match(a, /\bfix/i, `the answer doesn't say Green fixes the CI failure: ${a}`);
});

type EventRow = { actor: string; actor_id: string; payload: { questionId?: string; prNumber?: number } | null };

async function requeues(world: object, n: number): Promise<EventRow[]> {
  polled(pollCtx(world));
  const item = base260(world).items.get(n);
  assert.ok(item, `no item ${n} was set up`);
  return (await pool().query<EventRow>(
    "select actor, actor_id, payload from event where item_id = $1 and kind = $2 order by at, id", [item.id, REQUEUED_FOR_GREEN],
  )).rows;
}

async function exactlyOne(world: object, n: number): Promise<void> {
  const all = await requeues(world, n);
  assert.equal(all.length, 1, `item ${n} has ${all.length} ${REQUEUED_FOR_GREEN} events`);
  assert.equal(all[0].actor, "system", `the event's actor is ${all[0].actor} ${all[0].actor_id}`);
  const item = base260(world).items.get(n)!;
  assert.equal(all[0].payload?.questionId, item.question, `the event names question ${all[0].payload?.questionId}`);
  const pr = (await pool().query<{ pr_number: number | null }>("select pr_number from run where item_id = $1 and ended_at is null", [item.id])).rows[0]?.pr_number;
  assert.equal(all[0].payload?.prNumber, pr, `the event names PR ${all[0].payload?.prNumber}`);
  base260(world).lastAsked = n;
}

Then("item {int} has a system event recording its re-queue for Green after an older CI failure", long, async function (n: number) {
  await exactlyOne(this, n);
});

Then("item {int} has exactly one system event recording a re-queue for Green after an older CI failure", long, async function (n: number) {
  await exactlyOne(this, n);
});

Then("item {int} has no system event recording a re-queue for Green after an older CI failure", long, async function (n: number) {
  const all = await requeues(this, n);
  assert.equal(all.length, 0, `item ${n} has ${all.length} ${REQUEUED_FOR_GREEN} events`);
});

const namesItem = (t: string, n: number) => new RegExp(`(?<![\\w.])#?${n}(?!\\d)`).test(t);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

Then("the activity log lists item {int}'s re-queue for Green after an older CI failure", function (n: number) {
  const c = (this as { pbi105?: { status?: number; page?: string } }).pbi105;
  assert.ok(c?.page !== undefined, "the activity log wasn't opened");
  assert.equal(c.status, 200, `the activity log answered ${c.status}`);
  const rows = [...c.page.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) => text(r[1])).filter((r) => namesItem(r, n));
  assert.ok(rows.some((r) => r.includes(REQUEUED_FOR_GREEN)), `no row lists item ${n}'s re-queue (${REQUEUED_FOR_GREEN}):\n${rows.join("\n")}`);
});

// ---- the cell the claim started ----

function ranCell(world: object): CellCtx {
  assert.equal(base260(world).cellRan, true, "the scheduler started no cell for the item");
  const cell = cellOf(world);
  assert.equal(cell.error, null, `the cell failed: ${cell.error instanceof Error ? cell.error.stack : String(cell.error)}`);
  return cell;
}

const starts = (cell: CellCtx) => cell.calls.filter((x) => x.route === "/stage" && x.body.status === "started").map((x) => String(x.body.stageId));

Then("address didn't run before the green stage", function () {
  const s = starts(ranCell(this));
  const green = s.indexOf("green");
  assert.ok(green >= 0, `the green stage never began; the stages were ${JSON.stringify(s)}`);
  assert.ok(!s.slice(0, green).includes("address"), `address ran before the green stage; the stages were ${JSON.stringify(s)}`);
});

function firstBrief(world: object): string {
  const cell = ranCell(world);
  const b = cell.agentCalls.find((a) => a.stage === "green" && a.mode !== "judge" && !String(a.prompt).startsWith("# Definition of Done"));
  assert.ok(b, "Green never ran");
  return String(b.prompt);
}

Then("Green's brief doesn't name the test {string}", function (test: string) {
  const b = firstBrief(this);
  assert.ok(!b.includes(test), `Green's brief names the test "${test}":\n${b}`);
});

Then("Green's first attempt was reported as fixing CI on {string}", function (label: string) {
  const cell = ranCell(this);
  const sha = shaOf(this, label);
  const r = cell.calls.filter((x) => x.route === "/stage" && x.body.stageId === "green" && Number(x.body.attempt) === 1 && x.body.ciFailure).map((x) => x.body);
  assert.ok(r.length > 0, "Green's first attempt wasn't reported as fixing CI");
  const said = (b: Record<string, any>) => typeof b.ciFailure.sha === "string" && b.ciFailure.sha.length >= 7 && sha.startsWith(b.ciFailure.sha);
  const found = r.find(said);
  assert.ok(found, `Green's first attempt was reported as fixing CI on ${JSON.stringify(r.map((b) => b.ciFailure.sha))}, not ${sha}`);
  (this as { pbi292report?: Record<string, any> }).pbi292report = found;
});
