import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentArgs } from "../agent/run.ts";
import type { Verdict } from "../policy/policy.ts";
import { classifyRisk, pathFloor, type RiskContext } from "./shadow.ts";

/** A fake model: `replies` answers each call in turn, and every prompt is kept. */
function fake(...replies: string[]) {
  const prompts: string[] = [];
  const agent = async (a: AgentArgs) => {
    prompts.push(a.prompt);
    return { ok: true, text: replies[prompts.length - 1] ?? "", costUsd: 0, tokensIn: 0, tokensOut: 0, model: a.model, limit: null, usage: null, transcript: "" };
  };
  return { agent, prompts };
}
const tier = (t: string) => JSON.stringify({ tier: t, reason: "fake" });
const person = (yes: boolean) => JSON.stringify({ needsPerson: yes, reason: "fake" });

function ctx(over: Partial<RiskContext> & { agent: RiskContext["agent"] }, sensitive: string[] = [], riskText = "Low: docs.\nHigh: payments."): RiskContext {
  return {
    sop: { sop: "default", version: "0.1.0", models: { coding: "claude-sonnet-5-5", triage: "claude-haiku-5-5" }, stages: [] },
    config: { sensitivePaths: sensitive, reviewers: [], webTools: [], bdd: { parse: "", run: "", report: "" }, commands: { test: "", lint: "" } },
    risk: { name: "risk", source: "repo", sha: "s", text: riskText, criteria: [] },
    dodVerdicts: [],
    ...over,
  };
}

describe("pathFloor", () => {
  test("gives Medium for CI workflows, .factory/, .claude/, AGENTS.md, CLAUDE.md and sensitive paths, and Low for docs", () => {
    for (const f of [".github/workflows/ci.yml", ".factory/config.yml", ".factory/dod.md", ".claude/agents/self-reviewer.md", "AGENTS.md", "src/CLAUDE.md", "src/billing/pay.ts"]) {
      assert.equal(pathFloor([f], ["src/billing/**"]).min, "Medium", f);
    }
    assert.deepEqual(pathFloor(["docs/readme.md"], ["src/billing/**"]), { min: "Low", reasons: [] });
  });

  test("a sensitive glob reaches dotfiles, which path.matchesGlob alone would skip", () => {
    assert.equal(pathFloor(["infra/.env"], ["infra/**"]).min, "Medium");
  });
});

describe("classifyRisk", () => {
  test("a docs-only diff the model calls Low, with a DoD line left for a person, is Medium with that reason", async () => {
    const dod: Verdict[] = [{ index: 1, criterion: "Deployed to staging", status: "person", reason: "a person deploys" }];
    const r = await classifyRisk("diff", ["docs/readme.md"], ctx({ agent: fake(tier("Low"), person(false)).agent, dodVerdicts: dod }));
    assert.equal(r.tier, "Medium");
    assert.ok(r.reasons.includes("a DoD line needs a person at merge: Deployed to staging"));
  });

  test("the repo's risk.md reaches the prompt, and a payments change it calls High comes back High", async () => {
    const f = fake(tier("High"), person(false));
    const r = await classifyRisk("diff", ["src/payments/charge.ts"], ctx({ agent: f.agent }, [], "High: any change to src/payments/**"));
    assert.ok(f.prompts[0].includes("High: any change to src/payments/**"));
    assert.equal(r.tier, "High");
  });

  test("a risk.md and a model that both call a .factory/ change Low still give Medium, keeping both reasons", async () => {
    const r = await classifyRisk("diff", [".factory/config.yml"], ctx({ agent: fake(tier("Low"), person(false)).agent }, [], "Low: any .factory/ change"));
    assert.equal(r.tier, "Medium");
    assert.ok(r.reasons.some((x) => x.startsWith("the classifier says Low")));
    assert.ok(r.reasons.some((x) => x.includes(".factory/config.yml")));
  });

  test("a second pass that says a person should see it raises Low to Medium", async () => {
    const r = await classifyRisk("diff", ["docs/readme.md"], ctx({ agent: fake(tier("Low"), person(true)).agent }));
    assert.equal(r.tier, "Medium");
  });

  test("output that doesn't parse, in either pass, gives High with the reason", async () => {
    for (const replies of [["I'm not sure"], [tier("Low"), "maybe?"]]) {
      const r = await classifyRisk("diff", ["docs/readme.md"], ctx({ agent: fake(...replies).agent }));
      assert.equal(r.tier, "High");
      assert.equal(r.reasons[0], "classifier output unreadable");
    }
  });

  test("a docs change the model calls Low stays Low", async () => {
    const r = await classifyRisk("diff", ["docs/readme.md"], ctx({ agent: fake(tier("Low"), person(false)).agent }));
    assert.equal(r.tier, "Low");
  });
});
