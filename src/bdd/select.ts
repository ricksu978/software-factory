// Which scenarios a repo's bdd.run selects (PBI 185). A bdd.run can leave scenarios out with cucumber-js's
// `--tags <expression>`, as this repo's does with `--tags "not @local"`, so Red expects only the scenarios that
// expression selects from the ones bdd.parse lists. The command is split into words as a POSIX shell splits them,
// and into commands at unquoted `;`, `&`, `|` and newlines (so `&&` and `||` too). Only the words cucumber-js gets
// are read: those after a `cucumber-js` word, or after the `--` of `npm run <script>` (after the script name for
// pnpm and yarn), since a `-t` before them, as in `docker run -t app npx cucumber-js`, belongs to another program.
// A command with neither, such as a wrapper script, has every word read.
// Every `--tags`, `--tags=` or `-t` among them is read. cucumber-js ANDs repeated ones, so this does too. A filter
// set anywhere else, such as a profile in a cucumber config file, isn't seen, and Red then expects every scenario.
// So is an expression the shell expands, one with an unquoted or double-quoted `$` or backtick, as in
// `--tags "$BDD_TAGS"` or `--tags "$(cat tags.txt)"`: its text isn't known until the shell runs it.
import { parse } from "@cucumber/tag-expressions";

/** A word as the shell splits it, and whether the shell expands part of it (an unquoted or double-quoted `$` or backtick). */
interface Word {
  text: string;
  expands: boolean;
}

/**
 * The simple commands a POSIX shell splits `command` into at unquoted `;`, `&`, `|` and newlines, each as the words
 * it splits into, with quotes and backslash escapes removed.
 */
function segments(command: string): Word[][] {
  const out: Word[][] = [];
  let seg: Word[] = [];
  let word: Word | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (/[;&|\n]/.test(ch)) {
      if (word !== null) seg.push(word);
      word = null;
      if (seg.length) out.push(seg);
      seg = [];
      continue;
    }
    if (/\s/.test(ch)) {
      if (word !== null) seg.push(word);
      word = null;
      continue;
    }
    word ??= { text: "", expands: false };
    if (ch === "\\" && i + 1 < command.length) word.text += command[++i];
    else if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      const stop = end < 0 ? command.length : end;
      word.text += command.slice(i + 1, stop);
      i = stop;
    } else if (ch === '"') {
      for (i++; i < command.length && command[i] !== '"'; i++) {
        if (command[i] === "\\" && /["\\$`]/.test(command[i + 1] ?? "")) i++;
        else if (command[i] === "$" || command[i] === "`") word.expands = true;
        word.text += command[i];
      }
    } else {
      if (ch === "$" || ch === "`") word.expands = true;
      word.text += ch;
    }
  }
  if (word !== null) seg.push(word);
  if (seg.length) out.push(seg);
  return out;
}

/**
 * The index of the first word in `seg` that cucumber-js, or the npm script that runs it, gets as an argument, or -1
 * if `seg` runs neither.
 */
function cucumberArgs(words: Word[]): number {
  const seg = words.map((w) => w.text);
  const bin = seg.findIndex((w) => /(^|\/)cucumber-js$/.test(w));
  if (bin >= 0) return bin + 1;
  const pm = seg.findIndex((w) => /(^|\/)(npm|pnpm|yarn)$/.test(w));
  if (pm < 0) return -1;
  const run = seg.indexOf("run", pm + 1);
  if (run < 0 || run + 1 >= seg.length) return -1;
  const dashes = seg.indexOf("--", run + 2);
  if (dashes >= 0) return dashes + 1;
  // npm takes flags before `--` as its own, so its script gets no arguments; pnpm and yarn pass what follows the
  // script name to the script.
  return /(^|\/)npm$/.test(seg[pm]!) ? seg.length : run + 2;
}

/** The tag expressions `command` passes to cucumber-js. */
export function tagFilters(command: string): string[] {
  const segs = segments(command);
  const runs = segs.map((seg) => ({ seg, start: cucumberArgs(seg) })).filter((r) => r.start >= 0);
  // A command that runs its scenarios some other way, such as a wrapper script, has every word read, as no word can
  // be told to be another program's.
  if (runs.length === 0) return segs.flatMap(tagsIn);
  return runs.flatMap((r) => tagsIn(r.seg.slice(r.start)));
}

// An expression the shell expands is skipped: its text isn't known here, so, as with a filter in a config profile,
// Red expects every scenario rather than reading `$BDD_TAGS` as a tag expression.
function tagsIn(w: Word[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < w.length; i++) {
    const { text } = w[i]!;
    if ((text === "--tags" || text === "-t") && i + 1 < w.length) {
      const expr = w[++i]!;
      if (!expr.expands) out.push(expr.text);
    } else if (text.startsWith("--tags=") && !w[i]!.expands) out.push(text.slice("--tags=".length));
  }
  return out;
}

/** Whether `command` selects a scenario with these tags. Throws, naming the expression, if one doesn't parse. */
export function selects(command: string): (tags: string[]) => boolean {
  const nodes = tagFilters(command).map((expr) => {
    try {
      return parse(expr);
    } catch (e) {
      throw new Error(`bdd.run's tag expression "${expr}" doesn't parse: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  return (tags) => nodes.every((n) => n.evaluate(tags));
}
