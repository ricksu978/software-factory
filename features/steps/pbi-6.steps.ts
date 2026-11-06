import { After, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Steps record what they observe and assert only in Then, so a missing AppHost or image shows as red, not as a crash.
const repo = process.cwd();
const control = "http://localhost:7400";
const cellControl = "http://host.docker.internal:7400";
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

function sh(command: string, input?: string): { status: number | null; out: string } {
  const r = spawnSync(command, { cwd: repo, shell: true, encoding: "utf8", input });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

async function get(path: string): Promise<{ status: number; body: string } | null> {
  try {
    const r = await fetch(`${control}${path}`, { signal: AbortSignal.timeout(5_000) });
    return { status: r.status, body: await r.text() };
  } catch {
    return null;
  }
}

async function startAspire(c: Ctx): Promise<void> {
  c.started = true;
  sh("aspire start --non-interactive --nologo");
  const waited = sh("aspire wait control --status up --timeout 300 --non-interactive --nologo");
  c.up = waited.status === 0 && (await get("/")) !== null;
}

function stopAspire(): void {
  sh("aspire stop --non-interactive --nologo");
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

When("I start {string} and wait until the control resource answers on port {int}", long, async function (_cmd: string, _port: number) {
  await startAspire(ctx(this));
});

Then("the {string} and {string} containers are running, each with a data volume", function (a: string, b: string) {
  assert.ok(ctx(this).up, "the AppHost never came up");
  for (const name of [a, b]) {
    const ids = sh(`docker ps --filter "name=${name}" --format "{{.ID}}"`).out.split("\n").filter(Boolean);
    assert.ok(ids.length > 0, `no running container named like "${name}"`);
    const mounts = sh(`docker inspect --format "{{range .Mounts}}{{.Type}} {{end}}" ${ids[0]}`).out;
    assert.match(mounts, /volume/, `container "${name}" has no data volume`);
  }
});

Then("the {string} resource has exited with code {int}", function (resource: string, code: number) {
  assert.ok(ctx(this).up, "the AppHost never came up");
  const r = sh(`aspire describe ${resource} --format Json --non-interactive --nologo`);
  let doc: unknown = null;
  try {
    doc = JSON.parse(r.out.slice(r.out.indexOf("{")));
  } catch {
    assert.fail(`aspire describe gave no JSON:\n${r.out}`);
  }
  assert.equal(findKey(doc, /^exit_?code$/i), code, `exit code of "${resource}" in:\n${r.out}`);
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
