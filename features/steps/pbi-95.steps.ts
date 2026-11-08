import { After, AfterAll, Before, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { load, long } from "./pbi-8.steps.ts";

// PBI 95 runs the real migrate entry point against sources files it writes, so it gets its own Postgres: migrate
// upserts the repo and backlog_source rows other suites share. Each scenario starts from empty repo and source tables.
// A source entry names its App's bot login under `trustedBot`.
type Db = { pool: import("pg").Pool; url: string; stop(): Promise<void> };
type Entry = { repo: string; trustedBot?: string };
type World = { pbi95?: { entries: Entry[]; dir?: string; read?: { repo: string; trustedBot?: unknown }[] } };

const thisRepoSources = join(process.cwd(), "config/sources.yml");
let db: Db | undefined;

async function database(): Promise<Db> {
  if (db) return db;
  const mod = await load<{ startTestDb: () => Promise<Db> }>("src/store/test-db.ts");
  assert.ok(mod, "src/store/test-db.ts doesn't exist");
  db = await mod.startTestDb();
  return db;
}

function ctx(world: object): NonNullable<World["pbi95"]> {
  const w = world as World;
  w.pbi95 ??= { entries: [] };
  return w.pbi95;
}

function writeSources(world: object): string {
  const c = ctx(world);
  c.dir ??= mkdtempSync(join(tmpdir(), "pbi95-"));
  const file = join(c.dir, "sources.yml");
  const doc = c.entries.map((e) => ({
    repo: e.repo,
    installationId: 1,
    owner: { type: "user", login: "o" },
    projectNumber: 1,
    fieldMap: {},
    ...(e.trustedBot === undefined ? {} : { trustedBot: e.trustedBot }),
  }));
  writeFileSync(file, stringify(doc));
  return file;
}

async function runMigrate(sources: string): Promise<void> {
  const d = await database();
  const { FACTORY_APP_PRINCIPAL: _p, FACTORY_ENV: _e, FACTORY_DEV_LOGIN: _l, ...env } = process.env;
  const r = spawnSync(process.execPath, ["src/store/migrate-cli.ts"], {
    env: { ...env, FACTORY_DB_URI: d.url, FACTORY_SOURCES: sources },
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(r.status, 0, `migrate exited ${r.status}: ${r.stderr}`);
}

function entry(world: object, repo: string): Entry {
  const c = ctx(world);
  let e = c.entries.find((x) => x.repo === repo);
  if (!e) c.entries.push((e = { repo }));
  return e;
}

Before({ tags: "@pbi-95", ...long }, async function () {
  const d = await database();
  await d.pool.query("truncate repo, backlog_source cascade");
});

After({ tags: "@pbi-95" }, function () {
  const dir = ctx(this).dir;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

AfterAll(long, async function () {
  if (db) await db.stop();
});

Given("a sources file whose entry for {string} names the bot login {string}", function (repo: string, login: string) {
  entry(this, repo).trustedBot = login;
});

Given("a sources file whose entry for {string} names no bot login", function (repo: string) {
  delete entry(this, repo).trustedBot;
});

Given("the same sources file has an entry for {string} that names the bot login {string}", function (repo: string, login: string) {
  entry(this, repo).trustedBot = login;
});

Given("the same sources file has an entry for {string} that names no bot login", function (repo: string) {
  delete entry(this, repo).trustedBot;
});

Given("the repo {string} already has the trusted bot {string}", long, async function (repo: string, login: string) {
  await (await database()).pool.query(
    "insert into repo (host_adapter, url, trusted_bot) values ('github', $1, $2)",
    [`https://github.com/${repo}`, login],
  );
});

Given("migrate has run against that sources file", long, async function () {
  await runMigrate(writeSources(this));
});

When("the entry for {string} names the bot login {string} instead", function (repo: string, login: string) {
  entry(this, repo).trustedBot = login;
});

When("the entry for {string} no longer names a bot login", function (repo: string) {
  delete entry(this, repo).trustedBot;
});

When("migrate runs against that sources file", long, async function () {
  await runMigrate(writeSources(this));
});

When("migrate runs against this repo's sources file", long, async function () {
  await runMigrate(thisRepoSources);
});

When("this repo's sources file is read", function () {
  ctx(this).read = parse(readFileSync(thisRepoSources, "utf8")) ?? [];
});

Then("its entry for {string} names the bot login {string}", function (repo: string, login: string) {
  const found = ctx(this).read?.find((e) => e.repo === repo);
  assert.ok(found, `config/sources.yml has no entry for ${repo}`);
  assert.equal(found.trustedBot, login);
});

async function trustedBot(repo: string): Promise<string | null> {
  const rows = (await (await database()).pool.query<{ trusted_bot: string | null }>(
    "select trusted_bot from repo where url = $1",
    [`https://github.com/${repo}`],
  )).rows;
  assert.equal(rows.length, 1, `expected one repo row for ${repo}, found ${rows.length}`);
  return rows[0].trusted_bot;
}

Then("the repo {string} has the trusted bot {string}", async function (repo: string, login: string) {
  assert.equal(await trustedBot(repo), login);
});

Then("the repo {string} has no trusted bot", async function (repo: string) {
  assert.equal(await trustedBot(repo), null);
});
