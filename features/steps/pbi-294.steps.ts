// Step definitions for features/pbi-294-one-sentence-per-line.feature.
// - AC-1 reads the spec and the plan in the working tree and checks them with this file's own sentence finder, not the
//   prose lint's, so the layout is checked apart from the code that enforces it. A sentence ends at ".", "!" or "?",
//   after any closing quote or bracket, followed by whitespace and a capital, a digit, "§" or an opening quote or
//   bracket. "e.g.", "i.e.", "etc.", "vs.", "cf." and a lone capital initial don't end one. Code is left out: fenced
//   blocks, inline code (read as a word, so a sentence that starts with code still counts), and in the spec <pre>,
//   <code>, <script>, <style> and comments. HTML tags read as spaces. A Markdown list marker or blockquote marker at
//   the start of a line isn't a sentence end, and a Markdown table row is left out, since its cells can't span lines.
// - The before-text is features/fixtures/pbi-294/before-text.json. Both sides compare with whitespace collapsed, and
//   whitespace between two tags dropped, since "</td><td>" and "</td>\n<td>" render the same, and whitespace before a
//   <cite> dropped, since the spec shows a blockquote's <cite> as a block. Its "added" field holds the passages this
//   item adds to describe its own rule, as the Definition of Done asks, each put in after an anchor before comparing.
// - AC-2 copies every .md and .html file git knows, with scripts/prose-lint.mjs, to a temp directory and runs the lint
//   there the way .github/workflows/prose.yml does, then reads its "<file>:<line>: <message>" findings.
// - AC-3 replays the committed inputs under features/fixtures/pbi-294/replay/ through scripts/merge-replay.ts, and reads
//   the count the PR cites from features/fixtures/pbi-294/replay-result.json.
// - AC-4 reads the TypeScript source and walks it, tracking brackets, to find where each entry of a list starts.
import { After, Given, Then, When, type DataTable } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { replay, type MergeResult } from "../../scripts/merge-replay.ts";

const repo = process.cwd();
const SPEC = "docs/superpowers/specs/2026-11-05-software-factory-design.html";
const PLAN = "docs/superpowers/plans/2026-11-05-phase-0-walking-skeleton.md";
const FIXTURES = "features/fixtures/pbi-294";
const RESULT = `${FIXTURES}/replay-result.json`;
const DOCS = { spec: SPEC, plan: PLAN } as const;
type Doc = keyof typeof DOCS;

type Added = { after: string; text: string };
type Before = { spec: string; plan: string; planCodeBlocks: string[][]; added?: Partial<Record<Doc, Added[]>> };
type Finding = { file: string; line: number; message: string };
type Lint = { status: number | null; output: string; findings: Finding[] };
type Entry = { name: string; line: number };

type Ctx = {
  /** The documents the last "I read" step read, by name. */
  read: Partial<Record<Doc, string>>;
  /** The repo copy the Given steps changed. */
  copy?: string;
  /** Every temp directory to remove after the scenario. */
  temps: string[];
  /** The last lint run on the copy or the repo. */
  lint?: Lint;
  /** The line number, in the copy's plan, of the line a Given put inside a code block. */
  codeLine?: number;
  /** The file merges the replay replayed. */
  merges?: MergeResult[];
  /** The replay inputs' directory. */
  inputs?: string;
  /** The entries of the list or type the last AC-4 "When" read, and, for fakeRepoHost, its return type's members. */
  entries?: Entry[];
  declared?: Entry[];
};

function ctx(world: object): Ctx {
  const w = world as { pbi294?: Ctx };
  w.pbi294 ??= { read: {}, temps: [] };
  return w.pbi294;
}

After({ tags: "@pbi-294" }, function () {
  for (const dir of (this as { pbi294?: Ctx }).pbi294?.temps ?? []) rmSync(dir, { recursive: true, force: true });
});

// ---- Sentences ----

