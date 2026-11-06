import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { backlogContract } from "./contract.ts";
import { fakeBacklog, fakeRepoHost } from "./fake.ts";

backlogContract("fake", async () => fakeBacklog());

describe("fake backlog cursor", () => {
  test("a second listEligible from the returned cursor sees only items changed since", async () => {
    const t = fakeBacklog();
    const a = await t.seed({});
    const first = await t.adapter.listEligible(null);
    assert.deepEqual(first.items.map((i) => i.externalId), [a]);
    assert.deepEqual((await t.adapter.listEligible(first.cursor)).items, []);
    await t.adapter.setStatus(a, "Ready");
    assert.deepEqual((await t.adapter.listEligible(first.cursor)).items.map((i) => i.status), ["Ready"]);
  });
});

describe("fakeRepoHost", () => {
  const repo = "octo/repo";

  test("openOrUpdatePr updates the open PR for a branch, and opens a new one once that closes", async () => {
    const host = fakeRepoHost();
    const pr = { repo, branch: "factory/pbi-1-r1", base: "main", title: "t", body: "b" };
    const first = await host.openOrUpdatePr(pr);
    assert.deepEqual(await host.openOrUpdatePr({ ...pr, title: "t2" }), first);
    assert.equal(host.prs[0].title, "t2");
    await host.closePr(repo, first.number, "closing");
    assert.notEqual((await host.openOrUpdatePr(pr)).number, first.number);
  });

  test("prState counts only changes-requested reviews from trusted logins", async () => {
    const host = fakeRepoHost();
    const { number } = await host.openOrUpdatePr({ repo, branch: "b", base: "main", title: "t", body: "" });
    host.prs[0].reviews.push(
      { state: "changes_requested", submittedAt: "2026-11-06T10:00:00Z", author: "owner" },
      { state: "changes_requested", submittedAt: "2026-11-06T11:00:00Z", author: "stranger" },
    );
    assert.equal((await host.prState(repo, number, ["owner"])).lastChangesRequestedAt, "2026-11-06T10:00:00Z");
    assert.equal((await host.prState(repo, number, [])).lastChangesRequestedAt, null);
  });

  test("checks, files and the default branch come from the state tests set", async () => {
    const host = fakeRepoHost();
    const { number } = await host.openOrUpdatePr({ repo, branch: "b", base: "main", title: "t", body: "" });
    assert.equal(await host.checksOnHead(repo, number), "pending");
    host.prs[0].headSha = "abc";
    host.checks.set(`${repo}@abc`, "success");
    assert.equal(await host.checksOnHead(repo, number), "success");
    host.files.set(`${repo}@main:.factory/dod.md`, "- [ ] done");
    assert.equal(await host.readFile(repo, "main", ".factory/dod.md"), "- [ ] done");
    assert.equal(await host.readFile(repo, "main", ".factory/dor.md"), null);
    await assert.rejects(host.defaultBranchSha(repo));
    host.heads.set(repo, "def");
    assert.equal(await host.defaultBranchSha(repo), "def");
  });
});
