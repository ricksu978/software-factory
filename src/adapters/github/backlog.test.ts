import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { acceptanceCriteria, githubBacklog, parseGitHubWebhook, splitFiling, type FieldMap } from "./backlog.ts";

const fieldMap: FieldMap = {
  acceptanceCriteriaHeading: "Acceptance criteria", statusField: "Status", optInLabel: "factory", sprintField: null, readinessFields: ["Size"],
  statusFor: { Eligible: null, NotReady: null, Queued: "Todo", InProgress: "In Progress", SignOff: "In Progress", NeedsInput: "In Progress", InReview: "In Review", Accepted: null, Done: "Done", Failed: null, Abandoned: null } as FieldMap["statusFor"],
};
const app = { octokit: { request: async () => ({ data: {} }) }, getInstallationOctokit: async () => ({}) };
const repository = { full_name: "o/r" };

describe("githubBacklog", () => {
  test("a user-owned config with a null projectToken throws at construction, naming the missing secret", () => {
    assert.throws(() => githubBacklog({ app, installationId: 1, owner: { type: "user", login: "me" }, projectToken: null, projectNumber: 1, fieldMap }), /github-project-token/);
    assert.doesNotThrow(() => githubBacklog({ app, installationId: 1, owner: { type: "org", login: "acme" }, projectToken: null, projectNumber: 1, fieldMap }));
  });

  // An org-owned board goes through the installation client, so one stub serves both the board and the issues.
  function orgBoard(comments: { body: string; user: { type: string } }[], failFirstLookup = false) {
    const posted: string[] = [];
    let lookups = 0;
    const client = {
      async request(route: string, params: Record<string, any> = {}) {
        if (route.startsWith("GET") && route.endsWith("/comments")) return { data: comments };
        if (route.startsWith("POST") && route.endsWith("/comments")) posted.push(params.body);
        return { data: {} };
      },
      async graphql(query: string) {
        if (query.includes("projectV2(number")) {
          if (failFirstLookup && lookups++ === 0) throw new Error("rate limited");
          return { organization: { projectV2: { id: "P1", fields: { nodes: [] } } } };
        }
        return { node: { items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{
          id: "I1", updatedAt: "2026-11-06T00:00:00Z", fieldValues: { nodes: [] },
          content: { number: 7, title: "t", body: "", state: "OPEN", updatedAt: "2026-11-06T00:00:00Z", repository: { nameWithOwner: "o/r" }, labels: { nodes: [{ name: "factory" }] } },
        }] } } };
      },
    };
    const adapter = githubBacklog({ app: { octokit: client, getInstallationOctokit: async () => client }, installationId: 1, owner: { type: "org", login: "acme" }, projectToken: null, projectNumber: 1, fieldMap });
    return { adapter, posted };
  }

  test("a dedupe marker posted by a person doesn't stop the factory's comment, and one posted by a bot does", async () => {
    const planted = orgBoard([{ body: "<!-- factory:pr:x -->", user: { type: "User" } }]);
    await planted.adapter.comment("7", "hello", "pr:x");
    assert.equal(planted.posted.length, 1);
    const own = orgBoard([{ body: "<!-- factory:pr:x -->\nhello", user: { type: "Bot" } }]);
    await own.adapter.comment("7", "hello", "pr:x");
    assert.equal(own.posted.length, 0);
  });

  test("a failed project lookup isn't cached, so the next call tries again", async () => {
    const { adapter } = orgBoard([], true);
    await assert.rejects(adapter.getItem("7"), /rate limited/);
    assert.equal((await adapter.getItem("7"))?.externalId, "7");
  });

  test("acceptance criteria are the list under the heading, up to the next heading", () => {
    const body = "Intro\n\n## Acceptance criteria\n\n- [ ] First thing\n- Second thing\n* [x] Third\n\nNot a criterion.\n\n## Notes\n- not this";
    assert.deepEqual(acceptanceCriteria(body, "Acceptance criteria"), ["First thing", "Second thing", "Third"]);
    assert.deepEqual(acceptanceCriteria("no heading", "Acceptance criteria"), []);
  });
});

