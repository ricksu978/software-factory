// Step definitions for features/pbi-325-failed-token-save-keeps-rotated-refresh-token.feature.
//
// The scenarios run the BFF, the test sign-in provider and the stand-in API as PBI 289's do, and reuse its steps and
// PBI 288's: signing in, moving alice's access token's expiry, calling /bff/v1 and reading the stored refresh token.
// The provider (features/fixtures/pbi-288-provider.ts) rotates refresh tokens: a refresh retires the refresh token it
// was given, and refuses it from then on.
// The session store fails a save in Postgres. A trigger on the session table refuses an update that changes alice's
// tokens, the save a refresh makes, while a count of refusals lasts. The count is a sequence, so a refusal, which rolls
// back its own statement, still counts. Updates that only move timestamps, such as a lookup marking the session seen or
// a step moving the token's expiry, pass. "The session store answers again" drops the trigger.
// The BFF's log is its stdout and stderr, as PBI 288's steps collect them. A step that arranges a failing save notes
// how much log there was, so the log Thens read only what the BFF wrote after it.
// Every step asserts something. A Given asserts only what it arranges, so a scenario can't pass on a precondition that
// never held.
import { After, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { ApiCall } from "../fixtures/pbi-289-api.ts";
import { bffHost, bffUrl, browser, ctx as shared, providerOf, sessionCookie, type Seen } from "./pbi-288.steps.ts";
import { ctx as forwarded } from "./pbi-289.steps.ts";
import { long, need } from "./pbi-8.steps.ts";

type Ctx = {
  /** Whether the failing-save trigger is on the session table. */
  failing?: boolean;
  /** How long the BFF's log was when the failing save was arranged. */
  logFrom?: number;
};

function ctx(world: object): Ctx {
  const w = world as { pbi325?: Ctx };
  w.pbi325 ??= {};
  return w.pbi325;
}

const pool = () => need().pool;
/** The most refusals a count can hold, for "every save". */
const EVERY = "9223372036854775807";

async function heal(): Promise<void> {
  await pool().query(`
    drop trigger if exists pbi325_refuse on session;
    drop function if exists pbi325_refuse();
    drop table if exists pbi325_fail;
    drop sequence if exists pbi325_saves;
  `);
}

After({ tags: "@pbi-325", ...long }, async function () {
  if (ctx(this).failing) await heal();
});

/** The hash of the session cookie alice's browser holds, which keys her session row. */
async function aliceHash(world: object): Promise<string> {
  const name = await sessionCookie();
  const id = browser(shared(world), 1).cookies(bffHost).get(name);
  assert.ok(id, `alice's browser holds no ${name} cookie`);
  return createHash("sha256").update(id).digest("hex");
}

/** Makes the session store refuse the next `count` saves of alice's tokens. */
async function failSaves(world: object, count: string): Promise<void> {
  const hash = await aliceHash(world);
  await heal();
  await pool().query(`
    create sequence pbi325_saves;
    create table pbi325_fail (cookie_hash text primary key, failing bigint not null);
    create function pbi325_refuse() returns trigger language plpgsql security definer as $$
    declare f bigint;
    begin
      select failing into f from pbi325_fail where cookie_hash = new.cookie_hash;
      if f is not null and nextval('pbi325_saves') <= f then
        raise exception 'pbi325 refused this update';
      end if;
      return new;
    end $$;
    create trigger pbi325_refuse before update on session for each row
      when (old.access_token is distinct from new.access_token
        or old.refresh_token_encrypted is distinct from new.refresh_token_encrypted)
      execute function pbi325_refuse();
  `);
  ctx(world).failing = true;
  await pool().query("insert into pbi325_fail (cookie_hash, failing) values ($1, $2)", [hash, count]);
  const r = await pool().query<{ failing: string }>("select failing::text from pbi325_fail where cookie_hash = $1", [hash]);
  assert.equal(r.rows[0]?.failing, count, "the session store wasn't set to fail alice's saves");
  const t = await pool().query("select 1 from pg_trigger where tgname = 'pbi325_refuse' and not tgisinternal");
  assert.equal(t.rowCount, 1, "the failing-save trigger isn't on the session table");
  const b = shared(world).bff;
  assert.ok(b, "the BFF isn't running");
  ctx(world).logFrom = b.out.length;
}

// ---- The provider ----

Given("the provider rotates refresh tokens, refusing a refresh token once it has been replaced", function () {
  const p = providerOf(shared(this));
  p.rotates = true;
  assert.equal(p.rotates, true, "the test provider didn't keep the setting");
});

Given("the provider will issue the access token {string}, lasting {int} minutes, and the refresh token {string} on the next refresh", function (access: string, minutes: number, refresh: string) {
  const p = providerOf(shared(this));
  p.nextRefresh.accessToken = access;
  p.nextRefresh.expiresIn = minutes * 60;
  p.nextRefresh.refreshToken = refresh;
  assert.deepEqual(
    { ...p.nextRefresh },
    { accessToken: access, expiresIn: minutes * 60, refreshToken: refresh },
    "the test provider didn't keep the next refresh's tokens",
  );
});

Given("the provider will issue the access token {string} and the refresh token {string} on the next refresh", function (access: string, refresh: string) {
  const p = providerOf(shared(this));
  p.nextRefresh.accessToken = access;
  p.nextRefresh.refreshToken = refresh;
  assert.equal(p.nextRefresh.accessToken, access, "the test provider didn't keep the next refresh's access token");
  assert.equal(p.nextRefresh.refreshToken, refresh, "the test provider didn't keep the next refresh's refresh token");
});

// ---- The session store ----

Given("the session store will fail every save of alice's tokens", long, async function () {
  await failSaves(this, EVERY);
});

Given("the session store will fail the next save of alice's tokens", long, async function () {
  await failSaves(this, "1");
});

Given("the session store will fail the next {int} saves of alice's tokens", long, async function (n: number) {
  await failSaves(this, String(n));
});

When("the session store answers again", long, async function () {
  await heal();
  const t = await pool().query("select 1 from pg_trigger where tgname = 'pbi325_refuse'");
  assert.equal(t.rowCount, 0, "the failing-save trigger is still on the session table");
});

// ---- Calling the BFF ----

async function aliceCalls(world: object, method: string, path: string): Promise<Seen> {
  const seen = await browser(shared(world), 1).request(bffUrl(shared(world), path), { method });
  assert.notEqual(seen.status, 0, `the BFF didn't answer ${method} ${path}: ${seen.body}`);
  forwarded(world).last = seen;
  return seen;
}

When("alice's browser calls {word} {string} {int} times", long, async function (method: string, path: string, n: number) {
  for (let i = 0; i < n; i++) await aliceCalls(this, method, path);
});

Given("alice's browser has called {word} {string}", long, async function (method: string, path: string) {
  await aliceCalls(this, method, path);
});

Given("alice's browser has called {word} {string} again", long, async function (method: string, path: string) {
  await aliceCalls(this, method, path);
});

// ---- What the BFF answered and logged ----

function last(world: object): Seen {
  const l = forwarded(world).last;
  assert.ok(l, "no browser called the BFF");
  return l;
}

const shown = (l: Seen) => `${l.method} ${l.url.pathname} answered ${l.status}: ${l.body}`;

Then("the BFF answers with a server error", function () {
  const l = last(this);
  assert.ok(l.status >= 500 && l.status < 600, shown(l));
});

Then("the error says the session store couldn't save the session", function () {
  const l = last(this);
  assert.match(l.body, /session store/i, `the error doesn't name the session store: ${shown(l)}`);
  assert.match(l.body, /sav(e|ed|ing)\b/i, `the error doesn't say a save failed: ${shown(l)}`);
});

Then("the error doesn't mention the sign-in provider", function () {
  const l = last(this);
  assert.doesNotMatch(l.body, /provider|sign-in|sign in/i, `the error mentions the sign-in provider: ${shown(l)}`);
});

Then("the BFF doesn't clear alice's session cookie", long, async function () {
  const l = last(this);
  const name = await sessionCookie();
  const touched = l.setCookies.filter((k) => k.name === name);
  assert.equal(touched.length, 0, `the BFF set ${name} on its answer: ${JSON.stringify(touched)}`);
  assert.ok(browser(shared(this), 1).cookies(bffHost).has(name), `alice's browser no longer holds ${name}`);
});

/** The lines the BFF logged after the failing save was arranged. */
function logSince(world: object): string[] {
  const b = shared(world).bff;
  assert.ok(b, "the BFF isn't running");
  const from = ctx(world).logFrom;
  assert.ok(from !== undefined, "no failing save was arranged");
  return b.out.slice(from).split("\n").filter((x) => x.trim());
}

/** The lines that record the session store failing to save. */
function storeLines(world: object): string[] {
  return logSince(world).filter((x) => /session store/i.test(x) && /sav(e|ed|ing)\b/i.test(x));
}

Then("the BFF's log records that the session store couldn't save alice's refreshed tokens", function () {
  const lines = storeLines(this);
  assert.ok(lines.length > 0, `the BFF logged no failed save by the session store: ${JSON.stringify(logSince(this))}`);
});

Then("that log entry doesn't say the sign-in provider didn't answer", function () {
  const lines = storeLines(this);
  assert.ok(lines.length > 0, `the BFF logged no failed save by the session store: ${JSON.stringify(logSince(this))}`);
  for (const x of lines) assert.doesNotMatch(x, /provider/i, `the log entry blames the sign-in provider: ${x}`);
});

Then("the BFF's last answer is the stand-in API's answer", function () {
  const l = last(this);
  assert.equal(l.status, 200, shown(l));
  assert.equal(l.body, "{}", shown(l));
  const api = forwarded(this).api;
  assert.ok(api && api.calls.length > 0, "the API received no call");
});

Then("the API's last call carried {string} as a bearer token", function (token: string) {
  const api = forwarded(this).api;
  assert.ok(api, "no stand-in API is running");
  const k: ApiCall | undefined = api.calls.at(-1);
  assert.ok(k, "the API received no call");
  const got = /^Bearer\s+(\S+)$/i.exec(k.headers.authorization ?? "")?.[1];
  assert.equal(got, token, `${k.method} ${k.url} didn't carry ${JSON.stringify(token)} as a bearer token`);
});

// ---- What the provider received ----

function refreshes(world: object) {
  return providerOf(shared(world)).tokenRequests.filter((t) => t.form.grant_type === "refresh_token");
}

const listed = (world: object) => JSON.stringify(refreshes(world).map((r) => `${r.form.refresh_token} → ${r.status}`));

Then("the provider received one refresh with {string}", function (token: string) {
  const n = refreshes(this).filter((r) => r.form.refresh_token === token).length;
  assert.equal(n, 1, `the provider received ${n} refreshes with ${token}: ${listed(this)}`);
});

Then("the provider received a refresh with {string}", function (token: string) {
  assert.ok(refreshes(this).some((r) => r.form.refresh_token === token), `no refresh carried ${token}: ${listed(this)}`);
});

Then("the provider refused no refresh", function () {
  const refused = refreshes(this).filter((r) => r.status !== 200);
  assert.equal(refused.length, 0, `the provider refused ${refused.length} refreshes: ${listed(this)}`);
});

Then("alice hasn't signed in again at the provider", function () {
  const p = providerOf(shared(this));
  const signIns = p.issued.filter((i) => i.user === "alice" && i.grant === "authorization_code");
  assert.equal(signIns.length, 1, `the provider signed alice in ${signIns.length} times`);
  assert.equal(p.authorizations.length, 1, `the provider was asked to sign in ${p.authorizations.length} times`);
});
