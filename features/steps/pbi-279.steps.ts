// Step definitions for features/pbi-279-spa-floor-run-detail-phase0-activity.feature.
//
// What these steps drive, as web/src/api.ts lays it out:
//   web/src/api.ts             the shapes the pages read and send, and readFloor, readItem, readPhase0 and readActivity,
//                              each page's one read of the factory through the shell's call.
//   web/src/pages/Floor.tsx    Floor({ data, zone, now, message }) and submitFloorControls(call, button, reason).
//   web/src/pages/RunDetail.tsx RunDetail({ data, zone, now, message }), submitItemControls, submitSignOff and
//                              submitAnswer(call, item, button, text).
//   web/src/pages/Phase0.tsx   Phase0({ data }).
//   web/src/pages/Activity.tsx Activity({ data }).
// Node can't strip JSX, so Vite's SSR loader loads the pages with the SPA's own config, as web/src/page.test.ts does, and
// react-dom/server renders them to a string. The steps read that string as a tree of elements.
// The shell is the real one, web/src/shell.ts's startShell, started against a stubbed fetch that answers /auth/session,
// GET /bff/v1/floor, /bff/v1/items/{id}, /bff/v1/phase0 and /bff/v1/activity from this scenario's fixture data, and
// POST /bff/v1/overrides and /bff/v1/items/{id}/decisions as the API does, recording every request. A Given that says
// what the factory reports "after" a change makes the reads that follow an accepted POST answer that instead.
// Opening a page, or submitting a form, records a read or handler that throws rather than failing the step, and every
// Then about the page first checks that it opened, so a page that isn't built fails on its Then.
// What the page structure means here:
//   a section       a heading, h1 to h6, with that text, and what follows it up to the next heading as high
//   a banner        an element whose role is status or alert, read by its whole text
//   a badge         an element with data-slot="badge", shadcn/ui's Badge, or a class holding "badge"
//   a form          a <form> whose aria-label is its name, or else the first <form> in the section of that name
//   a label         a <label> whose for names the id of the input or textarea it labels
//   a table         its columns are its <th>s in <thead>, and its rows the <tr>s that hold <td>s
// Five of this feature's steps are other features' own, matched by their patterns: PBI 105's `item "X" is State` calls
// this file's itemIs, PBI 189's `the viewer's time zone is {string}` sets PBI 131's viewerZone, which these steps read,
// and PBI 140's `Floor shows {string}`, PBI 146's `Run detail shows {string}` and PBI 131's `{string} links to {string}`
// read the page this file renders, which it hands them through their own contexts.
import { AfterAll, Before, Given, Then, When, type DataTable } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createElement, type ComponentType } from "react";
import { renderToString } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";
import type {
  ActivityData, ActivityProps, Call, FloorData, FloorModule, FloorProps, ItemData, Phase0Data, Phase0Props, RunDetailModule, RunDetailProps, Submitted,
} from "../../web/src/api.ts";
import { startShell, type ShellPage } from "../../web/src/shell.ts";
import { long } from "./pbi-8.steps.ts";

const REPO = "acme/shop";
const WEB = join(import.meta.dirname, "..", "..", "web");

// ---- Vite's SSR loader, once per run ----

let vite: ViteDevServer | undefined;

async function load<T>(path: string): Promise<T> {
  vite ??= await createServer({
    configFile: join(WEB, "vite.config.ts"),
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    logLevel: "silent",
  });
  return (await vite.ssrLoadModule(path)) as T;
}

AfterAll(long, async function () {
  await vite?.close();
  vite = undefined;
});

type Api = {
  readFloor(call: Call): Promise<FloorData>;
  readItem(call: Call, id: string): Promise<ItemData>;
  readPhase0(call: Call): Promise<Phase0Data>;
  readActivity(call: Call): Promise<ActivityData>;
};
type Pages = {
  floor: FloorModule & { Floor: ComponentType<FloorProps> };
  item: RunDetailModule & { RunDetail: ComponentType<RunDetailProps> };
  phase0: { Phase0: ComponentType<Phase0Props> };
  activity: { Activity: ComponentType<ActivityProps> };
};
const api = () => load<Api>("/src/api.ts");
const floorModule = () => load<Pages["floor"]>("/src/pages/Floor.tsx");
const itemModule = () => load<Pages["item"]>("/src/pages/RunDetail.tsx");

// ---- the scenario's context ----

type Req = { method: string; path: string; body: unknown };
type Answer = { status: number; body: unknown };
export type PageName = "floor" | "item" | "phase0" | "activity";

export type Ctx = {
  now: Date;
  roles: { operator: boolean; owner: boolean };
  named: Map<string, Named>;
  floor: FloorData;
  floorAfter?: (c: Ctx) => FloorData;
  items: Map<string, ItemData>;
  ext?: string;
  itemAfter?: (c: Ctx) => ItemData;
  phase0: Phase0Data;
  activity: ActivityData;
  overrideAnswer?: Answer;
  decisionAnswer?: Answer;
  requests: Req[];
  /** Set once a POST is accepted, so the reads that follow answer what the factory reports after it. */
  accepted: boolean;
  shown: ShellPage[];
  call?: Call;
  page?: PageName;
  data?: unknown;
  message?: string | null;
  error?: string;
  html: string;
  tree?: El;
  submitted?: { result?: Submitted<unknown>; error?: string };
  lastBanner?: El;
  lastRow?: El;
  /** The stage attempt the last step set up, for "that attempt". */
  lastStage?: ItemData["stages"][number];
  /** Where the shell sent the browser. */
  navigations: string[];
  /** PBI 280's: the SPA's clock, which the page's now reads when it's set. */
  clock?: () => Date;
  /** PBI 280's: what the factory reports for the floor, made from what it would otherwise report. */
  serveFloor?: (f: FloorData) => FloorData;
  /** PBI 280's: answers a request before this file's stub does, when it answers at all. */
  fetchHook?: (method: string, path: string, init?: RequestInit) => Response | undefined;
  /** PBI 280's: told each time a page opens, after it renders. */
  opened?: (page: PageName) => Promise<void>;
  /** PBI 280's: told each time a page renders. */
  rendered?: () => void;
};

type Named = { id: string; external_id: string; repo: string | null; title: string };

export function ctx(world: object): Ctx {
  const w = world as { pbi279?: Ctx };
  w.pbi279 ??= {
    now: new Date(),
    roles: { operator: false, owner: false },
    named: new Map(),
    floor: emptyFloor(),
    items: new Map(),
    phase0: { runs: [], readinessSpend: 0 },
    activity: { events: [] },
    requests: [],
    accepted: false,
    shown: [],
    html: "",
    navigations: [],
  };
  return w.pbi279;
}

Before({ tags: "@pbi-279" }, function () {
  const c = ctx(this);
  // PBI 105's `item "X" is State` hands a bare state to the world's itemIs.
  (this as { itemIs?: (name: string, state: string) => Promise<void> }).itemIs = async (name, state) => {
    situate(c, name, state);
  };
});

/** The viewer's IANA zone, which PBI 189's step keeps in PBI 131's context. */
const zoneOf = (world: object) => (world as { pbi131?: { viewerZone?: string } }).pbi131?.viewerZone ?? "UTC";

export function emptyFloor(): FloorData {
  return {
    active: [], waiting: [], waitingCount: 0, capacity: 3, next: [], notReady: [], blocked: [], factory: [], keys: {},
    finalStage: [], baseFails: [], mainBreaks: [], split: [], failed: [], restart: null, cellImage: null, canOperate: false,
    claudeToken: null, workerHeartbeat: null,
  };
}

/** "#41 Add search" as the factory names the item, the same id each time it's named. */
export function named(c: Ctx, label: string, repo: string | null = REPO): Named {
  const m = /^#(\d+)\s+(.+)$/.exec(label) ?? /^#(\d+)$/.exec(label);
  assert.ok(m, `"${label}" isn't "#N title"`);
  const known = c.named.get(m[1]);
  if (known) {
    if (m[2]) known.title = m[2];
    return known;
  }
  const n: Named = { id: `00000000-0000-4000-8000-${m[1].padStart(12, "0")}`, external_id: m[1], repo, title: m[2] ?? `Item ${m[1]}` };
  c.named.set(m[1], n);
  return n;
}

const iso = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(Date.UTC(y, mo - 1, d, h, mi)).toISOString();
const ago = (c: Ctx, ms: number) => new Date(c.now.getTime() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const issueUrl = (n: string) => `https://github.com/${REPO}/issues/${n}`;
const clone = <T>(x: T): T => structuredClone(x);

// ---- the stubbed fetch and the shell ----

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function servedFloor(c: Ctx): FloorData {
  const f = c.accepted && c.floorAfter ? c.floorAfter(c) : c.floor;
  return { ...(c.serveFloor ? c.serveFloor(clone(f)) : f), canOperate: c.roles.operator };
}

function servedItem(c: Ctx, d: ItemData): ItemData {
  const now = c.accepted && c.itemAfter && d.item.id === current(c).item.id ? c.itemAfter(c) : d;
  return { ...now, controls: c.roles.operator ? now.controls : null };
}

async function stubFetch(c: Ctx, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const path = new URL(String(input instanceof Request ? input.url : input), "http://spa.test").pathname;
  const method = (init?.method ?? "GET").toUpperCase();
  let body: unknown;
  if (init?.body !== undefined && init.body !== null) {
    try {
      body = JSON.parse(String(init.body));
    } catch {
      body = String(init.body);
    }
  }
  c.requests.push({ method, path, body });
  const hooked = c.fetchHook?.(method, path, init);
  if (hooked) return hooked;
  if (method === "GET" && path === "/auth/session") return json(200, { issuer: "https://login.test", subject: "octo" });
  if (method === "GET" && path === "/bff/v1/floor") return json(200, servedFloor(c));
  if (method === "GET" && path === "/bff/v1/phase0") return json(200, c.phase0);
  if (method === "GET" && path === "/bff/v1/activity") return json(200, c.activity);
  const item = /^\/bff\/v1\/items\/([^/]+)$/.exec(path);
  if (method === "GET" && item) {
    const d = [...c.items.values()].find((i) => i.item.id === item[1]);
    return d ? json(200, servedItem(c, d)) : json(404, { error: "no such item" });
  }
  if (method === "POST" && path === "/bff/v1/overrides") {
    const a = c.overrideAnswer ?? (c.roles.operator ? { status: 201, body: { ok: true } } : { status: 403, body: { error: "you can't override the factory" } });
    if (a.status < 300) c.accepted = true;
    return json(a.status, a.body);
  }
  const decision = /^\/bff\/v1\/items\/([^/]+)\/decisions$/.exec(path);
  if (method === "POST" && decision) {
    const a = c.decisionAnswer ?? { status: 200, body: { outcome: "applied" } };
    if (a.status < 300) c.accepted = true;
    return json(a.status, a.body);
  }
  return json(404, { error: "not found" });
}

async function shell(c: Ctx): Promise<Call> {
  if (c.call) return c.call;
  const root = { classList: { add() {}, remove() {}, toggle: () => false, contains: () => false } };
  const s = await startShell({
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => stubFetch(c, input, init)) as typeof fetch,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    root,
    navigate: (url) => c.navigations.push(url),
    show: (p) => c.shown.push(p),
  });
  c.call = s.call;
  return s.call;
}

// ---- opening and rendering a page ----

const message = (e: unknown) => (e instanceof Error ? e.stack ?? e.message : String(e));

export async function open(world: object, page: PageName): Promise<void> {
  const c = ctx(world);
  const call = await shell(c);
  c.page = page;
  c.message = null;
  c.submitted = undefined;
  try {
    const a = await api();
    c.data = page === "floor" ? await a.readFloor(call)
      : page === "item" ? await a.readItem(call, current(c).item.id)
      : page === "phase0" ? await a.readPhase0(call)
      : await a.readActivity(call);
    c.error = undefined;
  } catch (e) {
    c.data = undefined;
    c.error = `the page's read failed: ${message(e)}`;
  }
  await render(world);
  await c.opened?.(page);
}

