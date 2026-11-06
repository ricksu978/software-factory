import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { loadSop, SopError, stageAfter } from "./sop.ts";

describe("stageAfter", () => {
  const def = loadSop(readFileSync(new URL("../../sop/default.yml", import.meta.url), "utf8"));
  test("gives the next listed stage, and null for merge, open-pr, address and a stage the SOP doesn't list", () => {
    assert.equal(stageAfter(def, "understand"), "specify");
    assert.equal(stageAfter(def, "specify"), "sign-off");
    assert.equal(stageAfter(def, "self-review"), "open-pr");
    for (const s of ["merge", "open-pr", "address", "deploy"]) assert.equal(stageAfter(def, s), null, s);
  });
});

const sop = (stages: string, models = "  coding: claude-opus-5-5\n  triage: claude-haiku-5-5\n") =>
  `sop: default\nversion: 0.1.0\nmodels:\n${models}stages:\n${stages}`;

describe("loadSop", () => {
  test("a valid SOP loads, with its models and stages", () => {
    const s = loadSop(sop("  - id: specify\n    model: coding\n  - id: sign-off\n  - id: red\n    model: coding\n"));
    assert.equal(s.models.triage, "claude-haiku-5-5");
    assert.deepEqual(s.stages.map((x) => x.id), ["specify", "sign-off", "red"]);
  });

  test("an unknown stage id is refused", () => {
    assert.throws(() => loadSop(sop("  - id: deploy\n")), (e: unknown) => e instanceof SopError && /unknown stage id deploy/.test(e.message));
  });

  test("a stage listed twice is refused", () => {
    assert.throws(() => loadSop(sop("  - id: red\n  - id: red\n")), /appears twice/);
  });

  test("models.coding and models.triage are both required", () => {
    assert.throws(() => loadSop(sop("  - id: red\n", "  coding: claude-opus-5-5\n")), /models\.triage is missing/);
  });

  test("a stage model must name a key in models", () => {
    assert.throws(() => loadSop(sop("  - id: green\n    model: claude-opus-5-5\n")), /isn't in models/);
  });

  test("a stage model that only an inherited property matches is refused", () => {
    assert.throws(() => loadSop(sop("  - id: green\n    model: constructor\n")), /isn't in models/);
  });
});
