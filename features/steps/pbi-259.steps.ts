// Step definitions for features/pbi-259-network-retries.feature.
//
// The cell scenarios run PBI 18's harness (its run, scripted agent and real git repos) with three things of its own,
// all on a clock the test moves, so a wait of minutes takes none:
// - the cell's real HTTP client, httpCellApi, over a fake fetch that is the fake cell API. It answers each call as the
//   cell API would, or with the answer or the connection fault a scenario plans for that call's nth try, and it logs
//   every try with the clock's time.
// - the cell's real git, shellGit, over a command runner that runs real git against the bare origin, except for a
//   push or a fetch a scenario plans to fail, which fails as git does on that fault without running.
// - a clock: `sleep` moves it on at once, and `now` reads it. The client, the git and the engine all get it.
//
// The @db scenarios run the cell API service on PBI 4's shared test database through PBI 222's and PBI 16's steps,
// with the fake repo host behind it made to fail as Octokit does when GitHub answers 5xx or can't be reached.
//
// "The green attempt" is the run's stage attempt that made the call: a run at green asks for checks at open-pr, so
// "isn't failed" means no attempt failed and the run went through, and "ends failed" means its last attempt failed.
import { After, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { httpCellApi } from "../../src/cell/api-client.ts";
import type { GitExec } from "../../src/cell/git.ts";
import { runTheCell, setUp, type Ctx as Pbi18 } from "./pbi-18.steps.ts";
import { ctx as p16ctx } from "./pbi-16.steps.ts";
import { ctx as p222ctx, deps as p222deps } from "./pbi-222.steps.ts";
import { long, need } from "./pbi-8.steps.ts";

const run = promisify(execFile);
const BRANCH = "factory/pbi-482-r1";
const START = Date.parse("2026-11-14T10:00:00Z");
const NETWORK = /network or GitHub error/i;

type Answer = { status: number; body?: unknown } | { fault: "refused" | "reset" | "timeout" };
type Plan = { tries: (Answer | null)[]; every?: Answer; forMs?: { ms: number; answer: Answer } };
type Try = { call: string; at: number; seq: number; url: string; body: string; status: number | null };
type GitFault = "resolve" | "refused" | "reset" | "proxy502" | "proxy503" | "proxy504" | "timeout" | "rejected";
type GitPlan = { tries: (GitFault | null)[]; every?: GitFault };
type GitTry = { op: "push" | "fetch"; at: number; seq: number; ok: boolean };

type Ctx = {
  /** The clock, in milliseconds. */
  t: number;
  seq: number;
  plans: Map<string, Plan>;
  /** The call the last plan was for, which "answers ... after that" and "... the second time" add to. */
  planned?: string;
  tries: Try[];
  /** The time of each call's first try, for a plan that fails for a while. */
  firstAt: Map<string, number>;
  git: Map<"push" | "fetch", GitPlan>;
  gitPlanned?: "push" | "fetch";
  gitTries: GitTry[];
  /** The call or the git command a scenario keeps failing, whose tries the attempt's message counts. */
  failing?: string;
  baseHead?: string;
  pbi18?: Pbi18;
  // ---- @db ----
  db?: {
    server?: { server: import("node:http").Server; stop(): Promise<void> };
    sha?: string;
    /** GitHub's fault for every question, and for the first question about checks only. */
    every?: unknown;
    firstChecks?: number;
    checksAsked: number;
    statuses: number[];
    bodies: string[];
    result?: unknown;
    error?: unknown;
  };
};

export function isPbi259(world: object): boolean {
  return (world as { pbi259?: Ctx }).pbi259 !== undefined;
}

function ctx(world: object): Ctx {
  const w = world as { pbi259?: Ctx };
  w.pbi259 ??= { t: START, seq: 0, plans: new Map(), tries: [], firstAt: new Map(), git: new Map(), gitTries: [] };
  return w.pbi259;
}

function cell(world: object): Pbi18 {
  const c = (world as { pbi18?: Pbi18 }).pbi18;
  assert.ok(c, "no run was set up");
  return c;
}

const clock = (c: Ctx) => ({
  now: () => new Date(c.t),
  sleep: async (ms: number) => {
    c.t += Math.max(0, ms);
    await new Promise((r) => setImmediate(r));
  },
});

After(async function () {
  const c = (this as { pbi259?: Ctx }).pbi259;
  await c?.db?.server?.stop();
});

// ---- the fake cell API, as the cell's fetch ----

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The error undici's fetch rejects with on each connection fault. */
function connectionFault(fault: "refused" | "reset" | "timeout"): Error {
  if (fault === "timeout") return new DOMException("The operation was aborted due to timeout", "TimeoutError") as unknown as Error;
  const cause = fault === "refused"
    ? Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:7401"), { code: "ECONNREFUSED", errno: -111, syscall: "connect" })
    : Object.assign(new Error("other side closed"), { name: "SocketError", code: "UND_ERR_SOCKET" });
  return new TypeError("fetch failed", { cause });
}

function answerFor(c: Ctx, call: string, n: number): Answer | null {
  const p = c.plans.get(call);
  if (!p) return null;
  if (p.forMs) return c.t - c.firstAt.get(call)! < p.forMs.ms ? p.forMs.answer : null;
  if (n < p.tries.length) return p.tries[n];
  return p.every ?? null;
}

function fakeCellApi(c: Ctx, cellCtx: Pbi18): typeof fetch {
  const record = (route: string, body: Record<string, any> = {}) => cellCtx.calls.push({ route, body });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const raw = typeof init?.body === "string" ? init.body : "";
    if (url.pathname.startsWith("/blob/")) return new Response(null, { status: 201 });
    const route = "/" + url.pathname.split("/").at(-1);
    const call = `${method} ${route}`;
    const n = c.tries.filter((x) => x.call === call).length;
    if (!c.firstAt.has(call)) c.firstAt.set(call, c.t);
    const t: Try = { call, at: c.t, seq: c.seq++, url: url.pathname + url.search, body: raw, status: null };
    c.tries.push(t);
    const planned = answerFor(c, call, n);
    if (planned && "fault" in planned) throw connectionFault(planned.fault);
    if (planned) {
      t.status = planned.status;
      return json(planned.status, planned.body ?? { error: `the fake cell API answers ${planned.status}` });
    }
    t.status = 200;
    const body = raw ? JSON.parse(raw) : {};
    switch (call) {
      case "GET /context": return json(200, { externalId: "482", nextStage: "green", branch: BRANCH, repo: "acme/app", base: "main" });
      case "POST /github-token": return json(200, { token: "ghs_fake", expiresAt: new Date(c.t + 3_600_000).toISOString() });
      case "POST /lease": record("/lease"); return json(200, { ok: true, stop: false });
      case "POST /stage": record("/stage", body); if (body.status === "started") cellCtx.stage = body.stageId; return json(200, { ok: true });
      case "POST /transition": record("/transition", body); return json(200, { ok: true });
      case "POST /policy-results": record("/policy-results", body); return json(200, { ok: true });
      case "POST /pr": record("/pr", body); return json(200, { ok: true });
      case "GET /checks": record("/checks", { sha: url.searchParams.get("sha") }); return json(200, { status: "success" });
      case "GET /ci-checks": record("/ci-checks", { sha: url.searchParams.get("sha") }); return json(200, { checks: null });
      case "POST /upload-url":
        record("/upload-url", { kind: body.kind, stageId: body.stageId, attempt: body.attempt });
        return json(200, { url: `http://blob.test/blob/${body.stageId}-${body.attempt}.${body.kind}` });
      default: return json(404, { error: `no route ${call}` });
    }
  }) as typeof fetch;
}

