// The parameter check `npm run factory` runs before `aspire run` (scripts/factory.ps1 through
// scripts/set-local-secrets.ps1 -MissingOnly), in Node so cells and CI can run it against a fake checkout (PBI 312).
// It reads the parameters the checkout's AppHost (aspire-apphost/apphost.mts) declares, asks the owner for each one
// not yet saved in that checkout's Aspire user secrets, and says whether the start can go on to `aspire run`.
// It takes only the parameters the AppHost declares under `aspire run`. One declared only for a published run, such as
// the BFF's oidc-issuer and oidc-client-secret, is never asked for and never stops the start.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type ParameterKind = "secret" | "plain";
export type DeclaredParameter = { name: string; kind: ParameterKind };

/**
 * The AppHost's source twice over, the same length as it: `code` with comments blanked, for finding declarations, and
 * `bare` with string and template contents blanked too, for reading its structure without a quoted ':' or '{' in the way.
 */
function lex(src: string): { code: string; bare: string } {
  let code = "";
  let bare = "";
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      code += blank(src.slice(i, stop));
      bare += blank(src.slice(i, stop));
      i = stop;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      code += blank(src.slice(i, stop));
      bare += blank(src.slice(i, stop));
      i = stop;
    } else if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      const stop = Math.min(j + 1, src.length);
      code += src.slice(i, stop);
      bare += c + blank(src.slice(i + 1, stop - 1)) + (stop - i > 1 ? c : "");
      i = stop;
    } else {
      code += c;
      bare += c;
      i++;
    }
  }
  return { code, bare };
}

const OPEN = "([{";
const CLOSE = ")]}";

/** The index of the bracket that closes the one at `open` in `bare`, or the end of the source. */
function closing(bare: string, open: number): number {
  let depth = 0;
  for (let i = open; i < bare.length; i++) {
    if (OPEN.includes(bare[i]!)) depth++;
    else if (CLOSE.includes(bare[i]!) && --depth === 0) return i;
  }
  return bare.length;
}

/**
 * The ranges of the AppHost's source that run only outside `aspire run`: the publish arm of a `runMode ? … : …`
 * ternary (the first arm of a `!runMode ? … : …` one), the `else` block of an `if (runMode) { … }`, and the block of
 * an `if (!runMode) { … }`.
 */
function publishOnlyRanges(bare: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (const m of bare.matchAll(/(!\s*)?\brunMode\s*\?(?![.?])/g)) {
    const start = m.index + m[0].length;
    let depth = 0;
    let nested = 0;
    let colon = -1;
    let end = bare.length;
    for (let i = start; i < bare.length; i++) {
      const c = bare[i]!;
      if (OPEN.includes(c)) depth++;
      else if (CLOSE.includes(c)) {
        if (depth === 0) { end = i; break; }
        depth--;
      } else if (depth === 0 && c === "?" && bare[i + 1] !== "." && bare[i + 1] !== "?") nested++;
      else if (depth === 0 && c === ":") {
        if (colon === -1 && nested === 0) colon = i;
        else if (nested > 0) nested--;
      } else if (depth === 0 && (c === ";" || c === ",") && colon !== -1) { end = i; break; }
    }
    if (colon === -1) continue;
    ranges.push(m[1] ? [start, colon] : [colon + 1, end]);
  }
  for (const m of bare.matchAll(/\bif\s*\(\s*(!\s*)?runMode\s*\)\s*\{/g)) {
    const open = m.index + m[0].length - 1;
    const close = closing(bare, open);
    if (m[1]) {
      ranges.push([open, close]);
      continue;
    }
    const after = /^\s*else\s*\{/.exec(bare.slice(close + 1));
    if (after) {
      const elseOpen = close + after[0].length;
      ranges.push([elseOpen, closing(bare, elseOpen)]);
    }
  }
  return ranges;
}

/**
 * The parameters `npm run factory` asks for: the ones the AppHost's source declares under `aspire run`, in the order
 * the start asks for them, secrets first, then plain parameters. Secrets are the ones declared through apphost.mts's
 * secret() helper. A declaration only outside `aspire run`, such as the BFF's `oidc-issuer`, isn't one (PBI 312).
 */
export function declaredParameters(appHostSource: string): DeclaredParameter[] {
  const { code, bare } = lex(appHostSource);
  const publishOnly = publishOnlyRanges(bare);
  const local = (at: number) => !publishOnly.some(([from, to]) => at >= from && at < to);
  const found = (re: RegExp) => [...code.matchAll(re)].filter((m) => local(m.index)).map((m) => m[1]!);
  return [
    ...found(/\bsecret\('([\w-]+)'\)/g).map((name) => ({ name, kind: "secret" as const })),
    ...found(/\baddParameter\('([\w-]+)'/g).map((name) => ({ name, kind: "plain" as const })),
  ];
}

export type ParameterCheckDeps = {
  /** The checkout whose aspire-apphost/apphost.mts declares the parameters. */
  checkout: string;
  /** That checkout's Aspire user secrets file, as `aspire secret path` gives it. It may not exist yet. */
  secretsFile: string;
  /** Asks the owner for `name`. An empty answer keeps it as it is. */
  ask(name: string, kind: ParameterKind, state: "set" | "missing"): Promise<string>;
  say(line: string): void;
};

/** Asks for each declared parameter not yet saved, saves the answers, and resolves to whether every one is set. */
export async function checkLocalParameters(deps: ParameterCheckDeps): Promise<boolean> {
  const src = readFileSync(join(deps.checkout, "aspire-apphost", "apphost.mts"), "utf8");
  const params = declaredParameters(src);
  if (params.length === 0) throw new Error(`no parameters found in ${deps.checkout}/aspire-apphost/apphost.mts`);

  const store: Record<string, unknown> = existsSync(deps.secretsFile)
    ? ((JSON.parse(readFileSync(deps.secretsFile, "utf8") || "null") as Record<string, unknown> | null) ?? {})
    : {};
  const has = (name: string) => Object.hasOwn(store, `Parameters:${name}`);

  deps.say(`Secrets file: ${deps.secretsFile}`);
  let changed = false;
  for (const { name, kind } of params) {
    if (has(name)) continue;
    const value = await deps.ask(name, kind, "missing");
    if (value) {
      store[`Parameters:${name}`] = value;
      changed = true;
      deps.say("  saved");
    } else deps.say("  kept");
  }

  // Written only when a value changed, so a run that asks nothing never rewrites the live token file.
  if (changed) {
    mkdirSync(dirname(deps.secretsFile), { recursive: true });
    writeFileSync(deps.secretsFile, JSON.stringify(store, null, 2));
  }
  const missing = params.map((p) => p.name).filter((n) => !has(n));
  if (missing.length) {
    deps.say(`Still missing: ${missing.join(", ")}`);
    return false;
  }
  deps.say(`All ${params.length} parameters are set.`);
  return true;
}

// `node src/apphost/local-parameters.ts <checkout>` prints a line `<kind> <name>` for each parameter the checkout's
// AppHost declares under `aspire run`, in the order the start asks for them. scripts/set-local-secrets.ps1 reads it,
// so `npm run factory` asks for the same parameters this check does.
if (import.meta.main) {
  const checkout = process.argv[2] ?? join(import.meta.dirname, "..", "..");
  for (const { kind, name } of declaredParameters(readFileSync(join(checkout, "aspire-apphost", "apphost.mts"), "utf8"))) {
    console.log(`${kind} ${name}`);
  }
}
