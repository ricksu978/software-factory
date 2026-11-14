// Step definitions for features/pbi-232-ci-failure-detail.feature. Two kinds of scenario:
//
// - The cell API ones run the real cell API on a real port over PBI 4's shared database, as PBI 16's steps do. Behind
//   it sits the real GitHub repo host, githubRepoHost, on a stub GitHub that answers three REST routes by the
//   scenario's checks:
//     GET /repos/{owner}/{repo}/commits/{ref}/check-runs   the commit's check runs, each with an `id`, a `name`, a
//                                                          `status`, a `conclusion` and its URL as `html_url` and `details_url`
//     GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs  a check run's log as text, by the check run's id, which for
//                                                          GitHub Actions is its job's id. 404 when the host can't give it.
//     GET /repos/{owner}/{repo}/compare/{basehead}          so onBranch finds the commit on the run's branch only
//   A failed check is one that completed with a conclusion other than success, neutral or skipped, as checksOnSha
//   already reads it. `GET /checks` answers
//     { "status": "failure", "failedChecks": [{ "name": "unit", "url": "https://…", "log": "<last 100 lines>" }] }
//   with `log` the last 100 lines of the check's log joined by "\n", or null when the repo host couldn't give it.
//   CI that hasn't failed answers an empty `failedChecks`.
//
// - The engine ones run the cell through PBI 18's harness ("the cell runs"), and PBI 128's for the PR review. The fake
//   cell API answers about CI in the same shape as the real one: `api.checks(sha)` resolves to
//   `{ status, failedChecks }`. A stage's finding is what the engine hands the next Green attempt: the list under
//   "## Your last attempt failed" in the first Green brief after that stage's failed attempt.
//
// Log lines are `step <n> of <total> in job <k>`, with the scenario's ending as the last line, so no line holds a check's
// name and no line is part of another.
import { After, Given, Then, When } from "@cucumber/cucumber";
import type { DataTable } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type pg from "pg";
import { load, long, testDb } from "./pbi-8.steps.ts";
import { setUp, type Ctx as CellCtx } from "./pbi-18.steps.ts";
import { ctx as reviewCtx } from "./pbi-128.steps.ts";

const SECRET = "cell-secret";
const REPO = "acme/app";
const SHA = "c1a0f00d5eed";
const KEEP = 100;

// ---- shared: logs ----

type Check = { id: number; name: string; status: string; conclusion: string | null; url: string; log: string | null };

function logLines(total: number, job: number, ending?: string): string[] {
  const lines = Array.from({ length: total }, (_, i) => `step ${i + 1} of ${total} in job ${job}`);
  if (ending !== undefined && total > 0) lines[total - 1] = ending;
  return lines;
}

const asText = (lines: string[]) => lines.join("\n") + "\n";
const lastHundred = (lines: string[]) => lines.slice(-KEEP).join("\n");

// ---- the cell API scenarios ----

type Mods = {
  cellApi: { runToken: (secret: string, runId: string, generation: number) => string; cellApi: (deps: object) => unknown };
  server: { startServer: (handlers: unknown[], opts: { port: number }) => Promise<Server> };
  fake: { fakeBacklog: () => { adapter: unknown; seed(item: { externalId: string }): Promise<string> } };
  github: { githubRepoHost: (app: unknown, installationId: number) => object };
  items: { claimNext: (c: pg.PoolClient, owner: string, now: Date) => Promise<{ runId: string; generation: number } | null> };
  db: { withTx: <T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>) => Promise<T> };
};
type Answer = { status?: string; failedChecks?: { name: string; url: string; log: string | null }[] };
type ApiCtx = {
  server?: Server; runId?: string; token?: string; checks: Check[];
  logs: Map<string, string[]>; code?: number; answer?: Answer; raw?: string;
};

function api(world: object): ApiCtx {
  const w = world as { pbi232api?: ApiCtx };
  w.pbi232api ??= { checks: [], logs: new Map() };
  return w.pbi232api;
}

