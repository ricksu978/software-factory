// The backlog and repo host interfaces every adapter implements (plan Task 6). src/adapters/contract.ts checks backlogs.

export type FactoryItem = {
  sourceId: string; externalId: string; title: string; body: string;
  acceptanceCriteria: string[]; labels: string[]; status: string; rank: number;
  repo: string | null; fields: Record<string, string>; closed: boolean; updatedAt: string;
  /** When the item's issue was created, as an ISO time, where the backlog knows it (PBI 187). */
  createdAt?: string;
  /**
   * The names in `fields` that come through only to order the claims, such as Priority (PBI 320), and that the
   * readiness check doesn't judge. A field the repo also lists as a readiness field isn't here.
   */
  orderOnly?: string[];
};
// fields holds the values of FieldMap.readinessFields, such as { Size: "8" }, and any field named in orderOnly

/** The fields the readiness check judges: an item's fields without those that only order the claims (PBI 320). */
export function judgedFields(fi: Pick<FactoryItem, "fields" | "orderOnly">): Record<string, string> {
  const skip = new Set(fi.orderOnly ?? []);
  return Object.fromEntries(Object.entries(fi.fields).filter(([k]) => !skip.has(k)));
}

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
  /**
   * PBI 255: files a new item on the board, in `repo`, with these labels and the board's own opt-in label, and answers
   * its external id, so a caller never names the opt-in label itself. A second call
   * with the same `dedupeKey` files nothing and answers the first item's id, as `comment` dedupes.
   */
  fileItem(p: { title: string; body: string; labels: string[]; repo: string | null }, dedupeKey: string): Promise<string>;
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

/**
 * Why an item went back to address, as its `changes_requested` event names it (PBI 258): a trusted review's summary, a
 * trusted comment in a thread that was unresolved when it was read, GitHub reporting the PR not mergeable, or CI failing
 * on the PR's head (PBI 235).
 */
export type ChangeCause =
  | { kind: "review"; author: string; body: string; submittedAt: string }
  | { kind: "thread_comment"; threadId: string; author: string; body: string; submittedAt: string }
  | { kind: "not_mergeable" }
  /** PBI 235: CI failed on `sha`, the head of the PR, with each failed check, its URL and the tests it names as failing. */
  | { kind: "ci_failed"; sha: string; checks: { name: string; url: string; failingTests: string[] }[] };

