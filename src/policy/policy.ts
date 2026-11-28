// Policy files, per plan Run contract 11: load a repo's .factory/<name>.md or the factory's default, parse its
// criteria, and read a judge's verdicts on them.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type PolicyName = "dor" | "scenarios" | "pr-review" | "risk" | "dod";
export type Criterion = {
  index: number; text: string; run: string | null;
  /** The CI check a dod.md line names with `ci: <name>`, which stands in for its command when it reported (PBI 229). */
  ci?: string | null;
};
export type Verdict = { index: number; criterion: string; status: "passed" | "failed" | "person"; reason: string };
export type Policy = { name: PolicyName; source: "repo" | "default"; sha: string; text: string; criteria: Criterion[] };

/**
 * Reads the text of the factory's default for a policy a repo has no `.factory/<name>.md` for (PBI 261). The worker
 * reads each default from the commit of `main` it last fetched, not from the checkout's disk. dod.md has no default.
 */
export type DefaultPolicies = ((name: Exclude<PolicyName, "dod">) => Promise<string>) & {
  /**
   * A reader fixed to the commit the defaults come from right now, so every read through it sees one commit even if
   * the source moves meanwhile. The poller pins once per poll. A source that can't move has no `pin`.
   */
  pin?: () => Promise<(name: Exclude<PolicyName, "dod">) => Promise<string>>;
};

export class PolicyError extends Error {
  override name = "PolicyError";
}

const withCriteria = new Set<PolicyName>(["dor", "pr-review", "dod"]);
const runInLine = /`run:\s*([^`]*)`/;
const ciInLine = /`ci:\s*([^`]*)`/;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const policyDir = () => process.env.FACTORY_POLICY_DIR ?? join(import.meta.dirname, "..", "..", "policy");

/**
 * One criterion per top-level `- [ ]` line, numbered from 1 in file order. Nested lines and prose are guidance. A
 * `run:` in backticks is the line's command, and a `ci:` in backticks names the CI check that stands in for it (PBI 229).
 */
export function parseCriteria(markdown: string): Criterion[] {
  const criteria: Criterion[] = [];
  // A file saved with a UTF-8 byte-order mark would otherwise lose a criterion on its first line.
  for (const line of markdown.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (!line.startsWith("- [ ] ")) continue;
    const text = line.slice(6).trim();
    const run = runInLine.exec(text)?.[1].trim();
    const ci = ciInLine.exec(text)?.[1].trim();
    criteria.push({ index: criteria.length + 1, text, run: run ? run : null, ...(ci ? { ci } : {}) });
  }
  return criteria;
}

/**
 * Loads `.factory/<name>.md` through `read`, or the factory's default when the repo has none. `read` returns null
 * only on a 404, and any error it throws propagates, so a failed read never falls back to the default. A missing
 * dod.md has no default and returns null. A `run:` or `ci:` line outside dod.md throws PolicyError. The default comes
 * from `defaults` when given, as the worker's comes from `main`'s fetched commit (PBI 261), and otherwise from the
 * policy directory beside the code, as a cell's comes from its image.
 */
export async function loadPolicy(
  read: (path: string) => Promise<string | null>, name: PolicyName, defaults?: DefaultPolicies,
): Promise<Policy | null> {
  let text = await read(`.factory/${name}.md`);
  let source: Policy["source"] = "repo";
  if (text === null) {
    if (name === "dod") return null;
    text = defaults ? await defaults(name) : await readFile(join(policyDir(), `${name}.md`), "utf8");
    source = "default";
  }
  if (name !== "dod" && /`run:[^`]*`/.test(text)) throw new PolicyError(`${name}.md: run: lines are allowed only in dod.md`);
  if (name !== "dod" && /`ci:[^`]*`/.test(text)) throw new PolicyError(`${name}.md: ci: lines are allowed only in dod.md`);
  return { name, source, sha: sha256(text), text, criteria: withCriteria.has(name) ? parseCriteria(text) : [] };
}

/** Every line of a judge's reply that parses as a JSON object. */
export function jsonLines(reply: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of reply.split(/\r?\n/)) {
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) out.push(value as Record<string, unknown>);
    } catch {
      // Not JSON. A judge's prose around its answer lines is ignored.
    }
  }
  return out;
}

/**
 * One verdict per criterion, keyed by index. A missing index fails with "not judged", a fail wins over any other
 * answer for the same index, and `person` counts only in dod.md.
 */
export function parseJudgement(reply: string, policy: Policy): Verdict[] {
  const answers = jsonLines(reply).filter((o) => typeof o.index === "number");
  return policy.criteria.map((c) => {
    const mine = answers.filter((a) => a.index === c.index);
    const reasonOf = (a: Record<string, unknown>) => (typeof a.reason === "string" ? a.reason : "");
    const valid = (s: unknown) => s === "passed" || (s === "person" && policy.name === "dod");
    if (mine.length === 0) return { index: c.index, criterion: c.text, status: "failed", reason: "not judged" };
    const bad = mine.find((a) => !valid(a.status));
    if (bad) return { index: c.index, criterion: c.text, status: "failed", reason: bad.status === "failed" ? reasonOf(bad) : `invalid status ${String(bad.status)}` };
    const person = mine.find((a) => a.status === "person");
    const chosen = person ?? mine[0];
    return { index: c.index, criterion: c.text, status: person ? "person" : "passed", reason: reasonOf(chosen) };
  });
}

export type ReadinessTexts = Record<"dor" | "scenarios" | "pr-review" | "risk" | "dod" | "config", string | null>;

/**
 * The factory's own readiness logic (PBI 149): the prompt it gives the judge, and the version of the engine rules no
 * policy file can weaken. A change to either re-checks every NotReady item. Since PBI 159 it also holds the prompt the
 * factory gives the coding model when it splits an oversized item, rendered independent of any one item.
 */
export type ReadinessLogic = { judgePrompt: string; version: number; splitPrompt: string };

/** Raise this by one whenever the engine rules change, so every NotReady item is re-checked under the new rules. */
// 2 (PBI 237): an open dependency no longer fails the gate. The scheduler holds a blocked item back instead.
// 3 (PBI 264): each permission the App is missing on the item's repo fails the gate.
// 4 (PBI 395): an item's "Changes the factory's rules" section is held to main, and one that changes them waits for the owner.
// 5 (PBI 414): the engine passes the rules line for an item whose section is held to main and covers every judged rule.
export const READINESS_VERSION = 5;

/**
 * SHA-256 over every file the readiness check reads, in a fixed order (Run contract 11). Each text goes in as its
 * UTF-8 byte length, a colon and the text, so no text can slide across into the next file. A missing file goes in
 * as `-;`, which no length prefix starts with, so it never matches a file whose text is `absent` or anything else.
 * Given the factory's readiness logic (PBI 149), the judge's prompt, the readiness version and (PBI 159) the split
 * prompt follow the files the same way, so a change to any of them gives a new sha for the same repo files.
 */
export function readinessSha(texts: ReadinessTexts, logic?: ReadinessLogic): string {
  const hash = createHash("sha256");
  for (const key of ["dor", "scenarios", "pr-review", "risk", "dod", "config"] as const) {
    const text = texts[key];
    if (text === null) hash.update("-;");
    else hash.update(`${Buffer.byteLength(text, "utf8")}:`).update(text, "utf8");
  }
  if (logic) {
    for (const text of [logic.judgePrompt, String(logic.version), logic.splitPrompt]) hash.update(`${Buffer.byteLength(text, "utf8")}:`).update(text, "utf8");
  }
  return hash.digest("hex");
}
