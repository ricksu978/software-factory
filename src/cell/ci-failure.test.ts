import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ciFailureOf, ciFindings, ciQuestion, sharedCiLines } from "./ci-failure.ts";

const SHA = "c0ffee1234567890c0ffee1234567890c0ffee12";
const url = (n: number) => `https://github.com/acme/widgets/actions/runs/${n}`;

describe("ciFailureOf", () => {
  test("keeps each failed check with its URL and failing tests, and drops the ones that passed or still run", () => {
    const f = ciFailureOf(SHA, [
      { name: "lint", conclusion: "success", url: url(1) },
      { name: "ci", conclusion: "failure", url: url(2), failingTests: ["a", "b"] },
      { name: "docs", conclusion: "pending", url: url(3) },
      { name: "e2e", conclusion: "failure", url: url(4) },
    ]);
    assert.deepEqual(f, { sha: SHA, checks: [{ name: "ci", url: url(2), failingTests: ["a", "b"] }, { name: "e2e", url: url(4), failingTests: [] }] });
  });

  test("gives no checks when CI named none", () => {
    assert.deepEqual(ciFailureOf(SHA, null), { sha: SHA, checks: [] });
  });
});

describe("ciFindings", () => {
  test("one finding per failed check, each saying CI failed on the commit, with the check, its URL and its tests", () => {
    const out = ciFindings({ sha: SHA, checks: [{ name: "ci", url: url(2), failingTests: ["a", "b"] }, { name: "e2e", url: url(4), failingTests: [] }] });
    assert.equal(out.length, 2);
    assert.match(out[0], /^CI failed on c0ffee1234/);
    assert.ok(out[0].includes(`"ci"`) && out[0].includes(url(2)) && out[0].includes(`"a", "b"`));
    assert.match(out[1], /CI named no failing test for the check "e2e"/);
  });

  test("says what the commit was, when told", () => {
    assert.match(ciFindings({ sha: SHA, checks: [] }, "the PR addresser's fix")[0], /^CI failed on c0ffee1\S*, the PR addresser's fix, and named no failed check/);
  });
});

describe("sharedCiLines", () => {
  const item = { sha: SHA, checks: [{ name: "ci", url: url(2), failingTests: ["parses the config"] }] };

  test("blames the base when every failed check names tests the base fails too", () => {
    const lines = sharedCiLines(item, [{ name: "ci", conclusion: "failure", url: url(9), failingTests: ["parses the config", "other"] }]);
    assert.deepEqual(lines, [{ criterion: "ci", tests: ["parses the config"], check: { name: "ci", url: url(2) } }]);
  });

  test("keeps the failure the item's when a test fails only on the item, a check names no test, or the base passed", () => {
    assert.equal(sharedCiLines({ sha: SHA, checks: [{ name: "ci", url: url(2), failingTests: ["parses the config", "totals"] }] },
      [{ name: "ci", conclusion: "failure", url: url(9), failingTests: ["parses the config"] }]), null);
    assert.equal(sharedCiLines({ sha: SHA, checks: [...item.checks, { name: "e2e", url: url(4), failingTests: [] }] },
      [{ name: "ci", conclusion: "failure", url: url(9), failingTests: ["parses the config"] }]), null);
    assert.equal(sharedCiLines(item, [{ name: "ci", conclusion: "success", url: url(9), failingTests: ["parses the config"] }]), null);
    assert.equal(sharedCiLines(item, null), null);
    assert.equal(sharedCiLines({ sha: SHA, checks: [] }, [{ name: "ci", conclusion: "failure", url: url(9), failingTests: ["x"] }]), null);
  });
});

describe("ciQuestion", () => {
  const first = { sha: SHA, checks: [{ name: "ci", url: url(1), failingTests: ["a"] }] };
  const second = { sha: "c0ffee2000000000000000000000000000000000", checks: [{ name: "ci", url: url(2), failingTests: [] }] };

  test("names each commit CI failed on, how often Green tried, the last commit left unchanged and its failed checks", () => {
    const q = ciQuestion([first, second]);
    assert.match(q, /Green tried to fix the CI failure 2 times/);
    assert.ok(q.includes("c0ffee1") && q.includes("c0ffee2"));
    assert.match(q, /Green's last attempt left c0ffee2 unchanged/);
    assert.ok(q.includes(url(2)) && !q.includes(url(1)));
    assert.match(q, /no failing test/);
  });
});
