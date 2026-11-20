// PBI 84: under `aspire run` Azurite runs on an account key of its own, not the published devstoreaccount1 key, and
// FACTORY_BLOB carries it. The scenarios check the key's wiring in run mode. These check what they don't: a fresh key
// each start, a key that decodes to 64 bytes as an Azure Storage key does, and a published AppHost that keeps
// Aspire's own blobs connection, so no run-mode key is published. Like apphost-graph.test.ts, they run the real
// apphost.mts against a fake Aspire module, one that records each resource's environment.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const repo = join(import.meta.dirname, "..", "..");

// Records each resource's environment. A value that isn't a string is recorded as `<blobs>` for the blobs resource,
// `<port>` for an endpoint property, and refExpr`...` joins its parts.
const FAKE_ASPIRE = String.raw`
import { writeFileSync } from 'node:fs';
const resources = [];
const pending = [];
const kinds = new WeakMap();
const REF = Symbol('refExpr');
function stub(resource, kind) {
  const p = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      return (...args) => {
        if (prop === 'build') return { run: async () => { await Promise.all(pending); writeFileSync(process.env.ENV_OUT, JSON.stringify(resources)); } };
        if (prop === 'isRunMode') return process.env.FAKE_RUN_MODE === '1';
        if (prop === 'withEnvironment' && resource) { resource.env[args[0]] = show(args[1]); return p; }
        if (prop === 'runAsEmulator' && typeof args[0]?.configureContainer === 'function') {
          pending.push(Promise.resolve(args[0].configureContainer(stub(resource, 'container'))));
          return p;
        }
        if (prop === 'property') return stub(null, 'port');
        if (/^add/.test(prop) && typeof args[0] === 'string') {
          const r = { name: args[0], kind: prop, env: {} };
          resources.push(r);
          return stub(r, prop === 'addBlobs' ? 'blobs' : prop);
        }
        return p;
      };
    },
  });
  kinds.set(p, kind);
  return p;
}
function show(v) {
  if (typeof v === 'string') return v;
  if (v && v[REF]) return v.strings.reduce((out, s, i) => out + s + (i < v.values.length ? show(v.values[i]) : ''), '');
  return '<' + (kinds.get(v) ?? 'value') + '>';
}
export async function createBuilder() { return stub(null, 'builder'); }
export const EndpointProperty = new Proxy({}, { get: (_t, k) => k });
export const refExpr = (strings, ...values) => ({ [REF]: true, strings: [...strings], values });
`;

const FAKE_NODE_START = `export async function runAppHostStart(_repo, startResources) { await startResources(); }\n`;

type Resource = { name: string; kind: string; env: Record<string, string> };

function runAppHost(runMode: boolean): Resource[] {
  const dir = mkdtempSync(join(tmpdir(), "azurite-key-"));
  try {
    const hostDir = join(dir, "aspire-apphost");
    mkdirSync(join(hostDir, ".aspire", "modules"), { recursive: true });
    mkdirSync(join(dir, "src", "apphost"), { recursive: true });
    copyFileSync(join(repo, "aspire-apphost", "apphost.mts"), join(hostDir, "apphost.mts"));
    writeFileSync(join(hostDir, ".aspire", "modules", "aspire.mjs"), FAKE_ASPIRE);
    writeFileSync(join(dir, "src", "apphost", "node-start.ts"), FAKE_NODE_START);
    const out = join(dir, "env.json");
    const r = spawnSync(process.execPath, [join(hostDir, "apphost.mts")], {
      cwd: hostDir,
      encoding: "utf8",
      env: { ...process.env, ENV_OUT: out, FAKE_RUN_MODE: runMode ? "1" : "0", FACTORY_FLOAT_PORTS: "" },
    });
    assert.equal(r.status, 0, `apphost.mts failed against the fake Aspire:\n${r.stderr}${r.stdout}`);
    return JSON.parse(readFileSync(out, "utf8")) as Resource[];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const storage = (rs: Resource[]) => rs.find((r) => r.kind === "addAzureStorage")!;
const env = (rs: Resource[], name: string) => rs.find((r) => r.name === name)!.env;

function azuriteKey(rs: Resource[]): string {
  const accounts = storage(rs).env.AZURITE_ACCOUNTS;
  assert.ok(accounts, "Azurite is given no AZURITE_ACCOUNTS");
  const m = /^devstoreaccount1:([^:;]+)$/.exec(accounts);
  assert.ok(m, `AZURITE_ACCOUNTS isn't one devstoreaccount1 entry with one key: ${accounts.replace(/:.*/, ":...")}`);
  return m[1]!;
}

test("under aspire run, Azurite's key is 64 random bytes in base64, new at each start", () => {
  const first = azuriteKey(runAppHost(true));
  assert.equal(Buffer.from(first, "base64").length, 64);
  assert.equal(Buffer.from(first, "base64").toString("base64"), first);
  assert.notEqual(azuriteKey(runAppHost(true)), first);
});

test("under aspire run, FACTORY_BLOB signs with Azurite's key on Azurite's own blob endpoint", () => {
  const rs = runAppHost(true);
  const key = azuriteKey(rs);
  for (const name of ["control", "cell-api", "worker"]) {
    assert.equal(
      env(rs, name).FACTORY_BLOB,
      `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=${key};BlobEndpoint=http://127.0.0.1:<port>/devstoreaccount1;`,
    );
  }
});

test("aspire publish keeps Aspire's blobs connection, so no run-mode key is published", () => {
  const rs = runAppHost(false);
  assert.equal(storage(rs).env.AZURITE_ACCOUNTS, undefined);
  for (const name of ["control", "cell-api", "worker"]) assert.equal(env(rs, name).FACTORY_BLOB, "<blobs>");
});
