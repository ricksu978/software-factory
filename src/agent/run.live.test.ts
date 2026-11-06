// Runs only with CLAUDE_CODE_OAUTH_TOKEN set (plan Task 11 Step 5). Run it in the cell image.
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { runAgent } from "./run.ts";

test("Haiku answers one word and the run reports its cost", { skip: !process.env.CLAUDE_CODE_OAUTH_TOKEN }, async () => {
  const r = await runAgent({ prompt: "Reply with the word ready.", model: "claude-haiku-5-5", cwd: tmpdir(), maxTurns: 1,
    mode: "judge", signal: AbortSignal.timeout(120_000) });
  assert.equal(r.ok, true, r.text);
  assert.ok(r.costUsd > 0);
  assert.equal(r.model, "claude-haiku-5-5");
});
