import { readFileSync } from "node:fs";

/**
 * Fills GITHUB_APP_KEY from the `.pem` file GITHUB_APP_KEY_FILE names, unless the key is already set. Under
 * `aspire run` the AppHost passes the file's path (issue #207), because the dashboard's parameter form is one line and
 * a pasted key loses its line breaks there. Azure sets GITHUB_APP_KEY from Key Vault, which this leaves alone.
 */
export function loadAppKey(env: NodeJS.ProcessEnv): void {
  if (env.GITHUB_APP_KEY || !env.GITHUB_APP_KEY_FILE) return;
  // Trim the quotes Explorer's "Copy as path" adds.
  const path = env.GITHUB_APP_KEY_FILE.trim().replace(/^["']|["']$/g, "");
  try {
    env.GITHUB_APP_KEY = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`GITHUB_APP_KEY_FILE ${path} can't be read: ${e instanceof Error ? e.message : e}`);
  }
}
