import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { PRODUCTION_LINE_ROWS, twoLists, type ProductionLineRow, type WaitingOnYouRow } from "./floor-lists.ts";

const waiting = (id: string, since: string | null, why: WaitingOnYouRow["why"] = "question"): WaitingOnYouRow => ({
  id, external_id: id, repo: null, title: `Item ${id}`, state: "NeedsInput", since: since ? new Date(since) : null, why, partOf: null,
});
const line = (id: string, state = "Queued", waitsOn: string[] = []): ProductionLineRow => ({
  id, external_id: id, repo: null, title: `Item ${id}`, state, stage: null, since: null, cost: null, message: null, ci_failure: null, badges: [], waitsOn, partOf: null,
});
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe("twoLists", () => {
  test("orders Waiting on you oldest first, with an item of no known time last", () => {
    const { waitingOnYou } = twoLists({
      waiting: [waiting("41", "2026-11-27T09:00:00Z"), waiting("99", null), waiting("45", "2026-11-25T08:00:00Z"), waiting("42", "2026-11-26T15:00:00Z")],
      inProgress: [], claimable: [], queue: [],
    });
    assert.deepEqual(ids(waitingOnYou), ["45", "42", "41", "99"]);
  });

  test("lists the InProgress items, then the claimable ones in claim order, then the rest of the queue, then those waiting on another PBI", () => {
    const { productionLine, productionMore } = twoLists({
      waiting: [],
      inProgress: [line("60", "InProgress")],
      claimable: [line("62"), line("61")],
      queue: [line("46", "Queued", ["12"]), line("61"), line("70"), line("62")],
    });
    assert.deepEqual(ids(productionLine), ["60", "62", "61", "70", "46"]);
    assert.equal(productionMore, 0);
  });

  test("holds 10 rows in all, every InProgress item included, and counts the queued items that didn't fit", () => {
    const inProgress = ["60", "61", "62"].map((id) => line(id, "InProgress"));
    const queue = Array.from({ length: 9 }, (_, i) => line(String(71 + i)));
    const { productionLine, productionMore } = twoLists({ waiting: [], inProgress, claimable: queue, queue });
    assert.equal(productionLine.length, PRODUCTION_LINE_ROWS);
    assert.deepEqual(ids(productionLine), ["60", "61", "62", "71", "72", "73", "74", "75", "76", "77"]);
    assert.equal(productionMore, 2);
  });

  test("shows every InProgress item even past 10, and then no queued one", () => {
    const inProgress = Array.from({ length: 12 }, (_, i) => line(String(i), "InProgress"));
    const { productionLine, productionMore } = twoLists({ waiting: [], inProgress, claimable: [line("q")], queue: [line("q")] });
    assert.equal(productionLine.length, 12);
    assert.equal(productionMore, 1);
  });

  test("never lists an item twice, or in both lists", () => {
    const { waitingOnYou, productionLine } = twoLists({
      waiting: [waiting("41", "2026-11-27T09:00:00Z"), waiting("41", "2026-11-27T08:00:00Z")],
      inProgress: [line("60", "InProgress"), line("41", "InProgress")],
      claimable: [line("60"), line("61")],
      queue: [line("61"), line("41")],
    });
    assert.deepEqual(ids(waitingOnYou), ["41"]);
    assert.deepEqual(ids(productionLine), ["60", "61"]);
  });
});
