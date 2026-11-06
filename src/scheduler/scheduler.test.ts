import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { fakeBacklog, fakeRepoHost } from "../adapters/fake.ts";
import { runToken } from "../control/cell-api.ts";
import { setOverride, type OverrideKind } from "../store/overrides.ts";
import { dbTest, startTestDb } from "../store/test-db.ts";
import { fakeLauncher } from "./launcher.ts";
import { tick } from "./scheduler.ts";

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

  test("re-queueing an Abandoned item with its sign-off still open sends it back to SignOff with a fresh clock", async () => {
    const id = await item("1", "Abandoned", "held = true");
    await openRun(id, "next_stage = 'sign-off'");
    await db.pool.query("insert into question (item_id, kind, body, asked_at, reminders_sent) values ($1, 'sign_off', 'q', $2, 2)", [id, ago(6 * DAY)]);
    await override("requeue", id);
    await run();
    assert.deepEqual(await state(id), { state: "SignOff", held: false });
    const q = (await db.pool.query("select asked_at, reminders_sent from question where item_id = $1", [id])).rows[0];
    assert.deepEqual(q, { asked_at: NOW, reminders_sent: 0 });
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
    assert.equal((await db.pool.query("select next_stage from run where item_id = $1", [id])).rows[0].next_stage, "open-pr");
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

  test("resume records who lifted the pause, and why", async () => {
    await override("pause");
    await setOverride(db.pool, { scope: "factory", targetId: null, kind: "resume", reason: "fixed", createdBy: operator, expiresAt: null });
    const rows = (await db.pool.query("select kind, reason, cleared_by from override order by created_at")).rows;
    assert.deepEqual(rows, [{ kind: "pause", reason: "unit", cleared_by: operator }, { kind: "resume", reason: "fixed", cleared_by: operator }]);
  });

  test("an override with a blank reason is refused", async () => {
    await assert.rejects(setOverride(db.pool, { scope: "factory", targetId: null, kind: "pause", reason: " ", createdBy: operator, expiresAt: null }), /needs a reason/);
  });
});
