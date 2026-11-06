// GitHub webhook intake. Only a delivery GitHub signed with the shared secret gets in, and each delivery id is
// acted on once, so a redelivery never produces a second event (spec §10).
import { createHmac, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import type { FactoryWebhookEvent } from "../adapters/types.ts";
import { appendEvent } from "../store/events.ts";

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
 * delivery id and one `webhook` event go in together: 204 the first time, 200 with no event for a redelivery.
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
    await appendEvent(c, {
      actor: "system", actorId: "github", itemId: null, kind: "webhook",
      payload: { deliveryId, githubEvent: headers["x-github-event"] ?? null, event },
    });
    await c.query("commit");
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
  // Only after the commit and with the client back in the pool, and without holding up GitHub's 204. A redelivery
  // returned above, so the same comment is never applied twice.
  if (event.kind === "comment" && deps.onComment) {
    const comment = event;
    void deps.onComment(comment).catch((e) => console.error(`applying comment ${comment.commentId} failed:`, e));
  }
  return { status: 204 };
}
