// Which page the SPA renders for what the shell shows (redesign steps 8a and 8b): the no-access page for a 403, App
// otherwise, showing the page at `path`.
// web/src/main.tsx renders it, and web/src/page.test.ts renders it to a string to check both pages.
import { App } from "./App.tsx";
import { NoAccess } from "./pages/NoAccess.tsx";
import type { Shell, ShellPage } from "./shell.ts";

export function pageFor(shown: ShellPage, call: Shell["call"], path = "/") {
  return shown.kind === "no-access" ? <NoAccess text={shown.text} /> : <App call={call} path={path} />;
}
