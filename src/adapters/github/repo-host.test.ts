import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fakeRepoHost } from "../fake.ts";
import { botKey, loginKey, standingSummaries, type Review } from "../types.ts";
import { cellRepoHost, githubRepoHost, ownersOf, type GitHubClient } from "./repo-host.ts";

type Call = { route: string; params: Record<string, any> };

/** A stub GitHub: `routes` answers by route, and every call is recorded. A route missing from the map throws 404. */
function stubGitHub(routes: Record<string, (p: Record<string, any>) => unknown>, graphql: (q: string, v: any) => unknown = () => ({})) {
  const calls: Call[] = [];
  const request = async (route: string, params: Record<string, any> = {}) => {
    calls.push({ route, params });
    const handler = routes[route];
    if (!handler) throw Object.assign(new Error(`404 ${route}`), { status: 404 });
    return { data: handler(params) };
  };
  const client: GitHubClient = { request, graphql: async (q, v) => graphql(q, v) as any };
  const app = { octokit: { request }, getInstallationOctokit: async () => client };
  return { calls, host: githubRepoHost(app, 7) };
}

const b64 = (s: string) => Buffer.from(s).toString("base64");

describe("githubRepoHost", () => {
  test("cellToken asks for write on contents, pull requests and issues for one repo, and nothing on statuses or checks", async () => {
    const { calls, host } = stubGitHub({ "POST /app/installations/{installation_id}/access_tokens": () => ({ token: "ghs_x", expires_at: "2026-11-06T10:00:00Z" }) });
    assert.deepEqual(await host.cellToken("ricksu978/software-factory"), { token: "ghs_x", expiresAt: "2026-11-06T10:00:00Z" });
    const p = calls[0].params;
    assert.equal(p.installation_id, 7);
    assert.deepEqual(p.repositories, ["software-factory"]);
    assert.deepEqual(p.permissions, { contents: "write", pull_requests: "write", issues: "write" });
    assert.ok(!("statuses" in p.permissions) && !("checks" in p.permissions));
  });

  const pr = { base: { ref: "main" }, user: { login: "author" }, head: { sha: "abc" } };

  test("requestReviewers asks the CODEOWNERS owners of the changed files when the repo has CODEOWNERS", async () => {
    const { calls, host } = stubGitHub({
      "GET /repos/{owner}/{repo}/pulls/{pull_number}": () => pr,
      "GET /repos/{owner}/{repo}/contents/{path}": (p) => (p.path === ".github/CODEOWNERS" ? { type: "file", content: b64("* @owner\n/docs/ @writer @org/docs-team\n") } : undefined),
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/files": () => [{ filename: "docs/spec.md" }],
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers": () => ({}),
    });
    assert.deepEqual(await host.requestReviewers("o/r", 3, ["fallback"]), ["writer", "org/docs-team"]);
    const req = calls.find((c) => c.route.endsWith("/requested_reviewers"))!.params;
    assert.deepEqual([req.reviewers, req.team_reviewers], [["writer"], ["docs-team"]]);
  });

  test("requestReviewers falls back when the repo has no CODEOWNERS", async () => {
    const { calls, host } = stubGitHub({
      "GET /repos/{owner}/{repo}/pulls/{pull_number}": () => pr,
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers": () => ({}),
    });
    assert.deepEqual(await host.requestReviewers("o/r", 3, ["dev", "your-org/payments-team"]), ["dev", "your-org/payments-team"]);
    const req = calls.find((c) => c.route.endsWith("/requested_reviewers"))!.params;
    assert.deepEqual([req.reviewers, req.team_reviewers], [["dev"], ["payments-team"]]);
  });

  test("requestReviewers falls back when CODEOWNERS names nobody but the author for the changed files", async () => {
    for (const codeowners of ["/docs/ @writer\n", "* @author\n"]) {
      const { calls, host } = stubGitHub({
        "GET /repos/{owner}/{repo}/pulls/{pull_number}": () => pr,
        "GET /repos/{owner}/{repo}/contents/{path}": (p) => (p.path === ".github/CODEOWNERS" ? { type: "file", content: b64(codeowners) } : undefined),
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/files": () => [{ filename: "src/a.ts" }],
        "POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers": () => ({}),
      });
      assert.deepEqual(await host.requestReviewers("o/r", 3, ["dev"]), ["dev"]);
      assert.deepEqual(calls.find((c) => c.route.endsWith("/requested_reviewers"))!.params.reviewers, ["dev"]);
    }
  });

  test("prState takes the newest changes-requested review from a trusted login and ignores a stranger's newer one", async () => {
    const reviews = [
      { id: 1, state: "CHANGES_REQUESTED", body: "Split it", submitted_at: "2026-11-06T01:00:00Z", user: { login: "Owner" } },
      { id: 2, state: "APPROVED", body: "", submitted_at: "2026-11-06T03:00:00Z", user: { login: "owner" } },
      { id: 3, state: "CHANGES_REQUESTED", body: "Split it", submitted_at: "2026-11-06T04:00:00Z", user: { login: "stranger" } },
    ];
    const { host } = stubGitHub({
      "GET /repos/{owner}/{repo}/pulls/{pull_number}": () => ({ merged: false, merge_commit_sha: "tmp", state: "open", mergeable: true }),
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews": () => reviews,
    }, () => ({ repository: { pullRequest: { reviewThreads: { nodes: [] }, reviews: { nodes: [] } } } }));
    assert.deepEqual(await host.prState("o/r", 3, ["owner"]), { merged: false, mergeSha: null, open: true, mergeable: true, lastChangesRequestedAt: "2026-11-06T01:00:00Z" });
    assert.equal((await host.prState("o/r", 3, [])).lastChangesRequestedAt, null);
  });

  test("prState counts a trusted comment in an unresolved thread, so a review that only comments still requests changes", async () => {
    const comment = (login: string, submittedAt: string) => ({ author: { __typename: "User", login }, body: "x", pullRequestReview: { submittedAt } });
    const thread = (isResolved: boolean, ...comments: unknown[]) => ({ id: "t", isResolved, path: "a.ts", line: 1, comments: { nodes: comments } });
    const threads = [
      thread(false, comment("Owner", "2026-11-06T02:00:00Z")),
      thread(true, comment("owner", "2026-11-06T05:00:00Z")),
      thread(false, comment("stranger", "2026-11-06T06:00:00Z")),
    ];
    const { host } = stubGitHub({
      "GET /repos/{owner}/{repo}/pulls/{pull_number}": () => ({ merged: false, merge_commit_sha: null, state: "open", mergeable: true }),
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews": () => [{ state: "COMMENTED", submitted_at: "2026-11-06T02:00:00Z", user: { login: "owner" } }],
    }, () => ({ repository: { pullRequest: { reviewThreads: { nodes: threads }, reviews: { nodes: [] } } } }));
    assert.equal((await host.prState("o/r", 3, ["owner"])).lastChangesRequestedAt, "2026-11-06T02:00:00Z", "the open thread, not the resolved or the stranger's");
    assert.equal((await host.prState("o/r", 3, [])).lastChangesRequestedAt, null);
    threads.push(thread(false, comment("owner", new Date().toISOString())));
    assert.equal((await host.prState("o/r", 3, ["owner"])).lastChangesRequestedAt, "2026-11-06T02:00:00Z", "a reply seconds old may be resolved next");
  });

  test("prState skips a thread the trusted bot opened, a trusted reply inside it included (PBI 130)", async () => {
    const comment = (__typename: string, login: string) => ({ author: { __typename, login }, body: "x", pullRequestReview: { submittedAt: "2026-11-06T02:00:00Z" } });
    const threads = [{ id: "t", isResolved: false, path: "a.ts", line: 1, comments: { nodes: [comment("Bot", "factory"), comment("User", "owner")] } }];
    const { host } = stubGitHub({
      "GET /repos/{owner}/{repo}/pulls/{pull_number}": () => ({ merged: false, merge_commit_sha: null, state: "open", mergeable: true }),
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews": () => [],
    }, () => ({ repository: { pullRequest: { reviewThreads: { nodes: threads }, reviews: { nodes: [] } } } }));
    assert.equal((await host.prState("o/r", 3, ["owner"], "factory[bot]")).lastChangesRequestedAt, null);
    assert.equal((await host.prState("o/r", 3, ["owner"], "factory")).lastChangesRequestedAt, null, "stored without [bot]");
    assert.equal((await host.prState("o/r", 3, ["owner"], "other[bot]")).lastChangesRequestedAt, "2026-11-06T02:00:00Z");
  });

  test("prState counts a changes-requested review with no summary only when it comments outside the factory's threads (PBI 130)", async () => {
    const comment = (__typename: string, login: string, databaseId: number) => ({ author: { __typename, login }, body: "x", pullRequestReview: { databaseId, submittedAt: "2026-11-06T01:00:00Z" } });
    const factory = { id: "ft", isResolved: false, path: "a.ts", line: 1, comments: { nodes: [comment("Bot", "factory", 1), comment("User", "owner", 2)] } };
    const threads: unknown[] = [factory];
    const { host } = stubGitHub({
      "GET /repos/{owner}/{repo}/pulls/{pull_number}": () => ({ merged: false, merge_commit_sha: null, state: "open", mergeable: true }),
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews": () => [{ id: 2, state: "CHANGES_REQUESTED", body: null, submitted_at: "2026-11-06T03:00:00Z", user: { login: "owner" } }],
    }, () => ({ repository: { pullRequest: { reviewThreads: { nodes: threads }, reviews: { nodes: [] } } } }));
    assert.equal((await host.prState("o/r", 3, ["owner"], "factory[bot]")).lastChangesRequestedAt, null, "its only text is a reply in the factory's thread");
    threads.push({ id: "pt", isResolved: true, path: "b.ts", line: 2, comments: { nodes: [comment("User", "owner", 2)] } });
    assert.equal((await host.prState("o/r", 3, ["owner"], "factory[bot]")).lastChangesRequestedAt, "2026-11-06T03:00:00Z", "it also opened a thread of its own");
  });

  test("prState reports a merge without reading threads, so a failing GraphQL call can't hide it", async () => {
    const { host } = stubGitHub({
      "GET /repos/{owner}/{repo}/pulls/{pull_number}": () => ({ merged: true, merge_commit_sha: "m1", state: "closed", mergeable: null }),
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews": () => [],
    }, () => { throw new Error("502 Bad Gateway"); });
    assert.deepEqual(await host.prState("o/r", 3, ["owner"]), { merged: true, mergeSha: "m1", open: false, mergeable: null, lastChangesRequestedAt: null });
  });

  test("openReviewComments returns every comment in unresolved threads and none from resolved ones", async () => {
    const thread = (id: string, isResolved: boolean, body: string) => ({ id, isResolved, path: "a.ts", line: 4, comments: { nodes: [{ author: { login: "dev" }, body }] } });
    const { host } = stubGitHub({}, () => ({ repository: { pullRequest: { reviewThreads: { nodes: [thread("t1", true, "done"), thread("t2", false, "fix this")] }, reviews: { nodes: [] } } } }));
    assert.deepEqual(await host.openReviewComments("o/r", 3), [{ threadId: "t2", path: "a.ts", line: 4, author: "dev", body: "fix this" }]);
  });

  test("openReviewComments adds a standing changes-requested summary after the thread comments, and skips a pending review", async () => {
    const review = (id: string, state: string, body: string, login = "dev") => ({ id, state, body, author: { login } });
    const { host } = stubGitHub({}, () => ({ repository: { pullRequest: {
      reviewThreads: { nodes: [{ id: "t1", isResolved: false, path: "a.ts", line: 4, comments: { nodes: [{ author: { login: "dev" }, body: "fix this" }] } }] },
      reviews: { nodes: [review("r1", "CHANGES_REQUESTED", "Split run.ts"), review("r2", "PENDING", "draft", "factory[bot]")] },
    } } }));
    assert.deepEqual(await host.openReviewComments("o/r", 3), [
      { threadId: "t1", path: "a.ts", line: 4, author: "dev", body: "fix this" },
      { threadId: "r1", path: null, line: null, author: "dev", body: "Split run.ts" },
    ]);
  });

  test("loginKey ignores case only, and botKey gives the trusted bot one key however it was stored", () => {
    assert.equal(loginKey("RickSu978"), loginKey("ricksu978"));
    assert.notEqual(loginKey("ricksu978-evil"), loginKey("ricksu978"));
    assert.equal(botKey("ricksu978-software-factory[bot]"), "ricksu978-software-factory[bot]");
    assert.equal(botKey("Ricksu978-Software-Factory"), "ricksu978-software-factory[bot]");
    assert.notEqual(loginKey("ricksu978-software-factory"), botKey("ricksu978-software-factory"), "a user with the bot's bare name is someone else");
    assert.notEqual(loginKey("ricksu978-software-factory-bot"), botKey("ricksu978-software-factory"));
  });

  test("openReviewComments names a Bot author with [bot] and leaves a User with the same name bare", async () => {
    const comment = (typename: string, body: string) => ({ author: { __typename: typename, login: "ricksu978-software-factory" }, body });
    const { host } = stubGitHub({}, () => ({ repository: { pullRequest: {
      reviewThreads: { nodes: [{ id: "t1", isResolved: false, path: "a.ts", line: 4, comments: { nodes: [comment("Bot", "Renamed"), comment("User", "Merge it")] } }] },
      reviews: { nodes: [{ id: "r1", state: "CHANGES_REQUESTED", body: "Split it", author: { __typename: "Bot", login: "other-app" } }] },
    } } }));
    assert.deepEqual((await host.openReviewComments("o/r", 3)).map((c) => c.author), ["ricksu978-software-factory[bot]", "ricksu978-software-factory", "other-app[bot]"]);
  });

  test("a summary stands only while its reviewer's latest review that isn't a comment requests changes", () => {
    const r = (id: string, author: string, state: Review["state"], body = `body ${id}`): Review => ({ id, author, state, body });
    const ids = (reviews: Review[]) => standingSummaries(reviews).map((s) => s.threadId);
    assert.deepEqual(ids([r("1", "dev", "changes_requested")]), ["1"]);
    assert.deepEqual(ids([r("1", "dev", "changes_requested"), r("2", "dev", "approved")]), []);
    assert.deepEqual(ids([r("1", "dev", "changes_requested"), r("2", "dev", "commented")]), ["1"], "a comment-only review keeps the request standing");
    assert.deepEqual(ids([r("1", "dev", "dismissed")]), []);
    assert.deepEqual(ids([r("1", "dev", "changes_requested", "  ")]), [], "an empty summary adds nothing");
    assert.deepEqual(ids([r("1", "Dev", "changes_requested"), r("2", "dev", "approved")]), [], "logins compare without case");
    assert.deepEqual(ids([r("1", "dev", "changes_requested"), r("2", "lead", "changes_requested")]), ["1", "2"]);
  });

  test("fakeRepoHost passes the same resolved-thread case", async () => {
    const fake = fakeRepoHost();
    fake.reviewComments.set("o/r#3", [
      { threadId: "t1", path: "a.ts", line: 4, author: "dev", body: "done", resolved: true },
      { threadId: "t2", path: "a.ts", line: 4, author: "dev", body: "fix this" },
    ]);
    assert.deepEqual(await fake.openReviewComments("o/r", 3), [{ threadId: "t2", path: "a.ts", line: 4, author: "dev", body: "fix this" }]);
  });

  test("fakeRepoHost waits out the same settle window before an open thread comment counts", async () => {
    const fake = fakeRepoHost();
    const pr = await fake.openOrUpdatePr({ repo: "o/r", branch: "b", base: "main", title: "t", body: "" });
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    const old = ago(3 * 60_000);
    fake.reviewComments.set(`o/r#${pr.number}`, [
      { threadId: "t1", path: "a.ts", line: 4, author: "Owner", body: "Cite the probe.", submittedAt: old },
      { threadId: "t1", path: "a.ts", line: 4, author: "owner", body: "Fixed.", submittedAt: ago(5_000) },
    ]);
    assert.equal((await fake.prState("o/r", pr.number, ["owner"])).lastChangesRequestedAt, old, "a reply seconds old may be resolved next");
    await fake.closePr("o/r", pr.number, "");
    assert.equal((await fake.prState("o/r", pr.number, ["owner"])).lastChangesRequestedAt, null, "a closed PR reads no threads");
  });

  test("replyToThread adds a reply to that one review thread", async () => {
    const seen: any[] = [];
    const { host } = stubGitHub({}, (q, v) => (seen.push({ q, v }), {}));
    await host.replyToThread("o/r", "t2", "kept as is, because the name matches the spec");
    assert.match(seen[0].q, /addPullRequestReviewThreadReply/);
    assert.deepEqual(seen[0].v, { thread: "t2", body: "kept as is, because the name matches the spec" });
  });

  test("postReview posts one review at the commit, with its body and line comments, as COMMENT", async () => {
    const { calls, host } = stubGitHub({ "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews": () => ({ id: 1 }) },
      () => ({ repository: { pullRequest: { reviewThreads: { nodes: [] } } } }));
    await host.postReview({ repo: "o/r", prNumber: 3, commitSha: "abc", body: "Two things", comments: [{ path: "a.ts", line: 4, body: "Name it" }] });
    assert.deepEqual(calls, [{ route: "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews", params: {
      owner: "o", repo: "r", pull_number: 3, commit_id: "abc", body: "Two things", event: "COMMENT",
      comments: [{ path: "a.ts", line: 4, side: "RIGHT", body: "Name it" }] } }]);
  });

  test("postReview returns the threads its own line comments opened, by the review's id", async () => {
    const thread = (id: string, review: number, path: string, line: number, body: string) =>
      ({ id, path, line, comments: { nodes: [{ body, pullRequestReview: { databaseId: review } }] } });
    const seen: any[] = [];
    const { host } = stubGitHub({ "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews": () => ({ id: 42 }) }, (q, v) => (seen.push({ q, v }),
      { repository: { pullRequest: { reviewThreads: { nodes: [thread("PRT_old", 41, "a.ts", 1, "Older"), thread("PRT_1", 42, "a.ts", 4, "Name it")] } } } }));
    const r = await host.postReview({ repo: "o/r", prNumber: 3, commitSha: "abc", body: "One thing", comments: [{ path: "a.ts", line: 4, body: "Name it" }] });
    assert.deepEqual(r, { threads: [{ threadId: "PRT_1", path: "a.ts", line: 4, body: "Name it" }] });
    assert.deepEqual(seen[0].v, { owner: "o", repo: "r", number: 3 });
    assert.doesNotMatch(seen[0].q, /mutation/);
  });

  test("postReview with no line comments asks GitHub for no threads", async () => {
    const seen: any[] = [];
    const { host } = stubGitHub({ "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews": () => ({ id: 42 }) }, (q) => (seen.push(q), {}));
    assert.deepEqual(await host.postReview({ repo: "o/r", prNumber: 3, commitSha: "abc", body: "Clean", comments: [] }), { threads: [] });
    assert.equal(seen.length, 0);
  });

  test("the cell's repo host can post a review, resolve a thread and read the open threads", () => {
    const host = cellRepoHost(async () => "t");
    for (const k of ["postReview", "resolveThread", "openReviewComments"] as const) assert.equal(typeof host[k], "function", k);
  });

  test("postReview ignores an event a caller slips in", async () => {
    const { calls, host } = stubGitHub({ "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews": () => ({ id: 1 }) });
    const p = { repo: "o/r", prNumber: 3, commitSha: "abc", body: "Ship it", comments: [], event: "APPROVE" };
    await host.postReview(p);
    assert.equal(calls[0].params.event, "COMMENT");
  });

  test("resolveThread sends resolveReviewThread for that thread", async () => {
    const seen: any[] = [];
    const { calls, host } = stubGitHub({}, (q, v) => (seen.push({ q, v }), { resolveReviewThread: { thread: { id: v.thread, isResolved: true } } }));
    await host.resolveThread("o/r", "t2");
    assert.equal(seen.length, 1);
    assert.match(seen[0].q, /resolveReviewThread/);
    assert.deepEqual(seen[0].v, { thread: "t2" });
    assert.deepEqual(calls, []);
  });

  test("commentOnPr posts one comment on the PR's conversation", async () => {
    const { calls, host } = stubGitHub({ "POST /repos/{owner}/{repo}/issues/{issue_number}/comments": () => ({}) });
    await host.commentOnPr("o/r", 3, "> Split run.ts\n\nSplit in a1b2c3d.");
    assert.deepEqual(calls[0].params, { owner: "o", repo: "r", issue_number: 3, body: "> Split run.ts\n\nSplit in a1b2c3d." });
  });

  test("fakeRepoHost adds the same standing summary, in submission order", async () => {
    const fake = fakeRepoHost();
    const { number } = await fake.openOrUpdatePr({ repo: "o/r", branch: "b", base: "main", title: "t", body: "" });
    fake.prs[0].reviews.push(
      { state: "approved", author: "dev", submittedAt: "2026-11-06T02:00:00Z" },
      { state: "changes_requested", author: "dev", submittedAt: "2026-11-06T01:00:00Z", body: "Split run.ts" },
      { state: "changes_requested", author: "lead", submittedAt: "2026-11-06T03:00:00Z", body: "Name the retry limit" },
    );
    assert.deepEqual((await fake.openReviewComments("o/r", number)).map((c) => [c.author, c.body, c.path]), [["lead", "Name the retry limit", null]]);
  });

  test("readFile decodes a file and gives null for a missing one", async () => {
    const { host } = stubGitHub({ "GET /repos/{owner}/{repo}/contents/{path}": (p) => (p.path === "a.txt" ? { type: "file", content: b64("hi") } : (() => { throw Object.assign(new Error("404"), { status: 404 }); })()) });
    assert.equal(await host.readFile("o/r", "main", "a.txt"), "hi");
    assert.equal(await host.readFile("o/r", "main", "b.txt"), null);
  });

  test("checksOnSha is failure on any failed run, pending while one runs or only a status exists, none with neither, and success otherwise", async () => {
    const run = (status: string, conclusion: string | null) => ({ status, conclusion });
    const cases: [object[], number, string][] = [
      [[run("completed", "success"), run("completed", "failure")], 0, "failure"],
      [[run("completed", "success"), run("in_progress", null)], 0, "pending"],
      [[], 1, "pending"],
      [[], 0, "none"],
      [[run("completed", "success"), run("completed", "skipped")], 0, "success"],
    ];
    for (const [runs, statuses, want] of cases) {
      const { host } = stubGitHub({
        "GET /repos/{owner}/{repo}/commits/{ref}/check-runs": () => ({ check_runs: runs }),
        "GET /repos/{owner}/{repo}/commits/{ref}/status": () => ({ total_count: statuses }),
      });
      assert.equal(await host.checksOnSha("o/r", "abc"), want);
    }
  });

  test("checksOnHead reads a head with no checks at all as pending", async () => {
    const { host } = stubGitHub({
      "GET /repos/{owner}/{repo}/pulls/{pull_number}": () => pr,
      "GET /repos/{owner}/{repo}/commits/{ref}/check-runs": () => ({ check_runs: [] }),
      "GET /repos/{owner}/{repo}/commits/{ref}/status": () => ({ total_count: 0 }),
    });
    assert.equal(await host.checksOnHead("o/r", 3), "pending");
  });

  test("onBranch is true when the branch is ahead of or at the sha, and false when diverged, behind or unknown", async () => {
    for (const [status, want] of [["ahead", true], ["identical", true], ["diverged", false], ["behind", false]] as const) {
      const { calls, host } = stubGitHub({ "GET /repos/{owner}/{repo}/compare/{basehead}": () => ({ status }) });
      assert.equal(await host.onBranch("o/r", "factory/pbi-1-r1", "abc"), want);
      assert.equal(calls[0].params.basehead, "abc...factory/pbi-1-r1");
    }
    assert.equal(await stubGitHub({}).host.onBranch("o/r", "main", "abc"), false);
  });
});

