// The scheduler (plan Task 13). Every TICK_MS it applies operator overrides, sends back expired leases, times out
// and reminds questions nobody answered, polls CI on merged items, and starts at most one cell while a slot under the
// WIP limit is free. Everything it decides comes from the database, so a restarted process picks up where the old
// one stopped and never starts a second cell for an item with a live lease (Review Focus 5).
import { createHash } from "node:crypto";
import type pg from "pg";
import type { BacklogAdapter, RepoHost } from "../adapters/types.ts";
import { runToken } from "../control/cell-api.ts";
import type { ItemEvent } from "../core/states.ts";
import { withTx } from "../store/db.ts";
import type { Actor } from "../store/events.ts";
import { claimNext, expireLeases, overrideItem, transitionItem } from "../store/items.ts";
import { activeOverrides, clearItemOverrides } from "../store/overrides.ts";
import { repoName, runBranch } from "../store/runs.ts";
import type { Launcher } from "./launcher.ts";

export const TICK_MS = 15_000;
const DAY_MS = 86_400_000;
const REMIND_AT_MS = [2 * DAY_MS, 4 * DAY_MS];
const TIMEOUT_MS = 5 * DAY_MS;
const NO_CI_AFTER_MS = 3_600_000;

export type TickDeps = {
  pool: pg.Pool;
  launcher: Launcher;
  now: Date;
  /** FACTORY_KILL=1 at control plane start. It stops every cell, as a kill override does. */
  killFlag: boolean;
  repoHost: RepoHost;
  backlogFor: (sourceId: string) => BacklogAdapter;
  /** The secret that signs each cell's RUN_TOKEN, shared with the cell API. */
  secret: string;
  /** The control plane's URL as a cell reaches it, passed to the cell as CONTROL_URL. */
  controlUrl: string;
  /** The version of the loaded SOP file, pinned on a run's first claim. */
  sopVersion: string;
};
export type TickResult = { started: string[]; stopped: string[]; expired: string[] };

const system: Actor = { actor: "system", actorId: "scheduler" };

// ponytail: copy of criteriaHash from src/watcher/poller.ts (PBI 8, PR #76), which isn't on main yet. Import it once it is.
function criteriaHash(criteria: string[]): string {
  return createHash("sha256").update(JSON.stringify(criteria)).digest("hex");
}

export async function tick(d: TickDeps): Promise<TickResult> {
  const result: TickResult = { started: [], stopped: [], expired: [] };
  const overrides = await activeOverrides(d.pool, d.now);
  const factory = (kind: string) => overrides.some((o) => o.scope === "factory" && o.kind === kind);

  // The kill switch stops every cell with a live lease and starts nothing. Their leases then run out as usual.
  if (d.killFlag || factory("kill")) {
    const live = await d.pool.query<{ execution_name: string }>(
      `select r.execution_name from item i join run r on r.item_id = i.id and r.ended_at is null
       where i.state = 'InProgress' and i.lease_expires > $1 and r.execution_name is not null`,
      [d.now],
    );
    for (const { execution_name } of live.rows) {
      await d.launcher.stop(execution_name);
      result.stopped.push(execution_name);
    }
    return result;
  }

  await applyItemOverrides(d, overrides, result);
  result.expired = await withTx(d.pool, (c) => expireLeases(c, d.now));
  await chaseQuestions(d);
  await pollMergedCi(d);
  if (factory("pause") || factory("drain")) return result;
  await startNext(d, result);
  return result;
}

async function itemRow(c: pg.Pool | pg.PoolClient, itemId: string) {
  const r = await c.query<{
    state: string; source_id: string; external_id: string; run_id: string | null; run_number: number | null; branch: string | null;
    execution_name: string | null; next_stage: string | null; pr_number: number | null; merge_sha: string | null; repo_url: string | null;
  }>(
    `select i.state, i.source_id, i.external_id, r.id as run_id, r.run_number, r.branch, r.execution_name, r.next_stage, r.pr_number,
       r.merge_sha, repo.url as repo_url
     from item i
     left join lateral (select * from run where run.item_id = i.id and run.ended_at is null order by run.run_number desc limit 1) r on true
     left join repo on repo.id = r.repo_id
     where i.id = $1`,
    [itemId],
  );
  return r.rows[0];
}

