// PBI 364: a stage that runs after sign-off may ask to change a locked feature file. Pure: no I/O.
//
// The stage's agent asks in its report, one line per file it wants to change, in the form
//   FEATURE CHANGE: <path>: <reason>
// The factory still restores the locked files and pushes the rest of the stage's work, then moves the item from
// InProgress to FeatureChangeRequest with the request: each file named, with its text at the lock commit (`before`),
// the version the agent proposed (`after`), and the agent's reason.
import { fenced } from "./fence.ts";

/** One locked feature file a feature change request asks to change. */
export type FeatureChangeFile = { path: string; reason: string; before: string; after: string };

/** PBI 366: the id of Run detail's Feature change request section, which Floor and the state line link to. */
export const FEATURE_CHANGE_ANCHOR = "feature-change-request";
/** PBI 366: what Floor and Run detail say of an item in FeatureChangeRequest, before the link to its request. */
export const WAITS_ON_OWNER = "Waiting on the Product Owner's decision on the";

/** The prefix of a report line that asks to change a locked feature file. */
export const FEATURE_CHANGE = "FEATURE CHANGE:";

/**
 * Each `FEATURE CHANGE: <path>: <reason>` line in a stage's report, as path to reason, in the order the report names
 * them. A path named twice keeps its last reason. A line with no reason asks for nothing.
 */
export function featureChangeAsks(report: string): Map<string, string> {
  const asks = new Map<string, string>();
  for (const m of report.matchAll(/^[ \t]*FEATURE CHANGE:[ \t]*(\S+?):[ \t]+(\S.*?)[ \t]*\r?$/gm)) {
    asks.delete(m[1]!);
    asks.set(m[1]!, m[2]!);
  }
  return asks;
}

/** One line of a line diff: kept on both sides, taken out (`before`) or put in (`after`). */
export type DiffLine = { side: "same" | "before" | "after"; text: string };

/**
 * The line diff from `before` to `after` by their longest common run of lines, each change's lines taken out before
 * those put in. Only the lines within `context` lines of a change are kept, and a `null` marks each run left out.
 */
export function lineDiff(before: string, after: string, context = 2): (DiffLine | null)[] {
  const a = lines(before);
  const b = lines(after);
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  }
  const all: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      all.push({ side: "same", text: a[i++]! });
      j++;
    } else if (j >= b.length || (i < a.length && lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) all.push({ side: "before", text: a[i++]! });
    else all.push({ side: "after", text: b[j++]! });
  }
  const near = all.map(() => false);
  all.forEach((l, k) => {
    if (l.side === "same") return;
    for (let x = Math.max(0, k - context); x <= Math.min(all.length - 1, k + context); x++) near[x] = true;
  });
  const out: (DiffLine | null)[] = [];
  all.forEach((l, k) => {
    if (near[k]) out.push(l);
    else if (out.at(-1) !== null) out.push(null);
  });
  if (out.at(-1) === null) out.pop();
  return out;
}

function lines(text: string): string[] {
  const all = text.split(/\r?\n/);
  if (all.at(-1) === "") all.pop();
  return all;
}

/**
 * The comment that posts a feature change request on the item's PBI, the way sign-off posts the scenarios: for each
 * file, its path, the stage's reason, and a diff from the lock commit to the proposed version, a line taken out
 * starting with `-` and one put in with `+`.
 */
export function featureChangeComment(files: FeatureChangeFile[]): string {
  const parts = files.map((f) => {
    const diff = lineDiff(f.before, f.after)
      .map((l) => (l === null ? "@@" : `${l.side === "before" ? "-" : l.side === "after" ? "+" : " "}${l.text}`))
      .join("\n");
    return `\`${f.path}\`\n\nReason: ${f.reason}\n\n${fenced(diff || "(no line changes)", "diff")}`;
  });
  const which = files.length === 1 ? "a locked feature file" : "locked feature files";
  return [
    `Feature change request. A stage after sign-off asks to change ${which}. The factory kept the files as they were at the lock commit, pushed the rest of the stage's work, and the item waits on the owner. Each file's change from the lock commit follows, with the stage's reason.`,
    ...parts,
  ].join("\n\n");
}
