// The scheduler (plan Task 13). Every TICK_MS it applies operator overrides, sends back expired leases, times out
// and reminds questions nobody answered and feature change requests nobody decided (PBI 366), polls CI on merged
// items, re-checks items that failed on main (PBI 369), and starts a cell for each free slot under the WIP limit.
// Everything it decides comes from the database, so a restarted process picks up where the old one stopped and never
// starts a second cell for an item with a live lease (Review Focus 5).
import type pg from "pg";
import type { BacklogAdapter, CheckRun, RepoHost } from "../adapters/types.ts";
import { DEFAULT_FAILED_RECHECK_HOURS, failedRecheckHours } from "../config/repo-config.ts";
import { BASE, runToken } from "../control/cell-api.ts";
import { minutes, SLOW_TICK_MS, watch, watched, type Slow, type Watch } from "../control/slow-work.ts";
import type { ItemEvent } from "../core/states.ts";
import { withTx } from "../store/db.ts";
import { appendEvent, type Actor } from "../store/events.ts";
import { FAILED_ON_MAIN, LAST_RECHECK } from "../store/rechecks.ts";
import { claimNext, expireLeases, overrideItem, transitionItem, withdrawnBeforeQueue } from "../store/items.ts";
import { activeOverrides, clearItemOverrides } from "../store/overrides.ts";
import { repoName, runBranch } from "../store/runs.ts";
// The poller compares against the same hash, so a claim and a poll can never disagree about unchanged criteria.
import { criteriaHash } from "../watcher/poller.ts";
import type { Launcher } from "./launcher.ts";
import { bugItem, compareWithParent, failingTests, type FailedCheck } from "./main-break.ts";

export const TICK_MS = 15_000;
const DAY_MS = 86_400_000;
const REMIND_AT_MS = [2 * DAY_MS, 4 * DAY_MS];
const TIMEOUT_MS = 5 * DAY_MS;
const NO_CI_AFTER_MS = 3_600_000;

export type TickDeps = {
  pool: pg.Pool;
  launcher: Launcher;
  now: Date;
  /** FACTORY_KILL=1 at worker start. It stops every cell, as a kill override does. */
  killFlag: boolean;
  repoHost: RepoHost;
  backlogFor: (sourceId: string) => BacklogAdapter;
  /** The secret that signs each cell's RUN_TOKEN, shared with the cell API. */
  secret: string;
  /** The control plane's URL as a cell reaches it, passed to the cell as CONTROL_URL. */
  controlUrl: string;
  /** The version of the loaded SOP file, pinned on a run's first claim. */
  sopVersion: string;
  /** Where a tick that runs long warns, and the clock that times it (PBI 134). */
  slow?: Slow;
  /** Failed CI reads kept across ticks, so a long red main doesn't re-read every commit each tick. Absent, each pass reads afresh. */
  ciMemo?: CiMemo;
  /** PBI 369: each repo's `failed_recheck_hours` kept across ticks. Absent, each pass reads config.yml afresh. */
  recheckHours?: RecheckHoursMemo;
};
export type TickResult = { started: string[]; stopped: string[]; expired: string[] };

const system: Actor = { actor: "system", actorId: "scheduler" };

/**
 * Runs one item's or one cell's step and logs a failure instead of throwing, so one broken call can't stop the kill
 * switch reaching the other cells, or wedge every later tick before leases expire. The step retries next tick.
 */
async function isolated(what: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(`scheduler: ${what} failed, retrying next tick:`, e);
  }
}

/** One tick. One that runs for 5 minutes warns, and again every 5 minutes, naming the step it is in (PBI 134). */
export async function tick(d: TickDeps): Promise<TickResult> {
  const w = watch(SLOW_TICK_MS, SLOW_TICK_MS, (ms, step) => `slow: the scheduler tick has run for ${minutes(ms)}, in step "${step}"`, d.slow);
  return watched(w, () => tickSteps(d, w));
}

async function tickSteps(d: TickDeps, w: Watch): Promise<TickResult> {
  const result: TickResult = { started: [], stopped: [], expired: [] };
  w.step("applying overrides");
  const overrides = await activeOverrides(d.pool, d.now);
  const factory = (kind: string) => overrides.some((o) => o.scope === "factory" && o.kind === kind);

  // The kill switch stops every cell with a live lease and starts nothing. Their leases then run out as usual.
  if (d.killFlag || factory("kill")) {
    w.step("stopping every cell");
    for (const { execution_name } of await liveCells(d)) {
      await isolated(`stopping ${execution_name}`, async () => {
        await d.launcher.stop(execution_name);
        result.stopped.push(execution_name);
      });
    }
    return result;
  }

  await applyItemOverrides(d, overrides, result);
  w.step("expiring leases");
  result.expired = await withTx(d.pool, (c) => expireLeases(c, d.now));
  w.step("chasing questions");
  await chaseQuestions(d);
  await chaseFeatureChanges(d);
  w.step("polling merged CI");
  await pollMergedCi(d);
  w.step("re-checking Failed items");
  await recheckFailed(d);
  // Prepare restart (PBI 140): cells are told to stop at their next renewal and wrap up in their own time. The scheduler
  // never stops one itself, however long it runs (PBI 300). Nothing starts until the control plane or the worker
  // restarts, or an operator resumes.
  if (factory("pause") || factory("drain") || factory("restart")) return result;
  w.step("starting the next item");
  await startNext(d, result);
  return result;
}