// ---- the cell's git, failing as git does ----

function gitError(args: string[], fault: GitFault): Error {
  const remote = "https://github.com/acme/app.git/";
  const stderr: Record<GitFault, string> = {
    resolve: `fatal: unable to access '${remote}': Could not resolve host: github.com`,
    refused: `fatal: unable to access '${remote}': Failed to connect to github.com port 443 after 3 ms: Couldn't connect to server`,
    reset: `error: RPC failed; curl 56 Recv failure: Connection reset by peer\nfatal: the remote end hung up unexpectedly`,
    proxy502: `fatal: unable to access '${remote}': CONNECT tunnel failed, response 502`,
    proxy503: `error: RPC failed; HTTP 503 curl 22 The requested URL returned error: 503\nfatal: the remote end hung up unexpectedly`,
    proxy504: `error: RPC failed; HTTP 504 curl 22 The requested URL returned error: 504\nfatal: the remote end hung up unexpectedly`,
    timeout: "",
    rejected: ` ! [rejected]        HEAD -> ${BRANCH} (fetch first)\nerror: failed to push some refs to '${remote}'\nhint: Updates were rejected because the remote contains work that you do not\nhint: have locally.`,
  };
  const cmd = `git ${args.join(" ")}`;
  // execFile's error for a command its timeout killed: no exit code, the signal, and `killed`.
  if (fault === "timeout") return Object.assign(new Error(`Command failed: ${cmd}\n`), { code: null, killed: true, signal: "SIGTERM", cmd, stdout: "", stderr: "" });
  return Object.assign(new Error(`Command failed: ${cmd}\n${stderr[fault]}`), {
    code: fault === "rejected" ? 1 : 128, killed: false, signal: null, cmd, stdout: "", stderr: stderr[fault],
  });
}

