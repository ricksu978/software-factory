import assert from "node:assert/strict";
import { after, before, beforeEach, describe, mock, test } from "node:test";
import { fakeBacklog, fakeRepoHost } from "../adapters/fake.ts";
import type { BacklogAdapter } from "../adapters/types.ts";
import { announcement, decide } from "../control/decisions.ts";
import { withTx } from "../store/db.ts";
import { overrideItem, transitionItem } from "../store/items.ts";
import { writeOutboxRows } from "../store/outbox.ts";
import { dbTest, startTestDb } from "../store/test-db.ts";
import { backoffMs, runRowEffects, workOutbox, type OutboxRow } from "./outbox.ts";

const system = { actor: "system" as const, actorId: "test" };

describe("backoffMs", () => {
  test("waits 30 seconds after the first failure, doubling up to 30 minutes", () => {
    assert.deepEqual([1, 2, 3, 6, 7, 20].map(backoffMs), [30_000, 60_000, 120_000, 960_000, 1_800_000, 1_800_000]);
  });
});

describe("workOutbox", dbTest, () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let source: string;
  let board: ReturnType<typeof fakeBacklog>;
  /** External ids whose every board call fails. */
  let refused: Set<string>;

  before(async () => {
    db = await startTestDb();
  });
  after(async () => {
    await db?.stop();
  });
  beforeEach(async () => {
    await db.pool.query(`truncate item, backlog_source, "user" cascade`);
    source = (await db.pool.query<{ id: string }>(
      "insert into backlog_source (adapter, url, field_map) values ('fake', 'worker-outbox', $1) returning id",
      [JSON.stringify({ statusFor: { InProgress: "Doing", SignOff: "Sign-off" } })],
    )).rows[0].id;
    board = fakeBacklog();
    refused = new Set();
    mock.method(console, "error", () => {});
  });

  const refusing = (): BacklogAdapter => new Proxy(board.adapter, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      return async (...args: unknown[]) => {
        if (refused.has(String(args[0]))) throw new Error("the board refuses");
        return v.apply(target, args);
      };
    },
  });
  const deps = () => ({ pool: db.pool, backlogFor: () => refusing(), repoHost: fakeRepoHost() });

  async function item(ext: string, state: string): Promise<string> {
    await board.seed({ externalId: ext, title: `item ${ext}` });
    return (await db.pool.query<{ id: string }>(
      "insert into item (source_id, external_id, title, state) values ($1, $2, 't', $3) returning id", [source, ext, state],
    )).rows[0].id;
  }
  const outbox = async () => (await db.pool.query<{ seq: string; consumer: string; event_id: string; item_id: string; attempts: number; due: boolean }>(
    "select seq, consumer, event_id, item_id, attempts, next_attempt_at <= now() as due from outbox order by seq",
  )).rows;
  const statuses = (ext: string) => board.adapter.getItem(ext).then((i) => i?.status);

  test("mirrors one item's rows in order and removes each", async () => {
    const id = await item("1", "Queued");
    await withTx(db.pool, (c) => transitionItem(c, id, "claimed", system));
    await withTx(db.pool, (c) => transitionItem(c, id, "scenarios_written", system));
    await workOutbox(deps());
    assert.equal(await statuses("1"), "Sign-off");
    assert.deepEqual(await outbox(), []);
  });

  test("a row a pre-219 process wrote is removed unhandled, and holds back none of its item's later rows", async () => {
    const id = await item("1", "Queued");
    // An old revision still running in a swap writes its row as PBI 218's code did, recording no outbox_worker_row, and its
    // own hook has already mirrored the change.
    await withTx(db.pool, async (c) => {
      const e = (await c.query<{ id: string }>(
        "insert into event (actor, actor_id, item_id, kind, payload) values ('system', 'old', $1, 'transition', $2) returning id",
        [id, { from: "Queued", to: "SignOff", event: "scenarios_written" }],
      )).rows[0].id;
      await c.query("insert into outbox (consumer, event_id, item_id) values ('board_mirror', $1, $2)", [e, id]);
    });
    await withTx(db.pool, (c) => transitionItem(c, id, "claimed", system));
    await workOutbox(deps());
    assert.equal(await statuses("1"), "Doing");
    assert.deepEqual(await board.comments("1"), []);
    assert.deepEqual(await outbox(), []);
  });

  test("a failed row stays with its attempt counted and a later due time, holds back its item's later rows, and no other item's", async () => {
    const a = await item("1", "Queued");
    const b = await item("2", "Queued");
    refused.add("1");
    await withTx(db.pool, (c) => transitionItem(c, a, "claimed", system));
    await withTx(db.pool, (c) => transitionItem(c, a, "scenarios_written", system));
    await withTx(db.pool, (c) => transitionItem(c, b, "claimed", system));
    await workOutbox(deps());
    assert.equal(await statuses("2"), "Doing");
    const left = await outbox();
    assert.deepEqual(left.map((r) => [r.item_id, r.attempts, r.due]), [[a, 1, false], [a, 0, true]]);
    // Once it's due again and the board takes it, both go, in order.
    refused.clear();
    await db.pool.query("update outbox set next_attempt_at = now()");
    await workOutbox(deps());
    assert.equal(await statuses("1"), "Sign-off");
    assert.deepEqual(await outbox(), []);
  });

  test("a decision's announcement quotes its text, and handling its row twice posts it once", async () => {
    const id = await item("1", "NeedsInput");
    const user = (await db.pool.query<{ id: string }>(
      `insert into "user" (provider, subject, github_login, role, product_owner) values ('dev', 'olu', 'olu', 'operator', false) returning id`,
    )).rows[0].id;
    await db.pool.query("insert into run (item_id, run_number, next_stage) values ($1, 1, 'green')", [id]);
    await db.pool.query("insert into question (item_id, kind, body) values ($1, 'needs_input', 'Which?')", [id]);
    assert.equal(await withTx(db.pool, (c) => decide(c, { itemId: id, userId: user, kind: "answer", text: "Use euros", via: "dashboard" })), "applied");
    const [r] = await outbox();
    const row: OutboxRow = { seq: r.seq, consumer: r.consumer as OutboxRow["consumer"], eventId: r.event_id, itemId: r.item_id };
    await runRowEffects(deps(), row);
    await runRowEffects(deps(), row);
    assert.deepEqual(await board.comments("1"), [announcement("answer", "Use euros")]);
  });

  test("a comment command's decision is announced in the same pass", async () => {
    const id = await item("1", "SignOff");
    await board.seed({ externalId: "1", title: "item 1", repo: "acme/app" });
    await db.pool.query(`insert into "user" (provider, subject, github_login, role, product_owner) values ('dev', 'pat', 'pat', 'viewer', true)`);
    await db.pool.query("insert into run (item_id, next_stage, scenarios_sha) values ($1, 'specify', 'abc')", [id]);
    await db.pool.query("insert into question (item_id, kind, body) values ($1, 'sign_off', 'Sign off?')", [id]);
    await withTx(db.pool, async (c) => {
      const e = (await c.query<{ id: string }>(
        "insert into event (actor, actor_id, kind, payload) values ('system', 'github', 'webhook', $1) returning id",
        [{ event: { kind: "comment", externalId: "1", repo: "acme/app", login: "pat", body: "/approve", commentId: "c1" } }],
      )).rows[0].id;
      await writeOutboxRows(c, "comment_commands", e, [id]);
    });
    await workOutbox(deps());
    assert.deepEqual(await board.comments("1"), [announcement("approve", "")]);
    assert.deepEqual(await outbox(), []);
  });

  test("a comment command handled late leaves a question asked after the comment was posted alone", async () => {
    const id = await item("1", "SignOff");
    await board.seed({ externalId: "1", title: "item 1", repo: "acme/app" });
    await db.pool.query(`insert into "user" (provider, subject, github_login, role, product_owner) values ('dev', 'pat', 'pat', 'viewer', true)`);
    await db.pool.query("insert into run (item_id, next_stage, scenarios_sha) values ($1, 'specify', 'abc')", [id]);
    await withTx(db.pool, async (c) => {
      const e = (await c.query<{ id: string }>(
        "insert into event (actor, actor_id, kind, payload, at) values ('system', 'github', 'webhook', $1, now() - interval '1 hour') returning id",
        [{ event: { kind: "comment", externalId: "1", repo: "acme/app", login: "pat", body: "/approve", commentId: "c1" } }],
      )).rows[0].id;
      await writeOutboxRows(c, "comment_commands", e, [id]);
    });
    await db.pool.query("insert into question (item_id, kind, body) values ($1, 'sign_off', 'Sign off the rewrite?')", [id]);
    await workOutbox(deps());
    assert.deepEqual(await board.comments("1"), []);
    assert.equal((await db.pool.query("select answer from question where item_id = $1", [id])).rows[0].answer, null);
    assert.deepEqual(await outbox(), []);
  });

  test("an override into SignOff quotes the item's open question on the board", async () => {
    const id = await item("1", "Failed");
    await db.pool.query("insert into question (item_id, kind, body) values ($1, 'sign_off', 'Sign off?')", [id]);
    await withTx(db.pool, (c) => overrideItem(c, id, "SignOff", system, "back to sign-off"));
    await workOutbox(deps());
    const [comment] = await board.comments("1");
    assert.match(comment, /Waiting for sign-off[\s\S]*\n\nSign off\?$/);
  });
});
