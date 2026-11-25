import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { fakeBacklog, fakeRepoHost } from "../adapters/fake.ts";
import type { CheckRun } from "../adapters/types.ts";
import { runToken } from "../control/cell-api.ts";
import { withTx } from "../store/db.ts";
import { requestFeatureChange } from "../store/feature-change.ts";
import { transitionItem } from "../store/items.ts";
import { clearRestartOnStart, setOverride, type OverrideKind } from "../store/overrides.ts";
import { dbTest, startTestDb } from "../store/test-db.ts";
import { fakeLauncher } from "./launcher.ts";
import { FAILED_RECHECK_MS, tick, type CiMemo } from "./scheduler.ts";

// The scenarios in features/pbi-17-scheduler.feature cover WIP, the brake, the kill switch, stop and re-queue. These
// cover the rest of plan Task 13's list.
const NOW = new Date("2026-11-06T10:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const DAY = 86_400_000;
const REPO = "ricksu978/software-factory";

describe("scheduler", dbTest, () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let backlog: ReturnType<typeof fakeBacklog>;
  let repoHost: ReturnType<typeof fakeRepoHost>;
  let source: string;
  let repoId: string;
  let operator: string;
  let launcher: ReturnType<typeof fakeLauncher>;
  let started: Record<string, string>[];
  let stopped: string[];

  before(async () => {
    db = await startTestDb();
  });
  after(async () => {
    await db?.stop();
  });
  beforeEach(async () => {
    await db.pool.query("truncate item, override, \"user\", repo, backlog_source cascade");
    await db.pool.query("update wip_policy set current_wip = 1, review_capacity = 3, usage_paused_until = null");
    source = (await db.pool.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'unit') returning id")).rows[0].id;
    repoId = (await db.pool.query<{ id: string }>("insert into repo (host_adapter, url) values ('github', $1) returning id", [`https://github.com/${REPO}`])).rows[0].id;
    operator = (await db.pool.query<{ id: string }>("insert into \"user\" (provider, subject, role) values ('dev', 'op', 'operator') returning id")).rows[0].id;
    backlog = fakeBacklog();
    repoHost = fakeRepoHost();
    repoHost.heads.set(REPO, "c0ffee0");
    launcher = fakeLauncher();
    started = launcher.started;
    stopped = launcher.stopped;
  });

  const run = (now = NOW, killFlag = false) =>
    tick({ pool: db.pool, launcher, now, killFlag, repoHost, backlogFor: () => backlog.adapter, secret: "s3cret", controlUrl: "http://control:7400", sopVersion: "default@1" });
  async function item(externalId: string, state: string, set = ""): Promise<string> {
    await backlog.seed({ externalId, repo: REPO, acceptanceCriteria: ["it works", "it's fast"] });
    const id = (await db.pool.query<{ id: string }>(
      "insert into item (source_id, external_id, title, state) values ($1, $2, 't', $3) returning id", [source, externalId, state],
    )).rows[0].id;
    if (set) await db.pool.query(`update item set ${set} where id = $1`, [id]);
    return id;
  }
  const openRun = async (itemId: string, set = "next_stage = 'green'") => {
    const id = (await db.pool.query<{ id: string }>("insert into run (item_id) values ($1) returning id", [itemId])).rows[0].id;
    await db.pool.query(`update run set ${set} where id = $1`, [id]);
    return id;
  };
  const override = (kind: OverrideKind, targetId: string | null = null) =>
    setOverride(db.pool, { scope: targetId ? "item" : "factory", targetId, kind, reason: "unit", createdBy: operator, expiresAt: null });
  const state = async (id: string) => (await db.pool.query("select state, held from item where id = $1", [id])).rows[0];

  for (const kind of ["drain", "pause"] as const) {
    test(`a factory ${kind} starts nothing, and resume lifts it`, async () => {
      await item("1", "Queued");
      await override(kind);
      await run();
      assert.deepEqual(started, []);
      await override("resume");
      await run();
      assert.equal(started.length, 1);
    });
  }

  test("a cell gets exactly the six Run contract 5 variables, and the first claim pins the run", async () => {
    const id = await item("1", "Queued");
    await run();
    const r = (await db.pool.query("select id, repo_id, config_sha, sop_version, execution_name from run where item_id = $1", [id])).rows[0];
    const gen = (await db.pool.query<{ lease_generation: number }>("select lease_generation from item where id = $1", [id])).rows[0].lease_generation;
    assert.deepEqual(started, [{
      RUN_ID: r.id, ITEM_ID: id, GENERATION: String(gen), RUN_TOKEN: runToken("s3cret", r.id, gen), CONTROL_URL: "http://control:7400", RESUME_FROM: "understand",
    }]);
    assert.deepEqual({ ...r, id: undefined }, { id: undefined, repo_id: repoId, config_sha: "c0ffee0", sop_version: "default@1", execution_name: "cell-1" });
  });

  test("a claim that opens a new run writes the criteria hash, and a resumed run keeps its pins", async () => {
    const fresh = await item("1", "Queued");
    await run();
    const hash = (await db.pool.query("select criteria_hash from item where id = $1", [fresh])).rows[0].criteria_hash;
    assert.match(hash, /^[0-9a-f]{64}$/);
    await db.pool.query("truncate item cascade");
    const resumed = await item("2", "Queued", "criteria_hash = 'old'");
    await openRun(resumed, `next_stage = 'address', config_sha = 'pinned', repo_id = '${repoId}', sop_version = 'v0'`);
    await run();
    assert.equal((await db.pool.query("select criteria_hash from item where id = $1", [resumed])).rows[0].criteria_hash, "old");
    assert.equal((await db.pool.query("select config_sha from run where item_id = $1", [resumed])).rows[0].config_sha, "pinned");
  });

  test("an item whose repo isn't configured is held with the reason, and the next tick starts the item behind it", async () => {
    await backlog.seed({ externalId: "1", repo: "someone/else" });
    const id = (await db.pool.query<{ id: string }>(
      "insert into item (source_id, external_id, title, state, backlog_rank) values ($1, '1', 't', 'Queued', 1) returning id", [source],
    )).rows[0].id;
    const behind = await item("2", "Queued", "backlog_rank = 2");
    await run();
    assert.equal(started.length, 0);
    assert.deepEqual(await state(id), { state: "Queued", held: true });
    assert.match((await backlog.comments("1")).join(), /someone\/else isn't configured/);
    await run();
    assert.deepEqual(started.map((e) => e.ITEM_ID), [behind]);
  });

  test("while any run waits for its usage reset, nothing at all starts", async () => {
    const limited = await item("1", "Queued");
    await openRun(limited, `resume_at = '${new Date(NOW.getTime() + 600_000).toISOString()}'`);
    await item("2", "Queued");
    await run();
    assert.deepEqual(started, []);
    await run(new Date(NOW.getTime() + 600_001));
    assert.equal(started.length, 1);
  });

  test("while usage is paused under the reserve, nothing starts", async () => {
    await item("1", "Queued");
    await db.pool.query("update wip_policy set usage_paused_until = $1", [new Date(NOW.getTime() + 60_000)]);
    await run();
    assert.deepEqual(started, []);
  });

  test("stopping a run comments its branch on the item", async () => {
    const id = await item("7", "InProgress", `lease_owner = 'cell', lease_expires = '${new Date(NOW.getTime() + 60_000).toISOString()}'`);
    await openRun(id, "execution_name = 'cell-7', run_number = 2");
    await override("stop_run", id);
    await run();
    assert.deepEqual(stopped, ["cell-7"]);
    assert.match((await backlog.comments("7")).join("\n"), /`factory\/pbi-7-r2`/);
  });

  test("an item's overrides end when it reaches Done, Failed or Abandoned", async () => {
    const id = await item("1", "Done");
    await override("hold", id);
    await run();
    const left = await db.pool.query("select 1 from override where target_id = $1 and cleared_at is null", [id]);
    assert.equal(left.rowCount, 0);
  });

  test("a Split parent's overrides end, since Split is an end state", async () => {
    const id = await item("1", "Split");
    await override("hold", id);
    await run();
    const left = await db.pool.query("select 1 from override where target_id = $1 and cleared_at is null", [id]);
    assert.equal(left.rowCount, 0);
  });

  test("a question gets a reminder at 2 days and at 4, once each", async () => {
    const id = await item("1", "SignOff");
    await openRun(id, "next_stage = 'sign-off'");
    await db.pool.query("insert into question (item_id, kind, body, asked_at) values ($1, 'sign_off', 'q', $2)", [id, ago(2 * DAY + 1)]);
    await run();
    await run(new Date(NOW.getTime() + 600_000));
    assert.equal((await backlog.comments("1")).length, 1);
    await run(new Date(NOW.getTime() + 2 * DAY));
    assert.equal((await backlog.comments("1")).length, 2);
    assert.equal((await db.pool.query("select reminders_sent from question where item_id = $1", [id])).rows[0].reminders_sent, 2);
  });

  test("a merge commit with no checks an hour after the merge fails the item, and a green one makes it Done", async () => {
    const silent = await item("1", "Accepted");
    await openRun(silent, `merge_sha = 'aaa1111', repo_id = '${repoId}'`);
    await db.pool.query("insert into event (at, actor, actor_id, item_id, kind, payload) values ($1, 'system', 't', $2, 'transition', '{\"to\":\"Accepted\"}')", [ago(3_600_001), silent]);
    const green = await item("2", "Accepted");
    await openRun(green, `merge_sha = 'bbb2222', repo_id = '${repoId}'`);
    repoHost.checks.set(`${REPO}@bbb2222`, "success");
    await run();
    assert.equal((await state(silent)).state, "Failed");
    assert.match((await backlog.comments("1")).join(), /No CI ran on main/);
    assert.equal((await state(green)).state, "Done");
  });

  // PBI 255: a red merge commit compared with its first parent. The scenarios cover the rest.
  async function redMerge(externalId: string, sha: string, parent: string, mergeRuns: CheckRun[], parentRuns: CheckRun[], mergedAgo = 60_000) {
    const id = await item(externalId, "Accepted");
    await openRun(id, `merge_sha = '${sha}', repo_id = '${repoId}', pr_number = 9`);
    await db.pool.query("insert into event (at, actor, actor_id, item_id, kind, payload) values ($1, 'system', 't', $2, 'transition', '{\"to\":\"Accepted\"}')", [ago(mergedAgo), id]);
    repoHost.parents.set(`${REPO}@${sha}`, parent);
    repoHost.runs.set(`${REPO}@${sha}`, mergeRuns);
    repoHost.runs.set(`${REPO}@${parent}`, parentRuns);
    repoHost.checks.set(`${REPO}@${sha}`, "failure");
    return id;
  }
  const check = (name: string, status: CheckRun["status"]): CheckRun => ({ name, status, url: `https://github.com/${REPO}/runs/${name}` });

  test("a red merge whose failed check still runs on its first parent waits a poll, and counts it passed after an hour (PBI 255)", async () => {
    const id = await redMerge("1", "m1", "p1", [check("test", "failure")], [check("test", "pending")]);
    await run();
    assert.equal((await state(id)).state, "Accepted");
    await run(new Date(NOW.getTime() + 3_600_000));
    assert.equal((await state(id)).state, "Failed");
    assert.equal(backlog.filed.length, 1);
  });

  test("a red merge with no failed check run, as with CI that reports statuses, is charged and files no bug item (PBI 255)", async () => {
    const id = await redMerge("1", "m1", "p1", [], []);
    await run();
    assert.equal((await state(id)).state, "Failed");
    assert.equal(backlog.filed.length, 0);
    assert.equal((await db.pool.query("select count(*)::int as n from main_break")).rows[0].n, 0);
  });

  test("a merge whose own run was cancelled by the next merge isn't charged: it waits on main and the next merge is charged with the break (PBI 255)", async () => {
    const first = await redMerge("1", "m1", "p1", [check("test", "cancelled")], [check("test", "success")]);
    const second = await redMerge("2", "m2", "m1", [check("test", "failure")], [check("test", "cancelled")], 50_000);
    repoHost.branches.set(`${REPO}@main`, ["p1", "m1", "m2"]);
    await db.pool.query("update wip_policy set current_wip = 0");
    await run();
    assert.equal((await state(first)).state, "Accepted");
    assert.match((await backlog.comments("1")).join(), /was cancelled/);
    assert.equal((await state(second)).state, "Failed");
    assert.deepEqual((await db.pool.query("select merge_sha from main_break")).rows, [{ merge_sha: "m2" }]);
    repoHost.branches.set(`${REPO}@main`, ["p1", "m1", "m2", "f1"]);
    repoHost.checks.set(`${REPO}@f1`, "success");
    await run();
    assert.equal((await state(first)).state, "Done");
  });

  test("a bug item names no label of its own, so the board adds only its own opt-in label (PBI 255)", async () => {
    await redMerge("1", "m1", "p1", [check("test", "failure")], [check("test", "success")]);
    const fileItem = backlog.adapter.fileItem;
    const asked: string[][] = [];
    backlog.adapter.fileItem = async (p, key) => { asked.push(p.labels); return fileItem(p, key); };
    await run();
    backlog.adapter.fileItem = fileItem;
    assert.deepEqual(asked, [[]]);
  });

  test("a bug item whose filing fails is filed on a later tick, and once (PBI 255)", async () => {
    const id = await redMerge("1", "m1", "p1", [check("test", "failure")], [check("test", "success")]);
    const fileItem = backlog.adapter.fileItem;
    backlog.adapter.fileItem = async () => { throw new Error("GitHub is down"); };
    await run();
    assert.equal((await state(id)).state, "Failed");
    assert.equal(backlog.filed.length, 0);
    backlog.adapter.fileItem = fileItem;
    await run();
    await run();
    assert.equal(backlog.filed.length, 1);
    assert.equal((await db.pool.query("select bug_external_id from main_break")).rows[0].bug_external_id, backlog.filed[0]);
  });

  test("a break that clears before its bug item could be filed gets none (PBI 255)", async () => {
    await redMerge("1", "m1", "p1", [check("test", "failure")], [check("test", "success")]);
    const fileItem = backlog.adapter.fileItem;
    backlog.adapter.fileItem = async () => { throw new Error("GitHub is down"); };
    await run();
    repoHost.branches.set(`${REPO}@main`, ["p1", "m1", "f1"]);
    repoHost.checks.set(`${REPO}@f1`, "success");
    await run();
    backlog.adapter.fileItem = fileItem;
    await run();
    assert.equal((await db.pool.query("select cleared_sha from main_break")).rows[0].cleared_sha, "f1");
    assert.equal(backlog.filed.length, 0);
  });

  test("a bug item stops coming first once main is green again (PBI 255)", async () => {
    const charged = await redMerge("1", "m1", "p1", [check("test", "failure")], [check("test", "success")]);
    await run();
    const bug = await item(backlog.filed[0], "Queued", "priority = 0");
    const urgent = await item("90", "Queued", "priority = 9");
    assert.ok(charged && bug && urgent);
    repoHost.branches.set(`${REPO}@main`, ["p1", "m1", "f1"]);
    repoHost.checks.set(`${REPO}@f1`, "success");
    await db.pool.query("update wip_policy set current_wip = 0");
    await run();
    assert.ok((await db.pool.query("select cleared_sha from main_break where bug_item_id = $1", [bug])).rows[0]?.cleared_sha === "f1");
    await db.pool.query("update wip_policy set current_wip = 1");
    await run();
    assert.equal((await state(urgent)).state, "InProgress");
    assert.equal((await state(bug)).state, "Queued");
  });

  test("a bug item whose merge leaves main red with the same checks is charged, not set to wait (PBI 255)", async () => {
    await redMerge("1", "m1", "p1", [check("test", "failure")], [check("test", "success")]);
    await run();
    const bug = await redMerge(backlog.filed[0], "m2", "m1", [check("test", "failure")], [check("test", "failure")]);
    await db.pool.query("update main_break set bug_item_id = $1", [bug]);
    await run();
    assert.equal((await state(bug)).state, "Failed");
    assert.equal((await db.pool.query("select waits_on_branch from run where item_id = $1", [bug])).rows[0].waits_on_branch, null);
    assert.equal(backlog.filed.length, 1);
    assert.equal((await db.pool.query("select count(*)::int as n from main_break where cleared_at is null")).rows[0].n, 1);
  });

  test("one read of main per pass answers every waiting item and standing break on it (PBI 255)", async () => {
    await redMerge("1", "m1", "p1", [check("test", "failure")], [check("test", "success")]);
    const second = await redMerge("2", "m2", "m1", [check("test", "failure")], [check("test", "failure")], 50_000);
    const third = await redMerge("3", "m3", "m2", [check("test", "failure")], [check("test", "failure")], 40_000);
    repoHost.branches.set(`${REPO}@main`, ["p1", "m1", "m2", "m3"]);
    await db.pool.query("update wip_policy set current_wip = 0");
    await run();
    const commitsAfter = repoHost.commitsAfter;
    const asked: string[] = [];
    repoHost.commitsAfter = async (repo, branch, sha) => { asked.push(sha); return commitsAfter(repo, branch, sha); };
    await run();
    assert.deepEqual(asked, ["m1"]);
    repoHost.branches.set(`${REPO}@main`, ["p1", "m1", "m2", "m3", "f1"]);
    repoHost.checks.set(`${REPO}@f1`, "success");
    asked.length = 0;
    await run();
    repoHost.commitsAfter = commitsAfter;
    assert.deepEqual(asked, ["m1"]);
    assert.equal((await state(second)).state, "Done");
    assert.equal((await state(third)).state, "Done");
    assert.equal((await db.pool.query("select cleared_sha from main_break")).rows[0].cleared_sha, "f1");
  });

  test("a red main's failed commits are read once per recheck window, not every tick, and a re-run turned green is seen after it (PBI 255)", async () => {
    await redMerge("1", "m1", "p1", [check("test", "failure")], [check("test", "success")]);
    const second = await redMerge("2", "m2", "m1", [check("test", "failure")], [check("test", "failure")], 50_000);
    repoHost.branches.set(`${REPO}@main`, ["p1", "m1", "m2", "x1", "x2"]);
    for (const sha of ["x1", "x2"]) repoHost.checks.set(`${REPO}@${sha}`, "failure");
    await db.pool.query("update wip_policy set current_wip = 0");
    const ciMemo: CiMemo = new Map();
    const memoRun = (now: Date) =>
      tick({ pool: db.pool, launcher, now, killFlag: false, repoHost, backlogFor: () => backlog.adapter, secret: "s3cret", controlUrl: "http://control:7400", sopVersion: "default@1", ciMemo });
    await memoRun(NOW);
    await memoRun(NOW);
    const checksOnSha = repoHost.checksOnSha;
    const read: string[] = [];
    repoHost.checksOnSha = async (repo, sha) => { read.push(sha); return checksOnSha(repo, sha); };
    await memoRun(new Date(NOW.getTime() + 15_000));
    assert.equal(read.length, 0);
    repoHost.checks.set(`${REPO}@x2`, "success");
    await memoRun(new Date(NOW.getTime() + FAILED_RECHECK_MS));
    repoHost.checksOnSha = checksOnSha;
    assert.ok(read.includes("x2"));
    assert.equal((await state(second)).state, "Done");
    assert.equal((await db.pool.query("select cleared_sha from main_break")).rows[0].cleared_sha, "x2");
  });

  test("a merge onto a main already red with no standing break records the break at its first parent, charges nothing and files no bug item (PBI 255)", async () => {
    const first = await redMerge("1", "m1", "p1", [check("test", "failure")], [check("test", "failure")]);
    const second = await redMerge("2", "m2", "m1", [check("test", "failure")], [check("test", "failure")], 50_000);
    repoHost.branches.set(`${REPO}@main`, ["p1", "m1", "m2"]);
    await db.pool.query("update wip_policy set current_wip = 0");
    await run();
    await run();
    assert.equal((await state(first)).state, "Accepted");
    assert.equal((await state(second)).state, "Accepted");
    assert.equal(backlog.filed.length, 0);
    const breaks = (await db.pool.query("select merge_sha, item_id, failed_checks, cleared_at from main_break")).rows;
    assert.deepEqual(breaks, [{ merge_sha: "p1", item_id: null, failed_checks: [{ name: "test", url: `https://github.com/${REPO}/runs/test`, tests: [] }], cleared_at: null }]);
    repoHost.branches.set(`${REPO}@main`, ["p1", "m1", "m2", "f1"]);
    repoHost.checks.set(`${REPO}@f1`, "success");
    await run();
    assert.equal((await state(first)).state, "Done");
    assert.equal((await db.pool.query("select cleared_sha from main_break")).rows[0].cleared_sha, "f1");
  });

  test("a merge found broken after a later merge recorded main red at it uncharged takes that break over and files its bug item (PBI 255)", async () => {
    const first = await redMerge("1", "m1", "p1", [check("test", "failure")], [check("test", "pending")]);
    const second = await redMerge("2", "m2", "m1", [check("test", "failure")], [check("test", "failure")], 50_000);
    repoHost.branches.set(`${REPO}@main`, ["p1", "m1", "m2"]);
    await db.pool.query("update wip_policy set current_wip = 0");
    await run();
    assert.equal((await state(first)).state, "Accepted");
    assert.equal((await db.pool.query("select item_id from main_break where merge_sha = 'm1'")).rows[0].item_id, null);
    repoHost.runs.set(`${REPO}@p1`, [check("test", "success")]);
    await run();
    assert.equal((await state(first)).state, "Failed");
    assert.equal((await state(second)).state, "Accepted");
    const breaks = (await db.pool.query("select merge_sha, item_id, pr_number, bug_external_id from main_break")).rows;
    assert.equal(breaks.length, 1);
    assert.deepEqual(breaks[0], { merge_sha: "m1", item_id: first, pr_number: 9, bug_external_id: backlog.filed[0] });
    assert.equal(backlog.filed.length, 1);
  });

  test("a merge found broken after the uncharged break recorded at it cleared takes it over and files no bug item (PBI 255)", async () => {
    const first = await redMerge("1", "m1", "p1", [check("test", "failure")], [check("test", "pending")]);
    await redMerge("2", "m2", "m1", [check("test", "failure")], [check("test", "failure")], 50_000);
    repoHost.branches.set(`${REPO}@main`, ["p1", "m1", "m2"]);
    await db.pool.query("update wip_policy set current_wip = 0");
    await run();
    repoHost.branches.set(`${REPO}@main`, ["p1", "m1", "m2", "f1"]);
    repoHost.checks.set(`${REPO}@f1`, "success");
    await run();
    assert.equal((await db.pool.query("select cleared_sha from main_break where merge_sha = 'm1'")).rows[0].cleared_sha, "f1");
    repoHost.runs.set(`${REPO}@p1`, [check("test", "success")]);
    await run();
    assert.equal((await state(first)).state, "Failed");
    assert.equal((await db.pool.query("select item_id from main_break where merge_sha = 'm1'")).rows[0].item_id, first);
    assert.equal(backlog.filed.length, 0);
  });

  // PBI 369: an item that failed its Definition of Done on main is re-checked every failed_recheck_hours hours. The
  // scenarios cover the rest.
  const HOUR = 3_600_000;
  async function failedMerge(externalId: string, sha: string, parent: string, mergeRuns: CheckRun[], parentRuns: CheckRun[], failedAgo = 0, event = "dod_failed") {
    const id = await redMerge(externalId, sha, parent, mergeRuns, parentRuns, failedAgo + HOUR);
    await db.pool.query("update item set state = 'Failed' where id = $1", [id]);
    await db.pool.query(
      "insert into event (at, actor, actor_id, item_id, kind, payload) values ($1, 'system', 't', $2, 'transition', $3)",
      [ago(failedAgo), id, JSON.stringify({ from: "Accepted", to: "Failed", event })],
    );
    repoHost.branches.set(`${REPO}@main`, [parent, sha]);
    await db.pool.query("update wip_policy set current_wip = 0");
    return id;
  }
  const rechecks = async (id: string) =>
    (await db.pool.query<{ at: Date }>("select at from event where item_id = $1 and kind = 'recheck' order by at", [id])).rows.map((r) => r.at.toISOString());
  const later = (ms: number) => new Date(NOW.getTime() + ms);

  test("a Failed item is first re-checked 8 hours after it failed, and one on a main already red goes back to Accepted and waits on main (PBI 369)", async () => {
    const id = await failedMerge("1", "m1", "p1", [check("test", "failure")], [check("test", "failure")]);
    const before = (await backlog.comments("1")).length;
    await run(later(8 * HOUR - 60_000));
    assert.deepEqual(await rechecks(id), []);
    assert.equal((await state(id)).state, "Failed");
    await run(later(8 * HOUR));
    assert.deepEqual(await rechecks(id), [later(8 * HOUR).toISOString()]);
    assert.equal((await state(id)).state, "Accepted");
    const moves = (await db.pool.query("select payload from event where item_id = $1 and kind = 'transition' and payload->>'event' = 'rechecked'", [id])).rows;
    assert.deepEqual(moves.map((m) => [m.payload.from, m.payload.to]), [["Failed", "Accepted"]]);
    assert.equal((await db.pool.query("select waits_on_branch from run where item_id = $1", [id])).rows[0].waits_on_branch, "main");
    const comments = (await backlog.comments("1")).slice(before);
    assert.equal(comments.length, 1);
    assert.match(comments[0], /re-check/i);
    assert.match(comments[0], /m1/);
    assert.match(comments[0], /p1/);
    await run(later(16 * HOUR));
    assert.equal((await backlog.comments("1")).length, before + 1);
    assert.equal((await rechecks(id)).length, 1);
  });

  test("a merge that still broke main stays Failed with no comment, and is re-checked again failed_recheck_hours later (PBI 369)", async () => {
    repoHost.files.set(`${REPO}@main:.factory/config.yml`, "failed_recheck_hours: 2\n");
    const id = await failedMerge("1", "m1", "p1", [check("test", "failure")], [check("test", "success")]);
    const before = (await backlog.comments("1")).length;
    for (const h of [1, 2, 3, 4]) await run(later(h * HOUR));
    assert.deepEqual(await rechecks(id), [later(2 * HOUR).toISOString(), later(4 * HOUR).toISOString()]);
    assert.equal((await state(id)).state, "Failed");
    assert.equal((await backlog.comments("1")).length, before);
    assert.equal(backlog.filed.length, 0);
  });

  test("a merge commit whose CI now passes goes back to Accepted, and is Done on the next pass (PBI 369)", async () => {
    const id = await failedMerge("1", "m1", "p1", [check("test", "failure")], [check("test", "success")], 8 * HOUR);
    repoHost.runs.set(`${REPO}@m1`, [check("test", "success")]);
    repoHost.checks.set(`${REPO}@m1`, "success");
    await run();
    assert.equal((await state(id)).state, "Accepted");
    assert.match((await backlog.comments("1")).at(-1)!, /now passes/);
    await run(later(60_000));
    assert.equal((await state(id)).state, "Done");
  });

  test("an item that went to Failed for another reason is never re-checked (PBI 369)", async () => {
    const id = await failedMerge("1", "m1", "p1", [check("test", "failure")], [check("test", "failure")], 8 * HOUR, "retries_exhausted");
    await run(later(HOUR));
    assert.deepEqual(await rechecks(id), []);
    assert.equal((await state(id)).state, "Failed");
  });

  test("a config whose failed_recheck_hours is wrong re-checks every 8 hours (PBI 369)", async () => {
    repoHost.files.set(`${REPO}@main:.factory/config.yml`, "failed_recheck_hours: nope\n");
    const id = await failedMerge("1", "m1", "p1", [check("test", "failure")], [check("test", "success")], 8 * HOUR);
    await run();
    assert.equal((await rechecks(id)).length, 1);
  });

  test("re-queueing an Abandoned item with its sign-off still open sends it back to SignOff with a fresh clock", async () => {
    const id = await item("1", "Abandoned", "held = true");
    await openRun(id, "next_stage = 'sign-off'");
    await db.pool.query("insert into question (item_id, kind, body, asked_at, reminders_sent) values ($1, 'sign_off', 'q', $2, 2)", [id, ago(6 * DAY)]);
    await override("requeue", id);
    await run();
    assert.deepEqual(await state(id), { state: "SignOff", held: false });
    const q = (await db.pool.query("select asked_at, reminders_sent from question where item_id = $1", [id])).rows[0];
    assert.deepEqual(q, { asked_at: NOW, reminders_sent: 0 });
    // The board comment quotes the question again, from the transition's payload (PBI 219).
    const ev = (await db.pool.query("select payload from event where item_id = $1 and kind = 'transition' and payload->>'event' = 'reopened_signoff'", [id])).rows[0];
    assert.equal(ev.payload.question, "q");
  });

  test("re-queueing an item withdrawn from NotReady sends it back to Eligible, not Queued (PBI 168)", async () => {
    const id = await item("1", "Abandoned");
    await db.pool.query(
      `insert into event (actor, actor_id, item_id, kind, payload) values ('system', 'poller', $1, 'transition', '{"from":"NotReady","to":"Abandoned","event":"withdrawn"}')`,
      [id],
    );
    await override("requeue", id);
    await run();
    assert.deepEqual(await state(id), { state: "Eligible", held: false });
  });

  test("re-queueing a Failed item whose PR merged starts a new run, numbered one higher, on a new branch", async () => {
    const id = await item("1", "Failed");
    await openRun(id, `merge_sha = 'abc1234', run_number = 1, branch = 'factory/pbi-1-r1', repo_id = '${repoId}', config_sha = 'x'`);
    await db.pool.query("update wip_policy set current_wip = 0");
    await override("requeue", id);
    await run();
    const runs = (await db.pool.query("select run_number, ended_at is not null as ended, next_stage, branch from run where item_id = $1 order by run_number", [id])).rows;
    assert.deepEqual(runs, [
      { run_number: 1, ended: true, next_stage: null, branch: "factory/pbi-1-r1" },
      { run_number: 2, ended: false, next_stage: "understand", branch: null },
    ]);
    assert.equal((await state(id)).state, "Queued");
  });

  test("re-queueing an Abandoned item whose PR a person closed resumes its run at open-pr", async () => {
    const id = await item("1", "Abandoned");
    await openRun(id, `next_stage = 'address', pr_number = 9, repo_id = '${repoId}', config_sha = 'x'`);
    repoHost.prs.push({
      number: 9, repo: REPO, branch: "factory/pbi-1-r1", base: "main", title: "t", body: "", headSha: null, open: false, merged: false,
      mergeSha: null, mergeable: null, reviewers: [], comments: [], reviews: [],
    });
    await db.pool.query("update wip_policy set current_wip = 0");
    await override("requeue", id);
    await run();
    const r = (await db.pool.query("select next_stage, pr_number, pr_url from run where item_id = $1", [id])).rows[0];
    // The closed PR is forgotten, so the poller doesn't withdraw the item again while open-pr opens a fresh one (PBI 142).
    assert.deepEqual(r, { next_stage: "open-pr", pr_number: null, pr_url: null });
  });

  test("re-queueing an item withdrawn from NeedsInput for a closed PR resumes at open-pr and closes its question (PBI 194)", async () => {
    const id = await item("1", "Abandoned");
    await openRun(id, `next_stage = 'address', pr_number = 9, repo_id = '${repoId}', config_sha = 'x'`);
    await db.pool.query("insert into question (item_id, kind, body, asked_at) values ($1, 'needs_input', 'q', $2)", [id, ago(DAY)]);
    repoHost.prs.push({
      number: 9, repo: REPO, branch: "factory/pbi-1-r1", base: "main", title: "t", body: "", headSha: null, open: false, merged: false,
      mergeSha: null, mergeable: null, reviewers: [], comments: [], reviews: [],
    });
    await db.pool.query("update wip_policy set current_wip = 0");
    await override("requeue", id);
    await run();
    // Back to NeedsInput holding PR 9, the next poll would withdraw it again, and every re-queue would end the same way.
    assert.notEqual((await state(id)).state, "NeedsInput");
    const r = (await db.pool.query("select next_stage, pr_number, pr_url from run where item_id = $1", [id])).rows[0];
    assert.deepEqual(r, { next_stage: "open-pr", pr_number: null, pr_url: null });
    const open = (await db.pool.query("select count(*)::int as n from question where item_id = $1 and answer is null and closed_at is null", [id])).rows[0].n;
    assert.equal(open, 0);
  });

  test("an item that names no repo is held with the reason", async () => {
    await backlog.seed({ externalId: "1", repo: null });
    const id = (await db.pool.query<{ id: string }>("insert into item (source_id, external_id, title, state) values ($1, '1', 't', 'Queued') returning id", [source])).rows[0].id;
    await run();
    assert.deepEqual(await state(id), { state: "Queued", held: true });
    assert.match((await backlog.comments("1")).join(), /names no repo/);
  });

  test("a pin that fails for a passing reason, such as GitHub being down, leaves the item as it was", async () => {
    const id = await item("1", "Queued");
    repoHost.heads.clear();
    await assert.rejects(run(), /no default branch head/);
    assert.deepEqual(await state(id), { state: "Queued", held: false });
    assert.equal((await db.pool.query("select count(*)::int as n from run where item_id = $1", [id])).rows[0].n, 0);
  });

  test("with three answered sign-offs and nothing else waiting, one of them starts", async () => {
    for (const ext of ["1", "2", "3"]) {
      const id = await item(ext, "SignOff");
      await openRun(id, `next_stage = 'red', repo_id = '${repoId}', config_sha = 'x'`);
      await db.pool.query("insert into question (item_id, kind, body, answer, answered_at) values ($1, 'sign_off', 'q', 'approve', $2)", [id, NOW]);
    }
    await run();
    assert.equal(started.length, 1);
  });

  test("one tick fills every free slot under the WIP limit, and no more (PBI 177)", async () => {
    await db.pool.query("update wip_policy set current_wip = 3");
    const running = await item("0", "InProgress", `lease_expires = '${new Date(NOW.getTime() + 300_000).toISOString()}'`);
    const queued = [await item("1", "Queued", "backlog_rank = 1"), await item("2", "Queued", "backlog_rank = 2"), await item("3", "Queued", "backlog_rank = 3")];
    await run();
    assert.deepEqual(started.map((e) => e.ITEM_ID), queued.slice(0, 2));
    assert.equal((await state(running)).state, "InProgress");
    assert.equal((await state(queued[2])).state, "Queued");
    await run();
    assert.equal(started.length, 2);
  });

  test("a start that fails ends the tick's starts, so the item it sent back isn't claimed again the same tick", async () => {
    await db.pool.query("update wip_policy set current_wip = 3");
    await item("1", "Queued");
    let calls = 0;
    launcher.start = async () => {
      calls++;
      throw new Error("docker is down");
    };
    await run();
    assert.equal(calls, 1);
  });

  test("a start that fails moves the item out of InProgress, so the generation it handed out is never valid again", async () => {
    const id = await item("1", "Queued");
    launcher.start = async () => {
      throw new Error("docker is down");
    };
    await run();
    const r = (await db.pool.query("select state, lease_generation from item where id = $1", [id])).rows[0];
    assert.deepEqual(r, { state: "Queued", lease_generation: 2 });
  });

  test("the kill switch still stops the other cells when one stop fails", async () => {
    for (const [ext, cell] of [["1", "cell-a"], ["2", "cell-b"]]) {
      const id = await item(ext, "InProgress", `lease_owner = 'x', lease_expires = '${new Date(NOW.getTime() + 60_000).toISOString()}'`);
      await openRun(id, `execution_name = '${cell}'`);
    }
    const stop = launcher.stop;
    launcher.stop = async (name) => {
      if (name === "cell-a") throw new Error("gone");
      await stop(name);
    };
    await run(NOW, true);
    assert.deepEqual(stopped, ["cell-b"]);
  });

  test("an override that keeps failing doesn't stop leases expiring or new cells starting", async () => {
    const stuck = await item("1", "Abandoned");
    await openRun(stuck, `pr_number = 9, repo_id = '${repoId}', config_sha = 'x'`);
    await override("requeue", stuck); // prState throws: the fake holds no PR 9
    const expired = await item("2", "InProgress", `lease_owner = 'x', lease_expires = '${ago(1).toISOString()}'`);
    await openRun(expired);
    // The same tick claims the expired item again, so what tick reports is the evidence, not the item's state.
    assert.deepEqual((await run()).expired, [expired]);
    assert.equal(started.length, 1);
    // The failed requeue stays active, so it applies once GitHub answers.
    repoHost.prs.push({
      number: 9, repo: REPO, branch: "factory/pbi-1-r1", base: "main", title: "t", body: "", headSha: null, open: false, merged: false,
      mergeSha: null, mergeable: null, reviewers: [], comments: [], reviews: [],
    });
    await run();
    assert.deepEqual(await state(stuck), { state: "Queued", held: false });
  });

  test("after a re-queue reopens a question, its reminders come again", async () => {
    const id = await item("1", "SignOff");
    await openRun(id, "next_stage = 'sign-off'");
    await db.pool.query("insert into question (item_id, kind, body, asked_at) values ($1, 'sign_off', 'q', $2)", [id, ago(4 * DAY + 1)]);
    const reminders = async () => (await backlog.comments("1")).filter((b) => b.startsWith("Reminder")).length;
    await run(); // the first round's reminder, posted at 4 days
    assert.equal(await reminders(), 1);
    // An operator abandons it, then re-queues it, which resets the clock.
    await db.pool.query("update item set state = 'Abandoned' where id = $1", [id]);
    await db.pool.query("update wip_policy set current_wip = 0");
    await override("requeue", id);
    await run();
    // 4 days on, the same reminder count is due again. A key without asked_at would match the first round's and be skipped.
    await run(new Date(NOW.getTime() + 4 * DAY + 1));
    assert.equal(await reminders(), 2);
  });

  /** An item moved from InProgress to FeatureChangeRequest `ms` before NOW, as a cell's request moves it (PBI 364). */
  async function waitsOnFeatureChange(externalId: string, ms: number): Promise<string> {
    const id = await item(externalId, "InProgress");
    const runId = await openRun(id);
    await withTx(db.pool, (c) => requestFeatureChange(c, runId, [{ path: "features/a.feature", reason: "r", before: "a\n", after: "b\n" }]));
    await db.pool.query("update event set at = $2 where item_id = $1 and payload->>'to' = 'FeatureChangeRequest'", [id, ago(ms)]);
    return id;
  }

  test("an item in FeatureChangeRequest holds no WIP slot and counts toward review capacity (PBI 366)", async () => {
    await waitsOnFeatureChange("1", 3_600_000);
    await db.pool.query("update wip_policy set review_capacity = 2");
    await item("2", "InReview");
    await item("3", "Queued");
    await run();
    assert.deepEqual(started, [], "two waiting fill a review capacity of 2");
    await db.pool.query("update wip_policy set review_capacity = 3");
    await run();
    assert.equal(started.length, 1, "the item in FeatureChangeRequest leaves the one WIP slot free");
  });

  test("an item in FeatureChangeRequest is reminded at 2 days and at 4 from its move, once each, and abandoned after 5 (PBI 366)", async () => {
    const id = await waitsOnFeatureChange("1", 2 * DAY + 1);
    const reminders = async () => (await backlog.comments("1")).filter((b) => b.startsWith("Reminder"));
    await run();
    await run(new Date(NOW.getTime() + 600_000));
    assert.equal((await reminders()).length, 1);
    assert.match((await reminders())[0], /still waiting for you/);
    await run(new Date(NOW.getTime() + 2 * DAY));
    assert.equal((await reminders()).length, 2);
    assert.equal((await state(id)).state, "FeatureChangeRequest");
    await run(new Date(NOW.getTime() + 3 * DAY));
    assert.equal((await state(id)).state, "Abandoned");
    const moved = (await db.pool.query("select payload->>'event' as event from event where item_id = $1 and payload->>'to' = 'Abandoned'", [id])).rows;
    assert.deepEqual(moved, [{ event: "timed_out" }]);
  });

  test("a second feature change request on the same run starts its reminders again (PBI 366)", async () => {
    const id = await waitsOnFeatureChange("1", 2 * DAY + 1);
    await run();
    // The owner's answer sends it back to work, and a later stage asks again.
    await db.pool.query("update item set state = 'InProgress' where id = $1", [id]);
    const runId = (await db.pool.query("select id from run where item_id = $1", [id])).rows[0].id;
    await withTx(db.pool, (c) => requestFeatureChange(c, runId, [{ path: "features/a.feature", reason: "again", before: "a\n", after: "c\n" }]));
    await db.pool.query("update event set at = $2 where item_id = $1 and payload->>'to' = 'FeatureChangeRequest' and at > $2", [id, NOW]);
    await run(new Date(NOW.getTime() + 2 * DAY + 1));
    assert.equal((await backlog.comments("1")).filter((b) => b.startsWith("Reminder")).length, 2);
  });

  test("re-queued after it timed out, an item goes back to waiting on its feature change request, its clock reset (PBI 366)", async () => {
    const id = await waitsOnFeatureChange("1", 5 * DAY + 1);
    await run();
    assert.equal((await state(id)).state, "Abandoned");
    const reminders = async () => (await backlog.comments("1")).filter((b) => b.startsWith("Reminder")).length;
    const before = await reminders();
    await override("requeue", id);
    const later = new Date(NOW.getTime() + 60_000);
    await run(later);
    assert.equal((await state(id)).state, "FeatureChangeRequest");
    assert.deepEqual(started, [], "the stage that asked doesn't run again");
    const r = (await db.pool.query("select next_stage, feature_change_reminders from run where item_id = $1", [id])).rows[0];
    assert.deepEqual(r, { next_stage: "green", feature_change_reminders: 0 });
    // The event log stamps the move with the database's clock, so it's set to the tick's, as the helper above does.
    await db.pool.query("update event set at = $2 where item_id = $1 and payload->>'event' = 'reopened_feature_change'", [id, later]);
    // The clock starts at the re-queue: nothing is due a day on, a reminder 2 days on, and no timeout until 5.
    await run(new Date(later.getTime() + DAY));
    assert.equal(await reminders(), before);
    await run(new Date(later.getTime() + 2 * DAY + 1));
    assert.equal(await reminders(), before + 1);
    assert.equal((await state(id)).state, "FeatureChangeRequest");
  });

  test("re-queued after a decision, an item abandoned from elsewhere goes to Queued, though its run still holds a request (PBI 366)", async () => {
    const id = await waitsOnFeatureChange("1", 3_600_000);
    const t = { actor: "system", actorId: "t" } as const;
    await withTx(db.pool, async (c) => {
      await transitionItem(c, id, "feature_change_decided", t);
      await transitionItem(c, id, "withdrawn", t);
    });
    await db.pool.query("update wip_policy set current_wip = 0");
    await override("requeue", id);
    await run();
    const moves = (await db.pool.query("select payload->>'event' as event from event where item_id = $1 and kind = 'transition' order by at", [id])).rows;
    assert.ok(moves.some((m) => m.event === "requeued"));
    assert.ok(!moves.some((m) => m.event === "reopened_feature_change"));
  });

  test("resume records who lifted the pause, and why", async () => {
    await override("pause");
    await setOverride(db.pool, { scope: "factory", targetId: null, kind: "resume", reason: "fixed", createdBy: operator, expiresAt: null });
    const rows = (await db.pool.query("select kind, reason, cleared_by from override order by created_at")).rows;
    assert.deepEqual(rows, [{ kind: "pause", reason: "unit", cleared_by: operator }, { kind: "resume", reason: "fixed", cleared_by: operator }]);
  });

  test("resume lifts a kill override too, so the factory starts work again", async () => {
    await override("kill");
    await setOverride(db.pool, { scope: "factory", targetId: null, kind: "resume", reason: "all clear", createdBy: operator, expiresAt: null });
    const kills = (await db.pool.query("select cleared_by from override where kind = 'kill'")).rows;
    assert.deepEqual(kills, [{ cleared_by: operator }]);
  });

  // PBI 140: Prepare restart. A restart override starts nothing. PBI 300: it never stops a cell either, however long the
  // cell runs, so each cell wraps up in its own time and its attempt stays open until the cell reports it.
  const prepared = async (minutesAgo: number) => {
    await override("restart");
    await db.pool.query("update override set created_at = $1 where kind = 'restart'", [ago(minutesAgo * 60_000)]);
  };
  const running = async (externalId: string, cell: string) => {
    const id = await item(externalId, "InProgress", `lease_owner = '${cell}', lease_expires = '${new Date(NOW.getTime() + 240_000).toISOString()}', lease_generation = 1`);
    const runId = await openRun(id, `next_stage = 'green', execution_name = '${cell}'`);
    await db.pool.query("insert into stage_run (run_id, stage_id, attempt, status) values ($1, 'green', 1, 'started')", [runId]);
    return { id, runId };
  };

  test("a restart being prepared starts nothing and stops no cell", async () => {
    await item("1", "Queued");
    await running("2", "cell-2");
    await prepared(14);
    await run();
    assert.deepEqual(started, []);
    assert.deepEqual(stopped, []);
  });

  test("hours after a restart was prepared, a running cell isn't stopped and its attempt stays open", async () => {
    const a = await running("2", "cell-2");
    await prepared(180);
    await run();
    assert.deepEqual(stopped, []);
    assert.equal((await state(a.id)).state, "InProgress");
    const attempt = (await db.pool.query("select status, ended_at from stage_run where run_id = $1", [a.runId])).rows[0];
    assert.deepEqual(attempt, { status: "started", ended_at: null });
    assert.deepEqual(started, [], "the factory still starts nothing until it restarts");
  });

  test("FACTORY_RESTART_WAIT_MINUTES stops nothing", async () => {
    const before = process.env.FACTORY_RESTART_WAIT_MINUTES;
    process.env.FACTORY_RESTART_WAIT_MINUTES = "0";
    try {
      await running("2", "cell-2");
      await prepared(5);
      await run();
      assert.deepEqual(stopped, []);
    } finally {
      if (before === undefined) delete process.env.FACTORY_RESTART_WAIT_MINUTES;
      else process.env.FACTORY_RESTART_WAIT_MINUTES = before;
    }
  });

  test("clearRestartOnStart clears only the restart override, and resume clears one too", async () => {
    await override("pause");
    await prepared(20);
    await clearRestartOnStart(db.pool);
    const kinds = (await db.pool.query("select kind from override where cleared_at is null")).rows.map((r) => r.kind);
    assert.deepEqual(kinds, ["pause"]);
    await prepared(1);
    await override("resume");
    const restarts = (await db.pool.query("select cleared_by from override where kind = 'restart' order by created_at")).rows;
    assert.equal(restarts.at(-1).cleared_by, operator);
  });

  test("an override with a blank reason is refused", async () => {
    await assert.rejects(setOverride(db.pool, { scope: "factory", targetId: null, kind: "pause", reason: " ", createdBy: operator, expiresAt: null }), /needs a reason/);
  });
});