function fakeGitExec(c: Ctx): GitExec {
  return async (args, opts) => {
    const op = args[0] === "push" ? "push" : args[0] === "fetch" && args.includes("main") ? "fetch" : null;
    if (op) {
      const n = c.gitTries.filter((x) => x.op === op).length;
      const p = c.git.get(op);
      const fault = p ? (n < p.tries.length ? p.tries[n] : p.every ?? null) : null;
      const t: GitTry = { op, at: c.t, seq: c.seq++, ok: !fault };
      c.gitTries.push(t);
      if (fault) throw gitError(args, fault);
    }
    return run("git", args, { cwd: opts.cwd, maxBuffer: 64 * 1024 * 1024 });
  };
}

const gitOf = (phrase: string): GitFault => {
  const faults: Record<string, GitFault> = {
    "GitHub's host name can't be resolved": "resolve",
    "the connection to GitHub is refused": "refused",
    "the connection to GitHub is reset": "reset",
    "the proxy answers 502": "proxy502",
    "the proxy answers 503": "proxy503",
    "the proxy answers 504": "proxy504",
    "the push doesn't finish within its limit": "timeout",
    "the fetch doesn't finish within its limit": "timeout",
  };
  const f = faults[phrase];
  assert.ok(f, `no git fault "${phrase}"`);
  return f;
};

// ---- Given: the run ----

Given("a run for item {int} at green", function (_item: number) {
  const r = setUp(this, "green", true);
  const c = ctx(this);
  c.pbi18 = r;
  // The run's PR is open, so Green's Definition of Done check asks the cell API for the CI checks a line names.
  r.prNumber = 7;
  r.dod = "- [ ] Typecheck passes. `run: true` `ci: ci`\n";
  // The base moves on, so the merge at the start of the claim has something to fetch and merge.
  const seed = join(r.root, "seed");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: seed, encoding: "utf8" }).trim();
  git("checkout", "-q", "main");
  writeFileSync(join(seed, "base.txt"), "a later commit on the base\n");
  git("add", "-A");
  git("commit", "-q", "-m", "the base moves on");
  git("push", "-q", "origin", "main");
  c.baseHead = git("rev-parse", "HEAD");

  const time = clock(c);
  const api = httpCellApi({ controlUrl: "http://cell-api.test", runId: "run-482", runToken: "run-token", generation: 1 },
    { fetch: fakeCellApi(c, r), ...time });
  r.api = api;
  r.gitDeps = { exec: fakeGitExec(c), ...time };
  r.now = time.now;
  r.sleep = time.sleep;
  // As src/cell/main.ts does, the cell asks for its context, and its git's credential helper asks for a token.
  r.prelude = async () => {
    await api.context();
    await api.githubToken();
  };
});

// ---- Given: the cell API's answers ----

function plan(c: Ctx, call: string, p: Plan): void {
  c.plans.set(call, p);
  c.planned = call;
}

function planned(c: Ctx): Plan {
  assert.ok(c.planned, "no answer was planned before this one");
  return c.plans.get(c.planned)!;
}

Given("the cell API answers {int} the first time the cell asks for checks on its commit", function (status: number) {
  plan(ctx(this), "GET /checks", { tries: [{ status }] });
});

