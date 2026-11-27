// PBI 423: how the control plane reads a commit's check runs when one of them was cancelled. No step definitions here.
//
// The fakes of PBI 232, 233, 235, 260 and 292 say what CI concluded on a commit as success, failure or pending, the
// words the factory's reads answer in. A cancelled run is one GitHub reports as `completed` with the conclusion
// `cancelled`, and only the control plane's reading of GitHub's check runs says what it comes to. So a commit holding a
// cancelled run is read here through the real GitHub repo host, githubRepoHost, over a stub GitHub that answers the
// commit's check runs, no commit status and no log. That gives what each read answers for the commit:
//   status       what `checksOnSha` answers, which the cell API's `/checks`, the poller and the webhook read
//   failedChecks what `failedChecksOnSha` answers, the failed checks `/checks` names
//   ciChecks     what `ciChecksOnSha` answers, each check by name, which `/ci-checks` and the poller read; a check the
//                read answers as failed keeps the failing tests the scenario gave it
// A commit with no cancelled run is read as the fakes always read it, so every other feature's CI stays as it was.
import type { CiCheck } from "../../src/adapters/types.ts";
import { githubRepoHost } from "../../src/adapters/github/repo-host.ts";

export type Reported = { name: string; conclusion: "success" | "failure" | "pending" | "cancelled"; url: string; failingTests?: string[]; completedAt?: string };

export type Reading = { status: string; failedChecks: { name: string; url: string; log: string | null }[]; ciChecks: CiCheck[] };

export const hasCancelled = (list: readonly { conclusion: string }[]) => list.some((x) => x.conclusion === "cancelled");

const REPO = "acme/widgets";
const SHA = "ca9ce11ed0000000000000000000000000000423";

/** What the factory's reads answer for a commit whose check runs are `list`, through the real GitHub repo host. */
export async function realReading(list: readonly Reported[]): Promise<Reading> {
  const runs = list.map((x, i) => ({
    id: 42300 + i, name: x.name, head_sha: SHA,
    status: x.conclusion === "pending" ? "in_progress" : "completed",
    conclusion: x.conclusion === "pending" ? null : x.conclusion,
    html_url: x.url, details_url: x.url, completed_at: x.completedAt ?? null, app: { slug: "ci-reading" },
  }));
  const notFound = (what: string) => Object.assign(new Error(`404 ${what}`), { status: 404 });
  const request = async (route: string) => {
    if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") return { data: { total_count: runs.length, check_runs: runs } };
    if (route === "GET /repos/{owner}/{repo}/commits/{ref}/status") return { data: { total_count: 0, state: "pending", statuses: [] } };
    throw notFound(route);
  };
  const client = { request, graphql: async () => { throw notFound("graphql"); } };
  const host = githubRepoHost({ octokit: { request }, getInstallationOctokit: async () => client } as never, 1);
  const status = await host.checksOnSha(REPO, SHA);
  const failedChecks = status === "failure" ? await host.failedChecksOnSha(REPO, SHA) : [];
  const named = (await host.ciChecksOnSha(REPO, SHA)) ?? [];
  const ciChecks = named.map((c): CiCheck => {
    const given = list.find((x) => x.name === c.name && x.url === c.url);
    return { ...c, failingTests: c.conclusion === "failure" ? [...(given?.failingTests ?? [])] : [] };
  });
  return { status, failedChecks: failedChecks.map((f) => ({ name: f.name, url: f.url, log: f.log })), ciChecks };
}
