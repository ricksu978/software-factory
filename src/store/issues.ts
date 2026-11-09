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
 * repo decides, as the scheduler pinned it. Without one, the repo stored at intake from the item's issue decides
 * (PBI 137). The board's repo_map never does, since a board can hold issues from several repos and a link to the
 * wrong repo is worse than none. A repo not on GitHub is null.
 */
export async function issueRepos(pool: pg.Pool | pg.PoolClient, itemIds: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (!itemIds.length) return out;
  const rows = (await pool.query<{ id: string; stored: string | null; host_adapter: string | null; url: string | null }>(
    `select i.id, i.repo as stored, rp.host_adapter, rp.url from item i
     left join lateral (select r.repo_id from run r where r.item_id = i.id and r.repo_id is not null
       order by r.run_number desc, r.started_at desc limit 1) pinned on true
     left join repo rp on rp.id = pinned.repo_id
     where i.id = any($1::uuid[])`,
    [itemIds],
  )).rows;
  for (const r of rows) {
    // A stored repo goes through githubRepo too, so one that isn't owner/name never makes a link.
    const pinned = r.host_adapter && r.url ? { host: r.host_adapter, url: r.url } : null;
    const stored = r.stored ? { host: "github", url: `https://github.com/${r.stored}` } : null;
    const from = pinned ?? stored;
    out.set(r.id, from ? githubRepo(from.host, from.url) : null);
  }
  return out;
}
