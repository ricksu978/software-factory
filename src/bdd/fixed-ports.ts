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
// - `.listen(7402`: a listen;
// - a port handed straight to a call, `settle(b, 7403)` or `connect(7403)`, where the call connects or listens: its name
//   is one that does (connect, fetch, listen, serve and the like), or it is a function defined in a step file whose
//   body makes such a call, itself or through another such function, as `settle` does through `answers`. A listen when
//   only listening is reached, else a connect.
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

/** A call that opens a socket or a server itself. A URL only written down, as a scenario port map builds, isn't one. */
const SOCKET_CONNECT = /(?:^|[^\w$])(?:fetch|connect|createConnection)\s*\(|\bhttps?\.(?:get|request)\s*\(|(?:^|[^\w$.])request\s*\(|\bnew\s+(?:\w+\.)?(?:Client|Socket|WebSocket|EventSource)\b/;
const SOCKET_LISTEN = /(?:^|[^\w$])(?:listen|serve|createServer)\s*\(/;
const NAME_CONNECTS = /^(?:fetch|connect|createConnection)$/;
const NAME_LISTENS = /^(?:listen|serve|createServer)$/;
const FUNCTION_DEF = /^(?:export\s+)?(?:(?:async\s+)?function\s*\*?\s*([\w$]+)\s*[(<]|(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[\w$]+)\s*(?::[^=]+)?=>)/;
const CALL = /(?<![\w$])([\w$]+)\s*\(/g;
const PORT_LITERAL = /^\s*(\d{1,5})\s*$/;

/** What each function a step file defines at its top level reaches: a socket's connect, a server's listen, or both. */
export type PortUsers = Map<string, Set<FixedPort["use"]>>;

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

/** `code` (comments already blanked) with the inside of every string turned to spaces, keeping its length. */
function blankStrings(code: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (quote) {
      if (ch === "\\" && i + 1 < code.length) {
        out += "  ";
        i += 1;
      } else if (ch === quote) {
        quote = null;
        out += ch;
      } else out += ch === "\n" ? "\n" : " ";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    out += ch;
  }
  return out;
}

/** Each top-level function in `code` with its body, which runs to the next line that starts at the left margin. */
function functionsIn(code: string): { name: string; body: string }[] {
  const lines = code.split("\n");
  const out: { name: string; body: string }[] = [];
  lines.forEach((text, i) => {
    const m = FUNCTION_DEF.exec(text);
    if (!m) return;
    let j = i + 1;
    while (j < lines.length && !/^[^\s}]/.test(lines[j])) j++;
    out.push({ name: m[1] ?? m[2], body: lines.slice(i, j).join("\n") });
  });
  return out;
}

/** The functions the sources define that connect or listen, themselves or through another such function. */
export function portUsers(sources: string[]): PortUsers {
  const defs = sources.flatMap((src) => functionsIn(blankStrings(blankComments(src))));
  const users: PortUsers = new Map();
  for (const { name, body } of defs) {
    const uses = new Set<FixedPort["use"]>();
    if (SOCKET_CONNECT.test(body)) uses.add("connect");
    if (SOCKET_LISTEN.test(body)) uses.add("listen");
    if (uses.size) users.set(name, uses);
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const { name, body } of defs) {
      const uses = users.get(name) ?? new Set<FixedPort["use"]>();
      const before = uses.size;
      for (const m of body.matchAll(CALL)) if (m[1] !== name) for (const u of users.get(m[1]) ?? []) uses.add(u);
      if (uses.size > before) {
        users.set(name, uses);
        grew = true;
      }
    }
  }
  return users;
}

/** The top-level arguments of the call whose `(` is at `open`, each with its offset, or null when it never closes. */
function callArgs(code: string, open: number): { text: string; at: number }[] | null {
  const args: { text: string; at: number }[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) {
        args.push({ text: code.slice(start, i), at: start });
        return args;
      }
    } else if (ch === "," && depth === 1) {
      args.push({ text: code.slice(start, i), at: start });
      start = i + 1;
    }
  }
  return null;
}

/** The use a call to `name` makes of a port handed to it, or none when it neither connects nor listens. */
function callUse(name: string, users: PortUsers): FixedPort["use"] | null {
  const uses = new Set(users.get(name) ?? []);
  if (NAME_CONNECTS.test(name)) uses.add("connect");
  if (NAME_LISTENS.test(name)) uses.add("listen");
  if (!uses.size) return null;
  return uses.has("connect") ? "connect" : "listen";
}

/**
 * Every place in one file's source that starts a server on, or connects to, a fixed port. `users` names the functions
 * that connect or listen; by default it is the ones this file defines, and the whole check passes those of every step file.
 */
export function fixedPortsIn(file: string, source: string, users: PortUsers = portUsers([source])): FixedPort[] {
  const blanked = blankComments(source);
  const lines = blanked.split("\n");
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
  const code = blankStrings(blanked);
  for (const m of code.matchAll(CALL)) {
    const use = callUse(m[1], users);
    if (!use) continue;
    for (const arg of callArgs(code, m.index + m[0].length - 1) ?? []) {
      const lit = PORT_LITERAL.exec(arg.text);
      if (lit) add(code.slice(0, arg.at + arg.text.indexOf(lit[1])).split("\n").length, Number(lit[1]), use);
    }
  }
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
  const sources = files(join(root, "features", "steps")).map((path) => ({ path, source: readFileSync(path, "utf8") }));
  const users = portUsers(sources.map((s) => s.source));
  return sources.flatMap(({ path, source }) => fixedPortsIn(relative(root, path).split(sep).join("/"), source, users));
}
