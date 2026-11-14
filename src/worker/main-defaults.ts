// The factory's default policies as `main` holds them (PBI 261). The worker reads each default from the commit of `main`
// it last fetched into the operator's checkout, the commit it builds the cell image from, so a merged change to one
// takes effect on the next poll with no restart, and an edit or a local commit in the checkout never counts. Cells
// keep reading the defaults baked into their image.
import type { DefaultPolicies } from "../policy/policy.ts";

export type MainDefaultsDeps = {
  /** The operator's checkout, which `main` is fetched into. */
  checkout: string;
  /** "origin" by default. */
  remote?: string;
  /** "main" by default. */
  branch?: string;
};

/** Reads each default policy from the fetched `main`'s `policy/<name>.md`. Not built yet. */
export function mainDefaults(_d: MainDefaultsDeps): DefaultPolicies {
  return async (name) => {
    throw new Error(`reading the default ${name}.md from main isn't built yet`);
  };
}
