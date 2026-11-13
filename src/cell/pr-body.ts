/**
 * PBI 216: the open-pr agent's reply, cleaned into the summary part of the PR body. A reply that already starts with a
 * `## Problem` heading is the body as it is. Otherwise, a reply that wraps the body in one fenced block keeps only the
 * fence's contents, and the text before the first `## ` heading is dropped. A reply that still doesn't start with a
 * `## Problem` heading gives a finding instead, which fails the open-pr attempt and goes into its retry's brief.
 */
export function cleanSummary(reply: string): { body: string } | { finding: string } {
  const PROBLEM = /^## Problem[ \t]*(\n|$)/;
  const trimmed = reply.trim();
  if (PROBLEM.test(trimmed)) return { body: trimmed };
  const text = unwrap(trimmed);
  const at = text.search(/^## /m);
  const body = at < 0 ? "" : text.slice(at).trim();
  if (PROBLEM.test(body)) return { body };
  const first = (body || trimmed).split("\n", 1)[0]!.slice(0, 80);
  return {
    finding: `The PR body must start with a \`## Problem\` heading, and this reply's ${body ? "starts with" : "has no `## ` heading, and starts with"} ${JSON.stringify(first)}. Reply with the PR body alone, with nothing before or after it: no note to the reader and no fenced block around it.`,
  };
}

/** The contents of the reply's one fenced block, when every `## ` heading in the reply sits inside it. Else the reply. */
function unwrap(text: string): string {
  const lines = text.split("\n");
  const blocks: { from: number; to: number }[] = [];
  let open: { char: string; len: number; from: number } | null = null;
  lines.forEach((line, i) => {
    if (!open) {
      const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      // A backtick fence's info string can't hold a backtick (CommonMark 4.5).
      if (m && !(m[1]![0] === "`" && m[2]!.includes("`"))) open = { char: m[1]![0]!, len: m[1]!.length, from: i };
      return;
    }
    const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
    if (m && m[1]![0] === open.char && m[1]!.length >= open.len) {
      blocks.push({ from: open.from, to: i });
      open = null;
    }
  });
  // An unclosed fence runs to the end of the reply.
  if (open) blocks.push({ from: (open as { from: number }).from, to: lines.length });
  if (blocks.length !== 1) return text;
  const { from, to } = blocks[0]!;
  const outside = [...lines.slice(0, from), ...lines.slice(to + 1)];
  if (outside.some((l) => l.startsWith("## "))) return text;
  return lines.slice(from + 1, to).join("\n");
}