const blank = (m: string) => m.replace(/[^\n]/g, " ");
/** Inline code reads as one word, padded to keep columns. */
const word = (m: string) => (m.includes("\n") ? blank(m) : "Code".padEnd(m.length, " ").slice(0, Math.max(m.length, 1)));
const ABBREVIATION = /(?:\b(?:e\.g|i\.e|etc|vs|cf)|(?:^|[\s(])[A-Z])$/;
const SENTENCE_END = /([.!?])['"”’)\]]*\s+(?=['"“‘(\[]*[A-Z0-9§])/g;

/** Where each sentence after the first starts in `text`. */
export function sentenceBreaks(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(SENTENCE_END)) {
    if (m[1] === "." && ABBREVIATION.test(text.slice(0, m.index))) continue;
    out.push(m.index! + m[0].length);
  }
  return out;
}

/** The doc's lines with code left out, line for line, and tags read as spaces in HTML. */
function proseLines(text: string, html: boolean): string[] {
  let t = text.replace(/```[\s\S]*?```/g, blank).replace(/`[^`\n]*`/g, word);
  if (html) {
    t = t
      .replace(/<(pre|code|script|style)\b[\s\S]*?<\/\1>/gi, word)
      .replace(/<!--[\s\S]*?-->/g, blank)
      .replace(/<[^>\n]*>/g, blank);
  }
  return t.split("\n");
}

/** Each line of the doc outside code that holds more than one sentence, as "<line>: <text>". */
function multiSentenceLines(text: string, html: boolean): string[] {
  const out: string[] = [];
  proseLines(text, html).forEach((line, i) => {
    if (!html && /^\s*\|/.test(line)) return;
    const body = line.replace(/^\s*(?:>\s*)*(?:(?:[-*+]|\d+\.)\s+)?(?:\[[ x]\]\s+)?/, "");
    if (sentenceBreaks(body).length) out.push(`${i + 1}: ${line.trim().replace(/\s+/g, " ").slice(0, 140)}`);
  });
  return out;
}

// Whitespace before a <cite> is dropped too: the spec styles "blockquote cite" as a block, so a line break between a
// quote's closing mark and its <cite> renders the same, and it's the only place such a quote's last sentence can end a line.
const collapse = (s: string) => s.replace(/\s+/g, " ").trim().replace(/> </g, "><").replace(/ <cite>/g, "<cite>");

function before(): Before {
  const path = join(repo, FIXTURES, "before-text.json");
  assert.ok(existsSync(path), `the before-text ${FIXTURES}/before-text.json isn't in the repo`);
  return JSON.parse(readFileSync(path, "utf8")) as Before;
}

/** Each fenced code block in a Markdown text, fences included, line by line. */
function codeBlocks(text: string): string[][] {
  const blocks: string[][] = [];
  let open: string[] | null = null;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      if (open) {
        open.push(line);
        blocks.push(open);
        open = null;
      } else open = [line];
    } else open?.push(line);
  }
  return blocks;
}

const readDoc = (doc: Doc) => readFileSync(join(repo, DOCS[doc]), "utf8");

When("I read the spec", function () {
  ctx(this).read = { spec: readDoc("spec") };
});

When("I read the plan", function () {
  ctx(this).read = { plan: readDoc("plan") };
});

When("I read the spec's tables", function () {
  ctx(this).read = { spec: readDoc("spec") };
});

When("I read the spec and the plan", function () {
  ctx(this).read = { spec: readDoc("spec"), plan: readDoc("plan") };
});

function noMultiSentenceLine(this: object) {
  const read = ctx(this).read;
  const docs = Object.keys(read) as Doc[];
  assert.ok(docs.length, "no document was read");
  for (const doc of docs) {
    const lines = multiSentenceLines(read[doc]!, doc === "spec");
    assert.equal(lines.length, 0, `${lines.length} lines of ${DOCS[doc]} hold more than one sentence, such as:\n${lines.slice(0, 10).join("\n")}`);
  }
}

Then("no line outside code holds more than one sentence", noMultiSentenceLine);
Then("no line outside code blocks holds more than one sentence", noMultiSentenceLine);

