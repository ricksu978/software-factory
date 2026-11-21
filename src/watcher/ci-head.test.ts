import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fakeRepoHost } from "../adapters/fake.ts";
import type { CiCheck } from "../adapters/types.ts";
import { ciChangeDetail, headCiFailure, type RerunLedger } from "./ci-head.ts";

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
    assert.equal(await headCiFailure(h, REPO, 57, { sha: "c0ffee1" }), null);
  });

  test("only reads CI when the commit it's told of is the head", async () => {
    const h = host("c0ffee1");
    report(h, "c0ffee1", [{ name: "ci", conclusion: "failure", url: url(1) }]);
    assert.equal((await headCiFailure(h, REPO, 57, { sha: "c0ffee1" }))?.sha, "c0ffee1");
    assert.equal(await headCiFailure(h, REPO, 57, { sha: "0ldc0de" }), null);
  });

  test("reads CI on the head it's given, without reading the PR again", async () => {
    const h = host("c0ffee1");
    let views = 0;
    const view = h.mergeView.bind(h);
    h.mergeView = async (...a) => { views++; return view(...a); };
    report(h, "c0ffee2", [{ name: "ci", conclusion: "failure", url: url(2) }]);
    assert.equal((await headCiFailure(h, REPO, 57, { head: "c0ffee2" }))?.sha, "c0ffee2");
    assert.equal(await headCiFailure(h, REPO, 57, { head: null }), null);
    assert.equal(views, 0);
  });

  test("is null when the base commit fails every test the head fails, so the base keeps the failure (PBI 215)", async () => {
    const h = host("c0ffee1");
    h.heads.set(REPO, "ma1n001");
    report(h, "c0ffee1", [{ name: "ci", conclusion: "failure", url: url(1), failingTests: ["totals include VAT"] }]);
    report(h, "ma1n001", [{ name: "ci", conclusion: "failure", url: url(9), failingTests: ["totals include VAT", "signs in"] }]);
    assert.equal(await headCiFailure(h, REPO, 57), null);
  });

  test("still fails the head when the base fails other tests, passed, can't be read, or the check names no test", async () => {
    const h = host("c0ffee1");
    report(h, "c0ffee1", [{ name: "ci", conclusion: "failure", url: url(1), failingTests: ["totals include VAT"] }]);
    assert.equal((await headCiFailure(h, REPO, 57))?.sha, "c0ffee1", "no default branch head to read");
    h.heads.set(REPO, "ma1n001");
    report(h, "ma1n001", [{ name: "ci", conclusion: "failure", url: url(9), failingTests: ["signs in"] }]);
    assert.equal((await headCiFailure(h, REPO, 57))?.sha, "c0ffee1");
    report(h, "ma1n001", [{ name: "ci", conclusion: "success", url: url(9) }]);
    assert.equal((await headCiFailure(h, REPO, 57))?.sha, "c0ffee1");
    report(h, "c0ffee1", [{ name: "ci", conclusion: "failure", url: url(1) }]);
    report(h, "ma1n001", [{ name: "ci", conclusion: "failure", url: url(9) }]);
    assert.equal((await headCiFailure(h, REPO, 57))?.sha, "c0ffee1");
  });
});

function ledger() {
  const rows = new Map<string, { checks: string[]; requestedAt: Date }>();
  const l: RerunLedger = {
    async get(sha) { return rows.get(sha) ?? null; },
    async claim(sha, checks, requestedAt) { if (rows.has(sha)) return false; rows.set(sha, { checks, requestedAt }); return true; },
    async settle(sha, checks) { if (checks.length) rows.get(sha)!.checks = checks; else rows.delete(sha); },
  };
  return { rows, l };
}

