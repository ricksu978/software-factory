import { Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { load, long, need, testDb } from "./pbi-8.steps.ts";

// Steps record and Thens assert. Modules load lazily, so while they don't exist every scenario fails on its
// Then. The @db scenarios share PBI 4's database. A delivery's event is found by the delivery id in its payload.
const repo = process.cwd();

type Headers = Record<string, string>;
type Webhook = {
  handleWebhook: (deps: { pool: unknown; secret: string }, req: { headers: Headers; rawBody: Buffer }) => Promise<{ status: number }>;
};
type Request = { route: string; params: Record<string, unknown> };
type RepoHostMod = {
  githubRepoHost: (app: unknown, installationId: number) => { cellToken(repo: string): Promise<{ token: string; expiresAt: string }> };
};
type Ctx = { secret?: string; statuses: number[]; ran: boolean; requests: Request[]; app?: unknown };

function ctx(world: object): Ctx {
  const w = world as { pbi11?: Ctx };
  w.pbi11 ??= { statuses: [], ran: false, requests: [] };
  return w.pbi11;
}

const commentBody = (delivery: string) =>
  Buffer.from(JSON.stringify({ action: "created", issue: { number: 11 }, comment: { id: delivery, body: "hello", user: { login: "someone" } } }));
const sign = (alg: "sha256" | "sha1", secret: string, body: Buffer) => `${alg}=${createHmac(alg, secret).update(body).digest("hex")}`;

async function deliver(c: Ctx, delivery: string, body: Buffer, signature: string | null): Promise<void> {
  const mod = await load<Webhook>("src/watcher/webhook.ts");
  const d = await testDb();
  if (!mod || !d) return;
  c.ran = true;
  const headers: Headers = { "x-github-delivery": delivery, "x-github-event": "issue_comment", "content-type": "application/json" };
  if (signature) headers["x-hub-signature-256"] = signature;
  c.statuses.push((await mod.handleWebhook({ pool: d.pool, secret: c.secret ?? "" }, { headers, rawBody: body })).status);
}

function ran(c: Ctx): void {
  assert.ok(c.ran, "src/watcher/webhook.ts doesn't exist");
}

async function stored(delivery: string): Promise<{ deliveries: number; events: number }> {
  const pool = need().pool;
  const deliveries = await pool.query("select 1 from webhook_delivery where id = $1", [delivery]);
  const events = await pool.query("select 1 from event where payload->>'deliveryId' = $1", [delivery]);
  return { deliveries: deliveries.rowCount ?? 0, events: events.rowCount ?? 0 };
}

Given("the webhook secret is {string}", long, async function (secret: string) {
  ctx(this).secret = secret;
  await testDb();
});

When("GitHub delivers an issue comment with delivery id {string}, signed with {string}", long, async function (delivery: string, secret: string) {
  const body = commentBody(delivery);
  await deliver(ctx(this), delivery, body, sign("sha256", secret, body));
});

When("GitHub delivers an issue comment with delivery id {string} and a signature from {string} over a body changed after", long, async function (delivery: string, secret: string) {
  const body = commentBody(delivery);
  const signature = sign("sha256", secret, body);
  const changed = Buffer.from(body);
  changed[changed.length - 2] ^= 1;
  await deliver(ctx(this), delivery, changed, signature);
});

When("GitHub delivers an issue comment with delivery id {string} and no signature header", long, async function (delivery: string) {
  await deliver(ctx(this), delivery, commentBody(delivery), null);
});

When("GitHub delivers an issue comment with delivery id {string} and a sha1 signature from {string}", long, async function (delivery: string, secret: string) {
  const body = commentBody(delivery);
  await deliver(ctx(this), delivery, body, sign("sha1", secret, body));
});

Then("the intake answers {int}", function (status: number) {
  const c = ctx(this);
  ran(c);
  assert.deepEqual(c.statuses, [status]);
});

Then("the intake answers {int} the first time and {int} the second time", function (first: number, second: number) {
  const c = ctx(this);
  ran(c);
  assert.deepEqual(c.statuses, [first, second]);
});

Then("{int} event is stored for delivery {string}", async function (n: number, delivery: string) {
  ran(ctx(this));
  const s = await stored(delivery);
  assert.equal(s.deliveries, 1, "no webhook_delivery row");
  assert.equal(s.events, n);
});

Then("nothing is stored for delivery {string}", async function (delivery: string) {
  ran(ctx(this));
  assert.deepEqual(await stored(delivery), { deliveries: 0, events: 0 });
});

// The plan asserts cellToken against a stubbed app.octokit.request, so no token is ever minted here.
Given("a GitHub App whose token requests are recorded", function () {
  const c = ctx(this);
  c.app = {
    octokit: {
      request: async (route: string, params: Record<string, unknown> = {}) => {
        c.requests.push({ route, params });
        return { data: { token: "ghs_test", expires_at: "2026-11-06T10:00:00Z" } };
      },
    },
  };
});

When("the factory asks for a cell token for the repo {string}", async function (fullName: string) {
  const c = ctx(this);
  const mod = await load<RepoHostMod>("src/adapters/github/repo-host.ts");
  if (!mod) return;
  c.ran = true;
  await mod.githubRepoHost(c.app, 1).cellToken(fullName);
});

function tokenRequest(c: Ctx): Request {
  assert.ok(c.ran, "src/adapters/github/repo-host.ts doesn't exist");
  const r = c.requests.filter((x) => x.route.includes("/access_tokens"));
  assert.equal(r.length, 1, `expected one installation token request, got: ${JSON.stringify(c.requests)}`);
  return r[0];
}

Then("the token request names only the repo {string}", function (fullName: string) {
  const repos = tokenRequest(ctx(this)).params.repositories as unknown[] | undefined;
  assert.ok(Array.isArray(repos) && repos.length === 1, `repositories must name one repo: ${JSON.stringify(repos)}`);
  // GitHub takes repository names here; the owner is already fixed by the installation.
  assert.ok(repos[0] === fullName.split("/")[1] || repos[0] === fullName, `wrong repo: ${repos[0]}`);
});

Then("the token request asks for exactly these permissions:", function (table: { hashes(): { permission: string; access: string }[] }) {
  const want = Object.fromEntries(table.hashes().map((r) => [r.permission, r.access]));
  assert.deepEqual(tokenRequest(ctx(this)).params.permissions, want);
});

// AC-4 runs the GitHub contract test, and reuses PBI 6's "every contract case passes" and "the suite ran these
// cases" Thens, which read world.pbi10.
Given("a sandbox Project on the owner's personal account", function () {
  // The contract test reads the project and token from its environment, so nothing is set up here.
});

When("I run the shared contract suite against the GitHub backlog adapter", long, function () {
  const w = this as { pbi10?: { out?: string; status?: number | null } };
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", join("src", "adapters", "github", "backlog.contract.test.ts")], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, FACTORY_GH_CONTRACT: "1" },
    timeout: 280_000,
  });
  w.pbi10 = { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
});
