#!/usr/bin/env node
// Mechanical prose rules from ~/.claude/CLAUDE.md "Writing style", for .md and .html.
// Usage: node prose-lint.mjs <file>...   or as a PostToolUse hook (reads tool JSON on stdin).
// Exit 2 with findings on stderr, so a hook feeds them back to Claude. Exit 0 when clean.
// A copy lives in software-factory/scripts/prose-lint.mjs for CI; keep the two in sync.
import { readFileSync, existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const blank = (m) => m.replace(/[^\n]/g, " "); // keep line numbers when stripping code

export function lint(text, ext) {
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
    ? /<b>([^<\n]*:[^<\n]*)<\/b>[ \t]*(?!<\/)\S/g
    : /^[ \t>]*(?:(?:[-*+]|\d+\.)[ \t]+)?(?:\[[ x]\][ \t]+)?\*\*([^*\n]*:[^*\n]*)\*\*[ \t]*\S/gm;
  for (const m of prose.matchAll(leadIn))
    if (!/^(Step \d+[a-z]?|My pick):/.test(m[1])) findings.push([at(prose, m.index), `bold lead-in has a colon before prose: ${m[0].trim()}`]);
  for (const m of prose.matchAll(/[a-z]\.[A-Z][a-z]/g)) findings.push([at(prose, m.index), `missing space after period: ${m[0]}`]);

  if (ext === ".html" && /class="mermaid"/.test(text) && !/<script[^>]*>[^<]*mermaid/i.test(text))
    findings.push([at(text, text.indexOf('class="mermaid"')), "mermaid block with no mermaid script"]);
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
    for (const [line, msg] of lint(readFileSync(f, "utf8"), ext)) {
      console.error(`${f}:${line}: ${msg}`);
      failed = true;
    }
  }
  process.exit(failed ? 2 : 0);
}
