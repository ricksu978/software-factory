import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ciFailureOf } from "./cell-api.ts";

// PBI 292: Floor and Run detail link each check URL a cell sends in `ciFailure`, so POST /stage takes only https
// links under the run's repo and gives 400 for any other, a `javascript:` one included.
describe("ciFailureOf", () => {
  const repo = "https://github.com/acme/widgets";
  const failure = (url: string) => ({ sha: "abc1234", checks: [{ name: "ci", url, failingTests: ["parses config"] }] });
  const rejects = (url: string, repoUrl: string | null = repo) =>
    assert.throws(() => ciFailureOf(failure(url), repoUrl), (e: Error) => e.constructor.name === "BadRequest" && /url must start with/.test(e.message));

  test("keeps a check URL under the run's repo", () => {
    const url = `${repo}/actions/runs/7201/job/9`;
    assert.deepEqual(ciFailureOf(failure(url), repo), { sha: "abc1234", checks: [{ name: "ci", url, failingTests: ["parses config"] }] });
    assert.equal(ciFailureOf(failure(url), `${repo}/`).checks[0].url, url);
  });

  test("keeps an empty check URL, which GitHub sends as a null html_url, as no link", () => {
    assert.equal(ciFailureOf(failure(""), repo).checks[0].url, "");
    assert.equal(ciFailureOf(failure(""), null).checks[0].url, "");
  });

  test("gives 400 for a javascript:, http or data URL, or one outside the run's repo", () => {
    rejects("javascript:alert(document.cookie)");
    rejects(" javascript:alert(1)");
    rejects(" ");
    rejects("http://github.com/acme/widgets/actions/runs/1");
    rejects("data:text/html,<script>alert(1)</script>");
    rejects("https://github.com/acme/widgets-evil/actions/runs/1");
    rejects("https://github.com/other/repo/actions/runs/1");
    rejects("https://github.com.evil.example/acme/widgets/actions/runs/1");
  });

  test("takes only a github.com https URL for a run with no repo yet", () => {
    assert.equal(ciFailureOf(failure("https://github.com/acme/widgets/actions/runs/1"), null).checks[0].url, "https://github.com/acme/widgets/actions/runs/1");
    rejects("javascript:alert(1)", null);
    rejects("https://evil.example/x", null);
  });
});
