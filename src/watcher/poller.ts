// The poller (plan Task 8): one pass over a backlog source and the PRs of the items it holds.
import { createHash } from "node:crypto";
import type pg from "pg";
import { loginKey, type BacklogAdapter, type FactoryItem, type RepoHost } from "../adapters/types.ts";
import { parseRepoConfig } from "../config/repo-config.ts";
import { minutes, SLOW_POLL_MS, watch, watched, type Slow, type Watch } from "../control/slow-work.ts";
import { CI_BACK_TO_GREEN, NO_REVIEW_TEXT, olderCiFailedQuestion } from "../core/questions.ts";
import type { ItemEvent, ItemState } from "../core/states.ts";
import { readinessLogic } from "../agent/run.ts";
import { gate, type GateContext } from "../gate/readiness.ts";
import { itemTextHash, splitUnanswered, type SplitDeps } from "../gate/split.ts";
import { keepSplit, keptSplit } from "../store/splits.ts";
import { loadPolicy, PolicyError, readinessSha, type DefaultPolicies, type Policy, type PolicyName, type ReadinessLogic } from "../policy/policy.ts";
import { withTx } from "../store/db.ts";
import { appendEvent } from "../store/events.ts";
import { logAttemptedMerge, mergeBlocker, mergedNote } from "./merge.ts";
import { IllegalTransition, transitionItem, upsertItem, withdrawnBeforeQueue } from "../store/items.ts";
import { recordReadinessCheck } from "../store/readiness-checks.ts";

export const POLL_INTERVAL_MS = 300_000;

export type PollDeps = {
  pool: pg.Pool;
  adapter: BacklogAdapter;
  repoHost: RepoHost;
  /** Reports what each call spent, so the gate records it as a readiness check (PBI 132). */
  judge: GateContext["judge"];
  sourceId: string;
  /** How the gate asks for a split of an oversized item (PBI 143). Without it, no split is asked for. */
  split?: SplitDeps;
  /** Where a poll that runs long warns, and the clock that times it (PBI 134). */
  slow?: Slow;
  /**
   * The factory's own readiness logic: the judge's prompt and the readiness version (PBI 149), and the split prompt
   * (PBI 159). The fingerprint covers it, so a restart with new logic re-checks every NotReady item. Unset, the
   * poller uses the code's own, readinessLogic().
   */
  logic?: ReadinessLogic;
  /**
   * Where the default policies come from, for a repo without its own (PBI 261): the worker reads them from the commit
   * of `main` it last fetched, for both the fingerprint and the gate's criteria. Unset, they come from the policy
   * directory beside the code.
   */
  defaults?: DefaultPolicies;
};

type Row = {
  id: string; external_id: string; state: ItemState; held: boolean; criteria_hash: string | null;
  readiness_policy_sha: string | null; readiness_item_hash: string | null;
  run_id: string | null; branch: string | null; pr_number: number | null; reviews_seen_at: Date | null; run_repo_url: string | null;
};

type Readiness = {
  sha: string; head: string; dor: Policy | null; policyErrors: string[]; dodExists: boolean; configValid: boolean; repoKnown: boolean;
  /** Each permission the App lacks on the repo (PBI 264). */
  missingPermissions: string[];
};

const system = { actor: "system", actorId: "poller" } as const;
const ACTIVE: ItemState[] = ["Queued", "InProgress", "SignOff", "NeedsInput", "InReview"];
/** States an item waits in before the readiness gate passes it. It holds no run, so leaving the backlog only withdraws it. */
const GATING: ItemState[] = ["Eligible", "NotReady"];
const POLICIES: PolicyName[] = ["dor", "scenarios", "pr-review", "risk", "dod"];
const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** SHA-256 of an item's acceptance criteria. A change since the run started sends the item back through Specify. */
export function criteriaHash(criteria: string[]): string {
  return sha256(criteria);
}

/**
 * SHA-256 of what the readiness check judges about the item itself. A NotReady item is re-gated when a person edits
 * it. Its open dependencies aren't judged (PBI 237): the scheduler skips a Queued item whose `blocked_by` isn't empty.
 */
export function readinessItemHash(fi: FactoryItem): string {
  return sha256({ title: fi.title, body: fi.body, criteria: fi.acceptanceCriteria, fields: fi.fields, repo: fi.repo });
}