/**
 * hold and unhold set `item.held`. stop_run stops the cell, fails the item through overrideTo and holds it. requeue
 * clears the hold and sends a Failed or Abandoned item back. Every one but hold is used up once applied, and an item's
 * overrides all end when it reaches Done, Failed or Abandoned, after this tick's requeue had its chance.
 */
async function applyItemOverrides(d: TickDeps, overrides: Awaited<ReturnType<typeof activeOverrides>>, result: TickResult) {
  for (const o of overrides) {
    if (o.scope !== "item" || !o.targetId) continue;
    const itemId = o.targetId;
    if (o.kind === "hold") {
      await d.pool.query("update item set held = true where id = $1", [itemId]);
    } else if (o.kind === "unhold") {
      await withTx(d.pool, async (c) => {
        await c.query("update item set held = false where id = $1", [itemId]);
        await clearItemOverrides(c, itemId, ["hold", "unhold"]);
      });
    } else if (o.kind === "requeue") {
      await requeue(d, itemId);
    } else if (o.kind === "stop_run") {
      const row = await itemRow(d.pool, itemId);
      if (row?.state === "InProgress") {
        if (row.execution_name) {
          await d.launcher.stop(row.execution_name);
          result.stopped.push(row.execution_name);
        }
        await withTx(d.pool, async (c) => {
          await overrideItem(c, itemId, "Failed", system, o.reason);
          await c.query("update item set held = true where id = $1", [itemId]);
        });
        const branch = row.run_number !== null ? runBranch({ branch: row.branch, externalId: row.external_id, runNumber: row.run_number }) : null;
        const body = branch
          ? `An operator stopped this run: ${o.reason}. Its work is kept on the branch \`${branch}\`. Re-queue it to carry on.`
          : `An operator stopped this run: ${o.reason}. Re-queue it to carry on.`;
        await d.backlogFor(row.source_id).comment(row.external_id, body, `stopped:${o.id}`);
      }
      await clearItemOverrides(d.pool, itemId, ["stop_run"]);
    }
  }
  await d.pool.query(
    `update override o set cleared_at = $1 from item i
     where o.cleared_at is null and o.scope = 'item' and o.target_id = i.id and i.state in ('Done', 'Failed', 'Abandoned')`,
    [d.now],
  );
}

/**
 * Sends a Failed or Abandoned item back and clears its hold (Run contract 1 and 7). An Abandoned item whose question
 * is still open goes back to waiting on it, with the clock and reminders reset. A run whose PR merged gives way to a
 * new run on a new branch. A run whose PR a person closed unmerged resumes at open-pr, from the kept branch.
 */
async function requeue(d: TickDeps, itemId: string) {
  const row = await itemRow(d.pool, itemId);
  let prClosed = false;
  if (row?.pr_number != null && row.repo_url && row.merge_sha === null) {
    const pr = await d.repoHost.prState(repoName(row.repo_url), row.pr_number, []);
    prClosed = !pr.open && !pr.merged;
  }
  await withTx(d.pool, async (c) => {
    await c.query("update item set held = false where id = $1", [itemId]);
    await clearItemOverrides(c, itemId);
    if (!row || (row.state !== "Failed" && row.state !== "Abandoned")) return;
    const open = await c.query<{ id: string; kind: string }>(
      "select id, kind from question where item_id = $1 and answer is null and closed_at is null order by asked_at desc limit 1",
      [itemId],
    );
    if (row.state === "Abandoned" && open.rowCount) {
      const event: ItemEvent = open.rows[0].kind === "sign_off" ? "reopened_signoff" : "reopened_question";
      await transitionItem(c, itemId, event, system);
      await c.query("update question set asked_at = $2, reminders_sent = 0 where id = $1", [open.rows[0].id, d.now]);
      return;
    }
    await transitionItem(c, itemId, "requeued", system);
    if (row.run_id && row.merge_sha) {
      await c.query("update run set ended_at = $2, outcome = 'requeued' where id = $1", [row.run_id, d.now]);
      await c.query(
        `insert into run (item_id, run_number, next_stage)
         values ($1, (select coalesce(max(run_number), 0) + 1 from run where item_id = $1), 'understand')`,
        [itemId],
      );
    } else if (row.run_id && prClosed) {
      await c.query("update run set next_stage = 'open-pr' where id = $1", [row.run_id]);
    }
  });
}

