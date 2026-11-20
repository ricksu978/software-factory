// PBI 294: lays out the design spec and the Phase 0 plan one sentence per line, and in the spec one table cell per line,
// so two PRs that change different sentences change different lines. Within a sentence it also starts a new line after
// each comma, semicolon or colon, so two PRs that change different clauses of one long sentence don't conflict either.
// In the spec it then puts a blank line after each line, so edits to neighbouring lines don't conflict (see spaced).
// The prose lint checks the sentences and cells, not the clause breaks or the blank lines: those are a one-off layout,
// made so the merge replay in scripts/merge-replay.ts meets PBI 294's bound, and later edits needn't keep them.
// It finds sentences the way the prose lint does.
// It only turns a run of spaces into a line break, or puts a line break between two tags, so a page renders the same.
// Code is left alone: fenced blocks and inline code, and in the spec <pre>, <code>, <script>, <style> and comments.
// Usage: node scripts/one-sentence-per-line.ts <file>...   rewrites each .md or .html file in place.
import { readFileSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { proseView, sentenceBreaks } from "./prose-lint.mjs";

type Edit = { from: number; to: number; insert: string };

const blank = (m: string) => m.replace(/[^\n]/g, " ");

/** The spec's markup with code and comments blanked, keeping tags and offsets. */
const markup = (text: string) =>
  text.replace(/<(pre|code|script|style)\b[\s\S]*?<\/\1>/gi, blank).replace(/<!--[\s\S]*?-->/g, blank);

const lineStart = (text: string, i: number) => text.lastIndexOf("\n", i - 1) + 1;

/** The indent a new line split from the line holding `at` takes, so Markdown keeps it in the same list item. */
function indent(text: string, at: number, html: boolean): string {
  const start = lineStart(text, at);
  const line = text.slice(start, at);
  if (html) return /^[ \t]*/.exec(line)![0];
  const prefix = /^[ \t]*(?:>[ \t]*)*(?:(?:[-*+]|\d+\.)[ \t]+)?/.exec(line)![0];
  return " ".repeat(prefix.length);
}

/**
 * The edit that starts a new line at a point between `from` and `to`, which hold only whitespace, tags and comments.
 * It prefers the point after any closing tags and before any opening ones, and it only uses a run of spaces or the
 * gap between two tags, so the text with whitespace collapsed stays the same. Null if there is no such point.
 */
function splitIn(text: string, from: number, to: number, html: boolean): Edit | null {
  const points: number[] = [];
  let lastClose = from;
  let firstOpen = to;
  for (let i = from; i <= to; ) {
    points.push(i);
    if (i === to) break;
    if (text[i] === "<") {
      const end = text.startsWith("<!--", i) ? text.indexOf("-->", i) + 3 : text.indexOf(">", i) + 1;
      if (end <= i || end > to) return null;
      if (text[i + 1] === "/" || text[i + 1] === "!") {
        if (firstOpen === to) lastClose = end;
      } else if (firstOpen === to) firstOpen = i;
      i = end;
    } else i++;
  }
  const ws = (c: string | undefined) => c === " " || c === "\t";
  // In the spec a quote's <cite> shows as a block ("blockquote cite { display: block }"), so a line break before it
  // renders the same, though no space or tag gap sits there.
  const usable = (p: number) =>
    ws(text[p - 1]) || ws(text[p]) || (text[p - 1] === ">" && text[p] === "<") || (html && text.startsWith("<cite>", p));
  const preferred = points.filter((p) => p >= lastClose && p <= firstOpen);
  const p = [...preferred, ...points].find(usable);
  if (p === undefined) return null;
  let a = p;
  let b = p;
  while (a > from && ws(text[a - 1])) a--;
  while (b < to && ws(text[b])) b++;
  return { from: a, to: b, insert: `\n${indent(text, a, html)}` };
}

/**
 * Where a clause ends inside a sentence: a comma, semicolon or colon followed by a space. Starting each clause on its
 * own line too means an edit to one clause of a long sentence leaves the lines around it alone, so a PR that changes
 * that clause and one that adds a sentence beside it don't touch the same lines. Commas inside a number or code don't
 * count, since no space follows them or the prose view blanks them.
 */
const CLAUSE_END = /[,;:][ \t]+(?=\S)/g;

/** True if a Markdown line starting with `rest` would read as something other than paragraph text. */
const markdownBlockStart = (rest: string) => /^(?:\d+[.)](?:\s|$)|[-*+](?:\s|$)|#|>|\||```|<)/.test(rest);

/**
 * Where the spec keeps its own line breaks outside <pre>: an element whose class its stylesheet sets to
 * "white-space: pre", such as the WIP formula. A line break there would show.
 */
function preformatted(text: string, html: boolean): [number, number][] {
  if (!html) return [];
  const classes = [...text.matchAll(/\.([\w-]+)\s*\{[^}]*white-space:\s*pre\s*[;}]/g)].map((m) => m[1]);
  const out: [number, number][] = [];
  for (const c of classes) {
    const el = new RegExp(`<(\\w+)\\b[^>]*\\bclass="[^"]*\\b${c}\\b[^"]*"[^>]*>[\\s\\S]*?</\\1>`, "g");
    for (const m of text.matchAll(el)) out.push([m.index!, m.index! + m[0].length]);
  }
  return out;
}

