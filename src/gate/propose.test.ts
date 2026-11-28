import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Verdict } from "../policy/policy.ts";
import { bodyDiff, proposedBody, untestable } from "./propose.ts";

const criteria = ["The checkout page loads the saved card", "Paying takes one click"];
const current = "Make checkout faster.\n\n## Acceptance criteria\n\n- The checkout page loads the saved card\n- Paying takes one click\n";
const line = (index: number, criterion: string, reason: string): Verdict => ({ index, criterion, status: "failed", reason });
const screen = line(2, "The item names the screen it changes", "No screen is named");
const testable = line(1, "Every acceptance criterion can be tested", "Paying takes one click has no measure of a click");

describe("untestable", () => {
  test("a criterion that a failed line about testing names in its reason is untestable, with the judge's reason", () => {
    assert.deepEqual(untestable(criteria, [screen, testable]), [{ criterion: "Paying takes one click", reason: testable.reason }]);
  });

  test("a line not about testing, or an engine rule, moves no criterion", () => {
    assert.deepEqual(untestable(criteria, [line(2, "The item names the screen", "Paying takes one click names none")]), []);
    assert.deepEqual(untestable(criteria, [{ ...testable, index: 0 }]), []);
  });
});

describe("proposedBody", () => {
  test("keeps every criterion word for word under the body's own heading, whatever the model wrote", () => {
    const body = proposedBody(current, criteria, "Make the checkout page faster.\n\n## Acceptance criteria\n\n- Payment needs a single click\n", [screen]);
    assert.equal(body, "Make the checkout page faster.\n\n## Acceptance criteria\n\n- The checkout page loads the saved card\n- Paying takes one click\n");
  });

  test("moves an untestable criterion to the Notes, after the model's own notes, with a line saying why", () => {
    const body = proposedBody(current, criteria, "Make the checkout page faster.\n\n## Notes\n\n- Ask design first.", [testable]);
    assert.equal(body, [
      "Make the checkout page faster.", "", "## Acceptance criteria", "", "- The checkout page loads the saved card", "", "## Notes", "",
      "- Ask design first.",
      `- "Paying takes one click" moved here from the acceptance criteria, because the readiness judge found it can't be tested: ${testable.reason}`,
    ].join("\n") + "\n");
  });

  test("keeps the model's other sections, such as a rules section", () => {
    const rules = "## Changes the factory's rules\n\n### Spec §6\n\n**Before**\n> A.\n\n**After**\n> B.";
    assert.ok(proposedBody(current, criteria, `Lead.\n\n${rules}`, [screen]).startsWith(`Lead.\n\n${rules}\n\n## Acceptance criteria`));
  });
});

describe("bodyDiff", () => {
  const marked = (lines: { text: string; changed: boolean }[][]) => lines.flat().filter((w) => w.changed).map((w) => w.text);

  test("a line changed on both sides is matched word by word", () => {
    const d = bodyDiff("Make checkout faster.", "Make the checkout page faster.");
    assert.deepEqual(marked(d.current), []);
    assert.deepEqual(marked(d.proposed), ["the", "page"]);
  });

  test("a kept line is never marked, and a run of lines that doesn't pair up is marked whole", () => {
    const proposed = proposedBody(current, criteria, "Make checkout faster.", [testable]);
    const d = bodyDiff(current, proposed);
    assert.deepEqual(marked(d.current), ["-", "Paying", "takes", "one", "click"]);
    assert.ok(!d.proposed.flat().some((w) => w.changed && w.text === "loads"));
    assert.ok(d.proposed.some((l) => l.length && l.every((w) => w.changed) && l.some((w) => w.text === "Notes")));
  });

  test("blank lines are left out", () => {
    assert.deepEqual(bodyDiff("a\n\n\nb", "a\nb"), { current: [[{ text: "a", changed: false }], [{ text: "b", changed: false }]], proposed: [[{ text: "a", changed: false }], [{ text: "b", changed: false }]] });
  });
});