const repoFromUrl = (url: string | null) => (url ? url.replace(/^https:\/\/github\.com\//, "") : null);

async function move(pool: pg.Pool, itemId: string, event: ItemEvent, also?: (c: pg.PoolClient) => Promise<unknown>): Promise<void> {
  await withTx(pool, async (c) => {
    await transitionItem(c, itemId, event, system);
    await also?.(c);
  });
}

async function items(pool: pg.Pool, sourceId: string, states: ItemState[]): Promise<Row[]> {
  const r = await pool.query<Row>(
    `select i.id, i.external_id, i.state, i.held, i.criteria_hash, i.readiness_policy_sha, i.readiness_item_hash,
            r.id as run_id, r.branch, r.pr_number, r.reviews_seen_at, rp.url as run_repo_url
     from item i
     left join lateral (select * from run where item_id = i.id and ended_at is null order by started_at desc limit 1) r on true
     left join repo rp on rp.id = r.repo_id
     where i.source_id = $1 and i.state = any($2)`,
    [sourceId, states],
  );
  return r.rows;
}

/**
 * Runs `fn` for each entry, so one item's failure never stops the rest of the poll. An IllegalTransition means
 * another poll or a webhook moved the item first, which counts as done. Returns how many entries failed.
 */
async function each<T>(list: T[], what: (t: T) => string, fn: (t: T) => Promise<void>): Promise<number> {
  let failed = 0;
  for (const t of list) {
    try {
      await fn(t);
    } catch (e) {
      if (e instanceof IllegalTransition) continue;
      failed++;
      console.error(`poller: ${what(t)} failed, retrying next poll:`, e);
    }
  }
  return failed;
}

/** Closes a run's PR if it's still open, with a comment that names the branch the factory keeps. */
async function closeOpenPr(host: RepoHost, repo: string | null, row: Row, why: string): Promise<void> {
  if (!repo || !row.pr_number) return;
  if (!(await host.prState(repo, row.pr_number, [])).open) return;
  await host.closePr(repo, row.pr_number, `${why} The factory closed this PR and keeps the branch \`${row.branch}\`.`);
}

/** Reads every readiness input for one repo at its default branch head, once per poll. */
async function readiness(
  pool: pg.Pool, host: RepoHost, repo: string | null, logic: ReadinessLogic, defaults?: DefaultPolicies,
): Promise<Readiness> {
  const known = repo !== null && (await pool.query("select 1 from repo where url = $1", [`https://github.com/${repo}`])).rowCount === 1;
  if (!repo || !known) {
    // The logic still counts, so a change to it re-checks these items too (PBI 149).
    const none = { dor: null, scenarios: null, "pr-review": null, risk: null, dod: null, config: null };
    return { sha: `unknown repo:${readinessSha(none, logic)}`, head: "", dor: null, policyErrors: [], dodExists: false, configValid: false, repoKnown: false, missingPermissions: [] };
  }
  const head = await host.defaultBranchSha(repo);
  const raw = new Map<string, string | null>();
  for (const path of [...POLICIES.map((n) => `.factory/${n}.md`), ".factory/config.yml"]) raw.set(path, await host.readFile(repo, head, path));
  const read = async (path: string) => raw.get(path) ?? null;

  // The hash covers each raw text, the default's text for an absent policy, and "absent" for a missing dod.md or config.
  const texts = { config: raw.get(".factory/config.yml") ?? null } as Parameters<typeof readinessSha>[0];
  for (const name of POLICIES) {
    const text = raw.get(`.factory/${name}.md`) ?? null;
    texts[name] = text ?? (name === "dod" ? null : (await loadPolicy(async () => null, name, defaults))!.text);
  }

  const policyErrors: string[] = [];
  const loaded = new Map<PolicyName, Policy | null>();
  for (const name of POLICIES) {
    try {
      loaded.set(name, await loadPolicy(read, name, defaults));
    } catch (e) {
      if (!(e instanceof PolicyError)) throw e;
      policyErrors.push(e.message);
      loaded.set(name, null);
    }
  }
  let configValid = true;
  try {
    parseRepoConfig(texts.config);
  } catch {
    configValid = false;
  }
  // A permission the owner grants later changes the sha, so a NotReady item it failed is gated again (PBI 264). A
  // repo missing none keeps the sha over its files and the logic alone.
  const missingPermissions = [...((await host.missingPermissions?.(repo)) ?? [])].sort();
  const sha = readinessSha(texts, logic);
  return {
    sha: missingPermissions.length > 0 ? `${sha}:missing:${missingPermissions.join(",")}` : sha, head, dor: loaded.get("dor") ?? null, policyErrors,
    dodExists: (loaded.get("dod") ?? null) !== null, configValid, repoKnown: true, missingPermissions,
  };
}

/**
 * Reads each default once per poll, so every repo in the poll sees the same text for it. A source that can be pinned
 * is pinned to one commit before the first read, so all the defaults in one poll come from that commit, even if a
 * fetch moves `main` mid-poll. Nothing is read, and nothing pinned, in a poll that needs no default.
 */
function oncePerPoll(defaults: DefaultPolicies): DefaultPolicies {
  let source: Promise<(name: Parameters<DefaultPolicies>[0]) => Promise<string>> | undefined;
  const read = new Map<string, Promise<string>>();
  return (name) => {
    source ??= defaults.pin ? defaults.pin() : Promise.resolve(defaults);
    if (!read.has(name)) read.set(name, source.then((r) => r(name)));
    return read.get(name)!;
  };
}

/**
 * The readiness fingerprint the poller takes for `repo` (PBI 261): the sha a NotReady item's stored one is compared
 * with. Given `defaults`, the defaults come from it, as the worker's come from `main`'s fetched commit.
 */
export async function readinessFingerprint(d: {
  pool: pg.Pool; repoHost: RepoHost; repo: string; logic?: ReadinessLogic; defaults?: DefaultPolicies;
}): Promise<string> {
  return (await readiness(d.pool, d.repoHost, d.repo, d.logic ?? readinessLogic(), d.defaults && oncePerPoll(d.defaults))).sha;
}

/**
 * One pass over a backlog source. In order: new and edited items; the PRs of InReview, InProgress and NeedsInput items;
 * withdrawals, criteria changes and dependencies of the other items the factory holds; re-gates after a readiness
 * input changed; and the gate on every Eligible item. Each item's failure is its own, so a judge on a usage limit or
 * one unreachable PR never stops merge or withdrawal detection for the rest, and the cursor is always saved.
 */
export async function pollOnce(deps: PollDeps): Promise<{ seen: number; cursor: string }> {
  // A poll that runs for 5 minutes warns, and again every 5 minutes, naming its board and its step (PBI 134). The
  // board is its source's id until the source's row is read, and its URL after.
  const board = { name: deps.sourceId };
  const say = (ms: number, step: string) => `slow: the poll of board ${board.name} has run for ${minutes(ms)}, in step "${step}"`;
  const w = watch(SLOW_POLL_MS, SLOW_POLL_MS, say, deps.slow);
  return watched(w, () => pollSteps(deps, w, board));
}

async function pollSteps(deps: PollDeps, w: Watch, board: { name: string }): Promise<{ seen: number; cursor: string }> {
  const { pool, adapter, repoHost, judge, sourceId, split } = deps;
  w.step("reading the board");
  const src = (await pool.query<{ url: string; cursor: string | null; paused: boolean; label: string | null }>(
    "select url, cursor, paused, field_map->>'optInLabel' as label from backlog_source where id = $1", [sourceId],
  )).rows[0];
  if (!src) throw new Error(`no backlog source ${sourceId}`);
  board.name = src.url;
  if (src.paused) return { seen: 0, cursor: src.cursor ?? "" };
  // The same field Task 7's adapter lists by, so the two can't disagree about which items are in.
  const label = src.label ?? "factory";
  const eligible = (fi: FactoryItem | null): boolean => fi !== null && !fi.closed && fi.labels.includes(label);
  const fetched = new Map<string, FactoryItem | null>();
  // Each item read back stores its issue's repo, so an item held from before repos were stored gets one (PBI 137).
  const itemOf = async (ext: string) => {
    if (!fetched.has(ext)) {
      const fi = await adapter.getItem(ext);
      fetched.set(ext, fi);
      if (fi) {
        await pool.query("update item set repo = $3 where source_id = $1 and external_id = $2 and repo is distinct from $3", [sourceId, ext, fi.repo]);
      }
    }
    return fetched.get(ext)!;
  };

  w.step("listing new and changed items");
  // 1. New and changed items. If any of them fails to go in, the cursor stays put so the next poll lists it again.
  const listed = await adapter.listEligible(src.cursor);
  //    An item withdrawn before it was Queued that's listed again, its label back, returns to Eligible (PBI 168).
  const unlisted = await each(listed.items, (fi) => `listing item ${fi.externalId}`, async (fi) => {
    fetched.set(fi.externalId, fi);
    const id = await upsertItem(pool, { sourceId, externalId: fi.externalId, title: fi.title, rank: fi.rank, repo: fi.repo, issueCreatedAt: fi.createdAt });
    await returnWithdrawn(pool, id);
  });

  w.step("reading the PRs of items in review");
  // 2. PRs of InReview items, and of InProgress and NeedsInput items whose run has opened one, before withdrawal, so a
  //    merge just before the item closes still counts as a merge. A merge or a close while the item is InProgress,
  //    during address for example, is the fallback for a webhook that never came (PBI 142). So is one while the item
  //    waits in NeedsInput on a question asked after its PR opened (PBI 194). Only an InReview item goes back to
  //    address on a review or a conflict, and only reviews by allowlisted users count (Run contract 10). A NeedsInput
  //    item that waits on "no trusted review text to address" goes back too, once the factory answers it (PBI 305).
  const trusted = (await pool.query<{ github_login: string }>(`select github_login from "user" where github_login is not null`)).rows.map((u) => u.github_login);
  await each(await items(pool, sourceId, ["InReview", "InProgress", "NeedsInput"]), (row) => `reading the PR of item ${row.external_id}`, async (row) => {
    const fi = await itemOf(row.external_id);
    const repo = fi?.repo ?? repoFromUrl(row.run_repo_url);
    if (!repo || !row.pr_number) return;
    // The factory's own review threads never send the item to address, whoever replies inside them (PBI 130).
    const bot = (await pool.query<{ trusted_bot: string | null }>("select trusted_bot from repo where lower(url) = lower($1)", [`https://github.com/${repo}`])).rows[0]?.trusted_bot ?? null;
    const pr = await repoHost.prState(repo, row.pr_number, trusted, bot);
    if (pr.merged) {
      // A merge the factory asked for whose answer it never got is still logged as the factory's (PBI 181).
      await move(pool, row.id, "merged", async (c) => {
        await c.query("update run set merge_sha = $2 where id = $1", [row.run_id, pr.mergeSha]);
        await logAttemptedMerge(c, row.id, row.pr_number!, pr.mergeSha, system);
      });
    } else if (!pr.open) {
      await move(pool, row.id, "withdrawn");
    } else if (row.state === "NeedsInput" && !row.held && ((await requeueForAddress(pool, row, pr)) || (await requeueForGreen(pool, row)))) {
      // The factory answered the item's "no trusted review text to address" question, and the scheduler claims it
      // again at address (PBI 305). Or it answered an older "Address failed" question naming only CI failures, and the
      // scheduler claims it again at green (PBI 317).
    } else if (pr.mergeable === false || newer(pr.lastChangesRequestedAt, row.reviews_seen_at)) {
      // A trusted review asking for changes, a comment in a still-open thread, or a conflict sends an InReview item
      // back to address. A NeedsInput item stays put on its question, and its PR isn't merged over the request (PBI 262),
      // unless the question is the one PBI 305 answers above.
      if (row.state === "InReview") {
        await move(pool, row.id, "changes_requested", (c) => c.query("update run set next_stage = 'address' where id = $1", [row.run_id]));
      }
    } else if ((row.state === "InReview" || row.state === "NeedsInput") && !row.held && eligible(fi) && (row.criteria_hash === null || row.criteria_hash === criteriaHash(fi!.acceptanceCriteria))) {
      // An item withdrawn from the board, or whose criteria changed, is left for step 3 to close its PR (PBI 181). A
      // NeedsInput item's PR merges under the same rules as an InReview one's (PBI 262).
      await mergeIfReady(pool, repoHost, repo, row.pr_number, row, trusted);
    }
  });

  w.step("checking the items the factory holds");
  // 3. Items the factory holds. listEligible can't see one that lost its label or closed, so each is read back.
  //    A PR closes before its item moves, so a failed close is retried by the next poll. An Eligible or NotReady item
  //    is only withdrawn, before step 4 can gate it (PBI 168).
  await each(await items(pool, sourceId, [...GATING, ...ACTIVE]), (row) => `checking item ${row.external_id}`, async (row) => {
    const fi = await itemOf(row.external_id);
    if (!eligible(fi)) {
      await closeOpenPr(repoHost, fi?.repo ?? repoFromUrl(row.run_repo_url), row, "This PR's item was withdrawn from the backlog.");
      await move(pool, row.id, "withdrawn");
      return;
    }
    if (!fi || GATING.includes(row.state)) return;
    const hash = criteriaHash(fi.acceptanceCriteria);
    if (row.criteria_hash !== null && row.criteria_hash !== hash) {
      // The comment and the close are idempotent and go before the move, so the next poll retries a failed one. The
      // comment goes first because step 2 withdraws an InReview item whose PR closed while the item stayed put.
      await adapter.comment(fi.externalId, "This item's acceptance criteria changed, so its scenarios need a new sign-off.", `criteria:${hash}`);
      await closeOpenPr(repoHost, fi.repo, row, "This item's acceptance criteria changed, so the factory starts a new run.");
      await restart(pool, row, fi, hash);
      return;
    }
    if (row.state === "Queued" || row.state === "SignOff" || row.state === "NeedsInput") {
      await pool.query("update item set blocked_by = $2 where id = $1", [row.id, await adapter.openDependencies(fi.externalId)]);
    }
  });

  w.step("re-queuing items stopped by a red base");
  // 3b. Items stopped by a red base (PBI 260). Once CI passes on a newer commit of the base branch, the factory answers
  //     the question itself and the scheduler claims the item again at its stage, merging the base as every claim does.
  await requeueAfterBasePassed(pool, repoHost, sourceId);

  w.step("checking readiness");
  // 4. Readiness. A NotReady item is re-gated when the item itself changed, or when a readiness input changed. The factory's own board writes change neither. Then every Eligible item is gated.
  //    An item that left the backlog is skipped: step 3 withdrew it, or failed to read it and retries next poll.
  const logic = deps.logic ?? readinessLogic();
  const defaults = deps.defaults && oncePerPoll(deps.defaults);
  const byRepo = new Map<string, Promise<Readiness>>();
  const readinessOf = (fi: FactoryItem) => {
    const key = fi.repo ?? "";
    if (!byRepo.has(key)) byRepo.set(key, readiness(pool, repoHost, fi.repo, logic, defaults));
    return byRepo.get(key)!;
  };
  // An item in an unknown repo fails the gate on that alone, and its host may have no dependencies to read.
  const depsOf = async (fi: FactoryItem) => ((await readinessOf(fi)).repoKnown ? adapter.openDependencies(fi.externalId) : []);
  await each(await items(pool, sourceId, ["NotReady"]), (row) => `re-gating item ${row.external_id}`, async (row) => {
    const fi = await itemOf(row.external_id);
    if (!fi || !eligible(fi)) return;
    if (readinessItemHash(fi) !== row.readiness_item_hash) await move(pool, row.id, "item_edited");
    else if ((await readinessOf(fi)).sha !== row.readiness_policy_sha) await move(pool, row.id, "policy_changed");
  });
  // Most often a failure here is the judge, or the coding model asked for a split, on a usage limit. The item stays
  // Eligible and the next poll tries again.
  await each(await items(pool, sourceId, ["Eligible"]), (row) => `the readiness check for item ${row.external_id}`, async (row) => {
    const fi = await itemOf(row.external_id);
    if (!fi || !eligible(fi)) return;
    const r = await readinessOf(fi);
    const out = await gate(fi, {
      readinessSha: r.sha, dor: r.dor, dodExists: r.dodExists, configValid: r.configValid, repoKnown: r.repoKnown, judge, adapter, policyErrors: r.policyErrors, split,
      missingPermissions: r.missingPermissions,
      // Every judge call's spend, a failed one's included, so the items the gate turns away count too (PBI 132).
      recordCheck: (_fi, check) => recordReadinessCheck(pool, row.id, check),
      // The split being filed, kept in the database so a restart finishes the filing it started (PBI 144).
      splits: { get: (i) => keptSplit(pool, row.id, itemTextHash(i)), keep: (i, children) => keepSplit(pool, row.id, itemTextHash(i), children) },
    });
    // An oversized item whose split the coding model didn't answer (a usage limit, a timeout) still owes a proposal.
    // It stays Eligible, like a failed judge run, so the next poll gates it and asks again.
    if (splitUnanswered(out.split)) throw new Error("the coding model gave no answer for the item's split proposal");
    // A queued item goes in blocked by its open dependencies, so no claim takes it before step 3 reads them next poll.
    const blockedBy = out.ready ? await depsOf(fi) : [];
    await move(pool, row.id, out.ready ? "ready" : "readiness_failed", async (c) => {
      await c.query("update item set readiness_policy_sha = $2, readiness_item_hash = $3, blocked_by = $4 where id = $1", [row.id, r.sha, readinessItemHash(out.item ?? fi), blockedBy]);
      for (const v of out.results) {
        await c.query(
          `insert into policy_result (item_id, run_id, file, source, checked_sha, criterion_index, criterion, status, reason)
           values ($1, null, 'dor', $2, $3, $4, $5, $6, $7)`,
          [row.id, r.dor?.source ?? "repo", r.head || null, v.index, v.criterion, v.status, v.reason],
        );
      }
      // A parent whose split the gate just filed, its last child filed and its label off, goes on from NotReady to
      // Split in the same commit, so no later poll finds it NotReady without its label and withdraws it (PBI 225).
      if (out.filed) await transitionItem(c, row.id, "split_filed", system);
    });
  });

  w.step("saving the cursor");
  if (unlisted > 0) return { seen: listed.items.length, cursor: src.cursor ?? "" };
  await pool.query("update backlog_source set cursor = $2 where id = $1", [sourceId, listed.cursor]);
  return { seen: listed.items.length, cursor: listed.cursor };
}

/** The kind of the event that logs a re-queue after CI passed on the base (PBI 260). */
export const REQUEUED_AFTER_BASE_PASSED = "requeued_after_base_passed";
/**
 * The kind of the event that logs a re-queue for address of an item that waited on "no trusted review text to
 * address", once its PR conflicts with its base or a newer trusted review asks for changes (PBI 305). Its payload holds
 * `questionId`, `prNumber`, `reason` ("conflict" or "review"), `base` for a conflict and `at`, the review's time, for a
 * review.
 */
export const REQUEUED_FOR_ADDRESS = "requeued_for_address";
/**
 * The kind of the event that logs a re-queue for Green of an item that waited on an older "Address failed" question
 * naming only CI failures, asked before #292 sent a CI failure back to Green (PBI 317). Its payload holds `questionId`
 * and `prNumber`.
 */
export const REQUEUED_FOR_GREEN = "requeued_for_green";
/** How many of a base branch's newest commits the poller reads CI on, newest first, to find the newest one with a verdict. */
const BASE_COMMITS_READ = 20;
/** The base a base failure names, or the cell API's own base for a question asked before cells named theirs. */
const DEFAULT_BASE = "main";

/**
 * PBI 260: answers each open question that blames a red base, on an item that isn't held, once CI has passed on a
 * commit of that base after the one the cell failed on and no newer commit's CI has failed. The answer names that commit and leaves `answered_by` null,
 * since no person gave it, and the re-queue is a system event. The item stays in NeedsInput at its stage, where the
 * scheduler claims an answered item. A held item is skipped, so the first poll after its release answers it. The
 * answer re-reads the item and question under a lock, so a person's answer, a Hold or a second poll that came first
 * wins and nothing is logged twice.
 */
async function requeueAfterBasePassed(pool: pg.Pool, host: RepoHost, sourceId: string): Promise<void> {
  const waiting = (await pool.query<{ id: string; external_id: string; question_id: string; repo: string | null; sha: string; base: string | null }>(
    `select i.id, i.external_id, q.id as question_id, coalesce(i.repo, replace(rp.url, 'https://github.com/', '')) as repo,
            q.base_failure->>'sha' as sha, q.base_failure->>'base' as base
     from item i
     join question q on q.item_id = i.id and q.kind = 'needs_input' and q.answer is null and q.closed_at is null and q.base_failure is not null
     left join lateral (select repo_id from run where item_id = i.id and ended_at is null order by started_at desc limit 1) r on true
     left join repo rp on rp.id = r.repo_id
     where i.source_id = $1 and i.state = 'NeedsInput' and not i.held`,
    [sourceId],
  )).rows;
  // One read of CI per commit per poll, however many items wait on the same base.
  const ci = new Map<string, Promise<string>>();
  const passed = (repo: string, sha: string) => {
    const key = `${repo}@${sha}`;
    if (!ci.has(key)) ci.set(key, host.checksOnSha(repo, sha));
    return ci.get(key)!;
  };
  await each(waiting, (w) => `re-queuing item ${w.external_id} after its base passed`, async (w) => {
    if (!w.repo || !w.sha) return;
    const base = w.base ?? DEFAULT_BASE;
    const after = (await host.commitsAfter(w.repo, base, w.sha)).slice(-BASE_COMMITS_READ).reverse();
    let green: string | null = null;
    // The newest commit with a verdict decides: a failure there means the base is red again, so the question stays open.
    for (const sha of after) {
      const status = await passed(w.repo, sha);
      if (status === "failure") break;
      if (status === "success") {
        green = sha;
        break;
      }
    }
    if (!green) return;
    await withTx(pool, async (c) => {
      const cur = await c.query(
        `select 1 from item i join question q on q.item_id = i.id
         where i.id = $1 and q.id = $2 and i.state = 'NeedsInput' and not i.held and q.answer is null and q.closed_at is null
         for update of i, q`,
        [w.id, w.question_id],
      );
      if (cur.rowCount === 0) return;
      const answer = `CI passed on ${green}, a newer commit of the base ${base} than ${w.sha}, where the cell failed. The factory picks the item up again at its stage and merges the base first.`;
      await c.query("update question set answer = $2, decision = 'answer', answered_at = now() where id = $1", [w.question_id, answer]);
      await appendEvent(c, { ...system, itemId: w.id, kind: REQUEUED_AFTER_BASE_PASSED, payload: { sha: green, base, failedSha: w.sha, questionId: w.question_id } });
    });
  });
}

/**
 * PBI 305: answers the question "no trusted review text to address" that a NeedsInput item which isn't held waits on,
 * once its PR conflicts with its base or a trusted review or open-thread comment newer than the question asks for
 * changes. A PR whose mergeability GitHub hasn't worked out yet doesn't count as conflicting. The answer names what
 * changed and leaves `answered_by` null, as PBI 260's does, and the re-queue is a system event. The run's next stage
 * is address, where the scheduler claims the answered item. The item and question are re-read under a lock after the
 * PR was read, so a person's answer, a Hold or another poll that came first wins and nothing is logged twice. Returns
 * whether it answered.
 */
async function requeueForAddress(
  pool: pg.Pool, row: Row, pr: { mergeable: boolean | null; lastChangesRequestedAt: string | null },
): Promise<boolean> {
  const conflict = pr.mergeable === false;
  if (!conflict && !pr.lastChangesRequestedAt) return false;
  return withTx(pool, async (c) => {
    const q = (await c.query<{ id: string; asked_at: Date }>(
      `select q.id, q.asked_at from item i join question q on q.item_id = i.id
       where i.id = $1 and i.state = 'NeedsInput' and not i.held
         and q.kind = 'needs_input' and q.body = $2 and q.answer is null and q.closed_at is null
       order by q.asked_at desc limit 1
       for update of i, q`,
      [row.id, NO_REVIEW_TEXT],
    )).rows[0];
    if (!q) return false;
    const review = newer(pr.lastChangesRequestedAt, q.asked_at) ? new Date(pr.lastChangesRequestedAt!).toISOString() : null;
    if (!conflict && !review) return false;
    const prNumber = row.pr_number!;
    const base = DEFAULT_BASE;
    const what = [
      ...(conflict ? [`PR #${prNumber} conflicts with its base ${base}.`] : []),
      ...(review ? [`A trusted review asked for changes on PR #${prNumber} at ${review}, after this question.`] : []),
    ];
    const answer = `${what.join(" ")} The factory picks the item up again at address.`;
    await c.query("update question set answer = $2, decision = 'answer', answered_at = now() where id = $1", [q.id, answer]);
    await c.query("update run set next_stage = 'address' where id = $1", [row.run_id]);
    const payload = conflict ? { questionId: q.id, prNumber, reason: "conflict", base, ...(review ? { at: review } : {}) } : { questionId: q.id, prNumber, reason: "review", at: review };
    await appendEvent(c, { ...system, itemId: row.id, kind: REQUEUED_FOR_ADDRESS, payload });
    return true;
  });
}

/**
 * PBI 317: answers the older "Address failed" question that a NeedsInput item which isn't held waits on, asked before
 * #292 sent a CI failure back to Green (CI_TO_GREEN_SINCE), when every finding it names is a CI failure. The same
 * question asked since then is address giving up on fixes CI failed on, and waits for a person, whose answer reruns
 * address so its thread replies go out. The answer is CI_BACK_TO_GREEN and
 * leaves `answered_by` null, as PBI 260's and 305's do, and the re-queue is a system event. The run's next stage is
 * green, where the scheduler claims the answered item, and the cell reads the failed checks of the PR's head as Green's
 * findings. The item and question are re-read under a lock after the PR was read, so a person's answer, a Hold or
 * another poll that came first wins and nothing is logged twice. Returns whether it answered.
 */
async function requeueForGreen(pool: pg.Pool, row: Row): Promise<boolean> {
  return withTx(pool, async (c) => {
    const q = (await c.query<{ id: string; body: string; asked_at: Date }>(
      `select q.id, q.body, q.asked_at from item i join question q on q.item_id = i.id
       where i.id = $1 and i.state = 'NeedsInput' and not i.held
         and q.kind = 'needs_input' and q.answer is null and q.closed_at is null
       order by q.asked_at desc limit 1
       for update of i, q`,
      [row.id],
    )).rows[0];
    if (!q || !olderCiFailedQuestion(q.body, q.asked_at)) return false;
    const prNumber = row.pr_number!;
    await c.query("update question set answer = $2, decision = 'answer', answered_at = now() where id = $1", [q.id, CI_BACK_TO_GREEN]);
    await c.query("update run set next_stage = 'green' where id = $1", [row.run_id]);
    await appendEvent(c, { ...system, itemId: row.id, kind: REQUEUED_FOR_GREEN, payload: { questionId: q.id, prNumber } });
    return true;
  });
}

/**
 * The factory's merge (PBI 181). An InReview or NeedsInput item (PBI 262) that isn't held, whose PR GitHub reads `clean`, that an allowlisted
 * user approved and whose Definition of Done lines left for the person who merges are all ticked, is squash-merged at
 * the head the view was read at. First the attempt, with the PR, the head and the approvers, is logged as
 * `factory_merge_attempt` in its own committed write, so a merge GitHub made while the call failed is still logged as
 * the factory's when step 2 or the webhook later sees the PR merged. Then the item row stays locked across the merge,
 * so a Hold or a claim that lands meanwhile waits, and the re-read under the lock sees the one that came first. A merge
 * moves the item through `merged`, as a person's would, and logs `factory_merged`. A refusal logs
 * `factory_merge_refused` with GitHub's message, and the next poll tries again. An item held or moved between the
 * two writes isn't merged, and `factory_merge_refused` closes its attempt. A NeedsInput item's open question closes
 * unanswered with a note naming the merge, and `factory_merged` says the item waited in NeedsInput and names the
 * question (PBI 262).
 */
async function mergeIfReady(pool: pg.Pool, host: RepoHost, repo: string, prNumber: number, row: Row, trusted: string[]): Promise<void> {
  // Only an allowlisted user's approval counts, as with requested changes (Run contract 10): a stranger's never merges.
  const keys = new Set(trusted.map(loginKey));
  const read = await host.mergeView(repo, prNumber);
  const view = { ...read, approvedBy: read.approvedBy.filter((a) => keys.has(loginKey(a))) };
  if (mergeBlocker(view) !== null) return;
  const mayMerge = async (c: pg.PoolClient) => {
    const cur = (await c.query<{ state: ItemState; held: boolean }>("select state, held from item where id = $1 for update", [row.id])).rows[0];
    return !!cur && cur.state === row.state && !cur.held;
  };
  const attempted = await withTx(pool, async (c) => {
    if (!(await mayMerge(c))) return false;
    // A NeedsInput item's attempt names the question it waits on, so a merge recovered from it is logged as this one
    // would be (PBI 262).
    const asked = row.state === "NeedsInput" ? await openQuestion(c, row.id) : null;
    const waiting = row.state === "NeedsInput" ? { waitingIn: row.state, question: asked?.body ?? null, questionId: asked?.id ?? null } : {};
    await appendEvent(c, { ...system, itemId: row.id, kind: "factory_merge_attempt", payload: { repo, prNumber, headSha: view.headSha, approvers: view.approvedBy, ...waiting } });
    return true;
  });
  if (!attempted) return;
  await withTx(pool, async (c) => {
    // A Hold or another move that landed since the attempt was logged stops the merge. The attempt is closed, so a
    // person's later merge of the PR isn't logged as the factory's.
    if (!(await mayMerge(c))) {
      await appendEvent(c, { ...system, itemId: row.id, kind: "factory_merge_refused", payload: { repo, prNumber, reason: "the item was held or moved before the merge" } });
      return;
    }
    const res = await host.mergePr(repo, prNumber, { method: "squash", headSha: view.headSha });
    if (!res.merged) {
      await appendEvent(c, { ...system, itemId: row.id, kind: "factory_merge_refused", payload: { repo, prNumber, reason: res.reason } });
      return;
    }
    // The question a NeedsInput item waited on, which the move to Accepted closes unanswered (PBI 194).
    const question = row.state === "NeedsInput" ? await openQuestion(c, row.id) : null;
    await transitionItem(c, row.id, "merged", system);
    await c.query("update run set merge_sha = $2 where id = $1", [row.run_id, res.sha]);
    if (question) {
      await c.query("update question set closed_note = $2 where id = $1", [question.id, mergedNote(prNumber, res.sha)]);
    }
    const waiting = row.state === "NeedsInput" ? { waitingIn: row.state, question: question?.body ?? null } : {};
    await appendEvent(c, { ...system, itemId: row.id, kind: "factory_merged", payload: { repo, prNumber, mergeSha: res.sha, approvers: view.approvedBy, ...waiting } });
  });
}

/** The newest question the item waits on, still unanswered and open. */
async function openQuestion(c: pg.ClientBase, itemId: string): Promise<{ id: string; body: string } | null> {
  return (await c.query<{ id: string; body: string }>(
    "select id, body from question where item_id = $1 and answer is null and closed_at is null order by asked_at desc limit 1", [itemId],
  )).rows[0] ?? null;
}

/**
 * Sends an Abandoned item back to Eligible through `returned` when its last move to Abandoned was a withdrawal from
 * Eligible or NotReady, so it meets the readiness gate again (PBI 168). An item withdrawn from Queued or later, or
 * abandoned any other way, stays where it is.
 */
async function returnWithdrawn(pool: pg.Pool, itemId: string): Promise<void> {
  await withTx(pool, async (c) => {
    const held = await c.query("select 1 from item where id = $1 and state = 'Abandoned' for update", [itemId]);
    if (held.rowCount === 0) return;
    if (!(await withdrawnBeforeQueue(c, itemId))) return;
    await transitionItem(c, itemId, "returned", system);
  });
}

function newer(review: string | null, seen: Date | null): boolean {
  if (!review) return false;
  return seen === null || new Date(review).getTime() > seen.getTime();
}

/**
 * Run contract 7: criteria changed, so the item goes back to Queued with a new run on a new branch. Queued has a
 * criteria_changed edge to itself, so IllegalTransition can't stop a second poll that read the old hash. The locked
 * re-read does.
 */
async function restart(pool: pg.Pool, row: Row, fi: FactoryItem, hash: string): Promise<void> {
  await withTx(pool, async (c) => {
    const cur = (await c.query<{ criteria_hash: string | null }>("select criteria_hash from item where id = $1 for update", [row.id])).rows[0];
    if (cur.criteria_hash === hash) return;
    await transitionItem(c, row.id, "criteria_changed", system);
    await c.query("update item set criteria_hash = $2 where id = $1", [row.id, hash]);
    await c.query("update run set ended_at = now(), outcome = 'criteria_changed' where item_id = $1 and ended_at is null", [row.id]);
    const n = (await c.query<{ n: number }>("select coalesce(max(run_number), 0) + 1 as n from run where item_id = $1", [row.id])).rows[0].n;
    await c.query("insert into run (item_id, run_number, next_stage, branch) values ($1, $2, 'understand', $3)", [row.id, n, `factory/pbi-${fi.externalId}-r${n}`]);
    await c.query("update question set closed_at = now() where item_id = $1 and answer is null and closed_at is null", [row.id]);
  });
}