describe("githubBacklog: the split board (PBI 144)", () => {
  function splitClient() {
    const calls: { route: string; params: Record<string, any> }[] = [];
    const recent: any[] = [
      { id: 900, node_id: "N9", number: 9, title: "planted", body: "factory-split-k-1", html_url: "u9", user: { type: "User" } },
      { id: 800, node_id: "N8", number: 8, title: "a PR", body: "factory-split-k-1", html_url: "u8", user: { type: "Bot" }, pull_request: {} },
      { id: 300, node_id: "N3", number: 3, title: "Card", body: "x factory-split-k-1", html_url: "u3", user: { type: "Bot" } },
    ];
    const client = {
      async request(route: string, params: Record<string, any> = {}) {
        calls.push({ route, params });
        if (route === "GET /repos/{owner}/{repo}/issues") return { data: recent };
        if (route === "POST /repos/{owner}/{repo}/issues") return { data: { id: 500, node_id: "N5", number: 5, title: params.title, html_url: "u5" } };
        if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}") return { data: { id: params.issue_number * 100, node_id: `N${params.issue_number}`, number: params.issue_number } };
        if (route.startsWith("DELETE")) throw Object.assign(new Error("Label does not exist"), { status: 404 });
        return { data: [] };
      },
      async graphql(query: string, vars: Record<string, any> = {}) {
        calls.push({ route: "graphql", params: { query, ...vars } });
        if (query.includes("projectV2(number")) {
          return { organization: { projectV2: { id: "P1", fields: { nodes: [{ id: "F1", name: "Status", options: [{ id: "O1", name: "Backlog" }] }] } } } };
        }
        if (query.includes("addProjectV2ItemById")) return { addProjectV2ItemById: { item: { id: "I5" } } };
        if (query.includes("updateProjectV2ItemFieldValue")) return {};
        return { node: { items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{
          id: "I1", updatedAt: "2026-11-06T00:00:00Z", fieldValues: { nodes: [] },
          content: { number: 7, title: "parent", body: "", state: "OPEN", updatedAt: "2026-11-06T00:00:00Z", repository: { nameWithOwner: "o/r" }, labels: { nodes: [{ name: "factory" }] } },
        }] } } };
      },
    };
    const adapter = githubBacklog({ app: { octokit: client, getInstallationOctokit: async () => client }, installationId: 1, owner: { type: "org", login: "acme" }, projectToken: null, projectNumber: 1, fieldMap });
    return { board: adapter.splitBoard, calls };
  }

  test("findIssues counts only a bot's issues, never a person's or a PR", async () => {
    const { board } = splitClient();
    assert.deepEqual(await board.findIssues("o/r", "factory-split-k-1"), [{ externalId: "3", title: "Card", url: "u3" }]);
  });

  test("a filed child is linked by its id, put on the board in the status and blocked by its blocker's id, off the board", async () => {
    const { board, calls } = splitClient();
    await board.findIssues("o/r", "factory-split-k-1");
    const c = await board.createIssue("o/r", "Bank", "body");
    assert.deepEqual(calls.at(-1)!.params, { owner: "o", repo: "r", title: "Bank", body: "body" });
    assert.equal(await board.boardStatus(c.externalId), null);
    await board.addSubIssue("7", c.externalId);
    assert.deepEqual(calls.at(-1), { route: "POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues", params: { owner: "o", repo: "r", issue_number: 7, sub_issue_id: 500 } });
    await board.addToBoard(c.externalId, "Backlog");
    const gql = calls.filter((x) => x.route === "graphql").map((x) => x.params);
    assert.ok(gql.some((v) => v.query.includes("addProjectV2ItemById") && v.content === "N5" && v.project === "P1"));
    assert.ok(gql.some((v) => v.query.includes("updateProjectV2ItemFieldValue") && v.item === "I5" && v.option === "O1"));
    await board.addBlockedBy(c.externalId, "3");
    assert.deepEqual(calls.at(-1), { route: "POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by", params: { owner: "o", repo: "r", issue_number: 5, issue_id: 300 } });
  });

  test("taking off a label the parent lacks succeeds", async () => {
    const { board } = splitClient();
    await board.removeLabel("7", "factory");
  });

  test("splitFiling uses the board's Eligible status, and a field map without one only proposes", () => {
    const { board } = splitClient();
    const withBacklog = { ...fieldMap, statusFor: { ...fieldMap.statusFor, Eligible: "Backlog" } };
    assert.deepEqual(splitFiling(board, withBacklog), { board, optInLabel: "factory", backlogStatus: "Backlog", criteriaHeading: "Acceptance criteria" });
    assert.equal(splitFiling(board, fieldMap), undefined);
  });
});

