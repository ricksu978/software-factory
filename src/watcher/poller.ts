// The poller (plan Task 8): one pass over a backlog source and the PRs of the items it holds.
import { createHash } from "node:crypto";
import type pg from "pg";
import type { BacklogAdapter, FactoryItem, RepoHost } from "../adapters/types.ts";
import { parseRepoConfig } from "../config/repo-config.ts";
import type { ItemEvent, ItemState } from "../core/states.ts";
import { gate } from "../gate/readiness.ts";
import { loadPolicy, PolicyError, readinessSha, type Policy, type PolicyName } from "../policy/policy.ts";
import { withTx } from "../store/db.ts";
import { IllegalTransition, transitionItem, upsertItem } from "../store/items.ts";

export const POLL_INTERVAL_MS = 300_000;

export type PollDeps = {
  pool: pg.Pool;
  adapter: BacklogAdapter;
  repoHost: RepoHost;
  judge: (item: FactoryItem, dor: Policy) => Promise<string>;
  sourceId: string;
};

type Row = {
  id: string; external_id: string; state: ItemState; criteria_hash: string | null;
  readiness_policy_sha: string | null; readiness_item_hash: string | null;
  run_id: string | null; branch: string | null; pr_number: number | null; reviews_seen_at: Date | null; run_repo_url: string | null;
};

type Readiness = {
  sha: string; head: string; dor: Policy | null; policyErrors: string[]; dodExists: boolean; configValid: boolean; repoKnown: boolean;
};

const system = { actor: "system", actorId: "poller" } as const;
const ACTIVE: ItemState[] = ["Queued", "InProgress", "SignOff", "NeedsInput", "InReview"];
const POLICIES: PolicyName[] = ["dor", "scenarios", "pr-review", "risk", "dod"];
const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** SHA-256 of an item's acceptance criteria. A change since the run started sends the item back through Specify. */
export function criteriaHash(criteria: string[]): string {
  return sha256(criteria);
}

/**
 * SHA-256 of what the readiness check judges about the item itself, open dependencies included. A NotReady item is
 * re-gated when this changes, whether a person edited it or a dependency closed.
 */