Given("answers normally after that", function () {
  const c = ctx(this);
  // In a @db scenario, it's GitHub that answers normally after its first failure.
  if (c.db) {
    assert.ok(c.db.firstChecks !== undefined, "no GitHub failure was planned before this one");
    return;
  }
  const p = planned(c);
  p.every = undefined;
});

Given("the cell API answers normally after that", function () {
  planned(ctx(this)).every = undefined;
});

Given(/^the cell's connection to the cell API (is refused|is reset before the answer arrives|gets no answer within the cell's time limit) the first time the cell asks for checks on its commit$/, function (fault: string) {
  const f = fault === "is refused" ? "refused" : fault.startsWith("is reset") ? "reset" : "timeout";
  plan(ctx(this), "GET /checks", { tries: [{ fault: f }] });
});

Given("the cell's connection to the cell API is refused every time the cell asks for checks on its commit", function () {
  const c = ctx(this);
  plan(c, "GET /checks", { tries: [], every: { fault: "refused" } });
  c.failing = "GET /checks";
});

Given("the cell API answers {int} the first two times the cell makes the call {string}", function (status: number, call: string) {
  plan(ctx(this), call, { tries: [{ status }, { status }] });
});

Given("the cell API answers {int} to every ask for checks on the cell's commit for the next {int} seconds", function (status: number, s: number) {
  plan(ctx(this), "GET /checks", { tries: [], forMs: { ms: s * 1000, answer: { status } } });
});

Given("the cell API answers {int} to every ask for checks on the cell's commit", function (status: number) {
  const c = ctx(this);
  plan(c, "GET /checks", { tries: [], every: { status } });
  c.failing = "GET /checks";
});

Given("answers 400, saying the commit isn't on the run's branch, the second time", function () {
  // The cell API's own words for it, from GET /checks.
  planned(ctx(this)).tries[1] = { status: 400, body: { error: `the commit isn't on ${BRANCH}` } };
});

Given("answers {int} the second time", function (status: number) {
  planned(ctx(this)).tries[1] = { status, body: { error: `the fake cell API answers ${status}` } };
});

Given("answers 409 the second time, because the run's lease generation moved on", function () {
  planned(ctx(this)).tries[1] = { status: 409, body: { error: "this run's lease generation has moved on" } };
});

// ---- Given: git ----

Given(/^the cell's first git (push|fetch of the base) fails because (.+)$/, function (what: string, phrase: string) {
  const c = ctx(this);
  const op = what === "push" ? "push" : "fetch";
  c.git.set(op, { tries: [gitOf(phrase)] });
  c.gitPlanned = op;
});

Given(/^git (push|fetch) goes through after that$/, function (op: "push" | "fetch") {
  const p = ctx(this).git.get(op);
  assert.ok(p, `no git ${op} failure was planned before this one`);
  p.every = undefined;
});

Given(/^every git (push|fetch of the base) the cell runs fails because (.+)$/, function (what: string, phrase: string) {
  const c = ctx(this);
  const op = what === "push" ? "push" : "fetch";
  c.git.set(op, { tries: [], every: gitOf(phrase) });
  c.gitPlanned = op;
  c.failing = `git ${op}`;
});

Given("its second git push is rejected because the run's branch moved on", function () {
  const p = ctx(this).git.get("push");
  assert.ok(p, "no git push failure was planned before this one");
  p.tries[1] = "rejected";
});

// ---- When ----

When("the cell runs as far as that call", { timeout: 60_000 }, async function () {
  await runTheCell(this);
});

// ---- Then: what the cell asked ----

const tries = (c: Ctx, call: string) => c.tries.filter((x) => x.call === call);
const normal = (t: Try) => t.status !== null && t.status < 400;

/** The tries of a call's first ask, up to and including the one the cell API answered normally. */
function firstAsk(c: Ctx, call: string): Try[] {
  const all = tries(c, call);
  const ok = all.findIndex(normal);
  assert.ok(ok >= 0, `the cell API never answered ${call} normally; the cell tried it ${all.length} times`);
  return all.slice(0, ok + 1);
}

function finished(world: object): Pbi18 {
  return cell(world);
}