/** Every cell with a live lease, by the execution name the launcher gave it. */
async function liveCells(d: TickDeps) {
  return (await d.pool.query<{ item_id: string; run_id: string; generation: number; execution_name: string }>(
    `select i.id as item_id, r.id as run_id, i.lease_generation as generation, r.execution_name
     from item i join run r on r.item_id = i.id and r.ended_at is null
     where i.state = 'InProgress' and i.lease_expires > $1 and r.execution_name is not null`,
    [d.now],
  )).rows;
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
 * other overrides end when it reaches Done, Failed, Abandoned or Split. A requeue stays until it runs, so one that
 * throws retries next tick.
 */
async function applyItemOverrides(d: TickDeps, overrides: Awaited<ReturnType<typeof activeOverrides>>, result: TickResult) {
  for (const o of overrides) {
    if (o.scope !== "item" || !o.targetId) continue;
    const itemId = o.targetId;
    await isolated(`${o.kind} on item ${itemId}`, async () => {
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
        await stopRun(d, itemId, o, result);
      }
    });
  }
  await d.pool.query(
    `update override o set cleared_at = $1 from item i
     where o.cleared_at is null and o.scope = 'item' and o.kind <> 'requeue' and o.target_id = i.id
       and i.state in ('Done', 'Failed', 'Abandoned', 'Split')`,
    [d.now],
  );
}

/**
 * Stops the cell, then fails and holds the item and uses up the override in one transaction. A stop that throws
 * leaves all three for the next tick. The comment naming the kept branch comes last and is best effort.
 */
async function stopRun(d: TickDeps, itemId: string, o: { id: string; reason: string }, result: TickResult) {
  const row = await itemRow(d.pool, itemId);
  if (row?.state !== "InProgress") return void (await clearItemOverrides(d.pool, itemId, ["stop_run"]));
  if (row.execution_name) {
    await d.launcher.stop(row.execution_name);
    result.stopped.push(row.execution_name);
  }
  await withTx(d.pool, async (c) => {
    await overrideItem(c, itemId, "Failed", system, o.reason);
    await c.query("update item set held = true where id = $1", [itemId]);
    await clearItemOverrides(c, itemId, ["stop_run"]);
  });
  const branch = row.run_number !== null ? runBranch({ branch: row.branch, externalId: row.external_id, runNumber: row.run_number }) : null;
  const body = branch
    ? `An operator stopped this run: ${o.reason}. Its work is kept on the branch \`${branch}\`. Re-queue it to carry on.`
    : `An operator stopped this run: ${o.reason}. Re-queue it to carry on.`;
  await isolated(`commenting the stop on item ${itemId}`, () => d.backlogFor(row.source_id).comment(row.external_id, body, `stopped:${o.id}`));
}

