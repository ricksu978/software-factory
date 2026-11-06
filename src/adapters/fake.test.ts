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

describe("fake backlog isolation", () => {
  test("items share no state with the caller's input, with each other, or with what getItem returns", async () => {
    const t = fakeBacklog();
    const labels = ["factory"];
    const a = await t.seed({ labels });
    const b = await t.seed({ labels });
    await t.adapter.claim(a);
    assert.deepEqual(labels, ["factory"]);
    assert.deepEqual((await t.adapter.getItem(b))?.labels, ["factory"]);
    const read = await t.adapter.getItem(a);
    assert.ok(read);
    read.fields.x = "leak";
    read.acceptanceCriteria.push("leak");
    const again = await t.adapter.getItem(a);
    assert.deepEqual(again?.fields, {});
    assert.deepEqual(again?.acceptanceCriteria, ["it works"]);
  });

  test("an auto id never reuses an id a test seeded explicitly", async () => {
    const t = fakeBacklog();
    const explicit = await t.seed({ externalId: "2", title: "explicit" });
    const auto = await t.seed({});
    assert.notEqual(auto, explicit);
    assert.equal((await t.adapter.getItem(explicit))?.title, "explicit");
    assert.equal((await t.adapter.listEligible(null)).items.length, 2);
  });
});

describe("fakeRepoHost", () => {
  test("openReviewComments returns comments from unresolved threads only", async () => {
    const host = fakeRepoHost();
    const comment = { path: "a.ts", line: 1, author: "owner", body: "fix" };
    host.reviewComments.set("octo/repo#1", [
      { ...comment, threadId: "open" },
      { ...comment, threadId: "done", resolved: true },
    ]);
    assert.deepEqual(await host.openReviewComments("octo/repo", 1), [{ ...comment, threadId: "open" }]);
  });

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
