import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fakeRepoHost } from "../adapters/fake.ts";
import type { CiCheck } from "../adapters/types.ts";
import { ciChangeDetail, headCiFailure } from "./ci-head.ts";

const REPO = "acme/widgets";
const url = (n: number) => `https://github.com/acme/widgets/actions/runs/${n}`;

function host(head: string | null) {
  const h = fakeRepoHost();
  h.prs.push({
    number: 57, repo: REPO, branch: "factory/pbi-482-r1", base: "main", title: "t", body: "", headSha: head, open: true, merged: false,
    mergeSha: null, mergeable: true, reviewers: [], comments: [], reviews: [],
  });
  return h;
}
function report(h: ReturnType<typeof host>, sha: string, checks: CiCheck[]) {
  h.ciChecks.set(`${REPO}@${sha}`, checks);
  h.checks.set(`${REPO}@${sha}`, checks.some((c) => c.conclusion === "failure") ? "failure" : checks.some((c) => c.conclusion === "pending") ? "pending" : "success");
}

describe("headCiFailure", () => {
  test("gives each failed check on the PR's head, and none that passed", async () => {
    const h = host("c0ffee1");
    report(h, "c0ffee1", [
      { name: "lint", conclusion: "success", url: url(7300) },
      { name: "ci", conclusion: "failure", url: url(7301), failingTests: ["totals include VAT"] },
    ]);
    assert.deepEqual(await headCiFailure(h, REPO, 57), { sha: "c0ffee1", checks: [{ name: "ci", url: url(7301), failingTests: ["totals include VAT"] }] });
  });

  test("is null while CI still runs on the head, once it passed there, and with no head", async () => {
    const h = host("c0ffee1");
    report(h, "c0ffee1", [{ name: "ci", conclusion: "pending", url: url(1) }]);
    assert.equal(await headCiFailure(h, REPO, 57), null);
    report(h, "c0ffee1", [{ name: "ci", conclusion: "success", url: url(1) }]);
    assert.equal(await headCiFailure(h, REPO, 57), null);
    assert.equal(await headCiFailure(host(null), REPO, 57), null);
  });

  test("is null for a failure that names no failed check, which only holds the merge (PBI 181)", async () => {
    const h = host("c0ffee1");
    h.checks.set(`${REPO}@c0ffee1`, "failure");
    assert.equal(await headCiFailure(h, REPO, 57), null);
    report(h, "c0ffee1", [{ name: "ci", conclusion: "failure", url: url(1) }]);
    assert.equal((await headCiFailure(h, REPO, 57))?.checks.length, 1);
  });

  test("ignores a failure on a commit that isn't the head", async () => {
    const h = host("c0ffee2");
    report(h, "c0ffee1", [{ name: "ci", conclusion: "failure", url: url(1) }]);
    report(h, "c0ffee2", [{ name: "ci", conclusion: "pending", url: url(2) }]);
    assert.equal(await headCiFailure(h, REPO, 57), null);
    assert.equal(await headCiFailure(h, REPO, 57, "c0ffee1"), null);
  });

  test("only reads CI when the commit it's told of is the head", async () => {
    const h = host("c0ffee1");
    report(h, "c0ffee1", [{ name: "ci", conclusion: "failure", url: url(1) }]);
    assert.equal((await headCiFailure(h, REPO, 57, "c0ffee1"))?.sha, "c0ffee1");
    assert.equal(await headCiFailure(h, REPO, 57, "0ldc0de"), null);
  });
});

describe("ciChangeDetail", () => {
  test("names the failure as the cause, and holds Green's findings for it", () => {
    const f = { sha: "c0ffee1", checks: [{ name: "ci", url: url(7301), failingTests: [] }] };
    const d = ciChangeDetail(f);
    assert.deepEqual(d.cause, { kind: "ci_failed", ...f });
    assert.equal(d.findings.length, 1);
    assert.match(d.findings[0], /^CI failed on c0ffee1: the check "ci" failed, .*7301\. CI named no failing test/);
  });
});
