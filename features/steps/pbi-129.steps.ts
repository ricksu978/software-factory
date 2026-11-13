// Step definitions for features/pbi-129-pr-review-groundwork.feature.
//
// The PR reviewer's scenarios read cell/claude/agents/factory-pr-reviewer.md, as the cell image ships it, and set up a
// cell run through agentOptions the way features/steps/pbi-96.steps.ts does, to work out which definition the run gets.
//
// The repo host's scenarios drive githubRepoHost over a recording GitHub client, and fakeRepoHost directly. Each call
// on the repo host is caught and kept, so a call that fails shows on the Then that reads its outcome. The shapes the
// steps rely on:
//   - `RepoHost.postReview({ repo, prNumber, commitSha, body, comments: [{ path, line, body }] })`. On GitHub it sends
//     `POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews` with `commit_id`, `body`, `comments` and `event`.
//   - `RepoHost.resolveThread(repo, threadId)`. On GitHub it sends the `resolveReviewThread` GraphQL mutation, with the
//     thread id among its variables.
//   - The fake records `postedReviews: { repo, prNumber, commitSha, body, comments, event }[]` in the order they were
//     posted, and `resolvedThreads: { repo, threadId }[]`, one entry for each thread it resolves.
import { After, Given, Then, When, type DataTable } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { fakeRepoHost } from "../../src/adapters/fake.ts";
import { githubRepoHost, type AppLike, type GitHubClient } from "../../src/adapters/github/repo-host.ts";
import type { ReviewComment } from "../../src/adapters/types.ts";
import { agentOptions, type AgentArgs } from "../../src/agent/run.ts";

const repoRoot = process.cwd();
const AGENTS_DIR = join(repoRoot, "cell/claude/agents");
const PR_REVIEWER = "factory-pr-reviewer";

// ---------------------------------------------------------------------------------------------------------------------
// Agent definitions

type Def = { name: string; description: string; prompt: string; tools: string[] | null; disallowed: string[] };

const list = (v: unknown): string[] | null =>
  v === undefined || v === null ? null : Array.isArray(v) ? v.map(String) : String(v).split(",").map((s) => s.trim()).filter(Boolean);

function parseFile(text: string): Def {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  assert.ok(m, "an agent file without front matter");
  const fm = (parse(m[1]) ?? {}) as Record<string, unknown>;
  return { name: String(fm.name ?? ""), description: String(fm.description ?? ""), prompt: m[2].trim(),
    tools: list(fm.tools), disallowed: list(fm.disallowedTools) ?? [] };
}

/** The factory's own definition of the named agent, or null when the repo ships none. */
function factoryDef(name: string): Def | null {
  const f = join(AGENTS_DIR, `${name}.md`);
  return existsSync(f) ? parseFile(readFileSync(f, "utf8")) : null;
}

function needFactory(name: string): Def {
  const d = factoryDef(name);
  assert.ok(d, `the factory ships no ${name} agent at cell/claude/agents/${name}.md`);
  return d;
}

type Ctx = {
  agents?: Def[];
  agent?: Def | null;
  dir?: string;
  got?: Def | null;
};

function ctx(world: object): Ctx {
  const w = world as { pbi129?: Ctx };
  w.pbi129 ??= {};
  return w.pbi129;
}

After(function () {
  const d = (this as { pbi129?: Ctx }).pbi129?.dir;
  if (d) rmSync(d, { recursive: true, force: true });
});

