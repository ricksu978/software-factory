// The Configuration page's settings (PBI 175). Runtime settings are the one wip_policy row, read fresh on every request,
// and an operator can change six of them, each change with a reason that the logged event keeps (PBI 176). An operator can
// also clear an active usage pause, with a reason, but never set one: only a usage report sets it (PBI 178). The scheduler picks up the current WIP and review capacity on its next tick, and a
// cell reads the usage reserve. The WIP minimum and maximum only bound the current WIP, and the daily budget is stored but
// not enforced yet. Env-backed settings are the
// values the control plane read from its environment at start, shown read-only. Only the names in ENV_SETTINGS ever
// reach the page, so a secret such as GITHUB_APP_KEY or FACTORY_DB_URI can't show by being added to the environment.
import type pg from "pg";
import { appendEvent } from "../store/events.ts";

export type RuntimeKey = "mode" | "wip_min" | "wip_max" | "current_wip" | "review_capacity" | "usage_reserve" | "daily_budget" | "usage_pause";

/**
 * Each runtime setting in the order the page lists it: its label, its wip_policy column, whether an operator can change
 * it, whether an operator can only clear it, and a note when a change does less than the page's heading says. Nothing outside this page reads the WIP minimum
 * and maximum yet, so they only bound the current WIP, and nothing enforces the daily budget yet.
 */
export const RUNTIME_SETTINGS: { key: RuntimeKey; label: string; column: string; editable: boolean; clearable?: boolean; note?: string }[] = [
  { key: "mode", label: "WIP mode", column: "mode", editable: false },
  { key: "wip_min", label: "WIP minimum", column: "wip_min", editable: true, note: "Only bounds the current WIP for now." },
  { key: "wip_max", label: "WIP maximum", column: "wip_max", editable: true, note: "Only bounds the current WIP for now." },
  { key: "current_wip", label: "current WIP", column: "current_wip", editable: true },
  { key: "review_capacity", label: "review capacity", column: "review_capacity", editable: true },
  { key: "usage_reserve", label: "usage reserve", column: "usage_reserve_at", editable: true },
  { key: "daily_budget", label: "daily budget", column: "daily_budget", editable: true, note: "Stored, but not enforced yet." },
  { key: "usage_pause", label: "usage pause", column: "usage_paused_until", editable: false, clearable: true },
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
type TurnedDown = { ok: false; status: number; message: string };
export type Checked = { ok: true; updates: Update[]; reason: string } | TurnedDown;

const col = (key: RuntimeKey) => RUNTIME_SETTINGS.find((s) => s.key === key)!.column;
const turnDown = (message: string): TurnedDown => ({ ok: false, status: 400, message });

/**
 * Checks a change against the policy as it is now, and returns the columns it writes. A new WIP minimum or maximum
 * that leaves the current WIP outside the range moves the current WIP to the nearest end, so min <= current <= max
 * always holds. A value that breaks a rule is turned down with that rule first; a value that keeps every rule still needs
 * a reason that isn't only spaces (PBI 176).
 */
export function checkChange(now: RuntimeValues, key: string, value: string, reason?: string): Checked {
  const updates = checkValue(now, key, value);
  if (!Array.isArray(updates)) return updates;
  const why = (reason ?? "").trim();
  if (why === "") return turnDown("Give a reason for the change.");
  return { ok: true, updates, reason: why };
}

/** The columns a change writes, or why it's turned down. */
function checkValue(now: RuntimeValues, key: string, value: string): Update[] | TurnedDown {
  const setting = RUNTIME_SETTINGS.find((s) => s.key === key);
  const raw = value.trim();
  if (setting?.clearable) {
    if (raw !== "") return turnDown(`The ${setting.label} can only be cleared.`);
    if (now[setting.key] === null) return turnDown(`There's no ${setting.label} to clear.`);
    return [{ key: setting.key, column: setting.column, value: null }];
  }
  if (!setting || !setting.editable) return turnDown("That setting can't be changed from the page.");
  const min = Number(now.wip_min);
  const max = Number(now.wip_max);
  const current = Number(now.current_wip);
  const one = (v: number | null): Update[] => [{ key: setting.key, column: setting.column, value: v }];
  const withCurrent = (k: RuntimeKey, v: number, lo: number, hi: number): Update[] => {
    const updates: Update[] = [{ key: k, column: col(k), value: v }];
    const moved = Math.min(Math.max(current, lo), hi);
    if (moved !== current) updates.push({ key: "current_wip", column: col("current_wip"), value: moved });
    return updates;
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
      if (n === null || n < 0 || n > 1) return turnDown("Usage reserve must be a number from 0 to 1.");
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
 * `setting` event whose actor_id is the user's id, as for every other human event, from what, to what and why. A change
 * to the value already there logs nothing.
 */
export async function changeSetting(pool: pg.Pool, by: string, key: string, value: string, reason?: string): Promise<Checked> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    const now = await runtimeValues(c, true);
    const checked = checkChange(now, key, value, reason);
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
      await appendEvent(c, { actor: "human", actorId: by, itemId: null, kind: "setting", payload: { setting: label, from, to, reason: checked.reason } });
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