Then(/^(?:its|the spec's) text, with whitespace collapsed, is the same as the before-text for the (spec|plan)$/, function (doc: Doc) {
  const text = ctx(this).read[doc] ?? readDoc(doc);
  const now = collapse(text);
  const was = withAdded(doc);
  if (now === was) return;
  let i = 0;
  while (now[i] === was[i]) i++;
  assert.fail(`${DOCS[doc]} differs from its before-text at character ${i}:\n  now: ${now.slice(Math.max(0, i - 60), i + 60)}\n  was: ${was.slice(Math.max(0, i - 60), i + 60)}`);
});

Then("every sentence in the before-text for each file is still in it, word for word", function () {
  const read = ctx(this).read;
  for (const doc of ["spec", "plan"] as Doc[]) {
    const now = collapse(read[doc] ?? readDoc(doc));
    // With the added passages in, since the spec's goes between two table rows, which a sentence here can span.
    const text = withAdded(doc);
    const starts = [0, ...sentenceBreaks(text), text.length];
    const missing: string[] = [];
    for (let i = 0; i + 1 < starts.length; i++) {
      const sentence = text.slice(starts[i], starts[i + 1]).trim();
      if (sentence && !now.includes(sentence)) missing.push(sentence.slice(0, 140));
    }
    assert.equal(missing.length, 0, `${missing.length} sentences of the before-text for ${DOCS[doc]} aren't in it, such as:\n${missing.slice(0, 5).join("\n")}`);
  }
});

Then("every code block in it is the same, line for line, as in the before-text for the plan", function () {
  const now = codeBlocks(ctx(this).read.plan ?? readDoc("plan"));
  assert.deepEqual(now, before().planCodeBlocks);
});

/**
 * The before-text for a doc, whitespace collapsed, with the passages this item adds to describe its own rule put in.
 * Each goes right after its anchor, which must occur once, so the rest of the file still has to match the before-text.
 */
function withAdded(doc: Doc): string {
  const b = before();
  let was = collapse(b[doc]);
  for (const { after, text } of b.added?.[doc] ?? []) {
    const at = was.indexOf(after);
    assert.ok(at >= 0 && was.indexOf(after, at + 1) < 0, `the anchor for an added passage in ${DOCS[doc]} isn't once in its before-text: ${after}`);
    was = was.slice(0, at + after.length) + text + was.slice(at + after.length);
  }
  return was;
}

// ---- Table cells ----

/** The spec's lines with code and comments blanked, keeping tags. */
const markupLines = (text: string) =>
  text.replace(/<(pre|code|script|style)\b[\s\S]*?<\/\1>/gi, blank).replace(/<!--[\s\S]*?-->/g, blank).split("\n");

const CELL = /<t[dh](?=[\s>])/gi;

Then("every table cell starts on a line of its own", function () {
  const spec = ctx(this).read.spec;
  assert.ok(spec, "the spec wasn't read");
  const bad: string[] = [];
  markupLines(spec).forEach((line, i) => {
    for (const m of line.matchAll(CELL)) {
      const lead = line.slice(0, m.index).replace(/<tr\b[^>]*>/gi, "").trim();
      if (lead) bad.push(`${i + 1}: ${line.trim().slice(0, 140)}`);
    }
  });
  assert.equal(bad.length, 0, `${bad.length} table cells of ${SPEC} don't start their own line, such as:\n${bad.slice(0, 10).join("\n")}`);
});

Then("no line holds the end of one table cell and the start of the next", function () {
  const spec = ctx(this).read.spec;
  assert.ok(spec, "the spec wasn't read");
  const bad: string[] = [];
  markupLines(spec).forEach((line, i) => {
    if (/<\/t[dh]>.*<t[dh](?=[\s>])/i.test(line)) bad.push(`${i + 1}: ${line.trim().slice(0, 140)}`);
  });
  assert.equal(bad.length, 0, `${bad.length} lines of ${SPEC} end one table cell and start the next, such as:\n${bad.slice(0, 10).join("\n")}`);
});

// ---- The prose lint ----

