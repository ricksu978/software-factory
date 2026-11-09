// The readiness gate (plan Task 9): the engine's own rules first, then the judge on every dor.md line.
import type { BacklogAdapter, FactoryItem } from "../adapters/types.ts";
import type { JudgeSpend } from "../agent/run.ts";
import type { ReadinessCheck } from "../store/readiness-checks.ts";
import { jsonLines, parseJudgement, type Policy, type Verdict } from "../policy/policy.ts";
import { itemTextHash, proposeSplit, splitComment, splitUnanswered, type SplitDeps, type SplitOutcome } from "./split.ts";

export type GateContext = {
  readinessSha: string;
  /** Null when the repo is unknown. */
  dor: Policy | null;
  dodExists: boolean;
  configValid: boolean;
  repoKnown: boolean;
  openDeps: string[];
  /** `spent` hears what the call cost, whether it answers or throws (PBI 132). */
  judge: (item: FactoryItem, dor: Policy, spent?: (s: JudgeSpend) => void) => Promise<string>;
  /** Records each judge call's spend for the item, even when the call failed (PBI 132). */
  recordCheck?: (item: FactoryItem, check: ReadinessCheck) => Promise<void>;
  /** When a judge call runs. Defaults to the wall clock. */
  now?: () => Date;
  adapter: BacklogAdapter;
  /** Each PolicyError the caller hit loading the five policy files, such as a run: line outside dod.md. */
  policyErrors?: string[];
  /** How to ask for a split of an oversized item (PBI 143). */
  split?: SplitDeps;
};

/**
 * `oversized` is the judge's reading of the item's size, false when its last line doesn't say true. `split` is null
 * when the item isn't oversized or the judge was never asked.
 */
export type GateResult = { ready: boolean; results: Verdict[]; oversized?: boolean; split?: SplitOutcome | null };

const engine = (reason: string): Verdict => ({ index: 0, criterion: "engine rule", status: "failed", reason });

/** The rules no policy file can weaken (spec §6). Any failure here means the judge is never asked. */
function engineRules(item: FactoryItem, ctx: GateContext): Verdict[] {
  const failed: Verdict[] = [];
  const policyErrors = ctx.policyErrors ?? [];
  if (!ctx.repoKnown) failed.push(engine("The factory doesn't know this item's repo"));
  for (const e of policyErrors) failed.push(engine(e));
  if (ctx.repoKnown && !ctx.dor && policyErrors.length === 0) failed.push(engine("dor.md couldn't be loaded"));
  if (!ctx.dodExists) failed.push(engine("No .factory/dod.md in this repo"));
  if (!ctx.configValid) failed.push(engine("No valid .factory/config.yml in this repo"));
  if (item.acceptanceCriteria.length === 0) failed.push(engine("The item has no acceptance criteria"));
  for (const dep of ctx.openDeps) failed.push(engine(`The item depends on ${dep}, which is still open`));
  return failed;
}

/**
 * Asks the judge, then records what the call spent as a readiness check, whether it answered or threw (PBI 132). A
 * judge that reports no spend records nothing.
 */
async function judged(item: FactoryItem, dor: Policy, ctx: GateContext): Promise<string> {
  const ranAt = (ctx.now ?? (() => new Date()))();
  let spend: JudgeSpend | null = null;
  try {
    return await ctx.judge(item, dor, (s) => { spend = s; });
  } finally {
    if (spend && ctx.recordCheck) await ctx.recordCheck(item, { ...(spend as JudgeSpend), ranAt });
  }
}

/**
 * Checks one item. It's ready only when every engine rule holds, every dor.md criterion passed and the judge raised
 * no flag. A not-ready item gets one comment naming each failed line in the repo's own words, keyed so a re-gate
 * after any readiness input changes posts a fresh one. The gate never edits the item.
 */
export async function gate(item: FactoryItem, ctx: GateContext): Promise<GateResult> {
  let results = engineRules(item, ctx);
  let oversized = false;
  if (results.length === 0 && ctx.dor) {
    const dor = ctx.dor;
    const reply = await judged(item, dor, ctx);
    // Every flags line counts, so an early or echoed {"flags":[]} can't cancel a real flag later in the reply.
    const flagLines = jsonLines(reply).filter((o) => Array.isArray(o.flags));
    if (flagLines.length === 0) {
      // The engine verdict fails the item even when dor.md has no criteria, so the flag check can't be skipped.
      results = [
        engine("readiness check output unreadable"),
        ...dor.criteria.map((c): Verdict => ({ index: c.index, criterion: c.text, status: "failed", reason: "readiness check output unreadable" })),
      ];
    } else {
      const flags = [...new Set(flagLines.flatMap((o) => (o.flags as unknown[]).map(String)))];
      // Only a literal true on the last flags line counts. Size never becomes a verdict, so it can't fail the item.
      oversized = flagLines.at(-1)!.oversized === true;
      results = [...parseJudgement(reply, dor), ...flags.map((f) => ({ ...engine(`The item text ${f}`), criterion: "readiness flag" }))];
    }
  }
  // PBI 143: an oversized item gets a proposed split, posted as its own comment, once per item text.
  const split = oversized && ctx.split ? await proposeSplit(item, ctx.split) : null;
  if (split?.proposed) await ctx.adapter.comment(item.externalId, splitComment(item, split.children), `split:${itemTextHash(item)}`);
  const failed = results.filter((r) => r.status !== "passed");
  if (failed.length > 0) {
    const lines = failed.map((r) => (r.index > 0 ? `- ${r.criterion}\n  ${r.reason}` : `- ${r.reason}`));
    const noSplit = split && !split.proposed ? `\nThe judge found the item too big for one Sprint, but a split couldn't be proposed because ${split.reason}.\n` : "";
    const body = `The factory can't start this item yet. It failed these readiness checks:\n\n${lines.join("\n")}\n${noSplit}`;
    // A comment that says the coding model gave no answer is keyed on the item text, not updatedAt: the poller keeps
    // that item Eligible and gates it again, and the comment itself bumps updatedAt on GitHub, so an updatedAt key
    // would post it again on every poll. Its own key also lets the re-gate that gets an answer post a readiness
    // comment without that line instead of being deduplicated against it.
    const key = splitUnanswered(split)
      ? `readiness:split-unanswered:${itemTextHash(item)}:${ctx.readinessSha}`
      : `readiness:${item.updatedAt}:${ctx.readinessSha}`;
    await ctx.adapter.comment(item.externalId, body, key);
  }
  return { ready: failed.length === 0, results, oversized, split };
}
