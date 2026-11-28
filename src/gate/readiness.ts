// The readiness gate (plan Task 9): the engine's own rules first, then the judge on every dor.md line.
import type { BacklogAdapter, FactoryItem } from "../adapters/types.ts";
import type { AgentArgs, AgentResult, JudgeSpend } from "../agent/run.ts";
import type { CheckVerdict, ReadinessCheck, ReadinessCheckKind } from "../store/readiness-checks.ts";
import { jsonLines, parseJudgement, type Policy, type Verdict } from "../policy/policy.ts";
import { tmpdir } from "node:os";
import { childBody, factoryFiled, fileSplit, priorFiling, type ChildIssue } from "./file-split.ts";
import { keepingCriteria, leadOf, mayRewrite, missingPermission, ownerAction, ownerOnly, readRewrite, rewritePrompt } from "./repair.ts";
import { checkRuleChanges, judgedRules, parseRuleChanges, placeKey, placeName, ruleChangesHash, RULES_HEADING, type RuleChangeRead } from "./rule-changes.ts";
import { APPROVAL_CRITERION } from "../store/rule-changes.ts";
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
  /**
   * Reads a file of the factory's own repo on `main`, or null when it isn't there (PBI 395), so each rule an item's
   * "Changes the factory's rules" section changes has its Before held to the rule's text on `main`. Without it, no
   * Before can be checked, and an entry that gives one fails.
   */
  factoryRules?: (path: string) => Promise<string | null>;
  /** The hash of the rule changes the owner last approved on the item, or null when none were (PBI 395). */
  ruleApproval?: string | null;
};

/**
 * `oversized` is the judge's reading of the item's size, false when its last line doesn't say true. `split` is null
 * when the item isn't oversized or the judge was never asked. `filed` is true when the split was filed as child issues
 * (PBI 144), which leaves the item not ready whatever its verdicts. `children` are then the issues it filed, in the order
 * of the split (PBI 227).
 */
export type GateResult = {
  ready: boolean; results: Verdict[]; oversized?: boolean; split?: SplitOutcome | null; filed?: boolean; children?: ChildIssue[];
  /** The item as it was last gated, when the gate rewrote its body and gated it again (PBI 264). */
  item?: FactoryItem;
  /** What the gate read from the item's "Changes the factory's rules" section, each entry with what's wrong with it (PBI 395). */
  ruleChanges?: RuleChangeRead[];
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
 * What a judge call records beside its spend (PBI 348): `verdict` reads what the call decided from what it returned,
 * and a call that threw records an error verdict. `child` is the title of the proposed child judged for its parent.
 */
type Judged<T> = { verdict: (r: T) => CheckVerdict; child?: string };

/**
 * Makes one AI call for the gate, then records what it spent as a readiness check of `kind`, whether it answered or
 * threw (PBI 132), with its verdict when `judged` says how to read one (PBI 348). A call that reports no spend records
 * nothing. A check that can't be recorded is logged, so the call's own reply or error is what comes out: a reply isn't
 * thrown away and paid for again on the next poll, and a usage limit still reads as a usage limit.
 */
async function recorded<T>(item: FactoryItem, ctx: GateContext, kind: ReadinessCheckKind, call: (spent: (s: JudgeSpend) => void) => Promise<T>,
  judged?: Judged<T>): Promise<T> {
  const ranAt = (ctx.now ?? (() => new Date()))();
  let spend: JudgeSpend | null = null;
  let verdict: CheckVerdict | undefined = judged ? { outcome: "error" } : undefined;
  try {
    const r = await call((s) => { spend = s; });
    if (judged) verdict = judged.verdict(r);
    return r;
  } finally {
    if (spend && ctx.recordCheck) {
      const check: ReadinessCheck = { ...(spend as JudgeSpend), kind, ranAt };
      if (verdict) check.verdict = verdict;
      if (judged?.child !== undefined) check.child = judged.child;
      try {
        await ctx.recordCheck(item, check);
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
      spent({ model: a.model, effort: a.effort, tokensIn: 0, tokensOut: 0, costUsd: 0 });
      throw e;
    }
    spent({ model: r.model, effort: a.effort, tokensIn: r.tokensIn, tokensOut: r.tokensOut, costUsd: r.costUsd });
    return r;
  };
}

/** Asks for a split through `recorded`, so the coding model's call is a `split` readiness check. A cached split asks nothing. */
function recordedSplit(item: FactoryItem, ctx: GateContext, deps: SplitDeps): Promise<SplitOutcome> {
  return recorded(item, ctx, "split", (spent) => proposeSplit(item, { ...deps, agent: spending(deps.agent, spent) }, ctx.dor ?? undefined));
}

/** `rules` is each factory rule the judge finds the item changes, as "§N" or a policy file's path (PBI 395). */
type Judgement = { results: Verdict[]; oversized: boolean; rules: string[]; verdict: CheckVerdict };

/** Reads the judge's reply on `dor`: its verdicts, its reading of the subject's size, and the call's verdict as recorded. */
function readJudgement(reply: string, dor: Policy): Judgement {
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
      rules: [],
      verdict: { outcome: "unreadable" },
    };
  }
  const flags = [...new Set(flagLines.flatMap((o) => (o.flags as unknown[]).map(String)))];
  const lines = parseJudgement(reply, dor);
  const failed = lines.filter((r) => r.status !== "passed").map((r) => ({ criterion: r.criterion, reason: r.reason }));
  // Only a literal true on the last flags line counts. Size never becomes a verdict, so it can't fail the item.
  return {
    results: [...lines, ...flags.map((f) => ({ ...engine(`The item text ${f}`), criterion: "readiness flag" }))],
    oversized: flagLines.at(-1)!.oversized === true,
    rules: judgedRules(flagLines.at(-1)!.rules),
    verdict: failed.length === 0 && flags.length === 0 ? { outcome: "passed" } : { outcome: "failed", lines: failed, flags },
  };
}

