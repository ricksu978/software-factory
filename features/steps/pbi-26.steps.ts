import { After, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

// PBI 22. The @local scenarios build the cell image from this checkout and run it with the checkout mounted
// read-only at /work and no Docker socket, so a test can only get a database the way a real cell would.
const repo = process.cwd();
const sh = promisify(execFile);
const long = { timeout: 900_000 };
const IMAGE = "factory-cell:pbi-26-test";
const CELL_NETWORK = "factory-cells";

type Ctx = { dod?: string; config?: string; out?: string; outside?: string; outsidePort?: string; result?: Record<string, unknown> | null };

function ctx(world: object): Ctx {
  const w = world as { pbi26?: Ctx };
  w.pbi26 ??= {};
  return w.pbi26;
}

async function docker(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const r = await sh("docker", args, { maxBuffer: 64 * 1024 * 1024 });
    return { ...r, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number };
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? String(e), code: err.code ?? 1 };
  }
}

// Run contract 11's env for the gates' commands: PATH, HOME, CI and FACTORY_PG_BIN only when the image sets it.
const gateEnv = 'env -i PATH="$PATH" HOME="$HOME" CI=true ${FACTORY_PG_BIN:+FACTORY_PG_BIN="$FACTORY_PG_BIN"}';

function inCell(command: string, network = "none"): string[] {
  return ["run", "--rm", "--network", network, "-v", `${repo}:/work:ro`, "-w", "/work", "--entrypoint", "sh", IMAGE, "-c", `${gateEnv} ${command}`];
}

// A script run inside the cell: it prints one JSON line, and any error becomes that line too, so the Then fails, not the When.
function script(body: string): string {
  const js = `import { startTestDb } from "/work/src/store/test-db.ts";
const out = {};
try { ${body} } catch (e) { out.error = String(e && e.message || e); }
console.log(JSON.stringify(out));
process.exit(0);`;
  return `node --input-type=module -e '${js.replace(/'/g, "'\\''")}'`;
}

function lastJson(text: string): Record<string, unknown> | null {
  const line = text.trim().split("\n").reverse().find((l) => l.startsWith("{"));
  try { return line ? JSON.parse(line) : null; } catch { return null; }
}

When("the factory reads this repo's .factory\\/dod.md and .factory\\/config.yml", function () {
  const c = ctx(this);
  c.dod = readFileSync(join(repo, ".factory/dod.md"), "utf8");
  c.config = readFileSync(join(repo, ".factory/config.yml"), "utf8");
});

Then("no command sets FACTORY_DB_TESTS=skip", function () {
  const c = ctx(this);
  assert.ok(!c.dod?.includes("FACTORY_DB_TESTS=skip"), ".factory/dod.md still sets FACTORY_DB_TESTS=skip");
  assert.ok(!c.config?.includes("FACTORY_DB_TESTS=skip"), ".factory/config.yml still sets FACTORY_DB_TESTS=skip");
});

Then("the scenario filter leaves out only {string}", function (tag: string) {
  const c = ctx(this);
  const filters = [...`${c.dod}\n${c.config}`.matchAll(/--tags "([^"]+)"/g)].map((m) => m[1]);
  assert.ok(filters.length > 0, "no scenario filter found");
  for (const f of filters) assert.equal(f, `not ${tag}`, `a filter reads "${f}"`);
});

let built: Promise<void> | null = null;
Given("the cell image built from this checkout", long, async function () {
  built ??= docker(["build", "-f", "cell/Dockerfile", "-t", IMAGE, repo]).then((r) => {
    if (r.code !== 0) throw new Error(`cell image build failed: ${r.stderr.slice(-2000)}`);
  });
  await built;
});

When("a cell runs the database suites {string} and {string} with the gates' environment", long, async function (a: string, b: string) {
  const r = await docker(inCell(`node --test ${a} ${b}`));
  ctx(this).out = `${r.stdout}\n${r.stderr}`;
});

