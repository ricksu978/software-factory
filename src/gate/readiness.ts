// The readiness gate (plan Task 9): the engine's own rules first, then the judge on every dor.md line.
import type { BacklogAdapter, FactoryItem } from "../adapters/types.ts";
import type { AgentArgs, AgentResult, JudgeSpend } from "../agent/run.ts";
import type { ReadinessCheck, ReadinessCheckKind } from "../store/readiness-checks.ts";
import { jsonLines, parseJudgement, type Policy, type Verdict } from "../policy/policy.ts";
import { fileSplit, priorFiling } from "./file-split.ts";
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
  /** Records each judge or split call's spend for the item, even when the call failed (PBI 132). */
  recordCheck?: (item: FactoryItem, check: ReadinessCheck) => Promise<void>;
  /** When a judge or split call runs. Defaults to the wall clock. */
  now?: () => Date;
  adapter: BacklogAdapter;
  /** Each PolicyError the caller hit loading the five policy files, such as a run: line outside dod.md. */
  policyErrors?: string[];
  /** How to ask for a split of an oversized item (PBI 143). */
  split?: SplitDeps;
  /** Where a readiness check that couldn't be recorded is reported. Defaults to console.error. */
  log?: (line: string) => void;
};

/**
 * `oversized` is the judge's reading of the item's size, false when its last line doesn't say true. `split` is null
 * when the item isn't oversized or the judge was never asked. `filed` is true when the split was filed as child issues
 * (PBI 144), which leaves the item not ready whatever its verdicts.
 */
export type GateResult = { ready: boolean; results: Verdict[]; oversized?: boolean; split?: SplitOutcome | null; filed?: boolean };

const engine = (reason: string): Verdict => ({ index: 0, criterion: "engine rule", status: "failed", reason });

/**
 * The rules no policy file can weaken (spec §6). Any failure here means the judge is never asked.
 * Raise READINESS_VERSION in src/policy/policy.ts whenever these rules change (PBI 149).
 */
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
 * Makes one AI call for the gate, then records what it spent as a readiness check of `kind`, whether it answered or
 * threw (PBI 132). A call that reports no spend records nothing. A check that can't be recorded is logged, so the
 * call's own reply or error is what comes out: a reply isn't thrown away and paid for again on the next poll, and a
 * usage limit still reads as a usage limit.
 */
async function recorded<T>(item: FactoryItem, ctx: GateContext, kind: ReadinessCheckKind, call: (spent: (s: JudgeSpend) => void) => Promise<T>): Promise<T> {
  const ranAt = (ctx.now ?? (() => new Date()))();
  let spend: JudgeSpend | null = null;
  try {
    return await call((s) => { spend = s; });
  } finally {
    if (spend && ctx.recordCheck) {
      try {
        await ctx.recordCheck(item, { ...(spend as JudgeSpend), kind, ranAt });
      } catch (e) {
        (ctx.log ?? console.error)(`readiness: couldn't record the ${kind} call's cost for item ${item.externalId}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
}

/** Asks for a split through `recorded`, so the coding model's call is a `split` readiness check. A cached split asks nothing. */
function recordedSplit(item: FactoryItem, ctx: GateContext, deps: SplitDeps): Promise<SplitOutcome> {
  return recorded(item, ctx, "split", (spent) => proposeSplit(item, {
    ...deps,
    agent: async (a: AgentArgs): Promise<AgentResult> => {
      let r: AgentResult;
      try {
        r = await deps.agent(a);
      } catch (e) {
        // A run that throws never started, so it spent nothing, and says so.
        spent({ model: a.model, tokensIn: 0, tokensOut: 0, costUsd: 0 });
        throw e;
      }
      spent({ model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut, costUsd: r.costUsd });
      return r;
    },
  }));
}

/**
 * Checks one item. It's ready only when every engine rule holds, every dor.md criterion passed and the judge raised
 * no flag. A not-ready item gets one comment naming each failed line in the repo's own words, keyed so a re-gate
 * after any readiness input changes posts a fresh one. The gate never edits the item, except that filing a split takes
 * the parent's opt-in label off once its children are filed (PBI 144).
 */
export async function gate(item: FactoryItem, ctx: GateContext): Promise<GateResult> {
  let results = engineRules(item, ctx);
  let oversized = false;
  if (results.length === 0 && ctx.dor) {
    const dor = ctx.dor;
    const reply = await recorded(item, ctx, "judge", (spent) => ctx.judge(item, dor, spent));
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
  const split = oversized && ctx.split ? await recordedSplit(item, ctx, ctx.split) : null;
  // PBI 144: a valid split is filed as child issues, unless the parent is already split another way (by hand, or from
  // an earlier text's split). That's read first, so the proposal comment only says the factory files the children
  // when it will. A failed write throws, so the poller gates the parent again.
  const file = split?.proposed ? ctx.split?.file : undefined;
  const prior = split?.proposed && file ? await priorFiling(item, split.children, file.board) : null;
  if (split?.proposed) await ctx.adapter.comment(item.externalId, splitComment(item, split.children, !!prior), `split:${itemTextHash(item)}`);
  // A parent whose split is filed has left the factory, so it's never ready and gets no readiness comment.
  const filed = split?.proposed && file && prior ? await fileSplit(item, split.children, ctx.adapter, file, prior) : false;
  if (filed) return { ready: false, results, oversized, split, filed };
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