function stageReports(r: Pbi18, status?: string): Record<string, any>[] {
  return r.calls.filter((x) => x.route === "/stage" && (status === undefined || x.body.status === status)).map((x) => x.body);
}

function lastFailed(world: object): Record<string, any> {
  const f = stageReports(cell(world), "failed").at(-1);
  assert.ok(f, `no attempt ended failed; the cell ended ${cell(world).result ?? `with ${String(cell(world).error)}`}`);
  return f;
}

const messageOf = (world: object) => String(lastFailed(world).message ?? "");

Then("the cell asked for checks on that commit twice", function () {
  assert.equal(firstAsk(ctx(this), "GET /checks").length, 2);
});

Then("the cell asked for checks on that commit exactly twice", function () {
  assert.equal(tries(ctx(this), "GET /checks").length, 2);
});

Then("the cell asked for checks on that commit at least {int} times", function (n: number) {
  const all = tries(ctx(this), "GET /checks").length;
  assert.ok(all >= n, `the cell asked ${all} times`);
});

Then("the cell waited before asking again", function () {
  const [a, b] = tries(ctx(this), "GET /checks");
  assert.ok(b, "the cell didn't ask again");
  assert.ok(b.at > a.at, "the cell asked again at once, without waiting");
});

Then("the cell waited before each ask after the first", function () {
  const all = tries(ctx(this), "GET /checks");
  assert.ok(all.length > 1, "the cell didn't ask again");
  for (let i = 1; i < all.length; i++) assert.ok(all[i].at > all[i - 1].at, `ask ${i + 1} came at once after ask ${i}`);
});

Then("the last ask came at least {int} minutes after the first", function (m: number) {
  const all = tries(ctx(this), "GET /checks");
  const gap = all.at(-1)!.at - all[0].at;
  assert.ok(gap >= m * 60_000, `the last ask came ${gap / 1000}s after the first`);
});

Then("the cell asked again for checks until the cell API answered normally", function () {
  const c = ctx(this);
  const ask = firstAsk(c, "GET /checks");
  assert.ok(ask.length > 1, "the cell didn't ask again");
  assert.ok(ask.at(-1)!.at - ask[0].at >= 90_000, "the cell API answered normally before the outage was over");
  assert.equal(tries(c, "GET /checks").length, ask.length, "the cell asked again after a normal answer");
});

Then("the cell made the call {string} three times", function (call: string) {
  assert.equal(firstAsk(ctx(this), call).length, 3, `tries of ${call}: ${tries(ctx(this), call).map((t) => t.status ?? "fault").join(", ")}`);
});

Then("each of the three tries sent the same request", function () {
  const c = ctx(this);
  const three = tries(c, c.planned!).slice(0, 3);
  assert.equal(three.length, 3, `the cell tried ${c.planned} ${three.length} times`);
  for (const t of three.slice(1)) assert.deepEqual({ url: t.url, body: t.body }, { url: three[0].url, body: three[0].body });
});

Then("the cell carried on past that call", function () {
  const r = cell(this);
  assert.equal(r.error, null, `the cell failed: ${String(r.error)}`);
  assert.equal(r.result, "done");
});

// ---- Then: the attempt ----

Then(/^the green attempt is not failed by (that answer|that fault|that push|that fetch|those answers)$/, function (_what: string) {
  const r = finished(this);
  assert.equal(r.error, null, `the cell failed: ${String(r.error)}`);
  assert.deepEqual(stageReports(r, "failed").map((x) => `${x.stageId}-${x.attempt}: ${x.message ?? ""}`), [], "an attempt ended failed");
  assert.equal(r.result, "done");
});

Then("the attempt's message says nothing about a network or GitHub error", function () {
  for (const s of stageReports(cell(this))) assert.doesNotMatch(String(s.message ?? ""), NETWORK);
});

Then("only then did the green attempt end failed", function () {
  const c = ctx(this);
  const r = cell(this);
  lastFailed(this);
  // The failed report is the last /stage call; it must come after the last try of the call that kept failing.
  const reports = c.tries.filter((t) => t.call === "POST /stage" && normal(t));
  const last = Math.max(...c.tries.filter((t) => t.call === "GET /checks").map((t) => t.seq), ...c.gitTries.map((t) => t.seq));
  assert.ok(reports.length && reports.at(-1)!.seq > last, "the attempt ended failed before the cell's last try");
  assert.equal(stageReports(r).at(-1)!.status, "failed");
});