/**
 * Sends a Failed or Abandoned item back and clears its hold (Run contract 1 and 7). One withdrawn from Eligible or
 * NotReady goes back to Eligible, through the readiness gate again (PBI 168). An Abandoned item whose question
 * is still open goes back to waiting on it, with the clock and reminders reset. A run whose PR merged gives way to a
 * new run on a new branch. A run whose PR a person closed unmerged resumes at open-pr, from the kept branch, even
 * when a question was open, which then closes (PBI 194).
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
    const open = await c.query<{ id: string; kind: string; body: string }>(
      "select id, kind, body from question where item_id = $1 and answer is null and closed_at is null order by asked_at desc limit 1",
      [itemId],
    );
    // A person closed the PR, by hand or by the poller or webhook's withdrawal, so the item resumes at open-pr as it
    // does from InReview. A question it waited on when the PR closed closes too: reopening it would send the item
    // back to NeedsInput holding the closed PR, and the next poll would withdraw it again (PBI 194).
    if (prClosed && open.rowCount) {
      await c.query("update question set closed_at = now() where item_id = $1 and answer is null and closed_at is null", [itemId]);
    } else if (row.state === "Abandoned" && open.rowCount) {
      const event: ItemEvent = open.rows[0].kind === "sign_off" ? "reopened_signoff" : "reopened_question";
      // The worker quotes the question on the board from the transition's payload, so the person sees what they are
      // asked again (PBI 219).
      await transitionItem(c, itemId, event, system, { question: open.rows[0].body });
      await c.query("update question set asked_at = $2, reminders_sent = 0 where id = $1", [open.rows[0].id, d.now]);
      return;
    }
    // An item withdrawn before it was Queued never passed the readiness gate, so it goes back to Eligible to meet it
    // again rather than straight to Queued (PBI 168).
    if (row.state === "Abandoned" && (await withdrawnBeforeQueue(c, itemId))) {
      await transitionItem(c, itemId, "returned", system);
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
      // The closed PR is dropped, so the poller, which reads an InProgress run's PR, doesn't withdraw the item again
      // while open-pr opens a fresh one from the kept branch (PBI 142).
      await c.query("update run set next_stage = 'open-pr', pr_number = null, pr_url = null where id = $1", [row.run_id]);
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
    await isolated(`chasing question ${q.id}`, async () => {
      const age = d.now.getTime() - q.asked_at.getTime();
      if (age > TIMEOUT_MS) return void (await withTx(d.pool, (c) => transitionItem(c, q.item_id, "timed_out", system)));
      const due = REMIND_AT_MS.filter((at) => age >= at).length;
      if (due <= q.reminders_sent) return;
      const body = `Reminder: this item is still waiting for you. With no answer it's abandoned ${Math.ceil((TIMEOUT_MS - age) / DAY_MS)} days from now.`;
      // asked_at is in the key, because a re-queue resets it and the reminders start again under new keys.
      await d.backlogFor(q.source_id).comment(q.external_id, body, `reminder:${q.id}:${q.asked_at.toISOString()}:${due}`);
      await d.pool.query("update question set reminders_sent = $2 where id = $1", [q.id, due]);
    });
  }
}

/**
 * An item in FeatureChangeRequest waits on the owner as one in SignOff does (PBI 366): reminded at 2 and 4 days, once
 * each, and abandoned after 5. Its clock starts at its latest move to FeatureChangeRequest, not at any question.
 */
async function chaseFeatureChanges(d: TickDeps) {
  const r = await d.pool.query<{ id: string; run_id: string; since: Date; reminders_sent: number; source_id: string; external_id: string }>(
    `select i.id, r.id as run_id, r.feature_change_reminders as reminders_sent, i.source_id, i.external_id,
       (select max(at) from event e where e.item_id = i.id and e.kind = 'transition' and e.payload->>'to' = 'FeatureChangeRequest') as since
     from item i join lateral (select id, feature_change_reminders from run where item_id = i.id order by run_number desc, started_at desc limit 1) r on true
     where i.state = 'FeatureChangeRequest'`,
  );
  for (const f of r.rows) {
    if (!f.since) continue;
    await isolated(`chasing the feature change request of item ${f.external_id}`, async () => {
      const age = d.now.getTime() - f.since.getTime();
      if (age > TIMEOUT_MS) return void (await withTx(d.pool, (c) => transitionItem(c, f.id, "timed_out", system)));
      const due = REMIND_AT_MS.filter((at) => age >= at).length;
      if (due <= f.reminders_sent) return;
      const body = `Reminder: this item is still waiting for you to decide on its feature change request. With no decision it's abandoned ${Math.ceil((TIMEOUT_MS - age) / DAY_MS)} days from now.`;
      // The move's time is in the key, so a later request on the same run is reminded under new keys.
      await d.backlogFor(f.source_id).comment(f.external_id, body, `feature-change-reminder:${f.run_id}:${f.since.toISOString()}:${due}`);
      await d.pool.query("update run set feature_change_reminders = $2 where id = $1", [f.run_id, due]);
    });
  }
}

/** The newest commits of a branch that a green one is looked for in, so a long red stretch costs a bounded number of reads. */
const GREEN_LOOKBACK = 50;

/**
 * How long a failed CI read of a branch commit is trusted before it's read again. The green search on a red branch
 * walks up to GREEN_LOOKBACK commits, and every one is red, so reading each afresh every 15-second tick would cost
 * thousands of GitHub requests an hour. A failure rarely changes, but a re-run can turn it green, so it's re-read
 * after this long. A commit not yet failed, a new head among them, is read every pass.
 */
export const FAILED_RECHECK_MS = 10 * 60_000;

/** Failed CI reads of branch commits, keyed by repo and sha, with when each was read. One lives for the worker's life. */
export type CiMemo = Map<string, number>;

type MergedCiDeps = Pick<TickDeps, "pool" | "repoHost" | "backlogFor" | "now" | "ciMemo">;

