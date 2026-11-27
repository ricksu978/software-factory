// PBI 265: Start now, Move up and Move down, read by the claim order that claimNext and Floor's "Production Line" share.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { withTx } from "./db.ts";
import { claimKeys, claimNext, keepMovesInPlace, moveInQueue, nextUp } from "./items.ts";
import { setOverride, type OverrideKind } from "./overrides.ts";
import { dbTest, startTestDb } from "./test-db.ts";

describe("queue order", dbTest, () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let source: string;
  let operator: string;

  before(async () => {
    db = await startTestDb();
  });
  after(async () => {
    await db?.stop();
  });
  beforeEach(async () => {
    await db.pool.query(`truncate item, backlog_source, override, "user" cascade`);
    source = (await db.pool.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'unit') returning id")).rows[0].id;
    operator = (await db.pool.query<{ id: string }>(
      `insert into "user" (provider, subject, github_login, role) values ('microsoft', 'op', 'op', 'operator') returning id`,
    )).rows[0].id;
  });

  const names = new Map<string, string>();
  async function item(name: string, state: string, rank: number | null, set = "", from = source): Promise<string> {
    const id = (await db.pool.query<{ id: string }>(
      "insert into item (source_id, external_id, title, state, backlog_rank) values ($1, $2, $2, $3, $4) returning id",
      [from, name, state, rank],
    )).rows[0].id;
    if (set) await db.pool.query(`update item set ${set} where id = $1`, [id]);
    names.set(id, name);
    return id;
  }
  const order = async () => (await nextUp(db.pool, 10)).map((r) => r.external_id);
  const press = (itemId: string, kind: OverrideKind) =>
    setOverride(db.pool, { scope: "item", targetId: itemId, kind, reason: "unit", createdBy: operator, expiresAt: null });

  test("a Start now item comes before the items above it and before an answered item", async () => {
    const b = await item("B", "NeedsInput", 1);
    await db.pool.query("insert into question (item_id, kind, body, answer) values ($1, 'needs_input', 'q', 'a')", [b]);
    await item("C", "Queued", 2);
    const a = await item("A", "Queued", 3);
    assert.deepEqual(await order(), ["B", "C", "A"]);
    await press(a, "start_now");
    assert.deepEqual(await order(), ["A", "B", "C"]);
    assert.equal((await withTx(db.pool, (c) => claimNext(c, "scheduler", new Date())))?.itemId, a);
  });

  test("a Start now item that is held, blocked or not Queued yet isn't claimable", async () => {
    await item("B", "Queued", 1);
    const held = await item("H", "Queued", 2, "held = true");
    const blocked = await item("X", "Queued", 3, "blocked_by = '{9}'");
    const notReady = await item("N", "NotReady", 4);
    for (const id of [held, blocked, notReady]) await press(id, "start_now");
    assert.deepEqual(await order(), ["B"]);
  });

  test("a cleared Start now gives the item back its board place", async () => {
    await item("A", "Queued", 1);
    const b = await item("B", "Queued", 2);
    await press(b, "start_now");
    assert.deepEqual(await order(), ["B", "A"]);
    await db.pool.query("update override set cleared_at = now()");
    assert.deepEqual(await order(), ["A", "B"]);
  });

  test("Move up and Move down step an item one place, and two moves step it two", async () => {
    await item("A", "Queued", 1);
    await item("B", "Queued", 2);
    const c = await item("C", "Queued", 3);
    await move(c, "up");
    assert.deepEqual(await order(), ["A", "C", "B"]);
    await move(c, "up");
    assert.deepEqual(await order(), ["C", "A", "B"]);
    await move(c, "down");
    assert.deepEqual(await order(), ["A", "C", "B"]);
    await move(c, "down");
    assert.deepEqual(await order(), ["A", "B", "C"]);
    const kinds = (await db.pool.query("select kind, reason, created_by from override where target_id = $1 order by created_at", [c])).rows;
    assert.deepEqual(kinds.map((k) => k.kind), ["move_up", "move_up", "move_down", "move_down"]);
    assert.ok(kinds.every((k) => k.created_by === operator && k.reason === "unit"));
  });

  test("a held item moves among the queue it would be in, and takes its place once released", async () => {
    await item("A", "Queued", 1);
    await item("B", "Queued", 2);
    const c = await item("C", "Queued", 3, "held = true");
    await withTx(db.pool, (cl) => moveInQueue(cl, c, "up", { reason: "unit", createdBy: operator }));
    assert.deepEqual(await order(), ["A", "B"]);
    await db.pool.query("update item set held = false where id = $1", [c]);
    assert.deepEqual(await order(), ["A", "C", "B"]);
  });

  test("a move ends with its override, and the item goes back to its board place", async () => {
    await item("A", "Queued", 1);
    const b = await item("B", "Queued", 2);
    await withTx(db.pool, (cl) => moveInQueue(cl, b, "up", { reason: "unit", createdBy: operator }));
    assert.deepEqual(await order(), ["B", "A"]);
    await db.pool.query("update override set cleared_at = now()");
    assert.deepEqual(await order(), ["A", "B"]);
  });

  test("moving an item that isn't in the queue throws", async () => {
    const n = await item("N", "NotReady", 1);
    await assert.rejects(withTx(db.pool, (cl) => moveInQueue(cl, n, "up", { reason: "unit", createdBy: operator })), /isn't in the factory queue/);
  });

  const move = (id: string, dir: "up" | "down") => withTx(db.pool, (cl) => moveInQueue(cl, id, dir, { reason: "unit", createdBy: operator }));

  test("a move steps one place when two backlog sources' ranks tie", async () => {
    const other = (await db.pool.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'unit-2') returning id")).rows[0].id;
    // Fresh ids each round, since the tie between two rank-1 items falls to their ids.
    for (let round = 0; round < 12; round++) {
      await db.pool.query("truncate item, override cascade");
      await item("A", "Queued", 1);
      await item("X", "Queued", 1, "", other);
      const c = await item("C", "Queued", 2);
      const before = await order();
      await move(c, "up");
      assert.deepEqual(await order(), [before[0], "C", before[1]], `round ${round}`);
      await move(c, "up");
      assert.deepEqual(await order(), ["C", ...before.slice(0, 2)], `round ${round}`);
      await move(c, "down");
      await move(c, "down");
      assert.deepEqual(await order(), [...before.slice(0, 2), "C"], `round ${round}`);
      const a = before[0] === "A" ? (await db.pool.query("select id from item where external_id = 'A'")).rows[0].id : null;
      if (a) {
        await move(a, "down");
        assert.deepEqual(await order(), [before[1], "A", "C"], `round ${round}`);
      }
    }
  });

  test("an item with no board rank moves down past another one", async () => {
    await item("A", "Queued", 1);
    const n = await item("N", "Queued", null);
    await item("M", "Queued", null);
    const first = await order();
    const top = first[1] === "N" ? n : (await db.pool.query("select id from item where external_id = 'M'")).rows[0].id;
    await move(top, "down");
    assert.deepEqual(await order(), ["A", first[2], first[1]]);
    await move(top, "up");
    await move(top, "up");
    assert.deepEqual(await order(), [first[1], "A", first[2]]);
  });

  test("an item moves back and forth between the same two many times and still lands between them", async () => {
    await item("A", "Queued", 1);
    await item("B", "Queued", 2);
    const c = await item("C", "Queued", 3);
    const d = await item("D", "Queued", 4);
    // C and D swap places over and over inside the gap between A and B, halving it each time.
    await move(c, "up");
    await move(d, "up");
    await move(d, "up");
    assert.deepEqual(await order(), ["A", "D", "C", "B"]);
    for (let i = 0; i < 80; i++) {
      await move(i % 2 ? d : c, "up");
      assert.deepEqual(await order(), i % 2 ? ["A", "D", "C", "B"] : ["A", "C", "D", "B"], `move ${i}`);
    }
  });
  test("a moved item keeps its place when a board change shifts it and the items around it", async () => {
    const a = await item("A", "Queued", 3);
    const b = await item("B", "Queued", 4);
    const c = await item("C", "Queued", 5);
    await move(c, "up");
    assert.deepEqual(await order(), ["A", "C", "B"]);
    // A new issue goes to the top of the board, and every rank below it grows by one.
    for (const [id, rank] of [[a, 4], [b, 5], [c, 6]] as const) await db.pool.query("update item set backlog_rank = $2 where id = $1", [id, rank]);
    assert.deepEqual(await order(), ["A", "C", "B"]);
    // An issue above them leaves the board, and every rank shrinks by two.
    for (const [id, rank] of [[a, 2], [b, 3], [c, 4]] as const) await db.pool.query("update item set backlog_rank = $2 where id = $1", [id, rank]);
    assert.deepEqual(await order(), ["A", "C", "B"]);
  });

  // PBI 311: a move holds its item next to the item it passed, whatever else the board does, until the board flips them.
  const ranks = async (r: [string, number][]) => {
    for (const [id, rank] of r) await db.pool.query("update item set backlog_rank = $2 where id = $1", [id, rank]);
    await withTx(db.pool, (cl) => keepMovesInPlace(cl));
  };
  const moveOf = async (id: string) => (await db.pool.query<{ cleared_at: Date | null; cleared_cause: string | null; passed: string | null }>(
    "select cleared_at, cleared_cause, value->>'passed' as passed from override where target_id = $1 order by created_at desc limit 1", [id],
  )).rows[0];

  test("a move records the item it passed", async () => {
    await item("A", "Queued", 1);
    const b = await item("B", "Queued", 2);
    const c = await item("C", "Queued", 3);
    await move(c, "up");
    assert.equal((await moveOf(c)).passed, b);
  });

  test("a moved-up item stays ahead of the item it passed when a new issue lands between them", async () => {
    const a = await item("A", "Queued", 1);
    const b = await item("B", "Queued", 2);
    const c = await item("C", "Queued", 3);
    await move(c, "up");
    await item("X", "Queued", 3);
    await ranks([[a, 1], [b, 2], [c, 4]]);
    assert.deepEqual(await order(), ["A", "C", "B", "X"]);
    // A second poll of the same board changes nothing.
    await ranks([]);
    assert.deepEqual(await order(), ["A", "C", "B", "X"]);
    assert.equal((await moveOf(c)).cleared_at, null);
  });

  test("a moved-down item stays behind the item it passed when new issues land between them", async () => {
    const a = await item("A", "Queued", 1);
    const b = await item("B", "Queued", 2);
    const c = await item("C", "Queued", 3);
    await move(a, "down");
    await item("X", "Queued", 2);
    await item("Y", "Queued", 3);
    await ranks([[a, 1], [b, 4], [c, 5]]);
    assert.deepEqual(await order(), ["X", "Y", "B", "A", "C"]);
  });

  test("an item not yet Queued that sits just ahead of the passed item doesn't come between them once Queued", async () => {
    await item("A", "Queued", 1);
    const y = await item("Y", "Eligible", 2);
    const b = await item("B", "Queued", 3);
    const c = await item("C", "Queued", 4);
    await move(c, "up");
    await ranks([[c, 6]]);
    await db.pool.query("update item set state = 'Queued' where id = $1", [y]);
    assert.deepEqual(await order(), ["A", "Y", "C", "B"]);
    assert.equal((await moveOf(c)).passed, b);
  });

  test("a board that puts the two items in the other order ends the move, saying why", async () => {
    const a = await item("A", "Queued", 1);
    const b = await item("B", "Queued", 2);
    const c = await item("C", "Queued", 3);
    const d = await item("D", "Queued", 4);
    await move(d, "up");
    await ranks([[a, 1], [d, 2], [b, 3], [c, 4]]);
    assert.deepEqual(await order(), ["A", "D", "B", "C"]);
    const ended = await moveOf(d);
    assert.ok(ended.cleared_at instanceof Date);
    assert.equal(ended.cleared_cause, "board_order");
    await ranks([[a, 1], [b, 2], [c, 3], [d, 4]]);
    assert.deepEqual(await order(), ["A", "B", "C", "D"]);
  });

  test("a board that puts a moved-down item behind the item it passed ends the move", async () => {
    const a = await item("A", "Queued", 1);
    const b = await item("B", "Queued", 2);
    await move(a, "down");
    await ranks([[b, 1], [a, 2]]);
    assert.equal((await moveOf(a)).cleared_cause, "board_order");
  });

  test("a move whose passed item left the queue keeps its place as before", async () => {
    const a = await item("A", "Queued", 1);
    const b = await item("B", "Queued", 2);
    const c = await item("C", "Queued", 3);
    await move(c, "up");
    await db.pool.query("update item set state = 'Abandoned' where id = $1", [b]);
    await ranks([]);
    assert.deepEqual(await order(), ["A", "C"]);
    assert.equal((await moveOf(c)).cleared_at, null);
  });

  test("a Move up pressed on an item already at the top keeps its hold on the item it passed", async () => {
    const a = await item("A", "Queued", 1);
    const b = await item("B", "Queued", 2);
    const c = await item("C", "Queued", 3);
    await move(c, "up");
    await move(c, "up");
    await move(c, "up");
    assert.deepEqual(await order(), ["C", "A", "B"]);
    assert.equal((await moveOf(c)).passed, a);
    await item("X", "Queued", 3);
    await item("Y", "Queued", 4);
    await ranks([[a, 1], [b, 2], [c, 5]]);
    assert.deepEqual(await order(), ["C", "A", "B", "X", "Y"]);
  });

  test("two moves that each passed the other settle once, and a poll of an unchanged board writes nothing", async () => {
    await item("A", "Queued", 1);
    const b = await item("B", "Queued", 2);
    const c = await item("C", "Queued", 3);
    await move(c, "up");
    await move(b, "up");
    assert.deepEqual(await order(), ["A", "B", "C"]);
    const values = async () => (await db.pool.query<{ v: string }>(
      "select value::text as v from override where kind in ('move_up', 'move_down') order by id",
    )).rows.map((r) => r.v);
    const before = await values();
    for (let i = 0; i < 3; i++) await ranks([]);
    assert.deepEqual(await values(), before);
    assert.deepEqual(await order(), ["A", "B", "C"]);
  });

  const activeMoves = async (id: string) => (await db.pool.query<{ kind: string }>(
    "select kind from override where target_id = $1 and kind in ('move_up', 'move_down') and cleared_at is null", [id],
  )).rows.map((r) => r.kind);

  test("moving an item back where the board has it isn't ended by a board change nobody made", async () => {
    const a = await item("A", "Queued", 1);
    const b = await item("B", "Queued", 2);
    await item("C", "Queued", 3);
    await move(a, "down");
    await move(a, "up");
    assert.deepEqual(await order(), ["A", "B", "C"]);
    await ranks([]);
    assert.deepEqual(await order(), ["A", "B", "C"]);
    const latest = await moveOf(a);
    assert.equal(latest.cleared_at, null);
    assert.equal(latest.passed, b);
    // Once the board itself puts A behind B, the order the move up was made in has flipped, so the board wins.
    await ranks([[b, 1], [a, 2]]);
    assert.deepEqual(await order(), ["B", "A", "C"]);
    assert.deepEqual(await activeMoves(a), []);
  });

  test("the board ending a move ends the item's earlier moves too, so it follows the board", async () => {
    const a = await item("A", "Queued", 1);
    const b = await item("B", "Queued", 2);
    const c = await item("C", "Queued", 3);
    await move(c, "up");
    await move(c, "up");
    assert.deepEqual(await order(), ["C", "A", "B"]);
    await ranks([[c, 1], [a, 2], [b, 3]]);
    assert.deepEqual(await order(), ["C", "A", "B"]);
    assert.deepEqual(await activeMoves(c), []);
    const ended = (await db.pool.query<{ n: number }>(
      "select count(*)::int as n from override where target_id = $1 and cleared_cause = 'board_order'", [c],
    )).rows[0].n;
    assert.equal(ended, 2);
    // It follows the board from then on.
    await ranks([[a, 1], [b, 2], [c, 3]]);
    assert.deepEqual(await order(), ["A", "B", "C"]);
  });
});

