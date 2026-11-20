// PBI 294: lays out the design spec and the Phase 0 plan one sentence per line, and in the spec one table cell per line,
// so two PRs that change different sentences change different lines. It finds sentences the way the prose lint does.
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

/** True if a Markdown line starting with `rest` would read as something other than paragraph text. */
const markdownBlockStart = (rest: string) => /^(?:\d+[.)](?:\s|$)|[-*+](?:\s|$)|#|>|\||```|<)/.test(rest);

function edits(text: string, html: boolean): Edit[] {
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
  for (const at of sentenceBreaks(prose)) {
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

/** The text laid out one sentence per line, and in HTML one table cell per line. */
export function reflow(text: string, ext: string): string {
  const html = ext === ".html";
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
