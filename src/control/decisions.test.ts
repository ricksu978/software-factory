import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { fakeBacklog, fakeRepoHost } from "../adapters/fake.ts";
import { dbTest, startTestDb } from "../store/test-db.ts";
import { announcement, applyComment, decideFeatureChange, parseCommand, turnedDownFinding } from "./decisions.ts";

describe("parseCommand", () => {
  test("reads only a leading /approve, /changes or /answer", () => {
    assert.deepEqual(parseCommand("/approve"), { kind: "approve", text: "" });
    assert.deepEqual(parseCommand("  /changes cover the empty month\n"), { kind: "changes", text: "cover the empty month" });
    assert.deepEqual(parseCommand("/answer use AUD\nand round to cents"), { kind: "answer", text: "use AUD\nand round to cents" });
    assert.equal(parseCommand("Looks good, /approve"), null);
    assert.equal(parseCommand("/approved"), null);
    assert.equal(parseCommand("thanks"), null);
  });
});

describe("announcement", () => {
  test("names a feature change decision as one, and quotes its note (PBI 365)", () => {
    assert.match(announcement("approve", "", "feature_change"), /^Feature change approved\./);
    assert.match(announcement("changes", "Keep refusing\nthem", "feature_change"), /^Feature change turned down\.[^\n]*\n\n> Keep refusing\n> them$/);
    assert.match(announcement("approve", ""), /^Scenarios signed off\./);
  });
});

