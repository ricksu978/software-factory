// Step definitions for features/pbi-212-merged-pr-while-waiting-for-ci.feature.
//
// The cell scenarios run PBI 18's engine harness. Each stage starts from the step that already sets it up: PBI 152's
// "resumes at address", PBI 142's "resumes at open-pr", or this file's "resumes at pr-review" with PBI 128's scripted
// PR reviewer and PR addresser. The factory never resumes a cell at pr-review: a run gets there by passing open-pr, so
// "resumes at pr-review" starts the cell at open-pr on the run's open PR, and the PR review follows once its CI passes. The run's PR is #57 on a fake repo host: PBI 128's for pr-review, otherwise one of
// this file's own. Every reply and reviewer request on it is recorded in PBI 194's and PBI 142's contexts, so their
// "no reply is posted" and "no reviewers are requested" Thens read it.
//
// A person merging or closing the PR "while <stage> waits for CI" happens on the first CI question the cell asks during
// that stage. The fake control plane then answers as `GET checks` does today: it refuses with a 400, because the
// commit is no longer on the run's branch (the branch is gone) or is now on main (the branch was kept). Every later
// question gets the same refusal. The repo host meanwhile reports the PR merged, or closed without a merge, and the
// bare origin shows the merge on main and the branch deleted or kept.
//
// The @db scenarios reuse PBI 12's poller harness and PBI 142's item setup, and call the real cell API's `GET checks`
// over HTTP with the run's token.
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fakeRepoHost } from "../../src/adapters/fake.ts";
import { cellApi, runToken } from "../../src/control/cell-api.ts";
import { startServer } from "../../src/http/server.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";
import { ctx as pollCtx, REPO as POLL_REPO } from "./pbi-12.steps.ts";
import { ctx as prReviewCtx, newPass } from "./pbi-128.steps.ts";
import { lastAttempt } from "./pbi-142.steps.ts";
import { setUp, type Ctx as CellCtx } from "./pbi-18.steps.ts";

type Host = ReturnType<typeof fakeRepoHost>;
type FakePr = Host["prs"][number];
type Ctx = {
  host?: Host;
  server?: Server;
  answer?: { status: number; body: Record<string, unknown> };
};

const REPO = "acme/app";
const BRANCH = "factory/pbi-482-r1";
const SECRET = "pbi-212-secret";

function ctx(world: object): Ctx {
  const w = world as { pbi212?: Ctx };
  w.pbi212 ??= {};
  return w.pbi212;
}

