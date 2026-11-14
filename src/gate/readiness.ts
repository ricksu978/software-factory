// The readiness gate (plan Task 9): the engine's own rules first, then the judge on every dor.md line.
import type { BacklogAdapter, FactoryItem } from "../adapters/types.ts";
import type { AgentArgs, AgentResult, JudgeSpend } from "../agent/run.ts";
import type { ReadinessCheck, ReadinessCheckKind } from "../store/readiness-checks.ts";
import { jsonLines, parseJudgement, type Policy, type Verdict } from "../policy/policy.ts";
import { tmpdir } from "node:os";
import { childBody, fileSplit, priorFiling } from "./file-split.ts";
import { keepingCriteria, leadOf, mayRewrite, missingPermission, ownerAction, ownerOnly, readRewrite, rewritePrompt } from "./repair.ts";
import { itemTextHash, proposeSplit, splitComment, splitKey, splitUnanswered, type SplitChild, type SplitDeps, type SplitOutcome } from "./split.ts";

export type GateContext = {
  readinessSha: string;
  /** Null when the repo is unknown. */
  dor: Policy | null;
  dodExists: boolean;
  configValid: boolean;
  repoKnown: boolean;
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
  /**
   * Where the split being filed is kept (PBI 144). `get` reads the split kept for the item's text, or null. `keep` keeps
   * one unless a split is kept already, and returns the kept one. The gate keeps a split before it files any child and
   * reads it back before asking the coding model again, so a filing that stopped partway is finished after a restart
   * with the children it started with.
   */
  splits?: { get: (item: FactoryItem) => Promise<SplitChild[] | null>; keep: (item: FactoryItem, children: SplitChild[]) => Promise<SplitChild[]> };
  /**
   * Each permission the factory's App needs on the item's repo and hasn't been granted, by GitHub's name, such as
   * "issues: write" (PBI 264). Only the owner can grant one, so each is an engine rule failure the factory never
   * rewrites, and the readiness comment says what the owner has to do.
   */
  missingPermissions?: string[];
  /** Where a readiness check that couldn't be recorded is reported. Defaults to console.error. */
  log?: (line: string) => void;
};

/**
 * `oversized` is the judge's reading of the item's size, false when its last line doesn't say true. `split` is null
 * when the item isn't oversized or the judge was never asked. `filed` is true when the split was filed as child issues
 * (PBI 144), which leaves the item not ready whatever its verdicts.
 */
export type GateResult = {
  ready: boolean; results: Verdict[]; oversized?: boolean; split?: SplitOutcome | null; filed?: boolean;
  /** The item as it was last gated, when the gate rewrote its body and gated it again (PBI 264). */
  item?: FactoryItem;
};

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
  for (const p of ctx.missingPermissions ?? []) failed.push(missingPermission(p));
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

/** `agent`, telling `spent` what each run cost. */
function spending(agent: SplitDeps["agent"], spent: (s: JudgeSpend) => void): SplitDeps["agent"] {
  return async (a: AgentArgs): Promise<AgentResult> => {
    let r: AgentResult;
    try {
      r = await agent(a);
    } catch (e) {
      // A run that throws never started, so it spent nothing, and says so.
      spent({ model: a.model, tokensIn: 0, tokensOut: 0, costUsd: 0 });
      throw e;
    }
    spent({ model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut, costUsd: r.costUsd });
    return r;
  };
}

/** Asks for a split through `recorded`, so the coding model's call is a `split` readiness check. A cached split asks nothing. */
function recordedSplit(item: FactoryItem, ctx: GateContext, deps: SplitDeps): Promise<SplitOutcome> {
  return recorded(item, ctx, "split", (spent) => proposeSplit(item, { ...deps, agent: spending(deps.agent, spent) }, ctx.dor ?? undefined));
}

/**
 * The judge's verdicts on `subject` against `dor`, with its reading of the subject's size. The call is recorded as a
 * `judge` check against `owner`, the item whose row pays for it: the subject itself, or the parent of a proposed child.
 */
async function judgement(subject: FactoryItem, owner: FactoryItem, dor: Policy, ctx: GateContext): Promise<{ results: Verdict[]; oversized: boolean }> {
  const reply = await recorded(owner, ctx, "judge", (spent) => ctx.judge(subject, dor, spent));
  // Every flags line counts, so an early or echoed {"flags":[]} can't cancel a real flag later in the reply.
  const flagLines = jsonLines(reply).filter((o) => Array.isArray(o.flags));
  if (flagLines.length === 0) {
    // The engine verdict fails the item even when dor.md has no criteria, so the flag check can't be skipped.
    return {
      results: [
        engine("readiness check output unreadable"),
        ...dor.criteria.map((c): Verdict => ({ index: c.index, criterion: c.text, status: "failed", reason: "readiness check output unreadable" })),
      ],
      oversized: false,
    };
  }
  const flags = [...new Set(flagLines.flatMap((o) => (o.flags as unknown[]).map(String)))];
  // Only a literal true on the last flags line counts. Size never becomes a verdict, so it can't fail the item.
  return {
    results: [...parseJudgement(reply, dor), ...flags.map((f) => ({ ...engine(`The item text ${f}`), criterion: "readiness flag" }))],
    oversized: flagLines.at(-1)!.oversized === true,
  };
}