describe("parseGitHubWebhook", () => {
  const h = (event: string) => ({ "x-github-event": event });

  test("an issue_comment created maps to comment, and one by a bot user is ignored", () => {
    const body = { action: "created", repository, issue: { number: 11 }, comment: { id: 99, body: "/approve", user: { login: "ricksu978", type: "User" } } };
    assert.deepEqual(parseGitHubWebhook(h("issue_comment"), body), { kind: "comment", externalId: "11", repo: repository.full_name, login: "ricksu978", body: "/approve", commentId: "99" });
    const own = { ...body, comment: { ...body.comment, user: { login: "ricksu978-software-factory[bot]", type: "Bot" } } };
    assert.deepEqual(parseGitHubWebhook(h("issue_comment"), own), { kind: "ignored" });
    assert.deepEqual(parseGitHubWebhook(h("issue_comment"), { ...body, action: "edited" }), { kind: "ignored" });
  });

  test("a pull_request_review submitted maps to review with the state lowercased and the author's login", () => {
    const body = { action: "submitted", repository, pull_request: { number: 5 }, review: { state: "CHANGES_REQUESTED", submitted_at: "2026-11-06T01:00:00Z", user: { login: "dev", type: "User" } } };
    assert.deepEqual(parseGitHubWebhook(h("pull_request_review"), body), { kind: "review", prNumber: 5, repo: "o/r", state: "changes_requested", submittedAt: "2026-11-06T01:00:00Z", author: "dev" });
  });

  test("issues, merged and closed PRs and completed check suites map to their events", () => {
    assert.deepEqual(parseGitHubWebhook(h("issues"), { action: "labeled", repository, issue: { number: 3 } }), { kind: "item_changed", externalId: "3" });
    assert.deepEqual(parseGitHubWebhook(h("pull_request"), { action: "closed", repository, pull_request: { number: 5, merged: true, merge_commit_sha: "m1" } }), { kind: "pr_merged", prNumber: 5, repo: "o/r", mergeSha: "m1" });
    assert.deepEqual(parseGitHubWebhook(h("pull_request"), { action: "closed", repository, sender: { login: "dev" }, pull_request: { number: 5, merged: false } }), { kind: "pr_closed", prNumber: 5, repo: "o/r", by: "dev" });
    // A bot's close still maps, naming the bot, so the webhook can tell the factory's own App from any other.
    assert.deepEqual(parseGitHubWebhook(h("pull_request"), { action: "closed", repository, sender: { login: "github-actions[bot]", type: "Bot" }, pull_request: { number: 5, merged: false } }), { kind: "pr_closed", prNumber: 5, repo: "o/r", by: "github-actions[bot]" });
    assert.deepEqual(parseGitHubWebhook(h("check_suite"), { action: "completed", repository, check_suite: { head_sha: "s1" } }), { kind: "checks_completed", sha: "s1", repo: "o/r" });
  });

  test("unknown or malformed payloads are ignored and never throw", () => {
    for (const [event, body] of [["nonsense", {}], ["issue_comment", null], ["pull_request", "x"], ["issue_comment", { action: "created", issue: {} }]] as [string, unknown][]) {
      assert.deepEqual(parseGitHubWebhook(h(event), body), { kind: "ignored" });
    }
    assert.deepEqual(parseGitHubWebhook({}, undefined), { kind: "ignored" });
  });
});
