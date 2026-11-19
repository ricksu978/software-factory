import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { fakeBacklog, fakeRepoHost } from "../adapters/fake.ts";
import type { FactoryItem } from "../adapters/types.ts";
import type { Policy } from "../policy/policy.ts";
import { dbTest, startTestDb } from "../store/test-db.ts";
import { SPLIT_DONE_HEADING } from "../gate/split-done.ts";
import { CI_BACK_TO_GREEN, NO_REVIEW_TEXT } from "../core/questions.ts";
import { criteriaHash, pollOnce, readinessFingerprint, REQUEUED_FOR_ADDRESS, REQUEUED_FOR_GREEN } from "./poller.ts";

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

  test("a permission the App lacks on the repo fails the gate, and granting it gates the item again (PBI 264)", async () => {
    host.permissionsMissing.set(REPO, ["issues: write"]);
    const ext = await seed();
    await poll();
    const r = await row(ext);
    assert.equal(r.state, "NotReady");
    assert.deepEqual(judged, [], "an engine rule failure never asks the judge");
    const results = (await db.pool.query("select criterion, status from policy_result where item_id = $1", [r.id])).rows;
    assert.ok(results.some((v) => v.criterion === "app permission" && v.status === "failed"));
    assert.match((await fake.comments(ext)).join("\n"), /issues: write/);
    host.permissionsMissing.delete(REPO);
    await poll();
    assert.equal((await row(ext)).state, "Queued");
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

  /** A parent that an oversized verdict and a valid two-child split file as children 101 and 102, on a board in memory. */
  async function splitting() {
    const big = async (item: FactoryItem, dor: Policy) => {
      judged.push(item.externalId);
      // A proposed child, judged before it's filed (PBI 264), carries a split marker and passes.
      const child = item.body.includes("factory-split-");
      return [...dor.criteria.map((c) => JSON.stringify({ index: c.index, status: child ? "passed" : "failed", reason: "because" })), JSON.stringify({ flags: [], oversized: !child })].join("\n");
    };
    const children = [{ title: "A", body: "Parent t", criteria: [1], needs: [] }, { title: "B", body: "Parent t", criteria: [2], needs: [1] }];
    const agent = async () => ({ ok: true, text: JSON.stringify({ children }) }) as never;
    const subs: string[] = [];
    const filed: { externalId: string; title: string; url: string; body: string }[] = [];
    let n = 100;
    // Once set, the filed children are older than the repo's newest issues, so a search of the repo no longer finds them.
    let old = false;
    const board = {
      subIssues: async () => subs.map((id) => {
        const f = filed.find((x) => x.externalId === id);
        return { externalId: id, title: f?.title ?? id, url: `u/${id}`, body: f?.body ?? "", openedByApp: !!f };
      }),
      findIssues: async (_repo: string, text: string) => old ? [] :
        filed.filter((f) => f.body.includes(text)).map(({ externalId, title, url }) => ({ externalId, title, url })),
      createIssue: async (_repo: string, title: string, body: string) => {
        const issue = { externalId: String(++n), title, url: `u/${n}` };
        filed.push({ ...issue, body });
        return issue;
      },
      addSubIssue: async (_p: string, c: string) => void subs.push(c),
      boardStatus: async () => "Backlog",
      addToBoard: async () => {},
      blockedBy: async () => [],
      addBlockedBy: async () => {},
      removeLabel: async (id: string) => void (await fake.seed({ externalId: id, labels: [], repo: REPO, acceptanceCriteria: ["one", "two"] })),
    };
    const split = { sop: { models: { coding: "c" } }, agent, seen: new Map(), file: { board, optInLabel: "factory", backlogStatus: "Backlog", criteriaHeading: "AC" } };
    const ext = await seed({ acceptanceCriteria: ["one", "two"] });
    const pollSplit = () => pollOnce({ pool: db.pool, adapter: fake.adapter, repoHost: host, judge: big, sourceId, split });
    const moves = async () => (await db.pool.query(
      "select payload->>'from' as from, payload->>'event' as event, payload->>'to' as to from event where item_id = $1 and kind = 'transition' order by at, id",
      [(await row(ext)).id],
    )).rows;
    return { ext, subs, pollSplit, moves, age: () => void (old = true) };
  }

  test("a parent whose split is filed moves NotReady to Split, and stays there with its label back and a new policy (PBI 225)", async () => {
    const { ext, subs, pollSplit, moves } = await splitting();
    await pollSplit();
    assert.equal(subs.length, 2);
    assert.equal((await row(ext)).state, "Split");
    await pollSplit();
    await fake.seed({ externalId: ext, labels: ["factory"], repo: REPO, acceptanceCriteria: ["one", "two"] });
    commit("c2", { ...files, ".factory/dor.md": "- [ ] Has a title\n- [ ] Has an owner\n" });
    judged = [];
    await pollSplit();
    assert.equal((await row(ext)).state, "Split");
    assert.deepEqual(judged, []);
    assert.deepEqual(await moves(), [{ from: "Eligible", event: "readiness_failed", to: "NotReady" }, { from: "NotReady", event: "split_filed", to: "Split" }]);
  });

  /** Has the factory hold split child `ext` in `state`, with a run whose PR `pr`, when given, merged. */
  async function child(ext: string, state: string, pr?: number) {
    const id = (await db.pool.query<{ id: string }>(
      `insert into item (source_id, external_id, title, state) values ($1, $2, 't', $3)
       on conflict (source_id, external_id) do update set state = excluded.state returning id`,
      [sourceId, ext, state],
    )).rows[0].id;
    await db.pool.query("delete from run where item_id = $1", [id]);
    await db.pool.query(
      "insert into run (item_id, run_number, branch, pr_number, pr_url, merge_sha) values ($1, 1, $2, $3, $4, $5)",
      [id, `factory/pbi-${ext}-r1`, pr ?? null, pr ? `https://github.com/${REPO}/pull/${pr}` : null, pr ? `m${pr}` : null],
    );
  }

  test("a Split parent stays Split while a filed child isn't Done, then moves to Done, comments once and closes (PBI 226)", async () => {
    const { ext, pollSplit, moves } = await splitting();
    await pollSplit();
    await child("101", "Done", 61);
    await child("102", "Failed");
    await pollSplit();
    assert.equal((await row(ext)).state, "Split");
    assert.equal((await fake.adapter.getItem(ext))!.closed, false);
    assert.deepEqual((await fake.comments(ext)).filter((b) => b.startsWith(SPLIT_DONE_HEADING)), []);

    await child("102", "Done", 62);
    await pollSplit();
    await pollSplit();
    assert.equal((await row(ext)).state, "Done");
    assert.equal((await fake.adapter.getItem(ext))!.closed, true);
    const done = (await fake.comments(ext)).filter((b) => b.startsWith(SPLIT_DONE_HEADING));
    assert.equal(done.length, 1);
    assert.match(done[0], /\[A\]\(u\/101\), closed by \[PR #61\]\(https:\/\/github\.com\/octo\/repo\/pull\/61\)/);
    assert.match(done[0], /\[B\]\(u\/102\), closed by \[PR #62\]/);
    assert.deepEqual((await moves()).slice(-1), [{ from: "Split", event: "children_done", to: "Done" }]);
  });

  test("a Split parent with a filed child the factory doesn't hold stays Split, and a sub-issue added by hand doesn't count (PBI 226)", async () => {
    const { ext, subs, pollSplit } = await splitting();
    await pollSplit();
    await child("101", "Done", 61);
    await pollSplit();
    assert.equal((await row(ext)).state, "Split");
    subs.push("999");
    await child("102", "Done", 62);
    await pollSplit();
    assert.equal((await row(ext)).state, "Done");
  });

  test("a Split parent whose move to Split recorded no children finds them by their split markers, and moves to Done once they're Done (PBI 226)", async () => {
    const { ext, subs, pollSplit, moves, age } = await splitting();
    await pollSplit();
    age();
    await db.pool.query("update event set payload = payload - 'children' where item_id = $1 and payload->>'event' = 'split_filed'", [(await row(ext)).id]);
    // A sub-issue added by hand carries no split marker, so it isn't a filed child and doesn't hold the parent back.
    subs.push("999");
    await child("101", "Done", 61);
    await child("102", "Failed");
    await pollSplit();
    assert.equal((await row(ext)).state, "Split");
    await child("102", "Done", 62);
    await pollSplit();
    assert.equal((await row(ext)).state, "Done");
    const done = (await fake.comments(ext)).filter((b) => b.startsWith(SPLIT_DONE_HEADING));
    assert.equal(done.length, 1);
    assert.match(done[0], /\[A\]\(u\/101\), closed by \[PR #61\]/);
    assert.match(done[0], /\[B\]\(u\/102\), closed by \[PR #62\]/);
    assert.deepEqual((await moves()).slice(-1), [{ from: "Split", event: "children_done", to: "Done" }]);
  });

  test("a Split parent whose move to Split recorded no children stays Split while a filed child isn't among its sub-issues (PBI 226)", async () => {
    const { ext, subs, pollSplit } = await splitting();
    await pollSplit();
    await db.pool.query("update event set payload = payload - 'children' where item_id = $1 and payload->>'event' = 'split_filed'", [(await row(ext)).id]);
    subs.splice(subs.indexOf("102"), 1);
    await child("101", "Done", 61);
    await child("102", "Done", 62);
    await pollSplit();
    assert.equal((await row(ext)).state, "Split");
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

  /** A NeedsInput item stopped at address on `body`, asked at `askedAt`, with its PR open. */
  async function waiting(body: string, askedAt = "2026-11-10T09:00:00Z") {
    const h = await held("NeedsInput", { pr: true, reviewsSeenAt: "2026-11-01T00:00:00Z" });
    await db.pool.query("update run set next_stage = 'address' where id = $1", [h.run]);
    const q = (await db.pool.query<{ id: string }>(
      "insert into question (item_id, kind, body, asked_at) values ($1, 'needs_input', $2, $3) returning id", [h.id, body, askedAt],
    )).rows[0].id;
    return { ...h, q, p: host.prs.find((p) => p.number === h.pr)! };
  }
  const question = async (q: string) =>
    (await db.pool.query<{ answer: string | null; answered_by: string | null; answered_at: Date | null }>("select answer, answered_by, answered_at from question where id = $1", [q])).rows[0];
  const requeues = async (id: string) =>
    (await db.pool.query<{ actor: string; payload: Record<string, unknown> }>("select actor, payload from event where item_id = $1 and kind = $2", [id, REQUEUED_FOR_ADDRESS])).rows;

  test("a conflict answers an item's \"no trusted review text\" question for the factory, once, naming the PR and its base (PBI 305)", async () => {
    const { id, q, pr, p } = await waiting(NO_REVIEW_TEXT);
    p.mergeable = false;
    await poll();
    await poll();
    const a = await question(q);
    assert.equal(a.answered_by, null);
    assert.ok(a.answered_at);
    assert.match(a.answer!, new RegExp(`PR #${pr} conflicts with its base main`));
    const events = await requeues(id);
    assert.equal(events.length, 1);
    assert.equal(events[0].actor, "system");
    assert.deepEqual(events[0].payload, { questionId: q, prNumber: pr, reason: "conflict", base: "main" });
    assert.equal((await db.pool.query("select next_stage from run where item_id = $1", [id])).rows[0].next_stage, "address");
    assert.equal((await row((await db.pool.query("select external_id from item where id = $1", [id])).rows[0].external_id)).state, "NeedsInput");
  });

  test("a trusted review newer than the question answers it with the review's time, and an older one doesn't (PBI 305)", async () => {
    await db.pool.query(`insert into "user" (provider, subject, github_login, role) values ('microsoft', 'octo', 'octo', 'viewer')`);
    const { id, q, pr, p } = await waiting(NO_REVIEW_TEXT);
    p.reviews.push({ state: "changes_requested", submittedAt: "2026-11-10T08:00:00Z", author: "octo", body: "x" });
    await poll();
    assert.equal((await question(q)).answer, null);
    p.reviews.push({ state: "changes_requested", submittedAt: "2026-11-10T10:30:00Z", author: "octo", body: "x" });
    await poll();
    const a = await question(q);
    assert.equal(a.answered_by, null);
    assert.match(a.answer!, new RegExp(`trusted review asked for changes on PR #${pr} at 2026-11-10T10:30:00.000Z`));
    const events = await requeues(id);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].payload, { questionId: q, prNumber: pr, reason: "review", at: "2026-11-10T10:30:00.000Z" });
  });

  test("a held item, an item on another question, or a PR GitHub hasn't worked out, keeps the question open (PBI 305)", async () => {
    const heldOne = await waiting(NO_REVIEW_TEXT);
    await db.pool.query("update item set held = true where id = $1", [heldOne.id]);
    heldOne.p.mergeable = false;
    const other = await waiting("Address failed: CI failed on the PR");
    other.p.mergeable = false;
    const unknown = await waiting(NO_REVIEW_TEXT);
    unknown.p.mergeable = null;
    await poll();
    for (const w of [heldOne, other, unknown]) {
      assert.equal((await question(w.q)).answer, null);
      assert.equal((await requeues(w.id)).length, 0);
    }
    await db.pool.query("update item set held = false where id = $1", [heldOne.id]);
    await poll();
    assert.ok((await question(heldOne.q)).answer);
  });

  test("two polls at once answer the question and log the re-queue once (PBI 305)", async () => {
    const { id, q, p } = await waiting(NO_REVIEW_TEXT);
    p.mergeable = false;
    await Promise.all([poll(), poll()]);
    assert.ok((await question(q)).answer);
    assert.equal((await requeues(id)).length, 1);
  });

  const greens = async (id: string) =>
    (await db.pool.query<{ actor: string; payload: Record<string, unknown> }>("select actor, payload from event where item_id = $1 and kind = $2", [id, REQUEUED_FOR_GREEN])).rows;
  const nextStage = async (id: string) => (await db.pool.query("select next_stage from run where item_id = $1", [id])).rows[0].next_stage;

  test("an older \"Address failed\" question naming only CI failures is answered once, for Green, by the factory (PBI 317)", async () => {
    const { id, q, pr } = await waiting("Address failed:\n- CI failed on m3rge01\n- CI failed on m3rge02, the PR addresser's fix");
    await poll();
    await poll();
    const a = await question(q);
    assert.equal(a.answer, CI_BACK_TO_GREEN);
    assert.equal(a.answered_by, null);
    assert.ok(a.answered_at);
    const events = await greens(id);
    assert.equal(events.length, 1);
    assert.equal(events[0].actor, "system");
    assert.deepEqual(events[0].payload, { questionId: q, prNumber: pr });
    assert.equal(await nextStage(id), "green");
  });

  test("one naming something besides CI failures, a held item, or a person's answer keeps it as it was (PBI 317)", async () => {
    const mixed = await waiting("Address failed:\n- CI failed on m3rge01\n- the locked scenario file \"a.feature\" changed");
    const heldOne = await waiting("Address failed:\n- CI failed on m3rge01");
    await db.pool.query("update item set held = true where id = $1", [heldOne.id]);
    const answered = await waiting("Address failed:\n- CI failed on m3rge01");
    await db.pool.query("update question set answer = 'Leave it', decision = 'answer', answered_at = now() where id = $1", [answered.q]);
    await poll();
    for (const w of [mixed, heldOne]) assert.equal((await question(w.q)).answer, null);
    assert.equal((await question(answered.q)).answer, "Leave it");
    for (const w of [mixed, heldOne, answered]) {
      assert.equal((await greens(w.id)).length, 0);
      assert.equal(await nextStage(w.id), "address");
    }
    await db.pool.query("update item set held = false where id = $1", [heldOne.id]);
    await poll();
    assert.equal((await question(heldOne.q)).answer, CI_BACK_TO_GREEN);
  });

  test("a CI-only \"Address failed\" question asked since #292 shipped waits for a person, its run still at address (PBI 317)", async () => {
    const { id, q } = await waiting("Address failed:\n- CI failed on m3rge02, the PR addresser's fix", "2026-11-15T06:00:00Z");
    await poll();
    assert.equal((await question(q)).answer, null);
    assert.equal((await greens(id)).length, 0);
    assert.equal(await nextStage(id), "address");
  });

  test("two polls at once answer an older CI-failed question and log its re-queue once (PBI 317)", async () => {
    const { id, q } = await waiting("Address failed:\n- CI failed on m3rge01");
    await Promise.all([poll(), poll()]);
    assert.equal((await question(q)).answer, CI_BACK_TO_GREEN);
    assert.equal((await greens(id)).length, 1);
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

  test("given a defaults reader, the gate and the fingerprint read the defaults from it, not the policy directory (PBI 261)", async () => {
    commit("c2", { ".factory/config.yml": files[".factory/config.yml"], ".factory/dod.md": files[".factory/dod.md"] });
    const held: Record<string, string> = { dor: "- [ ] Names the user it serves\n", scenarios: "s\n", "pr-review": "- [ ] p\n", risk: "r\n" };
    const defaults = async (name: string) => held[name];
    const asked: string[] = [];
    const recording = async (item: FactoryItem, dor: Policy) => {
      asked.push(...dor.criteria.map((c) => c.text));
      return judge(item, dor);
    };
    const pollWith = () => pollOnce({ pool: db.pool, adapter: fake.adapter, repoHost: host, judge: recording, sourceId, defaults });
    verdict = "failed";
    const ext = await seed();
    await pollWith();
    assert.deepEqual(asked, ["Names the user it serves"]);
    const before = await readinessFingerprint({ pool: db.pool, repoHost: host, repo: REPO, defaults });
    assert.equal((await row(ext)).readiness_policy_sha, before);
    await pollWith();
    assert.deepEqual(judged, [ext], "the same defaults don't re-gate");
    held.risk = "r changed\n";
    assert.notEqual(await readinessFingerprint({ pool: db.pool, repoHost: host, repo: REPO, defaults }), before);
    verdict = "passed";
    await pollWith();
    assert.equal((await row(ext)).state, "Queued");
  });

  test("a pinnable defaults reader is pinned once per poll, so a move mid-poll can't mix two commits (PBI 261)", async () => {
    commit("c2", { ".factory/config.yml": files[".factory/config.yml"], ".factory/dod.md": files[".factory/dod.md"] });
    const commits: Record<string, string>[] = [{ dor: "- [ ] Old\n", scenarios: "s\n", "pr-review": "- [ ] p\n", risk: "r\n" }];
    let pins = 0;
    // Each pin fixes the latest commit; a fresh read of the moving ref follows the latest, and moves it after the dor read.
    const moving = async (name: string) => {
      const text = commits[commits.length - 1][name];
      if (name === "dor") commits.push({ dor: "- [ ] New\n", scenarios: "s\n", "pr-review": "- [ ] p\n", risk: "r new\n" });
      return text;
    };
    const defaults = Object.assign(moving, {
      pin: async () => {
        pins++;
        const at = commits[commits.length - 1];
        return async (name: string) => at[name];
      },
    });
    const sha = await readinessFingerprint({ pool: db.pool, repoHost: host, repo: REPO, defaults });
    assert.equal(pins, 1, "one pin for the whole poll");
    const pinnedFirst = { ...commits[0] };
    assert.equal(sha, await readinessFingerprint({ pool: db.pool, repoHost: host, repo: REPO, defaults: async (n: string) => pinnedFirst[n] }));
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

    test("a NeedsInput merge that went through while the call failed gets the question's note and names the question when the next poll sees it (PBI 262)", async () => {
      await allow("octo");
      const { ext, id, pr, p } = await ready("NeedsInput");
      const qid = (await db.pool.query<{ id: string }>(
        "insert into question (item_id, kind, body, asked_at) values ($1, 'needs_input', 'Address failed', now()) returning id", [id],
      )).rows[0].id;
      const mergePr = host.mergePr.bind(host);
      host.mergePr = async (...args) => {
        await mergePr(...args);
        throw new Error("502 Bad Gateway");
      };
      await poll();
      assert.equal(p.merged, true);
      assert.equal((await row(ext)).state, "NeedsInput");
      assert.deepEqual(await events("factory_merge_attempt"), [
        { repo: REPO, prNumber: pr, headSha: "h1", approvers: ["octo"], waitingIn: "NeedsInput", question: "Address failed", questionId: qid },
      ]);
      host.mergePr = mergePr;
      await poll();
      assert.equal((await row(ext)).state, "Accepted");
      const q = (await db.pool.query("select closed_at, answer, closed_note from question where id = $1", [qid])).rows[0];
      assert.ok(q.closed_at);
      assert.equal(q.answer, null);
      assert.equal(q.closed_note, `The factory merged PR #${pr} as commit m9.`);
      assert.deepEqual(await events("factory_merged"), [
        { repo: REPO, prNumber: pr, mergeSha: "m9", approvers: ["octo"], waitingIn: "NeedsInput", question: "Address failed" },
      ]);
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

    test("a clean, approved NeedsInput PR merges, its question closes with a note naming the merge, and the event names the question (PBI 262)", async () => {
      await allow("octo");
      const { ext, id, pr, run } = await ready("NeedsInput");
      await db.pool.query("insert into question (item_id, kind, body, asked_at) values ($1, 'needs_input', 'Address failed', now())", [id]);
      await poll();
      assert.equal((await row(ext)).state, "Accepted");
      assert.equal((await db.pool.query("select merge_sha from run where id = $1", [run])).rows[0].merge_sha, "m9");
      const q = (await db.pool.query("select closed_at, answer, closed_note from question where item_id = $1", [id])).rows[0];
      assert.ok(q.closed_at);
      assert.equal(q.answer, null);
      assert.equal(q.closed_note, `The factory merged PR #${pr} as commit m9.`);
      assert.deepEqual(await events("factory_merged"), [
        { repo: REPO, prNumber: pr, mergeSha: "m9", approvers: ["octo"], waitingIn: "NeedsInput", question: "Address failed" },
      ]);
      const moves = (await db.pool.query("select payload from event where item_id = $1 and kind = 'transition'", [id])).rows.map((r) => r.payload);
      assert.deepEqual(moves, [{ from: "NeedsInput", to: "Accepted", event: "merged" }]);
    });

    test("a held NeedsInput item, or one whose PR isn't clean, isn't merged and keeps its question open with no note (PBI 262)", async () => {
      await allow("octo");
      const a = await ready("NeedsInput");
      await db.pool.query("update item set held = true where id = $1", [a.id]);
      const b = await ready("NeedsInput");
      b.p.mergeState = "blocked";
      for (const h of [a, b]) await db.pool.query("insert into question (item_id, kind, body, asked_at) values ($1, 'needs_input', 'q', now())", [h.id]);
      await poll();
      assert.deepEqual(host.mergeCalls, []);
      for (const h of [a, b]) {
        assert.equal((await row(h.ext)).state, "NeedsInput");
        const q = (await db.pool.query("select closed_at, closed_note from question where item_id = $1", [h.id])).rows[0];
        assert.deepEqual(q, { closed_at: null, closed_note: null });
      }
    });

    test("a NeedsInput PR with unaddressed trusted changes, an open trusted thread or a conflict isn't merged, and the item stays on its question (PBI 262)", async () => {
      await allow("octo");
      await allow("kim");
      const seen = "2026-11-06T10:00:00Z";
      const a = await ready("NeedsInput");
      const b = await ready("NeedsInput");
      const c = await ready("NeedsInput");
      for (const h of [a, b, c]) await db.pool.query("update run set reviews_seen_at = $2 where id = $1", [h.run, seen]);
      a.p.reviews.push({ state: "changes_requested", submittedAt: "2026-11-06T10:30:00Z", author: "kim", body: "Fix it." });
      b.p.reviews.push({ state: "commented", submittedAt: "2026-11-06T10:30:00Z", author: "kim" });
      host.reviewComments.set(`${b.p.repo}#${b.pr}`, [{ threadId: "t1", path: "a.ts", line: 1, author: "kim", body: "Cite the probe.", submittedAt: "2026-11-06T10:30:00Z" }]);
      c.p.mergeable = false;
      for (const h of [a, b, c]) await db.pool.query("insert into question (item_id, kind, body, asked_at) values ($1, 'needs_input', 'q', now())", [h.id]);
      await poll();
      assert.deepEqual(host.mergeCalls, []);
      for (const h of [a, b, c]) {
        assert.equal((await row(h.ext)).state, "NeedsInput");
        const q = (await db.pool.query("select closed_at, closed_note from question where item_id = $1", [h.id])).rows[0];
        assert.deepEqual(q, { closed_at: null, closed_note: null });
      }
    });
  });

  describe("re-queuing an item stopped by a red base once CI passes on it (PBI 260)", () => {
    /** A NeedsInput item whose open question says the base failed at `sha`, or asks something else with `sha` null. */
    async function waiting(sha: string | null, base?: string) {
      const h = await held("NeedsInput");
      const failure = sha === null ? null : { sha, tests: ["parses the config"], ...(base ? { base } : {}) };
      const q = (await db.pool.query<{ id: string }>(
        "insert into question (item_id, kind, body, base_failure) values ($1, 'needs_input', 'The base fails in the cell.', $2) returning id",
        [h.id, failure === null ? null : JSON.stringify(failure)],
      )).rows[0].id;
      return { ...h, question: q };
    }
    const question = async (id: string) =>
      (await db.pool.query("select answer, answered_by, decision from question where id = $1", [id])).rows[0];
    const requeues = async (itemId: string) =>
      (await db.pool.query("select actor, actor_id, payload from event where item_id = $1 and kind = 'requeued_after_base_passed'", [itemId])).rows;

    test("CI passing on a newer base commit answers the question as the factory and logs one system event", async () => {
      host.branches.set(`${REPO}@main`, ["b1", "b2", "b3"]);
      host.checks.set(`${REPO}@b3`, "pending");
      host.checks.set(`${REPO}@b2`, "success");
      const w = await waiting("b1", "main");
      await poll();
      await poll();
      const q = await question(w.question);
      assert.equal(q.answered_by, null);
      assert.match(q.answer, /CI passed on .*b2/);
      const events = await requeues(w.id);
      assert.equal(events.length, 1);
      assert.equal(events[0].actor, "system");
      assert.equal(events[0].payload.sha, "b2");
      assert.equal(events[0].payload.base, "main");
    });

    test("CI on the failing commit, an older one, or still pending or failing on a newer one leaves the question open", async () => {
      host.branches.set(`${REPO}@main`, ["b0", "b1", "b2", "b3"]);
      host.checks.set(`${REPO}@b0`, "success");
      host.checks.set(`${REPO}@b1`, "success");
      host.checks.set(`${REPO}@b2`, "pending");
      host.checks.set(`${REPO}@b3`, "failure");
      const w = await waiting("b1");
      await poll();
      assert.equal((await question(w.question)).answer, null);
      assert.deepEqual(await requeues(w.id), []);
    });

    test("a pass behind a newer failing commit leaves the question open, since the base is red again", async () => {
      host.branches.set(`${REPO}@main`, ["b1", "b2", "b3"]);
      host.checks.set(`${REPO}@b2`, "success");
      host.checks.set(`${REPO}@b3`, "failure");
      const w = await waiting("b1", "main");
      await poll();
      assert.equal((await question(w.question)).answer, null);
      assert.deepEqual(await requeues(w.id), []);
    });

    test("a question with no base failure, or a held item, isn't answered, and a released one is", async () => {
      host.branches.set(`${REPO}@main`, ["b1", "b2"]);
      host.checks.set(`${REPO}@b2`, "success");
      const other = await waiting(null);
      const hold = await waiting("b1", "main");
      await db.pool.query("update item set held = true where id = $1", [hold.id]);
      await poll();
      assert.equal((await question(other.question)).answer, null);
      assert.equal((await question(hold.question)).answer, null);
      await db.pool.query("update item set held = false where id = $1", [hold.id]);
      await poll();
      assert.equal((await question(other.question)).answer, null);
      assert.notEqual((await question(hold.question)).answer, null);
      assert.deepEqual(await requeues(other.id), []);
    });

    test("an item waits on its own base branch's CI, and a question without a branch waits on main", async () => {
      host.branches.set(`${REPO}@main`, ["b1", "b2"]);
      host.branches.set(`${REPO}@release`, ["r1"]);
      host.checks.set(`${REPO}@b2`, "success");
      const onRelease = await waiting("r1", "release");
      const onMain = await waiting("b1");
      await poll();
      assert.equal((await question(onRelease.question)).answer, null);
      assert.notEqual((await question(onMain.question)).answer, null);
    });
  });
});
