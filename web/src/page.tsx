// Which page the SPA renders for what the shell shows (redesign step 8a): the no-access page for a 403, App otherwise.
// web/src/main.tsx renders it, and web/src/page.test.ts renders it to a string to check both pages.
import { App } from "./App.tsx";
import { NoAccess } from "./pages/NoAccess.tsx";
import type { Shell, ShellPage } from "./shell.ts";

export function pageFor(shown: ShellPage, call: Shell["call"]) {
  return shown.kind === "no-access" ? <NoAccess text={shown.text} /> : <App call={call} />;
}
