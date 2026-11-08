import { CLAIM_MARKER, OPT_IN_LABEL, type ContractTarget } from "./contract.ts";
import { loginKey, standingSummaries, THREAD_SETTLE_MS, type FactoryItem, type RepoHost, type ReviewComment } from "./types.ts";

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
    item.updatedAt = new Date().toISOString();
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
        if (!list.some((c) => c.key === key)) list.push({ body, key });
        comments.set(id, list);
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
};
type Status = "pending" | "success" | "failure";

/**
 * An in-memory RepoHost for the tests in Tasks 7 to 17. Tests set its state directly: PRs, check results by
 * `repo@sha`, files by `repo@ref:path`, default branch heads, each branch's commits by `repo@branch`, and review
 * comments by `repo#number`. A sha with no check result has no checks at all. A comment marked `resolved` sits in a
 * resolved thread, and openReviewComments leaves it out. An open one with a `submittedAt` counts in prState as
 * GitHub's does: on an open PR, from a trusted login in any case, once it has stood for THREAD_SETTLE_MS.
 */
export function fakeRepoHost(): RepoHost & {
  prs: FakePr[];
  checks: Map<string, Status>;
  files: Map<string, string>;
  heads: Map<string, string>;
  branches: Map<string, string[]>;
  reviewComments: Map<string, (ReviewComment & { resolved?: boolean; submittedAt?: string })[]>;
} {
  const prs: FakePr[] = [];
  const checks = new Map<string, Status>();
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
    prs, checks, files, heads, branches, reviewComments,
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
    async onBranch(repo, branch, sha) {
      return branches.get(`${repo}@${branch}`)?.includes(sha) ?? false;
    },
    async requestReviewers(repo, n, fallback) {
      pr(repo, n).reviewers = [...fallback];
      return [...fallback];
    },
    async prState(repo, n, trustedLogins) {
      const p = pr(repo, n);
      const settled = Date.now() - THREAD_SETTLE_MS;
      const trusted = new Set(trustedLogins.map(loginKey));
      const open = (p.open ? reviewComments.get(`${repo}#${n}`) ?? [] : [])
        .filter((c) => !c.resolved && c.submittedAt && Date.parse(c.submittedAt) <= settled && trusted.has(loginKey(c.author))).map((c) => c.submittedAt!);
      const requested = [...p.reviews.filter((r) => r.state === "changes_requested" && trusted.has(loginKey(r.author))).map((r) => r.submittedAt), ...open].sort();
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
    async postReview() {
      throw new Error("postReview is not implemented yet (PBI 129)");
    },
    async resolveThread() {
      throw new Error("resolveThread is not implemented yet (PBI 129)");
    },
  };
}
