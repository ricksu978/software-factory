// GitHub webhook intake. Only a delivery GitHub signed with the shared secret gets in, and each delivery id is
// acted on once, so a redelivery never produces a second event (spec §10).
import { createHmac, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { botKey, loginKey, type FactoryWebhookEvent } from "../adapters/types.ts";
import { withTx } from "../store/db.ts";
import { appendEvent } from "../store/events.ts";
import { IllegalTransition, transitionItem } from "../store/items.ts";
import { CONSUMER, writeOutboxRows } from "../store/outbox.ts";

/** True only for `sha256=` plus the hex HMAC-SHA256 of the body. A `sha1=` header or no header is false. */
export function verifySignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  // An empty secret would accept anything signed with an empty key, so a missing secret refuses every delivery.
  if (!secret || !header?.startsWith("sha256=")) return false;
  const want = Buffer.from(`sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`);
  const got = Buffer.from(header);
  return got.length === want.length && timingSafeEqual(got, want);
}

export type WebhookDeps = {
  pool: pg.Pool;
  secret: string;
  parse: (headers: Record<string, string>, body: unknown) => FactoryWebhookEvent;
  /** Runs once a new `comment` event has committed, so /approve and /answer comments reach `applyComment` (Task 15). */
  onComment?: (e: Extract<FactoryWebhookEvent, { kind: "comment" }>) => Promise<unknown>;
};

/**
 * 401 for a bad signature, with nothing written. 400 for a signed body with no delivery id or no JSON. Otherwise the
 * delivery id, one `webhook` event and, for a comment, its outbox rows go in together: 204 the first time, 200 with no
 * event for a redelivery.
 */
export async function handleWebhook(deps: WebhookDeps, req: { headers: Record<string, string | undefined>; rawBody: Buffer }): Promise<{ status: 200 | 204 | 400 | 401 }> {
  const headers = Object.fromEntries(Object.entries(req.headers).filter((e): e is [string, string] => typeof e[1] === "string").map(([k, v]) => [k.toLowerCase(), v]));
  if (!verifySignature(deps.secret, req.rawBody, headers["x-hub-signature-256"])) return { status: 401 };
  const deliveryId = headers["x-github-delivery"];
  if (!deliveryId) return { status: 400 };
  let body: unknown;
  try {
    body = JSON.parse(req.rawBody.toString("utf8"));
  } catch {
    return { status: 400 };
  }
  const c = await deps.pool.connect();
  let event: FactoryWebhookEvent;
  try {
    await c.query("begin");
    const fresh = await c.query("insert into webhook_delivery (id) values ($1) on conflict (id) do nothing", [deliveryId]);
    if (fresh.rowCount === 0) {
      await c.query("rollback");
      return { status: 200 };
    }
    event = deps.parse(headers, body);
    const eventId = await appendEvent(c, {
      actor: "system", actorId: "github", itemId: null, kind: "webhook",
      payload: { deliveryId, githubEvent: headers["x-github-event"] ?? null, event },
    });
    // A comment names items by issue number, and the same number can be an item on each of several boards, so it gets
    // one comment command row per item with that number, and none when no board has one (2026-11-07 design, §07).
    if (event.kind === "comment") {
      const items = await c.query<{ id: string }>("select id from item where external_id = $1 order by id", [event.externalId]);
      await writeOutboxRows(c, CONSUMER.commentCommands, eventId, items.rows.map((r) => r.id));
    }
    await c.query("commit");
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
  // A failed move is logged, not thrown: the delivery is already recorded, so GitHub's redelivery would be dropped,
  // and the poller's next pass catches the same merge, close or review from the PR's state.
  await applyPrEvent(deps.pool, event).catch((e) => console.error(`applying ${event.kind} failed, the poller retries it:`, e));
  // Only after the commit and with the client back in the pool, and without holding up GitHub's 204. A redelivery
  // returned above, so the same comment is never applied twice.
  if (event.kind === "comment" && deps.onComment) {
    const comment = event;
    void deps.onComment(comment).catch((e) => console.error(`applying comment ${comment.commentId} failed:`, e));
  }
  return { status: 204 };
}

const github = { actor: "system", actorId: "github" } as const;

/**
 * Plan Task 17: what a merge, a close or a review does to the item whose open run holds the PR. A merge moves InReview,
 * InProgress during address, or NeedsInput (PBI 194) to Accepted and records `merge_sha`; the scheduler's CI poll then decides Done or
 * Failed. A close without a merge withdraws the item. A changes-requested review with a summary from an allowlisted
 * login, newer than `run.reviews_seen_at`, sends an InReview item back to address (Run contract 10). An item another path moved
 * first is left alone.
 */
async function applyPrEvent(pool: pg.Pool, e: FactoryWebhookEvent): Promise<void> {
  if (e.kind !== "pr_merged" && e.kind !== "pr_closed" && !(e.kind === "review" && e.state === "changes_requested")) return;
  const row = (await pool.query<{ item_id: string; state: string; run_id: string; reviews_seen_at: Date | null; trusted_bot: string | null }>(
    `select i.id as item_id, i.state, r.id as run_id, r.reviews_seen_at, repo.trusted_bot from run r join item i on i.id = r.item_id join repo on repo.id = r.repo_id
     where r.ended_at is null and r.pr_number = $1 and lower(repo.url) = lower($2)`,
    [e.prNumber, `https://github.com/${e.repo}`],
  )).rows[0];
  if (!row) return;
  try {
    if (e.kind === "pr_merged") {
      if (row.state !== "InReview" && row.state !== "InProgress" && row.state !== "NeedsInput") return;
      await withTx(pool, async (c) => {
        await transitionItem(c, row.item_id, "merged", github);
        await c.query("update run set merge_sha = $2 where id = $1", [row.run_id, e.mergeSha]);
      });
    } else if (e.kind === "pr_closed") {
      // The factory's own close comes from moving the item already, so only someone else's withdraws it.
      // trusted_bot may be stored without "[bot]" (issue #79), and GitHub always sends an App's login with it.
      if (row.trusted_bot && loginKey(e.by) === botKey(row.trusted_bot)) return;
      await withTx(pool, (c) => transitionItem(c, row.item_id, "withdrawn", github));
    } else {
      if (row.state !== "InReview") return;
      // The payload carries no line comments, so a review with no summary may hold nothing but a reply inside the
      // factory's own thread. The poller tells which, as it does for a review that only comments (PBI 130).
      if (!e.body.trim()) return;
      if (row.reviews_seen_at && new Date(e.submittedAt).getTime() <= row.reviews_seen_at.getTime()) return;
      const trusted = await pool.query(`select 1 from "user" where lower(github_login) = lower($1)`, [e.author]);
      if (!trusted.rowCount) return;
      await withTx(pool, async (c) => {
        await transitionItem(c, row.item_id, "changes_requested", github);
        await c.query("update run set next_stage = 'address' where id = $1", [row.run_id]);
      });
    }
  } catch (err) {
    if (!(err instanceof IllegalTransition)) throw err;
  }
}
