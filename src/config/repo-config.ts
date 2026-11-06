// A repo's .factory/config.yml (spec §6 "Repo config", plan Task 9).
import YAML from "yaml";

export type RepoConfig = {
  sensitivePaths: string[];
  reviewers: string[];
  bdd: { parse: string; run: string; report: string };
  commands: { test: string; lint: string };
};

/** Thrown for a missing or invalid config. `key` names the setting that's wrong. */
export class ConfigError extends Error {
  override name = "ConfigError";
  readonly key: string;
  constructor(key: string, detail = `missing or invalid ${key}`) {
    super(`.factory/config.yml: ${detail}`);
    this.key = key;
  }
}

function section<K extends string>(doc: Record<string, unknown>, key: string, fields: readonly K[]): Record<K, string> {
  const value = doc[key];
  if (!value || typeof value !== "object") throw new ConfigError(key);
  const out = {} as Record<K, string>;
  for (const f of fields) {
    const v = (value as Record<string, unknown>)[f];
    if (typeof v !== "string" || v.trim() === "") throw new ConfigError(`${key}.${f}`);
    out[f] = v;
  }
  return out;
}

function strings(doc: Record<string, unknown>, key: string): string[] {
  const v = doc[key] ?? [];
  if (!Array.isArray(v) || !v.every((s) => typeof s === "string")) throw new ConfigError(key, `${key} must be a list of strings`);
  return v;
}

/** Parses config.yml. Null means the repo has none, which fails on `bdd`, since such a repo can't run BDD. */
export function parseRepoConfig(yamlText: string | null): RepoConfig {
  let doc: unknown = null;
  if (yamlText !== null) {
    try {
      doc = YAML.parse(yamlText);
    } catch (e) {
      throw new ConfigError("yaml", `not valid YAML: ${(e as Error).message}`);
    }
  }
  const d = (doc && typeof doc === "object" ? doc : {}) as Record<string, unknown>;
  return {
    sensitivePaths: strings(d, "sensitive_paths"),
    reviewers: strings(d, "reviewers"),
    bdd: section(d, "bdd", ["parse", "run", "report"] as const),
    commands: section(d, "commands", ["test", "lint"] as const),
  };
}
