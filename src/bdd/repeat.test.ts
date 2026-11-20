import assert from "node:assert/strict";
import { test } from "node:test";
import { exactName, parseRepeatArgs, repeat, type RunResult } from "./repeat.ts";

test("--times and --name are read in either order", () => {
  assert.deepEqual(parseRepeatArgs(["--times", "3", "--name", "Counts to three"]), { times: 3, name: "Counts to three" });
  assert.deepEqual(parseRepeatArgs(["--name", "Counts to three", "--times", "3"]), { times: 3, name: "Counts to three" });
  assert.deepEqual(parseRepeatArgs(["--times=3", "--name=Counts to three"]), { times: 3, name: "Counts to three" });
});

for (const times of ["0", "-2", "three", "1.5", "2x", ""]) {
  test(`a run count of ${JSON.stringify(times)} is refused`, () => {
    const r = parseRepeatArgs(["--times", times, "--name", "A"]);
    assert.ok("error" in r);
    assert.match(r.error, /run count must be a whole number above zero/);
  });
}

test("a missing run count is refused", () => {
  const r = parseRepeatArgs(["--name", "A"]);
  assert.ok("error" in r && /run count must be a whole number above zero/.test(r.error));
});

test("a missing or empty name is refused", () => {
  for (const args of [["--times", "2"], ["--times", "2", "--name", ""]]) {
    const r = parseRepeatArgs(args);
    assert.ok("error" in r && /--name/.test(r.error));
  }
});

test("an unknown argument is refused", () => {
  const r = parseRepeatArgs(["--times", "2", "--name", "A", "--fast"]);
  assert.ok("error" in r && /--fast/.test(r.error));
});

test("the name pattern matches the whole name only, its regex characters taken literally", () => {
  const re = new RegExp(exactName("Counts (to) three? $1.50"));
  assert.ok(re.test("Counts (to) three? $1.50"));
  assert.ok(!re.test("Counts (to) three? $1.50 again"));
  assert.ok(!re.test("Counts to three $1.50"));
  assert.ok(!new RegExp(exactName("Counts to three")).test("Counts to thirty three"));
});

const runner = (outcomes: boolean[]) => {
  const calls: number[] = [];
  return {
    calls,
    run: async (i: number): Promise<RunResult> => {
      calls.push(i);
      return { passed: outcomes[i - 1], output: `output of run ${i}\n` };
    },
  };
};

test("every run passing reports n of n and succeeds", async () => {
  const r = runner([true, true, true]);
  const lines: string[] = [];
  const ok = await repeat(3, r.run, (l) => lines.push(l));
  assert.equal(ok, true);
  assert.deepEqual(r.calls, [1, 2, 3]);
  assert.equal(lines.at(-1), "3 of 3 runs passed.");
  assert.ok(!lines.some((l) => /failed/.test(l)));
});

test("failed runs are named with their output, later runs still go ahead, and the count says how many passed", async () => {
  const r = runner([true, false, true, false, true]);
  const lines: string[] = [];
  const ok = await repeat(5, r.run, (l) => lines.push(l));
  assert.equal(ok, false);
  assert.deepEqual(r.calls, [1, 2, 3, 4, 5]);
  const out = lines.join("\n");
  assert.deepEqual([...out.matchAll(/run (\d+) of 5 failed/g)].map((m) => Number(m[1])), [2, 4]);
  assert.match(out, /output of run 2/);
  assert.doesNotMatch(out, /output of run 3/);
  assert.equal(lines.at(-1), "3 of 5 runs passed. Runs 2 and 4 failed.");
});
