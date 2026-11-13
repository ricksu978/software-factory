// The Configuration page's settings (PBI 175). Runtime settings are the one wip_policy row, read fresh on every request,
// and an operator can change six of them, which the scheduler picks up on its next tick. Env-backed settings are the
// values the control plane read from its environment at start, shown read-only. Only the names in ENV_SETTINGS ever
// reach the page, so a secret such as GITHUB_APP_KEY or FACTORY_DB_URI can't show by being added to the environment.
import type pg from "pg";
import { appendEvent } from "../store/events.ts";

export type RuntimeKey = "mode" | "wip_min" | "wip_max" | "current_wip" | "review_capacity" | "usage_reserve" | "daily_budget" | "usage_pause";

/** Each runtime setting in the order the page lists it: its label, its wip_policy column, and whether an operator can change it. */
export const RUNTIME_SETTINGS: { key: RuntimeKey; label: string; column: string; editable: boolean }[] = [
  { key: "mode", label: "WIP mode", column: "mode", editable: false },
  { key: "wip_min", label: "WIP minimum", column: "wip_min", editable: true },
  { key: "wip_max", label: "WIP maximum", column: "wip_max", editable: true },
  { key: "current_wip", label: "current WIP", column: "current_wip", editable: true },
  { key: "review_capacity", label: "review capacity", column: "review_capacity", editable: true },
  { key: "usage_reserve", label: "usage reserve", column: "usage_reserve_at", editable: true },
  { key: "daily_budget", label: "daily budget", column: "daily_budget", editable: true },
  { key: "usage_pause", label: "usage pause", column: "usage_paused_until", editable: false },
];

/** The env names the page lists. A secret is never one of them: its value never leaves the process. */
export const ENV_SETTINGS = [
  "FACTORY_ENV",
  "FACTORY_DEV_LOGIN",
  "GITHUB_APP_ID",
  "CELL_CONTROL_URL",
  "CELL_BLOB_HOST",
  "PORT",
  "FACTORY_POLICY_DIR",
  "FACTORY_RESTART_WAIT_MINUTES",
  "CLAUDE_TOKEN_CREATED_AT",
  "FACTORY_KILL",
  "CONTAINER_APP_NAME",
] as const;

/** A runtime setting as the page shows it: its value as text, or null when it has none. */
export type RuntimeValues = Record<RuntimeKey, string | null>;

export type Setting = { key: string; label: string; value: string | null };

const show = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().replace(/\.000Z$/, "Z");
  return String(v);
};

export async function runtimeValues(pool: pg.Pool | pg.ClientBase, lock = false): Promise<RuntimeValues> {
  const cols = RUNTIME_SETTINGS.map((s) => `${s.column} as ${s.key}`).join(", ");
  const row = (await pool.query(`select ${cols} from wip_policy limit 1${lock ? " for update" : ""}`)).rows[0] ?? {};
  return Object.fromEntries(RUNTIME_SETTINGS.map((s) => [s.key, show(row[s.key])])) as RuntimeValues;
}

/** The env-backed settings as the control plane started with them. An empty value counts as not set. */
export function envSettings(env: Record<string, string | undefined>): Setting[] {
  return ENV_SETTINGS.map((name) => ({ key: name, label: name, value: env[name] ? env[name] : null }));
}

const MAX_INT = 2_147_483_647;
const whole = (raw: string) => (/^\d{1,10}$/.test(raw) && Number(raw) >= 1 && Number(raw) <= MAX_INT ? Number(raw) : null);
const decimal = (raw: string) => (/^\d{1,12}(\.\d{1,6})?$|^\.\d{1,6}$/.test(raw) ? Number(raw) : null);

export type Update = { key: RuntimeKey; column: string; value: number | null };
export type Checked = { ok: true; updates: Update[] } | { ok: false; status: number; message: string };

const col = (key: RuntimeKey) => RUNTIME_SETTINGS.find((s) => s.key === key)!.column;
const turnDown = (message: string): Checked => ({ ok: false, status: 400, message });

/**
 * Checks a change against the policy as it is now, and returns the columns it writes. A new WIP minimum or maximum
 * that leaves the current WIP outside the range moves the current WIP to the nearest end, so min <= current <= max
 * always holds.
 */
export function checkChange(now: RuntimeValues, key: string, value: string): Checked {
  const setting = RUNTIME_SETTINGS.find((s) => s.key === key);
  if (!setting || !setting.editable) return turnDown("That setting can't be changed from the page.");
  const raw = value.trim();
  const min = Number(now.wip_min);
  const max = Number(now.wip_max);
  const current = Number(now.current_wip);
  const one = (v: number | null): Checked => ({ ok: true, updates: [{ key: setting.key, column: setting.column, value: v }] });
  const withCurrent = (k: RuntimeKey, v: number, lo: number, hi: number): Checked => {
    const updates: Update[] = [{ key: k, column: col(k), value: v }];
    const moved = Math.min(Math.max(current, lo), hi);
    if (moved !== current) updates.push({ key: "current_wip", column: col("current_wip"), value: moved });
    return { ok: true, updates };
  };
  switch (setting.key) {
    case "wip_min": {
      const n = whole(raw);
      if (n === null) return turnDown("WIP minimum must be a whole number of at least 1.");
      if (n > max) return turnDown("WIP minimum can't be more than WIP maximum.");
      return withCurrent("wip_min", n, n, max);
    }
    case "wip_max": {
      const n = whole(raw);
      if (n === null) return turnDown("WIP maximum must be a whole number of at least 1.");
      if (n < min) return turnDown("WIP maximum can't be less than WIP minimum.");
      return withCurrent("wip_max", n, min, n);
    }
    case "current_wip": {
      const n = whole(raw);
      if (n === null || n < min || n > max) return turnDown("Current WIP must be a whole number from WIP minimum to WIP maximum.");
      return one(n);
    }
    case "review_capacity": {
      const n = whole(raw);
      if (n === null) return turnDown("Review capacity must be a whole number of at least 1.");
      return one(n);
    }
    case "usage_reserve": {
      const n = decimal(raw);
      if (n === null || n <= 0 || n > 1) return turnDown("Usage reserve must be more than 0 and at most 1.");
      return one(n);
    }
    case "daily_budget": {
      if (raw === "") return one(null);
      const n = decimal(raw);
      if (n === null || n <= 0) return turnDown("Daily budget must be more than 0, or left empty for none.");
      return one(n);
    }
    default:
      return turnDown("That setting can't be changed from the page.");
  }
}

/**
 * Applies one change in a transaction, against the policy row locked as it is now, and logs each column it moved as a
 * `setting` event naming who changed it, from what and to what. A change to the value already there logs nothing.
 */
export async function changeSetting(pool: pg.Pool, by: string, key: string, value: string): Promise<Checked> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    const now = await runtimeValues(c, true);
    const checked = checkChange(now, key, value);
    if (!checked.ok) {
      await c.query("rollback");
      return checked;
    }
    for (const u of checked.updates) {
      await c.query(`update wip_policy set ${u.column} = $1`, [u.value]);
      const from = now[u.key];
      const to = u.value === null ? null : String(u.value);
      if (from !== null && to !== null && Number(from) === Number(to)) continue;
      if (from === to) continue;
      const label = RUNTIME_SETTINGS.find((s) => s.key === u.key)!.label;
      await appendEvent(c, { actor: "human", actorId: by, itemId: null, kind: "setting", payload: { setting: label, from, to } });
    }
    await c.query("commit");
    return checked;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
