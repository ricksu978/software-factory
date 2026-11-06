import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { fakeBacklog, fakeRepoHost } from "../adapters/fake.ts";
import type { FactoryItem } from "../adapters/types.ts";
import type { Policy } from "../policy/policy.ts";
import { dbTest, startTestDb } from "../store/test-db.ts";
import { criteriaHash, pollOnce } from "./poller.ts";

const REPO = "octo/repo";
const files = {
  ".factory/config.yml": "bdd:\n  parse: p\n  run: r\n  report: x.ndjson\ncommands:\n  test: t\n  lint: l\n",
  ".factory/dod.md": "- [ ] Tests pass\n",
  ".factory/dor.md": "- [ ] Has a title\n",
};

describe("pollOnce", dbTest, () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let fake: ReturnType<typeof fakeBacklog>;
  let host: ReturnType<typeof fakeRepoHost>;
  let sourceId: string;
  let verdict: "passed" | "failed" | "throw";
  let judged: string[];

  const judge = async (item: FactoryItem, dor: Policy) => {
    judged.push(item.externalId);
    if (verdict === "throw" || (verdict === "passed" && item.title === "boom")) throw new Error("usage limit");
    return [...dor.criteria.map((c) => JSON.stringify({ index: c.index, status: verdict, reason: "because" })), JSON.stringify({ flags: [] })].join("\n");
  };
  const poll = () => pollOnce({ pool: db.pool, adapter: fake.adapter, repoHost: host, judge, sourceId });
  const commit = (sha: string, set: Record<string, string>) => {
    for (const [p, t] of Object.entries(set)) host.files.set(`${REPO}@${sha}:${p}`, t);
    host.heads.set(REPO, sha);
  };
  const row = async (ext: string) =>
    (await db.pool.query("select id, state, blocked_by, readiness_policy_sha, criteria_hash from item where source_id = $1 and external_id = $2", [sourceId, ext])).rows[0];
  const seed = (extra: Partial<FactoryItem> = {}) => fake.seed({ labels: ["factory"], repo: REPO, ...extra });

  /** An item the factory already holds in `state`, with an open run, optionally with a PR. */
  async function held(state: string, opts: { pr?: boolean; criteriaHash?: string; reviewsSeenAt?: string } = {}) {
    const ext = await seed();
    const id = (await db.pool.query<{ id: string }>(
      "insert into item (source_id, external_id, title, state, criteria_hash) values ($1, $2, 't', $3, $4) returning id",
      [sourceId, ext, state, opts.criteriaHash ?? null],
    )).rows[0].id;
    const pr = opts.pr ? (await host.openOrUpdatePr({ repo: REPO, branch: `factory/pbi-${ext}-r1`, base: "main", title: "t", body: "" })).number : null;
    const run = (await db.pool.query<{ id: string }>(
      "insert into run (item_id, run_number, next_stage, branch, pr_number, reviews_seen_at) values ($1, 1, 'open-pr', $2, $3, $4) returning id",
      [id, `factory/pbi-${ext}-r1`, pr, opts.reviewsSeenAt ?? new Date().toISOString()],
    )).rows[0].id;
    return { ext, id, pr, run };
  }

  before(async () => {
    db = await startTestDb();
  });
  after(async () => {
    await db?.stop();
  });
  beforeEach(async () => {
    await db.pool.query('truncate item, backlog_source, repo, "user" cascade');
    fake = fakeBacklog();
    host = fakeRepoHost();
    commit("c1", files);
    sourceId = (await db.pool.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'unit') returning id")).rows[0].id;
    await db.pool.query("insert into repo (host_adapter, url) values ('fake', $1)", [`https://github.com/${REPO}`]);
    verdict = "passed";
    judged = [];
  });

  test("an item that passes the gate is Queued, with its results and readiness sha stored", async () => {
    const ext = await seed();
    await poll();
    const r = await row(ext);
    assert.equal(r.state, "Queued");
    assert.match(r.readiness_policy_sha, /^[0-9a-f]{64}$/);
    const results = (await db.pool.query("select file, source, criterion_index, criterion, status, checked_sha from policy_result where item_id = $1", [r.id])).rows;
    assert.deepEqual(results, [{ file: "dor", source: "repo", criterion_index: 1, criterion: "Has a title", status: "passed", checked_sha: "c1" }]);
  });

  test("an item that fails the gate is NotReady with a reasons comment", async () => {
    verdict = "failed";
    const ext = await seed();
    await poll();
    assert.equal((await row(ext)).state, "NotReady");
    assert.match((await fake.comments(ext))[0], /Has a title/);
  });

  test("an edit to a NotReady item moves it back to Eligible and gates it again", async () => {
    verdict = "failed";
    const ext = await seed();
    await poll();
    verdict = "passed";
    await fake.seed({ externalId: ext, labels: ["factory"], repo: REPO, body: "Now with a clearer scope." });
    await poll();
    assert.equal((await row(ext)).state, "Queued");
    const events = (await db.pool.query("select payload->>'event' as e from event where item_id = $1 order by at", [(await row(ext)).id])).rows.map((x) => x.e);
    assert.deepEqual(events, ["readiness_failed", "item_edited", "ready"]);
  });

  test("the factory's own board write doesn't re-gate a NotReady item", async () => {
    verdict = "failed";
    const ext = await seed();
    await poll();
    await fake.adapter.setStatus(ext, "Not ready");
    judged = [];
    await poll();
    assert.equal((await row(ext)).state, "NotReady");
    assert.deepEqual(judged, []);
    assert.equal((await fake.comments(ext)).length, 1);
  });

  test("an Eligible or NotReady item that left the backlog is never gated into Queued", async () => {
    verdict = "failed";
    const notReady = await seed();
    await poll();
    verdict = "throw";
    const eligible = await seed();
    await poll();
    assert.deepEqual([(await row(notReady)).state, (await row(eligible)).state], ["NotReady", "Eligible"]);
    await fake.seed({ externalId: eligible, labels: [], repo: REPO });
    await fake.adapter.close(notReady);
    verdict = "passed";
    commit("c2", { ...files, ".factory/dor.md": "- [ ] Has a title\n\nEdited.\n" });
    judged = [];
    await poll();
    assert.equal((await row(eligible)).state, "Eligible");
    assert.equal((await row(notReady)).state, "NotReady");
    assert.deepEqual(judged, []);
  });

  test("an item NotReady only on an open dependency is re-gated once the dependency closes", async () => {
    const ext = await seed();
    fake.setDependencies(ext, ["#7"]);
    await poll();
    assert.equal((await row(ext)).state, "NotReady");
    assert.match((await fake.comments(ext))[0], /depends on #7/);
    fake.setDependencies(ext, []);
    await poll();
    assert.equal((await row(ext)).state, "Queued");
  });

  test("a listed item that fails to go in keeps the cursor, so the next poll lists it again", async () => {
    const before = (await db.pool.query("select cursor from backlog_source where id = $1", [sourceId])).rows[0].cursor;
    const fine = await seed();
    // Postgres refuses a NUL in a text column, so this one item can't be stored.
    await seed({ externalId: `bad${String.fromCharCode(0)}id` });
    await poll();
    assert.equal((await db.pool.query("select cursor from backlog_source where id = $1", [sourceId])).rows[0].cursor, before);
    assert.equal((await row(fine)).state, "Queued");
  });

  test("the opt-in label comes from the source's field map", async () => {
    await db.pool.query(`update backlog_source set field_map = '{"optInLabel": "ready-for-factory"}' where id = $1`, [sourceId]);
    const { ext } = await held("Queued");
    await poll();
    assert.equal((await row(ext)).state, "Abandoned");
  });

  test("a Done item that loses its label is left alone", async () => {
    const ext = await seed();
    await db.pool.query("insert into item (source_id, external_id, title, state) values ($1, $2, 't', 'Done')", [sourceId, ext]);
    await fake.seed({ externalId: ext, labels: [], repo: REPO });
    await poll();
    assert.equal((await row(ext)).state, "Done");
  });

  test("the cursor persists, so a second poll with no changes sees nothing", async () => {
    await seed();
    const first = await poll();
    assert.equal(first.seen, 1);
    assert.equal((await db.pool.query("select cursor from backlog_source where id = $1", [sourceId])).rows[0].cursor, first.cursor);
    assert.equal((await poll()).seen, 0);
  });

  test("a paused source is skipped", async () => {
    await db.pool.query("update backlog_source set paused = true where id = $1", [sourceId]);
    const ext = await seed();
    assert.equal((await poll()).seen, 0);
    assert.equal(await row(ext), undefined);
  });

  test("open dependencies are written to blocked_by, and cleared when they close", async () => {
    const { ext } = await held("Queued");
    fake.setDependencies(ext, ["12"]);
    await poll();
    assert.deepEqual((await row(ext)).blocked_by, ["12"]);
    fake.setDependencies(ext, []);
    await poll();
    assert.deepEqual((await row(ext)).blocked_by, []);
  });

  test("changed criteria send an InReview item back to Queued on a new run, close the PR and the question, and fire once", async () => {
    const { ext, id, pr } = await held("InReview", { pr: true, criteriaHash: criteriaHash(["old criterion"]) });
    await db.pool.query("insert into question (item_id, kind, body) values ($1, 'sign_off', 'q')", [id]);
    await poll();
    const r = await row(ext);
    assert.equal(r.state, "Queued");
    assert.equal(r.criteria_hash, criteriaHash(["it works"]));
    const runs = (await db.pool.query("select run_number, next_stage, branch, ended_at is not null as ended from run where item_id = $1 order by run_number", [id])).rows;
    assert.deepEqual(runs, [
      { run_number: 1, next_stage: "open-pr", branch: `factory/pbi-${ext}-r1`, ended: true },
      { run_number: 2, next_stage: "understand", branch: `factory/pbi-${ext}-r2`, ended: false },
    ]);
    assert.equal(host.prs.find((p) => p.number === pr)?.open, false);
    assert.match(host.prs.find((p) => p.number === pr)?.comments[0] ?? "", new RegExp(`factory/pbi-${ext}-r1`));
    assert.equal((await db.pool.query("select count(*)::int as n from question where item_id = $1 and closed_at is not null", [id])).rows[0].n, 1);
    assert.match((await fake.comments(ext))[0], /new sign-off/);
    await poll();
    assert.equal((await db.pool.query("select count(*)::int as n from run where item_id = $1", [id])).rows[0].n, 2);
  });

  test("a criteria comment that fails leaves the item and its PR for the next poll, which posts it and restarts", async () => {
    const { ext, id, pr } = await held("InReview", { pr: true, criteriaHash: criteriaHash(["old criterion"]) });
    const comment = fake.adapter.comment;
    let fail = true;
    fake.adapter.comment = async (...args) => {
      if (fail) throw new Error("GitHub 403 rate limit");
      return comment(...args);
    };
    await poll();
    assert.equal((await row(ext)).state, "InReview");
    assert.equal(host.prs.find((p) => p.number === pr)?.open, true);
    fail = false;
    await poll();
    assert.equal((await row(ext)).state, "Queued");
    assert.match((await fake.comments(ext))[0], /new sign-off/);
    assert.equal((await db.pool.query("select count(*)::int as n from run where item_id = $1", [id])).rows[0].n, 2);
  });

  test("a poll that overlaps another poll's restart doesn't restart the item again", async () => {
    const { ext, id } = await held("InReview", { criteriaHash: criteriaHash(["old criterion"]) });
    const comment = fake.adapter.comment;
    let nested = false;
    fake.adapter.comment = async (...args) => {
      // The outer poll has read the old hash. A second poll runs to completion before the outer one moves the item.
      if (!nested) {
        nested = true;
        await poll();
      }
      return comment(...args);
    };
    await poll();
    assert.equal((await row(ext)).state, "Queued");
    assert.equal((await db.pool.query("select count(*)::int as n from run where item_id = $1", [id])).rows[0].n, 2);
  });

  test("changed criteria on an InProgress item fence its cell and start a new run", async () => {
    const { ext } = await held("InProgress", { criteriaHash: criteriaHash(["old criterion"]) });
    await db.pool.query("update item set lease_generation = 3, lease_owner = 'cell-a', lease_expires = now() where source_id = $1 and external_id = $2", [sourceId, ext]);
    await poll();
    const r = (await db.pool.query("select state, lease_generation, lease_owner from item where source_id = $1 and external_id = $2", [sourceId, ext])).rows[0];
    assert.deepEqual(r, { state: "Queued", lease_generation: 4, lease_owner: null });
  });

  test("a PR that fails to close leaves the item for the next poll, which closes it and withdraws the item", async () => {
    const { ext, pr } = await held("InReview", { pr: true });
    await fake.adapter.close(ext);
    const closePr = host.closePr.bind(host);
    let fail = true;
    host.closePr = async (...args) => {
      if (fail) throw new Error("GitHub 502");
      return closePr(...args);
    };
    await poll();
    assert.equal((await row(ext)).state, "InReview");
    fail = false;
    await poll();
    assert.equal((await row(ext)).state, "Abandoned");
    assert.equal(host.prs.find((p) => p.number === pr)?.open, false);
  });

  test("one PR that can't be read, or an item a webhook already moved, doesn't stop the rest of the poll", async () => {
    const broken = await held("InReview", { pr: true });
    const raced = await held("InReview", { pr: true });
    const merged = await held("InReview", { pr: true });
    for (const h of [raced, merged]) Object.assign(host.prs.find((p) => p.number === h.pr)!, { open: false, merged: true, mergeSha: "m1" });
    const prState = host.prState.bind(host);
    host.prState = async (repo, n, logins) => {
      if (n === broken.pr) throw new Error("GitHub 502");
      // A pr_merged webhook moves this item between the poller's read and its own move.
      if (n === raced.pr) await db.pool.query("update item set state = 'Accepted' where id = $1", [raced.id]);
      return prState(repo, n, logins);
    };
    const fresh = await seed();
    const out = await poll();
    assert.equal((await row(broken.ext)).state, "InReview");
    assert.equal((await row(raced.ext)).state, "Accepted");
    assert.equal((await row(merged.ext)).state, "Accepted");
    assert.equal((await row(fresh)).state, "Queued");
    assert.equal((await db.pool.query("select cursor from backlog_source where id = $1", [sourceId])).rows[0].cursor, out.cursor);
  });

  test("a PR merged just before its item closed counts as a merge", async () => {
    const { ext, pr, run } = await held("InReview", { pr: true });
    Object.assign(host.prs.find((p) => p.number === pr)!, { open: false, merged: true, mergeSha: "m1" });
    await fake.adapter.close(ext);
    await poll();
    assert.equal((await row(ext)).state, "Accepted");
    assert.equal((await db.pool.query("select merge_sha from run where id = $1", [run])).rows[0].merge_sha, "m1");
  });

  test("a PR whose board item was deleted is still closed, through the run's repo", async () => {
    const { ext, pr, run } = await held("InReview", { pr: true });
    const repoId = (await db.pool.query<{ id: string }>("select id from repo")).rows[0].id;
    await db.pool.query("update run set repo_id = $2 where id = $1", [run, repoId]);
    // A first poll consumes the listing, so the item is gone from the board by the next one.
    await poll();
    const getItem = fake.adapter.getItem;
    fake.adapter.getItem = async (id) => (id === ext ? null : getItem(id));
    await poll();
    assert.equal((await row(ext)).state, "Abandoned");
    assert.equal(host.prs.find((p) => p.number === pr)?.open, false);
  });

  test("a review submitted while address ran requeues the item once it's back in InReview", async () => {
    await db.pool.query(`insert into "user" (provider, subject, role, github_login) values ('dev', 'octo', 'owner', 'octo')`);
    // The claim that started the address run set reviews_seen_at to its own time.
    const { ext, pr, run } = await held("InReview", { pr: true, reviewsSeenAt: "2026-11-06T10:00:00Z" });
    host.prs.find((p) => p.number === pr)!.reviews.push({ state: "changes_requested", submittedAt: "2026-11-06T10:30:00Z", author: "octo" });
    await poll();
    assert.equal((await row(ext)).state, "Queued");
    assert.equal((await db.pool.query("select next_stage from run where id = $1", [run])).rows[0].next_stage, "address");
  });

  test("a merge conflict sends an InReview item to address", async () => {
    const { ext, pr, run } = await held("InReview", { pr: true });
    host.prs.find((p) => p.number === pr)!.mergeable = false;
    await poll();
    assert.equal((await row(ext)).state, "Queued");
    assert.equal((await db.pool.query("select next_stage from run where id = $1", [run])).rows[0].next_stage, "address");
  });

  test("a review older than the address run's claim leaves the item in InReview", async () => {
    await db.pool.query(`insert into "user" (provider, subject, role, github_login) values ('dev', 'octo', 'owner', 'octo')`);
    const { ext, pr } = await held("InReview", { pr: true, reviewsSeenAt: "2026-11-06T10:00:00Z" });
    host.prs.find((p) => p.number === pr)!.reviews.push({ state: "changes_requested", submittedAt: "2026-11-06T09:00:00Z", author: "octo" });
    await poll();
    assert.equal((await row(ext)).state, "InReview");
  });

  test("a missed merge moves the item to Accepted and records the merge sha", async () => {
    const { ext, pr, run } = await held("InReview", { pr: true });
    Object.assign(host.prs.find((p) => p.number === pr)!, { open: false, merged: true, mergeSha: "m1" });
    await poll();
    assert.equal((await row(ext)).state, "Accepted");
    assert.equal((await db.pool.query("select merge_sha from run where id = $1", [run])).rows[0].merge_sha, "m1");
  });

  test("a judge that throws leaves only that item Eligible, and the rest of the poll still runs", async () => {
    const stuck = await seed({ title: "boom" });
    const fine = await seed();
    const { ext: merged, pr } = await held("InReview", { pr: true });
    Object.assign(host.prs.find((p) => p.number === pr)!, { open: false, merged: true, mergeSha: "m1" });
    const out = await poll();
    assert.equal((await row(stuck)).state, "Eligible");
    assert.deepEqual(await fake.comments(stuck), []);
    assert.equal((await row(fine)).state, "Queued");
    assert.equal((await row(merged)).state, "Accepted");
    assert.equal((await db.pool.query("select cursor from backlog_source where id = $1", [sourceId])).rows[0].cursor, out.cursor);
  });

  test("an item in a repo the factory doesn't know is NotReady, and the judge isn't asked", async () => {
    const ext = await seed({ repo: "someone/else" });
    await poll();
    assert.equal((await row(ext)).state, "NotReady");
    assert.deepEqual(judged, []);
  });

  test("an item in an unknown repo is told so, even when its host can't list dependencies", async () => {
    const ext = await seed({ repo: "someone/else" });
    fake.adapter.openDependencies = async () => {
      throw new Error("404 from a repo outside the App's installation");
    };
    await poll();
    await poll();
    assert.equal((await row(ext)).state, "NotReady");
    assert.match((await fake.comments(ext))[0], /doesn't know this item's repo/);
  });

  test("a pr-review.md with a run: line makes the item NotReady with that reason, and fixing it re-gates", async () => {
    commit("c2", { ...files, ".factory/pr-review.md": "- [ ] Lint `run: npm run lint`\n" });
    const ext = await seed();
    await poll();
    assert.equal((await row(ext)).state, "NotReady");
    assert.match((await fake.comments(ext))[0], /pr-review\.md: run: lines are allowed only in dod\.md/);
    commit("c3", { ...files, ".factory/pr-review.md": "- [ ] Lint is clean\n" });
    await poll();
    assert.equal((await row(ext)).state, "Queued");
  });

  test("adding a missing dod.md re-gates the item and posts a fresh comment", async () => {
    commit("c2", { ".factory/config.yml": files[".factory/config.yml"], ".factory/dor.md": files[".factory/dor.md"] });
    verdict = "failed";
    const ext = await seed();
    await poll();
    assert.match((await fake.comments(ext))[0], /No \.factory\/dod\.md/);
    commit("c3", files);
    await poll();
    assert.equal((await row(ext)).state, "NotReady");
    assert.equal((await fake.comments(ext)).length, 2);
  });

  test("a deploy that changes the default dor.md re-gates a repo that uses it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "policy-"));
    const old = process.env.FACTORY_POLICY_DIR;
    try {
      cpSync(join(import.meta.dirname, "..", "..", "policy"), dir, { recursive: true });
      process.env.FACTORY_POLICY_DIR = dir;
      commit("c2", { ".factory/config.yml": files[".factory/config.yml"], ".factory/dod.md": files[".factory/dod.md"] });
      verdict = "failed";
      const ext = await seed();
      await poll();
      assert.equal((await row(ext)).state, "NotReady");
      verdict = "passed";
      writeFileSync(join(dir, "dor.md"), "- [ ] Has a title\n");
      await poll();
      assert.equal((await row(ext)).state, "Queued");
    } finally {
      if (old === undefined) delete process.env.FACTORY_POLICY_DIR;
      else process.env.FACTORY_POLICY_DIR = old;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
