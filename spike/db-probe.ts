// Stands in for the migrate entry point until plan Task 4. It proves the database is reachable,
// and counts its own runs so a restart can show the data volume kept the rows (PBI 2, AC-2).
import pg from "pg";

const client = new pg.Client({ connectionString: process.env.FACTORY_DB_URI });
await client.connect();
await client.query("create table if not exists probe_runs (id serial primary key, at timestamptz not null default now())");
await client.query("insert into probe_runs default values");
const { rows } = await client.query<{ count: string }>("select count(*) from probe_runs");
console.log(`probe run ${rows[0].count}`);
await client.end();