After(async function () {
  const s = (this as { pbi232api?: ApiCtx }).pbi232api?.server;
  if (s) await new Promise((r) => s.close(r));
});

/** A stub GitHub over the scenario's checks. A route it doesn't serve, or a log it can't give, answers 404. */
function stubGitHub(c: ApiCtx) {
  const notFound = (what: string) => Object.assign(new Error(`404 ${what}`), { status: 404 });
  const request = async (route: string, params: Record<string, any> = {}) => {
    if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
      const runs = params.ref === SHA ? c.checks : [];
      return { data: { total_count: runs.length, check_runs: runs.map((x) => ({
        id: x.id, name: x.name, status: x.status, conclusion: x.conclusion, html_url: x.url, details_url: x.url, head_sha: SHA,
      })) } };
    }
    if (route === "GET /repos/{owner}/{repo}/commits/{ref}/status") return { data: { total_count: 0, statuses: [] } };
    if (route === "GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs") {
      const found = c.checks.find((x) => x.id === Number(params.job_id));
      if (!found || found.log === null) throw notFound(`log of job ${params.job_id}`);
      return { data: found.log };
    }
    if (route === "GET /repos/{owner}/{repo}/compare/{basehead}") {
      const [sha, branch] = String(params.basehead).split("...");
      if (sha !== SHA) throw notFound(`commit ${sha}`);
      return { data: { status: branch === "main" ? "diverged" : "ahead" } };
    }
    throw notFound(route);
  };
  const client = { request, graphql: async () => { throw notFound("graphql"); } };
  return { octokit: { request }, getInstallationOctokit: async () => client };
}

Given("a cell waiting on CI for a commit on its branch", long, async function () {
  const c = api(this);
  const d = await testDb();
  const [cellApi, server, fake, github, items, db] = await Promise.all([
    load<Mods["cellApi"]>("src/control/cell-api.ts"), load<Mods["server"]>("src/http/server.ts"), load<Mods["fake"]>("src/adapters/fake.ts"),
    load<Mods["github"]>("src/adapters/github/repo-host.ts"), load<Mods["items"]>("src/store/items.ts"), load<Mods["db"]>("src/store/db.ts"),
  ]);
  assert.ok(d && cellApi && server && fake && github && items && db, "the cell API's modules or the test database are missing");
  // claimNext takes the oldest queued item, so no other scenario's item may be waiting.
  await d.pool.query("truncate item cascade");
  const source = await d.pool.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'test:' || gen_random_uuid()) returning id");
  await d.pool.query("insert into repo (host_adapter, url, trusted_bot) values ('github', $1, 'factory[bot]') on conflict (url) do nothing", [`https://github.com/${REPO}`]);
  const board = fake.fakeBacklog();
  await board.seed({ externalId: "232" });
  await d.pool.query("insert into item (source_id, external_id, title, state) values ($1, '232', 'CI failure detail', 'Queued')", [source.rows[0].id]);
  const claim = await db.withTx(d.pool, (client) => items.claimNext(client, "cell-a", new Date()));
  assert.ok(claim, "the claim returned nothing");
  await d.pool.query("update run set repo_id = (select id from repo where url = $2), sop_version = 'default@1', config_sha = 'cfg1234' where id = $1",
    [claim.runId, `https://github.com/${REPO}`]);
  c.runId = claim.runId;
  c.token = cellApi.runToken(SECRET, claim.runId, claim.generation);
  const handler = cellApi.cellApi({
    pool: d.pool, secret: SECRET, repoHost: github.githubRepoHost(stubGitHub(c), 1), backlogFor: () => board.adapter,
    stageAfter: () => null, uploadUrl: async (path: string) => `http://blob.test/${path}`,
    gateway: { upstream: "http://127.0.0.1:9", ownerToken: () => "owner-secret" }, webToolsOf: () => [],
  });
  c.server = await server.startServer([handler], { port: 0 });
});

