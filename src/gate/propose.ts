// The rewrite the factory proposes for an item a person wrote that fails only dor.md lines (PBI 439). The coding model
// rewrites the body as it does a split's child (PBI 264), and the factory builds the proposed body from its reply: the
// item's acceptance criteria stay word for word, except a criterion the judge found untestable, which moves to the
// Notes with a line saying why. The proposal is shown on the item page and applied only when the owner accepts it.
import type { Verdict } from "../policy/policy.ts";
import { withoutSection } from "./file-split.ts";
import { wordDiff, type DiffWord } from "./rule-changes.ts";

/** The heading the factory gives a body's criteria when the body has none of its own. */
const CRITERIA_HEADING = "## Acceptance criteria";
const NOTES = "Notes";

const isHeading = (line: string) => /^#{1,6}\s/.test(line);
const headingName = (line: string) => line.replace(/^#+\s*/, "").trim();

/** A dor.md line about testing, such as "Every acceptance criterion can be tested". */
const TESTING_LINE = /\btest/i;

/** Where a judge's reason turns from one criterion to the next: a sentence's end, a semicolon, or a contrast. */
const CLAUSE = /(?<=[.;!?])\s+|;\s*|,?\s+\b(?:but|while|whereas|although|though|however|yet)\b,?\s+/i;
/** A clause that finds what it names testable, such as "... is fine" or "... can be tested". */
const PASSING = /\b(?:is|are)\s+(?:fine|ok|okay|good|testable|measurable|clear|specific)\b|\bcan be (?:tested|measured|checked)\b|\bpasses\b/i;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Where `criterion` stands in `clause` as words of its own, not inside a longer word, nor inside a longer criterion
 * the clause names too.
 */
function names(clause: string, criterion: string, criteria: string[]): boolean {
  const at = (needle: string) => [...clause.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${escape(needle)}(?![\\p{L}\\p{N}])`, "giu"))]
    .map((m) => [m.index, m.index + needle.length] as const);
  const longer = criteria.filter((o) => o !== criterion && o.length > criterion.length && o.toLowerCase().includes(criterion.toLowerCase())).flatMap(at);
  return at(criterion).some(([s, e]) => !longer.some(([ls, le]) => ls <= s && e <= le));
}

/**
 * Each acceptance criterion the judge found untestable, with the judge's reason. A criterion is untestable when a
 * failed dor.md line about testing names it word for word in a clause of its reason that doesn't find it testable. So
 * a reason that names one criterion as fine and another as untestable moves only the second, and a criterion that
 * is only part of a longer one the reason names stays where it is.
 */
export function untestable(criteria: string[], failed: Verdict[]): { criterion: string; reason: string }[] {
  const out: { criterion: string; reason: string }[] = [];
  const lines = failed.filter((f) => f.index > 0 && f.status !== "passed" && TESTING_LINE.test(f.criterion));
  for (const c of criteria) {
    const v = lines.find((f) => f.reason.split(CLAUSE).some((clause) => clause && names(clause, c, criteria) && !PASSING.test(clause)));
    if (v) out.push({ criterion: c, reason: v.reason });
  }
  return out;
}

/** The line of `body` that opens its criteria section: the first heading whose bullets list one of `criteria`. */
function criteriaHeading(body: string, criteria: string[]): string | null {
  const lines = body.split(/\r?\n/);
  for (const [i, line] of lines.entries()) {
    if (!isHeading(line)) continue;
    const rest = lines.slice(i + 1);
    const end = rest.findIndex(isHeading);
    const section = end === -1 ? rest : rest.slice(0, end);
    if (section.some((l) => criteria.some((c) => l.replace(/^\s*[-*]\s+(\[[ xX]\]\s+)?/, "").trim() === c))) return line.trim();
  }
  return null;
}

/** The lines under the heading `name` in `body`, blank ones dropped, or none when it has no such heading. */
function sectionLines(body: string, name: string): string[] {
  const lines = body.split(/\r?\n/);
  const at = lines.findIndex((l) => isHeading(l) && headingName(l).toLowerCase() === name.toLowerCase());
  if (at === -1) return [];
  const rest = lines.slice(at + 1);
  const end = rest.findIndex(isHeading);
  return (end === -1 ? rest : rest.slice(0, end)).filter((l) => l.trim() !== "");
}

/**
 * The proposed issue body: `rewritten`, the coding model's body, without any criteria or Notes section of its own,
 * then the current body's criteria heading and its criteria word for word, less the untestable ones, then the Notes,
 * the model's own lines first and then a line for each criterion moved there saying why.
 */
export function proposedBody(current: string, criteria: string[], rewritten: string, failed: Verdict[]): string {
  const heading = criteriaHeading(current, criteria) ?? CRITERIA_HEADING;
  const moved = untestable(criteria, failed);
  const kept = criteria.filter((c) => !moved.some((m) => m.criterion === c));
  const notes = [
    ...sectionLines(rewritten, NOTES),
    ...moved.map((m) => `- "${m.criterion}" moved here from the acceptance criteria, because the readiness judge found it can't be tested: ${m.reason}`),
  ];
  const own = [headingName(heading), headingName(CRITERIA_HEADING), NOTES].reduce((b, name) => withoutSection(b, name), rewritten).trim();
  const parts = [own, `${heading}\n\n${kept.map((c) => `- ${c}`).join("\n")}`];
  if (notes.length) parts.push(`## ${NOTES}\n\n${notes.join("\n")}`);
  return `${parts.filter(Boolean).join("\n\n")}\n`;
}

/** One line of a body as the item page shows it, each word marked when it changes. */
export type BodyLine = DiffWord[];

/**
 * The current body beside the proposed one, line by line, each word that changes marked. Lines are matched first, blank
 * ones left out, so a line kept as it was is never marked. Between two kept lines, a run of lines changed on both sides
 * is matched word by word when each side has as many lines as the other; otherwise every word in the run is marked,
 * so a criterion moved to the Notes reads as changed, though the line saying why quotes it.
 */
export function bodyDiff(current: string, proposed: string): { current: BodyLine[]; proposed: BodyLine[] } {
  const a = current.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const b = proposed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const { before: keptA, after: keptB } = common(a, b);
  const out = { current: [] as BodyLine[], proposed: [] as BodyLine[] };
  const words = (l: string, changed: boolean): BodyLine => l.split(/\s+/).filter(Boolean).map((text) => ({ text, changed }));
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const runA: string[] = [];
    const runB: string[] = [];
    while (i < a.length && !keptA.has(i)) runA.push(a[i++]);
    while (j < b.length && !keptB.has(j)) runB.push(b[j++]);
    if (runA.length === runB.length) {
      for (const [k, l] of runA.entries()) {
        const d = wordDiff(l, runB[k]);
        out.current.push(d.before);
        out.proposed.push(d.after);
      }
    } else {
      out.current.push(...runA.map((l) => words(l, true)));
      out.proposed.push(...runB.map((l) => words(l, true)));
    }
    if (i < a.length && j < b.length) {
      out.current.push(words(a[i++], false));
      out.proposed.push(words(b[j++], false));
    }
  }
  return out;
}

/** The indexes of `a` and `b` in their longest common run of equal entries. */
function common(a: string[], b: string[]): { before: Set<number>; after: Set<number> } {
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const before = new Set<number>();
  const after = new Set<number>();
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) {
      before.add(i++);
      after.add(j++);
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++;
    else j++;
  }
  return { before, after };
}
