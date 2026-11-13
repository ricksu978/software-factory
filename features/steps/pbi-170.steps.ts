// Step definitions for features/pbi-170-seed-owner-issuer.feature. They run `migrate-cli.ts seed-owner` through PBI
// 89's When and its exit steps, on PBI 4's shared test database, and read the "user" table directly.
import { Before, Given, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { ctx } from "./pbi-89.steps.ts";
import { long, need, testDb } from "./pbi-8.steps.ts";

const pool = () => need().pool;

Before({ tags: "@pbi-170 and @db", ...long }, async function () {
  const d = await testDb();
  if (!d) return;
  await d.pool.query(`truncate "user" cascade`);
});

// The same words are a Given in one scenario and a Then in another. Before seed-owner runs they add the user; after
// it runs they check the user.
Given("the user {string} from the issuer {string} is a(n) {word}", async function (subject: string, issuer: string, role: string) {
  if (!ctx(this).started) {
    await pool().query(`insert into "user" (issuer, subject, role) values ($1, $2, $3)`, [issuer, subject, role]);
    return;
  }
  const rows = (await pool().query(`select role from "user" where subject = $1 and issuer = $2`, [subject, issuer])).rows;
  assert.deepEqual(rows, [{ role }]);
});

// "the user {string} loads with the issuer {string} and no provider" is PBI 117's step, which falls back to this
// shared database.

Then("the user {string} is an owner", async function (subject: string) {
  const rows = (await pool().query(`select role from "user" where subject = $1`, [subject])).rows;
  assert.deepEqual(rows, [{ role: "owner" }]);
});

Then("exactly one user {string} from the issuer {string} exists", async function (subject: string, issuer: string) {
  const r = await pool().query(`select 1 from "user" where subject = $1 and issuer = $2`, [subject, issuer]);
  assert.equal(r.rowCount, 1);
});

Then("there are two users {string}, one from each issuer, and both are owners", async function (subject: string) {
  const rows = (await pool().query(`select issuer, role from "user" where subject = $1 order by issuer`, [subject])).rows;
  assert.deepEqual(rows, [
    { issuer: "https://id.example.com/realms/factory", role: "owner" },
    { issuer: "https://login.example.org", role: "owner" },
  ]);
});

Then("it exits {int} naming {string} and {string}", function (status: number, first: string, second: string) {
  const r = ctx(this).started!;
  assert.equal(r.status, status, r.stderr);
  assert.ok(r.stderr.includes(first) && r.stderr.includes(second), r.stderr);
});

Then("it exits {int} saying the issuer must be a URL", function (status: number) {
  const r = ctx(this).started!;
  assert.equal(r.status, status, r.stderr);
  assert.match(r.stderr, /issuer.*must be a URL/i);
});

Then("no user from the issuer {string} exists", async function (issuer: string) {
  assert.equal((await pool().query(`select 1 from "user" where issuer = $1`, [issuer])).rowCount, 0);
});
