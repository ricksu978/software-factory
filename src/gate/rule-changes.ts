// An item's "## Changes the factory's rules" section (PBI 395): what it says it changes, read and held to `main`.
// Pure, apart from the reader of `main` the check is handed.
import { createHash } from "node:crypto";
import type { RuleChange, RulePlace } from "../store/rule-changes.ts";

/** The heading an item says it changes the factory's own rules under. Any other heading isn't read. */
export const RULES_HEADING = "## Changes the factory's rules";
/** The factory's spec, where section §N is the <section> whose <h2> opens with <span class="n">0N</span>. */
export const SPEC_PATH = "docs/superpowers/specs/2026-11-05-software-factory-design.html";
/** A policy file of the factory: a Markdown file directly under `policy/`. No other path of the factory's repo is read. */
export const POLICY_PATH = /^policy\/[A-Za-z0-9_-]+\.md$/;

/** True when `path` is a file a rule change may name and the check may read: the spec, or a policy file of the factory. */
export function isRulesFile(path: string): boolean {
  return path === SPEC_PATH || POLICY_PATH.test(path);
}

/** The branch every Before is held to. */
export const RULES_REF = "main";

/** A rule change as the readiness check read it, with what's wrong with its entry, if anything. */
export type RuleChangeRead = RuleChange & { problem?: string };

/** "spec section §6", or a policy file's path, as comments and the item page name a rule. */
export function placeName(p: RulePlace): string {
  return p.kind === "spec" ? `spec section ${p.section}` : p.path;
}

/** The key a place is matched on: "§6" or the policy file's path, as the judge names it. */
export function placeKey(p: RulePlace): string {
  return p.kind === "spec" ? p.section : p.path;
}

const SECTION = /§\s*(\d+)/;

/** The judge's `rules` list as places' keys: "§N" for anything naming a spec section, the trimmed path otherwise. */
export function judgedRules(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const r of raw) {
    if (typeof r !== "string" || !r.trim()) continue;
    const m = SECTION.exec(r);
    const key = m ? `§${Number(m[1])}` : r.trim().replace(/^`|`$/g, "");
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/** The section's lines, from the line after its heading up to the next heading of level one or two, or null when it has none. */
export function rulesSection(body: string): string[] | null {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === RULES_HEADING);
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,2}\s/.test(l));
  return end < 0 ? rest : rest.slice(0, end);
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Each rule the item's section changes, in its order. A "### Spec §N" heading names a spec section, and any other "###"
 * heading a policy file by its path. Under it, "**Before**" and "**After**" are each followed by their text as "> "
 * quote lines, joined into one line. A part the entry doesn't give is null.
 */
export function parseRuleChanges(body: string): RuleChange[] {
  const lines = rulesSection(body);
  if (!lines) return [];
  const out: RuleChange[] = [];
  let cur: { place: RulePlace; before: string[] | null; after: string[] | null } | null = null;
  let part: "before" | "after" | null = null;
  const flush = () => {
    if (!cur) return;
    const joined = (p: string[] | null) => (p === null ? null : squash(p.join(" ")) || null);
    out.push({ place: cur.place, before: joined(cur.before), after: joined(cur.after) });
  };
  for (const line of lines) {
    const h = /^###\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      const name = h[1].replace(/`/g, "").trim();
      const spec = /^spec\s+§\s*(\d+)/i.exec(name);
      cur = { place: spec ? { kind: "spec", section: `§${Number(spec[1])}` } : { kind: "policy", path: name }, before: null, after: null };
      part = null;
      continue;
    }
    if (!cur) continue;
    const label = /^\s*\*\*(Before|After):?\*\*:?\s*(.*)$/i.exec(line);
    if (label) {
      part = label[1].toLowerCase() as "before" | "after";
      cur[part] = [];
      const inline = /^>\s?(.*)$/.exec(label[2]);
      if (inline) cur[part]!.push(inline[1]);
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote && part) cur[part]!.push(quote[1]);
  }
  flush();
  return out;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", sect: "§" };
const decode = (s: string) => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (e, name: string) => {
  if (name[0] === "#") return String.fromCodePoint(parseInt(name.slice(name[1] === "x" || name[1] === "X" ? 2 : 1), name[1] === "x" || name[1] === "X" ? 16 : 10));
  return ENTITIES[name.toLowerCase()] ?? e;
});
const BLOCK = /^(p|div|li|ul|ol|br|hr|h[1-6]|tr|td|th|table|thead|tbody|section|blockquote|pre|dl|dt|dd|figure|figcaption|details|summary|aside|header|footer|nav|article)$/i;

