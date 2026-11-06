// The poller (plan Task 8): one pass over a backlog source and the PRs of the items it holds.
import { createHash } from "node:crypto";
import type pg from "pg";
import type { BacklogAdapter, FactoryItem, RepoHost } from "../adapters/types.ts";
import { parseRepoConfig } from "../config/repo-config.ts";
import type { ItemEvent, ItemState } from "../core/states.ts";
import { gate } from "../gate/readiness.ts";
import { loadPolicy, PolicyError, readinessSha, type Policy, type PolicyName } from "../policy/policy.ts";
import { withTx } from "../store/db.ts";
import { transitionItem, upsertItem } from "../store/items.ts";

export const POLL_INTERVAL_MS = 300_000;

export type PollDeps = {
  pool: pg.Pool;
  adapter: BacklogAdapter;
  repoHost: RepoHost;
  judge: (item: FactoryItem, dor: Policy) => Promise<string>;
  sourceId: string;
};

type Row = {
  id: string; external_id: string; state: ItemState; criteria_hash: string | null; readiness_policy_sha: string | null;
  run_id: string | null; run_number: number | null; branch: string | null; pr_number: number | null; reviews_seen_at: Date | null;
};

type Readiness = {
  sha: string; head: string; dor: Policy | null; policyErrors: string[]; dodExists: boolean; configValid: boolean; repoKnown: boolean;
};

const system = { actor: "system", actorId: "poller" } as const;
const ACTIVE: ItemState[] = ["Queued", "InProgress", "SignOff", "NeedsInput", "InReview"];
const POLICIES: PolicyName[] = ["dor", "scenarios", "pr-review", "risk", "dod"];

/** SHA-256 of an item's acceptance criteria. A change since the run started sends the item back through Specify. */
export function criteriaHash(criteria: string[]): string {
  return createHash("sha256").update(JSON.stringify(criteria)).digest("hex");
}

async function move(pool: pg.Pool, itemId: string, event: ItemEvent, also?: (c: pg.PoolClient) => Promise<void>): Promise<void> {
  await withTx(pool, async (c) => {
    await transitionItem(c, itemId, event, system);
    await also?.(c);
  });
}

async function items(pool: pg.Pool, sourceId: string, states: ItemState[]): Promise<Row[]> {
  const r = await pool.query<Row>(
    `select i.id, i.external_id, i.state, i.criteria_hash, i.readiness_policy_sha,
            r.id as run_id, r.run_number, r.branch, r.pr_number, r.reviews_seen_at
     from item i
     left join lateral (select * from run where item_id = i.id and ended_at is null order by started_at desc limit 1) r on true
     where i.source_id = $1 and i.state = any($2)`,
    [sourceId, states],
  );
  return r.rows;
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
    dodExists: loaded.get("dod") !== null && loaded.get("dod") !== undefined, configValid, repoKnown: true,
  };
}

/**
 * One pass over a backlog source. It brings in new and changed items, withdraws items that lost their label or
 * closed, restarts items whose criteria changed, records open dependencies, re-gates NotReady items when a
 * readiness input changed, gates every Eligible item, and moves InReview items whose PR changed. A judge that throws
 * leaves only that item in Eligible, so a usage limit never stops merge or withdrawal detection.
 */
