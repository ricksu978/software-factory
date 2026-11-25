// Step definitions for features/pbi-84-azurite-own-account-key.feature.
// - The @ac-1 scenarios read the AppHost's wiring without starting it. They copy aspire-apphost/ to a temp directory
//   and run the real apphost.mts there against a stand-in for Aspire's generated module, as
//   src/apphost/apphost-graph.test.ts does. The stand-in records the environment each resource is given, including the
//   Azurite container's (the resource configureContainer is handed, or the storage resource itself), and resolves each
//   value as Aspire would:
//   - the blobs resource becomes the connection string Aspire's emulator hands out, which signs with the published
//     devstoreaccount1 key;
//   - a parameter becomes the value its options give, or else a stand-in value of its own, the same each time;
//   - refExpr`...` joins its parts, and anything else the stand-in can't resolve becomes `<name>`.
//   Azurite takes its accounts and keys from AZURITE_ACCOUNTS ("account:key1[:key2];..."), so that is the key it's given.
// - The @local scenarios run the owner's real `aspire run`, Docker and secrets, so the owner runs them and the PR
//   records the run. pbi-6.steps.ts owns `"aspire run" is up and the image ... is built` and `the response status is`,
//   so these steps share its world state (`pbi6`).
import { After, Given, Then, When } from "@cucumber/cucumber";
import {
  AccountSASPermissions, AccountSASResourceTypes, AccountSASServices, BlobSASPermissions, BlobServiceClient,
  generateAccountSASQueryParameters, generateBlobSASQueryParameters, StorageSharedKeyCredential,
} from "@azure/storage-blob";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { runToken } from "../../src/control/cell-api.ts";

const repo = process.cwd();
const long = { timeout: 600_000 };

/** Microsoft's published development account and key for Azurite. */
const DEV_ACCOUNT = "devstoreaccount1";
const PUBLISHED_KEY = "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";

// ---- @ac-1: the AppHost's wiring, read against a stand-in for Aspire ----

const FAKE_ASPIRE = String.raw`
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const PUBLISHED_KEY = ${JSON.stringify(PUBLISHED_KEY)};
const resources = [];
const pending = [];
const info = new WeakMap();
function stub(meta) {
  const target = function () {};
  const p = new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      return (...args) => {
        if (prop === 'build') return { run: async () => { await Promise.all(pending); writeFileSync(process.env.WIRING_OUT, JSON.stringify(dump())); } };
        if (prop === 'isRunMode') return process.env.FAKE_RUN_MODE === '1';
        if (prop === 'isPublishMode') return process.env.FAKE_RUN_MODE !== '1';
        if (prop === 'withEnvironment' && meta.resource) {
          if (typeof args[0] === 'string') meta.resource.env[args[0]] = args[1];
          return p;
        }
        if (prop === 'runAsEmulator' && meta.resource) {
          const configure = args[0]?.configureContainer;
          if (typeof configure === 'function') pending.push(Promise.resolve(configure(stub({ resource: meta.resource }))));
          return p;
        }
        if (/^addParameter/.test(prop) && typeof args[0] === 'string') {
          return stub({ kind: 'parameter', name: args[0], args: args.slice(1) });
        }
        if (/^add/.test(prop) && typeof args[0] === 'string') {
          const resource = { name: args[0], kind: prop, env: {} };
          resources.push(resource);
          return stub({ kind: prop === 'addBlobs' ? 'blobs' : 'resource', name: args[0], resource });
        }
        // Every other call chains, as Aspire's builders do, so later calls still land on the same resource.
        return p;
      };
    },
  });
  info.set(p, meta);
  return p;
}
const REF = Symbol('refExpr');
function standIn(name) {
  return createHash('sha256').update('stand-in for parameter ' + name).digest().toString('base64') + createHash('sha256').update(name).digest().toString('base64').slice(0, 44);
}
function paramValue(meta) {
  for (const a of meta.args) {
    if (typeof a === 'string') return a;
    if (a && typeof a === 'object') {
      for (const k of ['value', 'default', 'defaultValue']) if (typeof a[k] === 'string') return a[k];
    }
  }
  return standIn(meta.name);
}
function resolve(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v[REF]) return v.strings.reduce((out, s, i) => out + s + (i < v.values.length ? resolve(v.values[i]) : ''), '');
  const meta = info.get(v);
  if (!meta) return '<value>';
  if (meta.kind === 'blobs') return 'DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=' + PUBLISHED_KEY + ';BlobEndpoint=http://azurite.test:10000/devstoreaccount1;';
  if (meta.kind === 'parameter') return paramValue(meta);
  return '<' + meta.name + '>';
}
function dump() {
  return { resources: resources.map((r) => ({ name: r.name, kind: r.kind, env: Object.fromEntries(Object.entries(r.env).map(([k, v]) => [k, resolve(v)])) })) };
}
export async function createBuilder() { return stub({ kind: 'builder', name: 'builder' }); }
export const EndpointProperty = new Proxy({}, { get: (_t, k) => k });
export const refExpr = (strings, ...values) => ({ [REF]: true, strings: [...strings], values });
`;