/** Every .md and .html file git knows in the repo, tracked or new, as the lint's CI job lists them. */
function docFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "*.md", "*.html"], { cwd: repo, encoding: "utf8" });
  return [...new Set(out.split("\n").filter(Boolean))].filter((f) => existsSync(join(repo, f)));
}

/** A temp copy of the repo's docs and its prose lint. */
function makeCopy(c: Ctx): string {
  const dir = mkdtempSync(join(tmpdir(), "pbi294-"));
  c.temps.push(dir);
  for (const f of [...docFiles(), "scripts/prose-lint.mjs"]) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    copyFileSync(join(repo, f), join(dir, f));
  }
  return dir;
}

function setLine(dir: string, path: string, n: number, text: string) {
  const lines = readFileSync(join(dir, path), "utf8").split("\n");
  assert.ok(n <= lines.length, `${path} has only ${lines.length} lines`);
  lines[n - 1] = text;
  writeFileSync(join(dir, path), lines.join("\n"));
}

/** Runs the lint in `dir` on every doc there, as .github/workflows/prose.yml runs it. */
function runLint(dir: string): Lint {
  const files = docFiles().filter((f) => existsSync(join(dir, f)));
  const r = spawnSync(process.execPath, ["scripts/prose-lint.mjs", ...files], { cwd: dir, encoding: "utf8" });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const findings: Finding[] = [];
  for (const line of output.split("\n")) {
    const m = /^(.+?):(\d+): (.*)$/.exec(line);
    if (m) findings.push({ file: m[1], line: Number(m[2]), message: m[3] });
  }
  return { status: r.status, output, findings };
}

function copy(c: Ctx): string {
  c.copy ??= makeCopy(c);
  return c.copy;
}

Given(/^a copy of the repo where line (\d+) of the (spec|plan) holds "(.*)"$/, function (n: string, doc: Doc, text: string) {
  const c = ctx(this);
  setLine(copy(c), DOCS[doc], Number(n), text);
});

Given(/^line (\d+) of the (spec|plan) holds "(.*)"$/, function (n: string, doc: Doc, text: string) {
  const c = ctx(this);
  setLine(copy(c), DOCS[doc], Number(n), text);
});

Given("a copy of the repo where a code block in the plan holds the line {string}", function (text: string) {
  const c = ctx(this);
  const dir = copy(c);
  const lines = readFileSync(join(dir, PLAN), "utf8").split("\n");
  // The first line inside a fenced code block past line 30, clear of the lines other steps set.
  let inside = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) inside = !inside;
    else if (inside && i + 1 > 30) {
      c.codeLine = i + 1;
      break;
    }
  }
  assert.ok(c.codeLine, `${PLAN} has no code block past line 30`);
  setLine(dir, PLAN, c.codeLine, text);
});

Given("a copy of the repo where {string} holds the line {string}", function (path: string, text: string) {
  const c = ctx(this);
  const dir = copy(c);
  const file = join(dir, path);
  assert.ok(existsSync(file), `${path} isn't in the repo`);
  const doc = readFileSync(file, "utf8");
  const end = doc.lastIndexOf("</body>");
  writeFileSync(file, end >= 0 ? `${doc.slice(0, end)}<p>${text}</p>\n${doc.slice(end)}` : `${doc.replace(/\n*$/, "")}\n\n${text}\n`);
});

When("I run the prose lint on the copy", function () {
  const c = ctx(this);
  c.lint = runLint(copy(c));
});

When("I run the prose lint on the repo", function () {
  const c = ctx(this);
  c.lint = runLint(makeCopy(c));
});

function lint(c: Ctx): Lint {
  assert.ok(c.lint, "the lint hasn't run");
  return c.lint;
}

Then("the lint fails", function () {
  const l = lint(ctx(this));
  assert.notEqual(l.status, 0, "the lint passed");
});

Then("the lint passes", function () {
  const l = lint(ctx(this));
  assert.equal(l.status, 0, `the lint failed:\n${l.output}`);
});