Given("CI on that commit has these checks:", function (table: DataTable) {
  const c = api(this);
  for (const r of table.hashes()) {
    const job = c.checks.length + 1;
    const lines = logLines(Number(r["log lines"]), job);
    c.logs.set(r.check, lines);
    c.checks.push({ id: 9000 + job, name: r.check, status: "completed", conclusion: r.result, url: r.url, log: asText(lines) });
  }
});

Given("CI on that commit has a failed check {string} at {string} whose log the repo host can't give", function (name: string, url: string) {
  const c = api(this);
  c.checks.push({ id: 9000 + c.checks.length + 1, name, status: "completed", conclusion: "failure", url, log: null });
});

Given(/^CI on that commit is (still running|passed on every check)$/, function (state: string) {
  const c = api(this);
  const running = state === "still running";
  for (const [i, name] of ["build", "unit"].entries()) {
    const lines = logLines(10, i + 1);
    c.checks.push({ id: 9001 + i, name, status: running && i === 1 ? "in_progress" : "completed",
      conclusion: running && i === 1 ? null : "success", url: `https://ci.example/runs/0/jobs/${name}`, log: asText(lines) });
  }
});

When("the cell asks the cell API about CI on that commit", long, async function () {
  const c = api(this);
  assert.ok(c.server, "the cell API didn't start");
  const port = (c.server.address() as AddressInfo).port;
  const r = await fetch(`http://127.0.0.1:${port}/internal/cells/${c.runId}/checks?sha=${SHA}`, { headers: { authorization: `Bearer ${c.token}` } });
  c.code = r.status;
  c.raw = await r.text();
  try { c.answer = JSON.parse(c.raw) as Answer; } catch { c.answer = undefined; }
});

function answer(c: ApiCtx): Answer {
  assert.equal(c.code, 200, `the cell API answered ${c.code}: ${c.raw}`);
  assert.ok(c.answer, `the cell API's answer isn't JSON: ${c.raw}`);
  return c.answer;
}

function failed(c: ApiCtx): NonNullable<Answer["failedChecks"]> {
  const a = answer(c);
  assert.ok(Array.isArray(a.failedChecks), `the answer lists no failed checks: ${c.raw}`);
  return a.failedChecks;
}

function failedCheck(c: ApiCtx, name: string) {
  const found = failed(c).find((x) => x.name === name);
  assert.ok(found, `the answer doesn't list the failed check "${name}": ${c.raw}`);
  return found;
}

const logOf = (log: string | null) => (log ?? "").replace(/\n$/, "").split("\n");

Then("the cell API answers that CI failed", function () {
  assert.equal(answer(api(this)).status, "failure");
});

Then("the cell API answers {string}", function (status: string) {
  assert.equal(answer(api(this)).status, status);
});

Then("the answer lists exactly the failed checks {string} and {string}", function (a: string, b: string) {
  assert.deepEqual(failed(api(this)).map((x) => x.name).sort(), [a, b].sort());
});

Then("the answer lists exactly the failed check {string}", function (name: string) {
  assert.deepEqual(failed(api(this)).map((x) => x.name), [name]);
});

Then("the answer lists no failed check", function () {
  assert.deepEqual(failed(api(this)), []);
});

Then("the answer gives {string} the URL {string}", function (name: string, url: string) {
  assert.equal(failedCheck(api(this), name).url, url);
});

Then("the answer gives {string} the last 100 lines of its log, from line {int} to line {int}", function (name: string, from: number, to: number) {
  const c = api(this);
  const lines = c.logs.get(name)!;
  assert.equal(to - from + 1, KEEP);
  assert.deepEqual(logOf(failedCheck(c, name).log), lines.slice(from - 1, to));
});

Then("the answer gives {string} all {int} lines of its log", function (name: string, n: number) {
  const c = api(this);
  const lines = c.logs.get(name)!;
  assert.equal(lines.length, n);
  assert.deepEqual(logOf(failedCheck(c, name).log), lines);
});