const FAKE_NODE_START = `export async function runAppHostStart(_repo, startResources) { await startResources(); }\n`;

type Wiring = { resources: { name: string; kind: string; env: Record<string, string> }[] };
type Ac1 = { floatPorts: boolean; wiring?: Wiring; error?: string };

function ac1(world: object): Ac1 {
  const w = world as { pbi84?: Ac1 };
  w.pbi84 ??= { floatPorts: false };
  return w.pbi84;
}

/** Runs the real apphost.mts, as `aspire run` would (run mode), against the stand-in, and returns what it wired up. */
function readWiring(floatPorts: boolean): Wiring {
  const dir = mkdtempSync(join(tmpdir(), "pbi-84-apphost-"));
  try {
    const hostDir = join(dir, "aspire-apphost");
    cpSync(join(repo, "aspire-apphost"), hostDir, {
      recursive: true,
      filter: (src) => !/[\\/](node_modules|\.aspire|dist)([\\/]|$)/.test(src.slice(join(repo, "aspire-apphost").length)),
    });
    mkdirSync(join(hostDir, ".aspire", "modules"), { recursive: true });
    writeFileSync(join(hostDir, ".aspire", "modules", "aspire.mjs"), FAKE_ASPIRE);
    mkdirSync(join(dir, "src", "apphost"), { recursive: true });
    writeFileSync(join(dir, "src", "apphost", "node-start.ts"), FAKE_NODE_START);
    const out = join(dir, "wiring.json");
    const r = spawnSync(process.execPath, [join(hostDir, "apphost.mts")], {
      cwd: hostDir,
      encoding: "utf8",
      env: { ...process.env, WIRING_OUT: out, FAKE_RUN_MODE: "1", FACTORY_FLOAT_PORTS: floatPorts ? "1" : "" },
    });
    assert.equal(r.status, 0, `apphost.mts failed against the stand-in for Aspire:\n${r.stderr}${r.stdout}`);
    return JSON.parse(readFileSync(out, "utf8")) as Wiring;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function wiring(world: object): Wiring {
  const c = ac1(world);
  assert.ok(c.wiring, `the AppHost's wiring wasn't read: ${c.error ?? "no When ran"}`);
  return c.wiring;
}

/** The Azurite container: the storage resource, whose env carries what configureContainer gave the container. */
function azurite(w: Wiring) {
  const r = w.resources.find((x) => x.kind === "addAzureStorage");
  assert.ok(r, "the AppHost adds no Azure Storage resource");
  return r;
}

/** Azurite's accounts, from AZURITE_ACCOUNTS: "account:key1[:key2];...". */
function accounts(env: Record<string, string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const entry of (env.AZURITE_ACCOUNTS ?? "").split(";").map((s) => s.trim()).filter(Boolean)) {
    const [name, ...keys] = entry.split(":");
    out.set(name!, keys);
  }
  return out;
}

/** The account key the Azurite container is given, or null when it runs on its built-in development account. */
function azuriteKey(w: Wiring): { account: string; key: string } | null {
  const accts = accounts(azurite(w).env);
  const [first] = accts.entries();
  if (!first) return null;
  return { account: first[0], key: first[1][0] ?? "" };
}

function givenKey(w: Wiring): { account: string; key: string } {
  const k = azuriteKey(w);
  assert.ok(k, "the Azurite container is given no account key: its environment has no AZURITE_ACCOUNTS, so it runs on the published devstoreaccount1 key");
  return k;
}

const RESOURCE = { control: "control", "cell API": "cell-api", worker: "worker" } as const;

function factoryBlob(w: Wiring, resource: string): { account: string; key: string } {
  const r = w.resources.find((x) => x.name === resource);
  assert.ok(r, `the AppHost adds no ${resource} resource`);
  const cs = r.env.FACTORY_BLOB;
  assert.ok(cs, `the ${resource} resource is given no FACTORY_BLOB`);
  const part = (name: string) => new RegExp(`(?:^|;)\\s*${name}=([^;]*)`, "i").exec(cs)?.[1] ?? "";
  return { account: part("AccountName"), key: part("AccountKey") };
}

/** Asserts `resource`'s FACTORY_BLOB signs with the key Azurite is given, for the account Azurite is given it for. */
function carriesAzuriteKey(w: Wiring, resource: string): void {
  const blob = factoryBlob(w, resource);
  const accts = accounts(azurite(w).env);
  givenKey(w);
  const keys = accts.get(blob.account);
  assert.ok(keys, `the ${resource} resource's FACTORY_BLOB names account "${blob.account}", which the Azurite container isn't given`);
  assert.ok(keys.includes(blob.key), `the ${resource} resource's FACTORY_BLOB carries a different key from the one the Azurite container is given`);
}

Given("ports float, as they do for a test run", function () {
  ac1(this).floatPorts = true;
});

When("the AppHost's wiring for {string} is read without starting it", function (_cmd: string) {
  const c = ac1(this);
  try {
    c.wiring = readWiring(c.floatPorts);
  } catch (e) {
    c.error = e instanceof Error ? e.message : String(e);
  }
});

Then("the Azurite container is given an account key", function () {
  givenKey(wiring(this));
});

Then("that account key is not the published development key", function () {
  assert.notEqual(givenKey(wiring(this)).key, PUBLISHED_KEY, "the Azurite container is given the published development key");
});

Then("that account key is not empty", function () {
  assert.ok(givenKey(wiring(this)).key.trim() !== "", "the Azurite container is given an empty account key");
});

Then("the Azurite container is given an account key that is not the published development key", function () {
  assert.notEqual(givenKey(wiring(this)).key, PUBLISHED_KEY, "the Azurite container is given the published development key");
});

Then("the control resource's {string} carries the same account key as the Azurite container", function (variable: string) {
  assert.equal(variable, "FACTORY_BLOB");
  carriesAzuriteKey(wiring(this), "control");
});

Then("the account key in the control resource's {string} is not the published development key", function (variable: string) {
  assert.equal(variable, "FACTORY_BLOB");
  assert.notEqual(factoryBlob(wiring(this), "control").key, PUBLISHED_KEY, "the control resource's FACTORY_BLOB carries the published development key");
});

Then("the {string} of the control, cell API and worker resources all carry the Azurite container's account key", function (variable: string) {
  assert.equal(variable, "FACTORY_BLOB");
  const w = wiring(this);
  for (const resource of Object.values(RESOURCE)) carriesAzuriteKey(w, resource);
});

Then("none of them carries the published development key", function () {
  const w = wiring(this);
  const carrying = Object.values(RESOURCE).filter((r) => factoryBlob(w, r).key === PUBLISHED_KEY);
  assert.deepEqual(carrying, [], `these resources' FACTORY_BLOB carries the published development key: ${carrying.join(", ")}`);
});

// ---- @local: the owner runs these against a real `aspire run`, and the PR records the run ----
// A SAS's signature is an HMAC over its fields with the account key, so it is the same whoever computes it. Code in a
// cell can compute it with the published key, which anyone can look up. These steps compute it with that key and hand
// the URL to a factory-cell:local container, which sends it through the egress proxy as a cell would.

const APPHOST = "--apphost . --non-interactive --nologo";
const EGRESS_PROXY = "http://factory-egress:3128";

type Local = {
  /** Control's real FACTORY_BLOB, from `aspire describe`. */
  blob?: string;
  /** What the container sends, and what came back. */
  url?: string;
  body?: string;
  log?: { container: string; path: string; text: string };
  seeded?: { dbUri: string; itemId: string; sourceId: string };
};

function local(world: object): Local {
  const w = world as { pbi84local?: Local };
  w.pbi84local ??= {};
  return w.pbi84local;
}

/** pbi-6.steps.ts's state: its Given starts `aspire run` and checks the image, and its Then reads `status`. */
function p6(world: object): { started: boolean; imageBuilt?: boolean; status?: number | null } {
  const w = world as { pbi6?: { started: boolean; imageBuilt?: boolean; status?: number | null } };
  w.pbi6 ??= { started: false };
  return w.pbi6;
}

/** `aspire describe` for one resource. Its stdout shows environment values, so it's never printed. */
function describe(resource: string): Record<string, unknown> | undefined {
  const r = spawnSync(`aspire describe ${resource} --format Json ${APPHOST}`, {
    cwd: repo, shell: true, encoding: "utf8", env: { ...process.env, FACTORY_FLOAT_PORTS: "1" },
  });
  try {
    const out = r.stdout ?? "";
    return (JSON.parse(out.slice(out.indexOf("{"))) as { resources: Record<string, unknown>[] }).resources[0];
  } catch {
    return undefined;
  }
}

function findKey(value: unknown, pattern: RegExp): unknown {
  if (!value || typeof value !== "object") return undefined;
  for (const [k, v] of Object.entries(value)) {
    if (pattern.test(k)) return v;
    const nested = findKey(v, pattern);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function envOf(resource: string, name: string): string | undefined {
  const v = findKey(describe(resource), new RegExp(`^${name}$`));
  return typeof v === "string" ? v : undefined;
}

function controlBlob(world: object): string | undefined {
  const l = local(world);
  l.blob ??= envOf("control", "FACTORY_BLOB");
  return l.blob;
}

const part = (cs: string, name: string) => new RegExp(`(?:^|;)\\s*${name}=([^;]*)`, "i").exec(cs)?.[1];

/** Azurite's blob endpoint as a cell container reaches it: host.docker.internal on Azurite's port. */
function cellBlobEndpoint(world: object): string | undefined {
  const blob = controlBlob(world);
  const endpoint = blob ? part(blob, "BlobEndpoint") : undefined;
  if (!endpoint) return undefined;
  const u = new URL(endpoint);
  u.hostname = "host.docker.internal";
  return u.toString().replace(/\/$/, "");
}

/** Waits until the worker has started the egress proxy, for up to two minutes. */
function egressUp(): boolean {
  const end = Date.now() + 120_000;
  while (Date.now() < end) {
    const r = spawnSync("docker", ["inspect", "--format", "{{.State.Running}}", "factory-egress"], { encoding: "utf8" });
    if ((r.stdout ?? "").trim() === "true") return true;
    spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 2000)"]);
  }
  return false;
}

/** curl in a factory-cell:local container on the cell network, through the egress proxy. Returns status and body. */
function curlInCell(args: string[]): { status: number | null; body: string } {
  if (!egressUp()) return { status: null, body: "" };
  const r = spawnSync("docker", [
    "run", "--rm", "--network", "factory-cells",
    "-e", `http_proxy=${EGRESS_PROXY}`, "-e", `HTTP_PROXY=${EGRESS_PROXY}`, "-e", `https_proxy=${EGRESS_PROXY}`, "-e", `HTTPS_PROXY=${EGRESS_PROXY}`,
    "factory-cell:local", "curl", "-s", "-w", "\n%{http_code}", ...args,
  ], { encoding: "utf8" });
  const out = (r.stdout ?? "").replace(/\r?\n$/, "");
  const i = out.lastIndexOf("\n");
  const status = Number.parseInt(out.slice(i + 1), 10);
  return { status: Number.isInteger(status) && status > 0 ? status : null, body: i < 0 ? "" : out.slice(0, i) };
}

function service(world: object): BlobServiceClient {
  const blob = controlBlob(world);
  assert.ok(blob, "Aspire gave the control resource no FACTORY_BLOB");
  return BlobServiceClient.fromConnectionString(blob);
}

const published = new StorageSharedKeyCredential(DEV_ACCOUNT, PUBLISHED_KEY);
const soon = () => new Date(Date.now() + 15 * 60_000);

/** A blob SAS URL a cell could sign for itself with the published key, as the cell container reaches Azurite. */
function forgedBlobSas(world: object, container: string, path: string, permissions: string): string {
  const endpoint = cellBlobEndpoint(world);
  assert.ok(endpoint, "couldn't read Azurite's blob endpoint from the control resource's FACTORY_BLOB in `aspire describe`");
  const sas = generateBlobSASQueryParameters(
    { containerName: container, blobName: path, permissions: BlobSASPermissions.parse(permissions), expiresOn: soon() }, published,
  ).toString();
  return `${endpoint}/${container}/${path.split("/").map(encodeURIComponent).join("/")}?${sas}`;
}

Given("a {string} container has signed its own write SAS for a blob under {string}, with the published development key", function (_image: string, container: string) {
  const l = local(this);
  l.log = { container, path: `pbi-84/${randomUUID()}.txt`, text: "" };
  l.url = forgedBlobSas(this, container, l.log.path, "cw");
  assert.ok(l.url, "no forged write SAS URL was made");
});

Given("a run's log has been uploaded to Azurite", long, async function () {
  const l = local(this);
  const runId = randomUUID();
  l.log = { container: "transcripts", path: `${runId}/red-1.jsonl`, text: `{"pbi-84":"the log of run ${runId}"}\n` };
  assert.ok(controlBlob(this), "couldn't read the control resource's FACTORY_BLOB from `aspire describe`");
  const client = service(this).getContainerClient(l.log.container);
  await client.createIfNotExists();
  await client.getBlockBlobClient(l.log.path).upload(l.log.text, Buffer.byteLength(l.log.text));
  assert.equal(await readLog(this), l.log.text, "the log uploaded to Azurite doesn't read back as written");
});

Given("a {string} container has signed its own read SAS for that log, with the published development key", function (_image: string) {
  const l = local(this);
  assert.ok(l.log, "no log was uploaded");
  l.url = forgedBlobSas(this, l.log.container, l.log.path, "r");
  assert.ok(l.url, "no forged read SAS URL was made");
});

Given("a {string} container has signed its own write SAS for that log, with the published development key", function (_image: string) {
  const l = local(this);
  assert.ok(l.log, "no log was uploaded");
  l.url = forgedBlobSas(this, l.log.container, l.log.path, "cw");
  assert.ok(l.url, "no forged write SAS URL was made");
});

Given("a {string} container has signed its own account SAS that allows listing, with the published development key", function (_image: string) {
  const l = local(this);
  const endpoint = cellBlobEndpoint(this);
  assert.ok(endpoint, "couldn't read Azurite's blob endpoint from the control resource's FACTORY_BLOB in `aspire describe`");
  const sas = generateAccountSASQueryParameters({
    services: AccountSASServices.parse("b").toString(),
    resourceTypes: AccountSASResourceTypes.parse("s").toString(),
    permissions: AccountSASPermissions.parse("l"),
    expiresOn: soon(),
  }, published).toString();
  l.url = `${endpoint}/?comp=list&${sas}`;
  assert.ok(l.url.includes("sig="), "the forged account SAS URL carries no signature");
});

function send(world: object, method: "PUT" | "GET", data?: string): void {
  const l = local(world);
  const c = p6(world);
  if (!c.imageBuilt || !l.url) {
    c.status = null;
    return;
  }
  const args = method === "PUT" ? ["-X", "PUT", "-H", "x-ms-blob-type: BlockBlob", "--data-binary", data ?? "", l.url] : [l.url];
  const r = curlInCell(args);
  c.status = r.status;
  l.body = r.body;
}

When("the container PUTs a blob to that SAS URL through the egress proxy", long, function () {
  send(this, "PUT", "forged by a cell");
});

When("the container GETs that SAS URL through the egress proxy", long, function () {
  send(this, "GET");
});

When("the container PUTs {string} to that SAS URL through the egress proxy", long, function (text: string) {
  send(this, "PUT", text);
});

When("the container lists the blob containers with that SAS through the egress proxy", long, function () {
  send(this, "GET");
});

Then("no such blob exists in Azurite", long, async function () {
  const l = local(this);
  assert.ok(l.log, "no blob was named");
  const exists = await service(this).getContainerClient(l.log.container).getBlockBlobClient(l.log.path).exists();
  assert.equal(exists, false, `Azurite holds ${l.log.container}/${l.log.path}`);
});

Then("the response does not contain the log's text", function () {
  const l = local(this);
  assert.ok(l.log?.text, "no log was uploaded");
  assert.ok(!(l.body ?? "").includes(l.log.text.trim()), "the response carries the log's text");
});

async function readLog(world: object): Promise<string> {
  const l = local(world);
  assert.ok(l.log, "no log was uploaded");
  const r = await service(world).getContainerClient(l.log.container).getBlockBlobClient(l.log.path).downloadToBuffer();
  return r.toString("utf8");
}

Then("the log in Azurite still holds its original text", long, async function () {
  assert.equal(await readLog(this), local(this).log!.text);
});

// ---- @ac-3: the cell API's upload URLs ----

/** Seeds an item with a run in progress at lease generation 1 in the factory's database, and returns its credential. */
async function seedRun(world: object): Promise<{ runId: string; credential: string }> {
  const dbUri = envOf("cell-api", "FACTORY_DB_URI");
  const secret = envOf("cell-api", "CELL_SECRET");
  assert.ok(dbUri, "couldn't read the cell-api resource's FACTORY_DB_URI from `aspire describe`");
  assert.ok(secret, "couldn't read the cell-api resource's CELL_SECRET from `aspire describe`");
  const client = new pg.Client({ connectionString: dbUri });
  await client.connect();
  try {
    const sourceId = (await client.query<{ id: string }>(
      "insert into backlog_source (adapter, url) values ('fake', 'pbi-84:' || gen_random_uuid()) returning id")).rows[0]!.id;
    const itemId = (await client.query<{ id: string }>(
      `insert into item (source_id, external_id, title, state, lease_owner, lease_generation, lease_expires)
       values ($1, 'pbi-84', 'pbi-84 upload URL', 'InProgress', 'pbi-84', 1, now() + interval '1 hour') returning id`, [sourceId])).rows[0]!.id;
    const runId = (await client.query<{ id: string }>(
      "insert into run (item_id, run_number, next_stage) values ($1, 1, 'red') returning id", [itemId])).rows[0]!.id;
    local(world).seeded = { dbUri, itemId, sourceId };
    return { runId, credential: `${runId}.1.${runToken(secret, runId, 1)}` };
  } finally {
    await client.end();
  }
}

After({ tags: "@pbi-84 and @local" }, async function () {
  const s = local(this).seeded;
  if (!s) return;
  const client = new pg.Client({ connectionString: s.dbUri });
  await client.connect();
  try {
    await client.query("update item set state = 'Abandoned', lease_owner = null, lease_expires = null where id = $1", [s.itemId]);
  } catch {
    // Best effort: the item is the test's own, and an abandoned one is never claimed.
  } finally {
    await client.end();
  }
});

/** Asks the cell API, from a cell container through the egress proxy, for an upload URL for the run's transcript. */
async function askUploadUrl(world: object): Promise<void> {
  const l = local(world);
  assert.ok(p6(world).imageBuilt, "the image factory-cell:local isn't built");
  const cellApi = findKey(describe("cell-api"), /^urls$/);
  const url = Array.isArray(cellApi) ? (cellApi[0] as { url?: string } | undefined)?.url : undefined;
  assert.ok(url, "couldn't read the cell-api resource's URL from `aspire describe`");
  const run = await seedRun(world);
  const base = url.replace(/\/$/, "").replace("localhost", "host.docker.internal");
  const r = curlInCell([
    "-X", "POST", "-H", `Authorization: Bearer ${run.credential}`, "-H", "content-type: application/json",
    "--data", JSON.stringify({ kind: "transcript", stageId: "red", attempt: 1 }), `${base}/internal/cells/${run.runId}/upload-url`,
  ]);
  assert.equal(r.status, 200, `the cell API answered the upload-URL request with ${r.status ?? "no response"}, not 200: ${r.body}`);
  l.url = (JSON.parse(r.body) as { url?: string }).url;
  const text = `{"pbi-84":"the log of run ${run.runId}"}\n`;
  l.log = { container: "transcripts", path: `${run.runId}/red-1.jsonl`, text };
}

Given("a {string} container has asked the cell API for an upload URL for its run's log", long, async function (_image: string) {
  await askUploadUrl(this);
  const l = local(this);
  assert.ok(l.url, "the cell API gave the container no upload URL");
  assert.ok(l.log, "no log was named for the upload");
});

Given("a {string} container has uploaded its run's log to an upload URL from the cell API", long, async function (_image: string) {
  await askUploadUrl(this);
  const l = local(this);
  assert.ok(l.url, "the cell API gave the container no upload URL");
  assert.ok(l.log, "no log was named for the upload");
  const r = curlInCell(["-X", "PUT", "-H", "x-ms-blob-type: BlockBlob", "--data-binary", l.log.text, l.url]);
  assert.equal(r.status, 201, `the container's PUT of its log to the upload URL got ${r.status ?? "no response"}, not 201: ${r.body}`);
});

When("the container PUTs the log to that upload URL through the egress proxy", long, function () {
  send(this, "PUT", local(this).log?.text);
});

When("the container GETs that upload URL through the egress proxy", long, function () {
  send(this, "GET");
});

Then("the control plane reads back the same log from Azurite", long, async function () {
  assert.equal(await readLog(this), local(this).log!.text);
});