function cell(world: object): CellCtx {
  const w = world as { pbi18?: CellCtx };
  assert.ok(w.pbi18, "no run was set up");
  return w.pbi18;
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

Before({ tags: "@pbi-212 and @db", ...long }, async function () {
  const d = await testDb();
  if (d) await d.pool.query('truncate item, event, backlog_source, repo, "user" cascade');
});

After({ tags: "@pbi-212" }, async function () {
  const s = (this as { pbi212?: Ctx }).pbi212;
  if (s?.server) {
    s.server.closeAllConnections();
    await new Promise<void>((resolve) => s.server!.close(() => resolve()));
  }
});

// ---- the cell's repo host ----

/**
 * The cell's repo host and its PR n, open on the run's branch. PBI 128's host when its PR reviewer is set up, otherwise
 * a fake of this file's own. Either way the engine reaches it through a proxy that records replies and reviewer requests.
 */
export function cellPr(world: object, n: number): FakePr {
  const run = cell(world);
  const mine = ctx(world);
  if (!mine.host) {
    const w = world as { pbi128?: unknown };
    if (w.pbi128) mine.host = prReviewCtx(world).host;
    else {
      mine.host = fakeRepoHost();
      run.repoHost = mine.host as unknown as Record<string, unknown>;
    }
    const replies = ((world as { pbi194?: { replies: unknown[] } }).pbi194 ??= { replies: [] } as never).replies;
    const asked = ((world as { pbi142?: { opened: unknown[]; reviewersAsked: unknown[] } }).pbi142 ??= { opened: [], reviewersAsked: [] }).reviewersAsked;
    const inner = run.repoHost!;
    run.repoHost = new Proxy(inner, {
      get(target, key, receiver) {
        const real = Reflect.get(target, key, receiver) as ((...a: unknown[]) => Promise<unknown>) | undefined;
        if (key === "replyToThread" || key === "commentOnPr") return async (...a: unknown[]) => { replies.push(a); return real?.apply(target, a); };
        if (key === "requestReviewers") return async (...a: unknown[]) => { asked.push(a); return real?.apply(target, a); };
        return typeof real === "function" ? real.bind(target) : real;
      },
    });
  }
  let pr = mine.host.prs.find((p) => p.repo === REPO && p.number === n);
  if (!pr) {
    pr = {
      number: n, repo: REPO, branch: BRANCH, base: "main", title: "Item 482", body: "", headSha: null, open: true, merged: false,
      mergeSha: null, mergeable: true, reviewers: [], comments: [], reviews: [],
    };
    mine.host.prs.push(pr);
  }
  Object.assign(pr, { open: true, merged: false, mergeSha: null });
  run.prNumber = n;
  return pr;
}

/** The control plane's 400 for a commit `GET checks` won't answer about, as the cell's HTTP client reports it. */
function refusal(sha: string, why: "gone" | "on main"): Error {
  const error = why === "gone" ? `${sha} isn't on ${BRANCH}` : `${sha} is on main, not only on ${BRANCH}`;
  return new Error(`GET /checks?sha=${sha}: 400 ${JSON.stringify({ error })}`);
}

type Outcome = { merged: boolean; keepBranch: boolean };

/**
 * On the first CI question the cell asks during `stage`, a person merges or closes PR n, and the origin shows it. From
 * then on the control plane refuses every CI question, as it does today. Before that, CI answers as it did.
 */
function duringCiWait(world: object, n: number, stage: string, outcome: Outcome) {
  const run = cell(world);
  const pr = cellPr(world, n);
  const before = run.checks;
  let happened = false;
  run.checks = async (sha: string) => {
    if (!happened && run.stage !== stage) return before ? before(sha) : "success";
    if (!happened) {
      happened = true;
      const bare = ["--git-dir", run.origin];
      const id = ["-c", "user.name=person", "-c", "user.email=person@example.com"];
      const tree = git(run.root, ...bare, "rev-parse", `${sha}^{tree}`);
      // A kept branch is merged with a merge commit, so the pushed commit is now on main. A deleted one was squashed.
      const parents = outcome.keepBranch ? ["-p", "main", "-p", sha] : ["-p", "main"];
      if (outcome.merged) {
        const merge = git(run.root, ...bare, ...id, "commit-tree", tree, ...parents, "-m", `Merge PR #${n}`);
        git(run.root, ...bare, "update-ref", "refs/heads/main", merge);
        Object.assign(pr, { open: false, merged: true, mergeSha: merge, headSha: sha });
      } else {
        Object.assign(pr, { open: false, merged: false, mergeSha: null, headSha: sha });
      }
      if (!outcome.keepBranch) git(run.root, ...bare, "update-ref", "-d", `refs/heads/${BRANCH}`);
    }
    throw refusal(sha, outcome.keepBranch ? "on main" : "gone");
  };
}

const STAGE = "(open-pr|address|pr-review)";
const PUSH = "(?:its push|the PR's head|the PR addresser's fix)";

Given("a run for item {int} that resumes at pr-review", function (_item: number) {
  // open-pr updates the run's open PR 57, which the PR review then reviews.
  const run = setUp(this, "open-pr", true);
  run.prNumber = 57;
});

Given("the run's branch has its PR {int} open", function (n: number) {
  cellPr(this, n);
});

Given("the PR reviewer reports a finding the PR addresser fixes", function () {
  const c = prReviewCtx(this);
  c.newFindingsUpTo = 1;
  newPass(c);
  cellPr(this, 57);
});

Given("the address stage allows {int} retries", function (n: number) {
  cell(this).editSop = (sop: { stages: { id: string; retries?: number }[] }) => {
    const address = sop.stages.find((s) => s.id === "address");
    assert.ok(address, "the SOP has no address stage");
    address.retries = n;
  };
});

Given(new RegExp(`^a person merges PR (\\d+) and deletes its branch while ${STAGE} waits for CI on ${PUSH}$`), function (n: string, stage: string) {
  duringCiWait(this, Number(n), stage, { merged: true, keepBranch: false });
});

Given(new RegExp(`^a person merges PR (\\d+) with a merge commit and keeps its branch while ${STAGE} waits for CI on ${PUSH}$`), function (n: string, stage: string) {
  duringCiWait(this, Number(n), stage, { merged: true, keepBranch: true });
});

Given(new RegExp(`^a person closes PR (\\d+) without merging it and deletes its branch while ${STAGE} waits for CI on ${PUSH}$`), function (n: string, stage: string) {
  duringCiWait(this, Number(n), stage, { merged: false, keepBranch: false });
});

Given("the factory refuses to report CI on address's push because the commit isn't on the run's branch", function () {
  const run = cell(this);
  run.checks = async (sha: string) => {
    if (run.stage === "address") throw refusal(sha, "gone");
    return "success";
  };
});

// ---- the cell's Thens ----

const transitions = (run: CellCtx) => run.calls.filter((x) => x.route === "/transition").map((x) => x.body);

/** The report "that attempt" means: of the stage the last Then read, open-pr by default, as in PBI 142. */
function thatMessage(world: object): string {
  return String(lastAttempt(world, (world as { thatStage?: string }).thatStage ?? "open-pr").message ?? "");
}

const namesPr = (message: string, n: number) => new RegExp(`(#|PR )${n}(?!\\d)`).test(message);
// "closed without being merged" names no merge, so the negated forms are dropped before looking for one.
const saysMerged = (message: string) => /merged/i.test(message.replace(/\b(without|not|never)\s+(a\s+|being\s+|been\s+)?merg\w*|\bunmerged\b/gi, ""));

Then("the cell ends without an error", function () {
  const run = cell(this);
  assert.equal(run.error, null, `the cell failed: ${String(run.error)}`);
});

Then(new RegExp(`^the ${STAGE} stage ran exactly one attempt$`), function (stage: string) {
  const run = cell(this);
  const started = run.calls.filter((x) => x.route === "/stage" && x.body.stageId === stage && x.body.status === "started");
  assert.equal(started.length, 1, `${stage} started ${started.length} attempts`);
  lastAttempt(this, stage);
});

Then("that attempt's message names PR {int} as closed without a merge", function (n: number) {
  const message = thatMessage(this);
  assert.ok(namesPr(message, n), `the message doesn't name PR ${n}: ${message}`);
  assert.match(message, /closed/i, `the message doesn't say the PR closed: ${message}`);
  assert.match(message, /\b(without|not|never)\s+(a\s+|being\s+|been\s+)?merg|\bunmerged\b/i, `the message doesn't say the PR closed without a merge: ${message}`);
});

Then("that attempt's message doesn't name PR {int} as already merged", function (n: number) {
  const message = thatMessage(this);
  assert.ok(!(namesPr(message, n) && saysMerged(message)) && !/already merged/i.test(message), `the message names PR ${n} as merged: ${message}`);
});

Then("that attempt's message says the commit isn't on the run's branch", function () {
  const message = thatMessage(this);
  assert.match(message, /(isn't|is not|not) on/i, `the message doesn't say the commit isn't on the branch: ${message}`);
  assert.ok(message.includes(BRANCH) || /run's branch/.test(message), `the message doesn't name the run's branch: ${message}`);
});

// "the item doesn't move to Failed" is pbi-215.steps.ts's, shared by both features.

Then("the item is still InProgress when the cell ends", function () {
  const run = cell(this);
  assert.equal(run.error, null, `the cell failed: ${String(run.error)}`);
  assert.deepEqual(transitions(run).map((t) => t.event), [], "the cell moved the item out of InProgress");
});

Then("the item's retries aren't reported exhausted", function () {
  assert.ok(!transitions(cell(this)).some((t) => t.event === "retries_exhausted"), "the item's retries were reported exhausted");
});

Then("the address agent was briefed exactly once", function () {
  const briefs = cell(this).agentCalls.filter((a) => a.stage === "address" && a.agent === "factory-pr-addresser");
  assert.equal(briefs.length, 1, `the address agent was briefed ${briefs.length} times`);
});

// ---- the cell API (@db) ----

async function runOf(world: object): Promise<{ id: string; branch: string }> {
  const c = pollCtx(world);
  const r = await need().pool.query<{ id: string; branch: string }>(
    "select r.id, r.branch from run r join item i on i.id = r.item_id where i.source_id = $1 and i.external_id = $2 order by r.run_number desc limit 1",
    [c.sourceId, c.extIds[0]],
  );
  assert.ok(r.rows[0], "the item has no run");
  return r.rows[0];
}

function host(world: object): Host {
  const h = pollCtx(world).host;
  assert.ok(h, "the poller's repo host wasn't set up");
  return h as unknown as Host;
}

Given("commit {string} is on no branch of the run's repo that the run owns", long, async function (sha: string) {
  const h = host(this);
  // On another run's branch, with CI green on it, so only the refusal keeps its status from the cell.
  h.branches.set(`${POLL_REPO}@factory/pbi-999-r1`, [sha]);
  h.checks.set(`${POLL_REPO}@${sha}`, "success");
});

Given("commit {string} is on main and on the run's branch", long, async function (sha: string) {
  const h = host(this);
  const { branch } = await runOf(this);
  for (const b of ["main", branch]) h.branches.set(`${POLL_REPO}@${b}`, [...(h.branches.get(`${POLL_REPO}@${b}`) ?? []), sha]);
  h.checks.set(`${POLL_REPO}@${sha}`, "success");
});

When("the run's cell asks the factory whether CI passed on commit {string}", long, async function (sha: string) {
  const mine = ctx(this);
  const c = pollCtx(this);
  const pool = need().pool;
  const run = await runOf(this);
  // A cell runs only for a run that has its repo.
  await pool.query("update run set repo_id = (select id from repo where url = $2) where id = $1", [run.id, `https://github.com/${POLL_REPO}`]);
  const gen = (await pool.query<{ g: number }>("select i.lease_generation as g from item i join run r on r.item_id = i.id where r.id = $1", [run.id])).rows[0].g;
  if (!mine.server) {
    const handler = cellApi({
      pool, secret: SECRET, repoHost: host(this) as never, backlogFor: () => c.fake!.adapter as never, stageAfter: () => null,
      uploadUrl: async () => "http://127.0.0.1:1/upload", gateway: { upstream: "http://127.0.0.1:1", ownerToken: () => "owner" },
      webToolsOf: () => [],
    });
    mine.server = await startServer([handler], { port: 0 });
  }
  const port = (mine.server.address() as AddressInfo).port;
  const r = await fetch(`http://127.0.0.1:${port}/internal/cells/${run.id}/checks?sha=${encodeURIComponent(sha)}`, {
    headers: { authorization: `Bearer ${runToken(SECRET, run.id, gen)}` },
  });
  const text = await r.text();
  let body: Record<string, unknown>;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  mine.answer = { status: r.status, body };
});

function answer(world: object) {
  const a = ctx(world).answer;
  assert.ok(a, "the cell asked the factory nothing");
  return a;
}

Then("the factory refuses, saying {string} isn't on the run's branch", long, async function (sha: string) {
  const a = answer(this);
  const { branch } = await runOf(this);
  assert.equal(a.status, 400, `the factory answered ${a.status}: ${JSON.stringify(a.body)}`);
  assert.ok(String(a.body.error ?? "").includes(`${sha} isn't on ${branch}`), `the refusal doesn't say ${sha} isn't on ${branch}: ${JSON.stringify(a.body)}`);
});

Then("the factory refuses, saying {string} is on main", function (sha: string) {
  const a = answer(this);
  assert.equal(a.status, 400, `the factory answered ${a.status}: ${JSON.stringify(a.body)}`);
  assert.ok(String(a.body.error ?? "").includes(`${sha} is on main`), `the refusal doesn't say ${sha} is on main: ${JSON.stringify(a.body)}`);
});

Then("the factory gives no CI status for {string}", function (sha: string) {
  const a = answer(this);
  assert.equal(a.body.status, undefined, `the factory gave ${sha} the CI status ${String(a.body.status)}`);
});
