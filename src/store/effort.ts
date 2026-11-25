// PBI 319: the effort every agent call names. It's a runtime setting on the Configuration page, kept on the one
// wip_policy row, and always has one of these values, starting at medium.
import type pg from "pg";

/** The efforts an operator can set, lowest first. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** The effort a new factory starts at, and the one a record from before PBI 319, with none stored, ran at. */
export const DEFAULT_EFFORT: Effort = "medium";

/** The effort set now. A cell reads it once, when it starts; a readiness judge or split call reads it each time it runs. */
export async function currentEffort(_c: pg.Pool | pg.PoolClient): Promise<Effort> {
  throw new Error("not implemented: PBI 319 reads the effort setting");
}
