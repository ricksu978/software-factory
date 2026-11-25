// GitHub's webhook intake on the orchestrator API (redesign step 6d, 2026-11-07 design §05, §07 and §12).
// POST /webhooks/github lands here. A delivery signed with the webhook secret gets in, each delivery id is acted on
// once, and a new delivery is recorded as one `webhook` event together with its outbox rows: for a comment, one
// comment_commands row per item, on any board, that the comment names. The API never runs a comment's commands. The
// worker does that from the outbox.
import type pg from "pg";
import { parseGitHubWebhook } from "../adapters/github/backlog.ts";
import type { RepoHost } from "../adapters/types.ts";
import { handleWebhook } from "../watcher/webhook.ts";

export type WebhookIntakeDeps = {
  pool: pg.Pool;
  /** GITHUB_WEBHOOK_SECRET, which signs GitHub's deliveries. */
  secret: string;
  /**
   * Where a check suite's delivery reads the PR's head and its CI, so a failure there sends an InReview item back to
   * address (PBI 235). Unset, the delivery is only recorded, and the poller's next pass reads the same failure.
   */
  repoHost?: RepoHost;
};

/** The webhook request as the API received it: its headers and the body's exact bytes. */
export type WebhookRequest = { headers: Record<string, string | undefined>; rawBody: Buffer };

/**
 * 401 for a delivery not signed with the secret, 400 for a signed one with no delivery id or a body that isn't JSON,
 * 204 for a new delivery once it's recorded and 200 for a redelivery, which records nothing. A database error throws,
 * with nothing of the delivery kept, so the caller answers 500 and GitHub's retry gets in.
 */
export function webhookIntake(deps: WebhookIntakeDeps, req: WebhookRequest): Promise<{ status: 200 | 204 | 400 | 401 }> {
  // handleWebhook stays as it is (design §05), with no onComment: comment commands reach the worker through the
  // outbox rows written with the event.
  return handleWebhook({ pool: deps.pool, secret: deps.secret, parse: parseGitHubWebhook, repoHost: deps.repoHost }, req);
}
