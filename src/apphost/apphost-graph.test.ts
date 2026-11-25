// Ties aspire-apphost/apphost.mts's real waits to appHostResources() (PBI 206). The scenarios check the order against
// appHostResources(), but the real AppHost wires its waits with waitFor() and waitForCompletion() calls of its own. This
// runs the real apphost.mts, in run mode and in publish mode, against a fake Aspire module that records every resource
// and every wait, and fails when the waits among the listed resources differ from the list.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { CELL_IMAGE_RESOURCE } from "./cell-image.ts";
import { appHostResources } from "./start.ts";

const repo = join(import.meta.dirname, "..", "..");

// A fake of Aspire's generated module. Every builder call returns a chainable stand-in that records the resources the
// AppHost adds and the waits it gives them. build().run() writes what it recorded, as JSON, to the file in GRAPH_OUT.
const FAKE_ASPIRE = String.raw`
import { writeFileSync } from 'node:fs';
const apps = [];
const waits = [];
const names = new WeakMap();
function stub(name) {
  const target = function () {};
  const p = new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then') return undefined;
      if (typeof prop === 'symbol') return undefined;
      return (...args) => {
        if (prop === 'build') return { run: async () => writeFileSync(process.env.GRAPH_OUT, JSON.stringify({ apps, waits })) };
        if (prop === 'isRunMode') return process.env.FAKE_RUN_MODE === '1';
        if (prop === 'waitFor' || prop === 'waitForCompletion') {
          waits.push({ from: name, to: names.get(args[0]) ?? null, kind: prop, options: args[1] ?? null });
          return p;
        }
        if (/^add/.test(prop) && typeof args[0] === 'string') {
          const child = stub(args[0]);
          if (prop === 'addNodeApp') apps.push(args[0]);
          return child;
        }
        return p;
      };
    },
  });
  names.set(p, name);
  return p;
}
export async function createBuilder() { return stub(null); }
export const EndpointProperty = new Proxy({}, { get: (_t, k) => k });
export const refExpr = (strings, ...values) => strings.join('');
`;

/**
 * The AppHost's start, faked: hands the resources appHostResources() lists to startResources, as startAppHost() does
 * once its checks pass, without touching git or Docker.
 */
const fakeNodeStart = (startUrl: string) => `
import { appHostResources } from ${JSON.stringify(startUrl)};
export async function runAppHostStart(_repo, startResources) {
  const deps = { git: () => ({ status: 0, stdout: '', stderr: '' }), dockerBuild: async () => 0 };
  await startResources(appHostResources(deps));
}
`;

type Graph = { apps: string[]; waits: { from: string | null; to: string | null; kind: string; options: { exitCode?: number } | null }[] };

/** Runs the real apphost.mts against the fakes, in run mode or not, and returns what it wired up. */
function runAppHost(runMode: boolean): Graph {
  const dir = mkdtempSync(join(tmpdir(), "apphost-graph-"));
  try {
    const hostDir = join(dir, "aspire-apphost");
    mkdirSync(join(hostDir, ".aspire", "modules"), { recursive: true });
    mkdirSync(join(dir, "src", "apphost"), { recursive: true });
    copyFileSync(join(repo, "aspire-apphost", "apphost.mts"), join(hostDir, "apphost.mts"));
    writeFileSync(join(hostDir, ".aspire", "modules", "aspire.mjs"), FAKE_ASPIRE);
    writeFileSync(join(dir, "src", "apphost", "node-start.ts"), fakeNodeStart(pathToFileURL(join(import.meta.dirname, "start.ts")).href));
    const out = join(dir, "graph.json");
    const r = spawnSync(process.execPath, [join(hostDir, "apphost.mts")], {
      cwd: hostDir,
      encoding: "utf8",
      env: { ...process.env, GRAPH_OUT: out, FAKE_RUN_MODE: runMode ? "1" : "0", FACTORY_FLOAT_PORTS: "" },
    });
    assert.equal(r.status, 0, `apphost.mts failed against the fake Aspire:\n${r.stderr}${r.stdout}`);
    return JSON.parse(readFileSync(out, "utf8")) as Graph;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** For each listed resource the AppHost added, the listed resources it waits for, sorted. */
function waitsAmong(graph: Graph, listed: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const name of listed) if (graph.apps.includes(name)) out[name] = [];
  for (const w of graph.waits) {
    if (w.from && w.to && w.from in out && listed.includes(w.to)) out[w.from].push(w.to);
  }
  for (const k of Object.keys(out)) out[k] = [...new Set(out[k])].sort();
  return out;
}

const listed = appHostResources({ git: () => ({ status: 0, stdout: "", stderr: "" }), dockerBuild: async () => 0 });
const names = listed.map((r) => r.name);

test("under aspire run, apphost.mts adds every resource appHostResources() lists, with the same waits", () => {
  const graph = runAppHost(true);
  for (const name of names) assert.ok(graph.apps.includes(name), `apphost.mts adds no resource named "${name}"`);
  const expected = Object.fromEntries(listed.map((r) => [r.name, [...r.waitsFor].sort()]));
  assert.deepEqual(waitsAmong(graph, names), expected);
});

test("under aspire run, the worker waits for cell-image to complete with exit code 0", () => {
  const graph = runAppHost(true);
  const wait = graph.waits.find((w) => w.from === "worker" && w.to === CELL_IMAGE_RESOURCE);
  assert.ok(wait, "the worker doesn't wait for cell-image");
  assert.equal(wait.kind, "waitForCompletion");
  assert.equal(wait.options?.exitCode, 0);
});

test("aspire publish adds no cell-image, and keeps the other listed waits", () => {
  const graph = runAppHost(false);
  assert.ok(!graph.apps.includes(CELL_IMAGE_RESOURCE));
  const expected = Object.fromEntries(
    listed.filter((r) => r.name !== CELL_IMAGE_RESOURCE).map((r) => [r.name, r.waitsFor.filter((w) => w !== CELL_IMAGE_RESOURCE).sort()]),
  );
  assert.deepEqual(waitsAmong(graph, names), expected);
});

test("under aspire run, the BFF waits for spa-build to complete with exit code 0, so it never serves a missing build", () => {
  const graph = runAppHost(true);
  assert.ok(graph.apps.includes("spa-build"), "apphost.mts adds no spa-build resource");
  const wait = graph.waits.find((w) => w.from === "bff" && w.to === "spa-build");
  assert.ok(wait, "the BFF doesn't wait for spa-build");
  assert.equal(wait.kind, "waitForCompletion");
  assert.equal(wait.options?.exitCode, 0);
});

test("aspire publish adds no spa-build resource", () => {
  assert.ok(!runAppHost(false).apps.includes("spa-build"));
});