Then("the green attempt ends failed", function () {
  assert.equal(stageReports(cell(this)).at(-1)?.status, "failed", "the cell's last attempt didn't end failed");
  lastFailed(this);
});

Then("the green attempt ends failed, as an attempt ends on any other error today", function () {
  const r = cell(this);
  assert.equal(stageReports(r).at(-1)?.status, "failed", "the cell's last attempt didn't end failed");
  assert.notEqual(r.result, "stopped", "the cell stopped instead");
  assert.notEqual(r.result, "done", "the run went through");
});

Then("the attempt's message names the call for checks", function () {
  assert.match(messageOf(this), /GET \/checks/);
});

Then("the attempt's message names git push", function () {
  assert.match(messageOf(this), /git push/);
});

Then("the attempt's message names git fetch", function () {
  assert.match(messageOf(this), /git fetch/);
});

Then("the attempt's message says it failed on a network or GitHub error after the number of tries the cell made", function () {
  const c = ctx(this);
  assert.ok(c.failing, "the scenario planned no call that keeps failing");
  const n = c.failing.startsWith("git ")
    ? c.gitTries.filter((t) => `git ${t.op}` === c.failing).length
    : tries(c, c.failing).length;
  const m = messageOf(this);
  assert.match(m, NETWORK);
  assert.match(m, new RegExp(`after ${n} tries`), `the cell tried ${n} times; the message is: ${m}`);
});

Then("the attempt's message says the push was rejected", function () {
  assert.match(messageOf(this), /rejected/);
});

Then("the attempt's message doesn't say it failed on a network or GitHub error", function () {
  assert.doesNotMatch(messageOf(this), NETWORK);
});

Then("the attempt's message says the commit isn't on the run's branch", function () {
  assert.match(messageOf(this), new RegExp(`isn't on ${BRANCH}`));
});

// "the cell ends stopped" is PBI 18's "the cell ends {word}".

Then("the cell pushes nothing more and makes no further call", function () {
  const c = ctx(this);
  const fenced = tries(c, "GET /checks").at(-1);
  assert.equal(fenced?.status, 409, "the cell's last ask for checks didn't get the 409");
  const later = [...c.tries.filter((t) => t.seq > fenced.seq).map((t) => t.call), ...c.gitTries.filter((t) => t.seq > fenced.seq).map((t) => `git ${t.op}`)];
  assert.deepEqual(later, [], "the cell went on after the 409");
});

/** PBI 152's "the owner is asked no question", in this feature: no transition carries a question. */
export function ownerAskedNoQuestion(world: object): void {
  const asked = cell(world).calls.filter((x) => x.route === "/transition" && x.body.question);
  assert.deepEqual(asked.map((x) => x.body.question.body), [], "the owner was asked a question");
}

/** PBI 194's "the cell reports no move for the item", in this feature: the cell sent no transition. */
export function reportsNoMove(world: object): void {
  const moves = cell(world).calls.filter((x) => x.route === "/transition").map((x) => x.body.event);
  assert.deepEqual(moves, [], "the cell reported a move for the item");
}

// ---- Then: git ----

const gitTries = (c: Ctx, op: "push" | "fetch") => c.gitTries.filter((t) => t.op === op);

function firstGit(c: Ctx, op: "push" | "fetch"): GitTry[] {
  const all = gitTries(c, op);
  const ok = all.findIndex((t) => t.ok);
  assert.ok(ok >= 0, `git ${op} never went through; the cell ran it ${all.length} times`);
  return all.slice(0, ok + 1);
}

Then("the cell ran git push twice", function () {
  assert.equal(firstGit(ctx(this), "push").length, 2);
});

Then("the cell ran git fetch of the base twice", function () {
  assert.equal(firstGit(ctx(this), "fetch").length, 2);
});

Then("the cell ran git push exactly twice", function () {
  assert.equal(gitTries(ctx(this), "push").length, 2);
});