describe("claim keys (PBI 320)", dbTest, () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let source: string;

  before(async () => {
    db = await startTestDb();
  });
  after(async () => {
    await db?.stop();
  });
  beforeEach(async () => {
    await db.pool.query(`truncate item, backlog_source, override, "user" cascade`);
    source = (await db.pool.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'unit') returning id")).rows[0].id;
  });

  async function item(name: string, state: string, rank: number, priority: number | null, deps: string[] = []): Promise<string> {
    return (await db.pool.query<{ id: string }>(
      "insert into item (source_id, external_id, title, state, backlog_rank, board_priority, blocked_by) values ($1, $2, $2, $3, $4, $5, $6) returning id",
      [source, name, state, rank, priority, deps],
    )).rows[0].id;
  }
  /** An open run at `stage`, with an open PR, and the stages before it passed. */
  async function inLoop(id: string, stage: string, passed: string[] = []): Promise<void> {
    const run = (await db.pool.query<{ id: string }>(
      "insert into run (item_id, run_number, next_stage, pr_number, pr_url) values ($1, 1, $2, 7, 'https://github.com/o/r/pull/7') returning id", [id, stage],
    )).rows[0].id;
    for (const s of passed) await db.pool.query("insert into stage_run (run_id, stage_id, attempt, status) values ($1, $2, 1, 'passed')", [run, s]);
  }
  const order = async (resumeOnly = false) => (await nextUp(db.pool, 10, { resumeOnly })).map((r) => r.external_id);

  test("an item with no priority read yet counts as 3, and priority comes before the board order", async () => {
    await item("A", "Queued", 1, 4);
    await item("B", "Queued", 2, null);
    await item("C", "Queued", 3, 2);
    assert.deepEqual(await order(), ["C", "B", "A"]);
  });

  test("the final-stage group comes first, ordered by its own priority", async () => {
    await item("A", "Queued", 1, 1);
    await inLoop(await item("F", "Queued", 2, 5), "address", ["pr-review"]);
    await inLoop(await item("G", "Queued", 3, 2), "address", ["pr-review"]);
    assert.deepEqual(await order(), ["G", "F", "A"]);
    const keys = await claimKeys(db.pool);
    assert.equal([...keys.values()].filter((k) => k.finalStage).length, 2);
  });

  test("only the review loop with an open PR is final-stage", async () => {
    const first = await item("P", "InProgress", 1, 3);
    await inLoop(first, "pr-review");
    const second = await item("Q", "InProgress", 2, 3);
    // A passed address leaves next_stage at address (stageAfter), and the same claim runs the pr-review after it.
    await inLoop(second, "address", ["pr-review", "address"]);
    const green = await item("G", "InProgress", 3, 3);
    await inLoop(green, "green");
    const merged = await item("M", "Accepted", 4, 3);
    await inLoop(merged, "address");
    const keys = await claimKeys(db.pool);
    assert.equal(keys.get(first)?.finalStage, false);
    assert.equal(keys.get(second)?.finalStage, true);
    assert.equal(keys.get(green)?.finalStage, false);
    assert.equal(keys.get(merged)?.finalStage, false);
  });

  test("an item a final-stage item depends on, through another, joins the group with its priority", async () => {
    const a = await item("A", "InReview", 1, 2, ["E"]);
    await inLoop(a, "address");
    await item("E", "Queued", 2, 5, ["D"]);
    const d = await item("D", "Queued", 3, 5);
    await item("X", "Queued", 4, 1);
    assert.deepEqual(await order(), ["D", "X"]);
    assert.deepEqual(await claimKeys(db.pool, [d]), new Map([[d, {
      own: 5, priority: 2, finalStage: true, priorityFrom: { id: a, externalId: "A" }, finalStageFrom: { id: a, externalId: "A" }, bug: false,
    }]]));
  });

  test("outside the group an item takes the highest priority of the items that depend on it, never a lower one", async () => {
    const h = await item("H", "Queued", 1, 1, ["D"]);
    await item("L", "Queued", 2, 5, ["D", "K"]);
    await item("X", "Queued", 3, 2);
    const d = await item("D", "Queued", 4, 4);
    const k = await item("K", "Queued", 5, 3);
    assert.deepEqual(await order(), ["D", "X", "K"]);
    const keys = await claimKeys(db.pool, [d, k]);
    assert.deepEqual(keys.get(d), { own: 4, priority: 1, finalStage: false, priorityFrom: { id: h, externalId: "H" }, finalStageFrom: null, bug: false });
    assert.deepEqual(keys.get(k), { own: 3, priority: 3, finalStage: false, priorityFrom: null, finalStageFrom: null, bug: false });
  });

  test("a Done dependent lends nothing, and a cycle of dependencies ends", async () => {
    const a = await item("A", "Done", 1, 1, ["D"]);
    await inLoop(a, "address");
    await item("B", "Queued", 2, 2, ["C"]);
    const c = await item("C", "Queued", 3, 4, ["B"]);
    const d = await item("D", "Queued", 4, 5);
    const keys = await claimKeys(db.pool);
    assert.deepEqual(keys.get(d), { own: 5, priority: 5, finalStage: false, priorityFrom: null, finalStageFrom: null, bug: false });
    assert.equal(keys.get(c)?.priority, 2);
  });

  test("a priority-1 item gets past the waiting brake, and new work at another priority doesn't", async () => {
    await item("B", "Queued", 1, 2);
    await item("P", "Queued", 2, 1);
    await item("H", "Queued", 3, 1, ["D"]);
    await item("D", "Queued", 4, 4);
    assert.deepEqual(await order(true), ["P", "D"]);
  });

  // PBI 378: the board's "bug" label, as the poller writes it to bug_label.
  const bug = (id: string) => db.pool.query("update item set bug_label = true where id = $1", [id]);
  /** An answered NeedsInput item. */
  async function answered(id: string): Promise<void> {
    await db.pool.query("insert into question (item_id, kind, body, answer) values ($1, 'needs_input', 'q', 'a')", [id]);
  }

  test("in the final-stage group, bug items come first within each priority, after the higher priorities", async () => {
    await inLoop(await item("A", "Queued", 1, 1), "address", ["pr-review"]);
    await inLoop(await item("C", "Queued", 2, 2), "address", ["pr-review"]);
    const b = await item("B", "Queued", 3, 2);
    await inLoop(b, "address", ["pr-review"]);
    await bug(b);
    await item("X", "Queued", 4, 1);
    assert.deepEqual(await order(), ["A", "B", "C", "X"]);
    assert.equal((await claimKeys(db.pool, [b])).get(b)?.bug, true);
  });

  test("outside the group, bug items come first at claim priority 1 only, and before answered items", async () => {
    const n = await item("N", "NeedsInput", 1, 1);
    await answered(n);
    await item("A", "Queued", 2, 1);
    await bug(await item("B", "Queued", 3, 1));
    await item("P", "Queued", 4, 2);
    await bug(await item("Q", "Queued", 5, 2));
    assert.deepEqual(await order(), ["B", "N", "A", "P", "Q"]);
  });

  test("an item doesn't take the bug label of an item that depends on it, but its own counts at an inherited priority", async () => {
    await bug(await item("H", "Queued", 1, 1, ["D"]));
    const d = await item("D", "Queued", 2, 4);
    await item("X", "Queued", 3, 1);
    await bug(await item("Y", "Queued", 4, 1));
    const e = await item("E", "Queued", 5, 4);
    await item("K", "Queued", 6, 1, ["E"]);
    assert.deepEqual(await order(), ["Y", "D", "X", "E"]);
    assert.equal((await claimKeys(db.pool, [d])).get(d)?.bug, false);
    await bug(e);
    assert.deepEqual(await order(), ["Y", "E", "D", "X"]);
  });

  test("Move up doesn't take an item past a bug item at claim priority 1", async () => {
    await bug(await item("B", "Queued", 1, 1));
    const c = await item("C", "Queued", 2, 1);
    const op = (await db.pool.query<{ id: string }>(
      `insert into "user" (provider, subject, github_login, role) values ('microsoft', 'op', 'op', 'operator') returning id`,
    )).rows[0].id;
    await withTx(db.pool, (tx) => moveInQueue(tx, c, "up", { reason: "unit", createdBy: op }));
    assert.deepEqual(await order(), ["B", "C"]);
  });
});