describe("ownersOf", () => {
  const rules = [
    { pattern: "*", owners: ["@all"] },
    { pattern: "*.md", owners: ["@docs"] },
    { pattern: "/src/billing/", owners: ["@billing"] },
    { pattern: "apps/", owners: ["@apps"] },
  ];
  test("the last matching rule wins, and anchored, unanchored and directory patterns match as GitHub documents", () => {
    assert.deepEqual(ownersOf(rules, "src/a.ts"), ["@all"]);
    assert.deepEqual(ownersOf(rules, "deep/readme.md"), ["@docs"]);
    assert.deepEqual(ownersOf(rules, "src/billing/pay.ts"), ["@billing"]);
    assert.deepEqual(ownersOf(rules, "lib/src/billing/pay.ts"), ["@all"]);
    assert.deepEqual(ownersOf(rules, "x/apps/y.ts"), ["@apps"]);
  });

  test("a rule matches dotfiles and paths under dot directories, as gitignore rules do", () => {
    assert.deepEqual(ownersOf(rules, ".github/workflows/ci.yml"), ["@all"]);
    assert.deepEqual(ownersOf(rules, ".env"), ["@all"]);
    assert.deepEqual(ownersOf([{ pattern: "/docs/", owners: ["@docs"] }], "docs/.x"), ["@docs"]);
    assert.deepEqual(ownersOf([{ pattern: ".factory/", owners: ["@ops"] }], "a/.factory/config.yml"), ["@ops"]);
  });
});
