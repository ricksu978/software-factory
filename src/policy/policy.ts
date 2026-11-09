// Policy files, per plan Run contract 11: load a repo's .factory/<name>.md or the factory's default, parse its
// criteria, and read a judge's verdicts on them.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type PolicyName = "dor" | "scenarios" | "pr-review" | "risk" | "dod";
export type Criterion = { index: number; text: string; run: string | null };
export type Verdict = { index: number; criterion: string; status: "passed" | "failed" | "person"; reason: string };
export type Policy = { name: PolicyName; source: "repo" | "default"; sha: string; text: string; criteria: Criterion[] };

export class PolicyError extends Error {
  override name = "PolicyError";
}

const withCriteria = new Set<PolicyName>(["dor", "pr-review", "dod"]);
const runInLine = /`run:\s*([^`]*)`/;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const policyDir = () => process.env.FACTORY_POLICY_DIR ?? join(import.meta.dirname, "..", "..", "policy");

/** One criterion per top-level `- [ ]` line, numbered from 1 in file order. Nested lines and prose are guidance. */
export function parseCriteria(markdown: string): Criterion[] {
  const criteria: Criterion[] = [];
  // A file saved with a UTF-8 byte-order mark would otherwise lose a criterion on its first line.
  for (const line of markdown.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (!line.startsWith("- [ ] ")) continue;
    const text = line.slice(6).trim();
    const run = runInLine.exec(text)?.[1].trim();
    criteria.push({ index: criteria.length + 1, text, run: run ? run : null });
  }
  return criteria;
}

/**
 * Loads `.factory/<name>.md` through `read`, or the factory's default when the repo has none. `read` returns null
 * only on a 404, and any error it throws propagates, so a failed read never falls back to the default. A missing
 * dod.md has no default and returns null. A `run:` line outside dod.md throws PolicyError.
 */
export async function loadPolicy(read: (path: string) => Promise<string | null>, name: PolicyName): Promise<Policy | null> {
  let text = await read(`.factory/${name}.md`);
  let source: Policy["source"] = "repo";
  if (text === null) {
    if (name === "dod") return null;
    text = await readFile(join(policyDir(), `${name}.md`), "utf8");
    source = "default";
  }
  if (name !== "dod" && /`run:[^`]*`/.test(text)) throw new PolicyError(`${name}.md: run: lines are allowed only in dod.md`);
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
 * policy file can weaken. A change to either re-checks every NotReady item.
 */
export type ReadinessLogic = { judgePrompt: string; version: number };

/** Raise this by one whenever the engine rules change, so every NotReady item is re-checked under the new rules. */
export const READINESS_VERSION = 1;

/**
 * SHA-256 over every file the readiness check reads, in a fixed order (Run contract 11). Each text goes in as its
 * UTF-8 byte length, a colon and the text, so no text can slide across into the next file. A missing file goes in
 * as `-;`, which no length prefix starts with, so it never matches a file whose text is `absent` or anything else.
 */
export function readinessSha(texts: ReadinessTexts, _logic?: ReadinessLogic): string {
  // PBI 149 stub: the logic isn't covered yet.
  const hash = createHash("sha256");
  for (const key of ["dor", "scenarios", "pr-review", "risk", "dod", "config"] as const) {
    const text = texts[key];
    if (text === null) hash.update("-;");
    else hash.update(`${Buffer.byteLength(text, "utf8")}:`).update(text, "utf8");
  }
  return hash.digest("hex");
}
