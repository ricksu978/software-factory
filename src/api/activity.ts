// The activity log's rows as GET /v1/activity answers them (PBI 286): what today's /activity page shows, and nothing
// it hides. The rows come from src/http/routes.ts's `activity`, the page's own query.
import { MOVES, type ActivityRow } from "../http/views.ts";

export type ActivityEvent = {
  at: string; external_id: string | null; repo: string | null; title: string | null; kind: string;
  from: string | null; to: string | null; event: string | null;
  /** Only a setting change carries who made it, the setting and why, as the page shows them. */
  actor?: string | null; setting?: string | null; reason?: string | null;
};

/**
 * Each row as the page shows it. A move (transition, override or SOP move) keeps its from and to, and a transition its
 * event. A setting change keeps its from, to, actor, setting and reason. Any other kind carries no states.
 */
export function activityLog(rows: ActivityRow[]): ActivityEvent[] {
  return rows.map((r) => {
    const row = { at: r.at.toISOString(), external_id: r.external_id, repo: r.repo, title: r.title, kind: r.kind };
    if (r.kind === "setting") {
      return { ...row, from: r.from, to: r.to, event: null, actor: r.actor ?? null, setting: r.setting ?? null, reason: r.reason ?? null };
    }
    const move = MOVES.has(r.kind);
    return { ...row, from: move ? r.from : null, to: move ? r.to : null, event: r.kind === "transition" ? r.event : null };
  });
}