/** HTML read as prose: a block tag parts words, an inline one doesn't, entities are decoded and whitespace runs are one space. */
function htmlText(html: string): string {
  const t = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi, (_t, name: string) => (BLOCK.test(name) ? " " : ""));
  return squash(decode(t));
}

/** Text as it's compared: straight quotes, no Markdown emphasis or code marks, one space between words. */
function comparable(s: string): string {
  return squash(s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\*\*|__|`/g, ""));
}

/**
 * The text of the rule's place in `source`, as a Before is compared with it: a spec section's HTML read as prose, or a
 * policy file's Markdown. Null when the spec has no such section.
 */
export function ruleText(source: string, place: RulePlace): string | null {
  if (place.kind === "policy") return comparable(source);
  const n = Number(place.section.slice(1));
  for (const part of source.split(/<section\b/i).slice(1)) {
    const h = /<h2\b[^>]*>\s*<span class="n">\s*(\d+)\s*<\/span>([\s\S]*?)<\/h2>/i.exec(part);
    if (!h || Number(h[1]) !== n) continue;
    const body = part.slice(h.index + h[0].length).split(/<\/section>/i)[0];
    return comparable(htmlText(body));
  }
  return null;
}

const wordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** True when `quote` is in `text` as whole words: no letter or digit runs on past either end. */
function quotes(text: string, quote: string): boolean {
  if (!quote) return false;
  for (let i = text.indexOf(quote); i >= 0; i = text.indexOf(quote, i + 1)) {
    const cut = (wordChar(quote[0]) && wordChar(text[i - 1])) || (wordChar(quote.at(-1)) && wordChar(text[i + quote.length]));
    if (!cut) return true;
  }
  return false;
}

/**
 * Checks each entry: it names a spec section or a policy file of the factory, it gives a Before and an After, and its
 * Before is found word for word in its place on `main`. A heading naming any other path is never read, so an item can't
 * use the check to probe the factory's other files.
 * `read` reads a file of the factory's repo on `main`, or null when it isn't there. Without it, no Before can be held
 * to `main`, so every entry that gives one fails. Each spec or policy file is read once.
 */
export async function checkRuleChanges(changes: RuleChange[], read: ((path: string) => Promise<string | null>) | undefined): Promise<RuleChangeRead[]> {
  const files = new Map<string, Promise<string | null>>();
  const file = (path: string) => {
    if (!files.has(path)) files.set(path, read ? read(path) : Promise.resolve(null));
    return files.get(path)!;
  };
  const out: RuleChangeRead[] = [];
  for (const ch of changes) {
    const name = placeName(ch.place);
    const path = ch.place.kind === "spec" ? SPEC_PATH : ch.place.path;
    let problem: string | undefined;
    if (ch.place.kind === "policy" && !POLICY_PATH.test(ch.place.path)) problem = `${name} isn't a spec section or a policy file of the factory.`;
    else if (ch.before === null) problem = `The entry for ${name} gives no Before.`;
    else if (ch.after === null) problem = `The entry for ${name} gives no After.`;
    else if (!read) problem = `The factory couldn't read main to check the Before quoted for ${name}.`;
    else {
      const source = await file(path);
      const text = source === null ? null : ruleText(source, ch.place);
      if (text === null) problem = `main holds no ${name}, so the Before quoted for it doesn't match main.`;
      else if (!quotes(text, comparable(ch.before))) problem = `The Before quoted for ${name} doesn't match main word for word.`;
    }
    out.push(problem ? { ...ch, problem } : { ...ch });
  }
  return out;
}

/** SHA-256 over each rule's place, Before and After, in order: what an owner's approval is for. */
export function ruleChangesHash(changes: RuleChange[]): string {
  const plain = changes.map((c) => ({ place: c.place, before: c.before, after: c.after }));
  return createHash("sha256").update(JSON.stringify(plain)).digest("hex");
}

export type DiffWord = { text: string; changed: boolean };

/** Each side's words, split on whitespace, with those outside their longest common run marked changed. */
export function wordDiff(before: string, after: string): { before: DiffWord[]; after: DiffWord[] } {
  const a = before.split(/\s+/).filter(Boolean);
  const b = after.split(/\s+/).filter(Boolean);
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const keptA = new Set<number>();
  const keptB = new Set<number>();
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) {
      keptA.add(i++);
      keptB.add(j++);
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++;
    else j++;
  }
  return {
    before: a.map((text, i) => ({ text, changed: !keptA.has(i) })),
    after: b.map((text, j) => ({ text, changed: !keptB.has(j) })),
  };
}
