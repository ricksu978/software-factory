import assert from "node:assert/strict";
import { test } from "node:test";
import { featureChangeAsks, featureChangeComment, lineDiff } from "./feature-change.ts";

test("a report's FEATURE CHANGE lines name each file with its reason (PBI 364)", () => {
  const report = [
    "Done. The tests pass.",
    "",
    "FEATURE CHANGE: features/a.feature: An empty order is held, not refused",
    "  FEATURE CHANGE: features/b.feature: A refund needs the order's number: always  ",
    "APPROVED",
  ].join("\n");
  assert.deepEqual([...featureChangeAsks(report)], [
    ["features/a.feature", "An empty order is held, not refused"],
    ["features/b.feature", "A refund needs the order's number: always"],
  ]);
});

test("a report with no FEATURE CHANGE line, or one with no reason, asks for nothing (PBI 364)", () => {
  assert.equal(featureChangeAsks("All done.\nSCENARIO NOTE: x is odd").size, 0);
  assert.equal(featureChangeAsks("FEATURE CHANGE: features/a.feature:").size, 0);
  assert.equal(featureChangeAsks("I'd write FEATURE CHANGE: features/a.feature: x mid-line").size, 0);
});

test("a file named twice keeps its last reason (PBI 364)", () => {
  assert.deepEqual([...featureChangeAsks("FEATURE CHANGE: f.feature: one\r\nFEATURE CHANGE: f.feature: two\r\n")], [["f.feature", "two"]]);
});

test("the line diff shows each line taken out and put in, with context and gaps (PBI 364)", () => {
  const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].join("\n") + "\n";
  const after = ["a", "b", "c", "d", "E", "f", "g", "h", "i"].join("\n") + "\n";
  assert.deepEqual(lineDiff(before, after, 1), [
    null,
    { side: "same", text: "d" },
    { side: "before", text: "e" },
    { side: "after", text: "E" },
    { side: "same", text: "f" },
  ]);
  assert.deepEqual(lineDiff("x\n", "x\ny\n", 0), [null, { side: "after", text: "y" }]);
  assert.deepEqual(lineDiff("x\n", "x\n"), []);
});

test("the PBI comment names each file, its reason and its diff (PBI 364)", () => {
  const body = featureChangeComment([
    { path: "features/a.feature", reason: "Held, not refused", before: "  Then refused\n", after: "  Then held\n" },
    { path: "features/b.feature", reason: "Needs a number", before: "x\n", after: "y\n" },
  ]);
  const a = body.indexOf("features/a.feature");
  const b = body.indexOf("features/b.feature");
  assert.ok(a > 0 && b > a);
  const first = body.slice(a, b);
  assert.match(first, /Reason: Held, not refused/);
  assert.match(first, /```diff\n-  Then refused\n\+  Then held\n```/);
  assert.match(body.slice(b), /Reason: Needs a number[\s\S]*-x\n\+y/);
});
