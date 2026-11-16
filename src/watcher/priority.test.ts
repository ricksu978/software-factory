// PBI 320: an item's own priority from the board's Priority field, and that a new priority doesn't re-gate the item.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { FactoryItem } from "../adapters/types.ts";
import { boardPriority, readinessItemHash } from "./poller.ts";

describe("boardPriority", () => {
  test("a whole number from 1 to 5 is the priority", () => {
    for (const p of [1, 2, 3, 4, 5]) assert.equal(boardPriority({ Priority: String(p) }), p);
    assert.equal(boardPriority({ Priority: " 2 " }), 2);
  });

  test("a missing value or one outside 1 to 5 is 3", () => {
    for (const raw of ["", "0", "6", "-1", "2.5", "high", "P1", "10"]) assert.equal(boardPriority({ Priority: raw }), 3, raw);
    assert.equal(boardPriority({}), 3);
    assert.equal(boardPriority({ Size: "1" }), 3);
  });
});

describe("readinessItemHash", () => {
  const fi = (fields: Record<string, string>): FactoryItem => ({
    sourceId: "s", externalId: "1", title: "t", body: "b", acceptanceCriteria: ["it works"], labels: [], status: "", rank: 1, repo: "o/r", fields,
    closed: false, updatedAt: "",
  });

  test("ignores the Priority field, so a new priority doesn't re-gate the item", () => {
    assert.equal(readinessItemHash(fi({ Size: "3", Priority: "1" })), readinessItemHash(fi({ Size: "3" })));
    assert.notEqual(readinessItemHash(fi({ Size: "5" })), readinessItemHash(fi({ Size: "3" })));
  });
});