/** The agent's instructions as sentences, so a step can ask for one sentence that says all of something. */
function sentences(prompt: string): string[] {
  return prompt.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

function saysInOneSentence(world: object, what: string, ...patterns: RegExp[]) {
  const d = ctx(world).agent;
  assert.ok(d, `the factory ships no ${PR_REVIEWER} agent`);
  const hit = sentences(d.prompt).find((s) => patterns.every((p) => p.test(s)));
  assert.ok(hit, `no sentence in ${PR_REVIEWER}'s instructions ${what} (looked for ${patterns.map(String).join(", ")})`);
}

When("the factory's cell agents are read", function () {
  ctx(this).agents = readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md")).map((f) => parseFile(readFileSync(join(AGENTS_DIR, f), "utf8")));
});

When("the factory's {string} agent is read", function (name: string) {
  ctx(this).agent = factoryDef(name);
});

Then("they include an agent named {string}", function (name: string) {
  const agents = ctx(this).agents ?? [];
  assert.ok(agents.some((a) => a.name === name), `the factory's cell agents are ${agents.map((a) => a.name).join(", ")}`);
  ctx(this).agent = agents.find((a) => a.name === name);
});

Then("its description says it reviews a pull request for the factory", function () {
  const d = ctx(this).agent;
  assert.ok(d, "no agent was found");
  assert.match(d.description, /factory/i, "the description doesn't say it's the factory's");
  assert.match(d.description, /review/i, "the description doesn't say it reviews");
  assert.match(d.description, /pull request|\bPR\b/i, "the description doesn't say it reviews a pull request");
});

Then("its instructions tell it to review the PR head its brief names", function () {
  saysInOneSentence(this, "tells it to review the PR head its brief names", /review/i, /\bhead\b/i, /\bbrief\b/i);
});

Then("its instructions tell it to judge that head against the PR review rubric in its brief, and nothing else", function () {
  saysInOneSentence(this, "tells it to judge the head against the rubric in its brief and nothing else",
    /\bhead\b/i, /rubric/i, /\bbrief\b/i, /nothing else/i);
  assert.match(ctx(this).agent!.prompt, /pr-review\.md|PR review rubric/i, "the instructions don't name the PR review rubric");
});

Then("its instructions tell it to check each open thread in its brief against the PR head", function () {
  saysInOneSentence(this, "tells it to check each open thread in its brief against the head",
    /\beach\b/i, /open thread/i, /\bbrief\b/i, /\bhead\b/i);
});

Then("its instructions tell it to say, for each of those threads, whether the head settles it", function () {
  saysInOneSentence(this, "tells it to say for each thread whether the head settles it",
    /\beach\b/i, /thread/i, /whether/i, /settle/i);
});

Then("its instructions say its last line is exactly {string} when nothing is left open", function (word: string) {
  saysInOneSentence(this, `says its last line is exactly ${word} when nothing is open`,
    /last line/i, /exactly/i, new RegExp(`\`${word}\``), /open/i);
});

Then("its instructions say its last line is otherwise {string}, with n the number left open", function (verdict: string) {
  saysInOneSentence(this, `says its last line is otherwise ${verdict}, with n the number open`,
    /last line|otherwise/i, new RegExp(`\`${verdict.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\``), /number/i, /open/i);
});

// A checkout's own agent files, and the definition a cell run that names the PR reviewer gets there.

// The checkout's own agent files come from PBI 96's steps, which keep the checkout in the world's `pbi96`.
type Pbi96 = { dir: string; checkout: Map<string, string> };
const pbi96 = (world: object) => (world as { pbi96?: Pbi96 }).pbi96;

/** The checkout's own file for the PR reviewer, as PBI 96's Given wrote it. */
function checkoutDef(world: object): Def {
  const c = pbi96(world);
  assert.ok(c, "no checkout was set up");
  const f = join(c.dir, ".claude/agents", `${PR_REVIEWER}.md`);
  assert.ok(existsSync(f), "the checkout holds no PR reviewer file");
  return parseFile(readFileSync(f, "utf8"));
}

Given("a checkout with no agent files of its own", function () {
  const dir = mkdtempSync(join(tmpdir(), "pbi129-"));
  ctx(this).dir = dir;
  assert.ok(!existsSync(join(dir, ".claude")));
});

/** The definition a run with these options gets for the agent it names, or null when none is found (PBI 96's order). */
function resolve(options: Record<string, unknown>, cwd: string): Def | null {
  const name = options.agent as string | undefined;
  assert.ok(name, "the run names no agent");
  const passed = (options.agents as Record<string, { description?: string; prompt: string; tools?: string[]; disallowedTools?: string[] }> | undefined)?.[name];
  if (passed) {
    return { name, description: passed.description ?? "", prompt: passed.prompt.trim(), tools: passed.tools ?? null, disallowed: passed.disallowedTools ?? [] };
  }
  const sources = (options.settingSources as string[] | undefined) ?? [];
  const dirs = [
    ...(sources.includes("project") ? [join(String(options.cwd ?? cwd), ".claude/agents")] : []),
    ...(sources.includes("user") ? [join(homedir(), ".claude/agents")] : []),
  ];
  for (const d of dirs) {
    const f = join(d, `${name}.md`);
    if (existsSync(f)) return parseFile(readFileSync(f, "utf8"));
  }
  return null;
}

When("a cell run that names {string} sets up its agent run in that checkout", function (name: string) {
  const c = ctx(this);
  const dir = pbi96(this)?.dir ?? c.dir;
  assert.ok(dir, "no checkout was set up");
  const args: AgentArgs = { prompt: "# PR review brief", model: "claude-sonnet-4-5", cwd: dir, agent: name, mode: "cell",
    webTools: [], signal: new AbortController().signal };
  c.got = resolve(agentOptions(args) as Record<string, unknown>, dir);
});

function got(world: object): Def {
  const d = ctx(world).got;
  assert.ok(d, `the run gets no definition of ${PR_REVIEWER}`);
  return d;
}

Then("the PR reviewer the run gets has the factory's instructions", function () {
  const ours = needFactory(PR_REVIEWER);
  assert.equal(got(this).prompt, ours.prompt, "the PR reviewer the run gets doesn't have the factory's instructions");
});

Then("the PR reviewer the run gets doesn't have the checkout's instructions", function () {
  const theirs = checkoutDef(this);
  assert.ok(!got(this).prompt.includes(theirs.prompt), "the PR reviewer the run gets has the checkout's instructions");
});

Then("the PR reviewer the run gets has the tools the factory's definition lists", function () {
  const ours = needFactory(PR_REVIEWER);
  assert.deepEqual(got(this).tools, ours.tools, "the PR reviewer's tools differ from the factory's definition");
});

Then("the PR reviewer the run gets has no tool that only the checkout's file grants", function () {
  const ours = needFactory(PR_REVIEWER);
  const d = got(this);
  assert.ok(d.tools, "the PR reviewer the run gets has every tool");
  const theirs = checkoutDef(this).tools ?? [];
  const extra = d.tools.filter((t) => !d.disallowed.includes(t) && theirs.includes(t) && !(ours.tools ?? []).includes(t));
  assert.deepEqual(extra, [], `the PR reviewer the run gets has ${extra.join(", ")} from the checkout's file`);
});

// ---------------------------------------------------------------------------------------------------------------------
// The repo host on GitHub, over a client that records each request

type Request = { route: string; params: Record<string, unknown> };
type GraphqlCall = { query: string; vars: Record<string, unknown> };
type Thread = { id: string; isResolved: boolean; path: string; line: number; body: string };
type LineComment = { path: string; line: number; body: string };
type ReviewArgs = { repo: string; prNumber: number; commitSha: string; body: string; comments: LineComment[] };
type Host = {
  postReview(p: ReviewArgs & { event?: string }): Promise<void>;
  resolveThread(repo: string, threadId: string): Promise<void>;
};

type GitHub = { repo: string; pr: number; threads: Map<string, Thread>; requests: Request[]; graphql: GraphqlCall[]; host: Host;
  before?: string };
type Outcome = { error: unknown | null };
type HostCtx = { gh?: GitHub; posts: Outcome[]; resolves: Map<string, Outcome[]> };

function hctx(world: object): HostCtx {
  const w = world as { pbi129host?: HostCtx };
  w.pbi129host ??= { posts: [], resolves: new Map() };
  return w.pbi129host;
}

const split = (repo: string) => {
  const [owner, name] = repo.split("/");
  return { owner, repo: name };
};

function gitHub(world: object, repo: string, pr: number, threads: Thread[]): GitHub {
  const gh: GitHub = { repo, pr, threads: new Map(threads.map((t) => [t.id, t])), requests: [], graphql: [], host: undefined as unknown as Host };
  const client: GitHubClient = {
    async request(route, params = {}) {
      gh.requests.push({ route, params: structuredClone(params) });
      if (route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews") return { data: { id: 1001, state: "COMMENTED" } };
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
        return { data: { number: pr, state: "open", head: { sha: "1a2b3c4" }, base: { ref: "main" }, user: { login: "factory[bot]" } } };
      }
      throw Object.assign(new Error(`the recording GitHub doesn't answer ${route}`), { status: 404 });
    },
    async graphql<T>(query: string, vars: Record<string, unknown> = {}) {
      gh.graphql.push({ query, vars: structuredClone(vars) });
      if (/resolveReviewThread/.test(query)) {
        const id = Object.values(vars).find((v) => typeof v === "string" && gh.threads.has(v)) as string | undefined;
        if (!id) throw new Error(`GitHub knows no review thread among ${JSON.stringify(vars)}`);
        const t = gh.threads.get(id)!;
        t.isResolved = true;
        return { resolveReviewThread: { thread: { id, isResolved: true } } } as T;
      }
      if (/mutation/.test(query)) throw new Error("the recording GitHub only answers resolveReviewThread mutations");
      return { repository: { pullRequest: {
        reviewThreads: { nodes: [...gh.threads.values()].map((t) => ({ id: t.id, isResolved: t.isResolved, path: t.path, line: t.line,
          comments: { nodes: [{ author: { __typename: "User", login: "reviewer" }, body: t.body, pullRequestReview: { submittedAt: "2026-11-01T00:00:00Z" } }] } })) },
        reviews: { nodes: [] },
      } } } as T;
    },
  };
  const app: AppLike = { octokit: client, getInstallationOctokit: async () => client };
  gh.host = githubRepoHost(app, 1) as unknown as Host;
  hctx(world).gh = gh;
  return gh;
}

function needGitHub(world: object): GitHub {
  const gh = hctx(world).gh;
  assert.ok(gh, "no GitHub pull request was set up");
  return gh;
}

const snapshot = (gh: GitHub) => JSON.stringify([...gh.threads.values()].map((t) => ({ ...t })));

Given("GitHub's pull request {int} on {string}, whose requests are recorded", function (pr: number, repo: string) {
  gitHub(this, repo, pr, []);
});

Given("GitHub's pull request {int} on {string}, with an open review thread {string}, whose requests are recorded", function (pr: number, repo: string, id: string) {
  gitHub(this, repo, pr, [{ id, isResolved: false, path: "src/totals.ts", line: 12, body: "Rename this" }]);
});

Given("GitHub's pull request {int} on {string}, with a resolved review thread {string}, whose requests are recorded", function (pr: number, repo: string, id: string) {
  const gh = gitHub(this, repo, pr, [
    { id, isResolved: true, path: "src/totals.ts", line: 12, body: "Rename this" },
    { id: `${id}-other`, isResolved: false, path: "src/totals.ts", line: 40, body: "And this" },
  ]);
  gh.before = snapshot(gh);
});

async function post(world: object, host: Host, p: ReviewArgs & { event?: string }) {
  try {
    await host.postReview(p);
    hctx(world).posts.push({ error: null });
  } catch (error) {
    hctx(world).posts.push({ error });
  }
}

async function resolveOn(world: object, host: Host, repo: string, id: string) {
  const r = hctx(world).resolves;
  try {
    await host.resolveThread(repo, id);
    r.set(id, [...(r.get(id) ?? []), { error: null }]);
  } catch (error) {
    r.set(id, [...(r.get(id) ?? []), { error }]);
  }
}

When("the factory posts a review on PR {int} at commit {string} with the body {string} and these line comments:", async function (pr: number, sha: string, body: string, table: DataTable) {
  const gh = needGitHub(this);
  const comments = table.hashes().map((r) => ({ path: r.path, line: Number(r.line), body: r.body }));
  await post(this, gh.host, { repo: gh.repo, prNumber: pr, commitSha: sha, body, comments });
});

When("the factory posts a review on PR {int} at commit {string} with the body {string} and no line comments", async function (pr: number, sha: string, body: string) {
  const gh = needGitHub(this);
  await post(this, gh.host, { repo: gh.repo, prNumber: pr, commitSha: sha, body, comments: [] });
});

When("the factory posts a review on PR {int} at commit {string} with the body {string}, slipping in the event {string}", async function (pr: number, sha: string, body: string, event: string) {
  const gh = needGitHub(this);
  // The signature takes no event, so this one gets past the type checker the way a careless caller's might.
  await post(this, gh.host, { repo: gh.repo, prNumber: pr, commitSha: sha, body, comments: [], event });
});

When("the factory resolves thread {string}", async function (id: string) {
  const gh = needGitHub(this);
  await resolveOn(this, gh.host, gh.repo, id);
});

/** The reviews GitHub received on the PR, from the review requests the client recorded. */
function reviewsOn(world: object, pr: number): Record<string, unknown>[] {
  const gh = needGitHub(world);
  const { owner, repo } = split(gh.repo);
  return gh.requests
    .filter((r) => r.route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews")
    .filter((r) => r.params.owner === owner && r.params.repo === repo && Number(r.params.pull_number) === pr)
    .map((r) => r.params);
}

function theReview(world: object): Record<string, unknown> {
  // PBI 128's engine scenarios pick "that review" from what the fake repo host recorded, in GitHub's request shape.
  const own = (world as { reviewUnderTest?: () => Record<string, unknown> }).reviewUnderTest;
  if (own) return own();
  const gh = needGitHub(world);
  const reviews = reviewsOn(world, gh.pr);
  assert.equal(reviews.length, 1, `GitHub received ${reviews.length} reviews on PR ${gh.pr}`);
  return reviews[0];
}

function postError(world: object): string {
  const e = hctx(world).posts.find((p) => p.error)?.error;
  return e ? ` (posting failed: ${e instanceof Error ? e.message : String(e)})` : "";
}

Then("GitHub receives one review on PR {int}", function (pr: number) {
  const reviews = reviewsOn(this, pr);
  assert.equal(reviews.length, 1, `GitHub received ${reviews.length} reviews on PR ${pr}${postError(this)}`);
});

Then("that review is at commit {string}", function (sha: string) {
  assert.equal(theReview(this).commit_id, sha);
});

Then("that review has the body {string}", function (body: string) {
  assert.equal(theReview(this).body, body);
});

Then("that review has a line comment {string} on line {int} of {string}", function (body: string, line: number, path: string) {
  const comments = (theReview(this).comments ?? []) as LineComment[];
  assert.ok(comments.some((c) => c.body === body && Number(c.line) === line && c.path === path),
    `the review's line comments are ${JSON.stringify(comments)}`);
});

Then("that review has no line comments", function () {
  const comments = (theReview(this).comments ?? []) as unknown[];
  assert.deepEqual(comments, []);
});

Then("that review's event is {string}", function (event: string) {
  assert.equal(theReview(this).event, event);
});

Then("GitHub receives no review on PR {int} whose event is {string}", function (pr: number, event: string) {
  const sent = reviewsOn(this, pr).filter((r) => r.event === event);
  assert.equal(sent.length, 0, `GitHub received ${sent.length} reviews on PR ${pr} with the event ${event}`);
});

Then("GitHub is asked to resolve thread {string}", function (id: string) {
  const asked = needGitHub(this).graphql.filter((g) => /resolveReviewThread/.test(g.query) && Object.values(g.vars).includes(id));
  const e = hctx(this).resolves.get(id)?.find((o) => o.error)?.error;
  assert.ok(asked.length > 0, `GitHub was never asked to resolve thread ${id}${e ? ` (resolving failed: ${String(e)})` : ""}`);
});

Then("thread {string} is resolved", function (id: string) {
  const t = needGitHub(this).threads.get(id);
  assert.ok(t, `GitHub has no thread ${id}`);
  assert.equal(t.isResolved, true, `thread ${id} is still open`);
});

Then("resolving thread {string} succeeds", function (id: string) {
  const outcomes = hctx(this).resolves.get(id) ?? [];
  assert.equal(outcomes.length, 1, `thread ${id} was resolved ${outcomes.length} times`);
  assert.equal(outcomes[0].error, null, `resolving thread ${id} failed: ${String(outcomes[0].error)}`);
});

Then("thread {string} is still resolved", function (id: string) {
  const t = needGitHub(this).threads.get(id);
  assert.ok(t, `GitHub has no thread ${id}`);
  assert.equal(t.isResolved, true, `thread ${id} is open`);
});

Then("nothing else on PR {int} has changed", function (pr: number) {
  const gh = needGitHub(this);
  assert.equal(pr, gh.pr);
  assert.equal(snapshot(gh), gh.before, "PR's review threads changed");
  const writes = gh.requests.filter((r) => !r.route.startsWith("GET "));
  assert.deepEqual(writes.map((r) => r.route), [], "the repo host wrote to GitHub over REST");
  const mutations = gh.graphql.filter((g) => /mutation/.test(g.query) && !/resolveReviewThread/.test(g.query));
  assert.equal(mutations.length, 0, "the repo host sent GitHub a mutation other than resolving the thread");
});

// The repo host's way to post a review, as src/adapters/types.ts declares it on RepoHost.

/** The parameter list of `postReview` in the RepoHost interface, or null when RepoHost declares no such method. */
function postReviewParams(): string | null {
  const text = readFileSync(join(repoRoot, "src/adapters/types.ts"), "utf8");
  const start = text.indexOf("export interface RepoHost");
  assert.ok(start >= 0, "src/adapters/types.ts declares no RepoHost");
  const at = text.indexOf("postReview(", start);
  if (at < 0) return null;
  let depth = 0;
  const open = at + "postReview".length;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(open + 1, i);
  }
  return null;
}

When("the repo host's way to post a review is read", function () {
  (this as { pbi129params?: string | null }).pbi129params = postReviewParams();
});

function params(world: object): string {
  const p = (world as { pbi129params?: string | null }).pbi129params;
  assert.ok(p !== undefined && p !== null, "RepoHost declares no postReview");
  return p;
}

Then("it takes the repo, the PR, the commit, the body and the line comments", function () {
  const p = params(this);
  for (const [what, name] of [["the repo", "repo"], ["the PR", "prNumber"], ["the commit", "commitSha"], ["the body", "body"], ["the line comments", "comments"]]) {
    assert.match(p, new RegExp(`\\b${name}\\??\\s*:`), `postReview doesn't take ${what} as \`${name}\`: (${p})`);
  }
  assert.doesNotMatch(p, /\.\.\.\w+\s*:\s*unknown/, `postReview takes anything at all: (${p})`);
});

Then("it takes nothing that names a review event", function () {
  const p = params(this);
  assert.doesNotMatch(p, /event|APPROVE|REQUEST_CHANGES|PENDING|\bstate\b/i, `postReview takes a review event: (${p})`);
  assert.doesNotMatch(p, /\.\.\.\w+\s*:\s*unknown|Record<string,\s*unknown>|\bany\b/, `postReview takes anything at all: (${p})`);
});

// ---------------------------------------------------------------------------------------------------------------------
// The fake repo host

type PostedReview = { repo: string; prNumber: number; commitSha: string; body: string; comments: LineComment[]; event: string };
type Fake = ReturnType<typeof fakeRepoHost> & { postedReviews?: PostedReview[]; resolvedThreads?: { repo: string; threadId: string }[] };
type FakeCtx = { host: Fake; repo: string; pr: number };

function fctx(world: object): FakeCtx {
  const f = (world as { pbi129fake?: FakeCtx }).pbi129fake;
  assert.ok(f, "no fake repo host was set up");
  return f;
}

function fakeWith(world: object, pr: number, repo: string, threads: { id: string; body: string }[]): FakeCtx {
  const host = fakeRepoHost() as Fake;
  host.prs.push({ number: pr, repo, branch: `factory/pbi-129-r1`, base: "main", title: "PR", body: "", headSha: "1a2b3c4", open: true,
    merged: false, mergeSha: null, mergeable: true, reviewers: [], comments: [], reviews: [] });
  host.reviewComments.set(`${repo}#${pr}`, threads.map((t): ReviewComment & { resolved?: boolean } =>
    ({ threadId: t.id, path: "src/totals.ts", line: 12, author: "reviewer", body: t.body })));
  const f = { host, repo, pr };
  (world as { pbi129fake?: FakeCtx }).pbi129fake = f;
  return f;
}

Given("the fake repo host has PR {int} on {string}", function (pr: number, repo: string) {
  fakeWith(this, pr, repo, []);
});

Given("the fake repo host has PR {int} on {string} with an open thread {string} saying {string}", function (pr: number, repo: string, id: string, body: string) {
  fakeWith(this, pr, repo, [{ id, body }]);
});

Given("the fake repo host has PR {int} on {string} with open threads {string} and {string}", function (pr: number, repo: string, a: string, b: string) {
  fakeWith(this, pr, repo, [{ id: a, body: `Thread ${a}` }, { id: b, body: `Thread ${b}` }]);
});

When("the factory resolves thread {string} on the fake repo host", async function (id: string) {
  const f = fctx(this);
  await resolveOn(this, f.host as unknown as Host, f.repo, id);
});

When("the factory resolves thread {string} on the fake repo host again", async function (id: string) {
  const f = fctx(this);
  await resolveOn(this, f.host as unknown as Host, f.repo, id);
});

When("the factory posts a review on PR {int} at commit {string} on the fake repo host, with the body {string} and a line comment {string} on line {int} of {string}", async function (pr: number, sha: string, body: string, comment: string, line: number, path: string) {
  const f = fctx(this);
  await post(this, f.host as unknown as Host, { repo: f.repo, prNumber: pr, commitSha: sha, body, comments: [{ path, line, body: comment }] });
});

When("the factory posts a review on PR {int} at commit {string} on the fake repo host, with the body {string}", async function (pr: number, sha: string, body: string) {
  const f = fctx(this);
  await post(this, f.host as unknown as Host, { repo: f.repo, prNumber: pr, commitSha: sha, body, comments: [] });
});

When("nothing is posted or resolved on the fake repo host", function () {
  fctx(this);
});

Then("PR {int}'s open review comments no longer hold {string}", async function (pr: number, body: string) {
  const f = fctx(this);
  const open = await f.host.openReviewComments(f.repo, pr);
  const e = [...hctx(this).resolves.values()].flat().find((o) => o.error)?.error;
  assert.ok(!open.some((c) => c.body === body), `PR ${pr}'s open review comments still hold "${body}"${e ? ` (resolving failed: ${String(e)})` : ""}`);
});

Then("resolving thread {string} the second time succeeds", function (id: string) {
  const outcomes = hctx(this).resolves.get(id) ?? [];
  assert.equal(outcomes.length, 2, `thread ${id} was resolved ${outcomes.length} times`);
  assert.equal(outcomes[1].error, null, `resolving thread ${id} the second time failed: ${String(outcomes[1].error)}`);
});

function resolvedThreads(world: object): { repo: string; threadId: string }[] {
  const r = fctx(world).host.resolvedThreads;
  assert.ok(Array.isArray(r), "the fake repo host records no resolved threads");
  return r;
}

function postedReviews(world: object): PostedReview[] {
  const r = fctx(world).host.postedReviews;
  assert.ok(Array.isArray(r), `the fake repo host records no reviews${postError(world)}`);
  return r;
}

Then("the fake repo host records thread {string} as resolved once", function (id: string) {
  const f = fctx(this);
  const hits = resolvedThreads(this).filter((t) => t.threadId === id && t.repo === f.repo);
  assert.equal(hits.length, 1, `the fake repo host records thread ${id} as resolved ${hits.length} times`);
});

Then("the fake repo host's recorded resolved threads hold {string} and {string}", function (a: string, b: string) {
  const f = fctx(this);
  assert.deepEqual(resolvedThreads(this), [{ repo: f.repo, threadId: a }, { repo: f.repo, threadId: b }]);
});

function reviewsOnFake(world: object, pr: number): PostedReview[] {
  const f = fctx(world);
  return postedReviews(world).filter((r) => r.repo === f.repo && r.prNumber === pr);
}

Then("the fake repo host's recorded reviews hold one review on PR {int}", function (pr: number) {
  assert.equal(reviewsOnFake(this, pr).length, 1);
});

Then("the fake repo host's recorded reviews hold two reviews on PR {int}", function (pr: number) {
  assert.equal(reviewsOnFake(this, pr).length, 2);
});

function recorded(world: object, i: number): PostedReview {
  const r = reviewsOnFake(world, fctx(world).pr)[i];
  assert.ok(r, `the fake repo host records no review number ${i + 1}`);
  return r;
}

Then("that recorded review is at commit {string} with the body {string}", function (sha: string, body: string) {
  const r = recorded(this, 0);
  assert.equal(r.commitSha, sha);
  assert.equal(r.body, body);
});

Then("that recorded review has a line comment {string} on line {int} of {string}", function (body: string, line: number, path: string) {
  assert.deepEqual(recorded(this, 0).comments, [{ path, line, body }]);
});

Then("that recorded review only comments", function () {
  assert.equal(recorded(this, 0).event, "COMMENT");
});

Then("the first recorded review is at commit {string} with the body {string}", function (sha: string, body: string) {
  const r = recorded(this, 0);
  assert.deepEqual([r.commitSha, r.body], [sha, body]);
});

Then("the second recorded review is at commit {string} with the body {string}", function (sha: string, body: string) {
  const r = recorded(this, 1);
  assert.deepEqual([r.commitSha, r.body], [sha, body]);
});

Then("the fake repo host's recorded reviews are empty", function () {
  assert.deepEqual(postedReviews(this), []);
});

Then("the fake repo host's recorded resolved threads are empty", function () {
  assert.deepEqual(resolvedThreads(this), []);
});
