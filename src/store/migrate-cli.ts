// The migrate entry point: the `migrate` resource locally and the migrate job in Azure (plan Task 4).
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type pg from "pg";
import { parse } from "yaml";
import { createPool, migrate } from "./db.ts";

type Source = { repo: string; installationId: number; owner: { type: "user" | "org"; login: string }; projectNumber: number; fieldMap: unknown };

async function upsertSources(pool: pg.Pool, file: string): Promise<void> {
  const sources = (parse(readFileSync(file, "utf8")) ?? []) as Source[];
  for (const s of sources) {
    const repo = await pool.query<{ id: string }>(
      `insert into repo (host_adapter, url, installation_id) values ('github', $1, $2)
       on conflict (url) do update set installation_id = excluded.installation_id returning id`,
      [`https://github.com/${s.repo}`, s.installationId],
    );
    const projectUrl = `https://github.com/${s.owner.type === "org" ? "orgs" : "users"}/${s.owner.login}/projects/${s.projectNumber}`;
    await pool.query(
      `insert into backlog_source (adapter, url, owner_type, owner_login, project_number, field_map, repo_map)
       values ('github', $1, $2, $3, $4, $5, $6)
       on conflict (url) do update set field_map = excluded.field_map, repo_map = excluded.repo_map`,
      [projectUrl, s.owner.type, s.owner.login, s.projectNumber, JSON.stringify(s.fieldMap ?? {}), JSON.stringify({ [s.repo]: repo.rows[0].id })],
    );
  }
}

async function upsertDevOwner(pool: pg.Pool, login: string): Promise<void> {
  await pool.query(
    `insert into "user" (provider, subject, github_login, role, product_owner) values ('dev', $1, $1, 'owner', true)
     on conflict (provider, subject) do update set github_login = excluded.github_login, role = 'owner', product_owner = true`,
    [login],
  );
}

export async function main(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  if (args[0] === "seed-owner") {
    const seed = new URL("../../scripts/seed-owner.ts", import.meta.url);
    if (!existsSync(seed)) {
      console.error("seed-owner arrives with plan Task 15");
      return 1;
    }
    const pool = createPool(env.FACTORY_DB_URI);
    try {
      await migrate(pool);
      const mod = (await import(seed.href)) as { seedOwner: (pool: pg.Pool, words: string[]) => Promise<void> };
      await mod.seedOwner(pool, args.slice(1));
      return 0;
    } finally {
      await pool.end();
    }
  }
  if (args.length > 0) {
    console.error(`unknown argument: ${args[0]}`);
    return 1;
  }
  const pool = createPool(env.FACTORY_DB_URI);
  try {
    await migrate(pool);
    const sources = env.FACTORY_SOURCES ?? "config/sources.yml";
    if (existsSync(sources)) await upsertSources(pool, sources);
    if (env.FACTORY_ENV === "local") {
      if (env.FACTORY_DEV_LOGIN) await upsertDevOwner(pool, env.FACTORY_DEV_LOGIN);
      // Keeps PBI 2's restart scenario working: each local run adds one probe row.
      await pool.query("create table if not exists probe_runs (id serial primary key, at timestamptz not null default now())");
      await pool.query("insert into probe_runs default values");
    }
    return 0;
  } finally {
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