export async function render(world: object): Promise<void> {
  const c = ctx(world);
  c.html = "";
  c.tree = undefined;
  if (c.clock) c.now = c.clock();
  if (c.data !== undefined && !c.error) {
    try {
      const zone = zoneOf(world);
      if (c.page === "floor") c.html = renderToString(createElement((await floorModule()).Floor, { data: c.data as FloorData, zone, now: c.now, message: c.message }));
      else if (c.page === "item") c.html = renderToString(createElement((await itemModule()).RunDetail, { data: c.data as ItemData, zone, now: c.now, message: c.message }));
      else if (c.page === "phase0") c.html = renderToString(createElement((await load<Pages["phase0"]>("/src/pages/Phase0.tsx")).Phase0, { data: c.data as Phase0Data }));
      else c.html = renderToString(createElement((await load<Pages["activity"]>("/src/pages/Activity.tsx")).Activity, { data: c.data as ActivityData }));
      c.tree = parse(c.html);
    } catch (e) {
      c.error = `the page didn't render: ${message(e)}`;
    }
  }
  // The other features' steps this feature shares read the page through their own contexts.
  const w = world as { pbi89?: { status?: number; html?: string }; pbi146?: { page?: string; status?: number }; pbi19?: { status?: number; page?: string } };
  const status = c.tree ? 200 : 500;
  const page = c.tree ? c.html : (c.error ?? "nothing rendered");
  if (c.page === "floor") w.pbi89 = { ...(w.pbi89 ?? {}), status, html: c.tree ? text(c.tree) : page };
  w.pbi146 = { ...(w.pbi146 ?? {}), status, page } as { page?: string; status?: number };
  w.pbi19 = { ...(w.pbi19 ?? {}), status, page };
  c.rendered?.();
}

const PAGE_NAMES: Record<PageName, string> = { floor: "Floor", item: "Run detail", phase0: "The Phase 0 report", activity: "Activity" };

/** The page that's open, checked to be `page` when one is named, with what went wrong when it didn't render. */
function opened(c: Ctx, page?: PageName): El {
  if (page) assert.equal(c.page, page, `${PAGE_NAMES[page]} isn't open: ${c.page ? PAGE_NAMES[c.page] : "no page"} is`);
  assert.ok(c.tree, `${c.page ? PAGE_NAMES[c.page] : "the page"} didn't open: ${c.error ?? "nothing rendered"}`);
  assert.ok(c.html.trim() !== "", `${c.page ? PAGE_NAMES[c.page] : "the page"} rendered nothing`);
  return c.tree;
}

// ---- reading the rendered page ----

export type El = { tag: string; attrs: Record<string, string>; children: (El | string)[]; parent: El | null };
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const INLINE = new Set(["a", "abbr", "b", "code", "em", "i", "kbd", "label", "mark", "s", "small", "span", "strong", "sub", "sup", "time", "u"]);

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, e: string) => {
    const k = e.toLowerCase();
    if (k[0] === "#") return String.fromCodePoint(k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } as Record<string, string>)[k];
  });
}

function parse(html: string): El {
  const root: El = { tag: "#root", attrs: {}, children: [], parent: null };
  let cur = root;
  const tags = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|[^<]+|</g;
  for (const m of html.matchAll(tags)) {
    const t = m[0];
    if (t.startsWith("<!--")) continue;
    if (!m[2]) {
      cur.children.push(decode(t));
      continue;
    }
    const tag = m[2].toLowerCase();
    if (m[1]) {
      let e: El | null = cur;
      while (e && e !== root && e.tag !== tag) e = e.parent;
      if (e && e !== root) cur = e.parent!;
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of (m[3] ?? "").matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? "");
    const el: El = { tag, attrs, children: [], parent: cur };
    cur.children.push(el);
    if (!VOID.has(tag) && !m[4]) cur = el;
  }
  return root;
}

function rawText(n: El | string): string {
  if (typeof n === "string") return n;
  if (n.tag === "script" || n.tag === "style") return "";
  const inner = n.children.map(rawText).join("");
  return INLINE.has(n.tag) || n.tag === "#root" || n.tag === "#section" ? inner : ` ${inner} `;
}
/** An element's text as a reader sees it, with its whitespace collapsed. */
export const text = (n: El | string) => rawText(n).replace(/\s+/g, " ").trim();
/** An element's own text, leaving out the lists inside it. */
const ownText = (e: El) => text({ ...e, children: e.children.filter((k) => typeof k === "string" || (k.tag !== "ul" && k.tag !== "ol")) });

export function all(e: El): El[] {
  const out: El[] = [];
  const walk = (n: El) => n.children.forEach((k) => {
    if (typeof k !== "string") {
      out.push(k);
      walk(k);
    }
  });
  walk(e);
  return out;
}

const level = (e: El) => (/^h([1-6])$/.exec(e.tag) ? Number(e.tag[1]) : 0);
const headingsIn = (e: El) => [e, ...all(e)].filter((x) => level(x) > 0);

/** What follows the heading with this text, up to the next heading as high, or null when there's no such heading. */
function sectionOf(root: El, name: string): El | null {
  const h = all(root).find((e) => level(e) > 0 && text(e) === name);
  if (!h) return null;
  const lv = level(h);
  let at: El = h;
  while (at.parent && at.parent !== root && at.parent.children.filter((k) => typeof k !== "string" || k.trim()).at(-1) === at) at = at.parent;
  const siblings = at.parent!.children;
  const out: (El | string)[] = [];
  for (const k of siblings.slice(siblings.indexOf(at) + 1)) {
    if (typeof k !== "string" && headingsIn(k).some((x) => level(x) <= lv)) break;
    out.push(k);
  }
  return { tag: "#section", attrs: {}, children: out, parent: null };
}

export function section(root: El, name: string): El {
  const s = sectionOf(root, name);
  assert.ok(s, `the page has no "${name}" heading: its headings are ${JSON.stringify(all(root).filter((e) => level(e) > 0).map(text))}`);
  return s;
}

/** The innermost list item or table row whose text holds `what`. */
function rowOf(scope: El, what: string): El {
  const hits = all(scope).filter((e) => (e.tag === "li" || e.tag === "tr") && text(e).includes(what));
  const inner = hits.filter((e) => !all(e).some((x) => hits.includes(x)));
  assert.ok(inner.length > 0, `no list item or row shows "${what}": ${JSON.stringify(text(scope).slice(0, 600))}`);
  return inner[0];
}

const links = (scope: El) => all(scope).filter((e) => e.tag === "a").map((e) => ({ href: e.attrs.href ?? "", text: text(e) }));
const isBadge = (e: El) => e.attrs["data-slot"] === "badge" || /\bbadge\b/.test(e.attrs.class ?? "");
const badges = (scope: El) => all(scope).filter(isBadge).map(text);
export const banners = (root: El) => all(root).filter((e) => e.attrs.role === "status" || e.attrs.role === "alert");
const buttons = (scope: El) => all(scope).filter((e) => e.tag === "button" || (e.tag === "input" && /^(submit|button)$/i.test(e.attrs.type ?? "")));
const buttonText = (e: El) => (e.tag === "input" ? e.attrs.value ?? "" : text(e));
const fields = (scope: El) => all(scope).filter((e) => (e.tag === "input" && !/^(hidden|submit|button)$/i.test(e.attrs.type ?? "")) || e.tag === "textarea" || e.tag === "select");

export function includes(scope: El, want: string, where: string): void {
  const got = text(scope);
  assert.ok(got.includes(want), `${where} doesn't show "${want}": ${JSON.stringify(got.slice(0, 1500))}`);
}

function formOf(root: El, name: string): El | null {
  const own = all(root).find((e) => e.tag === "form" && (e.attrs["aria-label"] === name || e.attrs.name === name));
  if (own) return own;
  const s = sectionOf(root, name);
  return s ? all(s).find((e) => e.tag === "form") ?? null : null;
}

function form(root: El, name: string): El {
  const f = formOf(root, name);
  assert.ok(f, `the page has no "${name}" form`);
  return f;
}

/** The control the label with this text is for, checked to be the tag given. */
function labelled(scope: El, root: El, label: string, tags: string[]): El {
  const l = all(scope).find((e) => e.tag === "label" && text(e) === label);
  assert.ok(l, `no label reads "${label}"`);
  assert.ok(l.attrs.for, `the label "${label}" has no for`);
  const target = all(root).filter((e) => e.attrs.id === l.attrs.for);
  assert.equal(target.length, 1, `the label "${label}" is for id "${l.attrs.for}", which ${target.length} elements have`);
  assert.ok(tags.includes(target[0].tag), `the label "${label}" is for a <${target[0].tag}>, not a ${tags.join(" or ")}`);
  if (target[0].tag === "input") assert.ok(!/^(hidden|submit|button|checkbox|radio)$/i.test(target[0].attrs.type ?? ""), `the label "${label}" is for an input of type ${target[0].attrs.type}`);
  return target[0];
}

type Table = { columns: string[]; rows: El[][] };
function tableOf(t: El): Table {
  const head = all(t).find((e) => e.tag === "thead");
  const heads = head ? all(head).filter((e) => e.tag === "th") : [];
  const trs = all(t).filter((e) => e.tag === "tr" && !(head && all(head).includes(e)));
  const cells = (tr: El) => tr.children.filter((k): k is El => typeof k !== "string" && (k.tag === "td" || k.tag === "th"));
  const rows = trs.map(cells).filter((r) => r.some((x) => x.tag === "td"));
  const columns = heads.length ? heads.map(text) : trs.length ? cells(trs[0]).map(text) : [];
  return { columns, rows };
}

export function table(scope: El, what: string): Table {
  const t = all(scope).find((e) => e.tag === "table");
  assert.ok(t, `${what} has no table`);
  return tableOf(t);
}

export function cell(t: Table, row: El[], column: string): El {
  const i = t.columns.indexOf(column);
  assert.ok(i >= 0, `the table has no "${column}" column: ${JSON.stringify(t.columns)}`);
  assert.ok(row[i], `the row has no cell under "${column}"`);
  return row[i];
}

export function rowFor(t: Table, what: string): El[] {
  const row = t.rows.find((r) => text(r[0] ?? "").includes(what)) ?? t.rows.find((r) => r.some((x) => text(x).includes(what)));
  assert.ok(row, `the table has no row for "${what}": ${JSON.stringify(t.rows.map((r) => r.map(text)))}`);
  return row;
}

export function showsCells(row: El[], want: string[]): void {
  const got = row.map(text);
  for (const w of want) assert.ok(got.includes(w), `the row doesn't show "${w}": ${JSON.stringify(got)}`);
}

/** The element whose title is `title`, in the row's cells. */
function titled(row: El[], title: string, shown?: string): void {
  const hits = row.flatMap((x) => [x, ...all(x)]).filter((e) => e.attrs.title === title);
  assert.ok(hits.length > 0, `nothing in the row has the title "${title}"`);
  if (shown !== undefined) assert.ok(hits.some((e) => text(e) === shown), `the element titled "${title}" doesn't show "${shown}": ${JSON.stringify(hits.map(text))}`);
}

/** The value beside a term: the element after a <dt> or <th> reading `term`, or after any element reading it. */
function term(scope: El, name: string): string {
  const els = all(scope).filter((e) => text(e) === name && e.parent);
  const next = (e: El) => {
    const sibs = e.parent!.children.filter((k): k is El => typeof k !== "string");
    return sibs[sibs.indexOf(e) + 1];
  };
  const hit = els.filter((e) => e.tag === "dt" || e.tag === "th").find(next) ?? els.filter((e) => level(e) === 0).find(next);
  assert.ok(hit, `nothing reads "${name}" beside a value: ${JSON.stringify(text(scope).slice(0, 800))}`);
  return text(next(hit)!);
}

function termIs(scope: El, name: string, value: string): void {
  assert.equal(term(scope, name), value, `"${name}" doesn't read "${value}"`);
}

const before = (root: El, a: El, b: El) => {
  const order = all(root);
  return order.indexOf(a) < order.indexOf(b);
};

// ---- the fixture: Floor ----

const sectionNames = ["Waiting on you", "Next up", "Final stage", "Not ready", "Blocked", "Split", "Failed on main", "In flight"];

export function addActive(c: Ctx, n: Named, extra: Partial<FloorData["active"][number]>): FloorData["active"][number] {
  const row = { ...n, state: "InProgress", stage: "green", since: ago(c, 5 * MIN), cost: "0", badges: [], message: null, pr_number: null, pr_url: null, ci_failure: null, ...extra };
  c.floor.active.push(row);
  return row;
}

function ciFailure(sha: string, checks: string[], url = `https://github.com/${REPO}/actions/runs/1`) {
  return { sha, checks: checks.map((name) => ({ name, url, failingTests: [] })) };
}

Given("the SPA's pages are rendered with react-dom\\/server", long, async function () {
  // The pages load through Vite's SSR loader, started once for the run.
  await load("/src/api.ts");
});

