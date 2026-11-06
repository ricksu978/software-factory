import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { fakeBacklog } from "../adapters/fake.ts";
import { dbTest, startTestDb } from "../store/test-db.ts";
import { applyComment, parseCommand } from "./decisions.ts";

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
    assert.match((await fake.comments(ext))[0], /sent back for changes/);
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

  test("an item with no open question of that kind is ignored", async () => {
    await person("octo", "owner", true);
    const { ext } = await waiting("NeedsInput", "needs_input", "green");
    assert.equal(await comment(ext, "octo", "/approve"), "ignored");
  });
});
