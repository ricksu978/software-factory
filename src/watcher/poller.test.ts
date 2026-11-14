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

  test("each judge call's spend is stored for the item, a call that failed on a usage limit included (PBI 132)", async () => {
    const spent = { model: "claude-haiku-4-5", tokensIn: 900, tokensOut: 0, costUsd: 0.0012 };
    const limited = async (_item: FactoryItem, _dor: Policy, report?: (s: typeof spent) => void): Promise<string> => {
      report?.(spent);
      throw new Error("readiness judge failed: usage limit");
    };
    const ext = await seed();
    await pollOnce({ pool: db.pool, adapter: fake.adapter, repoHost: host, judge: limited, sourceId });
    const r = await row(ext);
    assert.equal(r.state, "Eligible");
    const checks = (await db.pool.query("select model, tokens_in, tokens_out, cost_usd::float8 as cost from readiness_check where item_id = $1", [r.id])).rows;
    assert.deepEqual(checks, [{ model: "claude-haiku-4-5", tokens_in: 900, tokens_out: 0, cost: 0.0012 }]);
  });

  test("an oversized item whose split got no answer stays Eligible, and the next poll asks again and posts it", async () => {
    const big = async (item: FactoryItem, dor: Policy) =>
      [...dor.criteria.map((c) => JSON.stringify({ index: c.index, status: "failed", reason: "because" })), JSON.stringify({ flags: [], oversized: true })].join("\n");
    let answer = false;
    const children = [{ title: "A", body: "Parent t", criteria: [1], needs: [] }, { title: "B", body: "Parent t", criteria: [2], needs: [1] }];
    const agent = async () => (answer ? { ok: true, text: JSON.stringify({ children }) } : { ok: false, text: "usage limit" }) as never;
    const split = { sop: { models: { coding: "c" } }, agent, seen: new Map() };
    const ext = await seed({ acceptanceCriteria: ["one", "two"] });
    const pollBig = () => pollOnce({ pool: db.pool, adapter: fake.adapter, repoHost: host, judge: big, sourceId, split });
    await pollBig();
    assert.equal((await row(ext)).state, "Eligible");
    assert.match((await fake.comments(ext)).join("\n"), /the coding model gave no answer/);
    // The coding model stays down. The comment bumped updatedAt, but the no-answer comment isn't posted again.
    await pollBig();
    assert.equal((await row(ext)).state, "Eligible");
    assert.equal((await fake.comments(ext)).filter((b) => b.includes("gave no answer")).length, 1);
    answer = true;
    await pollBig();
    assert.equal((await row(ext)).state, "NotReady");
    const all = await fake.comments(ext);
    assert.equal(all.filter((b) => b.startsWith("The factory proposes splitting")).length, 1);
    assert.ok(all.some((b) => b.startsWith("The factory can't start") && !b.includes("gave no answer")), "no corrected readiness comment");
  });

  test("intake stores each item's repo as owner/name, from its issue, or none for a board item in no repo", async () => {
    const a = await seed();
    const b = await seed({ repo: "other/tools" });
    const c = await seed({ repo: null });
    await poll();
    const repo = async (ext: string) => (await db.pool.query("select repo from item where source_id = $1 and external_id = $2", [sourceId, ext])).rows[0].repo;
    assert.equal(await repo(a), REPO);
    assert.equal(await repo(b), "other/tools");
    assert.equal(await repo(c), null);
  });

  test("an item held with no repo gets its repo from the next poll that reads it, whatever its state", async () => {
    const queued = await held("Queued");
    const notReady = await held("NotReady");
    const inProgress = await held("InProgress");
    const gone = await held("Queued");
    // The cursor is past every seeded item, so the poll only reads them back.
    await db.pool.query("update backlog_source set cursor = '999' where id = $1", [sourceId]);
    const { getItem } = fake.adapter;
    fake.adapter.getItem = async (id) => {
      if (id === gone.ext) throw new Error("unreachable");
      return getItem(id);
    };
    await poll();
    const repo = async (id: string) => (await db.pool.query("select repo from item where id = $1", [id])).rows[0].repo;
    assert.equal(await repo(queued.id), REPO);
    assert.equal(await repo(notReady.id), REPO);
    assert.equal(await repo(inProgress.id), REPO);
    assert.equal(await repo(gone.id), null);
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

  test("an Eligible or NotReady item that left the backlog is withdrawn to Abandoned, never gated (PBI 168)", async () => {
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
    assert.deepEqual([(await row(notReady)).state, (await row(eligible)).state], ["Abandoned", "Abandoned"]);
    assert.deepEqual(judged, []);
    const moves = (await db.pool.query(
      "select e.actor, e.payload->>'from' as from, e.payload->>'event' as event from event e where e.item_id = any($1) and e.payload->>'to' = 'Abandoned' order by e.payload->>'from'",
      [[(await row(notReady)).id, (await row(eligible)).id]],
    )).rows;
    assert.deepEqual(moves, [{ actor: "system", from: "Eligible", event: "withdrawn" }, { actor: "system", from: "NotReady", event: "withdrawn" }]);
  });

  test("an item withdrawn from NotReady that gets its label back returns to Eligible and meets the gate (PBI 168)", async () => {
    verdict = "failed";
    const ext = await seed();
    await poll();
    await fake.seed({ externalId: ext, labels: [], repo: REPO });
    await poll();
    assert.equal((await row(ext)).state, "Abandoned");
    await fake.seed({ externalId: ext, labels: ["factory"], repo: REPO });
    verdict = "passed";
    judged = [];
    await poll();
    assert.equal((await row(ext)).state, "Queued");
    assert.deepEqual(judged, [ext]);
    const moves = (await db.pool.query("select payload->>'from' as from, payload->>'to' as to from event where item_id = $1 and kind = 'transition' order by at", [(await row(ext)).id])).rows;
    assert.deepEqual(moves.slice(-2), [{ from: "Abandoned", to: "Eligible" }, { from: "Eligible", to: "Queued" }]);
  });

  test("an item withdrawn from Queued or later stays Abandoned when its label comes back", async () => {
    const { ext } = await held("Queued");
    await fake.seed({ externalId: ext, labels: [], repo: REPO });
    await poll();
    assert.equal((await row(ext)).state, "Abandoned");
    await fake.seed({ externalId: ext, labels: ["factory"], repo: REPO });
    await poll();
    assert.equal((await row(ext)).state, "Abandoned");
  });

  test("an item with an open dependency is queued blocked by it in the same poll, so no claim takes it early (PBI 237)", async () => {
    const ext = await seed();
    fake.setDependencies(ext, ["7"]);
    await poll();
    const r = await row(ext);
    assert.equal(r.state, "Queued");
    assert.deepEqual(r.blocked_by, ["7"]);
  });

  test("a NotReady item isn't re-gated when only its dependencies change, since they no longer touch the verdict", async () => {
    verdict = "failed";
    const ext = await seed();
    await poll();
    fake.setDependencies(ext, ["7"]);
    judged = [];
    await poll();
    assert.equal((await row(ext)).state, "NotReady");
    assert.deepEqual(judged, []);
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

  test("an InProgress item whose PR merged moves to Accepted with its merge commit, even if the item closed too", async () => {
    const { ext, pr, run } = await held("InProgress", { pr: true });
    Object.assign(host.prs.find((p) => p.number === pr)!, { open: false, merged: true, mergeSha: "m2" });
    await fake.adapter.close(ext);
    await poll();
    assert.equal((await row(ext)).state, "Accepted");
    assert.equal((await db.pool.query("select merge_sha from run where id = $1", [run])).rows[0].merge_sha, "m2");
  });

  test("an InProgress item whose PR closed without a merge is withdrawn", async () => {
    const { ext, pr, run } = await held("InProgress", { pr: true });
    Object.assign(host.prs.find((p) => p.number === pr)!, { open: false });
    await poll();
    assert.equal((await row(ext)).state, "Abandoned");
    assert.equal((await db.pool.query("select merge_sha from run where id = $1", [run])).rows[0].merge_sha, null);
  });

  test("a NeedsInput item whose PR merged moves to Accepted with its merge commit, and its question closes (PBI 194)", async () => {
    const { ext, id, pr, run } = await held("NeedsInput", { pr: true });
    await db.pool.query("insert into question (item_id, kind, body, asked_at) values ($1, 'needs_input', 'q', now())", [id]);
    Object.assign(host.prs.find((p) => p.number === pr)!, { open: false, merged: true, mergeSha: "m3" });
    await fake.adapter.close(ext);
    await poll();
    assert.equal((await row(ext)).state, "Accepted");
    assert.equal((await db.pool.query("select merge_sha from run where id = $1", [run])).rows[0].merge_sha, "m3");
    assert.equal((await db.pool.query("select 1 from question where item_id = $1 and closed_at is null", [id])).rowCount, 0);
  });

  test("a NeedsInput item whose PR closed without a merge is withdrawn (PBI 194)", async () => {
    const { ext, pr, run } = await held("NeedsInput", { pr: true });
    Object.assign(host.prs.find((p) => p.number === pr)!, { open: false });
    await poll();
    assert.equal((await row(ext)).state, "Abandoned");
    assert.equal((await db.pool.query("select merge_sha from run where id = $1", [run])).rows[0].merge_sha, null);
  });

  test("a NeedsInput item with an open PR that conflicts, or has a newer review, stays NeedsInput, its question open (PBI 194)", async () => {
    const { ext, id, pr } = await held("NeedsInput", { pr: true, reviewsSeenAt: "2026-11-06T10:00:00Z" });
    await db.pool.query("insert into question (item_id, kind, body, asked_at) values ($1, 'needs_input', 'q', now())", [id]);
    Object.assign(host.prs.find((p) => p.number === pr)!, { mergeable: false });
    await poll();
    assert.equal((await row(ext)).state, "NeedsInput");
    assert.equal((await db.pool.query("select 1 from question where item_id = $1 and closed_at is null", [id])).rowCount, 1);
  });

  test("an InProgress item with an open PR and a newer review stays InProgress", async () => {
    const { ext, pr } = await held("InProgress", { pr: true, reviewsSeenAt: "2026-11-06T10:00:00Z" });
    Object.assign(host.prs.find((p) => p.number === pr)!, { mergeable: false });
    await poll();
    assert.equal((await row(ext)).state, "InProgress");
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
    host.prs.find((p) => p.number === pr)!.reviews.push({ state: "changes_requested", submittedAt: "2026-11-06T10:30:00Z", author: "octo", body: "Fix it." });
    await poll();
    assert.equal((await row(ext)).state, "Queued");
    assert.equal((await db.pool.query("select next_stage from run where id = $1", [run])).rows[0].next_stage, "address");
  });

  test("a review that only comments sends the item to address while its thread is open, and not once it's resolved", async () => {
    await db.pool.query(`insert into "user" (provider, subject, role, github_login) values ('dev', 'octo', 'owner', 'octo')`);
    const { ext, pr, run } = await held("InReview", { pr: true, reviewsSeenAt: "2026-11-06T10:00:00Z" });
    const p = host.prs.find((x) => x.number === pr)!;
    p.reviews.push({ state: "commented", submittedAt: "2026-11-06T10:30:00Z", author: "octo" });
    const thread = { threadId: "t1", path: "a.ts", line: 1, author: "octo", body: "Cite the probe.", submittedAt: "2026-11-06T10:30:00Z", resolved: true };
    host.reviewComments.set(`${p.repo}#${pr}`, [thread]);
    await poll();
    assert.equal((await row(ext)).state, "InReview", "a resolved thread asks for nothing");
    thread.resolved = false;
    await poll();
    assert.equal((await row(ext)).state, "Queued");
    assert.equal((await db.pool.query("select next_stage from run where id = $1", [run])).rows[0].next_stage, "address");
  });

  test("a trusted reply inside a thread the factory's own review opened leaves the item in InReview (PBI 130)", async () => {
    await db.pool.query(`insert into "user" (provider, subject, role, github_login) values ('dev', 'octo', 'owner', 'octo')`);
    // Stored without "[bot]", as issue #79 allows; GitHub names the App's comments with it.
    await db.pool.query("update repo set trusted_bot = 'factory' where url = $1", [`https://github.com/${REPO}`]);
    const { ext, pr } = await held("InReview", { pr: true, reviewsSeenAt: "2026-11-06T10:00:00Z" });
    const p = host.prs.find((x) => x.number === pr)!;
    const at = "2026-11-06T10:30:00Z";
    host.reviewComments.set(`${p.repo}#${pr}`, [
      { threadId: "ft1", path: "a.ts", line: 1, author: "factory[bot]", body: "Misses the VAT.", submittedAt: at },
      { threadId: "ft1", path: "a.ts", line: 1, author: "octo", body: "I'd rather keep it.", submittedAt: at },
    ]);
    // octo submitted the reply as a review that requests changes with no summary.
    p.reviews.push({ state: "changes_requested", submittedAt: at, author: "octo" });
    await poll();
    assert.equal((await row(ext)).state, "InReview");
    host.reviewComments.get(`${p.repo}#${pr}`)!.push({ threadId: "pt1", path: "a.ts", line: 2, author: "octo", body: "Use the tax table.", submittedAt: at });
    await poll();
    assert.equal((await row(ext)).state, "Queued", "a person's own thread still sends it to address");
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
    host.prs.find((p) => p.number === pr)!.reviews.push({ state: "changes_requested", submittedAt: "2026-11-06T09:00:00Z", author: "octo", body: "Fix it." });
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

  test("a new readiness logic re-gates a NotReady item in an unknown repo too", async () => {
    const ext = await seed({ repo: "someone/else" });
    const pollWith = (version: number) => pollOnce({ pool: db.pool, adapter: fake.adapter, repoHost: host, judge, sourceId, logic: { judgePrompt: "p", version, splitPrompt: "s" } });
    await pollWith(1);
    await pollWith(2);
    await pollWith(2);
    const moves = (await db.pool.query("select payload->>'event' as e from event where item_id = $1 and kind = 'transition'", [(await row(ext)).id])).rows;
    assert.equal(moves.filter((m) => m.e === "policy_changed").length, 1);
    assert.equal((await row(ext)).state, "NotReady");
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

  test("a new readiness logic re-gates a NotReady item once, as a policy change, and the same logic never again", async () => {
    verdict = "failed";
    const ext = await seed();
    const logic = { judgePrompt: "Judge it.", version: 1, splitPrompt: "Split it." };
    const pollWith = (l: typeof logic) => pollOnce({ pool: db.pool, adapter: fake.adapter, repoHost: host, judge, sourceId, logic: l });
    await pollWith(logic);
    await pollWith({ ...logic });
    assert.deepEqual(judged, [ext], "the same logic doesn't re-gate");
    await pollWith({ ...logic, version: 2 });
    await pollWith({ ...logic, version: 2 });
    assert.deepEqual(judged, [ext, ext], "a raised version re-gates once");
    const moves = (await db.pool.query("select payload->>'event' as e from event where item_id = $1 and kind = 'transition'", [(await row(ext)).id])).rows;
    assert.equal(moves.filter((m) => m.e === "policy_changed").length, 1);
    assert.equal((await row(ext)).state, "NotReady");
  });
  describe("the factory's merge (PBI 181)", () => {
    const dod = "## Definition of Done\n\n- [x] Tests pass\n";
    const allow = (login: string) => db.pool.query(`insert into "user" (provider, subject, role, github_login) values ('dev', $1, 'owner', $1)`, [login]);
    async function ready(state = "InReview") {
      const h = await held(state, { pr: true });
      const p = host.prs.find((x) => x.number === h.pr)!;
      Object.assign(p, { headSha: "h1", mergeState: "clean", mergeAs: "m9", body: dod, reviews: [{ state: "approved", submittedAt: new Date(0).toISOString(), author: "octo" }] });
      return { ...h, p };
    }
    const events = async (kind: string) => (await db.pool.query<{ payload: any }>("select payload from event where kind = $1 and actor = 'system'", [kind])).rows.map((r) => r.payload);

    test("a clean, approved InReview PR is squash-merged at its head, the item moves to Accepted and the merge is logged", async () => {
      await allow("Octo");
      const { ext, pr, run } = await ready();
      await poll();
      assert.deepEqual(host.mergeCalls, [{ repo: REPO, prNumber: pr, method: "squash", headSha: "h1", merged: true }]);
      assert.equal((await row(ext)).state, "Accepted");
      assert.equal((await db.pool.query("select merge_sha from run where id = $1", [run])).rows[0].merge_sha, "m9");
      assert.deepEqual(await events("factory_merged"), [{ repo: REPO, prNumber: pr, mergeSha: "m9", approvers: ["octo"] }]);
    });

    test("an unticked DoD line, no approval, a state other than clean, a hold or an InProgress item leave the PR alone", async () => {
      await allow("octo");
      const a = await ready();
      a.p.body = `${dod}- [ ] No secret *(for the person who merges to check)*\n`;
      const b = await ready();
      b.p.reviews = [];
      const c = await ready();
      c.p.mergeState = "blocked";
      const d = await ready();
      await db.pool.query("update item set held = true where id = $1", [d.id]);
      const e = await ready("InProgress");
      await poll();
      assert.deepEqual(host.mergeCalls, []);
      for (const h of [a, b, c, d]) assert.equal((await row(h.ext)).state, "InReview");
      assert.equal((await row(e.ext)).state, "InProgress");
    });

    test("a merge GitHub refuses leaves the item in InReview, logs GitHub's message, and the next poll merges", async () => {
      await allow("octo");
      const { ext, pr, p } = await ready();
      p.refusals = ["Base branch was modified."];
      await poll();
      assert.equal((await row(ext)).state, "InReview");
      assert.deepEqual(await events("factory_merge_refused"), [{ repo: REPO, prNumber: pr, reason: "Base branch was modified." }]);
      assert.deepEqual(await events("factory_merged"), []);
      await poll();
      assert.equal((await row(ext)).state, "Accepted");
      assert.equal((await events("factory_merged")).length, 1);
    });

    test("a merge that went through while the call failed is still logged as the factory's when the next poll sees it", async () => {
      await allow("octo");
      const { ext, pr, run, p } = await ready();
      const mergePr = host.mergePr.bind(host);
      host.mergePr = async (...args) => {
        await mergePr(...args);
        throw new Error("502 Bad Gateway");
      };
      await poll();
      assert.equal(p.merged, true);
      assert.equal((await row(ext)).state, "InReview");
      assert.deepEqual(await events("factory_merged"), []);
      assert.deepEqual(await events("factory_merge_attempt"), [{ repo: REPO, prNumber: pr, headSha: "h1", approvers: ["octo"] }]);
      host.mergePr = mergePr;
      await poll();
      assert.equal((await row(ext)).state, "Accepted");
      assert.equal((await db.pool.query("select merge_sha from run where id = $1", [run])).rows[0].merge_sha, "m9");
      assert.deepEqual(await events("factory_merged"), [{ repo: REPO, prNumber: pr, mergeSha: "m9", approvers: ["octo"] }]);
    });

    test("a person's merge after a refused attempt isn't logged as the factory's", async () => {
      await allow("octo");
      const { ext, p } = await ready();
      p.refusals = ["Base branch was modified."];
      await poll();
      Object.assign(p, { open: false, merged: true, mergeSha: "m1" });
      await poll();
      assert.equal((await row(ext)).state, "Accepted");
      assert.deepEqual(await events("factory_merged"), []);
    });

    test("a hold that lands after the attempt is logged stops the merge and closes the attempt, so a person's merge isn't the factory's", async () => {
      await allow("octo");
      const { ext, id, pr, p } = await ready();
      // The dashboard's Hold, landing as the attempt commits, before the merge's locked re-read.
      await db.pool.query(`create function hold_on_attempt() returns trigger language plpgsql as $$
        begin if new.kind = 'factory_merge_attempt' then update item set held = true where id = new.item_id; end if; return new; end $$`);
      await db.pool.query("create trigger hold_on_attempt after insert on event for each row execute function hold_on_attempt()");
      try {
        await poll();
      } finally {
        await db.pool.query("drop trigger hold_on_attempt on event; drop function hold_on_attempt()");
      }
      assert.deepEqual(host.mergeCalls, []);
      assert.equal((await row(ext)).state, "InReview");
      assert.deepEqual(await events("factory_merge_refused"), [{ repo: REPO, prNumber: pr, reason: "the item was held or moved before the merge" }]);
      Object.assign(p, { open: false, merged: true, mergeSha: "m1" });
      await db.pool.query("update item set held = false where id = $1", [id]);
      await poll();
      assert.equal((await row(ext)).state, "Accepted");
      assert.deepEqual(await events("factory_merged"), []);
    });

    test("a clean, approved PR whose item lost its label, closed or changed criteria is closed unmerged", async () => {
      await allow("octo");
      const a = await ready();
      await fake.seed({ externalId: a.ext, labels: [], repo: REPO });
      const b = await ready();
      await fake.adapter.close(b.ext);
      const c = await ready();
      await db.pool.query("update item set criteria_hash = $2 where id = $1", [c.id, criteriaHash(["old criterion"])]);
      await poll();
      assert.deepEqual(host.mergeCalls, []);
      for (const h of [a, b, c]) assert.equal(h.p.open, false);
      for (const h of [a, b]) assert.equal((await row(h.ext)).state, "Abandoned");
      assert.equal((await row(c.ext)).state, "Queued");
      assert.deepEqual(await events("factory_merged"), []);
    });

    test("an approval from someone outside the allowlist doesn't merge, and only allowlisted approvers are logged", async () => {
      await allow("kim");
      const a = await ready();
      a.p.reviews = [{ state: "approved", submittedAt: new Date(0).toISOString(), author: "stranger" }];
      await poll();
      assert.deepEqual(host.mergeCalls, []);
      assert.equal((await row(a.ext)).state, "InReview");
      a.p.reviews.push({ state: "approved", submittedAt: new Date(1).toISOString(), author: "kim" });
      await poll();
      assert.equal((await row(a.ext)).state, "Accepted");
      assert.deepEqual((await events("factory_merged")).map((e) => e.approvers), [["kim"]]);
    });
  });
});
