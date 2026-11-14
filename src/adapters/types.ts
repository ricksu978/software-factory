// The backlog and repo host interfaces every adapter implements (plan Task 6). src/adapters/contract.ts checks backlogs.

export type FactoryItem = {
  sourceId: string; externalId: string; title: string; body: string;
  acceptanceCriteria: string[]; labels: string[]; status: string; rank: number;
  repo: string | null; fields: Record<string, string>; closed: boolean; updatedAt: string;
  /** When the item's issue was created, as an ISO time, where the backlog knows it (PBI 187). */
  createdAt?: string;
};
// fields holds the values of FieldMap.readinessFields, such as { Size: "8" }

export type FactoryWebhookEvent =
  | { kind: "item_changed"; externalId: string }
  | { kind: "pr_merged"; prNumber: number; repo: string; mergeSha: string }
  | { kind: "pr_closed"; prNumber: number; repo: string; by: string } // `by`: the login that closed it
  | { kind: "checks_completed"; sha: string; repo: string }
  | { kind: "comment"; externalId: string; repo: string; login: string; body: string; commentId: string }
  | { kind: "review"; prNumber: number; repo: string; state: "changes_requested" | "approved" | "commented"; submittedAt: string; author: string; body: string }
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

/**
 * Whether a thread is one the factory's own review opened: its first comment is by the repo's trusted bot. Such a
 * thread belongs to the PR review stage, so neither a reply inside it nor its finding sends an item to address
 * (PBI 130). With no trusted bot, no thread is the factory's.
 */
export function factoryThread(firstAuthor: string | undefined, trustedBot: string | null | undefined): boolean {
  return Boolean(trustedBot && firstAuthor !== undefined && loginKey(firstAuthor) === botKey(trustedBot));
}

/** The comments outside the factory's own threads, each thread known by its first comment in `comments`' order. */
export function withoutFactoryThreads<T extends { threadId: string; author: string }>(comments: T[], trustedBot: string | null | undefined): T[] {
  const first = new Map<string, string>();
  for (const c of comments) if (!first.has(c.threadId)) first.set(c.threadId, c.author);
  return comments.filter((c) => !factoryThread(first.get(c.threadId), trustedBot));
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

/** The review thread one of a posted review's line comments opened, by the id resolveThread and replyToThread take. */
export type OpenedThread = { threadId: string; path: string; line: number; body: string };

/** A check that failed on a commit, as the cell API hands it to a cell waiting on CI (PBI 232). */
export type FailedCheck = { name: string; url: string; log: string | null };

/** How many lines from the end of a failed check's log the cell API returns. */
export const FAILED_LOG_LINES = 100;

/** The last FAILED_LOG_LINES lines of `log`, joined by "\n", with a trailing newline and CRLFs dropped. */
export function logTail(log: string): string {
  return log.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").slice(-FAILED_LOG_LINES).join("\n");
}

/** GitHub's `mergeable_state` for a PR, lower case. Only `clean` lets the factory merge (PBI 181). */
export type MergeState = "clean" | "blocked" | "behind" | "unstable" | "unknown" | "dirty" | "draft" | "has_hooks";

/** What the poller reads to decide whether to merge a PR (PBI 181). */
export type MergeView = {
  mergeState: MergeState;
  /** The head the view was read at, which mergePr passes back so a head that moved since makes GitHub refuse. */
  headSha: string | null;
  /** The PR body, whose Definition of Done section holds the lines left for the person who merges. */
  body: string;
  /** Each reviewer whose latest review that isn't a plain comment approves the PR. */
  approvedBy: string[];
};

/** A merge GitHub made, with its commit, or one it refused, with GitHub's message. A refusal never throws. */
export type MergeResult = { merged: true; sha: string } | { merged: false; reason: string };

export interface RepoHost {
  cellToken(repo: string): Promise<{ token: string; expiresAt: string }>;
  openOrUpdatePr(p: { repo: string; branch: string; base: string; title: string; body: string }): Promise<{ number: number; url: string }>;
  checksOnHead(repo: string, prNumber: number): Promise<"pending" | "success" | "failure">;
  /** "none" means no check has reported on the sha at all, which the cell API turns into `none` after 10 minutes (Run contract 6). */
  checksOnSha(repo: string, sha: string): Promise<"pending" | "success" | "failure" | "none">;
  /**
   * The checks that failed on `sha`, each with its URL and the last 100 lines of its log, or a null log when the host
   * can't give it (PBI 232). A check that passed, was skipped or ended neutral isn't one of them.
   */
  failedChecksOnSha(repo: string, sha: string): Promise<FailedCheck[]>;
  /** Whether `sha` is the head of `branch` or one of its ancestors, so a cell can only ask about its own commits. */
  onBranch(repo: string, branch: string, sha: string): Promise<boolean>;
  /** CODEOWNERS first, then `fallback`. */
  requestReviewers(repo: string, prNumber: number, fallback: string[]): Promise<string[]>;
  /**
   * `lastChangesRequestedAt` is the newest trusted review that requests changes or comments in a still-open thread, once
   * that comment has stood two minutes (Run contract 10). A thread `trustedBot` opened, the factory's own review's, never
   * counts, whoever replies inside it, and neither does a review requesting changes whose only text sits in such a
   * thread (PBI 130).
   */
  prState(repo: string, prNumber: number, trustedLogins: string[], trustedBot?: string | null): Promise<{
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
   * human reviewer (PBI 129). It returns the thread each line comment opened, so the PR review stage can track its own
   * threads apart from the ones people open (PBI 128).
   */
  postReview(p: { repo: string; prNumber: number; commitSha: string; body: string; comments: LineComment[] }): Promise<{ threads: OpenedThread[] }>;
  /** Resolves one review thread by its id. Resolving a thread that's already resolved succeeds and changes nothing. */
  resolveThread(repo: string, threadId: string): Promise<void>;
  /** What decides a factory merge: GitHub's merge state, the head, the body and the approvers (PBI 181). */
  mergeView(repo: string, prNumber: number): Promise<MergeView>;
  /** Squash-merges the PR at `headSha`. GitHub refusing, a moved head for one, comes back as `merged: false`. */
  mergePr(repo: string, prNumber: number, p: { method: "squash"; headSha: string | null }): Promise<MergeResult>;
}
