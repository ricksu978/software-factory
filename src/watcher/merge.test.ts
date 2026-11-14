import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mergeBlocker, untickedDodLines } from "./merge.ts";

const body = (dod: string, extra = "") =>
  `Builds it.\n\n${extra}## Definition of Done\n\nThe factory checked these lines at c1.\n\n${dod}\n\n## Shadow risk tier\n\n**Low**.\n\n- [ ] not a DoD line\n`;

describe("untickedDodLines", () => {
  test("returns each unticked line of the Definition of Done section, without the note for the person who merges", () => {
    const b = body("- [x] Tests pass\n- [ ] No secret in the diff *(for the person who merges to check)*\n- [X] Names the task *(for the person who merges to check)*");
    assert.deepEqual(untickedDodLines(b), ["No secret in the diff"]);
  });

  test("ignores unticked boxes outside the Definition of Done", () => {
    assert.deepEqual(untickedDodLines(body("- [x] Tests pass", "## Try it\n\n- [ ] Try it on staging\n\n")), []);
  });

  test("reads a body with CRLF line ends and a Definition of Done at its very end", () => {
    assert.deepEqual(untickedDodLines("## Definition of Done\r\n\r\n- [ ] A *(for the person who merges to check)*\r\n"), ["A"]);
  });

  test("a body with no Definition of Done section leaves no line", () => {
    assert.deepEqual(untickedDodLines("Just a PR\n- [ ] something"), []);
  });
});

describe("mergeBlocker", () => {
  const view = { mergeState: "clean" as const, headSha: "h", body: body("- [x] Tests pass"), approvedBy: ["octo"] };

  test("a clean, approved PR with every DoD line ticked has no blocker", () => {
    assert.equal(mergeBlocker(view), null);
  });

  test("a PR GitHub doesn't read clean, with no approval, or with an unticked DoD line is held", () => {
    assert.match(mergeBlocker({ ...view, mergeState: "blocked" })!, /blocked/);
    assert.match(mergeBlocker({ ...view, approvedBy: [] })!, /approv/);
    assert.match(mergeBlocker({ ...view, body: body("- [ ] X *(for the person who merges to check)*") })!, /X/);
  });
});