const MORE_THAN_ONE = /more than one sentence/i;

Then(/^it reports line (\d+) of the (spec|plan)( as holding more than one sentence)?$/, function (n: string, doc: Doc, sentences?: string) {
  const l = lint(ctx(this));
  const hit = l.findings.some((f) => f.file === DOCS[doc] && f.line === Number(n) && (!sentences || MORE_THAN_ONE.test(f.message)));
  assert.ok(hit, `the lint didn't report line ${n} of ${DOCS[doc]}${sentences ?? ""}. It reported:\n${l.output}`);
});

Then("it doesn't report the line inside the code block", function () {
  const c = ctx(this);
  const l = lint(c);
  assert.ok(c.codeLine, "no line was put inside a code block");
  const hits = l.findings.filter((f) => f.file === PLAN && f.line === c.codeLine);
  assert.equal(hits.length, 0, `the lint reported the line inside the code block:\n${hits.map((f) => f.message).join("\n")}`);
});

Then("it reports no line of {string} as holding more than one sentence", function (path: string) {
  const l = lint(ctx(this));
  const hits = l.findings.filter((f) => f.file === path && MORE_THAN_ONE.test(f.message));
  assert.equal(hits.length, 0, `the lint reported ${path}:\n${hits.map((f) => `${f.line}: ${f.message}`).join("\n")}`);
});

function failsWith(c: Ctx, change: (dir: string) => void) {
  const dir = makeCopy(c);
  change(dir);
  const l = runLint(dir);
  assert.notEqual(l.status, 0, "the lint passed the changed copy");
  assert.ok(l.findings.some((f) => f.file === PLAN && MORE_THAN_ONE.test(f.message)), `the lint didn't report a line of the plan as holding more than one sentence:\n${l.output}`);
}

Then("a copy of the repo with {string} added to the plan fails the lint", function (text: string) {
  failsWith(ctx(this), (dir) => {
    const plan = readFileSync(join(dir, PLAN), "utf8");
    writeFileSync(join(dir, PLAN), `${plan.replace(/\n*$/, "")}\n\n${text}\n`);
  });
});

Then("a copy of the repo with {string} at line {int} of the plan fails the lint", function (text: string, n: number) {
  failsWith(ctx(this), (dir) => setLine(dir, PLAN, n, text));
});

// ---- The merge replay ----

Given("the replay inputs committed in the repo", function () {
  ctx(this).inputs = join(repo, FIXTURES, "replay");
});

When("I replay each file merge with base, ours and theirs in the new layout", function () {
  const c = ctx(this);
  c.merges = replay(c.inputs!, "new");
});

function merges(c: Ctx): MergeResult[] {
  assert.ok(c.merges, "the replay hasn't run");
  return c.merges;
}

Then("{int} file merges were replayed", function (n: number) {
  assert.equal(merges(ctx(this)).length, n);
});

Then("at most {int} of the {int} file merges conflict", function (most: number, n: number) {
  const m = merges(ctx(this));
  assert.equal(m.length, n);
  const conflicted = m.filter((x) => x.conflicted);
  assert.ok(conflicted.length <= most, `${conflicted.length} of ${n} file merges conflict: ${conflicted.map((x) => x.name).join(", ")}`);
});

function result(): { replayed: number; conflicted: number } {
  const path = join(repo, RESULT);
  assert.ok(existsSync(path), `the replay's result file ${RESULT} isn't in the repo`);
  return JSON.parse(readFileSync(path, "utf8"));
}

Then("the replay's result file in the repo states how many of the {int} file merges conflicted", function (n: number) {
  const r = result();
  assert.equal(r.replayed, n, `${RESULT} states ${r.replayed} file merges were replayed`);
  assert.ok(Number.isInteger(r.conflicted) && r.conflicted >= 0 && r.conflicted <= n, `${RESULT} states no count of conflicts`);
});

Then("that count is the one the replay got", function () {
  const got = merges(ctx(this)).filter((x) => x.conflicted).length;
  assert.equal(result().conflicted, got, `${RESULT} states a count the replay didn't get`);
});

