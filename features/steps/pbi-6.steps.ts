import { After, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Steps record what they observe and assert only in Then, so a missing AppHost or image shows as red, not as a crash.
// The AppHost runs with `--isolated` and FACTORY_FLOAT_PORTS=1, so Aspire picks control's and Azurite's ports, and
// sessions in different worktrees never clash on 7400 or 7410. Two runs from the SAME worktree still share its named
// data volumes, so run these scenarios once per worktree at a time. Every aspire command names this AppHost with
// --apphost, and control's URLs come from `aspire describe` once it's up.
const repo = process.cwd();
const APPHOST = "--apphost . --non-interactive --nologo";
let control = "";
let cellControl = "";
const long = { timeout: 600_000 };

type Ctx = {
  started: boolean;
  up?: boolean;
  runsBefore?: number | null;
  runsAfter?: number | null;
  envNames?: string[] | null;
  imageBuilt?: boolean;
  status?: number | null;
  sdkOut?: string;
};

function ctx(world: object): Ctx {
  const w = world as { pbi6?: Ctx };
  w.pbi6 ??= { started: false };
  return w.pbi6;
}

function sh(command: string, input?: string): { status: number | null; out: string; stdout: string; stderr: string } {
  const r = spawnSync(command, { cwd: repo, shell: true, encoding: "utf8", input, env: { ...process.env, FACTORY_FLOAT_PORTS: "1" } });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// Retries because a restart leaves fetch holding a dead keep-alive socket to the old process.
async function get(path: string): Promise<{ status: number; body: string } | null> {
  if (!control) return null;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const r = await fetch(`${control}${path}`, { signal: AbortSignal.timeout(5_000) });
      return { status: r.status, body: await r.text() };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  return null;
}

/**
 * `aspire describe` for one resource, or every resource when none is named, parsed from the JSON on stdout. It hands
 * back the exit status and stderr, never stdout, because stdout shows environment values such as FACTORY_DB_URI.
 */
function describe(resource = ""): { status: number | null; stderr: string; doc: { resources: Record<string, any>[] } | null } {
  const r = sh(`aspire describe ${resource} --format Json ${APPHOST}`);
  try {
    return { status: r.status, stderr: r.stderr, doc: JSON.parse(r.stdout.slice(r.stdout.indexOf("{"))) };
  } catch {
    return { status: r.status, stderr: r.stderr, doc: null };
  }
}

async function startAspire(c: Ctx): Promise<void> {
  c.started = true;
  control = "";
  cellControl = "";
  sh(`aspire start --isolated ${APPHOST}`);
  const waited = sh(`aspire wait control --status up --timeout 300 ${APPHOST}`);
  const url = describe("control").doc?.resources[0]?.urls?.[0]?.url;
  if (waited.status === 0 && typeof url === "string") {
    control = url.replace(/\/$/, "");
    cellControl = control.replace("localhost", "host.docker.internal");
  }
  c.up = (await get("/")) !== null;
}

function stopAspire(): void {
  sh(`aspire stop ${APPHOST}`);
}

async function runCount(): Promise<number | null> {
  const r = await get("/probe/runs");
  if (!r || r.status !== 200) return null;
  const n = (JSON.parse(r.body) as { count?: unknown }).count;
  return typeof n === "number" ? n : null;
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

function inCell(args: string): { status: number | null; out: string } {
  return sh(`docker run --rm --add-host=host.docker.internal:host-gateway ${args}`);
}

After({ tags: "@local" }, function () {
  if (ctx(this).started) stopAspire();
});

When("I start {string} and wait until the control resource answers", long, async function (_cmd: string) {
  await startAspire(ctx(this));
});

// CELL_CONTROL_URL is what the launcher hands each cell, so it must name the port control really answers on, pinned or
// floated. Read from `aspire describe`, which shows the resource's environment values.
Then("the control resource tells cells the port it answers on", function () {
  assert.ok(ctx(this).up, "the AppHost never came up");
  const res = describe("control").doc?.resources[0];
  const told = res?.environment?.CELL_CONTROL_URL;
  // Names only: describe shows values, and FACTORY_DB_URI carries the database password.
  assert.ok(typeof told === "string", `control has no CELL_CONTROL_URL among ${JSON.stringify(Object.keys(res?.environment ?? {}))}`);
  assert.equal(new URL(told).hostname, "host.docker.internal");
  assert.equal(new URL(told).port, new URL(control).port, `CELL_CONTROL_URL ${told} doesn't name control's port, ${control}`);
});

// Asks Aspire which container and named volume belong to this AppHost's resource, then checks that exact
// container. A name filter could match another AppHost's container, and both images declare an anonymous
// VOLUME, so any container would show a volume mount even without withDataVolume().
Then("the {string} and {string} containers are running, each with a data volume", function (a: string, b: string) {
  assert.ok(ctx(this).up, "the AppHost never came up");
  for (const resource of [a, b]) {
    const res = describe(resource).doc?.resources[0];
    const id = res?.properties?.["container.id"];
    assert.ok(typeof id === "string" && id, `aspire describe gave no container for "${resource}"`);
    const volumes = ([] as { source?: string; mountType?: string }[]).concat((res?.volumes ?? []) as never);
    const named = volumes.find((v) => v.mountType === "volume" && v.source?.endsWith("-data"));
    assert.ok(named?.source, `"${resource}" has no named data volume in ${JSON.stringify(res.volumes)}`);
    const state = sh(`docker inspect --format "{{.State.Running}} {{.Config.Image}} {{range .Mounts}}{{.Name}}={{.Destination}} {{end}}" ${id}`).out;
    const [running, image = "", ...mounts] = state.trim().split(/\s+/);
    assert.equal(running, "true", `the "${resource}" container isn't running`);
    const mount = mounts.find((m) => m.startsWith(`${named.source}=`));
    assert.ok(mount, `the "${resource}" container doesn't mount ${named.source}`);
    // The AppHost pins pg to Postgres 17, whose image keeps its data in an anonymous VOLUME at /var/lib/postgresql/data.
    // A named volume mounted anywhere else, as when withImageTag() comes after withDataVolume(), loses the data on restart.
    if (resource === "pg") {
      assert.match(image, /(^|\/)postgres:17(\.|$)/, `"pg" runs ${image}, not Postgres 17`);
      assert.equal(mount, `${named.source}=/var/lib/postgresql/data`, `"pg" mounts its data volume at the wrong path`);
    }
  }
});

Then("the {string} resource has exited with code {int}", function (resource: string, code: number) {
  assert.ok(ctx(this).up, "the AppHost never came up");
  const r = describe(resource);
  assert.ok(r.doc, `aspire describe gave no JSON, exit status ${r.status}, stderr:\n${r.stderr}`);
  // The resource's state, never the whole describe output, which shows environment values such as FACTORY_DB_URI.
  assert.equal(findKey(r.doc, /^exit_?code$/i), code, `exit code of "${resource}", in state ${String(r.doc.resources[0]?.state)}`);
});

Given('{string} has run once and the migrate probe recorded its run count', long, async function (_cmd: string) {
  const c = ctx(this);
  await startAspire(c);
  c.runsBefore = c.up ? await runCount() : null;
});

When('I stop {string} and start it again', long, async function (_cmd: string) {
  const c = ctx(this);
  stopAspire();
  await startAspire(c);
  c.runsAfter = c.up ? await runCount() : null;
});

Then("the migrate probe's run count is one higher than before", function () {
  const c = ctx(this);
  assert.ok(typeof c.runsBefore === "number", "no run count before the restart");
  assert.ok(typeof c.runsAfter === "number", "no run count after the restart");
  assert.equal(c.runsAfter, c.runsBefore + 1);
});

Given("{string} is up", long, async function (_cmd: string) {
  await startAspire(ctx(this));
});

When("I ask the control resource for the names of its environment variables", long, async function () {
  const r = await get("/probe/env");
  ctx(this).envNames = r && r.status === 200 ? (JSON.parse(r.body) as string[]) : null;
});

Then("the names include {string}, {string}, {string}, {string}, {string} and {string}", function (a: string, b: string, c: string, d: string, e: string, f: string) {
  const names = ctx(this).envNames;
  assert.ok(names, "the control resource gave no variable names");
  for (const n of [a, b, c, d, e, f]) assert.ok(names.includes(n), `"${n}" is missing from ${JSON.stringify(names)}`);
});

const spike = "docs/superpowers/spikes/2026-11-local-platform.md";

function spikeText(): string {
  const file = join(repo, spike);
  assert.ok(existsSync(file), `${spike} is missing`);
  return readFileSync(file, "utf8");
}

Then("the spike record names the variables Aspire injected for the database and the blobs", function () {
  const text = spikeText();
  assert.match(text, /\*\*Database variable\.\*\*[^\n]*`[A-Z][A-Z0-9_]+`/, "no Database variable line naming a variable");
  assert.match(text, /\*\*Blob variable\.\*\*[^\n]*`[A-Z][A-Z0-9_]+`/, "no Blob variable line naming a variable");
});

Given("{string} is up and the image {string} is built", long, async function (_cmd: string, image: string) {
  const c = ctx(this);
  await startAspire(c);
  c.imageBuilt = sh(`docker image inspect ${image}`).status === 0;
});

Given("the image {string} is built", function (image: string) {
  ctx(this).imageBuilt = sh(`docker image inspect ${image}`).status === 0;
});

When("a {string} container posts to {string} on the control plane", long, function (image: string, path: string) {
  const c = ctx(this);
  if (!c.imageBuilt) {
    c.status = null;
    return;
  }
  const r = inCell(`${image} curl -s -o /dev/null -w "%{http_code}" -X POST ${cellControl}${path}`);
  c.status = Number.parseInt(r.out.trim(), 10) || null;
});

When("the container PUTs a blob to an upload URL from {string}", long, async function (path: string) {
  const c = ctx(this);
  const r = await get(path);
  if (!c.imageBuilt || !r || r.status !== 200) {
    c.status = null;
    return;
  }
  const url = (JSON.parse(r.body) as { url: string }).url;
  const put = inCell(`factory-cell:local curl -s -o /dev/null -w "%{http_code}" -X PUT -H "x-ms-blob-type: BlockBlob" --data hi "${url}"`);
  c.status = Number.parseInt(put.out.trim(), 10) || null;
});

Then("the response status is {int}", function (code: number) {
  assert.equal(ctx(this).status, code);
});

When("a {string} container runs {string} with the Claude token", long, function (image: string, script: string) {
  const c = ctx(this);
  c.sdkOut = c.imageBuilt ? inCell(`-e CLAUDE_CODE_OAUTH_TOKEN ${image} node /app/${script}`).out : "";
});

Then('the result\'s subtype is {string}, or the spike record shows the {string} fallback working', function (subtype: string, _fallback: string) {
  const out = ctx(this).sdkOut ?? "";
  if (out.includes(`subtype: "${subtype}"`) || out.includes(`"subtype":"${subtype}"`)) return;
  assert.match(spikeText(), /\*\*CLI fallback\.\*\*[^\n]*\bworks\b/, `no "${subtype}" result, and the spike record shows no working CLI fallback:\n${out.slice(-800)}`);
});

Then("it states whether bubblewrap starts in a local cell container", function () {
  const text = (this as { lastText?: string | null }).lastText;
  assert.ok(text, "the spike record is missing");
  assert.match(text, /\*\*Bubblewrap\.\*\*[^\n]*\b(starts|doesn't start)\b/);
});

Then("it states whether GitHub lets the App's bot be assigned to an issue", function () {
  const text = (this as { lastText?: string | null }).lastText;
  assert.ok(text, "the spike record is missing");
  assert.match(text, /\*\*Bot assignment\.\*\*[^\n]*\b(accepted|refused)\b/);
});