/**
 * An Accepted item is Done once CI on its merge commit passes, and Failed when it never reports within an hour. A red
 * merge commit is compared with its first parent (PBI 255). When a check failed that the first parent passed, the
 * merge broke main: the item is Failed, the break is recorded and the factory files one bug item for it. When the first
 * parent failed the same checks, main was already red: the item stays Accepted and waits on main, and is Done once CI
 * passes on a later main commit, which also clears every break before it. The exception is the bug item of a standing
 * break: its merge is the fix for main, so main still red after it fails the item. Exported for PBI 255's steps, which run it
 * after each poll.
 */
export async function pollMergedCi(d: MergedCiDeps) {
  // One read of each commit's status per pass, however many items and breaks ask about it.
  const statuses = new Map<string, Promise<string>>();
  const status = (repo: string, sha: string) => {
    const key = `${repo}@${sha}`;
    if (!statuses.has(key)) statuses.set(key, d.repoHost.checksOnSha(repo, sha));
    return statuses.get(key)!;
  };
  await settleMerges(d, status);
  await fileBugItems(d);
  await d.pool.query(
    `update main_break b set bug_item_id = i.id from item i, item charged
     where b.bug_item_id is null and b.bug_external_id = i.external_id and charged.id = b.item_id and i.source_id = charged.source_id`,
  );
  await settleBranches(d, greenOn(d, remembered(d, status)));
}

/** How long a repo's `failed_recheck_hours` is trusted before config.yml is read again, so a tick doesn't read it each time. */
export const RECHECK_CONFIG_MS = 10 * 60_000;

/** Each repo's `failed_recheck_hours`, with when it was read. One lives for the worker's life. */
export type RecheckHoursMemo = Map<string, { hours: number; at: number }>;

type RecheckDeps = MergedCiDeps & { recheckHours?: RecheckHoursMemo };

/** The repo's `failed_recheck_hours` from config.yml on main, 8 when the key is missing, or when the file can't be read or is wrong. */
async function recheckHoursOf(d: RecheckDeps, repo: string): Promise<number> {
  const now = d.now.getTime();
  const memo = d.recheckHours?.get(repo);
  if (memo && now - memo.at < RECHECK_CONFIG_MS) return memo.hours;
  let hours = DEFAULT_FAILED_RECHECK_HOURS;
  try {
    hours = failedRecheckHours(await d.repoHost.readFile(repo, BASE, ".factory/config.yml"));
  } catch (e) {
    console.error(`scheduler: reading failed_recheck_hours for ${repo} failed, so Failed items there are re-checked every ${hours} hours:`, e);
  }
  d.recheckHours?.set(repo, { hours, at: now });
  return hours;
}

/**
 * PBI 369: re-checks each item that went to Failed with `dod_failed`, every `failed_recheck_hours` hours after it failed
 * (8 when the repo's .factory/config.yml has no such key), by running today's post-merge rules on its merge commit, as
 * an Accepted item's gets. Each re-check records an event of kind `recheck` on the item at `d.now`, so Floor and Run
 * detail show when it was last re-checked. When the rules no longer say the merge broke main, the item goes from Failed
 * to Accepted with the event `rechecked` in the same transaction, waits on main as the rules say, and gets one comment
 * saying why. Otherwise nothing else changes and nothing is commented, so a re-check that changes nothing makes no
 * noise. The tick runs it after pollMergedCi.
 */
export async function recheckFailed(d: RecheckDeps): Promise<void> {
  const r = await d.pool.query<MergeRow & { since: Date }>(
    `select i.id as item_id, r.id as run_id, r.repo_id, r.merge_sha, r.pr_number, repo.url as repo_url, i.source_id, i.external_id,
       (select max(e.at) from event e where e.item_id = i.id and e.kind = 'transition' and e.payload->>'to' = 'Accepted') as merged_at,
       coalesce(${LAST_RECHECK}, f.at) as since
     from item i ${FAILED_ON_MAIN}
     join lateral (select * from run where run.item_id = i.id and run.ended_at is null and run.merge_sha is not null order by run.run_number desc limit 1) r on true
     join repo on repo.id = r.repo_id
     where i.state = 'Failed'
     order by since`,
  );
  // One read of each commit's status per pass, however many items ask about it.
  const statuses = new Map<string, Promise<string>>();
  const status: Status = (repo, sha) => {
    const key = `${repo}@${sha}`;
    if (!statuses.has(key)) statuses.set(key, d.repoHost.checksOnSha(repo, sha));
    return statuses.get(key)!;
  };
  for (const row of r.rows) {
    await isolated(`re-checking item ${row.item_id}`, async () => {
      const hours = await recheckHoursOf(d, repoName(row.repo_url));
      if (d.now.getTime() - row.since.getTime() < hours * 3_600_000) return;
      const v = await verdictOn(d, status, row);
      const back = v.kind === "passed" || v.kind === "wait";
      // The re-check's own event id keys its comment, so a retried comment is posted once.
      const recheckId = await withTx(d.pool, async (c) => {
        const id = await appendEvent(c, { ...system, itemId: row.item_id, kind: "recheck", payload: { merge_sha: row.merge_sha, verdict: v.kind, moved: back }, at: d.now });
        if (v.kind === "passed" || v.kind === "wait") {
          await transitionItem(c, row.item_id, "rechecked", system);
          if (v.kind === "wait") await waitOnMain(d, c, row, v);
        }
        return id;
      });
      if (!back) return;
      const why = v.kind === "passed"
        ? `CI now passes on ${BASE} for the merge commit ${row.merge_sha}`
        : v.kind === "wait" && v.why === "already red"
          ? `CI failed on ${BASE} for the merge commit ${row.merge_sha}, but its first parent ${v.parent} failed the same checks, so ${BASE} was already red`
          : `CI on ${BASE} for the merge commit ${row.merge_sha} was cancelled, and no check failed`;
      const next = v.kind === "passed"
        ? "The item is Accepted again, and it's Done once the factory next reads CI on the merge commit."
        : `The item is Accepted again and waits on ${BASE}, and it's Done once CI passes on a later ${BASE} commit.`;
      const body = `Re-check: ${why}. Today's post-merge rules no longer say the merge broke ${BASE}, so the item no longer fails its Definition of Done. ${next}`;
      await isolated(`commenting the re-check on item ${row.item_id}`, () => d.backlogFor(row.source_id).comment(row.external_id, body, `rechecked:${recheckId}`));
    });
  }
}

