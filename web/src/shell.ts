// The SPA's shell (redesign step 8a, 2026-11-07 design §04): what the SPA does before any page draws, kept free of React
// and of the browser's globals so it runs in Node against stand-ins.
//   - The colour scheme follows the operating system: the shell asks matchMedia("(prefers-color-scheme: dark)"), marks
//     the page dark by putting the "dark" class on the root element, as shadcn/ui's theme expects, and follows a change
//     while the SPA is open. It keeps no choice of its own.
//   - Session handling: every call goes through the shell, and only to /bff/v1/* or /auth/*. A 401 sends the browser to
//     /auth/login. A 403 on a read shows the no-access page, since the API answers 403 to every read by someone who
//     isn't one of the factory's users. A 403 on a state-changing call goes back to its caller, because there it can
//     also mean the person lacks the role for that action, or the call lacked the BFF's Origin.
// At start the shell reads /bff/v1/floor, which needs both a session and a user. Any answer but 401 or 403 shows the
// SPA's page, whose own pages report a failed read.
// The browser's entry point, web/src/main.tsx, passes the real fetch, window.matchMedia, document.documentElement,
// location.assign and a function that renders the page with React.

/** What the shell shows: the SPA's own page, or the no-access page with the text it says. */
export type ShellPage = { kind: "app" } | { kind: "no-access"; text: string };

/** The part of a MediaQueryList the shell uses. */
export type ColourScheme = {
  readonly matches: boolean;
  addEventListener(type: "change", listener: (e: { matches: boolean }) => void): void;
};

export type ShellEnv = {
  fetch: typeof fetch;
  matchMedia(query: string): ColourScheme;
  /** The page's root element, document.documentElement in the browser. */
  root: { classList: { add(token: string): void; remove(token: string): void; toggle(token: string, force?: boolean): boolean; contains(token: string): boolean } };
  /** Sends the browser to an address, location.assign in the browser. */
  navigate(url: string): void;
  show(page: ShellPage): void;
};

export type Shell = {
  /** Calls the BFF at `path`, under /bff/v1/ or /auth/, handling a 401 or 403 as the shell does at start. */
  call(path: string, init?: RequestInit): Promise<Response>;
};

export const DARK_QUERY = "(prefers-color-scheme: dark)";
export const LOGIN_PATH = "/auth/login";
/** The no-access page's text, the same as today's dashboard's (src/http/views.ts). */
export const NO_ACCESS_TEXT = "You don't have access to this factory. Ask an owner to add you.";
const READS = new Set(["GET", "HEAD"]);

/** Starts the SPA: marks the page dark or not, checks the session, and shows a page or sends the browser away. */
export async function startShell(env: ShellEnv): Promise<Shell> {
  const scheme = env.matchMedia(DARK_QUERY);
  const mark = (dark: boolean) => void env.root.classList.toggle("dark", dark);
  mark(scheme.matches);
  scheme.addEventListener("change", (e) => mark(e.matches));

  const call = async (path: string, init?: RequestInit): Promise<Response> => {
    if (!/^\/(bff\/v1|auth)\//.test(path)) throw new Error(`the SPA calls only /bff/v1/ or /auth/, not ${path}`);
    const r = await env.fetch(path, { credentials: "same-origin", ...init });
    if (r.status === 401) env.navigate(LOGIN_PATH);
    else if (r.status === 403 && READS.has((init?.method ?? "GET").toUpperCase())) env.show({ kind: "no-access", text: NO_ACCESS_TEXT });
    return r;
  };

  const r = await call("/bff/v1/floor");
  if (r.status !== 401 && r.status !== 403) env.show({ kind: "app" });
  return { call };
}