function edits(text: string, html: boolean): Edit[] {
  const kept = preformatted(text, html);
  return allEdits(text, html).filter((e) => !kept.some(([a, b]) => e.to > a && e.from < b));
}

function allEdits(text: string, html: boolean): Edit[] {
  const out: Edit[] = [];
  if (html) {
    const m = markup(text);
    for (const cell of m.matchAll(/<t[dh](?=[\s>])/gi)) {
      const start = lineStart(m, cell.index!);
      if (!m.slice(start, cell.index).replace(/<tr\b[^>]*>/gi, "").trim()) continue;
      let from = cell.index!;
      while (from > start && (text[from - 1] === " " || text[from - 1] === "\t")) from--;
      const e = splitIn(text, from, cell.index!, html);
      if (e) out.push(e);
    }
  }
  const prose = proseView(text, html);
  const clauses = [...prose.matchAll(CLAUSE_END)].map((m) => m.index! + m[0].length);
  for (const at of [...sentenceBreaks(prose), ...clauses]) {
    let gapStart = at;
    while (gapStart > 0 && /\s/.test(prose[gapStart - 1])) gapStart--;
    const gap = prose.slice(gapStart, at);
    if (gap.includes("\n")) continue;
    const start = lineStart(text, at);
    if (!html && /^\s*#/.test(text.slice(start, at))) continue;
    if (!html && markdownBlockStart(text.slice(at, at + 8))) continue;
    const e = splitIn(text, at - gap.length, at, html);
    if (e) out.push(e);
  }
  return out;
}

/**
 * The spec with a blank line after each line of markup and prose, so one unchanged line sits between any two lines.
 * git merge-file reports edits to two adjacent lines as one conflict, so without it two PRs that change neighbouring
 * sentences or clauses still conflict. HTML reads a blank line as whitespace, so the page renders the same.
 * It leaves alone code, comments, tags that span lines, and elements the stylesheet sets to "white-space: pre",
 * where a line break would show or change a value. A line already followed by a blank line gets no second one.
 * Markdown can't take this, since a blank line there ends the paragraph, so the plan doesn't get it.
 */
function spaced(text: string): string {
  const kept: [number, number][] = preformatted(text, true);
  for (const m of text.matchAll(/<(pre|code|script|style|textarea)\b[\s\S]*?<\/\1>|<!--[\s\S]*?-->|<[^>]*>/gi)) {
    kept.push([m.index!, m.index! + m[0].length]);
  }
  const out: string[] = [];
  let from = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
    const line = text.slice(lineStart(text, i), i);
    const nextEnd = text.indexOf("\n", i + 1);
    const next = text.slice(i + 1, nextEnd === -1 ? text.length : nextEnd);
    if (!line.trim() || !next.trim() || kept.some(([a, b]) => i > a && i < b)) continue;
    out.push(text.slice(from, i + 1), "\n");
    from = i + 1;
  }
  out.push(text.slice(from));
  return out.join("");
}

/** The text laid out one sentence per line, and in HTML one table cell per line with a blank line after each line. */
export function reflow(text: string, ext: string): string {
  const html = ext === ".html";
  const laidOut = sentences(text, html);
  return html ? spaced(laidOut) : laidOut;
}

function sentences(text: string, html: boolean): string {
  for (let pass = 0; pass < 20; pass++) {
    const list = edits(text, html).sort((x, y) => y.from - x.from);
    if (!list.length) return text;
    // Edits run from the end of the text back, so each one's offsets still hold. One that overlaps the last is
    // left for the next pass.
    const parts: string[] = [];
    let floor = text.length;
    for (const e of list) {
      if (e.to > floor) continue;
      parts.push(text.slice(e.to, floor), e.insert);
      floor = e.from;
    }
    parts.push(text.slice(0, floor));
    const next = parts.reverse().join("");
    if (next === text) return text;
    text = next;
  }
  return text;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  for (const f of process.argv.slice(2)) {
    const ext = extname(f).toLowerCase();
    if (![".md", ".html"].includes(ext)) continue;
    const text = readFileSync(f, "utf8");
    const out = reflow(text, ext);
    if (out !== text) writeFileSync(f, out);
  }
}