/**
 * The status of a branch commit for the green search, answered "failure" from the memo while the failure was read
 * less than FAILED_RECHECK_MS ago. Only the green search uses it: an Accepted item's own merge commit is read afresh.
 */
function remembered(d: MergedCiDeps, status: Status): Status {
  const memo = d.ciMemo;
  if (!memo) return status;
  const now = d.now.getTime();
  for (const [key, at] of memo) if (now - at >= FAILED_RECHECK_MS) memo.delete(key);
  return async (repo, sha) => {
    const key = `${repo}@${sha}`;
    if (memo.has(key)) return "failure";
    const state = await status(repo, sha);
    if (state === "failure") memo.set(key, now);
    return state;
  };
}

type Status = (repo: string, sha: string) => Promise<string>;
/** The newest commit of `branch` that contains `sha`, `sha` itself included, on which CI passed, or null when none has. */
type GreenSince = (repo: string, branch: string, sha: string) => Promise<string | null>;

/**
 * GreenSince for one pass. Each branch's first-parent line is read once, from the first sha asked about, and its newest
 * green commit found once, so every waiting item and break on the branch is answered from that one read. Only a sha off
 * every line read so far, older than the first or off the branch, reads the branch again, from that sha.
 */
function greenOn(d: MergedCiDeps, status: Status): GreenSince {
  const lines = new Map<string, Promise<{ line: string[]; green: number }>[]>();
  const read = async (repo: string, branch: string, sha: string) => {
    const line = [sha, ...(await d.repoHost.commitsAfter(repo, branch, sha))];
    for (let i = line.length - 1; i >= Math.max(0, line.length - GREEN_LOOKBACK); i--) if ((await status(repo, line[i])) === "success") return { line, green: i };
    return { line, green: -1 };
  };
  return async (repo, branch, sha) => {
    const key = `${repo}@${branch}`;
    if (!lines.has(key)) lines.set(key, []);
    for (const earlier of lines.get(key)!) {
      // A read that failed answers nothing; the row that asked it already logged the failure.
      const { line, green } = await earlier.catch(() => ({ line: [] as string[], green: -1 }));
      const at = line.indexOf(sha);
      if (at >= 0) return green >= at ? line[green] : null;
    }
    const mine = read(repo, branch, sha);
    lines.get(key)!.push(mine);
    const { line, green } = await mine;
    return green >= 0 ? line[green] : null;
  };
}

type MergeRow = {
  item_id: string; run_id: string; repo_id: string; merge_sha: string; pr_number: number | null; repo_url: string;
  source_id: string; external_id: string; merged_at: Date | null;
};

/**
 * What today's post-merge rules say of a merge commit (PBI 255), read afresh from CI. `passed`: CI passed on it, so the
 * item is Done. `not yet`: CI hasn't said enough, so the next pass asks again. `wait`: the merge broke nothing, since
 * its only unpassed checks were cancelled or its first parent failed the same checks, so the item waits on main.
 * `charge`: the merge failed its Definition of Done, with the checks it failed that its first parent passed, or none
 * when there's nothing to compare. A Failed item's re-check asks the same (PBI 369).
 */
type Verdict =
  | { kind: "passed" }
  | { kind: "not yet" }
  | { kind: "wait"; why: "cancelled" }
  | { kind: "wait"; why: "already red"; parent: string | null; parentRuns: CheckRun[] }
  | { kind: "charge"; body: string; failed: CheckRun[] | null };

