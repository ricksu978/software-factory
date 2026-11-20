// Step definitions for features/pbi-278-spa-shell.feature.
//
// Where the SPA lives, as these steps read it:
//   web/                      the SPA's Vite project: web/index.html, web/src/** and web/components.json, shadcn/ui's
//                             configuration, whose aliases.ui is "@/components/ui", that is web/src/components/ui.
//   web/src/shell.ts          the SPA's shell, free of React and the browser's globals: startShell(env) marks the page
//                             dark or not, checks the session, and shows a page or sends the browser away. The steps
//                             start it in this process against stand-ins for fetch, matchMedia, the root element,
//                             location.assign and the page it shows.
//   web/dist/                 where `npm run build` writes the built page, index.html, and the script and stylesheet
//                             it names. The BFF serves these files.
// "The SPA has been built" runs `npm run build` in the repo, once per test run. "The BFF is running on 7403" runs
// `node src/bff/main.ts` as PBI 288's steps do (features/steps/pbi-288.steps.ts), on a free port rather than 7403 so a
// running factory doesn't get in the way, after checking 7403 is the BFF's own port. No scenario signs in, so the BFF
// gets a database address nothing answers on. "A browser opens {string}" is PBI 288's step, which opens a path on that
// BFF with no session and records the answer, "the command exits {int}" is PBI 5's, and "the page says {string}" is
// PBI 19's, given the text of the no-access page the shell shows.
// The source checks read every file under web/ but web/dist and web/node_modules. A check that something is absent
// first checks that what it looks through is the SPA's, so it can't pass on a source that isn't there yet.
import { After, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { ctx as shared, freePort, openOnBff, startBff, stopBff, type Seen } from "./pbi-288.steps.ts";
import { ctx as pageCtx } from "./pbi-19.steps.ts";
import { ctx as scriptCtx, tail } from "./pbi-5.steps.ts";
import { load, long } from "./pbi-8.steps.ts";

const repo = process.cwd();
const WEB = "web";
const DIST = join(WEB, "dist");
const UI = join(WEB, "src", "components", "ui");
const SHELL = join(WEB, "src", "shell.ts");
const DARK_QUERY = "(prefers-color-scheme: dark)";
const NO_SESSION_DB = "postgres://nobody:nothing@127.0.0.1:1/none";

// ---- The shell's shape, as web/src/shell.ts declares it ----

type ShellPage = { kind: "app" } | { kind: "no-access"; text: string };
type Listener = (e: { matches: boolean }) => void;
type ShellEnv = {
  fetch: typeof fetch;
  matchMedia(query: string): { readonly matches: boolean; addEventListener(type: "change", listener: Listener): void };
  root: { classList: { add(t: string): void; remove(t: string): void; toggle(t: string, force?: boolean): boolean; contains(t: string): boolean } };
  navigate(url: string): void;
  show(page: ShellPage): void;
};
type Shell = { call(path: string, init?: RequestInit): Promise<Response> };
type ShellModule = { startShell(env: ShellEnv): Promise<Shell> };

/** Stand-ins for the browser the shell runs in, and what the shell did with them. */
type Fake = {
  osDark: boolean;
  status: number;
  calls: string[];
  queries: string[];
  listeners: Listener[];
  classes: Set<string>;
  navigations: string[];
  shown: ShellPage[];
  /** Whether the page was marked dark just before the operating system's setting changed. */
  markedBeforeChange?: boolean;
  changedFrom?: boolean;
};

type Ctx = {
  fake?: Fake;
  shell?: Shell;
  callError?: unknown;
  navigationsBeforeCall?: number;
  source?: Map<string, string>;
  css?: string;
  scratch?: string;
  sourceFile?: string;
  missing?: string;
  scripted?: { path: string; file: string; seen: Seen }[];
};

function ctx(world: object): Ctx {
  const w = world as { pbi278?: Ctx };
  w.pbi278 ??= {};
  return w.pbi278;
}

After({ tags: "@pbi-278", ...long }, async function () {
  await stopBff(shared(this));
  const c = ctx(this);
  if (c.scratch) rmSync(c.scratch, { recursive: true, force: true });
});

// ---- Files ----

function walk(dir: string, skip: (rel: string) => boolean, root = dir, into = new Map<string, string>()): Map<string, string> {
  if (!existsSync(dir)) return into;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(root, full).split(sep).join("/");
    if (skip(rel)) continue;
    if (statSync(full).isDirectory()) walk(full, skip, root, into);
    else into.set(rel, readFileSync(full, "utf8"));
  }
  return into;
}

/** The SPA's source, by path under web/: everything but the build, installed packages and lock files. */
function spaSource(): Map<string, string> {
  return walk(join(repo, WEB), (rel) => /^(dist|node_modules)(\/|$)/.test(rel) || rel.endsWith(".tsbuildinfo"));
}

