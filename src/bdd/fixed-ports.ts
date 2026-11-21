// The fixed port check (PBI 390 AC-3): finds each place in the step definitions that starts a server on, or connects
// to, a port written into the code, so two workers running scenarios at once never collide on one.
//
// It reads each .ts, .mts, .js and .mjs file under features/steps, with its comments blanked out, line by line. A port
// is a whole number from 1024 to 65535 written as a literal. Below 1024 no step's server can listen, so a step that
// names one (port 9 as an upstream that never answers, say) reaches no other worker's server. Three shapes count:
// - a URL to this machine with its port, such as `http://127.0.0.1:7402/v1/floor` or `localhost:7430`: a connect,
//   unless its line builds an Error, whose message names an address and reaches none;
// - a port given by name, `port: 7402`, `PORT: "7400"` or `port = 7402`: a listen when its line starts or listens
//   (listen, serve, start, createServer), else a connect. A constant named for a port, `const PORT = 7402`, is judged
//   by the lines that use it: a connect where a use's line connects, a listen where a use's statement starts or
//   listens, and named at its own line for each;
// - `.listen(7402`: a listen.
// Words in a step's text, `Given("the API on port 7402")`, are none of these, so a scenario may still name its ports.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** One place in a step definition that uses a port fixed in its code. `file` is relative to the root, with `/`. */
export type FixedPort = { file: string; line: number; port: number; use: "listen" | "connect" };

const LOCAL_HOST = String.raw`(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\]|host\.docker\.internal)`;
const URL_PORT = new RegExp(String.raw`(?<![\w.-])${LOCAL_HOST}:(\d{1,5})(?!\d)`, "g");
const NAMED_PORT = /(?<![\w$])(\w*port)\s*[:=]\s*["'`]?(\d{1,5})(?!\d)["'`]?/gi;
const LISTEN_CALL = /\.listen\(\s*(\d{1,5})(?!\d)/g;
const CONST_PORT = /\b(?:const|let|var)\s+(\w*port)\s*(?::\s*\w+\s*)?=\s*["'`]?(\d{1,5})(?!\d)["'`]?/gi;
const LISTENS = /\b(?:listen|serve\w*|start\w*|createServer)\b/i;
const CONNECTS = /\b(?:fetch|request|get|connect|createConnection|Client|Socket|WebSocket|EventSource)\b|:\/\//;

const ERROR_MESSAGE = /\bError\(/;

const isPort = (n: number) => n >= 1024 && n <= 65535;

/** `source` with its comments turned to spaces, keeping every line break, so line numbers stay as they were. */
export function blankComments(source: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote) {
      out += ch;
      if (ch === "\\" && i + 1 < source.length) {
        out += next;
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (; i < stop; i++) out += source[i] === "\n" ? "\n" : " ";
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Every place in one file's source that starts a server on, or connects to, a fixed port. */
export function fixedPortsIn(file: string, source: string): FixedPort[] {
  const lines = blankComments(source).split("\n");
  const found = new Map<string, FixedPort>();
  const add = (line: number, port: number, use: FixedPort["use"]) => {
    if (isPort(port)) found.set(`${line}:${port}:${use}`, { file, line, port, use });
  };
  const constants = new Map<number, { name: string; port: number }>();
  lines.forEach((text, i) => {
    for (const m of text.matchAll(CONST_PORT)) constants.set(i, { name: m[1], port: Number(m[2]) });
  });
  lines.forEach((text, i) => {
    const line = i + 1;
    if (!ERROR_MESSAGE.test(text)) for (const m of text.matchAll(URL_PORT)) add(line, Number(m[1]), "connect");
    for (const m of text.matchAll(LISTEN_CALL)) add(line, Number(m[1]), "listen");
    if (constants.has(i)) return;
    for (const m of text.matchAll(NAMED_PORT)) add(line, Number(m[2]), LISTENS.test(text) ? "listen" : "connect");
  });
  for (const [i, { name, port }] of constants) {
    const use = new RegExp(String.raw`(?<![\w$.])${name}(?![\w$])`);
    // A use's statement may start lines above it, as `startApi({ ... }, PORT)` does, so a use that doesn't connect on
    // its own line is judged with the few lines before it.
    const uses = lines.flatMap((text, j) => (j !== i && use.test(text) ? [{ text, before: lines.slice(Math.max(0, j - 12), j + 1).join("\n") }] : []));
    const connects = uses.some((u) => CONNECTS.test(u.text));
    const listens = uses.some((u) => !CONNECTS.test(u.text) && LISTENS.test(u.before));
    if (listens) add(i + 1, port, "listen");
    if (connects || !listens) add(i + 1, port, "connect");
  }
  return [...found.values()].sort((a, b) => a.line - b.line || a.port - b.port || a.use.localeCompare(b.use));
}

function files(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  return entries
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.(?:m?ts|m?js)$/.test(e.name) ? [join(dir, e.name)] : []));
}

/** Every place under `<root>/features/steps` that starts a server on, or connects to, a fixed port. */
export function findFixedPorts(root: string): FixedPort[] {
  return files(join(root, "features", "steps")).flatMap((path) =>
    fixedPortsIn(relative(root, path).split(sep).join("/"), readFileSync(path, "utf8")),
  );
}
