// The SPA's addresses (redesign step 8b): Floor is /, Run detail /runs/{id}, Activity /activity, the Phase 0 report
// /phase0 and the Configuration page /configuration (PBI 175). Any other address shows that there's no such page. Kept free of React so Node's tests read it directly.
/** The SPA's own pages' addresses, which its links name. */
export const PATHS = { floor: "/", activity: "/activity", phase0: "/phase0", configuration: "/configuration" } as const;

/** The address of an item's Run detail. */
export const runPath = (id: string) => `/runs/${encodeURIComponent(id)}`;

export type Route = { page: "floor" | "activity" | "phase0" | "configuration" | "none" } | { page: "item"; id: string };

export function routeOf(path: string): Route {
  const p = path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (p === PATHS.floor) return { page: "floor" };
  if (p === PATHS.activity) return { page: "activity" };
  if (p === PATHS.phase0) return { page: "phase0" };
  if (p === PATHS.configuration) return { page: "configuration" };
  const run = /^\/runs\/([^/]+)$/.exec(p);
  if (run) {
    try {
      return { page: "item", id: decodeURIComponent(run[1]) };
    } catch {
      return { page: "none" };
    }
  }
  return { page: "none" };
}