Then("the answer says the log of {string} couldn't be read", function (name: string) {
  assert.equal(failedCheck(api(this), name).log, null);
});

// ---- the engine scenarios ----

type FailedCheck = { name: string; url: string; log: string | null; lines: string[] };
type RunCtx = {
  /** The checks that fail on the commit CI fails on, as the cell API answers them. */
  failing: FailedCheck[];
  /** The commits CI answered "failure" about. */
  failedShas: string[];
  /** Every agent call, with the stage it ran in and how many cell API calls came before it. */
  briefs: { stage: string; prompt: string; index: number }[];
  /** Restores fetch after "the cell can't reach GitHub". */
  restore?: () => void;
};

function cell(world: object): CellCtx {
  const w = world as { pbi18?: CellCtx };
  assert.ok(w.pbi18, "no run was set up");
  return w.pbi18;
}

function runCtx(world: object): RunCtx {
  const w = world as { pbi232run?: RunCtx };
  assert.ok(w.pbi232run, "no run was set up");
  return w.pbi232run;
}

After(function () {
  (this as { pbi232run?: RunCtx }).pbi232run?.restore?.();
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** The cell API's answer about CI on `sha`, given whether CI failed on it. */
function ciAnswer(r: RunCtx, sha: string, status: string) {
  if (status === "failure" && !r.failedShas.includes(sha)) r.failedShas.push(sha);
  return {
    status,
    failedChecks: status === "failure" ? r.failing.map((x) => ({ name: x.name, url: x.url, log: x.log })) : [],
  };
}

/**
 * Records every agent call against the cell API calls before it. Without PBI 128's harness, each Green attempt also
 * leaves a commit of its own, so the commit after failed CI is a new one.
 */
function recordBriefs(world: object, r: RunCtx, ownCommits: boolean) {
  const run = cell(world);
  const inner = run.wrapAgent;
  run.wrapAgent = (base) => {
    const next = inner ? inner(base) : base;
    return async (a) => {
      r.briefs.push({ stage: run.stage, prompt: a.prompt, index: run.calls.length });
      const out = await next(a);
      if (ownCommits && run.stage === "green" && !String(a.prompt).startsWith("# Definition of Done")) {
        const n = run.calls.filter((x) => x.route === "/stage" && x.body.stageId === "green" && x.body.status === "started").length;
        writeFileSync(join(a.cwd, "green.txt"), `attempt ${n}\n`);
      }
      return out;
    };
  };
}

function failing(r: RunCtx, name: string, url: string, total: number, ending?: string) {
  const lines = logLines(total, r.failing.length + 1, ending);
  r.failing.push({ name, url, lines, log: lastHundred(lines) });
}

Given("a run that reaches open-pr with a commit CI fails on", function () {
  const run = setUp(this, "red", true);
  const r: RunCtx = { failing: [], failedShas: [], briefs: [] };
  (this as { pbi232run?: RunCtx }).pbi232run = r;
  recordBriefs(this, r, true);
  // The first commit CI is asked about, the PR's head at open-pr, fails. Every later one passes.
  let first: string | null = null;
  run.checks = (async (sha: string) => {
    first ??= sha;
    return ciAnswer(r, sha, sha === first ? "failure" : "success");
  }) as unknown as CellCtx["checks"];
});

Given("CI's check {string} fails on that commit at {string} with a log of {int} lines ending {string}", function (name: string, url: string, n: number, ending: string) {
  failing(runCtx(this), name, url, n, ending);
});

Given("CI passes on the next commit green pushes", function () {
  // The run's CI already passes on every commit after the first.
  runCtx(this);
});

Given("CI's checks {string} at {string} and {string} at {string} fail on that commit", function (a: string, au: string, b: string, bu: string) {
  const r = runCtx(this);
  failing(r, a, au, 20);
  failing(r, b, bu, 20);
});

Given("CI's check {string} passes on that commit", function (_name: string) {
  // A check that passed is no failure, so the cell API's answer leaves it out.
  runCtx(this);
});

Given("CI's check {string} fails on that commit at {string} with a log ending {string}", function (name: string, url: string, ending: string) {
  failing(runCtx(this), name, url, 30, ending);
});

Given("the cell can't reach GitHub", function () {
  const r = runCtx(this);
  const run = cell(this);
  // No GitHub token in the cell's environment, and no request to GitHub gets through.
  run.secrets = { ...(run.secrets ?? {}), GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_TOKEN: process.env.GH_TOKEN };
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (/^https?:\/\/([^/]*\.)?github(usercontent)?\.com(\/|$)/.test(url)) throw new TypeError(`fetch failed: the cell can't reach GitHub (${url})`);
    return real(input, init);
  }) as typeof fetch;
  r.restore = () => { globalThis.fetch = real; };
});

