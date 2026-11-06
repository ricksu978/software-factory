// Board mirroring (Run contract 8). It hangs off onTransition, so the watcher, the scheduler, the cell API and the
// dashboard all mirror the same way, and it runs only after the transition commits.
import type pg from "pg";
import type { BacklogAdapter, RepoHost } from "../adapters/types.ts";
import type { ItemEvent, ItemState } from "../core/states.ts";
import { onTransition } from "../store/items.ts";
import { repoName, runBranch } from "../store/runs.ts";

export type BoardDeps = { pool: pg.Pool; backlogFor: (sourceId: string) => BacklogAdapter; repoHost: RepoHost };

// What the item waits for, posted on the board item so people who never open the dashboard can act on it.
const waitingFor: Partial<Record<ItemState, string>> = {
  SignOff: "Waiting for sign-off on the scenarios. Reply `/approve`, or `/changes <note>`.",
  NeedsInput: "Waiting for an answer. Reply `/answer <text>`.",
  Failed: "Failed. It waits for an operator to re-queue it from Run detail.",
};

type Row = {
  external_id: string; source_id: string; lease_generation: number; field_map: { statusFor?: Record<string, string | null> } | null;
  run_number: number | null; branch: string | null; pr_number: number | null; pr_url: string | null; repo_url: string | null; question: string | null;
};

/** Mirrors one committed transition onto the item's board, and closes its open PR when the item is withdrawn. */
export async function mirror(deps: BoardDeps, itemId: string, to: ItemState, event: ItemEvent): Promise<void> {
  const r = await deps.pool.query<Row>(
    `select i.external_id, i.source_id, i.lease_generation, s.field_map, r.run_number, r.branch, r.pr_number, r.pr_url, repo.url as repo_url,
       (select q.body from question q where q.item_id = i.id and q.answer is null and q.closed_at is null order by q.asked_at desc limit 1) as question
     from item i
     join backlog_source s on s.id = i.source_id
     left join lateral (select * from run where run.item_id = i.id order by run.run_number desc limit 1) r on true
     left join repo on repo.id = r.repo_id
     where i.id = $1`,
    [itemId],
  );
  const row = r.rows[0];
  if (!row) return;
  const board = deps.backlogFor(row.source_id);
  const id = row.external_id;
  // Each effect runs on its own, so one failed call can't skip the rest. Nothing retries a hook, so a skipped
  // closePr would leave a withdrawn item's PR open for someone to merge.
  const attempt = async (what: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      console.error(`board mirroring: ${what} failed for item ${itemId}:`, e);
    }
  };
  const status = row.field_map?.statusFor?.[to];
  if (status) await attempt("setStatus", () => board.setStatus(id, status));
  if (to === "InProgress") await attempt("claim", () => board.claim(id));
  if (event === "pr_opened" && row.pr_url) await attempt("linkPr", () => board.linkPr(id, row.pr_url!));
  if (to === "Done" || to === "Failed" || to === "Abandoned") await attempt("release", () => board.release(id));
  if (to === "Done") await attempt("close", () => board.close(id));
  const note = waitingFor[to];
  // Each exit from InProgress has its own generation, so one key per exit posts each wait once.
  if (note) await attempt("comment", () => board.comment(id, row.question ? `${note}\n\n${row.question}` : note, `waiting:${to}:${row.lease_generation}`));
  if (to === "Abandoned" && event === "withdrawn" && row.pr_number !== null && row.repo_url && row.run_number !== null) {
    const repo = repoName(row.repo_url);
    const pr = row.pr_number;
    const branch = runBranch({ branch: row.branch, externalId: id, runNumber: row.run_number });
    await attempt("closePr", async () => {
      if ((await deps.repoHost.prState(repo, pr, [])).open) {
        await deps.repoHost.closePr(repo, pr, `The item was withdrawn, so the factory closed this PR. The branch \`${branch}\` is kept.`);
      }
    });
  }
}

/** Registers mirroring for every transition from here on, and returns the call that stops it. */
export function mirrorBoard(deps: BoardDeps): () => void {
  return onTransition((itemId, _from, to, event) => mirror(deps, itemId, to, event));
}
