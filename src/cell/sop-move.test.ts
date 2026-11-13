import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { loadSop } from "../config/sop.ts";
import type { TransitionBody } from "./api-client.ts";
import type { CellContext } from "./engine.ts";
import { resumeOnImageSop, type SopMoveApi } from "./sop-move.ts";

const SOP = loadSop(readFileSync(join(import.meta.dirname, "..", "..", "sop", "default.yml"), "utf8"));

function context(o: Partial<CellContext>): CellContext {
  return {
    externalId: "482", title: "t", acceptanceCriteria: ["it works"], nextStage: "green", decision: null, lockSha: null, lockedFiles: [],
    prNumber: null, repo: "acme/widgets", base: "main", branch: "factory/pbi-482-r1", configSha: "a1b2c3d", sopVersion: SOP.version,
    dodVerdicts: [], dodCheckedSha: null, scenarioNotes: [], trustedComments: [], stageAttempts: {}, resume: null, ...o,
  };
}

function recorder() {
  const calls: { moves: { from: string; to: string }[]; transitions: TransitionBody[] } = { moves: [], transitions: [] };
  const api: SopMoveApi = {
    transition: async (b) => void calls.transitions.push(b),
    moveSop: async (b) => void calls.moves.push(b),
  };
  return { api, calls };
}

describe("resumeOnImageSop", () => {
  test("a run on the image's SOP goes on as it is and calls nothing", async () => {
    const { api, calls } = recorder();
    const ctx = context({});
    assert.equal(await resumeOnImageSop(api, ctx, SOP), ctx);
    assert.deepEqual(calls, { moves: [], transitions: [] });
  });

  test("a run pinned to an older SOP moves to the image's SOP and keeps its stage and config commit", async () => {
    const { api, calls } = recorder();
    const run = await resumeOnImageSop(api, context({ sopVersion: "0.0.3", nextStage: "red" }), SOP);
    assert.deepEqual(calls, { moves: [{ from: "0.0.3", to: SOP.version }], transitions: [] });
    assert.equal(run?.sopVersion, SOP.version);
    assert.equal(run?.nextStage, "red");
    assert.equal(run?.configSha, "a1b2c3d");
  });

  test("a run whose next stage the image's SOP lacks asks for input naming the stage, and doesn't move", async () => {
    const { api, calls } = recorder();
    assert.equal(await resumeOnImageSop(api, context({ sopVersion: "0.1.0", nextStage: "qa-review" }), SOP), null);
    assert.deepEqual(calls.moves, []);
    assert.equal(calls.transitions.length, 1);
    const [t] = calls.transitions;
    assert.equal(t.event, "blocked");
    assert.equal(t.question?.kind, "needs_input");
    assert.match(t.question?.body ?? "", /qa-review/);
    assert.match(t.question?.body ?? "", new RegExp(`SOP ${SOP.version.replace(/\./g, "\\.")} has no`));
    assert.match(t.question?.body ?? "", /0\.1\.0/);
  });
});