export function readinessItemHash(fi: FactoryItem, openDeps: string[]): string {
  return sha256({ title: fi.title, body: fi.body, criteria: fi.acceptanceCriteria, fields: fi.fields, repo: fi.repo, openDeps: [...openDeps].sort() });
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
    `select i.id, i.external_id, i.state, i.criteria_hash, i.readiness_policy_sha, i.readiness_item_hash,
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
async function readiness(pool: pg.Pool, host: RepoHost, repo: string | null): Promise<Readiness> {
  const known = repo !== null && (await pool.query("select 1 from repo where url = $1", [`https://github.com/${repo}`])).rowCount === 1;
  if (!repo || !known) {
    return { sha: "unknown repo", head: "", dor: null, policyErrors: [], dodExists: false, configValid: false, repoKnown: false };
  }
  const head = await host.defaultBranchSha(repo);
  const raw = new Map<string, string | null>();
  for (const path of [...POLICIES.map((n) => `.factory/${n}.md`), ".factory/config.yml"]) raw.set(path, await host.readFile(repo, head, path));
  const read = async (path: string) => raw.get(path) ?? null;

  // The hash covers each raw text, the default's text for an absent policy, and "absent" for a missing dod.md or config.
  const texts = { config: raw.get(".factory/config.yml") ?? null } as Parameters<typeof readinessSha>[0];
  for (const name of POLICIES) {
    const text = raw.get(`.factory/${name}.md`) ?? null;
    texts[name] = text ?? (name === "dod" ? null : (await loadPolicy(async () => null, name))!.text);
  }

  const policyErrors: string[] = [];
  const loaded = new Map<PolicyName, Policy | null>();
  for (const name of POLICIES) {
    try {
      loaded.set(name, await loadPolicy(read, name));
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
  return {
    sha: readinessSha(texts), head, dor: loaded.get("dor") ?? null, policyErrors,
    dodExists: (loaded.get("dod") ?? null) !== null, configValid, repoKnown: true,
  };
}

/**
 * One pass over a backlog source. In order: new and edited items; the PRs of InReview items; withdrawals, criteria
 * changes and dependencies of the other items the factory holds; re-gates after a readiness input changed; and the
 * gate on every Eligible item. Each item's failure is its own, so a judge on a usage limit or one unreachable PR
 * never stops merge or withdrawal detection for the rest, and the cursor is always saved.
 */
export async function pollOnce(deps: PollDeps): Promise<{ seen: number; cursor: string }> {
  const { pool, adapter, repoHost, judge, sourceId } = deps;
  const src = (await pool.query<{ cursor: string | null; paused: boolean; label: string | null }>(
    "select cursor, paused, field_map->>'optInLabel' as label from backlog_source where id = $1", [sourceId],
  )).rows[0];
  if (!src) throw new Error(`no backlog source ${sourceId}`);
  if (src.paused) return { seen: 0, cursor: src.cursor ?? "" };
  // The same field Task 7's adapter lists by, so the two can't disagree about which items are in.
  const label = src.label ?? "factory";
  const eligible = (fi: FactoryItem | null): boolean => fi !== null && !fi.closed && fi.labels.includes(label);
  const fetched = new Map<string, FactoryItem | null>();
  const itemOf = async (ext: string) => {
    if (!fetched.has(ext)) fetched.set(ext, await adapter.getItem(ext));
    return fetched.get(ext)!;
  };

  // 1. New and changed items. If any of them fails to go in, the cursor stays put so the next poll lists it again.
  const listed = await adapter.listEligible(src.cursor);
  const unlisted = await each(listed.items, (fi) => `listing item ${fi.externalId}`, async (fi) => {
    fetched.set(fi.externalId, fi);
    await upsertItem(pool, { sourceId, externalId: fi.externalId, title: fi.title, rank: fi.rank });
  });

  // 2. PRs of InReview items, before withdrawal, so a merge just before the item closes still counts as a merge.
  //    Only reviews by allowlisted users count (Run contract 10).
  const trusted = (await pool.query<{ github_login: string }>(`select github_login from "user" where github_login is not null`)).rows.map((u) => u.github_login);
  await each(await items(pool, sourceId, ["InReview"]), (row) => `reading the PR of item ${row.external_id}`, async (row) => {
    const repo = (await itemOf(row.external_id))?.repo ?? repoFromUrl(row.run_repo_url);
    if (!repo || !row.pr_number) return;
    const pr = await repoHost.prState(repo, row.pr_number, trusted);
    if (pr.merged) {
      await move(pool, row.id, "merged", (c) => c.query("update run set merge_sha = $2 where id = $1", [row.run_id, pr.mergeSha]));
    } else if (!pr.open) {
      await move(pool, row.id, "withdrawn");
    } else if (pr.mergeable === false || newer(pr.lastChangesRequestedAt, row.reviews_seen_at)) {
      await move(pool, row.id, "changes_requested", (c) => c.query("update run set next_stage = 'address' where id = $1", [row.run_id]));
    }
  });

  // 3. Items the factory holds. listEligible can't see one that lost its label or closed, so each is read back.
  //    A PR closes before its item moves, so a failed close is retried by the next poll.
  await each(await items(pool, sourceId, ACTIVE), (row) => `checking item ${row.external_id}`, async (row) => {
    const fi = await itemOf(row.external_id);
    if (!eligible(fi)) {
      await closeOpenPr(repoHost, fi?.repo ?? repoFromUrl(row.run_repo_url), row, "This PR's item was withdrawn from the backlog.");
      await move(pool, row.id, "withdrawn");
      return;
    }
    if (!fi) return;
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

  // 4. Readiness. A NotReady item is re-gated when the item itself changed, open dependencies included, or when a
  //    readiness input changed. The factory's own board writes change neither. Then every Eligible item is gated.
  //    An item that left the backlog is skipped: it has no withdrawn edge, and it must never reach Queued.
  const byRepo = new Map<string, Promise<Readiness>>();
  const readinessOf = (fi: FactoryItem) => {
    const key = fi.repo ?? "";
    if (!byRepo.has(key)) byRepo.set(key, readiness(pool, repoHost, fi.repo));
    return byRepo.get(key)!;
  };
  // An item in an unknown repo fails the gate on that alone, and its host may have no dependencies to read.
  const depsOf = async (fi: FactoryItem) => ((await readinessOf(fi)).repoKnown ? adapter.openDependencies(fi.externalId) : []);
  await each(await items(pool, sourceId, ["NotReady"]), (row) => `re-gating item ${row.external_id}`, async (row) => {
    const fi = await itemOf(row.external_id);
    if (!fi || !eligible(fi)) return;
    if (readinessItemHash(fi, await depsOf(fi)) !== row.readiness_item_hash) await move(pool, row.id, "item_edited");
    else if ((await readinessOf(fi)).sha !== row.readiness_policy_sha) await move(pool, row.id, "policy_changed");
  });
  // Most often a failure here is the judge on a usage limit. The item stays Eligible and the next poll tries again.
  await each(await items(pool, sourceId, ["Eligible"]), (row) => `the readiness check for item ${row.external_id}`, async (row) => {
    const fi = await itemOf(row.external_id);
    if (!fi || !eligible(fi)) return;
    const r = await readinessOf(fi);
    const openDeps = await depsOf(fi);
    const out = await gate(fi, {
      readinessSha: r.sha, dor: r.dor, dodExists: r.dodExists, configValid: r.configValid, repoKnown: r.repoKnown,
      openDeps, judge, adapter, policyErrors: r.policyErrors,
    });
    await move(pool, row.id, out.ready ? "ready" : "readiness_failed", async (c) => {
      await c.query("update item set readiness_policy_sha = $2, readiness_item_hash = $3 where id = $1", [row.id, r.sha, readinessItemHash(fi, openDeps)]);
      for (const v of out.results) {
        await c.query(
          `insert into policy_result (item_id, run_id, file, source, checked_sha, criterion_index, criterion, status, reason)
           values ($1, null, 'dor', $2, $3, $4, $5, $6, $7)`,
          [row.id, r.dor?.source ?? "repo", r.head || null, v.index, v.criterion, v.status, v.reason],
        );
      }
    });
  });

  if (unlisted > 0) return { seen: listed.items.length, cursor: src.cursor ?? "" };
  await pool.query("update backlog_source set cursor = $2 where id = $1", [sourceId, listed.cursor]);
  return { seen: listed.items.length, cursor: listed.cursor };
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