Then("every test in those files runs and passes", function () {
  const out = ctx(this).out ?? "";
  const count = (name: string) => Number(new RegExp(`^ℹ ${name} (\\d+)`, "m").exec(out)?.[1] ?? NaN);
  assert.ok(count("pass") > 0 && count("fail") === 0, `the suites didn't pass in the cell:\n${out.slice(-3000)}`);
});

Then("none is skipped", function () {
  const out = ctx(this).out ?? "";
  assert.equal(/^ℹ skipped (\d+)/m.exec(out)?.[1], "0", `some tests were skipped:\n${out.slice(-2000)}`);
});

When("a cell starts two test databases at once, then adds an item and the role {string} in the first", long, async function (role: string) {
  const r = await docker(inCell(script(`
    const [a, b] = await Promise.all([startTestDb(), startTestDb()]);
    const s = await a.pool.query("insert into backlog_source (adapter, url, field_map) values ('fake', 'test:one', '{}') returning id");
    await a.pool.query("insert into item (source_id, external_id, title, state) values ($1, '1', 'One', 'Eligible')", [s.rows[0].id]);
    await a.pool.query('create role "${role}"');
    out.items = (await b.pool.query("select count(*)::int as n from item")).rows[0].n;
    out.role = (await b.pool.query("select count(*)::int as n from pg_roles where rolname = $1", ["${role}"])).rows[0].n;
    await Promise.all([a.stop(), b.stop()]);`)));
  ctx(this).result = lastJson(r.stdout) ?? { error: r.stderr.slice(-2000) };
});

function result(world: object): Record<string, unknown> {
  const res = ctx(world).result;
  assert.ok(res && !res.error, `the cell couldn't start its test databases: ${String(res?.error)}`);
  return res;
}

Then("the second has no items", function () {
  assert.equal(result(this).items, 0);
});

Then("the second has no role {string}", function (_role: string) {
  assert.equal(result(this).role, 0);
});

Given("a Postgres server published on the host, outside the cell network", long, async function () {
  const c = ctx(this);
  const r = await docker(["run", "-d", "--rm", "-e", "POSTGRES_PASSWORD=outside", "-p", "127.0.0.1::5432", "postgres:17"]);
  assert.equal(r.code, 0, r.stderr);
  c.outside = r.stdout.trim();
  c.outsidePort = (await docker(["port", c.outside, "5432/tcp"])).stdout.trim().split(":").pop();
  for (let i = 0; i < 60; i++) {
    if ((await docker(["exec", c.outside, "pg_isready", "-U", "postgres"])).code === 0) return;
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error("the outside Postgres never became ready");
});

When("a cell on the cell network starts its own test database and then tries the outside server", long, async function () {
  const c = ctx(this);
  const net = await docker(["network", "inspect", CELL_NETWORK]);
  if (net.code !== 0) await docker(["network", "create", "--internal", CELL_NETWORK]);
  const r = await docker(inCell(script(`
    const own = await startTestDb();
    out.own = (await own.pool.query("select 1 as one")).rows[0].one;
    await own.stop();
    const pg = (await import("/work/node_modules/pg/lib/index.js")).default;
    const outside = new pg.Client({ host: "host.docker.internal", port: ${Number(c.outsidePort)}, user: "postgres", password: "outside", connectionTimeoutMillis: 5000 });
    try { await outside.connect(); out.outside = "connected"; await outside.end(); } catch (e) { out.outside = "unreachable: " + e.message; }`), CELL_NETWORK));
  c.result = lastJson(r.stdout) ?? { error: r.stderr.slice(-2000) };
});

Then("its own test database answers", function () {
  assert.equal(result(this).own, 1);
});

Then("the outside server can't be reached", function () {
  assert.match(String(result(this).outside), /^unreachable/);
});

After({ tags: "@pbi-26" }, async function () {
  const id = ctx(this).outside;
  if (id) await docker(["rm", "-f", id]);
});