Given("a run whose PR review finds a problem the PR addresser fixes with a new commit", function () {
  const run = setUp(this, "red", true);
  const review = reviewCtx(this);
  review.reviews.set(1, { findings: [{ path: "src/totals.ts", line: 12, body: "This misses the VAT." }], verdicts: new Map(), clean: false });
  review.raisedAt.set("This misses the VAT.", 1);
  review.last = "This misses the VAT.";
  const r: RunCtx = { failing: [], failedShas: [], briefs: [] };
  (this as { pbi232run?: RunCtx }).pbi232run = r;
  recordBriefs(this, r, false);
  const base = run.checks!;
  run.checks = (async (sha: string) => ciAnswer(r, sha, await base(sha))) as unknown as CellCtx["checks"];
});

Given("CI's check {string} fails on the addresser's fix at {string} with a log ending {string}", function (name: string, url: string, ending: string) {
  reviewCtx(this).ci.addresserFirstFails = true;
  failing(runCtx(this), name, url, 30, ending);
});

function ran(world: object): CellCtx {
  const run = cell(world);
  assert.equal(run.error, null, `the cell failed: ${String(run.error)}`);
  return run;
}

/** The index in the cell API calls of the stage's first failed attempt. */
function failedAttempt(world: object, stage: string): number {
  const run = ran(world);
  const i = run.calls.findIndex((x) => x.route === "/stage" && x.body.stageId === stage && x.body.status === "failed");
  assert.ok(i >= 0, `no ${stage} attempt ended failed: ${run.calls.filter((x) => x.route === "/stage" && x.body.stageId === stage).map((x) => x.body.status).join(", ")}`);
  return i;
}

/** The first Green brief after the stage's first failed attempt. */
function nextGreenBrief(world: object, stage: string): string {
  const at = failedAttempt(world, stage);
  const brief = runCtx(world).briefs.find((b) => b.stage === "green" && b.index > at);
  assert.ok(brief, `no Green attempt followed the failed ${stage} attempt`);
  return brief.prompt;
}

/** The stage's finding: the list the next Green brief carries under "## Your last attempt failed". */
function finding(world: object, stage: string): string {
  const brief = nextGreenBrief(world, stage);
  const at = brief.indexOf("## Your last attempt failed");
  assert.ok(at >= 0, `the Green brief after ${stage} carries no finding:\n${brief}`);
  return brief.slice(at);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whether `text` names the check, apart from inside a URL or a longer word. */
const names = (text: string, name: string) => new RegExp(`(?<![\\w/.-])${escape(name)}(?![\\w/-])`).test(text);

function check(world: object, name: string): FailedCheck {
  const found = runCtx(world).failing.find((x) => x.name === name);
  assert.ok(found, `no failing check "${name}" in the scenario`);
  return found;
}

Then(/^the (open-pr|pr-review) stage ends failed$/, function (stage: string) {
  failedAttempt(this, stage);
});

Then(/^(open-pr|pr-review)'s finding names the check "([^"]*)"$/, function (stage: string, name: string) {
  const f = finding(this, stage);
  assert.ok(names(f, name), `${stage}'s finding doesn't name the check "${name}":\n${f}`);
});

