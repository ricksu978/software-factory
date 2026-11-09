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
  const item = async (source: string, stored: string | null = null) =>
    (await db.pool.query<{ id: string }>("insert into item (source_id, external_id, title, state, repo) values ($1, '131', 't', 'Queued', $2) returning id", [source, stored])).rows[0].id;
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

  test("an item with no run takes the repo stored at intake, not its board's", async () => {
    const id = await item(await board({ "acme/widgets": widgets }), "acme/gadgets");
    assert.equal((await issueRepos(db.pool, [id])).get(id), "acme/gadgets");
  });

  test("an item's run names its repo, over the stored one", async () => {
    const id = await item(await board({ "acme/widgets": widgets, "acme/gadgets": gadgets }), "acme/widgets");
    await run(id, gadgets);
    assert.equal((await issueRepos(db.pool, [id])).get(id), "acme/gadgets");
  });

  test("names no repo when none is stored and no run names one, even on a board that maps to one repo", async () => {
    const one = await item(await board({ "acme/widgets": widgets }));
    const several = await item(await board({ "acme/widgets": widgets, "acme/gadgets": gadgets }));
    await run(several, null);
    const got = await issueRepos(db.pool, [one, several]);
    assert.equal(got.get(one), null);
    assert.equal(got.get(several), null);
  });

  test("names no repo for a stored repo that isn't owner/name", async () => {
    const id = await item(await board({}), "acme/widgets/issues");
    assert.equal((await issueRepos(db.pool, [id])).get(id), null);
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
