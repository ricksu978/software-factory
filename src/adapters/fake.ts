import { CLAIM_MARKER, OPT_IN_LABEL, type ContractTarget } from "./contract.ts";
import { loginKey, type MergeState, standingSummaries, THREAD_SETTLE_MS, withoutFactoryThreads, type FactoryItem, type LineComment, type RepoHost, type ReviewComment } from "./types.ts";

/**
 * An in-memory backlog for tests. Its cursor is a change counter, so listEligible returns only items changed since the
 * last cursor. It has no webhooks, so parseWebhook ignores everything.
 */
export function fakeBacklog(): ContractTarget & { setDependencies(externalId: string, open: string[]): void } {
  const items = new Map<string, FactoryItem & { seq: number }>();
  const comments = new Map<string, { body: string; key: string }[]>();
  const dependencies = new Map<string, string[]>();
  let seq = 0;

  const get = (id: string) => {
    const item = items.get(id);
    if (!item) throw new Error(`no item ${id}`);
    return item;
  };
  const touch = (id: string, change: (item: FactoryItem) => void) => {
    const item = get(id);
    change(item);
    item.seq = ++seq;
    // Always later than before, even within one millisecond, so a test can't miss a change of updatedAt.
    item.updatedAt = new Date(Math.max(Date.now(), Date.parse(item.updatedAt) + 1)).toISOString();
  };
  // Items go in and out as deep copies, so neither a caller's arrays nor a returned item can reach the stored state.
  const copy = ({ seq: _, ...item }: FactoryItem & { seq: number }): FactoryItem => structuredClone(item);
  let lastAutoId = 0;
  const autoId = () => {
    do lastAutoId++;
    while (items.has(String(lastAutoId)));
    return String(lastAutoId);
  };

  return {
    adapter: {
      capabilities: { webhooks: false },
      async listEligible(cursor) {
        const since = Number(cursor ?? 0);
        const changed = [...items.values()].filter((i) => i.seq > since && !i.closed && i.labels.includes(OPT_IN_LABEL));
        return { items: changed.map(copy), cursor: String(seq) };
      },
      async getItem(id) {
        const item = items.get(id);
        return item ? copy(item) : null;
      },
      async openDependencies(id) {
        return [...(dependencies.get(id) ?? [])];
      },
      async claim(id) {
        touch(id, (i) => {
          if (!i.labels.includes(CLAIM_MARKER)) i.labels.push(CLAIM_MARKER);
        });
      },
      async release(id) {
        touch(id, (i) => {
          i.labels = i.labels.filter((l) => l !== CLAIM_MARKER);
        });
      },
      async comment(id, body, key) {
        get(id);
        const list = comments.get(id) ?? [];
        if (list.some((c) => c.key === key)) return;
        list.push({ body, key });
        comments.set(id, list);
        // A new comment bumps the item's updatedAt, as it does on GitHub.
        touch(id, () => {});
      },
      async setStatus(id, status) {
        touch(id, (i) => {
          i.status = status;
        });
      },
      async linkPr(id, prUrl) {
        touch(id, (i) => {
          i.fields.pr = prUrl;
        });
      },
      async close(id) {
        touch(id, (i) => {
          i.closed = true;
        });
      },
      parseWebhook() {
        return { kind: "ignored" };
      },
    },
    async seed(partial) {
      // Seeding an explicit id that exists replaces that item, which is how a test edits one.
      const externalId = partial.externalId ?? autoId();
      items.set(externalId, {
        sourceId: "fake", title: `item ${externalId}`, body: "", acceptanceCriteria: ["it works"], labels: [OPT_IN_LABEL],
        status: "Backlog", rank: items.size + 1, repo: null, fields: {}, closed: false, updatedAt: new Date().toISOString(),
        ...structuredClone(partial), externalId, seq: ++seq,
      });
      return externalId;
    },
    async comments(id) {
      return (comments.get(id) ?? []).map((c) => c.body);
    },
    setDependencies(id, open) {
      dependencies.set(id, [...open]);
    },
  };
}

type FakePr = {
  number: number; repo: string; branch: string; base: string; title: string; body: string; headSha: string | null;
  open: boolean; merged: boolean; mergeSha: string | null; mergeable: boolean | null; reviewers: string[]; comments: string[];
  reviews: { state: "changes_requested" | "approved" | "commented"; submittedAt: string; author: string; body?: string }[];
  /** PBI 181: what GitHub reports as the PR's merge state. Unset, it reads `unknown`, so no PR merges by accident. */
  mergeState?: MergeState;
  /** PBI 181: the commit a merge of this PR makes. Unset, `merge-<number>`. */
  mergeAs?: string;
  /** PBI 181: GitHub's messages for the next merges it refuses, the first one first. */
  refusals?: string[];
};
/** A merge mergePr was asked for, and what it answered. */
type MergeCall = { repo: string; prNumber: number; method: string; headSha: string | null; merged: boolean };
type Status = "pending" | "success" | "failure";
/** A review postReview recorded. Its event is always COMMENT, as on GitHub. */
type PostedReview = { repo: string; prNumber: number; commitSha: string; body: string; comments: LineComment[]; event: "COMMENT" };

