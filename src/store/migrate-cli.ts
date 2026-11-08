// The migrate entry point: the `migrate` resource locally and the migrate job in Azure (plan Task 4).
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type pg from "pg";
import { parse } from "yaml";
import { seedOwner } from "../../scripts/seed-owner.ts";
import { createPool, migrate } from "./db.ts";

type Source = { repo: string; installationId: number; owner: { type: "user" | "org"; login: string }; projectNumber: number; fieldMap: unknown; trustedBot?: string };

async function upsertSources(pool: pg.Pool, file: string): Promise<void> {
  const sources = (parse(readFileSync(file, "utf8")) ?? []) as Source[];
  for (const s of sources) {
    const repo = await pool.query<{ id: string }>(
      // trustedBot names the App's bot login. An entry without one keeps whatever trusted_bot the row already holds.
      `insert into repo (host_adapter, url, installation_id, trusted_bot) values ('github', $1, $2, $3)
       on conflict (url) do update set installation_id = excluded.installation_id,
         trusted_bot = coalesce(excluded.trusted_bot, repo.trusted_bot) returning id`,
      [`https://github.com/${s.repo}`, s.installationId, s.trustedBot || null],
    );
    const projectUrl = `https://github.com/${s.owner.type === "org" ? "orgs" : "users"}/${s.owner.login}/projects/${s.projectNumber}`;
    await pool.query(
      `insert into backlog_source (adapter, url, owner_type, owner_login, project_number, field_map, repo_map)
       values ('github', $1, $2, $3, $4, $5, $6)
       on conflict (url) do update set field_map = excluded.field_map, repo_map = backlog_source.repo_map || excluded.repo_map`,
      [projectUrl, s.owner.type, s.owner.login, s.projectNumber, JSON.stringify(s.fieldMap ?? {}), JSON.stringify({ [s.repo]: repo.rows[0].id })],
    );
  }
}

/**
 * Azure only: makes the control plane's Entra principal a member of factory_app, so the append-only grant applies
 * to the app. It runs as the database's Entra admin, the migrate job's identity. pgaadauth_create_principal exists
 * only on Azure Postgres, so it's called only when the role is missing, and only the Azure job sets the variable.
 * https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/how-to-manage-azure-ad-users
 */
async function ensureAppPrincipal(pool: pg.Pool, name: string): Promise<void> {
  const exists = await pool.query("select 1 from pg_roles where rolname = $1", [name]);
  if (exists.rowCount === 0) await pool.query("select * from pg_catalog.pgaadauth_create_principal($1, false, false)", [name]);
  await pool.query(`grant factory_app to "${name.replaceAll('"', '""')}"`);
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
    const pool = createPool(env.FACTORY_DB_URI);
    try {
      await migrate(pool);
      await seedOwner(pool, args.slice(1));
      return 0;
    } catch (e) {
      console.error((e as Error).message);
      return 1;
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
    if (env.FACTORY_APP_PRINCIPAL) await ensureAppPrincipal(pool, env.FACTORY_APP_PRINCIPAL);
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