/** Times out questions older than 5 days, and reminds at 2 and 4 days, once each. */
async function chaseQuestions(d: TickDeps) {
  const r = await d.pool.query<{ id: string; item_id: string; asked_at: Date; reminders_sent: number; source_id: string; external_id: string }>(
    `select q.id, q.item_id, q.asked_at, q.reminders_sent, i.source_id, i.external_id from question q join item i on i.id = q.item_id
     where q.answer is null and q.closed_at is null and i.state in ('SignOff', 'NeedsInput')`,
  );
  for (const q of r.rows) {
    const age = d.now.getTime() - q.asked_at.getTime();
    if (age > TIMEOUT_MS) {
      await withTx(d.pool, (c) => transitionItem(c, q.item_id, "timed_out", system));
      continue;
    }
    const due = REMIND_AT_MS.filter((at) => age >= at).length;
    if (due > q.reminders_sent) {
      const body = `Reminder: this item is still waiting for you. With no answer it's abandoned ${Math.ceil((TIMEOUT_MS - age) / DAY_MS)} days from now.`;
      await d.backlogFor(q.source_id).comment(q.external_id, body, `reminder:${q.id}:${due}`);
      await d.pool.query("update question set reminders_sent = $2 where id = $1", [q.id, due]);
    }
  }
}

/** An Accepted item is Done once CI on its merge commit passes, and Failed when it fails or never reports within an hour. */
async function pollMergedCi(d: TickDeps) {
  const r = await d.pool.query<{ item_id: string; merge_sha: string; repo_url: string; source_id: string; external_id: string; merged_at: Date | null }>(
    `select i.id as item_id, r.merge_sha, repo.url as repo_url, i.source_id, i.external_id,
       (select max(e.at) from event e where e.item_id = i.id and e.kind = 'transition' and e.payload->>'to' = 'Accepted') as merged_at
     from item i join run r on r.item_id = i.id and r.ended_at is null and r.merge_sha is not null join repo on repo.id = r.repo_id
     where i.state = 'Accepted'`,
  );
  for (const row of r.rows) {
    const status = await d.repoHost.checksOnSha(repoName(row.repo_url), row.merge_sha);
    const silent = status === "none" && row.merged_at !== null && d.now.getTime() - row.merged_at.getTime() > NO_CI_AFTER_MS;
    if (status === "success") {
      await withTx(d.pool, (c) => transitionItem(c, row.item_id, "dod_verified", system));
    } else if (status === "failure" || silent) {
      await withTx(d.pool, (c) => transitionItem(c, row.item_id, "dod_failed", system));
      const body = silent
        ? `No CI ran on main for the merge commit ${row.merge_sha} within an hour, so the item failed its Definition of Done.`
        : `CI failed on main for the merge commit ${row.merge_sha}, so the item failed its Definition of Done.`;
      await d.backlogFor(row.source_id).comment(row.external_id, body, `ci:${row.merge_sha}`);
    }
  }
}

/**
 * Starts one cell when the WIP limit has room. Nothing starts while usage is paused or any run waits for its usage
 * reset, as spec §7 requires. While the waiting count is at review_capacity, only work already in flight starts.
 */