Then(/^the cell ran git (push|fetch of the base) at least (\d+) times$/, function (what: string, n: string) {
  const op = what === "push" ? "push" : "fetch";
  const all = gitTries(ctx(this), op).length;
  assert.ok(all >= Number(n), `the cell ran git ${op} ${all} times`);
});

Then(/^the cell waited before (pushing|fetching) again$/, function (what: string) {
  const [a, b] = gitTries(ctx(this), what === "pushing" ? "push" : "fetch");
  assert.ok(b, "the cell didn't try again");
  assert.ok(b.at > a.at, "the cell tried again at once, without waiting");
});

Then(/^the last (push|fetch) came at least (\d+) minutes after the first$/, function (op: "push" | "fetch", m: string) {
  const all = gitTries(ctx(this), op);
  const gap = all.at(-1)!.at - all[0].at;
  assert.ok(gap >= Number(m) * 60_000, `the last ${op} came ${gap / 1000}s after the first`);
});

Then("the run's branch holds the cell's commit", function () {
  const r = cell(this);
  const log = execFileSync("git", ["log", "--format=%s", BRANCH], { cwd: r.origin, encoding: "utf8" });
  assert.match(log, /^green\(@pbi-482\): implementation$/m, "the run's branch on the origin lacks green's commit");
});

Then("the base was merged into the run's branch", function () {
  const r = cell(this);
  const c = ctx(this);
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", c.baseHead!, BRANCH], { cwd: r.origin });
  } catch {
    assert.fail("the run's branch on the origin doesn't hold the base's head");
  }
});

// ---- @db: the cell API in front of a failing GitHub ----

const REPO = "ricksu978/software-factory";

function db(world: object): NonNullable<Ctx["db"]> {
  const c = ctx(world);
  c.db ??= { checksAsked: 0, statuses: [], bodies: [] };
  return c.db;
}

/** The error Octokit throws when GitHub answers `status`: a RequestError, named HttpError, with the status. */
function githubAnswers(status: number): Error {
  return Object.assign(new Error(status >= 500 ? "Server Error" : `GitHub answered ${status}`), { name: "HttpError", status });
}

/** The error Octokit throws when fetch to GitHub fails: a RequestError with status 500, its cause the fetch's error. */
function githubUnreachable(fault: "refused" | "reset" | "timeout"): Error {
  const cause = fault === "refused"
    ? new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 140.82.112.6:443"), { code: "ECONNREFUSED" }) })
    : fault === "reset"
      ? new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) })
      : new DOMException("The operation was aborted due to timeout", "TimeoutError");
  const message = fault === "timeout" ? "The operation was aborted due to timeout" : (cause as TypeError & { cause: Error }).cause.message;
  return Object.assign(new Error(message), { name: "HttpError", status: 500, cause });
}

// Every question the cell API asks GitHub through the repo host fails as planned. The fake repo host is PBI 222's.
function failGitHub(world: object): void {
  const d = db(world);
  const host = (p222ctx(world).repoHost ??= p222deps(world).repoHost) as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(host)) {
    if (typeof v !== "function" || (v as { pbi259?: boolean }).pbi259) continue;
    const wrapped = async (...args: unknown[]) => {
      if (k === "checksOnSha" && d.firstChecks !== undefined && d.checksAsked++ === 0) throw githubAnswers(d.firstChecks);
      if (d.every) throw d.every;
      return (v as (...a: unknown[]) => unknown).apply(host, args);
    };
    host[k] = Object.assign(wrapped, { pbi259: true });
  }
}

Given("item {string}'s run has open PR {int} and a commit on its branch", long, async function (_name: string, pr: number) {
  const d = db(this);
  const first = p16ctx(this).first;
  assert.ok(first, "no run was claimed");
  // At address, so GET /context reads the PR's review comments from GitHub.
  await need().pool.query("update run set pr_number = $2, next_stage = 'address' where id = $1", [first.runId, pr]);
  const row = (await need().pool.query<{ branch: string | null; run_number: number; external_id: string }>(
    "select r.branch, r.run_number, i.external_id from run r join item i on i.id = r.item_id where r.id = $1", [first.runId])).rows[0];
  const branch = row.branch ?? `factory/pbi-${row.external_id}-r${row.run_number}`;
  const host = p222ctx(this).repoHost ??= p222deps(this).repoHost;
  d.sha = "5c3a1f0e9d8b7a6c5d4e3f2a1b0c9d8e7f6a5b4c";
  host.branches.set(`${REPO}@${branch}`, [d.sha]);
  host.checks.set(`${REPO}@${d.sha}`, "success");
  host.ciChecks.set(`${REPO}@${d.sha}`, [{ name: "ci", conclusion: "success", url: "https://github.com/checks/1" }]);
  host.prs.push({
    number: pr, repo: REPO, branch, base: "main", title: "Cell API", body: "", headSha: d.sha, open: true, merged: false,
    mergeSha: null, mergeable: true, reviewers: [], comments: [], reviews: [],
  });
});

