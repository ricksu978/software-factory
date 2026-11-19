// The parameter check `npm run factory` runs before `aspire run` (scripts/factory.ps1 through
// scripts/set-local-secrets.ps1 -MissingOnly), in Node so cells and CI can run it against a fake checkout (PBI 312).
// It reads the parameters the checkout's AppHost (aspire-apphost/apphost.mts) declares, asks the owner for each one
// not yet saved in that checkout's Aspire user secrets, and says whether the start can go on to `aspire run`.
// This is today's check as the script runs it: it takes every parameter the AppHost declares, wherever it declares it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type ParameterKind = "secret" | "plain";
export type DeclaredParameter = { name: string; kind: ParameterKind };

/**
 * The parameters `npm run factory` asks for, from the AppHost's source, in the order the script asks: secrets first,
 * then plain parameters. Secrets are the ones declared through apphost.mts's secret() helper.
 */
export function declaredParameters(appHostSource: string): DeclaredParameter[] {
  const secret = [...appHostSource.matchAll(/secret\('([\w-]+)'\)/g)].map((m) => m[1]!);
  const plain = [...appHostSource.matchAll(/addParameter\('([\w-]+)'/g)].map((m) => m[1]!);
  return [
    ...secret.map((name) => ({ name, kind: "secret" as const })),
    ...plain.map((name) => ({ name, kind: "plain" as const })),
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
