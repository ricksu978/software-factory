// Which GitHub repo each item's issue is in, so the dashboard can link "#N" to it (PBI 131).
import type pg from "pg";

/** `owner/name` for a repo row on GitHub, or null for another host or a url that isn't one GitHub repo. */
export function githubRepo(hostAdapter: string, url: string): string | null {
  if (hostAdapter !== "github") return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.host !== "github.com") return null;
  const parts = u.pathname.replace(/^\/|\/$/g, "").split("/");
  return parts.length === 2 && parts.every((p) => /^[\w.-]+$/.test(p)) ? parts.join("/") : null;
}

/**
 * Each item's GitHub repo as `owner/name`, or null when the factory can't tell. The item's newest run that names a
 * repo decides, as the scheduler pinned it. Without one, the board decides only when its repo_map names one repo.
 * A repo not on GitHub is null, never a guess, since a link to the wrong repo is worse than none.
 */
export async function issueRepos(pool: pg.Pool | pg.PoolClient, itemIds: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (!itemIds.length) return out;
  const rows = (await pool.query<{ id: string; host_adapter: string | null; url: string | null }>(
    `select i.id, rp.host_adapter, rp.url from item i
     left join lateral (select r.repo_id from run r where r.item_id = i.id and r.repo_id is not null
       order by r.run_number desc, r.started_at desc limit 1) pinned on true
     left join backlog_source s on s.id = i.source_id
     left join repo rp on rp.id::text = coalesce(pinned.repo_id::text,
       case when jsonb_typeof(s.repo_map) = 'object' and (select count(*) from jsonb_object_keys(s.repo_map)) = 1
         then (select value from jsonb_each_text(s.repo_map)) end)
     where i.id = any($1::uuid[])`,
    [itemIds],
  )).rows;
  for (const r of rows) out.set(r.id, r.host_adapter && r.url ? githubRepo(r.host_adapter, r.url) : null);
  return out;
}