/** The newest of `causes` by `submittedAt`. On a tie a thread comment wins, since it holds the text the review asked with. */
export function newestCause<T extends { kind: string; submittedAt: string }>(causes: T[]): T | null {
  let best: T | null = null;
  for (const c of causes) {
    const d = best ? Date.parse(c.submittedAt) - Date.parse(best.submittedAt) : 1;
    if (d > 0 || (d === 0 && c.kind === "thread_comment")) best = c;
  }
  return best;
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

/**
 * How many failed checks a CI failure's log finding gives a log (PBI 232). The repo host reads logs for these only, and
 * gives the rest a null log, since the cell names them by name and URL alone.
 */
export const LOGGED_CHECKS = 5;

/** How many lines from the end of a failed check's log the cell API returns. */
export const FAILED_LOG_LINES = 100;

/** How many characters of one line of a failed check's log the cell API keeps, the rest cut and marked with "…". */
export const FAILED_LOG_LINE_CHARS = 500;

/**
 * How many characters of a failed check's log tail the cell API returns at most, kept from the end. A line cap alone
 * still lets 100 lines reach 50k characters; the tail goes into a finding every later Green brief copies, so it must
 * stay small next to the brief's context.
 */
export const FAILED_LOG_CHARS = 20_000;

/**
 * The last FAILED_LOG_LINES lines of `log`, joined by "\n", with a trailing newline and CRLFs dropped. A line longer
 * than FAILED_LOG_LINE_CHARS is cut to that many and ends in "…", and when the tail is still longer than
 * FAILED_LOG_CHARS its oldest characters go, from the start of a line, so a failing test that dumps a large blob can't
 * swell the finding.
 */
export function logTail(log: string): string {
  const lines = log.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").slice(-FAILED_LOG_LINES)
    .map((l) => (l.length > FAILED_LOG_LINE_CHARS ? `${l.slice(0, FAILED_LOG_LINE_CHARS)}…` : l));
  let total = lines.reduce((n, l) => n + l.length + 1, -1);
  while (total > FAILED_LOG_CHARS && lines.length > 1) total -= lines.shift()!.length + 1;
  return lines.join("\n");
}

/**
 * The lines of one file a PR's diff covers on its new side, `from` to `to` inclusive, so a line comment on any of them
 * is one GitHub can place (PBI 266). A file the PR doesn't change has no range.
 */
export type DiffRange = { path: string; from: number; to: number };

/**
 * A named check CI reported on a commit, with the URL of its run (PBI 229). `pending` is a check still running, which
 * has reported nothing yet.
 */
export type CiCheck = {
  name: string; conclusion: "success" | "failure" | "pending"; url: string;
  /** PBI 292: the tests a failed check names as failing, when its run reports them. Empty or absent when it names none. */
  failingTests?: string[];
  /**
   * PBI 233: when the check's run finished, as an ISO time, when the host says. A check another app re-runs on request
   * may finish again under the same run and URL, so only this tells its re-run apart from the run before.
   */
  completedAt?: string;
};

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

/** PBI 233: the checks a re-run started, and each named check the host refused to re-run, with why. */
export type RerunAnswer = { rerun: string[]; refused: { check: string; reason: string }[] };

export interface RepoHost {
  cellToken(repo: string): Promise<{ token: string; expiresAt: string }>;
  /**
   * Each permission the factory needs on the repo that its App's installation hasn't been granted, by GitHub's name,
   * such as "issues: write" (PBI 264). Empty when every one is granted. Only the owner can grant one.
   */
  missingPermissions?(repo: string): Promise<string[]>;
  openOrUpdatePr(p: { repo: string; branch: string; base: string; title: string; body: string }): Promise<{ number: number; url: string }>;
  checksOnHead(repo: string, prNumber: number): Promise<"pending" | "success" | "failure">;
  /** "none" means no check has reported on the sha at all, which the cell API turns into `none` after 10 minutes (Run contract 6). */
  checksOnSha(repo: string, sha: string): Promise<"pending" | "success" | "failure" | "none">;
  /**
   * The checks that failed on `sha`, each with its URL and the last 100 lines of its log, or a null log when the host
   * can't give it (PBI 232). Only the first LOGGED_CHECKS failed checks carry a log; the rest have a null one. A check that passed, was skipped or ended neutral isn't one of them.
   */
  failedChecksOnSha(repo: string, sha: string): Promise<FailedCheck[]>;
  /** PBI 234: the names of the checks still pending on `sha`, for the question when CI stays pending for 60 minutes. */
  pendingChecksOnSha(repo: string, sha: string): Promise<string[]>;
  /** Each check CI reported on the sha, by name, or null when none has (PBI 229). A dod.md `ci:` line reads its own. */
  ciChecksOnSha(repo: string, sha: string): Promise<CiCheck[] | null>;
  /**
   * PBI 233: re-runs the named checks that failed on `sha`, once, so a flaky check gets a second go before a red CI is
   * charged. Rejects when a named check didn't fail on `sha`, or when the host started no re-run at all. When it started
   * some, it answers which checks it re-ran and which it refused, and why, so a partial re-run is still a re-run.
   */
  rerunChecksOnSha?(repo: string, sha: string, checks: string[]): Promise<RerunAnswer>;
  /** Whether `sha` is the head of `branch` or one of its ancestors, so a cell can only ask about its own commits. */
  onBranch(repo: string, branch: string, sha: string): Promise<boolean>;
  /**
   * The commits on `branch` after `sha`, oldest first, so the last is the branch head (PBI 260). Only the branch's
   * first-parent line counts: a PR's own commits that came in through a merge commit didn't run the branch's CI. Empty
   * when `sha` is the head, or isn't on the branch at all.
   */
  commitsAfter(repo: string, branch: string, sha: string): Promise<string[]>;
  /** CODEOWNERS first, then `fallback`. */
  requestReviewers(repo: string, prNumber: number, fallback: string[]): Promise<string[]>;
  /**
   * `lastChangesRequestedAt` is the newest trusted review that requests changes or comments in a still-open thread, once
   * that comment has stood two minutes (Run contract 10). A thread `trustedBot` opened, the factory's own review's, never
   * counts, whoever replies inside it, and neither does a review requesting changes whose only text sits in such a
   * thread (PBI 130), or in a thread that is resolved when it's read (PBI 258).
   */
  prState(repo: string, prNumber: number, trustedLogins: string[], trustedBot?: string | null): Promise<{
    merged: boolean; mergeSha: string | null; open: boolean; mergeable: boolean | null; lastChangesRequestedAt: string | null;
    /** The PR's head as it was read, so the poller reads CI on it with no second read of the PR (PBI 235). */
    headSha?: string | null;
    /** What `lastChangesRequestedAt` dates: the review summary or the thread comment (PBI 258). */
    lastChangesRequested?: ChangeCause | null;
  }>;
  closePr(repo: string, prNumber: number, comment: string): Promise<void>;
  readFile(repo: string, ref: string, path: string): Promise<string | null>;
  /**
   * PBI 365: commits `files` to `branch` in one commit on top of the branch's head, each file's text its whole new
   * content, and answers the new commit's sha. The control plane writes an approved feature change request this way.
   */
  commitFiles(p: { repo: string; branch: string; message: string; files: { path: string; text: string }[] }): Promise<string>;
  defaultBranchSha(repo: string): Promise<string>;
  /** Every comment in the PR's unresolved review threads, then the review summaries that still stand. */
  openReviewComments(repo: string, prNumber: number): Promise<ReviewComment[]>;
  /**
   * The PR's submitted reviews, oldest first, each with its author's login, its state and its body. The PR review stage
   * reads the factory's own among them for the last round an earlier claim posted (PBI 318).
   */
  prReviews(repo: string, prNumber: number): Promise<Review[]>;
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
  /**
   * The new-side line ranges of the PR's diff at `commitSha`, against the PR's base, which a line comment in a review
   * at that commit must fall in (PBI 266). Null when the host can't give the whole diff, as GitHub can't past 300
   * files, so the caller can't tell which lines it covers.
   */
  diffLines(repo: string, prNumber: number, commitSha: string): Promise<DiffRange[] | null>;
  /** Resolves one review thread by its id. Resolving a thread that's already resolved succeeds and changes nothing. */
  resolveThread(repo: string, threadId: string): Promise<void>;
  /** What decides a factory merge: GitHub's merge state, the head, the body and the approvers (PBI 181). */
  mergeView(repo: string, prNumber: number): Promise<MergeView>;
  /** Squash-merges the PR at `headSha`. GitHub refusing, a moved head for one, comes back as `merged: false`. */
  mergePr(repo: string, prNumber: number, p: { method: "squash"; headSha: string | null }): Promise<MergeResult>;
  /** PBI 255: each check run that reported on `sha`, with its outcome and its page. A cancelled run is reported as `cancelled`, since it proves nothing either way. Empty when none has. */
  checkRuns(repo: string, sha: string): Promise<CheckRun[]>;
  /** PBI 255: the log of the check run named `check` on `sha`, or null when the host keeps none. */
  checkLog(repo: string, sha: string, check: string): Promise<string | null>;
  /** PBI 255: the commit's first parent, which for a merge onto `main` is the main commit it was merged onto. Null for a root commit. */
  firstParent(repo: string, sha: string): Promise<string | null>;
}

/**
 * One check run on a commit (PBI 255). `pending`: it hasn't finished. `cancelled`: it ended cancelled, as when a later
 * push cancelled it, so it proves nothing either way.
 */
export type CheckRun = { name: string; status: "pending" | "success" | "failure" | "cancelled"; url: string };