describe("decisions", dbTest, () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let fake: ReturnType<typeof fakeBacklog>;
  let sourceId: string;

  before(async () => {
    db = await startTestDb();
  });
  after(async () => {
    await db?.stop();
  });
  beforeEach(async () => {
    await db.pool.query('truncate item, backlog_source, "user" cascade');
    fake = fakeBacklog();
    sourceId = (await db.pool.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'unit') returning id")).rows[0].id;
  });

  const person = (login: string, role: string, productOwner: boolean) =>
    db.pool.query(`insert into "user" (provider, subject, role, product_owner, github_login) values ('dev', $1, $2, $3, $1)`, [login, role, productOwner]);

  /** An item waiting on a question. An Abandoned one got there through `abandonedBy`, timed_out unless given. */
  async function waiting(state: string, kind: "sign_off" | "needs_input", nextStage: string, abandonedBy = "timed_out") {
    const ext = await fake.seed({ repo: "octo/repo" });
    const id = (await db.pool.query<{ id: string }>("insert into item (source_id, external_id, title, state) values ($1, $2, 't', $3) returning id", [sourceId, ext, state])).rows[0].id;
    await db.pool.query("insert into run (item_id, run_number, next_stage, scenarios_sha) values ($1, 1, $2, 'abc')", [id, nextStage]);
    await db.pool.query("insert into question (item_id, kind, body) values ($1, $2, 'q')", [id, kind]);
    if (state === "Abandoned") {
      await db.pool.query(
        `insert into event (actor, actor_id, item_id, kind, payload) values ('system', 'test', $1, 'transition', jsonb_build_object('from', $2::text, 'to', 'Abandoned', 'event', $3::text))`,
        [id, kind === "sign_off" ? "SignOff" : "NeedsInput", abandonedBy],
      );
    }
    return { ext, id };
  }
  const comment = (ext: string, login: string, body: string, commentId = "c1", repo = "octo/repo") =>
    applyComment({ pool: db.pool, adapter: fake.adapter, sourceId }, { externalId: ext, repo, login, body, commentId });
  const state = async (id: string) => (await db.pool.query("select i.state, r.next_stage, r.features_lock_sha from item i join run r on r.item_id = i.id where i.id = $1", [id])).rows[0];

  test("/changes from a product owner sends the run back to specify and logs a human event", async () => {
    await person("octo", "owner", true);
    const { ext, id } = await waiting("SignOff", "sign_off", "sign-off");
    assert.equal(await comment(ext, "OCTO", "/changes add the empty month"), "applied");
    assert.deepEqual(await state(id), { state: "SignOff", next_stage: "specify", features_lock_sha: null });
    const ev = (await db.pool.query("select actor, payload from event where item_id = $1 and kind = 'decision'", [id])).rows[0];
    assert.deepEqual(ev, { actor: "human", payload: { kind: "changes", via: "comment", text: "add the empty month" } });
    // The worker announces it from the decision's outbox row (PBI 219), so applying it posts nothing.
    assert.deepEqual(await fake.comments(ext), []);
  });

  test("/answer from an operator answers a NeedsInput item and leaves its resume point", async () => {
    await person("op", "operator", false);
    const { ext, id } = await waiting("NeedsInput", "needs_input", "green");
    assert.equal(await comment(ext, "op", "/answer use AUD"), "applied");
    assert.deepEqual(await state(id), { state: "NeedsInput", next_stage: "green", features_lock_sha: null });
    assert.equal((await db.pool.query("select answer from question where item_id = $1", [id])).rows[0].answer, "use AUD");
  });

  test("/answer from a viewer is forbidden, with one reply and no change", async () => {
    await person("v", "viewer", false);
    const { ext, id } = await waiting("NeedsInput", "needs_input", "green");
    assert.equal(await comment(ext, "v", "/answer use AUD"), "forbidden");
    assert.equal((await db.pool.query("select answer from question where item_id = $1", [id])).rows[0].answer, null);
    assert.equal((await fake.comments(ext)).length, 1);
  });

  test("the same refused comment delivered twice replies once", async () => {
    const { ext } = await waiting("SignOff", "sign_off", "sign-off");
    await comment(ext, "stranger", "/approve", "c9");
    await comment(ext, "stranger", "/approve", "c9");
    assert.equal((await fake.comments(ext)).length, 1);
  });

  test("a comment with no leading command is ignored, with no reply", async () => {
    const { ext } = await waiting("SignOff", "sign_off", "sign-off");
    assert.equal(await comment(ext, "stranger", "Nice work"), "ignored");
    assert.deepEqual(await fake.comments(ext), []);
  });

  test("/answer on an Abandoned item's open question answers it and requeues the item", async () => {
    await person("octo", "owner", true);
    const { ext, id } = await waiting("Abandoned", "needs_input", "green");
    assert.equal(await comment(ext, "octo", "/answer use AUD"), "applied");
    assert.deepEqual(await state(id), { state: "Queued", next_stage: "green", features_lock_sha: null });
  });

  test("a late /approve on an item Abandoned in SignOff requeues it at red with the lock set", async () => {
    await person("octo", "owner", true);
    const { ext, id } = await waiting("Abandoned", "sign_off", "sign-off");
    assert.equal(await comment(ext, "octo", "/approve"), "applied");
    assert.deepEqual(await state(id), { state: "Queued", next_stage: "red", features_lock_sha: "abc" });
  });

  test("a late /approve on an item withdrawn from the backlog is ignored, and the item stays gone", async () => {
    await person("octo", "owner", true);
    const { ext, id } = await waiting("Abandoned", "sign_off", "sign-off", "withdrawn");
    assert.equal(await comment(ext, "octo", "/approve"), "ignored");
    assert.deepEqual(await state(id), { state: "Abandoned", next_stage: "sign-off", features_lock_sha: null });
  });

  test("a comment on the same issue number in another repo is ignored, with no reply", async () => {
    await person("octo", "owner", true);
    const { ext, id } = await waiting("SignOff", "sign_off", "sign-off");
    assert.equal(await comment(ext, "octo", "/approve", "c1", "someone/else"), "ignored");
    assert.equal(await comment(ext, "stranger", "/approve", "c2", "someone/else"), "ignored");
    assert.deepEqual(await state(id), { state: "SignOff", next_stage: "sign-off", features_lock_sha: null });
    assert.deepEqual(await fake.comments(ext), []);
  });

  test("an applied decision stays applied when its PBI comment fails", async (t) => {
    await person("octo", "owner", true);
    const { ext, id } = await waiting("SignOff", "sign_off", "sign-off");
    t.mock.method(fake.adapter, "comment", async () => {
      throw new Error("GitHub 502");
    });
    t.mock.method(console, "error", () => {});
    assert.equal(await comment(ext, "octo", "/approve"), "applied");
    assert.deepEqual(await state(id), { state: "SignOff", next_stage: "red", features_lock_sha: "abc" });
  });

  describe("on a feature change request (PBI 365)", () => {
    const files = [
      { path: "features/a.feature", reason: "Held, not refused", before: "Then refused\n", after: "Then held\n" },
      { path: "features/b.feature", reason: "Needs a number", before: "b\n", after: "b2\n" },
    ];
    let repo: ReturnType<typeof fakeRepoHost>;

    /** An item waiting in FeatureChangeRequest, its `stage` attempt 1 failed after asking. */
    async function requested(stage = "green") {
      repo = fakeRepoHost();
      repo.branches.set("octo/repo@factory/x-r1", ["lock1", "pushed"]);
      const ext = await fake.seed({ repo: "octo/repo" });
      const id = (await db.pool.query<{ id: string }>("insert into item (source_id, external_id, title, state) values ($1, $2, 't', 'FeatureChangeRequest') returning id", [sourceId, ext])).rows[0].id;
      const repoId = (await db.pool.query<{ id: string }>("insert into repo (host_adapter, url) values ('github', 'https://github.com/octo/repo') on conflict (url) do update set url = excluded.url returning id")).rows[0].id;
      const run = (await db.pool.query<{ id: string }>(
        `insert into run (item_id, repo_id, run_number, next_stage, branch, scenarios_sha, features_lock_sha, feature_change)
         values ($1, $2, 1, $3, 'factory/x-r1', 'lock1', 'lock1', $4) returning id`, [id, repoId, stage, JSON.stringify(files)])).rows[0].id;
      await db.pool.query("insert into stage_run (run_id, stage_id, attempt, status, ended_at) values ($1, $2, 1, 'failed', now())", [run, stage]);
      await db.pool.query(
        `insert into event (actor, actor_id, item_id, kind, payload) values ('agent', $2, $1, 'transition', '{"from":"InProgress","to":"FeatureChangeRequest","event":"feature_change_requested"}')`,
        [id, run]);
      return { ext, id, run };
    }
    const say = (ext: string, login: string, body: string, commentId = "c1", postedAt?: Date) =>
      applyComment({ pool: db.pool, adapter: fake.adapter, sourceId, repoHost: repo }, { externalId: ext, repo: "octo/repo", login, body, commentId }, postedAt);
    const runOf = async (id: string) => (await db.pool.query("select i.state, r.next_stage, r.features_lock_sha from item i join run r on r.item_id = i.id where i.id = $1", [id])).rows[0];
    const decisions = async (id: string) => (await db.pool.query("select actor, payload from event where item_id = $1 and kind = 'decision'", [id])).rows;

    test("/approve from a product owner commits every proposed file in one commit, moves the lock there and queues the item at the stage", async () => {
      await person("pia", "viewer", true);
      const { ext, id } = await requested("self-review");
      assert.equal(await say(ext, "pia", "/approve"), "applied");
      const line = repo.branches.get("octo/repo@factory/x-r1")!;
      assert.equal(line.length, 3);
      const sha = line[2];
      assert.equal(repo.parents.get(`octo/repo@${sha}`), "pushed");
      assert.equal(repo.files.get(`octo/repo@${sha}:features/a.feature`), "Then held\n");
      assert.equal(repo.files.get(`octo/repo@${sha}:features/b.feature`), "b2\n");
      assert.deepEqual(await runOf(id), { state: "Queued", next_stage: "self-review", features_lock_sha: sha });
      assert.deepEqual(await decisions(id), [{ actor: "human", payload: { about: "feature_change", kind: "approve", via: "comment", text: "" } }]);
      // Handled a second time, the item no longer waits, so nothing is committed again.
      assert.equal(await say(ext, "pia", "/approve"), "ignored");
      assert.equal(line.length, 3);
    });

    test("/changes keeps the lock and hands the stage that asked the note, whole, with no try spent", async () => {
      await person("pia", "viewer", true);
      const { ext, id, run } = await requested("red");
      assert.equal(await say(ext, "pia", "/changes Empty orders stay refused.\nShow the reason."), "applied");
      assert.deepEqual(await runOf(id), { state: "Queued", next_stage: "red", features_lock_sha: "lock1" });
      assert.equal(repo.branches.get("octo/repo@factory/x-r1")!.length, 2);
      const carry = (await db.pool.query("select retry_carry from stage_run where run_id = $1", [run])).rows[0].retry_carry;
      assert.deepEqual(carry, { tried: 0, findings: [turnedDownFinding("Empty orders stay refused.\nShow the reason.")] });
      assert.match(carry.findings[0], /Empty orders stay refused\.\nShow the reason\.$/);
    });

    test("anyone but a product owner is refused with one reply naming who decides, and nothing changes", async () => {
      await person("olga", "owner", false);
      const { ext, id } = await requested();
      assert.equal(await say(ext, "olga", "/approve"), "forbidden");
      assert.equal(await say(ext, "stranger", "/changes no", "c2"), "forbidden");
      assert.deepEqual(await runOf(id), { state: "FeatureChangeRequest", next_stage: "green", features_lock_sha: "lock1" });
      const replies = await fake.comments(ext);
      assert.equal(replies.length, 2);
      assert.match(replies[0], /^@olga Only a product owner can approve or turn down a feature change request\./);
      assert.deepEqual(await decisions(id), []);
    });

    test("a command posted before the request was asked is ignored", async () => {
      await person("pia", "viewer", true);
      const { ext, id } = await requested();
      assert.equal(await say(ext, "pia", "/approve", "c1", new Date(Date.now() - 3_600_000)), "ignored");
      assert.equal((await runOf(id)).state, "FeatureChangeRequest");
    });

    test("an approval with no repo host to commit through fails and changes nothing", async () => {
      await person("pia", "viewer", true);
      const { id } = await requested();
      const pia = (await db.pool.query<{ id: string }>(`select id from "user" where github_login = 'pia'`)).rows[0].id;
      await assert.rejects(decideFeatureChange({ pool: db.pool }, { itemId: id, userId: pia, kind: "approve", text: "", via: "dashboard" }), /repo host/);
      assert.equal((await runOf(id)).state, "FeatureChangeRequest");
    });
  });

  test("an item with no open question of that kind is ignored", async () => {
    await person("octo", "owner", true);
    const { ext } = await waiting("NeedsInput", "needs_input", "green");
    assert.equal(await comment(ext, "octo", "/approve"), "ignored");
  });
});
