// PBI 294: the prose lint's one-sentence-per-line rule for the spec and the Phase 0 plan, and the reflow that meets it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lint, sentenceBreaks } from "../scripts/prose-lint.mjs";
import { reflow } from "../scripts/one-sentence-per-line.ts";

const SPEC = "docs/superpowers/specs/2026-11-05-software-factory-design.html";
const PLAN = "docs/superpowers/plans/2026-11-05-phase-0-walking-skeleton.md";
const sentences = (text: string, ext: string, path: string) =>
  lint(text, ext, path).filter(([, msg]) => /more than one (sentence|table cell)/.test(msg));
const collapse = (s: string) => s.replace(/\s+/g, " ").trim().replace(/> </g, "><");

test("a sentence ends at a stop followed by a capital, a digit, § or an opening quote", () => {
  assert.equal(sentenceBreaks("One. Two! 3 apples? §4 is \"quoted\". (Then) more.").length, 4);
});

test("a sentence ends inside Markdown emphasis too, and the next may open with it", () => {
  assert.equal(sentenceBreaks("One test.** Two here.").length, 1);
  assert.equal(sentenceBreaks("**Goal.** Build it. _Then._ Ship. One. **Two.**").length, 5);
  assert.deepEqual(sentences("One test.** Two here.\n", ".md", PLAN).map(([l]) => l), [1]);
  assert.equal(reflow("**Goal.** Build it.\n", ".md"), "**Goal.**\nBuild it.\n");
});

test("abbreviations, initials and dots inside words don't end a sentence", () => {
  for (const s of ["Use e.g. Node here.", "Node 26.13.0 runs at 0.5 vCPU.", "Ask J. Smith first.", "Read i.e. This.", "A vs. B is fine."]) {
    assert.deepEqual(sentenceBreaks(s), [], s);
  }
});

test("the lint fails each plan line with two sentences and names it", () => {
  const text = "# Plan\n\nOne. Two.\n\nFine here.\n- Item one. Item two.\n";
  assert.deepEqual(sentences(text, ".md", PLAN).map(([line]) => line), [3, 6]);
});

test("the rule applies to the spec and the plan only, whatever the path's prefix", () => {
  const text = "One. Two.\n";
  assert.equal(sentences(text, ".md", "README.md").length, 0);
  assert.equal(sentences(text, ".md", "docs/superpowers/spikes/2026-11-phase-0-platform.md").length, 0);
  assert.equal(sentences(text, ".md", `/home/me/repo/${PLAN}`).length, 1);
  assert.equal(sentences(text, ".md", PLAN.replaceAll("/", "\\")).length, 1);
});

test("code doesn't count: fenced blocks, inline code and table rows in the plan", () => {
  const text = "```\n// Start. Then wait.\n```\nThe file `a. B` is here.\n| A. B | C |\n";
  assert.deepEqual(sentences(text, ".md", PLAN), []);
});

test("in the spec, tags read as spaces, so two paragraphs on a line are two sentences", () => {
  assert.deepEqual(sentences("<p>One.</p><p>Two.</p>\n", ".html", SPEC).map(([l]) => l), [1]);
  assert.deepEqual(sentences("<pre>A. B.</pre>\n<code>C. D</code>\n<!-- E. F -->\n", ".html", SPEC), []);
});

test("in the spec, a line with two table cells fails, and one cell per line passes", () => {
  assert.deepEqual(sentences("<tr><td>PBI</td><td>One work item.</td></tr>\n", ".html", SPEC).map(([l]) => l), [1]);
  assert.deepEqual(sentences("<table>\n<tr><td>PBI</td>\n<td>One work item.</td></tr>\n</table>\n", ".html", SPEC), []);
});

test("reflow puts each sentence of a Markdown paragraph on its own line, indented in a list item", () => {
  const text = "Para one. Para two.\n\n- Item one. Item two.\n  1. Deep one. Deep two.\n";
  const out = reflow(text, ".md");
  assert.equal(out, "Para one.\nPara two.\n\n- Item one.\n  Item two.\n  1. Deep one.\n     Deep two.\n");
  assert.deepEqual(sentences(out, ".md", PLAN), []);
});

test("reflow leaves code blocks, table rows and headings alone", () => {
  const text = "```\nA. B.\n```\n| A. B | C |\n";
  assert.equal(reflow(text, ".md"), text);
});

test("reflow doesn't start a line with what Markdown would read as a list item", () => {
  const out = reflow("See step one. 1. Then step two.\n", ".md");
  assert.ok(!/^\s*1\. /m.test(out), out);
});

test("reflow splits HTML sentences and table cells and keeps the text with whitespace collapsed", () => {
  const text = "<table><tr><th>A</th><th>B</th></tr><tr><td>One. Two.</td><td><b>Three.</b> <i>Four.</i></td></tr></table>\n<p>Five.</p><p>Six. <code>x. Y</code> seven.</p>\n<pre>Keep. This.</pre>\n";
  const out = reflow(text, ".html");
  assert.deepEqual(sentences(out, ".html", SPEC), [], out);
  assert.equal(collapse(out), collapse(text));
  assert.ok(out.includes("<pre>Keep. This.</pre>"));
});

test("reflow is stable: a reflowed text reflows to itself", () => {
  const text = "<p>One. Two.</p>\n";
  const once = reflow(text, ".html");
  assert.equal(reflow(once, ".html"), once);
});

test("reflow starts each clause of a sentence on its own line, after a comma, semicolon or colon", () => {
  assert.equal(reflow("Above it, three strips: one, two; three.\n", ".md"), "Above it,\nthree strips:\none,\ntwo;\nthree.\n");
  assert.equal(reflow("- Costs 1,000, at `a, b` most.\n", ".md"), "- Costs 1,000,\n  at `a, b` most.\n");
});

test("reflow leaves an element the spec styles white-space: pre alone", () => {
  const text = "<style>.formula { white-space: pre; }</style>\n<div class=\"formula\">a = max(0, b)\nc = d</div>\n<p>One, two.</p>\n";
  const out = reflow(text, ".html");
  assert.ok(out.includes("<div class=\"formula\">a = max(0, b)\nc = d</div>"), out);
  assert.ok(out.includes("<p>One,\n\ntwo.</p>"), out);
});

test("reflow puts a blank line after each HTML line outside code, comments and tags, once, and none in Markdown", () => {
  const text = "<p>One. Two.</p>\n<pre>a\nb</pre>\n<!-- c\nd -->\n<a\n  href=\"x\">e</a>\n";
  const out = reflow(text, ".html");
  assert.equal(out, "<p>One.\n\nTwo.</p>\n\n<pre>a\nb</pre>\n\n<!-- c\nd -->\n\n<a\n  href=\"x\">e</a>\n");
  assert.equal(reflow(out, ".html"), out);
  assert.equal(reflow("One. Two.\n", ".md"), "One.\nTwo.\n");
});
