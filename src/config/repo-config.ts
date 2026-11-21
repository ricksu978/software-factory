// A repo's .factory/config.yml (spec §6 "Repo config", plan Task 9).
import YAML from "yaml";

/** The agent web tools a repo may allow its cells. The model gateway enforces the list (spec §6 "Web tools"). */
export const WEB_TOOLS = ["WebSearch", "WebFetch"] as const;
export type WebTool = (typeof WEB_TOOLS)[number];

export type RepoConfig = {
  sensitivePaths: string[];
  reviewers: string[];
  webTools: WebTool[];
  bdd: { parse: string; run: string; report: string };
  /** `setup` installs the repo's dependencies in a fresh checkout. The engine runs it before any stage. */
  commands: { test: string; lint: string; setup?: string };
  /** PBI 369: how many hours apart the factory re-checks an item that failed its Definition of Done on main. */
  failedRecheckHours: number;
  /**
   * PBI 399: `command_timeout_minutes`, how many minutes the cell gives each command it runs before it stops it,
   * DEFAULT_COMMAND_TIMEOUT_MINUTES when the key is missing.
   */
  commandTimeoutMinutes?: number;
};

/** `failed_recheck_hours` when the key is missing (PBI 369). */
export const DEFAULT_FAILED_RECHECK_HOURS = 8;

/** `command_timeout_minutes` when the key is missing (PBI 399). */
export const DEFAULT_COMMAND_TIMEOUT_MINUTES = 15;

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

/** Only the two known tool names pass, so a typo can't widen what a cell may do. */
function webTools(doc: Record<string, unknown>): WebTool[] {
  const list = strings(doc, "web_tools");
  const unknown = list.filter((t) => !(WEB_TOOLS as readonly string[]).includes(t));
  if (unknown.length > 0) throw new ConfigError("web_tools", `web_tools allows only ${WEB_TOOLS.join(" and ")}, not ${unknown.join(", ")}`);
  return list as WebTool[];
}

/** `commands.setup` may be left out, but a present one must be a command. */
function setup(doc: Record<string, unknown>): { setup?: string } {
  const v = (doc.commands as Record<string, unknown> | undefined)?.setup;
  if (v === undefined) return {};
  if (typeof v !== "string" || v.trim() === "") throw new ConfigError("commands.setup");
  return { setup: v };
}

/**
 * 8 when the key is missing or isn't a number above zero (spec §6). It never throws: a setting that only paces
 * re-checks of Failed items mustn't make the whole config invalid and stop the repo's pipeline.
 */
function recheckHours(doc: Record<string, unknown>): number {
  const v = doc.failed_recheck_hours;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : DEFAULT_FAILED_RECHECK_HOURS;
}

/**
 * 15 when the key is missing (PBI 399). Unlike `failed_recheck_hours`, a wrong value makes the config invalid: a limit
 * the cell guessed at would stop a repo's long commands, or leave a hung one running, without saying why.
 */
function commandTimeout(doc: Record<string, unknown>): number {
  if (!("command_timeout_minutes" in doc)) return DEFAULT_COMMAND_TIMEOUT_MINUTES;
  const v = doc.command_timeout_minutes;
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) throw new ConfigError("command_timeout_minutes");
  return v;
}

function parseYaml(yamlText: string | null): Record<string, unknown> {
  let doc: unknown = null;
  if (yamlText !== null) {
    try {
      doc = YAML.parse(yamlText);
    } catch (e) {
      throw new ConfigError("yaml", `not valid YAML: ${(e as Error).message}`);
    }
  }
  return (doc && typeof doc === "object" ? doc : {}) as Record<string, unknown>;
}

/**
 * Only `failed_recheck_hours` from config.yml, 8 when it's missing or wrong or the repo has no config (PBI 369). The scheduler
 * reads it alone, so a config that's wrong elsewhere still sets how often Failed items are re-checked.
 */
export function failedRecheckHours(yamlText: string | null): number {
  return recheckHours(parseYaml(yamlText));
}

/** Parses config.yml. Null means the repo has none, which fails on `bdd`, since such a repo can't run BDD. */
export function parseRepoConfig(yamlText: string | null): RepoConfig {
  const d = parseYaml(yamlText);
  return {
    sensitivePaths: strings(d, "sensitive_paths"),
    reviewers: strings(d, "reviewers"),
    webTools: webTools(d),
    bdd: section(d, "bdd", ["parse", "run", "report"] as const),
    commands: { ...section(d, "commands", ["test", "lint"] as const), ...setup(d) },
    failedRecheckHours: recheckHours(d),
    commandTimeoutMinutes: commandTimeout(d),
  };
}