// ---- Lists in the code ----

/**
 * The entries of the object literal or type whose "{" is at `open` in `src`: each top-level name followed by ":", "?:",
 * "," or "}", with the line it starts on. With `shorthandOnly`, it stops at the first entry that isn't a bare name, so
 * it reads an object literal's state and stops at its methods.
 */
function entries(src: string, open: number, shorthandOnly = false): Entry[] {
  const out: Entry[] = [];
  const lineAt = (i: number) => src.slice(0, i).split("\n").length;
  let depth = 0;
  let expecting = false;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i + 2) + 1;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i);
      continue;
    }
    if (ch === "=" && src[i + 1] === ">") {
      i++;
      continue;
    }
    if ("{([<".includes(ch)) {
      depth++;
      if (depth === 1) expecting = true;
      continue;
    }
    if ("})]>".includes(ch)) {
      depth--;
      if (depth === 0) break;
      continue;
    }
    if (depth !== 1) continue;
    if (ch === ";" || ch === ",") {
      expecting = true;
      continue;
    }
    if (expecting && /[A-Za-z_$]/.test(ch)) {
      const m = /^([A-Za-z_$][\w$]*)\s*(\??:|,|})?/.exec(src.slice(i))!;
      const after = m[2];
      if (shorthandOnly) {
        if (after !== "," && after !== "}") break;
      } else if (!after || after === "," || after === "}") {
        expecting = false;
        continue;
      }
      out.push({ name: m[1], line: lineAt(i) });
      expecting = false;
      i += m[1].length - 1;
    }
  }
  return out;
}

function source(path: string): string {
  const file = join(repo, path);
  assert.ok(existsSync(file), `${path} isn't in the repo`);
  return readFileSync(file, "utf8");
}

When("I read the list of state that `fakeRepoHost` in {string} returns", function (path: string) {
  const c = ctx(this);
  const src = source(path);
  const start = src.indexOf("export function fakeRepoHost(");
  const typeOpen = src.indexOf("{", src.indexOf("RepoHost &", start));
  c.declared = entries(src, typeOpen);
  const ret = /\n\s*return \{/g;
  ret.lastIndex = start;
  const found = ret.exec(src);
  c.entries = found ? entries(src, found.index + found[0].length - 1, true) : [];
});

When("I read the parameter type of the Floor page in {string}", function (path: string) {
  const c = ctx(this);
  const src = source(path);
  const start = src.indexOf("export function floorPage(");
  c.entries = start < 0 ? [] : entries(src, src.indexOf("{", start));
  c.declared = undefined;
});

Then("each entry sits on a line of its own", function () {
  const list = ctx(this).entries ?? [];
  assert.ok(list.length, "no entries were found");
  const byLine = new Map<number, string[]>();
  for (const e of list) byLine.set(e.line, [...(byLine.get(e.line) ?? []), e.name]);
  const shared = [...byLine].filter(([, names]) => names.length > 1);
  assert.equal(shared.length, 0, `these lines hold more than one entry:\n${shared.map(([l, n]) => `${l}: ${n.join(", ")}`).join("\n")}`);
});

Then("the list holds every piece of state that `fakeRepoHost`'s return type declares", function () {
  const c = ctx(this);
  assert.ok(c.declared?.length, "fakeRepoHost's return type declares no state");
  const have = new Set((c.entries ?? []).map((e) => e.name));
  const missing = c.declared.map((e) => e.name).filter((n) => !have.has(n));
  assert.deepEqual(missing, [], `the list lacks ${missing.join(", ")}`);
});

function holdsAtLeast(this: object, table: DataTable) {
  const have = new Set((ctx(this).entries ?? []).map((e) => e.name));
  const missing = table.raw().flat().map((s) => s.trim()).filter((n) => n && !have.has(n));
  assert.deepEqual(missing, [], `it lacks ${missing.join(", ")}`);
}

Then("the list holds at least these entries:", holdsAtLeast);
Then("the type holds at least these entries:", holdsAtLeast);