async function verdictOn(d: MergedCiDeps, status: Status, row: MergeRow): Promise<Verdict> {
  const repo = repoName(row.repo_url);
  const state = await status(repo, row.merge_sha);
  const late = row.merged_at !== null && d.now.getTime() - row.merged_at.getTime() > NO_CI_AFTER_MS;
  if (state === "success") return { kind: "passed" };
  if (state === "none" && late) return { kind: "charge", body: `No CI ran on ${BASE} for the merge commit ${row.merge_sha} within an hour, so the item failed its Definition of Done.`, failed: null };
  if (state !== "failure") return { kind: "not yet" };

  const parent = await d.repoHost.firstParent(repo, row.merge_sha);
  const parentRuns = parent ? await d.repoHost.checkRuns(repo, parent) : [];
  const cmp = compareWithParent(await d.repoHost.checkRuns(repo, row.merge_sha), parentRuns);
  // A failed check still running on the first parent can't be compared yet. After an hour it counts as passed there.
  if (cmp.verdict === "undecided" && !late) return { kind: "not yet" };
  // No check failed on the merge: its only unpassed runs were cancelled, as when a later merge's push cancelled them
  // under `cancel-in-progress`. It broke nothing, so it isn't charged and no break is recorded.
  if (cmp.verdict === "cancelled") return { kind: "wait", why: "cancelled" };
  if (cmp.verdict === "already red") {
    // The bug item of a standing break is the fix for main. Its merge leaving main red fails it, rather than parking
    // the one item that can make main green behind itself. No new break is recorded, so no second bug item is filed.
    const fixes = await d.pool.query(
      "select 1 from main_break where repo_id = $1 and branch = $2 and bug_item_id = $3 and cleared_at is null limit 1",
      [row.repo_id, BASE, row.item_id],
    );
    if (fixes.rowCount) {
      return { kind: "charge", body: `CI failed on ${BASE} for the merge commit ${row.merge_sha}, the fix for ${BASE} being red, and ${BASE} is still red, so the item failed its Definition of Done. The failed run: https://github.com/${repo}/commit/${row.merge_sha}/checks`, failed: null };
    }
    return { kind: "wait", why: "already red", parent, parentRuns };
  }
  return {
    kind: "charge",
    body: `CI failed on ${BASE} for the merge commit ${row.merge_sha}, so the item failed its Definition of Done. The failed run: https://github.com/${repo}/commit/${row.merge_sha}/checks`,
    failed: cmp.verdict === "no checks" ? null : cmp.failed,
  };
}

/**
 * Sets the item's run to wait on main, inside the caller's transaction. When main was already red and no break stands,
 * main went red with no merge of the factory's to charge, by a push or a PR the factory doesn't hold. The break is
 * recorded at the first parent, the oldest red commit the factory knows of, with no item and no bug item, so Floor
 * shows main red until CI passes on it again. The factory files no bug item for a break it didn't make.
 */
async function waitOnMain(d: MergedCiDeps, c: pg.PoolClient, row: MergeRow, v: Extract<Verdict, { kind: "wait" }>) {
  await c.query("update run set waits_on_branch = $2 where id = $1", [row.run_id, BASE]);
  if (v.why !== "already red") return;
  await c.query(
    `insert into main_break (repo_id, branch, merge_sha, failed_checks, at)
     select $1, $2, $3, $4, $5 where not exists (select from main_break where repo_id = $1 and branch = $2 and cleared_at is null)
     on conflict (repo_id, merge_sha) do nothing`,
    [row.repo_id, BASE, v.parent, JSON.stringify(v.parentRuns.filter((r) => r.status === "failure").map((r): FailedCheck => ({ name: r.name, url: r.url, tests: [] }))), d.now],
  );
}

const WAITS = `The item stays Accepted and waits on ${BASE}, and it's Done once CI passes on a later ${BASE} commit.`;