/**
 * An in-memory RepoHost for the tests in Tasks 7 to 17. Tests set its state directly: PRs, check results by
 * `repo@sha`, files by `repo@ref:path`, default branch heads, each branch's commits by `repo@branch`, and review
 * comments by `repo#number`. A sha with no check result has no checks at all. A comment marked `resolved` sits in a
 * resolved thread, and openReviewComments leaves it out. An open one with a `submittedAt` counts in prState as
 * GitHub's does: on an open PR, from a trusted login in any case, once it has stood for THREAD_SETTLE_MS. A review that
 * requests changes counts when it has a body, or when a comment outside the factory's threads carries its author and
 * `submittedAt`, which is how the fake ties a comment to its review.
 * It records each review postReview posts in `postedReviews`, and each thread resolveThread resolves in `resolvedThreads`,
 * once, so the engine's tests can read what a stage posted. Each line comment a posted review carries opens a thread by
 * `factory[bot]` in `reviewComments`, which postReview returns.
 */
export function fakeRepoHost(): RepoHost & {
  prs: FakePr[];
  checks: Map<string, Status>;
  /** The names of the checks still pending, by `repo@sha`. A sha with none set has none pending. */
  pendingChecks: Map<string, string[]>;
  files: Map<string, string>;
  heads: Map<string, string>;
  branches: Map<string, string[]>;
  reviewComments: Map<string, (ReviewComment & { resolved?: boolean; submittedAt?: string })[]>;
  postedReviews: PostedReview[];
  resolvedThreads: { repo: string; threadId: string }[];
  mergeCalls: MergeCall[];
} {
  const mergeCalls: MergeCall[] = [];
  const postedReviews: PostedReview[] = [];
  const resolvedThreads: { repo: string; threadId: string }[] = [];
  let openedThreads = 0;
  const prs: FakePr[] = [];
  const checks = new Map<string, Status>();
  const pendingChecks = new Map<string, string[]>();
  const files = new Map<string, string>();
  const heads = new Map<string, string>();
  const branches = new Map<string, string[]>();
  const reviewComments = new Map<string, (ReviewComment & { resolved?: boolean; submittedAt?: string })[]>();
  const pr = (repo: string, n: number) => {
    const found = prs.find((p) => p.repo === repo && p.number === n);
    if (!found) throw new Error(`no PR ${repo}#${n}`);
    return found;
  };
  const url = (p: FakePr) => `https://github.com/${p.repo}/pull/${p.number}`;

  return {
    prs, checks, pendingChecks, files, heads, branches, reviewComments, postedReviews, resolvedThreads, mergeCalls,
    async cellToken(repo) {
      return { token: `fake-token-${repo}`, expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
    },
    async openOrUpdatePr({ repo, branch, base, title, body }) {
      const open = prs.find((p) => p.repo === repo && p.branch === branch && p.open);
      if (open) {
        Object.assign(open, { base, title, body });
        return { number: open.number, url: url(open) };
      }
      const created: FakePr = {
        number: prs.length + 1, repo, branch, base, title, body, headSha: null, open: true, merged: false,
        mergeSha: null, mergeable: true, reviewers: [], comments: [], reviews: [],
      };
      prs.push(created);
      return { number: created.number, url: url(created) };
    },
    async checksOnHead(repo, n) {
      const head = pr(repo, n).headSha;
      return (head && checks.get(`${repo}@${head}`)) || "pending";
    },
    async checksOnSha(repo, sha) {
      return checks.get(`${repo}@${sha}`) ?? "none";
    },
    async pendingChecksOnSha(repo, sha) {
      return [...(pendingChecks.get(`${repo}@${sha}`) ?? [])];
    },
    async onBranch(repo, branch, sha) {
      return branches.get(`${repo}@${branch}`)?.includes(sha) ?? false;
    },
    async requestReviewers(repo, n, fallback) {
      pr(repo, n).reviewers = [...fallback];
      return [...fallback];
    },
    async prState(repo, n, trustedLogins, trustedBot) {
      const p = pr(repo, n);
      const settled = Date.now() - THREAD_SETTLE_MS;
      const trusted = new Set(trustedLogins.map(loginKey));
      const own = withoutFactoryThreads(p.open ? reviewComments.get(`${repo}#${n}`) ?? [] : [], trustedBot);
      const open = own.filter((c) => !c.resolved && c.submittedAt && Date.parse(c.submittedAt) <= settled && trusted.has(loginKey(c.author))).map((c) => c.submittedAt!);
      // A comment belongs to the review its author submitted at its submittedAt.
      const withText = (r: FakePr["reviews"][number]) => (r.body ?? "").trim() !== "" || own.some((c) => c.submittedAt === r.submittedAt && loginKey(c.author) === loginKey(r.author));
      const requested = [...p.reviews.filter((r) => r.state === "changes_requested" && trusted.has(loginKey(r.author)) && withText(r)).map((r) => r.submittedAt), ...open].sort();
      return { merged: p.merged, mergeSha: p.mergeSha, open: p.open, mergeable: p.mergeable, lastChangesRequestedAt: requested.at(-1) ?? null };
    },
    async closePr(repo, n, comment) {
      const p = pr(repo, n);
      p.open = false;
      p.comments.push(comment);
    },
    async readFile(repo, ref, path) {
      return files.get(`${repo}@${ref}:${path}`) ?? null;
    },
    async defaultBranchSha(repo) {
      const head = heads.get(repo);
      if (!head) throw new Error(`no default branch head for ${repo}`);
      return head;
    },
    async openReviewComments(repo, n) {
      const comments = (reviewComments.get(`${repo}#${n}`) ?? []).filter((c) => !c.resolved).map(({ resolved: _, submittedAt: __, ...c }) => c);
      const reviews = [...(prs.find((p) => p.repo === repo && p.number === n)?.reviews ?? [])]
        .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))
        .map((r, i) => ({ id: `review-${i + 1}`, author: r.author, state: r.state, body: r.body ?? "" }));
      return [...comments, ...standingSummaries(reviews)];
    },
    async replyToThread(repo, threadId, body) {
      const key = [...reviewComments.keys()].find((k) => k.startsWith(`${repo}#`) && reviewComments.get(k)!.some((c) => c.threadId === threadId));
      if (!key) throw new Error(`no review thread ${threadId} in ${repo}`);
      const thread = reviewComments.get(key)!.find((c) => c.threadId === threadId)!;
      reviewComments.get(key)!.push({ threadId, path: thread.path, line: thread.line, author: "factory[bot]", body });
    },
    async commentOnPr(repo, n, body) {
      pr(repo, n).comments.push(body);
    },
    async postReview({ repo, prNumber, commitSha, body, comments }) {
      postedReviews.push({ repo, prNumber, commitSha, body, comments: comments.map(({ path, line, body }) => ({ path, line, body })), event: "COMMENT" });
      // Each line comment opens a thread by the factory's bot, as on GitHub.
      const key = `${repo}#${prNumber}`;
      const threads = comments.map(({ path, line, body }) => ({ threadId: `review-thread-${++openedThreads}`, path, line, body }));
      if (threads.length) reviewComments.set(key, [...(reviewComments.get(key) ?? []), ...threads.map((t) => ({ ...t, author: "factory[bot]" }))]);
      return { threads };
    },
    async resolveThread(repo, threadId) {
      const thread = [...reviewComments.entries()].find(([k, cs]) => k.startsWith(`${repo}#`) && cs.some((c) => c.threadId === threadId))?.[1]
        .filter((c) => c.threadId === threadId);
      if (!thread) throw new Error(`no review thread ${threadId} in ${repo}`);
      if (thread.every((c) => c.resolved)) return;
      for (const c of thread) c.resolved = true;
      resolvedThreads.push({ repo, threadId });
    },
    async mergeView(repo, n) {
      const p = pr(repo, n);
      const latest = new Map<string, { author: string; state: string }>();
      for (const r of [...p.reviews].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))) {
        if (r.state !== "commented") latest.set(loginKey(r.author), r);
      }
      const approvedBy = [...latest.values()].filter((r) => r.state === "approved").map((r) => r.author);
      return { mergeState: p.mergeState ?? "unknown", headSha: p.headSha, body: p.body, approvedBy };
    },
    // Merges any open PR it isn't told to refuse, as an admin's token could, so only the factory's own checks hold one.
    async mergePr(repo, n, { method, headSha }) {
      const p = pr(repo, n);
      const refusal = p.refusals?.shift()
        ?? (!p.open ? "Pull Request is not mergeable" : headSha !== null && headSha !== p.headSha ? "Head branch was modified. Review and try the merge again." : null);
      mergeCalls.push({ repo, prNumber: n, method, headSha, merged: refusal === null });
      if (refusal !== null) return { merged: false, reason: refusal };
      Object.assign(p, { open: false, merged: true, mergeSha: p.mergeAs ?? `merge-${n}` });
      return { merged: true, sha: p.mergeSha! };
    },
  };
}
