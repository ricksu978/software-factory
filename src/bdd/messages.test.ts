import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { classify, greenGate, redGate, traceability, type Results } from "./messages.ts";

// A real cucumber-js 13.3.0 run, trimmed to the four message kinds classify reads.
const fixture = readFileSync(new URL("./fixtures/verdicts.ndjson", import.meta.url), "utf8");

function byName(results: Results) {
  return Object.fromEntries([...results.values()].map((r) => [r.name, r.verdict]));
}

test("each scenario in a real run gets the verdict of its first step that didn't pass", () => {
  assert.deepEqual(byName(classify(fixture)), {
    "Then fails": "red",
    "And after a Then fails": "red",
    "Every step passes": "green",
    "Undefined step": "crash",
    "When fails": "crash",
    "Given is pending": "crash",
    "Ambiguous step": "crash",
    "A hook fails before the Then": "crash",
  });
});

test("a red verdict names the failed Then and its message", () => {
  const red = [...classify(fixture).values()].find((r) => r.name === "Then fails");
  assert.equal(red?.reason, '"a step fails" failed: Error: expected 3, got 4');
});

test("an empty report gives no results", () => {
  assert.equal(classify("").size, 0);
});

test("a report cut short turns the scenario it cut into a crash, never a red", () => {
  const lines = fixture.trim().split("\n");
  // The run's first FAILED result is the Then of "Then fails". Leave it half-written, as a killed runner would.
  const i = lines.findIndex((l) => l.includes('"status":"FAILED"'));
  const cut = classify(lines.map((l, n) => (n === i ? l.slice(0, 40) : l)).join("\n"));
  assert.equal(byName(cut)["Then fails"], "crash");
  assert.equal(byName(cut)["And after a Then fails"], "red");
});

function results(rows: [name: string, tags: string[], verdict: "red" | "green" | "crash"][]): Results {
  return new Map(rows.map(([name, tags, verdict], i) => [`p${i}`, { name, tags, verdict, reason: "" }]));
}

test("traceability lists a criterion only another item's scenario covers", () => {
  const r = results([
    ["a", ["@pbi-482", "@ac-1"], "red"],
    ["b", ["@pbi-482", "@ac-3"], "red"],
    ["c", ["@pbi-481", "@ac-2"], "green"],
  ]);
  assert.deepEqual(traceability(r, 3, "@pbi-482"), ["@ac-2"]);
});

test("red passes for a second item while the first item's scenarios are green", () => {
  const r = results([["a", ["@pbi-481"], "green"], ["b", ["@pbi-482"], "red"]]);
  assert.deepEqual(redGate(r, "@pbi-482", ["b"]), { ok: true, findings: [] });
});

test("red fails on a scenario of the item that crashed", () => {
  const r = results([["b", ["@pbi-482"], "crash"]]);
  assert.equal(redGate(r, "@pbi-482", ["b"]).ok, false);
});

test("green needs every scenario in the suite green, and a report with none fails", () => {
  assert.equal(greenGate(results([["a", ["@pbi-481"], "green"], ["b", ["@pbi-482"], "green"]])).ok, true);
  assert.deepEqual(greenGate(results([["a", ["@pbi-481"], "red"]])).findings, ["scenario is red: a: "]);
  assert.deepEqual(greenGate(new Map()).findings, ["the report holds no scenarios"]);
});