const REWRITE_TIMEOUT_MS = 120_000;

/**
 * Asks the SOP's coding model, with no tool, for one rewrite of `subject`'s body given the lines it failed (PBI 264),
 * recorded as a `split` check against `owner`. Returns the new body, or null when the reply carries none. A failed or
 * thrown run throws, so the poller leaves the item Eligible and the next poll asks again.
 */
async function rewrite(subject: FactoryItem, owner: FactoryItem, failed: Verdict[], dor: Policy, ctx: GateContext, deps: SplitDeps): Promise<string | null> {
  const r = await recorded(owner, ctx, "split", (spent) => spending(deps.agent, spent)({
    prompt: rewritePrompt(subject, dor, failed), model: deps.sop.models.coding, cwd: tmpdir(), maxTurns: 1, mode: "judge",
    signal: AbortSignal.timeout(REWRITE_TIMEOUT_MS),
  }));
  if (!r.ok) throw new Error(`the coding model gave no answer for the rewrite of "${subject.title}"`);
  return readRewrite(r.text);
}

/** Each failed verdict as the readiness and proposal comments list it, with what the owner has to do when only they can. */
function failedLines(failed: Verdict[]): string {
  return failed.map((r) => {
    if (r.index > 0) return `- ${r.criterion}\n  ${r.reason}`;
    return ownerOnly(r) ? `- ${r.reason}\n  ${ownerAction(r)}` : `- ${r.reason}`;
  }).join("\n");
}

/** A dor.md failure the coding model can fix by rewriting the body: a failed line, and no engine rule or flag beside it. */
const rewritable = (failed: Verdict[]) => failed.length > 0 && failed.every((v) => v.index > 0);

/**
 * Judges each proposed child against the parent's dor.md before the split is filed (PBI 264), as the issue it would
 * be filed as. A child that fails only dor.md lines gets one rewrite of its body, given the judge's reasons, and is
 * judged again. Returns the children, rewritten where they were, and for each one that still fails, its failed lines.
 */
async function checkChildren(parent: FactoryItem, children: SplitChild[], dor: Policy, ctx: GateContext, deps: SplitDeps, heading: string):
  Promise<{ children: SplitChild[]; failing: (Verdict[] | undefined)[] }> {
  const out: SplitChild[] = [];
  const failing: (Verdict[] | undefined)[] = [];
  const asFiled = (ch: SplitChild, n: number): FactoryItem => ({
    ...parent, externalId: `${parent.externalId}/split-${n}`, title: ch.title, body: childBody(parent, ch, n, heading),
    acceptanceCriteria: ch.criteria.map((c) => parent.acceptanceCriteria[c - 1]), labels: [], fields: {},
  });
  const failedOf = async (ch: SplitChild, n: number) => (await judgement(asFiled(ch, n), parent, dor, ctx)).results.filter((r) => r.status !== "passed");
  for (const [i, child] of children.entries()) {
    let ch = child;
    let failed = await failedOf(ch, i + 1);
    if (rewritable(failed)) {
      const body = await rewrite({ ...asFiled(ch, i + 1), body: ch.body }, parent, failed, dor, ctx, deps);
      if (body !== null) {
        ch = { ...ch, body };
        failed = await failedOf(ch, i + 1);
      }
    }
    out.push(ch);
    failing.push(failed.length > 0 ? failed : undefined);
  }
  return { children: out, failing };
}

/**
 * Rewrites a filed child that failed dor.md lines once (PBI 264), keeping its criteria section and the line saying
 * where it came from word for word, and returns it as edited. Null when the factory may not edit it: the board can't
 * say who wrote it, it isn't an issue the App opened with a split marker and nobody has edited since, an engine rule
 * or flag failed beside the lines, or the coding model's reply carries no body.
 */
async function repairChild(item: FactoryItem, failed: Verdict[], ctx: GateContext): Promise<FactoryItem | null> {
  const deps = ctx.split;
  const board = deps?.file?.board;
  if (!deps || !board?.authorship || !board.editBody || !ctx.dor || !rewritable(failed)) return null;
  if (!mayRewrite(item, await board.authorship(item.externalId))) return null;
  const heading = deps.file!.criteriaHeading;
  const text = await rewrite({ ...item, body: leadOf(item.body, heading) }, item, failed, ctx.dor, ctx, deps);
  const body = text === null ? null : keepingCriteria(item.body, text, heading);
  if (body === null) return null;
  await board.editBody(item.externalId, body);
  const fresh = await ctx.adapter.getItem(item.externalId);
  return fresh && fresh.body === body ? fresh : { ...item, body };
}

