// The backlog and repo host interfaces every adapter implements (plan Task 6). src/adapters/contract.ts checks backlogs.

export type FactoryItem = {
  sourceId: string; externalId: string; title: string; body: string;
  acceptanceCriteria: string[]; labels: string[]; status: string; rank: number;
  repo: string | null; fields: Record<string, string>; closed: boolean; updatedAt: string;
};
// fields holds the values of FieldMap.readinessFields, such as { Size: "8" }

export type FactoryWebhookEvent =
  | { kind: "item_changed"; externalId: string }
  | { kind: "pr_merged"; prNumber: number; repo: string; mergeSha: string }
  | { kind: "pr_closed"; prNumber: number; repo: string; by: string } // `by`: the login that closed it
  | { kind: "checks_completed"; sha: string; repo: string }
  | { kind: "comment"; externalId: string; repo: string; login: string; body: string; commentId: string }
  | { kind: "review"; prNumber: number; repo: string; state: "changes_requested" | "approved" | "commented"; submittedAt: string; author: string }
  | { kind: "ignored" };

export interface BacklogAdapter {
  capabilities: { webhooks: boolean };
  listEligible(cursor: string | null): Promise<{ items: FactoryItem[]; cursor: string }>;
  getItem(externalId: string): Promise<FactoryItem | null>;
  openDependencies(externalId: string): Promise<string[]>;
  claim(externalId: string): Promise<void>;
  release(externalId: string): Promise<void>;
  comment(externalId: string, body: string, dedupeKey: string): Promise<void>;
  setStatus(externalId: string, status: string): Promise<void>;
  linkPr(externalId: string, prUrl: string): Promise<void>;
  close(externalId: string): Promise<void>;
  parseWebhook(headers: Record<string, string>, body: unknown): FactoryWebhookEvent;
}

/** A line comment in a review thread, or a review's top-level summary, which has no path and the review's id as threadId. */
export type ReviewComment = { threadId: string; path: string | null; line: number | null; author: string; body: string };

/**
 * A login as GitHub compares it: logins ignore case. A bot author is always named `name[bot]`, as REST names it, so a
 * user account with the bot's bare name never shares its key (issue #79). Callers compare whole keys, never prefixes.
 */
export function loginKey(login: string): string {
  return login.toLowerCase();
}

/**
 * How long an open thread comment stands before prState counts it. A reviewer replies to a thread and resolves it in
 * two calls, and a poll between them would send the item to address with nothing left to read, which blocks it.
 */
// ponytail: a fixed two minutes; a reviewer slower than that between reply and resolve can still block the item.
export const THREAD_SETTLE_MS = 120_000;

/** The key of a repo's trusted bot, stored with or without its "[bot]" suffix. */
export function botKey(login: string): string {
  const key = loginKey(login);
  return key.endsWith("[bot]") ? key : `${key}[bot]`;
}

export type Review = { id: string; author: string; state: "changes_requested" | "approved" | "commented" | "dismissed"; body: string };

/**
 * The summaries that still stand, from a PR's reviews in the order they were submitted. A summary can't be resolved,
 * so it counts while its reviewer's latest review requests changes. As in GitHub's own reviewer state, a review that
 * only comments changes nothing, and an approval, a dismissal or a newer review replaces the summary (issue #28).
 */
export function standingSummaries(reviews: Review[]): ReviewComment[] {
  const latest = new Map<string, Review>();
  for (const r of reviews) if (r.state !== "commented") latest.set(loginKey(r.author), r);
  return [...latest.values()]
    .filter((r) => r.state === "changes_requested" && r.body.trim() !== "")
    .map((r) => ({ threadId: r.id, path: null, line: null, author: r.author, body: r.body }));
}

/** One comment a review leaves on a line of the PR's new code. */
export type LineComment = { path: string; line: number; body: string };

export interface RepoHost {
  cellToken(repo: string): Promise<{ token: string; expiresAt: string }>;
  openOrUpdatePr(p: { repo: string; branch: string; base: string; title: string; body: string }): Promise<{ number: number; url: string }>;
  checksOnHead(repo: string, prNumber: number): Promise<"pending" | "success" | "failure">;
  /** "none" means no check has reported on the sha at all, which the cell API turns into `none` after 10 minutes (Run contract 6). */
  checksOnSha(repo: string, sha: string): Promise<"pending" | "success" | "failure" | "none">;
  /** Whether `sha` is the head of `branch` or one of its ancestors, so a cell can only ask about its own commits. */
  onBranch(repo: string, branch: string, sha: string): Promise<boolean>;
  /** CODEOWNERS first, then `fallback`. */
  requestReviewers(repo: string, prNumber: number, fallback: string[]): Promise<string[]>;
  /** `lastChangesRequestedAt` is the newest trusted review that requests changes or comments in a still-open thread, once that comment has stood two minutes (Run contract 10). */
  prState(repo: string, prNumber: number, trustedLogins: string[]): Promise<{
    merged: boolean; mergeSha: string | null; open: boolean; mergeable: boolean | null; lastChangesRequestedAt: string | null;
  }>;
  closePr(repo: string, prNumber: number, comment: string): Promise<void>;
  readFile(repo: string, ref: string, path: string): Promise<string | null>;
  defaultBranchSha(repo: string): Promise<string>;
  /** Every comment in the PR's unresolved review threads, then the review summaries that still stand. */
  openReviewComments(repo: string, prNumber: number): Promise<ReviewComment[]>;
  /** Adds a reply to one review thread, as the address stage does when it answers a comment instead of changing code. */
  replyToThread(repo: string, threadId: string, body: string): Promise<void>;
  /** Posts a comment on the PR itself, as the address stage does to answer a review summary, which has no thread. */
  commentOnPr(repo: string, prNumber: number, body: string): Promise<void>;
  /**
   * Posts one review on the PR at `commitSha`, with a body and line comments on the new side of the diff. It's always a
   * `COMMENT` review: nothing here can approve a PR or request changes on it, so the factory never stands in for a
   * human reviewer (PBI 129).
   */
  postReview(p: { repo: string; prNumber: number; commitSha: string; body: string; comments: LineComment[] }): Promise<void>;
  /** Resolves one review thread by its id. Resolving a thread that's already resolved succeeds and changes nothing. */
  resolveThread(repo: string, threadId: string): Promise<void>;
}