async function settleMerges(d: MergedCiDeps, status: Status) {
  const r = await d.pool.query<MergeRow>(
    `select i.id as item_id, r.id as run_id, r.repo_id, r.merge_sha, r.pr_number, repo.url as repo_url, i.source_id, i.external_id,
       (select max(e.at) from event e where e.item_id = i.id and e.kind = 'transition' and e.payload->>'to' = 'Accepted') as merged_at
     from item i join run r on r.item_id = i.id and r.ended_at is null and r.merge_sha is not null join repo on repo.id = r.repo_id
     where i.state = 'Accepted' and r.waits_on_branch is null
     order by merged_at nulls last`,
  );
  for (const row of r.rows) {
    await isolated(`polling CI for item ${row.item_id}`, async () => {
      const v = await verdictOn(d, status, row);
      if (v.kind === "passed") return void (await withTx(d.pool, (c) => transitionItem(c, row.item_id, "dod_verified", system)));
      if (v.kind === "not yet") return;
      if (v.kind === "wait") {
        await withTx(d.pool, (c) => waitOnMain(d, c, row, v));
        const body = v.why === "cancelled"
          ? `CI on ${BASE} for the merge commit ${row.merge_sha} was cancelled before it finished, as when a later push to ${BASE} cancels it, and no check failed. ${WAITS}`
          : `CI failed on ${BASE} for the merge commit ${row.merge_sha}, but its first parent ${v.parent} failed the same checks, so ${BASE} was already red. ${WAITS}`;
        await isolated(`commenting the wait on item ${row.item_id}`, () => d.backlogFor(row.source_id).comment(row.external_id, body, `ci-wait:${row.merge_sha}`));
        return;
      }
      if (!v.failed) return charge(d, row, v.body);
      const repo = repoName(row.repo_url);
      const checks: FailedCheck[] = [];
      for (const run of v.failed) {
        const log = await d.repoHost.checkLog(repo, row.merge_sha, run.name).catch((e) => {
          console.error(`scheduler: reading the log of ${run.name} on ${row.merge_sha} failed, so its tests go unnamed:`, e);
          return null;
        });
        checks.push({ name: run.name, url: run.url, tests: failingTests(log) });
      }
      await charge(d, row, v.body, checks);
    });
  }
}

/** Fails the item and comments why. With `broke`, the merge broke main: the break is recorded in the same transaction. */
async function charge(d: MergedCiDeps, row: { item_id: string; repo_id: string; merge_sha: string; pr_number: number | null; source_id: string; external_id: string }, body: string, broke: FailedCheck[] | null = null) {
  await withTx(d.pool, async (c) => {
    await transitionItem(c, row.item_id, "dod_failed", system);
    if (broke) {
      // A later merge onto this one may have found main already red and recorded an uncharged break here while this
      // merge was still undecided. This merge broke main, so it takes that row over, and its bug item gets filed.
      await c.query(
        `insert into main_break (repo_id, branch, merge_sha, item_id, pr_number, failed_checks, at) values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (repo_id, merge_sha) do update set item_id = excluded.item_id, pr_number = excluded.pr_number, failed_checks = excluded.failed_checks
         where main_break.item_id is null`,
        [row.repo_id, BASE, row.merge_sha, row.item_id, row.pr_number, JSON.stringify(broke), d.now],
      );
    }
  });
  await isolated(`commenting CI on item ${row.item_id}`, () => d.backlogFor(row.source_id).comment(row.external_id, body, `ci:${row.merge_sha}`));
}

/**
 * Files the bug item of each standing break that has none yet. A break that cleared before its bug item was filed, as
 * when filing failed for a few polls or a merge took over a cleared row, gets none: main is already green. The dedupe
 * key keeps a retry after a lost answer from filing a second.
 */
async function fileBugItems(d: MergedCiDeps) {
  const r = await d.pool.query<{ id: string; merge_sha: string; branch: string; pr_number: number | null; pr_url: string | null; failed_checks: FailedCheck[]; repo_url: string; source_id: string; external_id: string }>(
    `select b.id, b.merge_sha, b.branch, b.pr_number, b.failed_checks, repo.url as repo_url, i.source_id, i.external_id,
       (select r.pr_url from run r where r.item_id = b.item_id and r.merge_sha = b.merge_sha order by r.started_at desc limit 1) as pr_url
     from main_break b join repo on repo.id = b.repo_id join item i on i.id = b.item_id
     where b.bug_external_id is null and b.cleared_at is null order by b.at`,
  );
  for (const b of r.rows) {
    await isolated(`filing the bug item for ${b.merge_sha}`, async () => {
      const { title, body } = bugItem({ sha: b.merge_sha, branch: b.branch, prNumber: b.pr_number, prUrl: b.pr_url, itemExternalId: b.external_id, checks: b.failed_checks });
      const externalId = await d.backlogFor(b.source_id).fileItem({ title, body, labels: [], repo: repoName(b.repo_url) }, `main-break:${b.merge_sha}`);
      await d.pool.query("update main_break set bug_external_id = $2 where id = $1", [b.id, externalId]);
    });
  }
}

/**
 * A break stands until CI passes on a commit of its branch that contains the merge commit that broke it, and an item
 * waiting on a branch is Done once CI passes on a commit of it that contains the item's merge commit. Breaks are asked
 * about first, oldest first, then waiting items in the order they merged, so the first sha asked about on a branch is
 * usually its oldest and its one read of the branch answers every row.
 */
