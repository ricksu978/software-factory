import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fakeRepoHost } from "../fake.ts";
import { githubRepoHost, ownersOf, type GitHubClient } from "./repo-host.ts";

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

  test("prState takes the newest changes-requested review from a trusted login and ignores a stranger's newer one", async () => {
    const reviews = [
      { state: "CHANGES_REQUESTED", submitted_at: "2026-11-06T01:00:00Z", user: { login: "Owner" } },
      { state: "APPROVED", submitted_at: "2026-11-06T03:00:00Z", user: { login: "owner" } },
      { state: "CHANGES_REQUESTED", submitted_at: "2026-11-06T04:00:00Z", user: { login: "stranger" } },
    ];
    const { host } = stubGitHub({
      "GET /repos/{owner}/{repo}/pulls/{pull_number}": () => ({ merged: false, merge_commit_sha: "tmp", state: "open", mergeable: true }),
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews": () => reviews,
    });
    assert.deepEqual(await host.prState("o/r", 3, ["owner"]), { merged: false, mergeSha: null, open: true, mergeable: true, lastChangesRequestedAt: "2026-11-06T01:00:00Z" });
    assert.equal((await host.prState("o/r", 3, [])).lastChangesRequestedAt, null);
  });

  test("openReviewComments returns every comment in unresolved threads and none from resolved ones", async () => {
    const thread = (id: string, isResolved: boolean, body: string) => ({ id, isResolved, path: "a.ts", line: 4, comments: { nodes: [{ author: { login: "dev" }, body }] } });
    const { host } = stubGitHub({}, () => ({ repository: { pullRequest: { reviewThreads: { nodes: [thread("t1", true, "done"), thread("t2", false, "fix this")] } } } }));
    assert.deepEqual(await host.openReviewComments("o/r", 3), [{ threadId: "t2", path: "a.ts", line: 4, author: "dev", body: "fix this" }]);
  });

  test("fakeRepoHost passes the same resolved-thread case", async () => {
    const fake = fakeRepoHost();
    fake.reviewComments.set("o/r#3", [
      { threadId: "t1", path: "a.ts", line: 4, author: "dev", body: "done", resolved: true },
      { threadId: "t2", path: "a.ts", line: 4, author: "dev", body: "fix this" },
    ]);
    assert.deepEqual(await fake.openReviewComments("o/r", 3), [{ threadId: "t2", path: "a.ts", line: 4, author: "dev", body: "fix this" }]);
  });

  test("readFile decodes a file and gives null for a missing one", async () => {
    const { host } = stubGitHub({ "GET /repos/{owner}/{repo}/contents/{path}": (p) => (p.path === "a.txt" ? { type: "file", content: b64("hi") } : (() => { throw Object.assign(new Error("404"), { status: 404 }); })()) });
    assert.equal(await host.readFile("o/r", "main", "a.txt"), "hi");
    assert.equal(await host.readFile("o/r", "main", "b.txt"), null);
  });

  test("checksOnSha is failure on any failed run, pending while one runs or none exist, and success otherwise", async () => {
    const run = (status: string, conclusion: string | null) => ({ status, conclusion });
    const cases: [object[], string][] = [
      [[run("completed", "success"), run("completed", "failure")], "failure"],
      [[run("completed", "success"), run("in_progress", null)], "pending"],
      [[], "pending"],
      [[run("completed", "success"), run("completed", "skipped")], "success"],
    ];
    for (const [runs, want] of cases) {
      const { host } = stubGitHub({ "GET /repos/{owner}/{repo}/commits/{ref}/check-runs": () => ({ check_runs: runs }) });
      assert.equal(await host.checksOnSha("o/r", "abc"), want);
    }
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
});
