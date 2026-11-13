// Every Aspire integration pin in aspire.config.json must exist on NuGet, or `aspire run` fails its package restore.
// It reads nuget.org, so it skips offline, except on GitHub Actions. A cell's commands run with CI=true and no network,
// so it keys on GITHUB_ACTIONS, which the cell's command env never carries.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const { packages } = JSON.parse(readFileSync(new URL("../aspire.config.json", import.meta.url), "utf8")) as { packages: Record<string, string> };

for (const [id, version] of Object.entries(packages)) {
  test(`${id} ${version} is published on nuget.org`, async (t) => {
    let r: Response;
    try {
      r = await fetch(`https://api.nuget.org/v3-flatcontainer/${id.toLowerCase()}/index.json`, { signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      if (process.env.GITHUB_ACTIONS) throw e;
      return t.skip(`nuget.org unreachable: ${(e as Error).message}`);
    }
    assert.equal(r.status, 200);
    const { versions } = (await r.json()) as { versions: string[] };
    assert.ok(versions.includes(version), `${id} has no ${version} on nuget.org`);
  });
}
