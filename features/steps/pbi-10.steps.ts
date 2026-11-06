import { Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The fake loads lazily, so while it doesn't exist every scenario fails on its Then instead of crashing the run.
const repo = process.cwd();

type Item = { labels: string[] };
type Fake = {
  adapter: {
    comment(externalId: string, body: string, dedupeKey: string): Promise<void>;
    claim(externalId: string): Promise<void>;
    release(externalId: string): Promise<void>;
    getItem(externalId: string): Promise<Item | null>;
  };
  seed(item: Partial<Item>): Promise<string>;
  comments(externalId: string): Promise<string[]>;
};
type Ctx = { fake?: Fake; id?: string; out?: string; status?: number | null };

function ctx(world: object): Ctx {
  const w = world as { pbi10?: Ctx };
  w.pbi10 ??= {};
  return w.pbi10;
}

async function fakeBacklog(): Promise<Fake | null> {
  const file = join(repo, "src", "adapters", "fake.ts");
  if (!existsSync(file)) return null;
  const mod = (await import(pathToFileURL(file).href)) as { fakeBacklog?: () => Fake };
  return mod.fakeBacklog ? mod.fakeBacklog() : null;
}

function seeded(c: Ctx): { fake: Fake; id: string } {
  assert.ok(c.fake && c.id, "src/adapters/fake.ts doesn't export fakeBacklog");
  return { fake: c.fake, id: c.id };
}

async function labels(c: Ctx): Promise<string[]> {
  const { fake, id } = seeded(c);
  const item = await fake.adapter.getItem(id);
  assert.ok(item, "getItem returned null for the seeded item");
  return item.labels;
}

When("I run the shared contract suite against the fake adapter", function () {
  const c = ctx(this);
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", join("src", "adapters", "fake.test.ts")], { cwd: repo, encoding: "utf8" });
  c.status = r.status;
  c.out = `${r.stdout}${r.stderr}`;
});

Then("every contract case passes", function () {
  const out = ctx(this).out ?? "";
  assert.equal(ctx(this).status, 0, out);
  assert.match(out, /^# fail 0$/m, out);
  assert.doesNotMatch(out, /^# pass 0$/m, `no test passed:\n${out}`);
});

Then("the suite ran these cases:", function (table: { hashes(): { case: string }[] }) {
  const out = ctx(this).out ?? "";
  for (const { case: name } of table.hashes()) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(out, new RegExp(`^\\s*ok \\d+ - ${escaped}$`, "m"), `case not run or not passing: ${name}`);
  }
});

Given("a fake backlog with an open item labelled {string}", async function (label: string) {
  const c = ctx(this);
  const fake = await fakeBacklog();
  if (!fake) return;
  c.fake = fake;
  c.id = await fake.seed({ labels: [label] });
});

When("the factory comments {string} on the item with dedupe key {string}", async function (body: string, key: string) {
  const c = ctx(this);
  if (c.fake && c.id) await c.fake.adapter.comment(c.id, body, key);
});

Then("the item has exactly {int} comment(s)", async function (n: number) {
  const { fake, id } = seeded(ctx(this));
  assert.equal((await fake.comments(id)).length, n);
});

When("the factory claims the item", async function () {
  const c = ctx(this);
  if (c.fake && c.id) await c.fake.adapter.claim(c.id);
});

When("the factory releases the item", async function () {
  const c = ctx(this);
  if (c.fake && c.id) await c.fake.adapter.release(c.id);
});

Then("the item read back carries the label {string}", async function (label: string) {
  assert.ok((await labels(ctx(this))).includes(label), `no label ${label}`);
});

Then("the item read back doesn't carry the label {string}", async function (label: string) {
  assert.ok(!(await labels(ctx(this))).includes(label), `label ${label} is still there`);
});
