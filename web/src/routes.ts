// The SPA's addresses (redesign step 8b): Floor is /, Run detail /runs/{id}, Activity /activity and the Phase 0 report
// /phase0. A stage attempt's transcript page is /runs/{id}/transcripts/{stage}/{attempt} (PBI 326). Any other address
// shows that there's no such page. Kept free of React so Node's tests read it directly.
/** The SPA's own pages' addresses, which its links name. */
export const PATHS = { floor: "/", activity: "/activity", phase0: "/phase0" } as const;

/** The address of an item's Run detail. */
export const runPath = (id: string) => `/runs/${encodeURIComponent(id)}`;

/** PBI 326: the address of the transcript page for an item's `stage` attempt `attempt`. */
export const transcriptPath = (id: string, stage: string, attempt: number) =>
  `${runPath(id)}/transcripts/${encodeURIComponent(stage)}/${attempt}`;

export type Route = { page: "floor" | "activity" | "phase0" | "none" } | { page: "item"; id: string }
  /** PBI 326: a stage attempt's transcript page. */
  | { page: "transcript"; id: string; stage: string; attempt: number };

const decoded = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return undefined;
  }
};

export function routeOf(path: string): Route {
  const p = path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (p === PATHS.floor) return { page: "floor" };
  if (p === PATHS.activity) return { page: "activity" };
  if (p === PATHS.phase0) return { page: "phase0" };
  const run = /^\/runs\/([^/]+)$/.exec(p);
  if (run) {
    const id = decoded(run[1]);
    return id === undefined ? { page: "none" } : { page: "item", id };
  }
  const transcript = /^\/runs\/([^/]+)\/transcripts\/([^/]+)\/([1-9]\d*)$/.exec(p);
  if (transcript) {
    const id = decoded(transcript[1]);
    const stage = decoded(transcript[2]);
    if (id !== undefined && stage !== undefined) return { page: "transcript", id, stage, attempt: Number(transcript[3]) };
  }
  return { page: "none" };
}