async function startNext(d: TickDeps, result: TickResult) {
  const policy = (await d.pool.query<{ current_wip: number; review_capacity: number; usage_paused_until: Date | null }>(
    "select current_wip, review_capacity, usage_paused_until from wip_policy limit 1",
  )).rows[0];
  if (policy.usage_paused_until && policy.usage_paused_until > d.now) return;
  const counts = (await d.pool.query<{ running: number; waiting: number; resuming: boolean }>(
    `select
       (select count(*)::int from item where state = 'InProgress') as running,
       (select count(*)::int from item i where i.state = 'InReview'
          or (i.state in ('SignOff', 'NeedsInput')
            and exists (select from question q where q.item_id = i.id and q.answer is null and q.closed_at is null))) as waiting,
       exists (select from run where ended_at is null and resume_at > $1) as resuming`,
    [d.now],
  )).rows[0];
  if (counts.resuming || counts.running >= policy.current_wip) return;

  let started: string | null;
  try {
    started = await claimAndStart(d, counts.waiting >= policy.review_capacity);
  } catch (e) {
    if (!(e instanceof PinError)) throw e;
    // The claim rolled back. Held, the item can't come first in line again, so it never blocks the items behind it.
    await d.pool.query("update item set held = true where id = $1", [e.itemId]);
    await d.backlogFor(e.sourceId).comment(e.externalId, `The factory can't start this item: ${e.message}. Fix it, then re-queue the item.`, `pin:${e.message}`);
    return;
  }
  if (started) result.started.push(started);
}

/** Thrown when a run can't be pinned for a reason that a retry won't fix. */
class PinError extends Error {
  itemId: string;
  sourceId: string;
  externalId: string;
  constructor(message: string, itemId: string, sourceId: string, externalId: string) {
    super(message);
    this.itemId = itemId;
    this.sourceId = sourceId;
    this.externalId = externalId;
  }
}

async function claimAndStart(d: TickDeps, resumeOnly: boolean): Promise<string | null> {
  return withTx(d.pool, async (c) => {
    const claim = await claimNext(c, "scheduler", d.now, { resumeOnly });
    if (!claim) return null;
    const run = (await c.query<{ next_stage: string; config_sha: string | null; source_id: string; external_id: string }>(
      "select r.next_stage, r.config_sha, i.source_id, i.external_id from run r join item i on i.id = r.item_id where r.id = $1",
      [claim.runId],
    )).rows[0];
    // A run's first claim pins the repo, its config commit and the SOP, and records the criteria it started from.
    // Any failure rolls the claim back, so the item stays where it was.
    if (run.config_sha === null) {
      const item = await d.backlogFor(run.source_id).getItem(run.external_id);
      const fail = (why: string) => new PinError(why, claim.itemId, run.source_id, run.external_id);
      if (!item?.repo) throw fail("the item names no repo");
      const repo = await c.query<{ id: string }>("select id from repo where url = $1", [`https://github.com/${item.repo}`]);
      if (!repo.rowCount) throw fail(`the repo ${item.repo} isn't configured`);
      const sha = await d.repoHost.defaultBranchSha(item.repo);
      await c.query("update run set repo_id = $2, config_sha = $3, sop_version = $4 where id = $1", [claim.runId, repo.rows[0].id, sha, d.sopVersion]);
      await c.query("update item set criteria_hash = $2 where id = $1", [claim.itemId, criteriaHash(item.acceptanceCriteria)]);
    }
    // Run contract 5: these six and nothing else. The launcher adds only the model and egress variables.
    const env = {
      RUN_ID: claim.runId, ITEM_ID: claim.itemId, GENERATION: String(claim.generation),
      RUN_TOKEN: runToken(d.secret, claim.runId, claim.generation), CONTROL_URL: d.controlUrl, RESUME_FROM: run.next_stage,
    };
    const name = await d.launcher.start(env);
    await c.query("update run set execution_name = $2 where id = $1", [claim.runId, name]);
    return name;
  });
}
