// GitHub's webhook intake on the orchestrator API (redesign step 6d, 2026-11-07 design §05, §07 and §12).
// POST /webhooks/github lands here. A delivery signed with the webhook secret gets in, each delivery id is acted on
// once, and a new delivery is recorded as one `webhook` event together with its outbox rows: for a comment, one
// comment_commands row per item, on any board, that the comment names. The API never runs a comment's commands. The
// worker does that from the outbox.
import type pg from "pg";

export type WebhookIntakeDeps = {
  pool: pg.Pool;
  /** GITHUB_WEBHOOK_SECRET, which signs GitHub's deliveries. */
  secret: string;
};

/** The webhook request as the API received it: its headers and the body's exact bytes. */
export type WebhookRequest = { headers: Record<string, string | undefined>; rawBody: Buffer };

/**
 * 401 for a delivery not signed with the secret, 400 for a signed one with no delivery id or a body that isn't JSON,
 * 204 for a new delivery once it's recorded and 200 for a redelivery, which records nothing.
 */
export async function webhookIntake(_deps: WebhookIntakeDeps, _req: WebhookRequest): Promise<{ status: 200 | 204 | 400 | 401 }> {
  // Red stub (PBI 287): no behaviour yet.
  return { status: 204 };
}
