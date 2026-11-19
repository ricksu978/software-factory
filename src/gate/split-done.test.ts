import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SPLIT_DONE_HEADING, splitDoneComment, splitDoneKey } from "./split-done.ts";

describe("splitDoneComment", () => {
  const children = [
    { title: "Card payments", url: "https://github.com/o/r/issues/7", prNumber: 61, prUrl: "https://github.com/o/r/pull/61" },
    { title: "Bank transfers", url: "https://github.com/o/r/issues/8", prNumber: 62, prUrl: "https://github.com/o/r/pull/62" },
  ];

  test("opens with the heading and gives each child its own line with the PR that closed it", () => {
    const body = splitDoneComment(children);
    assert.ok(body.startsWith(`${SPLIT_DONE_HEADING}\n`));
    const lines = body.split("\n");
    for (const c of children) {
      const mine = lines.filter((l) => l.includes(c.title));
      assert.equal(mine.length, 1, c.title);
      assert.ok(mine[0].includes(c.url) && mine[0].includes(c.prUrl!) && mine[0].includes(`#${c.prNumber}`), mine[0]);
    }
    assert.match(body, /closes this item as completed/);
  });

  test("a Done child with no PR on record says so", () => {
    const body = splitDoneComment([{ title: "Gift cards", url: "u/9", prNumber: null, prUrl: null }]);
    assert.match(body, /\[Gift cards\]\(u\/9\), with no PR on record/);
  });

  test("its key is the parent's, so a retried poll posts no second comment", () => {
    assert.equal(splitDoneKey("12"), "split-done:12");
  });
});