/**
 * The judge's verdicts on `subject` against `dor`, with its reading of the subject's size. The call is recorded as a
 * `judge` check against `owner`, the item whose row pays for it: the subject itself, or the parent of a proposed child,
 * whose check then names the child (PBI 348).
 */
async function judgement(subject: FactoryItem, owner: FactoryItem, dor: Policy, ctx: GateContext): Promise<{ results: Verdict[]; oversized: boolean; rules: string[]; readable: boolean }> {
  const { results, oversized, rules, verdict } = await recorded(owner, ctx, "judge", async (spent) => readJudgement(await ctx.judge(subject, dor, spent), dor),
    { verdict: (j) => j.verdict, child: subject === owner ? undefined : subject.title });
  return { results, oversized, rules, readable: verdict.outcome !== "unreadable" };
}

/** The dor.md line about the factory's own rules, as the repo words it: the one that names "the factory's rules". */
const RULES_LINE = /factory['’]s\s+(own\s+)?rules/i;

const names = (places: string[]) => (places.length <= 1 ? places.join("") : `${places.slice(0, -1).join(", ")} and ${places.at(-1)}`);
const named = (key: string) => (key.startsWith("§") ? `spec section ${key}` : key);

/**
 * PBI 395: the item's "Changes the factory's rules" section, held to `main` and to what the judge found. An entry that
 * gives no Before or no After, or whose Before isn't on `main` word for word, fails the item, naming its section. A rule
 * the judge finds that the section doesn't cover fails dor.md's rules line, its finding naming each place the section
 * should cover, or fails on its own when dor.md has no such line. When every entry holds and the section covers every
 * rule the judge finds, the engine passes the rules line whatever the judge said of it (PBI 414), as long as the judge's
 * reply was `readable`: an unreadable one named no rules, so the line keeps its unreadable failure. When nothing else
 * failed, a section the owner hasn't approved as it reads now leaves the item waiting for that approval.
 */
async function ruleVerdicts(item: FactoryItem, ctx: GateContext, judged: Verdict[], found: string[], readable: boolean): Promise<{ results: Verdict[]; changes: RuleChangeRead[]; approved: boolean }> {
  const changes = await checkRuleChanges(parseRuleChanges(item.body), ctx.factoryRules);
  const results = judged.map((r) => ({ ...r }));
  for (const c of changes) if (c.problem) results.push({ ...engine(c.problem), criterion: "rule change" });
  const covered = new Set(changes.map((c) => placeKey(c.place)));
  const missing = found.filter((f) => !covered.has(f));
  if (missing.length > 0) {
    const cover = `The item changes ${names(missing.map(named))}, so its "${RULES_HEADING.slice(3)}" section has to cover ${missing.length === 1 ? "it" : "each"}, quoting the rule's text on main as Before and giving its After.`;
    const line = results.find((r) => r.index > 0 && RULES_LINE.test(r.criterion));
    if (line) {
      line.reason = line.status === "passed" ? cover : `${line.reason} ${cover}`;
      line.status = "failed";
    } else results.push({ ...engine(cover), criterion: "rule change" });
  } else if (readable && changes.length > 0 && changes.every((c) => !c.problem)) {
    // PBI 414: for an item with the section, the engine alone decides the rules line once every entry holds against
    // main and the section covers every rule the judge found, whatever verdict the judge gave it. A judge that reads
    // the line as "the owner hasn't approved this yet" would otherwise fail the item instead of leaving it to wait.
    const line = results.find((r) => r.index > 0 && RULES_LINE.test(r.criterion));
    if (line) {
      line.status = "passed";
      line.reason = `The engine held each entry's Before to main and found it there word for word, and the item's "${RULES_HEADING.slice(3)}" section covers every rule the judge named.`;
    }
  }
  const approved = changes.length > 0 && ctx.ruleApproval === ruleChangesHash(changes);
  if (changes.length > 0 && !approved && results.every((r) => r.status === "passed")) {
    results.push({
      ...engine(`The item waits for the owner to approve its change to ${names(changes.map((c) => placeName(c.place)))}. The owner approves it on the item's page in the factory's dashboard.`),
      criterion: APPROVAL_CRITERION,
    });
  }
  return { results, changes, approved };
}

const REWRITE_TIMEOUT_MS = 120_000;

/**
 * Asks the SOP's coding model, with no tool, for one rewrite of `subject`'s body given the lines it failed (PBI 264),
 * recorded as a `split` check against `owner`. Returns the new body, or null when the reply carries none. A failed or
 * thrown run throws, so the poller leaves the item Eligible and the next poll asks again.
 */
async function rewrite(subject: FactoryItem, owner: FactoryItem, failed: Verdict[], dor: Policy, ctx: GateContext, deps: SplitDeps): Promise<string | null> {
  const effort = await deps.effort();
  const r = await recorded(owner, ctx, "split", (spent) => spending(deps.agent, spent)({
    prompt: rewritePrompt(subject, dor, failed), model: deps.sop.models.coding, effort, cwd: tmpdir(), maxTurns: 1, mode: "judge",
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
  // The marker is read first, so an item a person filed costs no board lookup.
  if (!factoryFiled(item)) return null;
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
 * the parent's opt-in label off once its children are filed (PBI 144), and a filed child that fails dor.md lines has
 * its body rewritten once (PBI 264).
 */
export function gate(item: FactoryItem, ctx: GateContext): Promise<GateResult> {
  return gateOnce(item, ctx, true);
}

async function gateOnce(item: FactoryItem, ctx: GateContext, mayRepair: boolean): Promise<GateResult> {
  let results = engineRules(item, ctx);
  let oversized = false;
  let ruleChanges: RuleChangeRead[] = [];
  let rulesApproved = false;
  if (results.length === 0 && ctx.dor) {
    let found: string[];
    let readable: boolean;
    ({ results, oversized, rules: found, readable } = await judgement(item, item, ctx.dor, ctx));
    ({ results, changes: ruleChanges, approved: rulesApproved } = await ruleVerdicts(item, ctx, results, found, readable));
  } else ruleChanges = await checkRuleChanges(parseRuleChanges(item.body), ctx.factoryRules);
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
  const children = split?.proposed && file && prior ? await fileSplit(item, split.children, ctx.adapter, file, prior) : null;
  if (children) return { ready: false, results, oversized, split, filed: true, children, ruleChanges };
  const failed = results.filter((r) => r.status !== "passed");
  // PBI 264: a child the factory filed that fails dor.md lines is rewritten once and gated again, its result standing.
  if (mayRepair && failed.length > 0 && !split?.proposed) {
    const edited = await repairChild(item, failed, ctx);
    if (edited) return { ...(await gateOnce(edited, ctx, false)), item: edited };
  }
  if (failed.length > 0) {
    const lines = failedLines(failed);
    const noSplit = split && !split.proposed ? `\nThe judge found the item too big for one Sprint, but a split couldn't be proposed because ${split.reason}.\n` : "";
    // An item that waits only for the owner's approval of its rule changes passed every check (PBI 395).
    const waitsOnly = failed.every((r) => r.criterion === APPROVAL_CRITERION);
    const body = waitsOnly
      ? `The factory can't start this item yet. It passed every readiness check, and it changes the factory's own rules:\n\n${lines}\n${noSplit}`
      : `The factory can't start this item yet. It failed these readiness checks:\n\n${lines}\n${noSplit}`;
    // A comment that says the coding model gave no answer is keyed on the item text, not updatedAt: the poller keeps
    // that item Eligible and gates it again, and the comment itself bumps updatedAt on GitHub, so an updatedAt key
    // would post it again on every poll. Its own key also lets the re-gate that gets an answer post a readiness
    // comment without that line instead of being deduplicated against it.
    const key = splitUnanswered(split)
      ? `readiness:split-unanswered:${itemTextHash(item)}:${ctx.readinessSha}`
      : `readiness:${item.updatedAt}:${ctx.readinessSha}${rulesApproved ? ":rules-approved" : ""}`;
    await ctx.adapter.comment(item.externalId, body, key);
  }
  return { ready: failed.length === 0, results, oversized, split, ruleChanges };
}
