// Where an item's issue lives on GitHub, for today's dashboard (src/http/views.ts) and the SPA's pages (web/src/pages).

/**
 * The issue's address on GitHub, or null when its repo isn't known or its number isn't one, since a link to the wrong
 * issue is worse than none.
 */
export function issueUrl(repo: string | null, externalId: string): string | null {
  return repo && /^\d+$/.test(externalId) ? `https://github.com/${repo}/issues/${externalId}` : null;
}