Given("the SPA's API client calls a stubbed fetch that answers from fixture data, with no BFF and no real sign-in; the stub says who the viewer is and their roles", function () {
  ctx(this);
});

Given("the factory's floor holds:", function (t: DataTable) {
  const c = ctx(this);
  for (const r of t.hashes()) {
    const n = named(c, `${r.issue} ${r.title}`);
    if (r.section === "Waiting on you") {
      const m = /^(\w+), waiting for (\d+) (minute|hour|day)s?(?:, PR #(\d+))?$/.exec(r.detail);
      assert.ok(m, `can't read the wait "${r.detail}"`);
      const ms = Number(m[2]) * ({ minute: MIN, hour: HOUR, day: DAY } as Record<string, number>)[m[3]];
      c.floor.waiting.push({ ...n, state: m[1], since: ago(c, ms), pr_number: m[4] ? Number(m[4]) : null, pr_url: m[4] ? `https://github.com/${REPO}/pull/${m[4]}` : null });
      c.floor.waitingCount++;
    } else if (r.section === "Next up") c.floor.next.push(n);
    else if (r.section === "Final stage") c.floor.finalStage.push({ ...n, state: r.detail });
    else if (r.section === "Not ready") c.floor.notReady.push({ ...n, failed: [...r.detail.matchAll(/"([^"]+)"/g)].map((x) => x[1]) });
    else throw new Error(`no fixture for the section "${r.section}"`);
  }
});

Given("the factory's floor has {string} in the repo {string} under {string}", function (label: string, repo: string, where: string) {
  assert.equal(where, "Next up");
  const c = ctx(this);
  c.floor.next.push(named(c, label, repo));
});

Given("the factory's floor has {string} under {string} with no repo known", function (label: string, where: string) {
  assert.equal(where, "Next up");
  const c = ctx(this);
  c.floor.next.push(named(c, label, null));
});

Given("the factory's floor holds a Queued item {string} blocked by {string} and {string}", function (label: string, a: string, b: string) {
  const c = ctx(this);
  c.floor.blocked.push({ ...named(c, label), blocked_by: [a, b].map((x) => x.replace(/^#/, "")) });
});

function children(c: Ctx, queued: string, done: string, missing: string) {
  return [[queued, "Queued"], [done, "Done"], [missing, null]].map(([label, state]) => {
    const n = named(c, label!);
    return { externalId: n.external_id, title: n.title, url: issueUrl(n.external_id), state };
  });
}

Given("it holds a Split parent {string} split into {string}, which is Queued, {string}, which is Done, and {string}, which the factory doesn't hold", function (parent: string, a: string, b: string, d: string) {
  const c = ctx(this);
  c.floor.split.push({ ...named(c, parent), children: children(c, a, b, d) });
});

Given("the factory's floor has {string}, which failed its Definition of Done on main and hasn't been re-checked yet", function (label: string) {
  const c = ctx(this);
  c.floor.failed.push({ ...named(c, label), rechecked: null });
});

Given("the factory's floor has {string}, which failed its Definition of Done on main and was last re-checked at {int}-{int}-{int} {int}:{int} UTC", function (label: string, y: number, mo: number, d: number, h: number, mi: number) {
  const c = ctx(this);
  c.floor.failed.push({ ...named(c, label), rechecked: iso(y, mo, d, h, mi) });
});

Given("the factory's floor has {string} under {string} at priority {int}, taken from {string}, and final-stage because of {string}", function (label: string, where: string, priority: number, from: string, group: string) {
  assert.equal(where, "Next up");
  const c = ctx(this);
  const n = named(c, label);
  c.floor.next.push(n);
  const f = named(c, from);
  const g = named(c, group);
  c.floor.keys[n.id] = { own: priority + 1, priority, priorityFrom: { id: f.id, externalId: f.external_id }, finalStage: true, finalStageFrom: { id: g.id, externalId: g.external_id }, bug: false };
});

Given("the factory's floor has {string}, which carries the bug label, under {string} at priority {int}", function (label: string, where: string, priority: number) {
  assert.equal(where, "Next up");
  const c = ctx(this);
  const n = named(c, label);
  c.floor.next.push(n);
  c.floor.keys[n.id] = { own: priority, priority, priorityFrom: null, finalStage: false, finalStageFrom: null, bug: true };
});

Given("the factory's floor has {string} In progress at stage {string} for {int} minutes, costing ${float}, with badges {string} and last agent message {string}", function (label: string, stage: string, minutes: number, usd: number, badge: string, msg: string) {
  const c = ctx(this);
  addActive(c, named(c, label), { stage, since: ago(c, minutes * MIN), cost: String(usd), badges: [badge], message: msg });
});

Given("the factory's floor has {string} at Green fixing a CI failure on commit {string} where the check {string} failed", function (label: string, sha: string, check: string) {
  const c = ctx(this);
  addActive(c, named(c, label), { ci_failure: ciFailure(sha, [check]) });
});

Given("the factory's floor has {string} at Green fixing a CI failure on commit {string} where the checks {string} and {string} failed", function (label: string, sha: string, a: string, b: string) {
  const c = ctx(this);
  addActive(c, named(c, label), { ci_failure: ciFailure(sha, [a, b]) });
});

Given("the factory's floor has {string} at Green fixing a CI failure on commit {string} where CI named no check the factory could read", function (label: string, sha: string) {
  const c = ctx(this);
  addActive(c, named(c, label), { ci_failure: ciFailure(sha, []) });
});

Given("the factory's floor has {string} at Green fixing a CI failure on commit {string} where the check {string} failed at {string}", function (label: string, sha: string, check: string, url: string) {
  const c = ctx(this);
  addActive(c, named(c, label), { ci_failure: ciFailure(sha, [check], url) });
});

Given("the factory's floor has nothing under {string}", function (where: string) {
  assert.ok(sectionNames.includes(where), `Floor has no section "${where}"`);
  ctx(this);
});

Given("the factory's floor has {int} items waiting on a person against a limit of {int}", function (n: number, limit: number) {
  const c = ctx(this);
  for (let i = 0; i < n; i++) c.floor.waiting.push({ ...named(c, `#${70 + i} Waiting ${i + 1}`), state: "SignOff", since: ago(c, HOUR), pr_number: null, pr_url: null });
  c.floor.waitingCount = n;
  c.floor.capacity = limit;
});

export function override(c: Ctx, f: FloorData, kind: string, reason: string): void {
  f.factory.push({ kind, reason });
  if (kind === "restart") f.restart = { running: f.running ?? 0, reason };
}

Given("the factory is under a {string} override with the reason {string}", function (kind: string, reason: string) {
  const c = ctx(this);
  override(c, c.floor, kind, reason);
});

Given("the factory is preparing a restart with the reason {string}", function (reason: string) {
  const c = ctx(this);
  override(c, c.floor, "restart", reason);
});

Given("the factory counts {int} cells still running", function (n: number) {
  const c = ctx(this);
  c.floor.running = n;
  if (c.floor.restart) c.floor.restart.running = n;
});

Given("the factory gives no count of the cells still running", function () {
  delete ctx(this).floor.running;
});

Given("the cell image was built from commit {string} and main's commit {string} needs a restart", function (built: string, restart: string) {
  ctx(this).floor.cellImage = { started: built, built, restart };
});

Given("the cell image carries no commit label and no restart is needed", function () {
  ctx(this).floor.cellImage = { started: "unknown", built: null, restart: null };
});

function mainBreak(c: Ctx, sha: string, b: Partial<FloorData["mainBreaks"][number]>): void {
  c.floor.mainBreaks.push({ branch: "main", sha, repo: REPO, pr_number: null, charged: null, bug_external_id: null, bug_id: null, bug_title: null, bug_state: null, ...b });
}

function bug(c: Ctx, label: string, state: string | null) {
  const n = named(c, label);
  return { bug_external_id: n.external_id, bug_id: n.id, bug_title: n.title, bug_state: state };
}

Given("main is red at commit {string}, the merge of PR #{int} for item {string}, and its bug item is {string}", function (sha: string, pr: number, charged: string, label: string) {
  const c = ctx(this);
  mainBreak(c, sha, { pr_number: pr, charged: charged.replace(/^#/, ""), ...bug(c, label, "Queued") });
});

Given("main is red at commit {string}, the merge of PR #{int} for item {string}, and the factory hasn't filed its bug item yet", function (sha: string, pr: number, charged: string) {
  mainBreak(ctx(this), sha, { pr_number: pr, charged: charged.replace(/^#/, "") });
});

Given("main is red at commit {string}, the merge of PR #{int} for item {string}, and its bug item {string} is Failed", function (sha: string, pr: number, charged: string, label: string) {
  const c = ctx(this);
  mainBreak(c, sha, { pr_number: pr, charged: charged.replace(/^#/, ""), ...bug(c, label, "Failed") });
});

Given("main is red at commit {string}, which the factory didn't merge, so no item is charged with it", function (sha: string) {
  mainBreak(ctx(this), sha, {});
});

Given("{string} waits on a question because its tests {string} and {string} fail on base commit {string}", function (label: string, a: string, b: string, sha: string) {
  const c = ctx(this);
  const n = named(c, label);
  c.floor.baseFails.push({ ...n, sha, tests: [a, b] });
  c.floor.waiting.push({ ...n, state: "NeedsInput", since: ago(c, HOUR), pr_number: null, pr_url: null });
  c.floor.waitingCount++;
});

Given("the Claude token expires in {int} days", function (days: number) {
  const c = ctx(this);
  const age = 365 - days;
  c.floor.claudeToken = {
    createdAt: ago(c, age * DAY), ageDays: age,
    banner: `The Claude token expires in ${days} days. Make a new one with claude setup-token and update the secret.`,
  };
});

// ---- the fixture: Run detail ----

type Controls = NonNullable<ItemData["controls"]>;

function controlsFor(state: string, held = false, running = false): Controls {
  return {
    held, stoppable: state === "InProgress" && running, requeueable: state === "Failed" || state === "Abandoned",
    startable: !held && (state === "Queued" || state === "Eligible" || state === "NotReady"), movable: !held && state === "Queued",
  };
}

function blankItem(n: Named, state: string): ItemData {
  return {
    item: { ...n, state, held: false }, run: null, policies: [], stages: [], readiness: [], question: null, criteria: null,
    scope: null, pending: [], features: [], verdicts: [], linkBlobs: true, fixingCi: null, controls: controlsFor(state),
    startNow: null, moveEnded: null, claim: null, splitInto: [], recheck: null,
  };
}

/** The item named, which the steps after this one mean by "it" and "its". */
function itemOf(c: Ctx, label: string, state = "InProgress"): ItemData {
  const n = named(c, label);
  let d = c.items.get(n.external_id);
  if (!d) {
    d = blankItem(n, state);
    c.items.set(n.external_id, d);
  }
  c.ext = n.external_id;
  return d;
}

function current(c: Ctx): ItemData {
  assert.ok(c.ext, "no item was set up");
  return c.items.get(c.ext)!;
}

function openRun(d: ItemData): NonNullable<ItemData["run"]> {
  d.run ??= { sop_version: "v1", config_sha: "c0nf1g0", scenarios_sha: null, features_lock_sha: null, risk_tier: null, tier_reasons: null, next_stage: null, pr_number: null, pr_url: null, open: true };
  return d.run;
}

/** Puts the item in the situation a step names: a bare state, or one of the outlines' situations. */
function apply(d: ItemData, situation: string): void {
  const s = situation.trim();
  const set = (state: string, held: boolean, running = false) => {
    d.item.state = state;
    d.item.held = held;
    d.controls = controlsFor(state, held, running);
    if (state === "InProgress") openRun(d).open = true;
  };
  if (s === "InProgress, not held, with a running cell") set("InProgress", false, true);
  else if (s === "held, InProgress with a running cell") set("InProgress", true, true);
  else if (s === "held and Failed") set("Failed", true);
  else if (s === "not held, and Failed") set("Failed", false);
  else if (/^[A-Z][A-Za-z]*$/.test(s)) set(s, false);
  else throw new Error(`no fixture for the situation "${situation}"`);
}

function situate(c: Ctx, label: string, situation: string): void {
  apply(itemOf(c, label), situation);
}

Given(/^item "([^"]*)" is (InProgress, not held, with a running cell|held and Failed)$/, function (label: string, situation: string) {
  situate(ctx(this), label, situation);
});

Given("item {string} in {string} is InReview on an open run with PR #{int} that resumes at {string}", function (label: string, repo: string, pr: number, stage: string) {
  const c = ctx(this);
  named(c, label, repo);
  const d = itemOf(c, label);
  apply(d, "InReview");
  Object.assign(openRun(d), { open: true, pr_number: pr, pr_url: `https://github.com/${repo}/pull/${pr}`, next_stage: stage });
});

Given("item {string} has a run on SOP version {string}, config {string}, scenarios locked at {string}, and shadow tier {string} because {string}", function (label: string, sop: string, config: string, lock: string, tier: string, why: string) {
  const d = itemOf(ctx(this), label);
  Object.assign(openRun(d), { sop_version: sop, config_sha: config, scenarios_sha: lock, features_lock_sha: lock, risk_tier: tier, tier_reasons: [why] });
});

Given("item {string} has no run yet", function (label: string) {
  const d = itemOf(ctx(this), label, "Queued");
  apply(d, "Queued");
  d.run = null;
});

Given("item {string} has priority {int}, from {string}, which depends on it, and its own priority on the board is {int}", function (label: string, priority: number, from: string, own: number) {
  const c = ctx(this);
  const d = itemOf(c, label, "Queued");
  apply(d, "Queued");
  const f = named(c, from);
  d.claim = { own, priority, priorityFrom: { id: f.id, externalId: f.external_id }, finalStage: false, finalStageFrom: null, bug: false };
});

Given("it is marked Start now with the reason {string}, by {string}", function (reason: string, by: string) {
  current(ctx(this)).startNow = { reason, by };
});

Given("its Move up was ended by a change to the board's order at {int}-{int}-{int} {int}:{int} UTC", function (y: number, mo: number, d: number, h: number, mi: number) {
  current(ctx(this)).moveEnded = { control: "Move up", at: iso(y, mo, d, h, mi) };
});

Given(/^item "([^"]*)" has priority (\d+)(?:,| and) (is final-stage because "[^"]*" depends on it|is final-stage because its PR is open|isn't final-stage), and (carries|doesn't carry) the bug label$/, function (label: string, p: string, group: string, carries: string) {
  const c = ctx(this);
  const d = itemOf(c, label, "Queued");
  const from = /"([^"]*)"/.exec(group)?.[1];
  const f = from ? named(c, from) : null;
  const finalStage = group.startsWith("is final-stage");
  if (group.includes("its PR is open")) {
    apply(d, "InReview");
    Object.assign(openRun(d), { open: true });
  } else apply(d, "Queued");
  d.claim = {
    own: Number(p), priority: Number(p), priorityFrom: null, finalStage,
    finalStageFrom: f ? { id: f.id, externalId: f.external_id } : null, bug: carries === "carries",
  };
});

Given("item {string} failed its Definition of Done on main and hasn't been re-checked yet", function (label: string) {
  const d = itemOf(ctx(this), label, "Failed");
  apply(d, "Failed");
  d.recheck = { last: null };
});

Given("item {string} failed its Definition of Done on main and was last re-checked at {int}-{int}-{int} {int}:{int} UTC", function (label: string, y: number, mo: number, day: number, h: number, mi: number) {
  const d = itemOf(ctx(this), label, "Failed");
  apply(d, "Failed");
  d.recheck = { last: iso(y, mo, day, h, mi) };
});

Given("item {string} was split into {string}, which is Queued, {string}, which is Done, and {string}, which the factory doesn't hold", function (label: string, a: string, b: string, m: string) {
  const c = ctx(this);
  const d = itemOf(c, label, "Split");
  apply(d, "Split");
  d.splitInto = children(c, a, b, m);
});

function fixingCi(world: object, label: string, sha: string, checks: NonNullable<ItemData["fixingCi"]>["checks"]): void {
  const d = itemOf(ctx(world), label);
  apply(d, "InProgress");
  openRun(d).next_stage = "green";
  d.fixingCi = { sha, checks };
}

Given("item {string} is fixing CI on commit {string}, where the check {string} at {string} failed the test {string}", function (label: string, sha: string, name: string, url: string, test: string) {
  fixingCi(this, label, sha, [{ name, url, failingTests: [test] }]);
});

Given("item {string} is fixing CI on commit {string}, where the check {string} failed and named no failing test", function (label: string, sha: string, name: string) {
  fixingCi(this, label, sha, [{ name, url: `https://github.com/${REPO}/actions/runs/1`, failingTests: [] }]);
});

Given("item {string} is fixing CI on commit {string}, where CI named no check the factory could read", function (label: string, sha: string) {
  fixingCi(this, label, sha, []);
});

Given("transcripts can be served", function () {
  ctx(this).items.forEach((d) => (d.linkBlobs = true));
  (this as { pbi279linkBlobs?: boolean }).pbi279linkBlobs = true;
});

Given("transcripts can't be served", function () {
  ctx(this).items.forEach((d) => (d.linkBlobs = false));
  (this as { pbi279linkBlobs?: boolean }).pbi279linkBlobs = false;
});

function addStage(world: object, label: string, s: Partial<ItemData["stages"][number]>): ItemData["stages"][number] {
  const c = ctx(world);
  const d = itemOf(c, label);
  const linkBlobs = (world as { pbi279linkBlobs?: boolean }).pbi279linkBlobs;
  if (linkBlobs !== undefined) d.linkBlobs = linkBlobs;
  openRun(d);
  const stage = {
    stage_id: "green", attempt: d.stages.length + 1, model: "sonnet", tokens_in: 1000, tokens_out: 100, cost_usd: "0.01", status: "passed",
    transcript_ref: null, started_at: ago(c, 2 * HOUR), ended_at: ago(c, HOUR), restates: [], message: null, ...s,
  };
  d.stages.push(stage);
  c.lastStage = stage;
  return stage;
}

Given("item {string} has a finished {string} attempt {int} on model {string} that took {int} minutes, used {int},{int} tokens in and {int} out, cost ${float} and left a transcript", function (label: string, stage: string, attempt: number, model: string, minutes: number, kIn: number, rest: number, out: number, usd: number) {
  const c = ctx(this);
  const start = ago(c, 3 * HOUR);
  addStage(this, label, {
    stage_id: stage, attempt, model, tokens_in: kIn * 1000 + rest, tokens_out: out, cost_usd: String(usd), status: "passed",
    started_at: start, ended_at: new Date(Date.parse(start) + minutes * MIN).toISOString(), transcript_ref: `transcripts/${named(c, label).external_id}-${stage}-${attempt}.jsonl`,
  });
});

Given("the PR reviewer needed a second ask in round {int} of that attempt because {string}", function (round: number, reason: string) {
  const s = ctx(this).lastStage;
  assert.ok(s, "no attempt was set up");
  (s.restates ??= []).push({ round, reason });
});

Given("item {string} has a {string} attempt whose message is {string}", function (label: string, stage: string, msg: string) {
  addStage(this, label, { stage_id: stage, message: msg, status: "failed" });
});

Given("item {string} has an attempt whose transcript is stored as {string}", function (label: string, ref: string) {
  addStage(this, label, { stage_id: "red", transcript_ref: ref });
});

Given(/^item "([^"]*)" is (InProgress on an open run|NeedsInput) and its newest attempt at "([^"]*)" started (\d+) minutes ago with no end$/, function (label: string, state: string, stage: string, minutes: string) {
  const c = ctx(this);
  const d = itemOf(c, label);
  apply(d, state === "NeedsInput" ? "NeedsInput" : "InProgress");
  openRun(d).open = true;
  addStage(this, label, { stage_id: stage, status: "started", started_at: ago(c, Number(minutes) * MIN), ended_at: null });
});

Given("item {string} has an attempt that started at {int}-{int}-{int} {int}:{int} UTC", function (label: string, y: number, mo: number, d: number, h: number, mi: number) {
  const at = iso(y, mo, d, h, mi);
  addStage(this, label, { started_at: at, ended_at: new Date(Date.parse(at) + 10 * MIN).toISOString() });
});

Given("item {string} took {int} hours in all, {int} hour Queued, {int} minutes waiting at sign-off, {int} minutes on a question, {int} minutes in review, and {int} hour in {string} over {int} attempts", function (label: string, total: number, queued: number, signOff: number, question: number, review: number, inStage: number, stage: string, attempts: number) {
  const d = itemOf(ctx(this), label);
  d.durations = {
    totalMs: total * HOUR, queuedMs: queued * HOUR,
    waiting: { signOffMs: signOff * MIN, needsInputMs: question * MIN, inReviewMs: review * MIN, totalMs: (signOff + question + review) * MIN },
    stages: [{ stageId: stage, ms: inStage * HOUR, attempts }],
  };
});

Given("item {string} has no creation time, so its total time isn't known", function (label: string) {
  const d = itemOf(ctx(this), label);
  d.durations = { totalMs: null, queuedMs: 0, waiting: { signOffMs: 0, needsInputMs: 0, inReviewMs: 0, totalMs: 0 }, stages: [] };
});

Given("item {string} failed the {string} criterion {string} from {string} because {string}", function (label: string, file: string, criterion: string, source: string, reason: string) {
  itemOf(ctx(this), label).policies.push({ file, source, criterion, status: "failed", reason });
});

function check(world: object, label: string, k: Partial<ItemData["readiness"][number]>): void {
  const c = ctx(world);
  itemOf(c, label).readiness.push({ kind: "judge", model: "haiku", tokensIn: 1000, tokensOut: 100, costUsd: 0.001, ranAt: ago(c, DAY), ...k });
}

Given("item {string} had a readiness judge call on {string} that used {int},{int} tokens in and {int} out and cost ${float}", function (label: string, model: string, kIn: number, rest: number, out: number, usd: number) {
  check(this, label, { model, tokensIn: kIn * 1000 + rest, tokensOut: out, costUsd: usd, verdict: { outcome: "passed" } });
});

Given("item {string} had a readiness judge call that passed it", function (label: string) {
  check(this, label, { verdict: { outcome: "passed" } });
});

Given("item {string} had a readiness judge call with no verdict recorded", function (label: string) {
  check(this, label, {});
});

Given("item {string} had a readiness judge call whose output was unreadable", function (label: string) {
  check(this, label, { verdict: { outcome: "unreadable" } });
});

Given("item {string} had a readiness judge call that failed with no verdict", function (label: string) {
  check(this, label, { verdict: { outcome: "error" } });
});

Given("item {string} had a readiness judge call on the proposed child {string} that passed it", function (label: string, child: string) {
  check(this, label, { verdict: { outcome: "passed" }, child });
});

Given("item {string} had a readiness split proposal", function (label: string) {
  check(this, label, { kind: "split", model: "sonnet" });
});

Given("item {string} had a readiness judge call that failed it on {string} because {string}, flagging {string}", function (label: string, criterion: string, reason: string, flag: string) {
  check(this, label, { verdict: { outcome: "failed", lines: [{ criterion, reason }], flags: [flag] } });
});

Given("item {string} has the scenario {string}, which failed at Red and passed at Green", function (label: string, name: string) {
  itemOf(ctx(this), label).verdicts.push({ name, red: "failed", green: "passed" });
});

Given("its signed-off feature file {string} holds {string}", function (path: string, body: string) {
  const d = current(ctx(this));
  Object.assign(openRun(d), { features_lock_sha: "f00d123" });
  d.features.push({ path, text: body });
});

const pendingText = (path: string) => `@pbi-41\nFeature: Search the catalogue (${path})\n\n  Scenario: Search by title\n    Given a title in the catalogue\n`;

function waitsForSignOff(c: Ctx, label: string): ItemData {
  const d = itemOf(c, label, "SignOff");
  apply(d, "SignOff");
  openRun(d).scenarios_sha = "5ce7a10";
  d.question = { kind: "sign_off", body: "The scenarios are ready for sign-off." };
  d.criteria ??= [];
  // The Sign off form shows only with files to read, so an item waiting for sign-off has one up until a scenario names its own.
  if (d.pending.length === 0) {
    const path = `features/pbi-${d.item.external_id}-default.feature`;
    d.pending.push({ path, text: pendingText(path) });
    defaultPending.add(d);
  }
  return d;
}

const defaultPending = new WeakSet<ItemData>();

Given("item {string} waits for sign-off", function (label: string) {
  waitsForSignOff(ctx(this), label);
});

Given("its issue's body is {string}", function (body: string) {
  current(ctx(this)).scope = body;
});

Given("its criterion {string} has the scenario {string}, and {string} has the @regression scenario {string}", function (a: string, s: string, b: string, r: string) {
  const d = current(ctx(this));
  (d.criteria ??= []).push({ criterion: a, scenarios: [{ name: s, regression: false }] }, { criterion: b, scenarios: [{ name: r, regression: true }] });
});

Given("its criterion {string} has no scenario", function (a: string) {
  (current(ctx(this)).criteria ??= []).push({ criterion: a, scenarios: [] });
});

Given("its feature file {string} is up for sign-off", function (path: string) {
  const d = current(ctx(this));
  if (defaultPending.delete(d)) d.pending = [];
  d.pending.push({ path, text: pendingText(path) });
});

Given("item {string} waits on the question {string}", function (label: string, q: string) {
  const d = itemOf(ctx(this), label, "NeedsInput");
  apply(d, "NeedsInput");
  d.question = { kind: "needs_input", body: q };
});

Given("item {string} is InProgress with no open question", function (label: string) {
  const d = itemOf(ctx(this), label);
  apply(d, "InProgress");
  d.question = null;
});

// ---- the viewer ----

export const role = (world: object, r: Partial<Ctx["roles"]>) => Object.assign(ctx(world).roles, r);

Given("I am an operator", function () {
  role(this, { operator: true });
});

Given("I am a viewer, not an operator", function () {
  role(this, { operator: false });
});

Given("I am the product owner", function () {
  role(this, { owner: true });
});

Given("I am a user", function () {
  role(this, { operator: false, owner: false });
});

Given("I am an operator and the product owner", function () {
  role(this, { operator: true, owner: true });
});

Given("I am the product owner and item {string} waits for sign-off", function (label: string) {
  role(this, { owner: true });
  waitsForSignOff(ctx(this), label);
});

Given("I am the product owner with the sign-off form for {string} open in the SPA", long, async function (label: string) {
  role(this, { owner: true });
  waitsForSignOff(ctx(this), label);
  await open(this, "item");
});

Given("I am a user who isn't the product owner, with the sign-off form for {string} open in the SPA", long, async function (label: string) {
  role(this, { owner: false });
  waitsForSignOff(ctx(this), label);
  await open(this, "item");
});

Given("I am an operator with the Run detail of Failed item {string} open in the SPA", long, async function (label: string) {
  role(this, { operator: true });
  situate(ctx(this), label, "Failed");
  await open(this, "item");
});

Given("I am an operator with Floor open in the SPA", long, async function () {
  role(this, { operator: true });
  await open(this, "floor");
});

Given("I am an operator with Floor open in the SPA, and the factory is under no override", long, async function () {
  role(this, { operator: true });
  ctx(this).floor.factory = [];
  await open(this, "floor");
});

Given("I am an operator with Floor open in the SPA, and the factory is under a {string} override with the reason {string}", long, async function (kind: string, reason: string) {
  role(this, { operator: true });
  const c = ctx(this);
  override(c, c.floor, kind, reason);
  await open(this, "floor");
});

// ---- what the factory answers ----

Given("the factory, asked for the floor after the override, reports a {string} override with the reason {string} and {int} cells still running", function (kind: string, reason: string, running: number) {
  ctx(this).floorAfter = (c) => {
    const f = clone(c.floor);
    f.factory = [];
    f.restart = null;
    f.running = kind === "drain" || kind === "restart" ? running : undefined;
    override(c, f, kind, reason);
    return f;
  };
});

Given("the factory, asked for the floor after the override, reports no override", function () {
  ctx(this).floorAfter = (c) => ({ ...clone(c.floor), factory: [], restart: null });
});

/** The reason the last override sent gave. */
const sentReason = (c: Ctx) => {
  const b = c.requests.filter((r) => r.method === "POST" && r.path === "/bff/v1/overrides").at(-1)?.body as { reason?: string } | undefined;
  return b?.reason ?? "";
};

function itemAfter(world: object, change: (d: ItemData, c: Ctx) => void): void {
  const c = ctx(world);
  const ext = current(c).item.external_id;
  c.itemAfter = (cc) => {
    const d = clone(cc.items.get(ext)!);
    change(d, cc);
    return d;
  };
}

Given("the factory, asked for the item after the decision, reports it with no open question", function () {
  itemAfter(this, (d) => {
    apply(d, "Queued");
    d.question = null;
    d.pending = [];
  });
});

Given("the factory, asked for the item after the answer, reports it with no open question", function () {
  itemAfter(this, (d) => {
    apply(d, "Queued");
    d.question = null;
  });
});

Given(/^the factory, asked for the item after the override, reports it (held, InProgress with a running cell|not held, and Failed|held and Failed|Queued)$/, function (situation: string) {
  itemAfter(this, (d) => apply(d, situation));
});

Given("the factory, asked for the item after the override, reports it Queued and marked Start now with that reason, by {string}", function (by: string) {
  itemAfter(this, (d, c) => {
    apply(d, "Queued");
    d.startNow = { reason: sentReason(c), by };
  });
});

Given("the factory, asked for the item after the override, reports it Queued at priority {int}", function (priority: number) {
  itemAfter(this, (d) => {
    apply(d, "Queued");
    d.claim = { own: priority, priority, priorityFrom: null, finalStage: false, finalStageFrom: null, bug: false };
  });
});

Given("the factory answers the decision that the item isn't waiting for it", function () {
  ctx(this).decisionAnswer = { status: 409, body: { error: "that item isn't waiting for this decision" } };
});

Given("the factory answers the decision with {int}, as it does for someone who can't make it", function (status: number) {
  ctx(this).decisionAnswer = { status, body: { error: "you can't make that decision" } };
});

Given("the factory answers the re-queue that only a Failed or Abandoned item can be re-queued, since someone else re-queued it first", function () {
  ctx(this).overrideAnswer = { status: 409, body: { error: "only a Failed or Abandoned item can be re-queued" } };
});

// ---- the fixture: Phase 0 and Activity ----

function merged(c: Ctx, label: string, r: Partial<Phase0Data["runs"][number]>): void {
  const n = named(c, label);
  c.phase0.runs.push({
    item_id: n.id, external_id: n.external_id, repo: n.repo, title: n.title, pr_url: `https://github.com/${REPO}/pull/${60 + c.phase0.runs.length}`,
    merged_at: iso(2026, 11, 1 + c.phase0.runs.length), cost: 0, risk_tier: null, tier_reasons: null, ...r,
  });
}

Given("the factory has merged {string} as {string} on {int}-{int}-{int} for ${float} at shadow tier {string}", function (label: string, url: string, y: number, mo: number, d: number, usd: number, tier: string) {
  merged(ctx(this), label, { pr_url: url, merged_at: iso(y, mo, d, 12), cost: usd, risk_tier: tier, tier_reasons: [] });
});

Given("it has merged {string} as {string} on {int}-{int}-{int} for ${float} at shadow tier {string} because {string}", function (label: string, url: string, y: number, mo: number, d: number, usd: number, tier: string, why: string) {
  merged(ctx(this), label, { pr_url: url, merged_at: iso(y, mo, d, 12), cost: usd, risk_tier: tier, tier_reasons: [why] });
});

Given("the factory has merged {string} for ${float} with no shadow tier", function (label: string, usd: number) {
  merged(ctx(this), label, { cost: usd, risk_tier: null, tier_reasons: null });
});

Given("the factory has merged only {string}, for ${float}", function (label: string, usd: number) {
  const c = ctx(this);
  c.phase0.runs = [];
  merged(c, label, { cost: usd, risk_tier: "low" });
});

Given("the factory has merged no PR", function () {
  ctx(this).phase0.runs = [];
});

Given(/^the readiness checks (?:on every item )?cost \$([\d.]+) in all$/, function (usd: string) {
  ctx(this).phase0.readinessSpend = Number(usd);
});

type Event = ActivityData["events"][number];
const event = (e: Partial<Event>): Event => ({ at: new Date().toISOString(), external_id: null, repo: null, title: null, kind: "transition", from: null, to: null, event: null, ...e });

Given("the factory's newest events are, newest first:", function (t: DataTable) {
  const c = ctx(this);
  c.activity.events = t.hashes().map((r) => {
    const n = named(c, `${r.issue} ${r.title}`);
    const [d, hm] = r["at (UTC)"].split(" ");
    return event({ at: new Date(`${d}T${hm}:00Z`).toISOString(), external_id: n.external_id, repo: n.repo, title: n.title, kind: r.kind, from: r.from || null, to: r.to || null, event: r.event || null });
  });
});

Given("the factory's newest events are one on {string} in {string} and one on {string} with no repo known", function (a: string, repo: string, b: string) {
  const c = ctx(this);
  const x = named(c, a, repo);
  const y = named(c, b, null);
  c.activity.events = [
    event({ at: iso(2026, 11, 20, 10, 5), external_id: x.external_id, repo, title: x.title, kind: "transition", from: "Queued", to: "InProgress", event: "claimed" }),
    event({ at: iso(2026, 11, 20, 10, 0), external_id: y.external_id, repo: null, title: y.title, kind: "transition", from: "Eligible", to: "Queued", event: "readiness_passed" }),
  ];
});

Given("the factory's newest event is a {string} change with no item", function (kind: string) {
  ctx(this).activity.events = [event({ at: iso(2026, 11, 20, 10, 5), kind, from: "3", to: "4", actor: "octo", setting: "WIP limit", reason: "more cells free" })];
});

Given("the factory's newest event is {string} changing {string} from not set to {string} because {string}", function (actor: string, setting: string, to: string, reason: string) {
  ctx(this).activity.events = [event({ at: iso(2026, 11, 20, 10, 5), kind: "setting", from: null, to, actor, setting, reason })];
});

Given("the factory's newest event happened at {int}-{int}-{int} {int}:{int} UTC", function (y: number, mo: number, d: number, h: number, mi: number) {
  const c = ctx(this);
  const n = named(c, "#41 Add search");
  c.activity.events = [event({ at: iso(y, mo, d, h, mi), external_id: n.external_id, repo: n.repo, title: n.title, kind: "transition", from: "Queued", to: "InProgress", event: "claimed" })];
});

Given("the factory has logged no event", function () {
  ctx(this).activity.events = [];
});

// ---- opening ----

When("I open Floor in the SPA", long, async function () {
  await open(this, "floor");
});

When("I open its Run detail in the SPA", long, async function () {
  await open(this, "item");
});

When("I open the Phase {int} report in the SPA", long, async function (n: number) {
  assert.equal(n, 0);
  await open(this, "phase0");
});

When("I open Activity in the SPA", long, async function () {
  await open(this, "activity");
});

// ---- submitting a form ----

async function submit(world: object, formName: string, button: string, value: string): Promise<void> {
  const c = ctx(world);
  const call = await shell(c);
  const item = c.data as ItemData;
  try {
    let r: Submitted<unknown>;
    if (formName === "Controls" && c.page === "floor") r = await (await floorModule()).submitFloorControls(call, button, value);
    else if (formName === "Controls" && c.page === "item") r = await (await itemModule()).submitItemControls(call, item, button, value);
    else if (formName === "Sign off") r = await (await itemModule()).submitSignOff(call, item, button, value);
    else if (formName === "Answer") r = await (await itemModule()).submitAnswer(call, item, button, value);
    else throw new Error(`no "${formName}" form on ${c.page ?? "no page"}`);
    c.submitted = { result: r };
    if (r?.outcome === "accepted") {
      c.data = r.data;
      c.message = null;
    } else if (r?.outcome === "failed") c.message = r.message;
  } catch (e) {
    c.submitted = { error: message(e) };
  }
  await render(world);
}

When("I submit the {string} form with {string} and the reason {string}", long, async function (f: string, button: string, reason: string) {
  await submit(this, f, button, reason);
});

When("I submit the {string} form with {string} and the note {string}", long, async function (f: string, button: string, note: string) {
  await submit(this, f, button, note);
});

When("I submit the {string} form with {string} and the answer {string}", long, async function (f: string, button: string, answer: string) {
  await submit(this, f, button, answer);
});

When("I submit the {string} form with {string} and {string} left empty", long, async function (f: string, button: string, _field: string) {
  await submit(this, f, button, "");
});

When("I submit the {string} form with {string} and {string} holding spaces only", long, async function (f: string, button: string, _field: string) {
  await submit(this, f, button, "   ");
});

When("I submit the {string} form with {string}", long, async function (f: string, button: string) {
  await submit(this, f, button, "");
});

const overridesSent = (c: Ctx) => c.requests.filter((r) => r.method === "POST" && r.path === "/bff/v1/overrides");
const decisionsSent = (c: Ctx) => c.requests.filter((r) => r.method === "POST" && /^\/bff\/v1\/items\/[^/]+\/decisions$/.test(r.path));

Given("I submitted the {string} form with {string} and {string} left empty, and no override was sent", long, async function (f: string, button: string, _field: string) {
  await submit(this, f, button, "");
  assert.deepEqual(overridesSent(ctx(this)), [], "an override was sent");
});

// ---- Then: Floor ----

export function floorRoot(world: object): El {
  return opened(ctx(world), "floor");
}

Then("under {string} Floor shows {string}", function (where: string, what: string) {
  includes(section(floorRoot(this), where), what, `Floor's "${where}"`);
});

Then("under {string} Floor shows {string} with {string}", function (where: string, what: string, detail: string) {
  const row = rowOf(section(floorRoot(this), where), what);
  includes(row, detail, `"${what}" under "${where}"`);
});

Then("under {string} Floor shows {string} with {string} and {string}", function (where: string, what: string, a: string, b: string) {
  const row = rowOf(section(floorRoot(this), where), what);
  includes(row, a, `"${what}" under "${where}"`);
  includes(row, b, `"${what}" under "${where}"`);
});

Then("under {string} Floor shows {string} with a link {string} to that PR and {string}", function (where: string, what: string, link: string, detail: string) {
  const c = ctx(this);
  const row = rowOf(section(floorRoot(this), where), what);
  const pr = c.floor.waiting.find((w) => what.includes(w.title))?.pr_url;
  assert.ok(links(row).some((l) => l.text === link && l.href === pr), `"${what}" has no link "${link}" to ${pr}: ${JSON.stringify(links(row))}`);
  includes(row, detail, `"${what}" under "${where}"`);
});

Then("{string} links to issue {int} of {string} on GitHub", function (ref: string, n: number, repo: string) {
  const found = links(opened(ctx(this))).filter((l) => l.text === ref);
  assert.ok(found.length > 0, `nothing links "${ref}"`);
  for (const l of found) assert.equal(l.href, `https://github.com/${repo}/issues/${n}`);
});

Then("{string} opens that item's Run detail in the SPA", function (title: string) {
  const c = ctx(this);
  const n = [...c.named.values()].find((x) => x.title === title);
  assert.ok(n, `no item is titled "${title}"`);
  const found = links(floorRoot(this)).filter((l) => l.text === title);
  assert.ok(found.length > 0, `nothing links "${title}"`);
  for (const l of found) assert.equal(l.href, `/runs/${n.id}`, `"${title}" doesn't open its Run detail`);
});

Then("Floor shows {string} as plain text, not a link", function (ref: string) {
  const root = floorRoot(this);
  includes(root, ref, "Floor");
  assert.deepEqual(links(root).filter((l) => l.text.includes(ref)), [], `Floor links "${ref}"`);
});

Then("under {string} Floor shows {string} split into, in order, {string} as {string}, {string} as {string} and {string} as {string}", function (where: string, what: string, a: string, as: string, b: string, bs: string, d: string, ds: string) {
  const s = section(floorRoot(this), where);
  const parent = all(s).filter((e) => e.tag === "li" && text(e).includes(what)).at(-1);
  assert.ok(parent, `"${where}" doesn't show "${what}"`);
  splitIn(parent, [[a, as], [b, bs], [d, ds]]);
});

function splitIn(scope: El, kids: string[][]): void {
  const items = all(scope).filter((e) => e.tag === "li");
  const rows = kids.map(([name, state]) => {
    const row = items.find((e) => text(e).includes(name) && !all(e).some((x) => x.tag === "li" && text(x).includes(name)));
    assert.ok(row, `no child shows "${name}": ${JSON.stringify(text(scope))}`);
    includes(row, state, `the child "${name}"`);
    return row;
  });
  for (let i = 1; i < rows.length; i++) assert.ok(before(scope, rows[i - 1], rows[i]), `"${kids[i - 1][0]}" doesn't come before "${kids[i][0]}"`);
}

Then("Floor shows {string} beside {string}", function (what: string, item: string) {
  includes(rowOf(floorRoot(this), item), what, `"${item}"`);
});

Then("Floor shows the badge {string} and {string} beside {string}", function (badge: string, what: string, item: string) {
  const row = rowOf(floorRoot(this), item);
  assert.ok(badges(row).includes(badge), `"${item}" has no badge "${badge}": ${JSON.stringify(badges(row))}`);
  includes(row, what, `"${item}"`);
});

Then("the {string} table has the columns {string}, {string}, {string}, {string}, {string} and {string}", function (name: string, cols0: string, cols1: string, cols2: string, cols3: string, cols4: string, cols5: string) {
  const cols = [cols0, cols1, cols2, cols3, cols4, cols5];
  columnsAre(this, name, cols);
});

Then("the {string} table has the columns {string}, {string}, {string} and {string}", function (name: string, cols0: string, cols1: string, cols2: string, cols3: string) {
  const cols = [cols0, cols1, cols2, cols3];
  columnsAre(this, name, cols);
});

Then("the {string} table has the columns {string}, {string}, {string}, {string}, {string}, {string}, {string}, {string}, {string} and {string}", function (name: string, cols0: string, cols1: string, cols2: string, cols3: string, cols4: string, cols5: string, cols6: string, cols7: string, cols8: string, cols9: string) {
  const cols = [cols0, cols1, cols2, cols3, cols4, cols5, cols6, cols7, cols8, cols9];
  columnsAre(this, name, cols);
});

function columnsAre(world: object, name: string, cols: string[]): void {
  const t = table(section(opened(ctx(world)), name), `"${name}"`);
  assert.deepEqual(t.columns, cols, `the "${name}" table's columns`);
}

/** The table a step about "its row" means: Floor's In flight, or the one table the open page has. */
function pageTable(world: object): Table {
  const c = ctx(world);
  const root = opened(c);
  if (c.page === "floor") return table(section(root, "In flight"), `"In flight"`);
  if (c.page === "item") return table(section(root, "Stages"), `"Stages"`);
  return table(root, PAGE_NAMES[c.page!]);
}

Then("its row for {string} shows {string}, {string}, {string}, {string} and {string}", function (item: string, want0: string, want1: string, want2: string, want3: string, want4: string) {
  const want = [want0, want1, want2, want3, want4];
  const t = pageTable(this);
  const row = rowFor(t, item);
  ctx(this).lastRow = { tag: "tr", attrs: {}, children: row, parent: null };
  showsCells(row, want);
});

Then("the row shows the badge {string}", function (badge: string) {
  const row = ctx(this).lastRow;
  assert.ok(row, "no row was read");
  assert.ok(badges(row).includes(badge), `the row has no badge "${badge}": ${JSON.stringify(badges(row))}`);
});

Then("the row's cost has the title {string}", function (title: string) {
  const c = ctx(this);
  assert.ok(c.lastRow, "no row was read");
  const row = c.lastRow.children as El[];
  titled(row, title);
});

Then("its Stage shows {string}", function (want: string) {
  const t = pageTable(this);
  assert.equal(t.rows.length, 1, "In flight doesn't hold one row");
  assert.equal(text(cell(t, t.rows[0], "Stage")), want);
});

Then("Floor shows the banner {string}", function (want: string) {
  const got = banners(floorRoot(this)).map(text);
  assert.ok(got.includes(want), `Floor has no banner "${want}": ${JSON.stringify(got)}`);
});

Then(/^Floor shows (?:the|a) banner beginning "([^"]*)"$/, function (lead: string) {
  const c = ctx(this);
  const b = banners(floorRoot(this)).find((e) => text(e).startsWith(lead));
  assert.ok(b, `Floor has no banner beginning "${lead}": ${JSON.stringify(banners(c.tree!).map(text))}`);
  c.lastBanner = b;
});

Then("Floor shows no banner beginning {string}", function (lead: string) {
  const got = banners(floorRoot(this)).map(text);
  assert.ok(!got.some((b) => b.startsWith(lead)), `Floor has a banner beginning "${lead}": ${JSON.stringify(got)}`);
});

Then("Floor shows no banner {string}", function (want: string) {
  const got = banners(floorRoot(this)).map(text);
  assert.ok(!got.includes(want), `Floor still has the banner "${want}"`);
});

Then("the banner says {string}", function (line: string) {
  const b = ctx(this).lastBanner;
  assert.ok(b, "no banner was read");
  includes(b, line, "the banner");
});

Then("the banner names {string} {string} with the tests {string} and {string}", function (item: string, at: string, a: string, b: string) {
  const banner = ctx(this).lastBanner;
  assert.ok(banner, "no banner was read");
  const row = rowOf(banner, item);
  includes(row, at, `"${item}" in the banner`);
  const tests = all(row).filter((e) => e.tag === "li").map(text);
  assert.ok(tests.includes(a) && tests.includes(b), `"${item}" doesn't list the tests "${a}" and "${b}": ${JSON.stringify(tests)}`);
});

Then("Floor links to Activity and to the Phase {int} report in the SPA", function (_n: number) {
  const ls = links(floorRoot(this));
  assert.ok(ls.some((l) => l.text === "Activity" && l.href === "/activity"), `Floor has no link "Activity" to /activity: ${JSON.stringify(ls)}`);
  assert.ok(ls.some((l) => l.text === "Phase 0 report" && l.href === "/phase0"), `Floor has no link "Phase 0 report" to /phase0: ${JSON.stringify(ls)}`);
});

const FLOOR_BUTTONS = ["Pause", "Drain", "Resume", "Kill switch", "Prepare restart"];
const ITEM_BUTTONS = ["Hold", "Release the hold", "Stop the run", "Re-queue", "Start now", "Move up", "Move down"];

function noControls(root: El, labels: string[], where: string): void {
  assert.equal(sectionOf(root, "Controls"), null, `${where} has a Controls section`);
  assert.ok(!all(root).some((e) => e.tag === "label" && text(e) === "Reason"), `${where} has a Reason field`);
  const got = buttons(root).map(buttonText).filter((b) => labels.includes(b));
  assert.deepEqual(got, [], `${where} offers override buttons`);
}

Then("Floor shows no {string} section, no Reason field and no override buttons", function (name: string) {
  assert.equal(name, "Controls");
  noControls(floorRoot(this), FLOOR_BUTTONS, "Floor");
});

Then("Floor has a text field labelled {string} under {string}", function (label: string, where: string) {
  const root = floorRoot(this);
  labelled(section(root, where), root, label, ["input"]);
});

Then("Floor has buttons with the text {string}, {string}, {string}, {string} and {string}", function (want0: string, want1: string, want2: string, want3: string, want4: string) {
  const want = [want0, want1, want2, want3, want4];
  const got = buttons(floorRoot(this)).map(buttonText);
  for (const w of want) assert.ok(got.includes(w), `Floor has no button "${w}": ${JSON.stringify(got)}`);
});

function everyLabelled(root: El, where: string): void {
  const fs = fields(root);
  assert.ok(fs.length > 0, `${where} has no input or textarea`);
  const labels = all(root).filter((e) => e.tag === "label");
  for (const f of fs) {
    assert.ok(f.attrs.id, `a <${f.tag}> on ${where} has no id`);
    const l = labels.filter((x) => x.attrs.for === f.attrs.id);
    assert.equal(l.length, 1, `the <${f.tag} id="${f.attrs.id}"> on ${where} has ${l.length} labels for it`);
    assert.ok(text(l[0]) !== "", `the label for "${f.attrs.id}" on ${where} has no text`);
  }
  const ids = all(root).map((e) => e.attrs.id).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length, `${where} repeats an id`);
  for (const b of buttons(root)) assert.ok(buttonText(b) !== "" || b.attrs["aria-label"], `a button on ${where} has no text`);
}

Then("every input and textarea on Floor has a label whose for matches its id, and every button has text", function () {
  everyLabelled(floorRoot(this), "Floor");
});

// ---- Then: Run detail ----

function itemRoot(world: object): El {
  return opened(ctx(world), "item");
}

Then("the heading is {string}, with {string} linking to the issue on GitHub", function (want: string, ref: string) {
  const c = ctx(this);
  const h1 = all(itemRoot(this)).find((e) => e.tag === "h1");
  assert.ok(h1, "Run detail has no <h1>");
  assert.equal(text(h1), want);
  const d = current(c);
  assert.ok(links(h1).some((l) => l.text === ref && l.href === `https://github.com/${d.item.repo}/issues/${d.item.external_id}`), `"${ref}" doesn't link to its issue: ${JSON.stringify(links(h1))}`);
});

Then("Run detail shows the item's heading {string}", function (want: string) {
  const h1 = all(itemRoot(this)).find((e) => e.tag === "h1");
  assert.ok(h1, "Run detail has no <h1>");
  assert.equal(text(h1), want);
});

Then("Run detail shows {string}, a link {string} to the PR, and {string}", function (state: string, link: string, rest: string) {
  const root = itemRoot(this);
  const pr = current(ctx(this)).run?.pr_url;
  includes(root, state, "Run detail");
  assert.ok(links(root).some((l) => l.text === link && l.href === pr), `Run detail has no link "${link}" to ${pr}`);
  includes(root, `${link}${rest}`, "Run detail");
});

Then("Run detail shows {string} {string}, {string} {string} and {string} {string}", function (a: string, av: string, b: string, bv: string, d: string, dv: string) {
  const root = itemRoot(this);
  termIs(root, a, av);
  termIs(root, b, bv);
  termIs(root, d, dv);
});

Then("Run detail shows {string} {string} and {string} {string}", function (a: string, av: string, b: string, bv: string) {
  const root = itemRoot(this);
  termIs(root, a, av);
  termIs(root, b, bv);
});

Then("Run detail shows {string} {string} with the reason {string}", function (name: string, value: string, why: string) {
  const got = term(itemRoot(this), name);
  assert.ok(got.startsWith(value), `"${name}" doesn't read "${value}": ${got}`);
  assert.ok(got.includes(why), `"${name}" doesn't give the reason "${why}": ${got}`);
});

Then("Run detail shows {string}, {string} and {string}", function (want0: string, want1: string, want2: string) {
  const want = [want0, want1, want2];
  const root = itemRoot(this);
  for (const w of want) includes(root, w, "Run detail");
});

Then("Run detail doesn't show {string} or {string}", function (a: string, b: string) {
  const got = text(itemRoot(this));
  assert.ok(!got.includes(a), `Run detail shows "${a}"`);
  assert.ok(!got.includes(b), `Run detail shows "${b}"`);
});

Then("Run detail says {string}", function (want: string) {
  includes(itemRoot(this), want, "Run detail");
});

Then("under {string} Run detail lists, in order, {string} as {string}, {string} as {string} and {string} as {string}", function (where: string, a: string, as: string, b: string, bs: string, d: string, ds: string) {
  splitIn(section(itemRoot(this), where), [[a, as], [b, bs], [d, ds]]);
});

Then("it lists {string}, linking to {string}, with the failing test {string}", function (name: string, url: string, test: string) {
  const root = itemRoot(this);
  const row = all(root).filter((e) => e.tag === "li" && links(e).some((l) => l.text === name)).at(-1);
  assert.ok(row, `Run detail lists no "${name}" linking to its run`);
  assert.ok(links(row).some((l) => l.text === name && l.href === url), `"${name}" doesn't link to ${url}`);
  const tests = all(row).filter((e) => e.tag === "li").map(text);
  assert.ok(tests.includes(test), `"${name}" doesn't list the failing test "${test}": ${JSON.stringify(tests)}`);
});

Then("Run detail lists {string} with {string}", function (name: string, what: string) {
  includes(rowOf(itemRoot(this), name), what, `"${name}"`);
});

function stagesTable(world: object): Table {
  return table(section(itemRoot(world), "Stages"), `"Stages"`);
}

function onlyRow(t: Table): El[] {
  assert.equal(t.rows.length, 1, `the table holds ${t.rows.length} rows, not one`);
  return t.rows[0];
}

Then("its row shows {string}, {string}, {string}, {string}, {string} and {string}", function (want0: string, want1: string, want2: string, want3: string, want4: string, want5: string) {
  const want = [want0, want1, want2, want3, want4, want5];
  const row = onlyRow(stagesTable(this));
  ctx(this).lastRow = { tag: "tr", attrs: {}, children: row, parent: null };
  showsCells(row, want);
});

Then("its tokens have the title {string} and its cost has the title {string}", function (tokens: string, cost: string) {
  const t = stagesTable(this);
  const row = onlyRow(t);
  titled(row, tokens, text(cell(t, row, "Tokens")));
  titled(row, cost, text(cell(t, row, "Cost")));
});

Then("its Transcript is a link {string} to the stored transcript", function (want: string) {
  const t = stagesTable(this);
  const row = onlyRow(t);
  const ref = current(ctx(this)).stages[0].transcript_ref;
  const ls = links(cell(t, row, "Transcript"));
  assert.deepEqual(ls, [{ href: `/bff/v1/blobs/${ref}`, text: want }]);
});

Then("its Notes say {string}", function (want: string) {
  const t = stagesTable(this);
  assert.equal(text(cell(t, onlyRow(t), "Notes")), want);
});

Then("that attempt's Notes say, in order, {string} and {string}", function (a: string, b: string) {
  const t = stagesTable(this);
  const got = text(cell(t, onlyRow(t), "Notes"));
  assert.ok(got.includes(a) && got.includes(b), `the Notes don't say "${a}" and "${b}": ${got}`);
  assert.ok(got.indexOf(a) < got.indexOf(b), `the Notes say "${b}" before "${a}"`);
});

Then("that attempt's Transcript shows {string} as plain text, not a link", function (ref: string) {
  const t = stagesTable(this);
  const c = cell(t, onlyRow(t), "Transcript");
  assert.equal(text(c), ref);
  assert.deepEqual(links(c), [], "the Transcript is a link");
});

Then("that attempt's Status is {string} and its Time spent is {string}", function (status: string, spent: string) {
  const t = stagesTable(this);
  const row = onlyRow(t);
  assert.equal(text(cell(t, row, "Status")), status);
  assert.equal(text(cell(t, row, "Time spent")), spent);
});

Then("that attempt's Started shows {string}", function (want: string) {
  const t = stagesTable(this);
  assert.equal(text(cell(t, onlyRow(t), "Started")), want);
});

Then("under {string} Run detail shows {string} {string}", function (where: string, name: string, value: string) {
  termIs(section(itemRoot(this), where), name, value);
});

Then("under {string} Run detail shows {string} {string} and {string} {string}", function (where: string, a: string, av: string, b: string, bv: string) {
  const s = section(itemRoot(this), where);
  termIs(s, a, av);
  termIs(s, b, bv);
});

Then("under {string} it shows {string} {string}, {string} {string}, {string} {string} and {string} {string}", function (where: string, pairs0: string, pairs1: string, pairs2: string, pairs3: string, pairs4: string, pairs5: string, pairs6: string, pairs7: string) {
  const pairs = [pairs0, pairs1, pairs2, pairs3, pairs4, pairs5, pairs6, pairs7];
  const s = section(itemRoot(this), where);
  for (let i = 0; i < pairs.length; i += 2) termIs(s, pairs[i], pairs[i + 1]);
});

Then("its {string} table shows {string} with {string} and {string} attempts", function (name: string, stage: string, time: string, attempts: string) {
  const t = table(section(itemRoot(this), name), `"${name}"`);
  const row = rowFor(t, stage);
  showsCells(row, [stage, time, attempts]);
});

Then("it shows {string}, {string}, {string} and {string}", function (want0: string, want1: string, want2: string, want3: string) {
  const want = [want0, want1, want2, want3];
  const t = table(section(itemRoot(this), "Policy results"), `"Policy results"`);
  const row = onlyRow(t);
  assert.deepEqual(row.map(text), want);
});

function readinessTable(world: object): Table {
  return table(section(itemRoot(world), "Readiness checks"), `"Readiness checks"`);
}

Then("its row shows {string}, {string}, {string} and {string}", function (want0: string, want1: string, want2: string, want3: string) {
  const want = [want0, want1, want2, want3];
  const row = onlyRow(readinessTable(this));
  ctx(this).lastRow = { tag: "tr", attrs: {}, children: row, parent: null };
  showsCells(row, want);
});

Then("the {string} table shows a {string} call whose Verdict is {string}", function (name: string, kind: string, verdict: string) {
  assert.equal(name, "Readiness checks");
  const t = readinessTable(this);
  const row = t.rows.find((r) => text(cell(t, r, "Call")) === kind);
  assert.ok(row, `no "${kind}" call: ${JSON.stringify(t.rows.map((r) => r.map(text)))}`);
  const v = cell(t, row, "Verdict");
  assert.equal(ownText(v), verdict);
  ctx(this).lastRow = v;
});

Then("under it the Verdict lists, in order, {string} and {string}", function (a: string, b: string) {
  const v = ctx(this).lastRow;
  assert.ok(v, "no Verdict was read");
  assert.deepEqual(all(v).filter((e) => e.tag === "li").map(text), [a, b]);
});

Then("the {string} table shows {string} with {string} and {string}", function (name: string, scenario: string, red: string, green: string) {
  const t = table(section(itemRoot(this), name), `"${name}"`);
  assert.deepEqual(rowFor(t, scenario).map(text), [scenario, red, green]);
});

Then("under {string} Run detail shows {string} with its text {string}", function (where: string, path: string, body: string) {
  const s = section(itemRoot(this), where);
  includes(s, path, `"${where}"`);
  includes(s, body, `"${where}"`);
});

Then("under {string} Run detail shows {string}", function (where: string, what: string) {
  includes(section(itemRoot(this), where), what, `"${where}"`);
});

Then("under {string} it lists {string} under {string}", function (where: string, scenario: string, criterion: string) {
  const s = section(itemRoot(this), where);
  const crit = all(s).find((e) => e.tag === "li" && ownText(e).startsWith(criterion));
  assert.ok(crit, `"${where}" doesn't list the criterion "${criterion}"`);
  assert.ok(all(crit).some((e) => e.tag === "li" && text(e).startsWith(scenario)), `"${scenario}" isn't listed under "${criterion}"`);
});

Then("it marks {string} {string}", function (what: string, mark: string) {
  const s = section(itemRoot(this), "Criteria and their scenarios");
  const li = all(s).filter((e) => e.tag === "li" && ownText(e).startsWith(what)).at(-1);
  assert.ok(li, `"${what}" isn't listed`);
  assert.ok(ownText(li).includes(mark), `"${what}" isn't marked "${mark}": ${ownText(li)}`);
});

Then("under {string} it shows {string} with its text", function (where: string, path: string) {
  const s = section(itemRoot(this), where);
  includes(s, path, `"${where}"`);
  const want = current(ctx(this)).pending.find((p) => p.path === path)?.text ?? "";
  const pre = all(s).filter((e) => e.tag === "pre" || e.tag === "code").map((e) => rawText(e).trim());
  assert.ok(pre.some((p) => p === want.trim()), `"${where}" doesn't show the text of ${path} as written: ${JSON.stringify(pre)}`);
});

Then("the {string} form, with {string}, {string} and {string}, comes after all of these", function (name: string, field: string, a: string, b: string) {
  const root = itemRoot(this);
  const f = form(root, name);
  labelled(f, root, field, ["textarea"]);
  const got = buttons(f).map(buttonText);
  assert.ok(got.includes(a) && got.includes(b), `the "${name}" form lacks "${a}" or "${b}": ${JSON.stringify(got)}`);
  for (const h of ["Scope", "Criteria and their scenarios", "Scenarios up for sign-off"]) {
    const s = all(root).find((e) => level(e) > 0 && text(e) === h);
    assert.ok(s, `Run detail has no "${h}"`);
    const last = all(section(root, h)).at(-1) ?? s;
    assert.ok(before(root, last, f), `the "${name}" form comes before the end of "${h}"`);
  }
});

function sent(c: Ctx, path: RegExp): Req[] {
  return c.requests.filter((r) => r.method === "POST" && path.test(r.path));
}

function submittedFine(c: Ctx): void {
  assert.ok(!c.submitted?.error, `the submit handler failed: ${c.submitted?.error}`);
}

function decisionIs(world: object, kind: string, label: string, text: string | null): void {
  const c = ctx(world);
  submittedFine(c);
  const n = named(c, label);
  const got = sent(c, new RegExp(`^/bff/v1/items/${n.id}/decisions$`));
  assert.equal(got.length, 1, `the SPA sent ${got.length} decisions on ${label}`);
  const body = got[0].body as { kind?: string; text?: string };
  assert.equal(body.kind, kind);
  if (text === null) assert.ok(body.text === "" || body.text === undefined, `the note isn't empty: ${JSON.stringify(body.text)}`);
  else assert.equal(body.text, text);
}

Then("the SPA sends the factory the decision {string} on {string} with the note {string}", function (kind: string, label: string, note: string) {
  decisionIs(this, kind, label, note);
});

Then("the SPA sends the factory the decision {string} on {string} with an empty note", function (kind: string, label: string) {
  decisionIs(this, kind, label, null);
});

Then("the SPA sends the factory the decision {string} on {string} with the text {string}", function (kind: string, label: string, t: string) {
  decisionIs(this, kind, label, t);
});

function readAgain(world: object, path: string, post: RegExp): void {
  const c = ctx(world);
  submittedFine(c);
  const at = c.requests.findIndex((r) => r.method === "POST" && post.test(r.path));
  assert.ok(at >= 0, "the SPA sent nothing");
  assert.ok(c.requests.slice(at + 1).some((r) => r.method === "GET" && r.path === path), `the SPA didn't read ${path} again after it was accepted`);
  assert.equal(c.submitted?.result?.outcome, "accepted", `the submit handler said ${JSON.stringify(c.submitted?.result)}`);
}

Then("the SPA reads the item from the factory again after the decision is accepted", function () {
  readAgain(this, `/bff/v1/items/${current(ctx(this)).item.id}`, /\/decisions$/);
});

Then("the SPA reads the item from the factory again after the answer is accepted", function () {
  readAgain(this, `/bff/v1/items/${current(ctx(this)).item.id}`, /\/decisions$/);
});

Then("the SPA reads the item from the factory again after the override is accepted", function () {
  readAgain(this, `/bff/v1/items/${current(ctx(this)).item.id}`, /^\/bff\/v1\/overrides$/);
});

Then("the SPA reads the floor from the factory again after the override is accepted", function () {
  readAgain(this, "/bff/v1/floor", /^\/bff\/v1\/overrides$/);
});

Then("Run detail no longer shows the {string} form", function (name: string) {
  assert.equal(formOf(itemRoot(this), name), null, `Run detail still shows the "${name}" form`);
});

Then("Run detail shows no {string} form and no {string} form", function (a: string, b: string) {
  const root = itemRoot(this);
  assert.equal(formOf(root, a), null, `Run detail shows the "${a}" form`);
  assert.equal(formOf(root, b), null, `Run detail shows the "${b}" form`);
});

Then("the SPA doesn't show the no-access page", function () {
  const c = ctx(this);
  itemRoot(this);
  assert.deepEqual(c.shown.filter((p) => p.kind === "no-access"), [], "the SPA showed the no-access page");
});

function requiredAndRefused(world: object, label: string, tags: string[]): void {
  const c = ctx(world);
  const root = opened(c);
  const f = labelled(root, root, label, tags);
  assert.ok("required" in f.attrs, `"${label}" isn't required`);
  submittedFine(c);
  assert.equal(c.submitted?.result?.outcome, "refused", `the submit handler didn't refuse: ${JSON.stringify(c.submitted?.result)}`);
}

Then("{string} is required, and the submit handler refuses an empty answer", function (label: string) {
  requiredAndRefused(this, label, ["textarea"]);
});

Then("{string} is required, and the submit handler refuses an empty reason", function (label: string) {
  requiredAndRefused(this, label, ["input"]);
});

Then("the SPA sends no decision", function () {
  const c = ctx(this);
  submittedFine(c);
  assert.deepEqual(decisionsSent(c), [], "the SPA sent a decision");
});

Then("the SPA sends no override", function () {
  const c = ctx(this);
  submittedFine(c);
  assert.deepEqual(overridesSent(c), [], "the SPA sent an override");
});

Then("the SPA sends the factory a factory-wide {string} override with the reason {string}", function (kind: string, reason: string) {
  const c = ctx(this);
  submittedFine(c);
  const got = overridesSent(c).map((r) => r.body as Record<string, unknown>);
  assert.equal(got.length, 1, `the SPA sent ${got.length} overrides: ${JSON.stringify(got)}`);
  assert.equal(got[0].kind, kind);
  assert.equal(got[0].reason, reason);
  assert.ok(!got[0].itemId, `the override names an item: ${got[0].itemId}`);
});

Then("the SPA sends the factory a {string} override on {string} with the reason {string}", function (kind: string, label: string, reason: string) {
  const c = ctx(this);
  submittedFine(c);
  const got = overridesSent(c).map((r) => r.body as Record<string, unknown>);
  assert.equal(got.length, 1, `the SPA sent ${got.length} overrides: ${JSON.stringify(got)}`);
  assert.deepEqual({ kind: got[0].kind, itemId: got[0].itemId, reason: got[0].reason }, { kind, itemId: named(c, label).id, reason });
});

function controlButtons(world: object): string[] {
  const root = itemRoot(world);
  return buttons(section(root, "Controls")).map(buttonText);
}

function exactly(got: string[], want: string[]): void {
  assert.deepEqual([...got].sort(), [...want].sort(), `the Controls offer ${JSON.stringify(got)}`);
}

Then("under {string} Run detail offers exactly the buttons {string} and {string}", function (_where: string, want0: string, want1: string) {
  const want = [want0, want1];
  exactly(controlButtons(this), want);
});

Then("under {string} Run detail offers exactly the buttons {string}, {string}, {string} and {string}", function (_where: string, want0: string, want1: string, want2: string, want3: string) {
  const want = [want0, want1, want2, want3];
  exactly(controlButtons(this), want);
});

Then("Run detail shows the buttons {string} and {string} under {string}", function (a: string, b: string, _where: string) {
  submittedFine(ctx(this));
  exactly(controlButtons(this), [a, b]);
});

function stateShown(root: El, state: string): void {
  const h1 = all(root).find((e) => e.tag === "h1");
  const hit = all(root).filter((e) => e !== h1 && !all(h1 ?? root).includes(e) && e.tag !== "button")
    .some((e) => new RegExp(`^${state}(?:$|[ ,.])`).test(text(e)));
  assert.ok(hit, `Run detail doesn't show the state "${state}": ${JSON.stringify(text(root).slice(0, 400))}`);
}

Then("Run detail shows the state {string} and the buttons {string} and {string} under {string}", function (state: string, a: string, b: string, _where: string) {
  submittedFine(ctx(this));
  stateShown(itemRoot(this), state);
  exactly(controlButtons(this), [a, b]);
});

Then("Run detail shows the state {string} and no {string} button", function (state: string, button: string) {
  submittedFine(ctx(this));
  const root = itemRoot(this);
  stateShown(root, state);
  assert.ok(!buttons(root).map(buttonText).includes(button), `Run detail still offers "${button}"`);
});

Then("Run detail shows no {string} section, no Reason field and no override buttons", function (name: string) {
  assert.equal(name, "Controls");
  noControls(itemRoot(this), ITEM_BUTTONS, "Run detail");
});

Then("Run detail has a text field labelled {string}", function (label: string) {
  const root = itemRoot(this);
  labelled(root, root, label, ["input"]);
});

Then("Run detail has a text area labelled {string}", function (label: string) {
  const root = itemRoot(this);
  labelled(root, root, label, ["textarea"]);
});

Then("every input and textarea on Run detail has a label whose for matches its id, and every button has text", function () {
  everyLabelled(itemRoot(this), "Run detail");
});

Then("the label {string} is for the sign-off note's id", function (label: string) {
  const root = itemRoot(this);
  const f = labelled(root, root, label, ["textarea"]);
  assert.ok(all(form(root, "Sign off")).includes(f), `"${label}" isn't for a field in the Sign off form`);
  (this as { pbi279ids?: string[] }).pbi279ids = [f.attrs.id];
});

Then("the label {string} is for the override reason's id", function (label: string) {
  const root = itemRoot(this);
  const f = labelled(root, root, label, ["input"]);
  assert.ok(all(form(root, "Controls")).includes(f), `"${label}" isn't for a field in the Controls form`);
  const w = this as { pbi279ids?: string[] };
  (w.pbi279ids ??= []).push(f.attrs.id);
});

Then("the two ids differ", function () {
  const ids = (this as { pbi279ids?: string[] }).pbi279ids ?? [];
  assert.equal(ids.length, 2, "the two labels weren't read");
  assert.notEqual(ids[0], ids[1]);
});

// ---- Then: Phase 0 ----

function phase0Root(world: object): El {
  return opened(ctx(world), "phase0");
}

Then("it shows {string}", function (want: string) {
  includes(phase0Root(this), want, "the Phase 0 report");
});

Then("it shows {string} {string}", function (name: string, value: string) {
  termIs(phase0Root(this), name, value);
});

Then("it shows {string} {string} and {string} {string}", function (a: string, av: string, b: string, bv: string) {
  const root = phase0Root(this);
  termIs(root, a, av);
  termIs(root, b, bv);
});

Then("its table has the columns {string}, {string}, {string}, {string} and {string}", function (cols0: string, cols1: string, cols2: string, cols3: string, cols4: string) {
  const cols = [cols0, cols1, cols2, cols3, cols4];
  const c = ctx(this);
  const t = table(opened(c), PAGE_NAMES[c.page!]);
  assert.deepEqual(t.columns, cols);
});

Then("its row for {string} shows a link to {string}, {string}, {string} and {string}", function (item: string, url: string, want0: string, want1: string, want2: string) {
  const want = [want0, want1, want2];
  const t = table(phase0Root(this), "The Phase 0 report");
  const row = rowFor(t, item);
  const pr = cell(t, row, "PR");
  assert.ok(links(pr).some((l) => l.href === url), `the PR cell doesn't link to ${url}: ${JSON.stringify(links(pr))}`);
  showsCells(row, want);
});

Then("its row for {string} shows {string} with the reason {string}", function (item: string, tier: string, why: string) {
  const t = table(phase0Root(this), "The Phase 0 report");
  const got = text(cell(t, rowFor(t, item), "Shadow tier"));
  assert.ok(got.startsWith(tier) && got.includes(why), `the Shadow tier reads "${got}"`);
});

Then("its row for {string} shows the Shadow tier {string}", function (item: string, tier: string) {
  const t = table(phase0Root(this), "The Phase 0 report");
  assert.equal(text(cell(t, rowFor(t, item), "Shadow tier")), tier);
});

// ---- Then: Activity ----

function activityTable(world: object): Table {
  return table(opened(ctx(world), "activity"), "Activity");
}

Then("Activity shows {string}", function (want: string) {
  includes(opened(ctx(this), "activity"), want, "Activity");
});

Then("its rows, in order, show {string}, {string}, {string} and {string}", function (want0: string, want1: string, want2: string, want3: string) {
  const want = [want0, want1, want2, want3];
  const t = activityTable(this);
  assert.deepEqual(t.rows.map((r) => text(cell(t, r, "Time (UTC)"))), want);
});

function moveOf(world: object, kind: string): string {
  const t = activityTable(world);
  const row = t.rows.find((r) => text(cell(t, r, "Kind")) === kind);
  assert.ok(row, `Activity has no "${kind}" event`);
  return text(cell(t, row, "Move"));
}

Then("the transition's Move shows {string}", function (want: string) {
  assert.equal(moveOf(this, "transition"), want);
});

Then("the override's Move shows {string}", function (want: string) {
  assert.equal(moveOf(this, "override"), want);
});

Then("the SOP move's Move shows {string}", function (want: string) {
  assert.equal(moveOf(this, "sop_moved"), want);
});

Then("the decision's Move is empty", function () {
  assert.equal(moveOf(this, "decision"), "");
});

Then("the first event's Item {string} links to issue {int} of {string} on GitHub", function (ref: string, n: number, repo: string) {
  const t = activityTable(this);
  assert.deepEqual(links(cell(t, t.rows[0], "Item")), [{ href: `https://github.com/${repo}/issues/${n}`, text: ref }]);
});

Then("the second event's Item shows {string} as plain text, not a link", function (ref: string) {
  const t = activityTable(this);
  assert.ok(t.rows[1], "Activity has no second event");
  const item = cell(t, t.rows[1], "Item");
  assert.equal(text(item), ref);
  assert.deepEqual(links(item), [], "the Item is a link");
});

Then("that event's Item is empty", function () {
  const t = activityTable(this);
  assert.ok(t.rows[0], "Activity has no event");
  assert.equal(text(cell(t, t.rows[0], "Item")), "");
});

Then("its Move shows {string}", function (want: string) {
  const t = activityTable(this);
  assert.ok(t.rows[0], "Activity has no event");
  assert.equal(text(cell(t, t.rows[0], "Move")), want);
});

Then("its time shows {string}", function (want: string) {
  const t = activityTable(this);
  assert.ok(t.rows[0], "Activity has no event");
  assert.equal(text(cell(t, t.rows[0], "Time (UTC)")), want);
});
