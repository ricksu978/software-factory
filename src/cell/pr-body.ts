const ALONE = "Reply with the PR body alone, with nothing before or after it: no note to the reader and no fenced block around it.";

/**
 * The open-pr agent call's result, cleaned as cleanSummary does. A failed call wrote no PR body, so its finding says the
 * call failed, with the first line of what it reported, instead of blaming the body it never wrote.
 */
export function summaryOf(reply: { ok: boolean; text: string }): { body: string } | { finding: string } {
  if (reply.ok) return cleanSummary(reply.text);
  const said = reply.text.trim().split("\n", 1)[0]!.slice(0, 200);
  return { finding: `The open-pr agent call failed${said ? ` (${JSON.stringify(said)})` : ""}, so it wrote no PR body. ${ALONE}` };
}

/**
 * PBI 216: the open-pr agent's reply, cleaned into the summary part of the PR body. A reply that already starts with a
 * `## Problem` heading is the body as it is. Otherwise, a reply that wraps the body in a fenced block keeps only the
 * fence's contents, and the text before the first `## ` heading is dropped. A reply that still doesn't start with a
 * `## Problem` heading gives a finding instead, which fails the open-pr attempt and goes into its retry's brief. So does
 * a body that leaves a code block open (PBI 291), since its stray fence would swallow the rest of the PR body.
 */
export function cleanSummary(reply: string): { body: string } | { finding: string } {
  const PROBLEM = /^## Problem[ \t]*(\n|$)/;
  const trimmed = reply.trim();
  if (PROBLEM.test(trimmed)) return balanced(trimmed);
  const text = unwrap(trimmed);
  const at = text.search(/^## /m);
  const body = at < 0 ? "" : text.slice(at).trim();
  if (PROBLEM.test(body)) return balanced(body);
  const first = (body || trimmed).split("\n", 1)[0]!.slice(0, 80);
  return {
    finding: `The PR body must start with a \`## Problem\` heading, and this reply ${body ? "starts with" : "has no `## ` heading, and starts with"} ${JSON.stringify(first)}. ${ALONE}`,
  };
}

/** The body, or a finding when one of its code blocks never closes. */
function balanced(body: string): { body: string } | { finding: string } {
  const open = blocksOf(body.split("\n")).find((b) => b.to === null);
  if (!open) return { body };
  return { finding: `The PR body leaves a code block open: the fence on its line ${open.from + 1} never closes. ${ALONE}` };
}

const OPENING = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CLOSING = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** A fence line that can open a block. A backtick fence's info string can't hold a backtick (CommonMark 4.5). */
function opening(line: string): { char: string; len: number; info: string } | null {
  const m = OPENING.exec(line);
  if (!m || (m[1]![0] === "`" && m[2]!.includes("`"))) return null;
  return { char: m[1]![0]!, len: m[1]!.length, info: m[2]!.trim() };
}

/** The fenced blocks in the lines, by first and last line. A block that never closes has `to: null`. */
function blocksOf(lines: string[]): { from: number; to: number | null }[] {
  const blocks: { from: number; to: number | null }[] = [];
  let open: { char: string; len: number; from: number } | null = null;
  lines.forEach((line, i) => {
    if (!open) {
      const o = opening(line);
      if (o) open = { char: o.char, len: o.len, from: i };
      return;
    }
    if (closes(line, open)) {
      blocks.push({ from: open.from, to: i });
      open = null;
    }
  });
  if (open) blocks.push({ from: (open as { from: number }).from, to: null });
  return blocks;
}

/**
 * The body inside the reply's wrapper fence, when every `## ` heading in the reply sits inside it. Else the reply. A
 * wrapper whose first fence line has a `markdown` or `md` info string, or none, runs to its own closing fence (see
 * wrapperEnd), so code blocks inside it are kept (PBI 291) and a note after it, code blocks and all, is left out (PBI
 * 297). A wrapper that never closes that way runs to the reply's last line that holds only a fence, so a code block it
 * leaves open still gives balanced's finding. Any other reply with one fenced block keeps that block.
 */
function unwrap(text: string): string {
  const lines = text.split("\n");
  const inside = (from: number, to: number) => {
    const outside = [...lines.slice(0, from), ...lines.slice(to + 1)];
    return outside.some((l) => l.startsWith("## ")) ? null : lines.slice(from + 1, to).join("\n");
  };
  const from = lines.findIndex((l) => opening(l) !== null);
  if (from >= 0) {
    const o = opening(lines[from]!)!;
    if (["", "markdown", "md"].includes(o.info.toLowerCase())) {
      let to = wrapperEnd(lines, from, o);
      if (to < 0) to = lines.findLastIndex((l) => closes(l, o));
      const body = to > from ? inside(from, to) : null;
      if (body !== null) return body;
    }
  }
  const blocks = blocksOf(lines);
  if (blocks.length !== 1) return text;
  return inside(blocks[0]!.from, blocks[0]!.to ?? lines.length) ?? text;
}

/** Whether the line holds only a fence that closes a block its opening fence `o` opened. */
function closes(line: string, o: { char: string; len: number }): boolean {
  const m = CLOSING.exec(line);
  return m !== null && m[1]![0] === o.char && m[1]!.length >= o.len;
}

/**
 * PBI 297: the line that closes the wrapper opened on line `from`, or -1. It's the first fence-only line that leaves no
 * code block inside the wrapper open. Such a line could open a bare code block inside the body instead, so it's taken as
 * one only when the body shows it: a `## ` heading follows it, or the block it would open closes just before another
 * fence-only line that would close the wrapper. Nothing else is a signal the wrapper's own closing fence can't give, so
 * a bare inner block followed by plain text and no heading closes the wrapper early, and a note after the wrapper is
 * left out however it's spaced.
 */
function wrapperEnd(lines: string[], from: number, wrapper: { char: string; len: number }): number {
  let inner: { char: string; len: number } | null = null;
  for (let i = from + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (inner) {
      if (closes(line, inner)) inner = null;
      continue;
    }
    if (closes(line, wrapper) && !opensBareBlock(lines, i, wrapper)) return i;
    const o = opening(line);
    if (o) inner = o;
  }
  return -1;
}

/** Whether the fence-only line `i` reads as opening a bare code block inside the wrapper, as wrapperEnd describes. */
function opensBareBlock(lines: string[], i: number, wrapper: { char: string; len: number }): boolean {
  if (lines.slice(i + 1).some((l) => l.startsWith("## "))) return true;
  const own = opening(lines[i]!)!;
  const end = lines.findIndex((l, j) => j > i && closes(l, own));
  if (end < 0) return false;
  const next = lines.slice(end + 1).find((l) => l.trim() !== "");
  return next !== undefined && closes(next, wrapper);
}
