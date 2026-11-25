// PBI 319: the effort every agent call names. It's a runtime setting on the Configuration page, kept on the one
// wip_policy row, and always has one of these values, starting at medium.
import type pg from "pg";

/** The efforts an operator can set, lowest first. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** The effort a new factory starts at, and the one a record from before PBI 319, with none stored, ran at. */
export const DEFAULT_EFFORT: Effort = "medium";

/** True for one of the five efforts, written exactly as EFFORTS writes it. */
export const isEffort = (v: unknown): v is Effort => typeof v === "string" && (EFFORTS as readonly string[]).includes(v);

/** The message a value other than one of the five efforts is turned down with. */
export const EFFORT_RULE = "Effort must be one of low, medium, high, xhigh or max.";

/**
 * Throws unless the call names a model and one of the efforts, so no call goes out at a default the factory didn't
 * choose (PBI 319). Callers outside TypeScript's reach, such as a cell's context read from JSON, can leave either out.
 */
export function assertNamed(a: { model?: unknown; effort?: unknown }): void {
  if (typeof a.model !== "string" || a.model.trim() === "") throw new Error("The agent call names no model, so it isn't sent: every call names its model and its effort.");
  if (a.effort === undefined || a.effort === null || a.effort === "") throw new Error("The agent call names no effort, so it isn't sent: every call names its model and its effort.");
  if (!isEffort(a.effort)) throw new Error(`The agent call names the effort ${JSON.stringify(a.effort)}, which isn't one of ${EFFORTS.join(", ")}, so it isn't sent.`);
}

/** The effort set now. A cell reads it once, when it starts; a readiness judge or split call reads it each time it runs. */
export async function currentEffort(c: pg.Pool | pg.PoolClient): Promise<Effort> {
  const v = (await c.query<{ effort: string }>("select effort from wip_policy limit 1")).rows[0]?.effort;
  if (!isEffort(v)) throw new Error(`the effort setting holds ${JSON.stringify(v ?? null)}, not one of ${EFFORTS.join(", ")}`);
  return v;
}

/** A model name as the dashboard shows it, its effort after it: a record with none stored ran at the default. */
export const withEffort = (model: string, effort: string | null | undefined): string => `${model} (${effort || DEFAULT_EFFORT})`;