Given("GitHub answers {int} to every question the cell API asks it", function (status: number) {
  db(this).every = githubAnswers(status);
  failGitHub(this);
});

Given(/^the cell API's connection to GitHub (is refused|is reset|gets no answer within the cell API's time limit)$/, function (fault: string) {
  db(this).every = githubUnreachable(fault === "is refused" ? "refused" : fault === "is reset" ? "reset" : "timeout");
  failGitHub(this);
});

Given("GitHub answers {int} to the cell API's first question about checks on that commit", function (status: number) {
  db(this).firstChecks = status;
  failGitHub(this);
});

async function serving(world: object): Promise<string> {
  const d = db(world);
  if (!d.server) {
    const mod = (await import("../../src/cell-api/main.ts")) as { serveCellApi: (deps: any, port: number) => Promise<NonNullable<typeof d.server>> };
    d.server = await mod.serveCellApi(p222deps(world), 0);
    // PBI 16's Thens check the cell API they read answers is up.
    p16ctx(world).server = d.server.server;
  }
  return `http://127.0.0.1:${(d.server.server.address() as import("node:net").AddressInfo).port}`;
}

When("the cell makes the call {string} with its token", long, async function (call: string) {
  const d = db(this);
  const first = p16ctx(this).first;
  assert.ok(first, "no run was claimed");
  const paths: Record<string, [string, string, unknown?]> = {
    "GET /checks": ["GET", `/checks?sha=${d.sha}`],
    "GET /ci-checks": ["GET", `/ci-checks?sha=${d.sha}`],
    "POST /github-token": ["POST", "/github-token", {}],
    "GET /context": ["GET", "/context"],
  };
  const found = paths[call];
  assert.ok(found, `unknown call ${call}`);
  const [method, path, body] = found;
  const base = await serving(this);
  const r = await fetch(`${base}/internal/cells/${first.runId}${path}`, {
    method,
    headers: { authorization: `Bearer ${first.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  d.bodies.push(await r.text());
  d.statuses.push(r.status);
  p16ctx(this).statuses.push(r.status);
});

When("the cell asks the cell API for checks on that commit", long, async function () {
  const c = ctx(this);
  const d = db(this);
  const first = p16ctx(this).first;
  assert.ok(first, "no run was claimed");
  const base = await serving(this);
  const watched: typeof fetch = async (input, init) => {
    const r = await fetch(input, init);
    d.statuses.push(r.status);
    return r;
  };
  const api = httpCellApi({ controlUrl: base, runId: first.runId, runToken: first.token, generation: first.generation }, { fetch: watched, ...clock(c) });
  try {
    d.result = await api.checks(d.sha!);
  } catch (e) {
    d.error = e;
  }
});

Then("the answer says GitHub failed", function () {
  const body = db(this).bodies.at(-1) ?? "";
  assert.match(body, /GitHub/, `the answer was: ${body}`);
});

Then("the cell API's first answer was {int}", function (status: number) {
  assert.equal(db(this).statuses[0], status, `answers: ${db(this).statuses.join(", ")}`);
});

Then("the cell asked again", function () {
  const d = db(this);
  assert.ok(d.statuses.length >= 2, `the cell asked ${d.statuses.length} time(s): ${String(d.error ?? "")}`);
});

Then("the cell got the commit's checks", function () {
  const d = db(this);
  assert.equal(d.error, undefined, `the cell's ask failed: ${String(d.error)}`);
  assert.equal((d.result as { status?: unknown } | undefined)?.status, "success");
});
