import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { acceptanceCriteria, githubBacklog, parseGitHubWebhook, type FieldMap } from "./backlog.ts";

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

  test("acceptance criteria are the list under the heading, up to the next heading", () => {
    const body = "Intro\n\n## Acceptance criteria\n\n- [ ] First thing\n- Second thing\n* [x] Third\n\nNot a criterion.\n\n## Notes\n- not this";
    assert.deepEqual(acceptanceCriteria(body, "Acceptance criteria"), ["First thing", "Second thing", "Third"]);
    assert.deepEqual(acceptanceCriteria("no heading", "Acceptance criteria"), []);
  });
});

describe("parseGitHubWebhook", () => {
  const h = (event: string) => ({ "x-github-event": event });

  test("an issue_comment created maps to comment, and one by a bot user is ignored", () => {
    const body = { action: "created", repository, issue: { number: 11 }, comment: { id: 99, body: "/approve", user: { login: "ricksu978", type: "User" } } };
    assert.deepEqual(parseGitHubWebhook(h("issue_comment"), body), { kind: "comment", externalId: "11", login: "ricksu978", body: "/approve", commentId: "99" });
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
    assert.deepEqual(parseGitHubWebhook(h("pull_request"), { action: "closed", repository, pull_request: { number: 5, merged: false } }), { kind: "pr_closed", prNumber: 5, repo: "o/r" });
    assert.deepEqual(parseGitHubWebhook(h("check_suite"), { action: "completed", repository, check_suite: { head_sha: "s1" } }), { kind: "checks_completed", sha: "s1", repo: "o/r" });
  });

  test("unknown or malformed payloads are ignored and never throw", () => {
    for (const [event, body] of [["nonsense", {}], ["issue_comment", null], ["pull_request", "x"], ["issue_comment", { action: "created", issue: {} }]] as [string, unknown][]) {
      assert.deepEqual(parseGitHubWebhook(h(event), body), { kind: "ignored" });
    }
    assert.deepEqual(parseGitHubWebhook({}, undefined), { kind: "ignored" });
  });
});
