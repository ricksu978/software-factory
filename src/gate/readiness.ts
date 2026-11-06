// The readiness gate (plan Task 9): the engine's own rules first, then the judge on every dor.md line.
import type { BacklogAdapter, FactoryItem } from "../adapters/types.ts";
import { jsonLines, parseJudgement, type Policy, type Verdict } from "../policy/policy.ts";

export type GateContext = {
  readinessSha: string;
  /** Null when the repo is unknown. */
  dor: Policy | null;
  dodExists: boolean;
  configValid: boolean;
  repoKnown: boolean;
  openDeps: string[];
  judge: (item: FactoryItem, dor: Policy) => Promise<string>;
  adapter: BacklogAdapter;
};

const engine = (reason: string): Verdict => ({ index: 0, criterion: "engine rule", status: "failed", reason });

/** The rules no policy file can weaken (spec §6). Any failure here means the judge is never asked. */
function engineRules(item: FactoryItem, ctx: GateContext): Verdict[] {
  const failed: Verdict[] = [];
  if (!ctx.repoKnown || !ctx.dor) failed.push(engine("The factory doesn't know this item's repo"));
  if (!ctx.dodExists) failed.push(engine("No .factory/dod.md in this repo"));
  if (!ctx.configValid) failed.push(engine("No valid .factory/config.yml in this repo"));
  if (item.acceptanceCriteria.length === 0) failed.push(engine("The item has no acceptance criteria"));
  for (const dep of ctx.openDeps) failed.push(engine(`The item depends on ${dep}, which is still open`));
  return failed;
}

/**
 * Checks one item. It's ready only when every engine rule holds, every dor.md criterion passed and the judge raised
 * no flag. A not-ready item gets one comment naming each failed line in the repo's own words, keyed so a re-gate
 * after any readiness input changes posts a fresh one. The gate never edits the item.
 */
export async function gate(item: FactoryItem, ctx: GateContext): Promise<{ ready: boolean; results: Verdict[] }> {
  let results = engineRules(item, ctx);
  if (results.length === 0 && ctx.dor) {
    const dor = ctx.dor;
    const reply = await ctx.judge(item, dor);
    const flagsLine = jsonLines(reply).find((o) => Array.isArray(o.flags));
    if (!flagsLine) {
      results = dor.criteria.map((c) => ({ index: c.index, criterion: c.text, status: "failed", reason: "readiness check output unreadable" }));
    } else {
      const flags = (flagsLine.flags as unknown[]).map(String);
      results = [...parseJudgement(reply, dor), ...flags.map((f) => ({ ...engine(`The item text ${f}`), criterion: "readiness flag" }))];
    }
  }
  const failed = results.filter((r) => r.status !== "passed");
  if (failed.length > 0) {
    const lines = failed.map((r) => (r.index > 0 ? `- ${r.criterion}\n  ${r.reason}` : `- ${r.reason}`));
    const body = `The factory can't start this item yet. It failed these readiness checks:\n\n${lines.join("\n")}\n`;
    await ctx.adapter.comment(item.externalId, body, `readiness:${item.updatedAt}:${ctx.readinessSha}`);
  }
  return { ready: failed.length === 0, results };
}