export async function pollOnce(deps: PollDeps): Promise<{ seen: number; cursor: string }> {
  const { pool, adapter, repoHost, judge, sourceId } = deps;
  const src = (await pool.query<{ cursor: string | null; paused: boolean; label_filter: string | null }>(
    "select cursor, paused, label_filter from backlog_source where id = $1", [sourceId],
  )).rows[0];
  if (!src) throw new Error(`no backlog source ${sourceId}`);
  if (src.paused) return { seen: 0, cursor: src.cursor ?? "" };
  const label = src.label_filter ?? "factory";
  const known = new Map<string, FactoryItem>();

  // 1. New and changed items. An edited NotReady item goes back to Eligible for a fresh check.
  const listed = await adapter.listEligible(src.cursor);
  for (const fi of listed.items) {
    known.set(fi.externalId, fi);
    const id = await upsertItem(pool, { sourceId, externalId: fi.externalId, title: fi.title, rank: fi.rank });
    const state = (await pool.query<{ state: ItemState }>("select state from item where id = $1", [id])).rows[0].state;
    if (state === "NotReady") await move(pool, id, "item_edited");
  }

  // 2. Items the factory holds. listEligible can't see one that lost its label or closed, so each is read back.
  for (const row of await items(pool, sourceId, ACTIVE)) {
    const fi = await adapter.getItem(row.external_id);
    if (fi) known.set(fi.externalId, fi);
    if (!fi || fi.closed || !fi.labels.includes(label)) {
      await move(pool, row.id, "withdrawn");
      await closeOpenPr(repoHost, fi?.repo ?? null, row, "This PR's item was withdrawn from the backlog.");
      continue;
    }
    const hash = criteriaHash(fi.acceptanceCriteria);
    if (row.criteria_hash !== null && row.criteria_hash !== hash) {
      await restart(pool, row, fi, hash);
      await closeOpenPr(repoHost, fi.repo, row, "This item's acceptance criteria changed, so the factory starts a new run.");
      await adapter.comment(fi.externalId, "This item's acceptance criteria changed, so its scenarios need a new sign-off.", `criteria:${hash}`);
      continue;
    }
    if (row.state === "Queued" || row.state === "SignOff" || row.state === "NeedsInput") {
      await pool.query("update item set blocked_by = $2 where id = $1", [row.id, await adapter.openDependencies(fi.externalId)]);
    }
  }

  // 3. Readiness. A NotReady item checked against older inputs is re-gated, then every Eligible item is gated.
  const byRepo = new Map<string, Promise<Readiness>>();
  const readinessOf = (fi: FactoryItem) => {
    const key = fi.repo ?? "";
    if (!byRepo.has(key)) byRepo.set(key, readiness(pool, repoHost, fi.repo));
    return byRepo.get(key)!;
  };
  const itemOf = async (ext: string) => known.get(ext) ?? (await adapter.getItem(ext));

  for (const row of await items(pool, sourceId, ["NotReady"])) {
    const fi = await itemOf(row.external_id);
    if (!fi) continue;
    try {
      if ((await readinessOf(fi)).sha !== row.readiness_policy_sha) await move(pool, row.id, "policy_changed");
    } catch (e) {
      console.error(`readiness inputs for ${fi.repo} unreadable, retrying next poll:`, e);
    }
  }
  for (const row of await items(pool, sourceId, ["Eligible"])) {
    const fi = await itemOf(row.external_id);
    if (!fi) continue;
    try {
      const r = await readinessOf(fi);
      const out = await gate(fi, {
        readinessSha: r.sha, dor: r.dor, dodExists: r.dodExists, configValid: r.configValid, repoKnown: r.repoKnown,
        openDeps: r.repoKnown ? await adapter.openDependencies(fi.externalId) : [], judge, adapter, policyErrors: r.policyErrors,
      });
      await move(pool, row.id, out.ready ? "ready" : "readiness_failed", async (c) => {
        await c.query("update item set readiness_policy_sha = $2 where id = $1", [row.id, r.sha]);
        for (const v of out.results) {
          await c.query(
            `insert into policy_result (item_id, run_id, file, source, checked_sha, criterion_index, criterion, status, reason)
             values ($1, null, 'dor', $2, $3, $4, $5, $6, $7)`,
            [row.id, r.dor?.source ?? "repo", r.head || null, v.index, v.criterion, v.status, v.reason],
          );
        }
      });
    } catch (e) {
      // Most often the judge hit a usage limit. The item stays Eligible and the next poll tries again.
      console.error(`readiness check for item ${fi.externalId} failed, retrying next poll:`, e);
    }
  }

  // 4. PRs of InReview items. Only reviews by allowlisted users count (Run contract 10).
  const trusted = (await pool.query<{ github_login: string }>(`select github_login from "user" where github_login is not null`)).rows.map((u) => u.github_login);
  for (const row of await items(pool, sourceId, ["InReview"])) {
    const repo = known.get(row.external_id)?.repo ?? null;
    if (!repo || !row.pr_number) continue;
    const pr = await repoHost.prState(repo, row.pr_number, trusted);
    if (pr.merged) {
      await move(pool, row.id, "merged", (c) => c.query("update run set merge_sha = $2 where id = $1", [row.run_id, pr.mergeSha]).then(() => {}));
    } else if (!pr.open) {
      await move(pool, row.id, "withdrawn");
    } else if (pr.mergeable === false || newer(pr.lastChangesRequestedAt, row.reviews_seen_at)) {
      await move(pool, row.id, "changes_requested", (c) => c.query("update run set next_stage = 'address' where id = $1", [row.run_id]).then(() => {}));
    }
  }

  await pool.query("update backlog_source set cursor = $2 where id = $1", [sourceId, listed.cursor]);
  return { seen: listed.items.length, cursor: listed.cursor };
}

function newer(review: string | null, seen: Date | null): boolean {
  if (!review) return false;
  return seen === null || new Date(review).getTime() > seen.getTime();
}

/** Run contract 7: criteria changed, so the item goes back to Queued with a new run on a new branch. */
async function restart(pool: pg.Pool, row: Row, fi: FactoryItem, hash: string): Promise<void> {
  await move(pool, row.id, "criteria_changed", async (c) => {
    await c.query("update item set criteria_hash = $2 where id = $1", [row.id, hash]);
    await c.query("update run set ended_at = now(), outcome = 'criteria_changed' where item_id = $1 and ended_at is null", [row.id]);
    const n = (await c.query<{ n: number }>("select coalesce(max(run_number), 0) + 1 as n from run where item_id = $1", [row.id])).rows[0].n;
    await c.query("insert into run (item_id, run_number, next_stage, branch) values ($1, $2, 'understand', $3)", [row.id, n, `factory/pbi-${fi.externalId}-r${n}`]);
    await c.query("update question set closed_at = now() where item_id = $1 and answer is null and closed_at is null", [row.id]);
  });
}
