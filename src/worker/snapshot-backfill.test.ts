import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { fakeBacklog, fakeRepoHost } from "../adapters/fake.ts";
import { dbTest, startTestDb } from "../store/test-db.ts";
import { backfillSnapshots } from "./snapshot-backfill.ts";

const repo = "acme/shop";

describe("snapshot backfill (PBI 224)", dbTest, () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let board: ReturnType<typeof fakeBacklog>;
  let host: ReturnType<typeof fakeRepoHost>;
  let sourceId: string;
  let repoId: string;

  before(async () => {
    db = await startTestDb();
  });
  after(async () => {
    await db.stop();
  });

  beforeEach(async () => {
    board = fakeBacklog();
    host = fakeRepoHost();
    await db.pool.query("truncate item, backlog_source, repo cascade");
    sourceId = (await db.pool.query<{ id: string }>("insert into backlog_source (adapter, url) values ('fake', 'test:backfill') returning id")).rows[0].id;
    repoId = (await db.pool.query<{ id: string }>("insert into repo (host_adapter, url, trusted_bot) values ('github', $1, 'factory[bot]') returning id", [`https://github.com/${repo}`])).rows[0].id;
  });

  async function run(externalId: string, sha: string | null, files: string[] | null): Promise<string> {
    const item = (await db.pool.query<{ id: string }>(
      "insert into item (source_id, external_id, title, state) values ($1, $2, $2, 'SignOff') returning id", [sourceId, externalId])).rows[0].id;
    return (await db.pool.query<{ id: string }>(
      `insert into run (item_id, run_number, next_stage, repo_id, scenarios_sha, locked_files) values ($1, 1, 'sign-off', $2, $3, $4) returning id`,
      [item, repoId, sha, files])).rows[0].id;
  }

  const backfill = () => backfillSnapshots({ pool: db.pool, repoHost: host, backlogFor: () => board.adapter });
  const stored = async (runId: string) => ({
    criteria: (await db.pool.query("select acceptance_criteria from run where id = $1", [runId])).rows[0].acceptance_criteria,
    files: (await db.pool.query("select sha, path, text from run_file where run_id = $1 order by path", [runId])).rows,
  });

  test("fills a run with a scenarios sha and no files, once, and leaves a run with no sha", async () => {
    await board.seed({ externalId: "1", acceptanceCriteria: ["pays", "declines"] });
    await board.seed({ externalId: "2" });
    host.files.set(`${repo}@abc:features/b.feature`, "B");
    host.files.set(`${repo}@abc:features/a.feature`, "A");
    const filled = await run("1", "abc", ["features/b.feature", "features/a.feature"]);
    const none = await run("2", null, null);

    assert.deepEqual(await backfill(), { filled: [filled], unfilled: [] });
    assert.deepEqual(await stored(filled), {
      criteria: ["pays", "declines"],
      files: [{ sha: "abc", path: "features/a.feature", text: "A" }, { sha: "abc", path: "features/b.feature", text: "B" }],
    });
    assert.deepEqual(await stored(none), { criteria: null, files: [] });

    host.files.set(`${repo}@abc:features/a.feature`, "A, edited");
    assert.deepEqual(await backfill(), { filled: [], unfilled: [] });
    assert.equal((await stored(filled)).files[0].text, "A");
  });

  test("reports a run it couldn't read as unfilled, stores nothing for it, and still fills the others", async () => {
    await board.seed({ externalId: "1" });
    await board.seed({ externalId: "2" });
    host.files.set(`${repo}@abc:features/a.feature`, "A");
    const good = await run("1", "abc", ["features/a.feature"]);
    const missingFile = await run("2", "abc", ["features/gone.feature"]);
    const noItem = await run("3", "abc", ["features/a.feature"]);

    const report = await backfill();
    assert.deepEqual(report.filled, [good]);
    assert.deepEqual(report.unfilled.map((u) => u.runId).sort(), [missingFile, noItem].sort());
    assert.match(report.unfilled.find((u) => u.runId === missingFile)!.reason, /holds no features\/gone\.feature at abc/);
    assert.deepEqual(await stored(missingFile), { criteria: null, files: [] });
    assert.deepEqual(await stored(noItem), { criteria: null, files: [] });
  });
});
