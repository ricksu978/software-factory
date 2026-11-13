// Which scenarios a repo's bdd.run selects (PBI 185). A bdd.run can leave scenarios out with cucumber-js's
// `--tags <expression>`, as this repo's does with `--tags "not @local"`, so Red expects only the scenarios that
// expression selects from the ones bdd.parse lists. The command is split into words as a POSIX shell splits them,
// and every `--tags`, `--tags=` or `-t` is read. cucumber-js ANDs repeated ones, so this does too. A filter set
// anywhere else, such as a profile in a cucumber config file, isn't seen, and Red then expects every scenario.
import { parse } from "@cucumber/tag-expressions";

/** The words a POSIX shell splits `command` into, with quotes and backslash escapes removed. */
function words(command: string): string[] {
  const out: string[] = [];
  let word: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (/\s/.test(ch)) {
      if (word !== null) out.push(word);
      word = null;
      continue;
    }
    word ??= "";
    if (ch === "\\" && i + 1 < command.length) word += command[++i];
    else if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      const stop = end < 0 ? command.length : end;
      word += command.slice(i + 1, stop);
      i = stop;
    } else if (ch === '"') {
      for (i++; i < command.length && command[i] !== '"'; i++) {
        if (command[i] === "\\" && /["\\$`]/.test(command[i + 1] ?? "")) i++;
        word += command[i];
      }
    } else word += ch;
  }
  if (word !== null) out.push(word);
  return out;
}

/** The tag expressions `command` passes to cucumber-js. */
export function tagFilters(command: string): string[] {
  const w = words(command);
  const out: string[] = [];
  for (let i = 0; i < w.length; i++) {
    if ((w[i] === "--tags" || w[i] === "-t") && i + 1 < w.length) out.push(w[++i]!);
    else if (w[i]!.startsWith("--tags=")) out.push(w[i]!.slice("--tags=".length));
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
