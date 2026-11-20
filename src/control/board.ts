// Board mirroring (Run contract 8). The worker runs it from each transition's and override's board mirror outbox row
// (src/worker/outbox.ts), so the watcher, the scheduler, the cell API and the dashboard all mirror the same way, and
// only once the transition has committed.
import type pg from "pg";
import type { BacklogAdapter, RepoHost } from "../adapters/types.ts";
import type { ItemEvent, ItemState } from "../core/states.ts";
import { effectsDone, recordEffect } from "../store/outbox.ts";
import { repoName, runBranch } from "../store/runs.ts";

export type BoardDeps = { pool: pg.Pool; backlogFor: (sourceId: string) => BacklogAdapter; repoHost: RepoHost };

// What the item waits for, posted on the board item so people who never open the dashboard can act on it.
const waitingFor: Partial<Record<ItemState, string>> = {
  SignOff: "Waiting for sign-off on the scenarios. Reply `/approve`, or `/changes <note>`.",
  NeedsInput: "Waiting for an answer. Reply `/answer <text>`.",
  Failed: "Failed. It waits for an operator to re-queue it from Run detail.",
};

type Row = {
  external_id: string; source_id: string; field_map: { statusFor?: Record<string, string | null> } | null;
  run_number: number | null; branch: string | null; pr_number: number | null; pr_url: string | null; repo_url: string | null;
};

/**
 * The board status a Split parent mirrors to: the one the field map names for Split, or none when it names none, so
 * the parent's board status stays as it was (PBI 227).
 */
export function splitStatus(fieldMap: Row["field_map"]): string | null {
  return fieldMap?.statusFor?.Split || null;
}

/**
 * What a mirror needs from the event behind it: its id, which every idempotency key comes from, so a row handled again
 * after a crash repeats no comment, and the question the item was asked as it moved, from the event's payload. `seq` is
 * the board mirror outbox row's: each effect that succeeds is recorded against it, and one already recorded is skipped,
 * so a row handled again repeats no board call (PBI 220).
 */
export type MirrorEvent = { eventId: string; seq: string; question?: string | null };

/**
 * Mirrors one committed transition onto the item's board, and closes its open PR when the item is withdrawn. Each
 * effect runs on its own, so one failed call can't skip the rest, and each failure is logged. Once all have run, it
 * throws if any failed, so the worker keeps the row and tries it again. An effect that succeeded is recorded against the
 * row and skipped when the row is handled again, so a retry runs only what failed. A crash between an effect and its
 * record repeats that one effect, and every effect is safe to repeat.
 */
export async function mirror(deps: BoardDeps, itemId: string, to: ItemState, event: ItemEvent | "override", e: MirrorEvent): Promise<void> {
  const r = await deps.pool.query<Row>(
    `select i.external_id, i.source_id, s.field_map, r.run_number, r.branch, r.pr_number, r.pr_url, repo.url as repo_url
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
  const failed: string[] = [];
  const done = await effectsDone(deps.pool, e.seq);
  const attempt = async (what: string, fn: () => Promise<unknown>) => {
    if (done.has(what)) return;
    try {
      await fn();
      await recordEffect(deps.pool, e.seq, what);
    } catch (err) {
      failed.push(what);
      console.error(`board mirroring: ${what} failed for item ${itemId}:`, err);
    }
  };
  const status = to === "Split" ? splitStatus(row.field_map) : row.field_map?.statusFor?.[to];
  if (status) await attempt("setStatus", () => board.setStatus(id, status));
  if (to === "InProgress") await attempt("claim", () => board.claim(id));
  if (event === "pr_opened" && row.pr_url) await attempt("linkPr", () => board.linkPr(id, row.pr_url!));
  if (to === "Done" || to === "Failed" || to === "Abandoned") await attempt("release", () => board.release(id));
  if (to === "Done") await attempt("close", () => board.close(id));
  const note = waitingFor[to];
  if (note) await attempt("comment", () => board.comment(id, e.question ? `${note}\n\n${e.question}` : note, `waiting:${e.eventId}`));
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
  if (failed.length) throw new Error(`board mirroring failed for item ${itemId}: ${failed.join(", ")}`);
}