const isCode = (rel: string) => /\.(tsx?|jsx?|mts|cts)$/.test(rel);
const isUi = (rel: string) => rel.startsWith("src/components/ui/");

function readText(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** The scripts and stylesheets a page names, as paths. */
function named(page: string): { scripts: string[]; styles: string[] } {
  const scripts = [...page.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)].map((m) => m[1]);
  const styles = [...page.matchAll(/<link\b[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => /\brel=["']?stylesheet/.test(tag))
    .map((tag) => /\bhref=["']([^"']+)["']/.exec(tag)?.[1])
    .filter((h): h is string => !!h);
  return { scripts, styles };
}

/** The file under `dist` that a path the page names maps to. */
const builtFile = (dist: string, path: string) => join(dist, ...new URL(path, "http://spa").pathname.split("/").filter(Boolean));

const builtPage = () => readText(join(repo, DIST, "index.html"));

function needBuiltPage(): string {
  const page = builtPage();
  assert.ok(page !== undefined, `the build wrote no ${DIST}/index.html`);
  return page;
}

function builtStylesheet(): string {
  const page = builtPage();
  if (page === undefined) return "";
  return named(page).styles.map((s) => readText(builtFile(join(repo, DIST), s)) ?? "").join("\n");
}

// ---- The SPA has been built ----

let built: { status: number | null; out: string } | undefined;

Given("the SPA has been built", { timeout: 600_000 }, function () {
  if (!built) {
    const r = spawnSync("npm run build", { cwd: repo, shell: true, encoding: "utf8" });
    built = { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  }
  assert.equal(built.status, 0, `npm run build failed:\n${tail(built.out)}`);
});

// ---- The BFF ----

Given("the BFF is running on {int}", long, async function (port: number) {
  const settings = await load<{ BFF_PORT: number }>("src/bff/settings.ts");
  assert.equal(settings?.BFF_PORT, port, `the BFF's own port is ${settings?.BFF_PORT}`);
  const s = shared(this);
  s.port = await freePort();
  s.env = {
    FACTORY_DB_URI: NO_SESSION_DB,
    OIDC_ISSUER: "http://127.0.0.1:1/realms/none",
    OIDC_CLIENT_ID: "dashboard",
    OIDC_SCOPES: "openid",
    BFF_SESSION_KEY: randomBytes(32).toString("base64"),
    PORT: String(s.port),
    BFF_ORIGIN: `http://localhost:${s.port}`,
  };
  await startBff(s);
});

When("a browser with no session opens {string}", async function (path: string) {
  await openOnBff(shared(this), path);
});

When("the same browser calls GET {string}", async function (path: string) {
  await openOnBff(shared(this), path);
});

When("a browser with no session opens each script and stylesheet the SPA's page names", async function () {
  const c = ctx(this);
  c.scripted = [];
  const page = builtPage();
  if (page === undefined) return;
  const { scripts, styles } = named(page);
  for (const path of [...scripts, ...styles]) {
    const seen = await openOnBff(shared(this), path);
    c.scripted.push({ path, file: builtFile(join(repo, DIST), path), seen });
  }
});

When("a browser opens a script under the SPA's built files that the build didn't write", async function () {
  const page = builtPage();
  const script = page === undefined ? undefined : named(page).scripts[0];
  // Beside the built script, so it is under the built files whichever folder the build puts scripts in.
  const dir = script ? new URL(".", new URL(script, "http://spa")).pathname : "/assets/";
  const path = `${dir}not-built-${randomBytes(6).toString("hex")}.js`;
  assert.ok(!existsSync(builtFile(join(repo, DIST), path)), `${path} was built`);
  ctx(this).missing = path;
  await openOnBff(shared(this), path);
});

When("a browser opens the address of one of the SPA's source files", async function () {
  // The address Vite's dev server would serve it at: its path under web/.
  const file = SHELL;
  assert.ok(existsSync(join(repo, file)), `${file} doesn't exist`);
  ctx(this).sourceFile = file;
  await openOnBff(shared(this), `/${relative(WEB, file).split(sep).join("/")}`);
});

function answerFor(world: object, path: string): Seen {
  const seen = shared(world).opened.find((o) => o.url.pathname === new URL(path, "http://spa").pathname);
  assert.ok(seen, `no browser opened ${path}`);
  return seen;
}

function assertSpaPage(seen: Seen) {
  const page = needBuiltPage();
  assert.equal(seen.status, 200, `the BFF answered ${seen.status} for ${seen.url.pathname}: ${seen.body.slice(0, 300)}`);
  assert.equal(seen.body, page, `the BFF's answer for ${seen.url.pathname} isn't the SPA's built page`);
  assert.match(seen.headers.get("content-type") ?? "", /^text\/html/, "the SPA's page isn't served as HTML");
}

function assertNotSpaPage(seen: Seen) {
  const page = builtPage();
  if (page !== undefined) assert.notEqual(seen.body, page, `the BFF answered ${seen.url.pathname} with the SPA's page`);
  assert.doesNotMatch(seen.body, /<div id="root"/, `the BFF answered ${seen.url.pathname} with a page that looks like the SPA's`);
}

Then("the BFF answers 200 with the SPA's page", function () {
  const opened = shared(this).opened;
  assert.ok(opened.length, "no browser opened anything");
  assertSpaPage(opened[opened.length - 1]);
});

Then("the BFF answers 200 with the SPA's page for {string}", function (path: string) {
  assertSpaPage(answerFor(this, path));
});

Then("the page loads the SPA's built script and stylesheet", function () {
  const opened = shared(this).opened;
  const page = opened[opened.length - 1].body;
  const { scripts, styles } = named(page);
  assert.ok(scripts.length, "the page names no script");
  assert.ok(styles.length, "the page names no stylesheet");
  for (const path of [...scripts, ...styles]) {
    assert.ok(existsSync(builtFile(join(repo, DIST), path)), `the page names ${path}, which the build didn't write`);
  }
  assert.ok(scripts.some((s) => s.endsWith(".js")), `none of the page's scripts is a built .js file: ${scripts.join(", ")}`);
  assert.ok(styles.some((s) => s.endsWith(".css")), `none of the page's stylesheets is a built .css file: ${styles.join(", ")}`);
});

Then("the BFF answers 200 for each, with the file's built contents", function () {
  const scripted = ctx(this).scripted ?? [];
  assert.ok(scripted.length, "the SPA's built page names no script or stylesheet to open");
  for (const { path, file, seen } of scripted) {
    assert.equal(seen.status, 200, `the BFF answered ${seen.status} for ${path}`);
    assert.equal(seen.body, readFileSync(file, "utf8"), `the BFF's answer for ${path} isn't the built file`);
  }
});

Then("the BFF answers 404 for the missing script, not with the SPA's page", function () {
  const path = ctx(this).missing;
  assert.ok(path, "no browser opened a missing script");
  const seen = answerFor(this, path);
  assert.equal(seen.status, 404, `the BFF answered ${seen.status} for ${path}`);
  assertNotSpaPage(seen);
});

Then("the BFF answers {int} for {string}, not with the SPA's page", function (status: number, path: string) {
  const seen = answerFor(this, path);
  assert.equal(seen.status, status, `the BFF answered ${seen.status} for ${path}: ${seen.body.slice(0, 300)}`);
  assertNotSpaPage(seen);
});

Then("neither of the other answers holds the file's contents", function () {
  const c = ctx(this);
  assert.ok(c.sourceFile, "no browser opened a source file");
  const checks = [
    { path: `/${relative(WEB, c.sourceFile).split(sep).join("/")}`, contents: readFileSync(join(repo, c.sourceFile), "utf8") },
    { path: "/package.json", contents: readFileSync(join(repo, "package.json"), "utf8") },
  ];
  for (const { path, contents } of checks) {
    const seen = answerFor(this, path);
    assert.ok(!seen.body.includes(contents.trim()), `the BFF answered ${path} with the file's contents`);
    const firstLine = contents.split("\n").find((l) => l.trim().length > 20)?.trim();
    if (firstLine) assert.ok(!seen.body.includes(firstLine), `the BFF's answer for ${path} holds part of the file`);
  }
});

// ---- Reading the SPA's source ----

When("I read the SPA's source", function () {
  ctx(this).source = spaSource();
});

When("I read the SPA's source outside its shadcn\\/ui components", function () {
  ctx(this).source = new Map([...spaSource()].filter(([rel]) => !isUi(rel)));
});

function source(world: object): Map<string, string> {
  const s = ctx(world).source;
  assert.ok(s, "the SPA's source wasn't read");
  return s;
}

/** Checks the source read holds the SPA: its page, and the script that page loads, under src/. */
function assertIsTheSpa(src: Map<string, string>) {
  const page = src.get("index.html");
  assert.ok(page !== undefined, `the SPA has no page, ${WEB}/index.html`);
  const { scripts } = named(page);
  const entry = scripts.map((s) => s.replace(/^\//, "")).find((s) => s.startsWith("src/"));
  assert.ok(entry, `${WEB}/index.html loads no script from ${WEB}/src`);
  assert.ok(src.has(entry), `${WEB}/index.html loads ${entry}, which doesn't exist`);
}

/** The addresses the code calls or sends the browser to: the first argument of fetch, the shell's call, location's
 * assign and replace, and what is given to location or an href. */
function addresses(src: Map<string, string>): { file: string; address: string }[] {
  const found: { file: string; address: string }[] = [];
  const patterns = [
    /\b(?:fetch|call|assign|replace|get|post|put|patch|del|request)\s*(?:<[^>]*>)?\s*\(\s*(["'`])((?:\/|https?:|wss?:)[^"'`$]*)/g,
    /\b(?:href|location|action|src)\s*=\s*\{?\s*(["'`])((?:\/|https?:|wss?:)[^"'`$]*)/g,
  ];
  for (const [file, text] of src) {
    if (!isCode(file)) continue;
    for (const re of patterns) for (const m of text.matchAll(re)) found.push({ file, address: m[2] });
  }
  return found;
}

Then("it calls at least one address under {string}", function (prefix: string) {
  const calls = addresses(source(this));
  assert.ok(calls.some((c) => c.address.startsWith(prefix)), `the SPA calls nothing under ${prefix}: ${JSON.stringify(calls)}`);
});

Then("every address it calls or sends the browser to starts with {string} or {string}", function (a: string, b: string) {
  const calls = addresses(source(this));
  assert.ok(calls.length, "the SPA calls nothing");
  const others = calls.filter((c) => !c.address.startsWith(a) && !c.address.startsWith(b));
  assert.deepEqual(others, [], `the SPA calls or sends the browser to addresses outside ${a} and ${b}`);
});

Then("it names no address on port {int} or {int}", function (p1: number, p2: number) {
  const src = source(this);
  assertIsTheSpa(src);
  const re = new RegExp(`(?:localhost|127\\.0\\.0\\.1|\\[::1\\]|[\\w.-]+):(?:${p1}|${p2})\\b|\\bport\\s*[:=]\\s*(?:${p1}|${p2})\\b`);
  const hits = [...src].filter(([, text]) => re.test(text)).map(([file]) => file);
  assert.deepEqual(hits, [], `the SPA names an address on port ${p1} or ${p2}`);
});

Then("it names no address with a scheme and host of its own", function () {
  const src = source(this);
  assertIsTheSpa(src);
  const allowed = /^(https?:\/\/(ui\.shadcn\.com|www\.w3\.org|json\.schemastore\.org)\b)/;
  const hits: string[] = [];
  for (const [file, text] of src) {
    if (!isCode(file) && file !== "index.html") continue;
    for (const m of text.matchAll(/\b(?:https?|wss?):\/\/[^\s"'`)<>]+/g)) if (!allowed.test(m[0])) hits.push(`${file}: ${m[0]}`);
  }
  assert.deepEqual(hits, [], "the SPA names addresses with a scheme and host");
});

// ---- shadcn/ui ----

const COMPONENTS: Record<string, string> = {
  table: "Table", badge: "Badge", button: "Button", input: "Input", textarea: "Textarea", alert: "Alert",
};

Then("it has a shadcn\\/ui configuration", function () {
  const text = source(this).get("components.json");
  assert.ok(text !== undefined, `the SPA has no shadcn/ui configuration, ${WEB}/components.json`);
  const cfg = JSON.parse(text) as { $schema?: string; tailwind?: { cssVariables?: boolean; css?: string }; aliases?: { ui?: string } };
  assert.match(cfg.$schema ?? "", /ui\.shadcn\.com/, "components.json isn't shadcn/ui's");
  assert.equal(cfg.tailwind?.cssVariables, true, "shadcn/ui isn't themed through CSS variables");
  assert.equal(cfg.aliases?.ui, "@/components/ui", "shadcn/ui's components aren't kept in src/components/ui");
});

Then("it keeps shadcn\\/ui's table, badge, button, input, textarea and alert components in the repo", function () {
  const src = source(this);
  for (const [name, exported] of Object.entries(COMPONENTS)) {
    const text = src.get(`src/components/ui/${name}.tsx`);
    assert.ok(text !== undefined, `${UI}/${name}.tsx doesn't exist`);
    assert.match(text, new RegExp(`export\\s*\\{[^}]*\\b${exported}\\b|export\\s+(?:function|const)\\s+${exported}\\b`), `${name}.tsx doesn't export ${exported}`);
  }
  const tracked = spawnSync("git", ["ls-files", "--error-unmatch", ...Object.keys(COMPONENTS).map((n) => `${UI}/${n}.tsx`)], { cwd: repo, encoding: "utf8" });
  assert.equal(tracked.status, 0, `the components aren't all kept in the repo: ${tracked.stderr}`);
});

Then("it draws no table, button, input or text area element of its own", function () {
  const src = source(this);
  const code = [...src].filter(([file]) => /\.(tsx|jsx)$/.test(file));
  const usesUi = code.filter(([, text]) => /from\s+["'](?:@\/components\/ui|(?:\.\.?\/)+(?:components\/)?ui)\/(table|badge|button|input|textarea|alert)["']/.test(text));
  assert.ok(usesUi.length, "none of the SPA's pages uses a shadcn/ui component");
  const own = /<(table|thead|tbody|tr|td|th|button|input|textarea)\b|createElement\(\s*["'](table|button|input|textarea)["']/;
  const hits = code.filter(([, text]) => own.test(text)).map(([file]) => file);
  assert.deepEqual(hits, [], "these files draw a table, button, input or text area of their own");
});

Then("its banners use the shadcn\\/ui alert component", function () {
  const code = [...source(this)].filter(([file]) => /\.(tsx|jsx)$/.test(file));
  assert.ok(code.some(([, text]) => /<Alert\b/.test(text)), "no page draws a banner with the shadcn/ui Alert");
  const hits = code.filter(([, text]) => /role=["'](alert|status)["']|className=["'][^"']*\b(banner|alert)\b/.test(text)).map(([f]) => f);
  assert.deepEqual(hits, [], "these files draw a banner of their own");
});

Then("its badges use the shadcn\\/ui badge component", function () {
  const code = [...source(this)].filter(([file]) => /\.(tsx|jsx)$/.test(file));
  assert.ok(code.some(([, text]) => /<Badge\b/.test(text)), "no page draws a badge with the shadcn/ui Badge");
  const hits = code.filter(([, text]) => /className=["'][^"']*\b(badge|pill|tag)\b/.test(text)).map(([f]) => f);
  assert.deepEqual(hits, [], "these files draw a badge of their own");
});

When("I read the SPA's built stylesheet", function () {
  ctx(this).css = builtStylesheet();
});

/** The custom properties a CSS rule sets, for rules whose selector list holds `selector`. */
function variables(css: string, selector: string): Map<string, string> {
  const vars = new Map<string, string>();
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(",").map((s) => s.trim());
    if (!selectors.includes(selector)) continue;
    for (const d of m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) vars.set(d[1], d[2].trim());
  }
  return vars;
}

const THEME = ["background", "foreground", "primary", "muted", "border", "destructive"];
const THEME_ALL = [
  "background", "foreground", "card-foreground", "card", "popover-foreground", "popover", "primary-foreground", "primary",
  "secondary-foreground", "secondary", "muted-foreground", "muted", "accent-foreground", "accent", "destructive-foreground",
  "destructive", "border", "input", "ring",
];

Then("it defines shadcn's colour variables, including background, foreground, primary, muted, border and destructive", function () {
  const css = ctx(this).css ?? "";
  assert.ok(css.length, "the build wrote no stylesheet the SPA's page loads");
  const root = variables(css, ":root");
  for (const name of THEME) assert.ok(root.has(`--${name}`), `the built stylesheet doesn't define --${name} on :root`);
});

Then("the shadcn\\/ui components take their colours from those variables", function () {
  const css = (ctx(this).css ?? "").replace(/\\/g, "");
  const used = new RegExp(`(?<![\\w:/-])(bg|text|border)-(${THEME_ALL.join("|")})(?![\\w/-])`, "g");
  for (const name of Object.keys(COMPONENTS)) {
    const text = readText(join(repo, UI, `${name}.tsx`));
    assert.ok(text !== undefined, `${UI}/${name}.tsx doesn't exist`);
    const classes = [...new Set([...text.matchAll(used)].map((m) => m[0]))];
    assert.ok(classes.length, `${name}.tsx takes no colour from shadcn's variables`);
    for (const cls of classes) {
      const colour = cls.replace(/^(bg|text|border)-/, "");
      const rule = new RegExp(`\\.${cls.replace(/[-]/g, "\\-")}\\s*\\{([^}]*)\\}`).exec(css);
      assert.ok(rule, `the built stylesheet has no .${cls}, which ${name}.tsx uses`);
      const via = rule[1].match(/var\((--[\w-]+)/)?.[1];
      assert.ok(via === `--${colour}` || via === `--color-${colour}`, `.${cls} takes its colour from ${via ?? "no variable"}`);
      if (via === `--color-${colour}`) {
        assert.match(css, new RegExp(`--color-${colour}\\s*:\\s*var\\(--${colour}\\)`), `--color-${colour} isn't shadcn's --${colour}`);
      }
    }
  }
});

// ---- Dark mode ----

function newFake(): Fake {
  return { osDark: false, status: 200, calls: [], queries: [], listeners: [], classes: new Set(), navigations: [], shown: [] };
}

function fake(world: object): Fake {
  const c = ctx(world);
  c.fake ??= newFake();
  return c.fake;
}

const sameQuery = (q: string) => q.replace(/\s+/g, "") === DARK_QUERY.replace(/\s+/g, "");

function env(f: Fake): ShellEnv {
  return {
    fetch: (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      f.calls.push(url);
      const body = f.status === 200 ? { issuer: "https://issuer.example", subject: "someone" } : { error: `answered ${f.status}` };
      return new Response(JSON.stringify(body), { status: f.status, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
    matchMedia(query: string) {
      f.queries.push(query);
      return {
        get matches() {
          return sameQuery(query) ? f.osDark : false;
        },
        media: query,
        addEventListener(type: string, listener: Listener) {
          if (type === "change" && sameQuery(query)) f.listeners.push(listener);
        },
        removeEventListener(_type: string, listener: Listener) {
          f.listeners = f.listeners.filter((l) => l !== listener);
        },
        addListener(listener: Listener) {
          if (sameQuery(query)) f.listeners.push(listener);
        },
        removeListener(listener: Listener) {
          f.listeners = f.listeners.filter((l) => l !== listener);
        },
      };
    },
    root: {
      classList: {
        add: (t: string) => void f.classes.add(t),
        remove: (t: string) => void f.classes.delete(t),
        toggle: (t: string, force?: boolean) => {
          const on = force ?? !f.classes.has(t);
          if (on) f.classes.add(t);
          else f.classes.delete(t);
          return on;
        },
        contains: (t: string) => f.classes.has(t),
      },
    },
    navigate: (url: string) => void f.navigations.push(url),
    show: (page: ShellPage) => void f.shown.push(page),
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function start(world: object): Promise<void> {
  const m = await load<ShellModule>(SHELL);
  assert.ok(m, `${SHELL} doesn't exist`);
  ctx(world).shell = await m.startShell(env(fake(world)));
  await settle();
}

Given("the operating system's colour scheme is {word}", function (scheme: string) {
  assert.ok(scheme === "dark" || scheme === "light", `no colour scheme ${scheme}`);
  fake(this).osDark = scheme === "dark";
});

When("the SPA starts", async function () {
  await start(this);
});

Given("the SPA has started", async function () {
  await start(this);
  assert.ok(ctx(this).shell, "the SPA's shell didn't start");
});

When("the operating system's colour scheme changes to {word}", async function (scheme: string) {
  const f = fake(this);
  f.changedFrom = f.osDark;
  f.markedBeforeChange = f.classes.has("dark");
  f.osDark = scheme === "dark";
  for (const l of [...f.listeners]) l({ matches: f.osDark });
  await settle();
});

Then("the SPA asks the operating system whether its colour scheme is dark", function () {
  const f = fake(this);
  assert.ok(f.queries.some(sameQuery), `the SPA asked matchMedia for ${JSON.stringify(f.queries)}, not ${DARK_QUERY}`);
});

Then("the SPA marks the page as dark", function () {
  const f = fake(this);
  if (f.changedFrom !== undefined) {
    assert.equal(f.markedBeforeChange, f.changedFrom, `before the change, the page was ${f.markedBeforeChange ? "" : "not "}marked dark`);
  }
  assert.ok(f.classes.has("dark"), `the page's root has the classes ${JSON.stringify([...f.classes])}, not "dark"`);
});

Then("the SPA doesn't mark the page as dark", function () {
  const f = fake(this);
  if (f.changedFrom !== undefined) {
    assert.equal(f.markedBeforeChange, f.changedFrom, `before the change, the page was ${f.markedBeforeChange ? "" : "not "}marked dark`);
    assert.ok(f.listeners.length, "the SPA doesn't listen for the operating system's colour scheme changing");
  }
  assert.ok(!f.classes.has("dark"), "the page's root is marked dark");
});

/** The relative lightness of a CSS colour, from 0 to 1, for the forms shadcn's themes use. */
function lightness(value: string): number {
  const v = value.trim().toLowerCase();
  let m = /^oklch\(\s*([\d.]+)(%?)/.exec(v);
  if (m) return Number(m[1]) / (m[2] ? 100 : 1);
  m = /^(?:hsla?\()?\s*[\d.]+(?:deg)?[\s,]+[\d.]+%[\s,]+([\d.]+)%/.exec(v);
  if (m) return Number(m[1]) / 100;
  m = /^#([0-9a-f]{3,8})$/.exec(v);
  if (m) {
    const h = m[1].length < 6 ? [...m[1].slice(0, 3)].map((x) => x + x).join("") : m[1].slice(0, 6);
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
    return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(v);
  if (m) {
    const [r, g, b] = [m[1], m[2], m[3]].map((x) => Number(x) / 255);
    return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
  }
  if (v === "white") return 1;
  if (v === "black") return 0;
  assert.fail(`can't read the colour ${value}`);
}

function schemeColours(selector: string): { background: string; foreground: string } {
  const css = builtStylesheet();
  assert.ok(css.length, "the build wrote no stylesheet the SPA's page loads");
  const vars = variables(css, selector);
  const background = vars.get("--background");
  const foreground = vars.get("--foreground");
  assert.ok(background && foreground, `the built stylesheet doesn't set --background and --foreground on ${selector}`);
  return { background, foreground };
}

Then("the SPA's built stylesheet gives shadcn's background and foreground variables their dark values on a page marked dark", function () {
  const dark = schemeColours(".dark");
  const light = schemeColours(":root");
  assert.notEqual(dark.background, light.background, "a page marked dark has the light background");
  assert.ok(lightness(dark.background) < lightness(dark.foreground), `on a page marked dark the background ${dark.background} is lighter than the text ${dark.foreground}`);
  assert.ok(lightness(dark.background) < 0.5, `the dark background ${dark.background} isn't dark`);
});

Then("the SPA's built stylesheet gives shadcn's background and foreground variables their light values on a page not marked dark", function () {
  const light = schemeColours(":root");
  const dark = schemeColours(".dark");
  assert.notEqual(dark.background, light.background, "a page not marked dark has the dark background");
  assert.ok(lightness(light.background) > lightness(light.foreground), `on a page not marked dark the background ${light.background} is darker than the text ${light.foreground}`);
  assert.ok(lightness(light.background) > 0.5, `the light background ${light.background} isn't light`);
});

Then("it keeps no dark-mode choice of its own in storage or a cookie", function () {
  const src = source(this);
  const code = [...src].filter(([file]) => isCode(file));
  assert.ok(code.some(([, text]) => text.includes(DARK_QUERY)), `the SPA doesn't ask the operating system for ${DARK_QUERY}`);
  const stored = /(localStorage|sessionStorage|document\.cookie|indexedDB|cookieStore)/;
  const hits: string[] = [];
  for (const [file, text] of code) {
    if (!stored.test(text)) continue;
    for (const line of text.split("\n")) if (stored.test(line) && /theme|dark|light|scheme|colou?r|mode/i.test(line)) hits.push(`${file}: ${line.trim()}`);
  }
  assert.deepEqual(hits, [], "the SPA keeps a dark-mode choice of its own");
});

Then("it offers no control that switches between dark and light", function () {
  const code = [...source(this)].filter(([file]) => isCode(file));
  const marks = code.filter(([, text]) => /classList\.(add|remove|toggle)\(\s*["'`]dark["'`]/.test(text));
  assert.ok(marks.length, "nothing in the SPA marks the page dark");
  for (const [file, text] of marks) assert.ok(text.includes(DARK_QUERY), `${file} marks the page dark without asking the operating system`);
  const control = /(theme|mode|dark|light)[-_ ]?(toggle|switch|picker|select)|Toggle(Theme|Dark|Mode)|(Dark|Light) mode|setTheme|useTheme|next-themes/i;
  const hits = code.filter(([file, text]) => !isUi(file) && control.test(text)).map(([file]) => file);
  assert.deepEqual(hits, [], "these files offer a control that switches between dark and light");
});

// ---- Session handling ----

Given("the BFF answers {int} to the SPA's calls", function (status: number) {
  fake(this).status = status;
});

Given("the BFF answers the SPA's calls with {int}", function (status: number) {
  fake(this).status = status;
});

Given("the SPA has started with a session", async function () {
  fake(this).status = 200;
  await start(this);
  assert.ok(ctx(this).shell, "the SPA's shell didn't start");
});

Given("the BFF now answers {int} to the SPA's calls", function (status: number) {
  fake(this).status = status;
});

When("the SPA makes its next call to {string}", async function (path: string) {
  const c = ctx(this);
  assert.ok(c.shell, "the SPA hasn't started");
  c.navigationsBeforeCall = fake(this).navigations.length;
  try {
    await c.shell.call(path);
  } catch (e) {
    // A call the shell turns into sending the browser away may reject; what it did is what the Then checks.
    c.callError = e;
  }
  await settle();
});

const pathOf = (url: string) => new URL(url, "http://spa").pathname;

Then("the SPA sends the browser to {string}", function (path: string) {
  const c = ctx(this);
  const f = fake(this);
  const after = f.navigations.slice(c.navigationsBeforeCall ?? 0);
  assert.ok(after.length, `the SPA sent the browser nowhere${c.callError ? `, and its call failed: ${String(c.callError)}` : ""}`);
  assert.equal(pathOf(after[after.length - 1]), path, `the SPA sent the browser to ${after.join(", ")}`);
  if (c.navigationsBeforeCall !== undefined) {
    assert.ok(f.calls.some((u) => pathOf(u) === "/bff/v1/floor"), `the SPA's next call didn't go to the BFF: ${f.calls.join(", ")}`);
  }
});

Then("the SPA shows its page", function () {
  const f = fake(this);
  assert.ok(f.calls.length, "the SPA made no call to the BFF");
  assert.ok(f.calls.every((u) => /^\/(bff\/v1|auth)\//.test(pathOf(u)) && !/^[a-z]+:/i.test(u)), `the SPA called ${f.calls.join(", ")}`);
  assert.deepEqual(f.shown.at(-1), { kind: "app" }, `the SPA showed ${JSON.stringify(f.shown)}`);
});

Then("the SPA doesn't send the browser anywhere", function () {
  assert.deepEqual(fake(this).navigations, [], "the SPA sent the browser away");
});

Then("it doesn't show the no-access page", function () {
  assert.ok(!fake(this).shown.some((p) => p.kind === "no-access"), "the SPA showed the no-access page");
});

Then("the SPA shows the no-access page", function () {
  const f = fake(this);
  const page = f.shown.at(-1);
  assert.ok(page?.kind === "no-access", `the SPA showed ${JSON.stringify(f.shown)}`);
  // "The page says {string}" is PBI 19's step, which reads the page it was given.
  pageCtx(this).page = page.text;
});

Then("the SPA doesn't send the browser to {string}", function (path: string) {
  const sent = fake(this).navigations.filter((u) => pathOf(u) === path);
  assert.deepEqual(sent, [], `the SPA sent the browser to ${path}`);
});

// ---- npm run build ----

/** A copy of the repo without its git history, installed packages or build, using the repo's installed packages. */
function scratchCopy(world: object): string {
  const dir = mkdtempSync(join(tmpdir(), "pbi-278-"));
  const skip = new Set([".git", "node_modules", "reports", "wt", ".aspire", join(WEB, "dist"), join(WEB, "node_modules")]);
  cpSync(repo, dir, {
    recursive: true,
    filter: (from) => {
      const rel = relative(repo, from);
      return !skip.has(rel) && !rel.split(sep).includes("node_modules");
    },
  });
  symlinkSync(join(repo, "node_modules"), join(dir, "node_modules"), "junction");
  if (existsSync(join(repo, WEB, "node_modules"))) symlinkSync(join(repo, WEB, "node_modules"), join(dir, WEB, "node_modules"), "junction");
  ctx(world).scratch = dir;
  return dir;
}

Given(/^a scratch copy of the repo with its installed packages( and no built SPA)?$/, function (noBuild?: string) {
  const dir = scratchCopy(this);
  assert.ok(existsSync(join(dir, "package.json")), "the scratch copy has no package.json");
  assert.ok(existsSync(join(dir, "node_modules")), "the scratch copy has no installed packages");
  if (noBuild) assert.ok(!existsSync(join(dir, DIST)), `the scratch copy has a ${DIST}`);
});

Given("one of the SPA's source files in the scratch copy has a type error", function () {
  const c = ctx(this);
  assert.ok(c.scratch, "no scratch copy");
  const file = join(c.scratch, SHELL);
  assert.ok(existsSync(file), `${SHELL} doesn't exist`);
  appendFileSync(file, '\nexport const pbi278TypeError: number = "not a number";\n');
  c.sourceFile = SHELL;
  assert.match(readFileSync(file, "utf8"), /pbi278TypeError: number = "not a number"/);
});

When("I run {string} in the scratch copy", { timeout: 600_000 }, function (command: string) {
  const c = ctx(this);
  assert.ok(c.scratch, "no scratch copy");
  const r = spawnSync(command, { cwd: c.scratch, shell: true, encoding: "utf8" });
  scriptCtx(this).result = { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
});

Then("the command exits non-zero", function () {
  const r = scriptCtx(this).result;
  assert.ok(r, "no command ran");
  assert.ok(r.status !== 0 && r.status !== null, `the command exited ${r.status}:\n${tail(r.out)}`);
});

Then("the output names the file with the type error", function () {
  const c = ctx(this);
  const r = scriptCtx(this).result;
  assert.ok(r && c.sourceFile, "no command ran on a source file with a type error");
  const under = relative(WEB, c.sourceFile).split(sep).join("/");
  assert.ok(r.out.includes(under), `the output doesn't name ${under}:\n${tail(r.out)}`);
  assert.match(r.out, /error/i, `the output reports no error:\n${tail(r.out)}`);
});

Then("the scratch copy holds the SPA's built page, script and stylesheet where the BFF serves them from", function () {
  const c = ctx(this);
  assert.ok(c.scratch, "no scratch copy");
  const dist = join(c.scratch, DIST);
  const page = readText(join(dist, "index.html"));
  assert.ok(page !== undefined, `the build wrote no ${DIST}/index.html`);
  const { scripts, styles } = named(page);
  assert.ok(scripts.some((s) => s.endsWith(".js")), "the built page names no built script");
  assert.ok(styles.some((s) => s.endsWith(".css")), "the built page names no built stylesheet");
  for (const path of [...scripts, ...styles]) assert.ok(existsSync(builtFile(dist, path)), `the build didn't write ${path}`);
});
