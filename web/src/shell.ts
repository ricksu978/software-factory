// The SPA's shell (redesign step 8a, 2026-11-07 design §04): what the SPA does before any page draws, kept free of React
// and of the browser's globals so it runs in Node against stand-ins.
//   - Dark mode follows the operating system: the shell asks matchMedia("(prefers-color-scheme: dark)"), marks the page
//     dark by putting the "dark" class on the root element, as shadcn/ui's theme expects, and follows a change while
//     the SPA is open. It keeps no choice of its own.
//   - Session handling: every call goes through the shell. A 401 sends the browser to /auth/login. A 403 shows the
//     no-access page. Otherwise the SPA shows its page.
// The browser's entry point passes the real fetch, window.matchMedia, document.documentElement, location.assign and the
// React root's render.

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

/** Starts the SPA: marks the page dark or not, checks the session, and shows a page or sends the browser away. */
export async function startShell(_env: ShellEnv): Promise<Shell> {
  return {
    call: async () => {
      throw new Error("not built yet");
    },
  };
}