describe("headCiFailure re-runs the failed checks once first (PBI 233)", () => {
  test("re-runs the failed checks once, waits while GitHub still shows the old run, and fails the head once the re-run fails", async () => {
    const h = host("c0ffee1");
    const { rows, l } = ledger();
    const old = new Date(Date.now() - 60_000).toISOString();
    report(h, "c0ffee1", [
      { name: "lint", conclusion: "success", url: url(7300), completedAt: old },
      { name: "ci", conclusion: "failure", url: url(7301), completedAt: old },
    ]);
    assert.equal(await headCiFailure(h, REPO, 57, {}, l), null, "the read right after the ask still shows the old run");
    assert.deepEqual(h.reruns, [{ key: `${REPO}@c0ffee1`, checks: ["ci"] }]);
    assert.deepEqual(rows.get("c0ffee1")?.checks, ["ci"]);
    report(h, "c0ffee1", [{ name: "lint", conclusion: "success", url: url(7300), completedAt: old }, { name: "ci", conclusion: "pending", url: url(7305) }]);
    assert.equal(await headCiFailure(h, REPO, 57, {}, l), null, "the re-run is still running");
    report(h, "c0ffee1", [
      { name: "lint", conclusion: "success", url: url(7300), completedAt: old },
      { name: "ci", conclusion: "failure", url: url(7305), completedAt: new Date(Date.now() + 1000).toISOString() },
    ]);
    assert.equal((await headCiFailure(h, REPO, 57, {}, l))?.checks[0].url, url(7305));
    assert.equal(h.reruns.length, 1, "a commit's checks are re-run once");
  });

  test("leaves the item in review when the re-run passes", async () => {
    const h = host("c0ffee1");
    const { l } = ledger();
    report(h, "c0ffee1", [{ name: "ci", conclusion: "failure", url: url(1), completedAt: new Date(Date.now() - 60_000).toISOString() }]);
    assert.equal(await headCiFailure(h, REPO, 57, {}, l), null);
    report(h, "c0ffee1", [{ name: "ci", conclusion: "success", url: url(2), completedAt: new Date(Date.now() + 1000).toISOString() }]);
    assert.equal(await headCiFailure(h, REPO, 57, {}, l), null);
    assert.equal(h.reruns.length, 1);
  });

  test("takes a check with no finish time as it reads after the re-run, so a re-run that fails at once fails the head", async () => {
    const h = host("c0ffee1");
    const { l } = ledger();
    report(h, "c0ffee1", [{ name: "ci", conclusion: "failure", url: url(1) }]);
    assert.equal((await headCiFailure(h, REPO, 57, {}, l))?.sha, "c0ffee1");
    assert.equal(h.reruns.length, 1);
  });

  test("keeps the old run stale even when the factory's clock is behind GitHub's", async () => {
    const h = host("c0ffee1");
    const { l } = ledger();
    report(h, "c0ffee1", [{ name: "ci", conclusion: "failure", url: url(1), completedAt: new Date(Date.now() + 30_000).toISOString() }]);
    assert.equal(await headCiFailure(h, REPO, 57, {}, l), null);
  });

  test("asks for no re-run when the commit's checks were re-run already, by the cell or an earlier read", async () => {
    const h = host("c0ffee1");
    const { rows, l } = ledger();
    rows.set("c0ffee1", { checks: ["ci"], requestedAt: new Date(Date.now() - 120_000) });
    report(h, "c0ffee1", [{ name: "ci", conclusion: "failure", url: url(2), completedAt: new Date(Date.now() - 60_000).toISOString() }]);
    assert.equal((await headCiFailure(h, REPO, 57, {}, l))?.sha, "c0ffee1");
    assert.equal(h.reruns.length, 0);
  });

  test("waits for checks still running before asking, so a check that fails later is re-run too", async () => {
    const h = host("c0ffee1");
    const { l } = ledger();
    report(h, "c0ffee1", [{ name: "ci", conclusion: "failure", url: url(1) }, { name: "e2e", conclusion: "pending", url: url(2) }]);
    assert.equal(await headCiFailure(h, REPO, 57, {}, l), null);
    assert.equal(h.reruns.length, 0);
  });

  test("lets the failure stand when the host refuses the re-run, and drops the record", async () => {
    const h = host("c0ffee1");
    const { rows, l } = ledger();
    h.rerunChecksOnSha = async () => { throw new Error("This workflow run is not retryable"); };
    report(h, "c0ffee1", [{ name: "ci", conclusion: "failure", url: url(1), completedAt: new Date(Date.now() - 60_000).toISOString() }]);
    assert.equal((await headCiFailure(h, REPO, 57, {}, l))?.sha, "c0ffee1");
    assert.equal(rows.size, 0);
  });

  test("leaves the item in review when GitHub fails to answer the ask, so the next read asks again", async () => {
    const h = host("c0ffee1");
    const { rows, l } = ledger();
    h.rerunChecksOnSha = async () => { throw Object.assign(new Error("bad gateway"), { name: "HttpError", status: 502 }); };
    report(h, "c0ffee1", [{ name: "ci", conclusion: "failure", url: url(1) }]);
    await assert.rejects(headCiFailure(h, REPO, 57, {}, l), /bad gateway/);
    assert.equal(rows.size, 0);
  });

  test("leaves the item in review when the re-run fails tests the base fails too", async () => {
    const h = host("c0ffee1");
    const { l } = ledger();
    h.heads.set(REPO, "ma1n001");
    report(h, "c0ffee1", [{ name: "ci", conclusion: "failure", url: url(1), failingTests: ["totals include VAT"] }]);
    report(h, "ma1n001", [{ name: "ci", conclusion: "failure", url: url(9), failingTests: ["totals include VAT"] }]);
    assert.equal(await headCiFailure(h, REPO, 57, {}, l), null);
    assert.equal(h.reruns.length, 1);
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
