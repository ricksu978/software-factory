import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { githubRepo, issueRepos } from "./issues.ts";
import { dbTest, startTestDb } from "./test-db.ts";

describe("githubRepo", () => {
  test("names a GitHub repo row as owner/name", () => {
    assert.equal(githubRepo("github", "https://github.com/acme/widgets"), "acme/widgets");
    assert.equal(githubRepo("github", "https://github.com/acme/widgets/"), "acme/widgets");
  });

  test("names no repo for another host or a url that isn't one GitHub repo", () => {
    assert.equal(githubRepo("gitlab", "https://gitlab.example.com/acme/widgets"), null);
    assert.equal(githubRepo("github", "https://gitlab.example.com/acme/widgets"), null);
    assert.equal(githubRepo("github", "https://github.com/acme"), null);
    assert.equal(githubRepo("github", "https://github.com/acme/widgets/issues"), null);
    assert.equal(githubRepo("github", "not a url"), null);
  });
});

describe("issueRepos", dbTest, () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  const repo = async (url: string, host = "github") =>
    (await db.pool.query<{ id: string }>("insert into repo (host_adapter, url) values ($1, $2) returning id", [host, url])).rows[0].id;
  const board = async (map: Record<string, string>) =>
    (await db.pool.query<{ id: string }>("insert into backlog_source (adapter, url, repo_map) values ('github', gen_random_uuid()::text, $1) returning id", [JSON.stringify(map)])).rows[0].id;
  const item = async (source: string) =>
    (await db.pool.query<{ id: string }>("insert into item (source_id, external_id, title, state) values ($1, '131', 't', 'Queued') returning id", [source])).rows[0].id;
  const run = (itemId: string, repoId: string | null) => db.pool.query("insert into run (item_id, repo_id) values ($1, $2)", [itemId, repoId]);

  let widgets: string;
  let gadgets: string;
  let gitlab: string;
  before(async () => {
    db = await startTestDb();
    widgets = await repo("https://github.com/acme/widgets");
    gadgets = await repo("https://github.com/acme/gadgets");
    gitlab = await repo("https://gitlab.example.com/acme/widgets", "gitlab");
  });
  after(async () => {
    await db?.stop();
  });

  test("an item with no run takes the one repo its board maps to", async () => {
    const id = await item(await board({ "acme/widgets": widgets }));
    assert.equal((await issueRepos(db.pool, [id])).get(id), "acme/widgets");
  });

  test("an item's run names its repo, over its board's", async () => {
    const id = await item(await board({ "acme/widgets": widgets, "acme/gadgets": gadgets }));
    await run(id, gadgets);
    assert.equal((await issueRepos(db.pool, [id])).get(id), "acme/gadgets");
  });

  test("names no repo when the board maps to none or several and no run names one", async () => {
    const none = await item(await board({}));
    const several = await item(await board({ "acme/widgets": widgets, "acme/gadgets": gadgets }));
    await run(several, null);
    const got = await issueRepos(db.pool, [none, several]);
    assert.equal(got.get(none), null);
    assert.equal(got.get(several), null);
  });

  test("names no repo when the run's repo isn't on GitHub", async () => {
    const id = await item(await board({ "acme/widgets": widgets }));
    await run(id, gitlab);
    assert.equal((await issueRepos(db.pool, [id])).get(id), null);
  });

  test("asks nothing for no items", async () => {
    assert.equal((await issueRepos(db.pool, [])).size, 0);
  });
});