async function settleBranches(d: MergedCiDeps, greenSince: GreenSince) {
  const breaks = await d.pool.query<{ id: string; merge_sha: string; branch: string; repo_url: string }>(
    "select b.id, b.merge_sha, b.branch, repo.url as repo_url from main_break b join repo on repo.id = b.repo_id where b.cleared_at is null order by b.at",
  );
  for (const b of breaks.rows) {
    await isolated(`checking whether ${b.merge_sha}'s break cleared`, async () => {
      const green = await greenSince(repoName(b.repo_url), b.branch, b.merge_sha);
      if (green) await d.pool.query("update main_break set cleared_at = $2, cleared_sha = $3 where id = $1", [b.id, d.now, green]);
    });
  }
  const waiting = await d.pool.query<{ item_id: string; merge_sha: string; branch: string; repo_url: string }>(
    `select i.id as item_id, r.merge_sha, r.waits_on_branch as branch, repo.url as repo_url
     from item i join run r on r.item_id = i.id and r.ended_at is null and r.merge_sha is not null join repo on repo.id = r.repo_id
     where i.state = 'Accepted' and r.waits_on_branch is not null
     order by (select max(e.at) from event e where e.item_id = i.id and e.kind = 'transition' and e.payload->>'to' = 'Accepted') nulls last`,
  );
  for (const row of waiting.rows) {
    await isolated(`checking the branch item ${row.item_id} waits on`, async () => {
      if (await greenSince(repoName(row.repo_url), row.branch, row.merge_sha)) {
        await withTx(d.pool, (c) => transitionItem(c, row.item_id, "dod_verified", system));
      }
    });
  }
}

/**
 * Starts a cell for each free slot under the WIP limit, so a live raise of current WIP fills the new slots in one tick
 * (PBI 177). With the running count at or over the limit, a lowered one, it starts nothing and stops nothing (spec §7,
 * Damping). Nothing starts while usage is paused or any run waits for its usage reset, as spec §7 requires. While the
 * waiting count is at review_capacity, only work already in flight starts. A pin failure or a failed start ends the
 * tick's starts, so an item sent back to Queued is never claimed twice in one tick.
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
          or i.state = 'FeatureChangeRequest'
          or (i.state in ('SignOff', 'NeedsInput')
            and exists (select from question q where q.item_id = i.id and q.answer is null and q.closed_at is null))) as waiting,
       exists (select from run where ended_at is null and resume_at > $1) as resuming`,
    [d.now],
  )).rows[0];
  if (counts.resuming) return;

  const resumeOnly = counts.waiting >= policy.review_capacity;
  for (let free = policy.current_wip - counts.running; free > 0; free--) {
    if (!(await startOne(d, resumeOnly, result))) return;
  }
}

/** Claims and starts one cell. False when nothing more should start this tick. */
async function startOne(d: TickDeps, resumeOnly: boolean, result: TickResult): Promise<boolean> {
  let started: string | null;
  try {
    started = await claimAndStart(d, resumeOnly);
  } catch (e) {
    if (!(e instanceof PinError)) throw e;
    // The claim rolled back. Held, the item can't come first in line again, so it never blocks the items behind it.
    await d.pool.query("update item set held = true where id = $1", [e.itemId]);
    // A held item reaches this once per hold, and the time keeps a second hold after a re-queue from reusing the key.
    const body = `The factory can't start this item: ${e.message}. Fix it, then re-queue the item.`;
    await isolated(`commenting the hold on item ${e.itemId}`, () => d.backlogFor(e.sourceId).comment(e.externalId, body, `pin:${d.now.toISOString()}`));
    return false;
  }
  if (!started) return false;
  result.started.push(started);
  return true;
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

/**
 * Claims and pins in one transaction, and starts the cell only after that commits. Starting inside the transaction
 * would let a rollback reuse the generation, and so the RUN_TOKEN, of a cell that had already started. A start that
 * fails moves the item out of InProgress, which raises the generation past anything the launcher might have begun.
 */
async function claimAndStart(d: TickDeps, resumeOnly: boolean): Promise<string | null> {
  const claimed = await claimAndPin(d, resumeOnly);
  if (!claimed) return null;
  const { claim, env } = claimed;
  let name: string;
  try {
    name = await d.launcher.start(env);
  } catch (e) {
    console.error(`scheduler: starting a cell for item ${claim.itemId} failed:`, e);
    await withTx(d.pool, async (c) => {
      const still = await c.query("select 1 from item where id = $1 and state = 'InProgress' and lease_generation = $2", [claim.itemId, claim.generation]);
      if (still.rowCount) await transitionItem(c, claim.itemId, "lease_expired", system);
    });
    return null;
  }
  await d.pool.query("update run set execution_name = $2 where id = $1", [claim.runId, name]);
  return name;
}

async function claimAndPin(d: TickDeps, resumeOnly: boolean) {
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
    return { claim, env };
  });
}
