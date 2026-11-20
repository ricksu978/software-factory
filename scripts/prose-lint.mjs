#!/usr/bin/env node
// Mechanical prose rules from ~/.claude/CLAUDE.md "Writing style", for .md and .html.
// Usage: node prose-lint.mjs <file>...   or as a PostToolUse hook (reads tool JSON on stdin).
// Exit 2 with findings on stderr, so a hook feeds them back to Claude. Exit 0 when clean.
// Two copies exist, the hook at ~/.claude/hooks/prose-lint.mjs and the CI copy at software-factory/scripts/prose-lint.mjs. Keep them in sync.
import { readFileSync, existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const blank = (m) => m.replace(/[^\n]/g, " "); // keep line numbers when stripping code

// One sentence per line (PBI 294), for the design spec and the Phase 0 plan only. Many PRs edit those two at once, and
// git merges line by line, so two PRs that change different sentences of one long line conflict. The rule checks the
// path, so the editor-hook copy of this file applies it to the same two files.
export const ONE_SENTENCE_FILES = [
  "docs/superpowers/specs/2026-11-05-software-factory-design.html",
  "docs/superpowers/plans/2026-11-05-phase-0-walking-skeleton.md",
];
const oneSentenceFile = (path) => ONE_SENTENCE_FILES.some((f) => `/${path.replaceAll("\\", "/")}`.endsWith(`/${f}`));

// A sentence ends at ".", "!" or "?", after any closing quote, bracket or Markdown emphasis ("*", "_"), followed by
// whitespace and a capital, a digit, "§" or an opening quote, bracket or emphasis. "e.g.", "i.e.", "etc.", "vs.", "cf." and a lone capital initial don't end one.
const ABBREVIATION = /(?:\b(?:e\.g|i\.e|etc|vs|cf)|(?:^|[\s(])[A-Z])$/;
const SENTENCE_END = /([.!?])[*_'"”’)\]]*\s+(?=[*_'"“‘(\[]*[A-Z0-9§])/g;

/** Where each sentence after the first starts in `text`. */
export function sentenceBreaks(text) {
  const out = [];
  for (const m of text.matchAll(SENTENCE_END)) {
    // A short window before the stop is enough, and keeps this linear on a long text. At the text's start a newline
    // stands in for it, which reads the same to the "lone capital" check.
    const before = m.index >= 6 ? text.slice(m.index - 6, m.index) : `\n${text.slice(0, m.index)}`;
    if (m[1] === "." && ABBREVIATION.test(before)) continue;
    out.push(m.index + m[0].length);
  }
  return out;
}

/** Inline code reads as one word, padded to keep columns, so a sentence that starts with code still counts. */
const word = (m) => (m.includes("\n") ? blank(m) : "Code".padEnd(m.length, " ").slice(0, Math.max(m.length, 1)));

/**
 * The text as its sentences read, character for character: code reads as a word or blanks, and in HTML comments read
 * as blanks and tags as spaces. A Markdown line that starts a list item or blockquote has its marker blanked, and a
 * Markdown table row is blanked whole, since its cells can't span lines.
 */
export function proseView(text, html) {
  let t = text.replace(/```[\s\S]*?```/g, blank).replace(/`[^`\n]*`/g, word);
  if (html) {
    t = t
      .replace(/<(pre|code|script|style)\b[\s\S]*?<\/\1>/gi, word)
      .replace(/<!--[\s\S]*?-->/g, blank)
      .replace(/<[^>\n]*>/g, blank);
  } else {
    t = t
      .replace(/^\s*\|.*$/gm, blank)
      .replace(/^\s*(?:>\s*)*(?:(?:[-*+]|\d+\.)\s+)?(?:\[[ x]\]\s+)?/gm, blank);
  }
  return t;
}

/** Each line of a spec or plan text that holds more than one sentence or, in the spec, more than one table cell. */
export function oneSentenceFindings(text, html) {
  const findings = [];
  proseView(text, html).split("\n").forEach((line, i) => {
    if (sentenceBreaks(line).length) findings.push([i + 1, "line holds more than one sentence; start each on its own line"]);
  });
  if (html) {
    const markup = text.replace(/<(pre|code|script|style)\b[\s\S]*?<\/\1>/gi, blank).replace(/<!--[\s\S]*?-->/g, blank);
    markup.split("\n").forEach((line, i) => {
      const cells = [...line.matchAll(/<t[dh](?=[\s>])/gi)];
      const lead = cells.length ? line.slice(0, cells[0].index).replace(/<tr\b[^>]*>/gi, "").trim() : "";
      if (cells.length > 1 || lead) findings.push([i + 1, "line holds more than one table cell, or text before one; start each cell on its own line"]);
    });
  }
  return findings.sort((a, b) => a[0] - b[0]);
}

export function lint(text, ext, path = "") {
  const findings = [];
  const at = (src, i) => src.slice(0, i).split("\n").length;
  for (const m of text.matchAll(/[–—]/g)) findings.push([at(text, m.index), "en or em dash"]);

  let prose = text
    .replace(/```[\s\S]*?```/g, blank)
    .replace(/`[^`\n]*`/g, blank)
    .replace(/<(pre|code|script|style)\b[\s\S]*?<\/\1>/gi, blank);

  // A bold label with a colon in it, followed by prose on the same line. A colon before a list
  // (nothing after the label) is fine, and so are the plan template's "Step N:" and the
  // reporting format's "My pick: X." labels. In Markdown a lead-in starts its line or list item.
  const leadIn = ext === ".html"
    ? /<b>([^<\n]*(?<!\d):(?!\d)[^<\n]*)<\/b>[ \t]*(?!<\/)\S/g // a clock time such as 09:02 is not a label colon
    : /^[ \t>]*(?:(?:[-*+]|\d+\.)[ \t]+)?(?:\[[ x]\][ \t]+)?\*\*([^*\n]*(?<!\d):(?!\d)[^*\n]*)\*\*[ \t]*\S/gm;
  for (const m of prose.matchAll(leadIn))
    if (!/^(Step \d+[a-z]?|My pick):/.test(m[1])) findings.push([at(prose, m.index), `bold lead-in has a colon before prose: ${m[0].trim()}`]);
  for (const m of prose.matchAll(/[a-z]\.[A-Z][a-z]/g)) findings.push([at(prose, m.index), `missing space after period: ${m[0]}`]);

  // A standalone document (its own <html>, or a repo doc under docs/) needs its own Mermaid script.
  // An Artifact page renders Mermaid natively.
  const standalone = /<html[\s>]/i.test(text) || /(^|[\\/])docs[\\/]/.test(path);
  if (ext === ".html" && standalone && /class="mermaid"/.test(text) && !/<script[^>]*>[^<]*mermaid/i.test(text))
    findings.push([at(text, text.indexOf('class="mermaid"')), "mermaid block with no mermaid script"]);
  if (oneSentenceFile(path)) findings.push(...oneSentenceFindings(text, ext === ".html"));
  return findings;
}

function files() {
  if (process.argv.length > 2) return process.argv.slice(2);
  try {
    const input = JSON.parse(readFileSync(0, "utf8"));
    const f = input.tool_input?.file_path ?? input.tool_response?.filePath;
    return f ? [f] : [];
  } catch { return []; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  let failed = false;
  for (const f of files()) {
    const ext = extname(f).toLowerCase();
    if (![".md", ".html"].includes(ext) || !existsSync(f)) continue;
    for (const [line, msg] of lint(readFileSync(f, "utf8"), ext, f)) {
      console.error(`${f}:${line}: ${msg}`);
      failed = true;
    }
  }
  process.exit(failed ? 2 : 0);
}
