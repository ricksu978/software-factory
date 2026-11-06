import { After, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Steps record and Thens assert. The gateway module loads lazily, so while it doesn't exist every scenario fails
// on its Then. The @local cells start from cellModelEnv, the function Task 13's launcher will use, so a cell
// that never had the owner's token can't make AC-3 pass on its own.
const repo = process.cwd();
const long = { timeout: 300_000 };
const network = "pbi33-gateway";
const gatewayName = "pbi33-gateway";
const standIn = "run-credential-ok";

type Gateway = {
  startModelGateway: (cfg: { port: number; upstream: string; ownerToken: () => string; verify: (credential: string) => boolean | Promise<boolean> }) => Promise<Server>;
  cellModelEnv: (cfg: { gatewayUrl: string; credential: string }) => Record<string, string>;
};
type Seen = { headers: IncomingHttpHeaders; body: string };
type Ctx = { gateway?: Server; upstream?: Server; seen: Seen[]; status?: number; body?: string; out?: string; containers: boolean };

function ctx(world: object): Ctx {
  const w = world as { pbi33?: Ctx };
  w.pbi33 ??= { seen: [], containers: false };
  return w.pbi33;
}

async function load(): Promise<Gateway | null> {
  const file = join(repo, "src", "control", "model-gateway.ts");
  return existsSync(file) ? ((await import(pathToFileURL(file).href)) as Gateway) : null;
}

function sh(args: string[], env?: NodeJS.ProcessEnv): { status: number | null; out: string } {
  const r = spawnSync("docker", args, { encoding: "utf8", env: env ?? process.env });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

After({ tags: "@pbi-33" }, async function () {
  const c = ctx(this);
  await new Promise((r) => (c.gateway ? c.gateway.close(r) : r(undefined)));
  await new Promise((r) => (c.upstream ? c.upstream.close(r) : r(undefined)));
  if (c.containers) {
    sh(["rm", "-f", gatewayName]);
    sh(["network", "rm", network]);
  }
});

Given("a model gateway in front of a fake upstream, holding the owner token {string}", long, async function (owner: string) {
  const c = ctx(this);
  const mod = await load();
  if (!mod) return;
  c.upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      c.seen.push({ headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ reply: "from upstream" }));
    });
  });
  const upstreamPort = await listen(c.upstream);
  c.gateway = await mod.startModelGateway({ port: 0, upstream: `http://127.0.0.1:${upstreamPort}`, ownerToken: () => owner, verify: (cred) => cred === standIn });
});

async function send(c: Ctx, credential: string, beta?: string): Promise<void> {
  if (!c.gateway) return;
  const port = (c.gateway.address() as AddressInfo).port;
  const headers: Record<string, string> = { authorization: `Bearer sk-ant-oat01-${credential}`, "content-type": "application/json" };
  if (beta) headers["anthropic-beta"] = beta;
  const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: "POST", headers, body: JSON.stringify({ model: "x" }) });
  c.status = r.status;
  c.body = await r.text();
}

When("a cell sends a model request with a valid run credential and the header {string}", long, async function (header: string) {
  const [, value] = header.split(": ");
  await send(ctx(this), standIn, value);
});

When("a cell sends a model request with a run credential the factory didn't issue", long, async function () {
  await send(ctx(this), "forged-credential");
});

Then("the upstream receives the authorization {string}", function (auth: string) {
  const c = ctx(this);
  assert.ok(c.gateway, "src/control/model-gateway.ts doesn't exist");
  assert.equal(c.seen.length, 1, "the upstream got no request");
  assert.equal(c.seen[0].headers.authorization, auth);
});

Then("the upstream receives the header {string}", function (header: string) {
  const [name, value] = header.split(": ");
  assert.equal(ctx(this).seen[0]?.headers[name.toLowerCase()], value);
});

Then("the cell receives the upstream's reply", function () {
  const c = ctx(this);
  assert.equal(c.status, 200);
  assert.deepEqual(JSON.parse(c.body ?? "{}"), { reply: "from upstream" });
});

Then("the gateway answers {int}", function (status: number) {
  const c = ctx(this);
  assert.ok(c.gateway, "src/control/model-gateway.ts doesn't exist");
  assert.equal(c.status, status);
});

Then("the upstream receives no request", function () {
  assert.equal(ctx(this).seen.length, 0);
});

// Starts the real gateway module in a container on a private network, with the owner's token passed by name.
// Nothing is published to the host. The cell's environment comes from cellModelEnv.
async function runCell(c: Ctx, command: string[]): Promise<void> {
  const mod = await load();
  if (!mod) return;
  const owner = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  assert.ok(owner, "CLAUDE_CODE_OAUTH_TOKEN must hold the owner's token for this scenario");
  c.containers = true;
  sh(["network", "create", network]);
  const start = `import(${JSON.stringify("file:///app/src/control/model-gateway.ts")}).then((m) => m.startModelGateway({ port: 7499, upstream: "https://api.anthropic.com", ownerToken: () => process.env.OWNER_TOKEN, verify: (c) => c === ${JSON.stringify(standIn)} }))`;
  const gw = sh(
    ["run", "-d", "--name", gatewayName, "--network", network, "-e", "OWNER_TOKEN", "-v", `${join(repo, "src")}:/app/src:ro`, "factory-cell:local", "node", "-e", start],
    { ...process.env, OWNER_TOKEN: owner },
  );
  assert.equal(gw.status, 0, gw.out);
  await new Promise((r) => setTimeout(r, 2000));
  const env = mod.cellModelEnv({ gatewayUrl: `http://${gatewayName}:7499`, credential: standIn });
  const args = ["run", "--rm", "--network", network];
  for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
  // The owner's token must not reach the cell, so the cell's environment is built from scratch here.
  const r = spawnSync("docker", [...args, "factory-cell:local", ...command], { encoding: "utf8", env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
  c.out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
}

When("a cell container holding only a stand-in token runs {string} through the gateway", long, async function (script: string) {
  await runCell(ctx(this), ["node", `/app/${script}`]);
});

When("a cell container holding only a stand-in token lists its environment", long, async function () {
  await runCell(ctx(this), ["env"]);
});

Then("the cell's result has the subtype {string}", function (subtype: string) {
  const out = ctx(this).out;
  assert.ok(out, "no cell ran");
  assert.ok(out.includes(`"subtype":"${subtype}"`), `no ${subtype} result:\n${out.slice(-800)}`);
});

Then("no variable in it holds the owner's Claude token", function () {
  const out = ctx(this).out;
  assert.ok(out, "no cell ran");
  assert.match(out, /^ANTHROPIC_BASE_URL=/m, "the cell's environment doesn't point at the gateway");
  const owner = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "";
  assert.ok(owner.length > 20, "the owner's token isn't set, so this check would prove nothing");
  assert.ok(!out.includes(owner), "the owner's token is in the cell's environment");
});