/**
 * Checks one item. It's ready only when every engine rule holds, every dor.md criterion passed and the judge raised
 * no flag. A not-ready item gets one comment naming each failed line in the repo's own words, keyed so a re-gate
 * after any readiness input changes posts a fresh one. The gate never edits the item, except that filing a split takes
 * the parent's opt-in label off once its children are filed (PBI 144).
 */
export function gate(item: FactoryItem, ctx: GateContext): Promise<GateResult> {
  return gateOnce(item, ctx, true);
}

async function gateOnce(item: FactoryItem, ctx: GateContext, mayRepair: boolean): Promise<GateResult> {
  let results = engineRules(item, ctx);
  let oversized = false;
  if (results.length === 0 && ctx.dor) ({ results, oversized } = await judgement(item, item, ctx.dor, ctx));
  // PBI 143: an oversized item gets a proposed split, posted as its own comment, once per item text and split prompt.
  // PBI 144: when splits are filed, a split already kept for this text is the one filed, so the coding model isn't
  // asked again and a filing that stopped partway is finished with the same children, after a restart too. A kept
  // split means filing started for this text, so it's read whatever this judge says: a judge that now answers not
  // oversized, an unreadable reply, or an engine rule that kept the judge from being asked still finishes the filing.
  const filing = !!ctx.split?.file;
  const kept = filing && ctx.splits ? await ctx.splits.get(item) : null;
  let split: SplitOutcome | null = kept ? { proposed: true, children: kept } : oversized && ctx.split ? await recordedSplit(item, ctx, ctx.split) : null;
  // PBI 264: before a new split is kept or filed, the judge checks each child against the same dor.md, and a failing
  // child gets one rewrite. A child that still fails files no child of the split, and the proposal says why. A kept
  // split passed this check before it was kept.
  let failing: (Verdict[] | undefined)[] = [];
  if (split?.proposed && filing && !kept && ctx.dor) {
    ({ children: split.children, failing } = await checkChildren(item, split.children, ctx.dor, ctx, ctx.split!, ctx.split!.file!.criteriaHeading));
  }
  const blocked = failing.some((f) => f !== undefined);
  // A valid split is kept before any child is filed. When another gate kept one first, that one is filed instead.
  if (split?.proposed && filing && ctx.splits && !kept && !blocked) split = { proposed: true, children: await ctx.splits.keep(item, split.children) };
  // A valid split is filed as child issues, unless the parent is already split another way (by hand, or from an
  // earlier text's split). That's read first, so the proposal comment only says the factory files the children when
  // it will. A failed write throws, so the poller gates the parent again.
  const file = split?.proposed && !blocked ? ctx.split?.file : undefined;
  const prior = split?.proposed && file ? await priorFiling(item, split.children, file.board) : null;
  // PBI 159: the key holds the split prompt too, so a new prompt posts one fresh proposal for the same text. A split
  // that's saved for filing is never replaced, so a new prompt can't change it: its proposal is keyed on the item text
  // alone, from the first gate that saves it, and a new prompt doesn't post the same children again.
  const saved = filing && !!ctx.splits;
  const proposalKey = saved ? `split:${itemTextHash(item)}` : ctx.split ? `split:${splitKey(item, ctx.split)}` : null;
  // A blocked split's proposal has its own key, per policy, so a later gate whose children pass posts the filing one.
  if (split?.proposed && proposalKey) {
    const notes = failing.map((f) => f && `This child fails the team's Definition of Ready, so no child of this split is filed:\n${failedLines(f)}`);
    await ctx.adapter.comment(item.externalId, splitComment(item, split.children, !!prior, blocked ? notes : undefined),
      blocked ? `${proposalKey}:unfiled:${ctx.readinessSha}` : proposalKey);
  }
  // A parent whose split is filed has left the factory, so it's never ready and gets no readiness comment.
  const filed = split?.proposed && file && prior ? await fileSplit(item, split.children, ctx.adapter, file, prior) : false;
  if (filed) return { ready: false, results, oversized, split, filed };
  const failed = results.filter((r) => r.status !== "passed");
  // PBI 264: a child the factory filed that fails dor.md lines is rewritten once and gated again, its result standing.
  if (mayRepair && failed.length > 0 && !split?.proposed) {
    const edited = await repairChild(item, failed, ctx);
    if (edited) return { ...(await gateOnce(edited, ctx, false)), item: edited };
  }
  if (failed.length > 0) {
    const lines = failedLines(failed);
    const noSplit = split && !split.proposed ? `\nThe judge found the item too big for one Sprint, but a split couldn't be proposed because ${split.reason}.\n` : "";
    const body = `The factory can't start this item yet. It failed these readiness checks:\n\n${lines}\n${noSplit}`;
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
