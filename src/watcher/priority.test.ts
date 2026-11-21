// PBI 320: an item's own priority from the board's Priority field, and that a new priority doesn't re-gate the item.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { FactoryItem } from "../adapters/types.ts";
import { boardPriority, carriesBug, readinessItemHash } from "./poller.ts";

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

describe("carriesBug", () => {
  // PBI 378: only the board's "bug" label counts, in any case, and no other label does.
  test("an item with the bug label carries it", () => {
    assert.equal(carriesBug(["factory", "bug"]), true);
    assert.equal(carriesBug(["Bug"]), true);
  });

  test("an item without it doesn't", () => {
    for (const labels of [[], ["factory"], ["enhancement"], ["bugfix"], ["not a bug"]]) assert.equal(carriesBug(labels), false, labels.join(","));
  });
});

describe("readinessItemHash", () => {
  const fi = (fields: Record<string, string>, orderOnly?: string[]): FactoryItem => ({
    sourceId: "s", externalId: "1", title: "t", body: "b", acceptanceCriteria: ["it works"], labels: [], status: "", rank: 1, repo: "o/r", fields,
    closed: false, updatedAt: "", ...(orderOnly ? { orderOnly } : {}),
  });

  test("ignores an order-only Priority field, so a new priority doesn't re-gate the item", () => {
    assert.equal(readinessItemHash(fi({ Size: "3", Priority: "1" }, ["Priority"])), readinessItemHash(fi({ Size: "3" })));
    assert.notEqual(readinessItemHash(fi({ Size: "5" }, ["Priority"])), readinessItemHash(fi({ Size: "3" }, ["Priority"])));
  });

  test("counts a Priority field the repo judges, so setting it re-gates the item", () => {
    assert.notEqual(readinessItemHash(fi({ Size: "3", Priority: "1" })), readinessItemHash(fi({ Size: "3" })));
  });
});
