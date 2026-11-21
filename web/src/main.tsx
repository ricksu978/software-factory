// The SPA's entry point (redesign step 8a): starts the shell (web/src/shell.ts) with the browser's own fetch,
// matchMedia, root element and location, and renders whichever page the shell shows (web/src/page.tsx).
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { pageFor } from "./page.tsx";
import { startShell, type Shell, type ShellPage } from "./shell.ts";
import "./index.css";

const root = createRoot(document.getElementById("root")!);
let shell: Shell | undefined;
let shown: ShellPage | undefined;

function render() {
  if (!shell || !shown) return;
  root.render(<StrictMode>{pageFor(shown, shell.call)}</StrictMode>);
}

shell = await startShell({
  fetch: window.fetch.bind(window),
  matchMedia: (query) => window.matchMedia(query),
  root: document.documentElement,
  navigate: (url) => window.location.assign(url),
  show: (page) => {
    shown = page;
    render();
  },
});
render();