Then(/^(open-pr|pr-review)'s finding names the checks "([^"]*)" and "([^"]*)"$/, function (stage: string, a: string, b: string) {
  const f = finding(this, stage);
  for (const name of [a, b]) assert.ok(names(f, name), `${stage}'s finding doesn't name the check "${name}":\n${f}`);
});

Then(/^(open-pr|pr-review)'s finding doesn't name the check "([^"]*)"$/, function (stage: string, name: string) {
  const f = finding(this, stage);
  assert.ok(!names(f, name), `${stage}'s finding names the check "${name}":\n${f}`);
});

Then(/^(open-pr|pr-review)'s finding holds "([^"]*)"$/, function (stage: string, text: string) {
  const f = finding(this, stage);
  assert.ok(f.includes(text), `${stage}'s finding lacks "${text}":\n${f}`);
});

Then(/^(open-pr|pr-review)'s finding holds "([^"]*)" and "([^"]*)"$/, function (stage: string, a: string, b: string) {
  const f = finding(this, stage);
  for (const text of [a, b]) assert.ok(f.includes(text), `${stage}'s finding lacks "${text}":\n${f}`);
});

Then(/^(open-pr|pr-review)'s finding holds the last 100 lines of the log of "([^"]*)", ending "([^"]*)"$/, function (stage: string, name: string, ending: string) {
  const f = finding(this, stage);
  const lines = check(this, name).lines;
  assert.equal(lines.at(-1), ending);
  for (const line of lines.slice(-KEEP)) assert.ok(f.includes(line), `${stage}'s finding lacks the log line "${line}":\n${f}`);
});

Then(/^(open-pr|pr-review)'s finding holds none of the first (\d+) lines of the log of "([^"]*)"$/, function (stage: string, n: string, name: string) {
  const f = finding(this, stage);
  for (const line of check(this, name).lines.slice(0, Number(n))) assert.ok(!f.includes(line), `${stage}'s finding holds the log line "${line}"`);
});

Then(/^(open-pr|pr-review)'s finding holds the log of "([^"]*)", ending "([^"]*)"$/, function (stage: string, name: string, ending: string) {
  const f = finding(this, stage);
  const lines = check(this, name).lines;
  assert.equal(lines.at(-1), ending);
  assert.ok(lines.length <= KEEP, "the scenario's log is longer than the cell API keeps");
  for (const line of lines) assert.ok(f.includes(line), `${stage}'s finding lacks the log line "${line}":\n${f}`);
});

Then("the next green brief holds open-pr's finding", function () {
  const run = ran(this);
  const r = runCtx(this);
  const brief = nextGreenBrief(this, "open-pr");
  const sha = r.failedShas[0];
  assert.ok(sha, "CI never failed");
  assert.ok(brief.includes(`CI failed on ${sha}`), `the next Green brief doesn't name the commit CI failed on, ${sha}:\n${brief}`);
  for (const x of r.failing) {
    assert.ok(names(brief, x.name), `the next Green brief doesn't name the check "${x.name}"`);
    assert.ok(brief.includes(x.url), `the next Green brief lacks ${x.url}`);
    assert.ok(brief.includes(x.lines.at(-1)!), `the next Green brief lacks the end of the log of "${x.name}"`);
  }
  // Green's retry pushed a new commit, which CI passed.
  assert.notEqual(git(run.root, "--git-dir", run.origin, "rev-parse", "factory/pbi-482-r1"), sha, "Green's retry pushed no new commit");
});

Then("the cell asked for no GitHub token while it waited on CI", function () {
  const run = ran(this);
  assert.ok(run.calls.some((x) => x.route === "/checks"), "the cell never waited on CI");
  assert.ok(!run.calls.some((x) => x.route === "/github-token"), "the cell asked for a GitHub token");
});
