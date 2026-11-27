// What the step files that once drove today's dashboard (src/http/routes.ts) or the combined control plane
// (src/main.ts) share now that they drive the split services (PBI 283, 2026-11-07 design §11 and §12).
//
// A step file builds the orchestrator API itself, from src/api/main.ts's apiApp, with `verify: testBearer`, and calls
// it with callApi as the person it names. The test bearer token is the person's name, and testBearer reads it back as
// that subject at TEST_ISSUER, so no issuer has to run. PBI 284's steps check the real JWT checks; these steps check
// what the API answers. A person these steps' Givens add the way today's dashboard knew them, by a provider and their
// name as subject, is put under TEST_ISSUER before each call, as signing in at the provider would key them.
//
// The pages a person sees are the SPA's own, web/src/pages/*.tsx, rendered by renderPage from what the API answered,
// as the browser renders them. Node can't strip JSX, so Vite's SSR loader loads the pages with the SPA's own config,
// as web/src/page.test.ts and PBI 279's steps do.
import { AfterAll } from "@cucumber/cucumber";
import { join } from "node:path";
import type pg from "pg";
import { createElement, type ComponentType } from "react";
import { renderToString } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";
import type { VerifyBearer } from "../../src/api/auth.ts";

/** The issuer every test bearer token speaks for. */
export const TEST_ISSUER = "https://sign-in.test/realms/factory";
/** The audience the test API is set up with. testBearer doesn't read it. */
export const TEST_AUDIENCE = "factory-api";

/** `Authorization: Bearer <name>` as the person `name` at TEST_ISSUER, and anything else as no one. */
export const testBearer: VerifyBearer = async (authorization) => {
  const token = /^Bearer +(\S+)$/i.exec(authorization ?? "")?.[1];
  return token ? { issuer: TEST_ISSUER, subject: decodeURIComponent(token) } : null;
};

/** The API's Hono app, as apiApp returns it. */
export type ApiApp = { request(path: string, init?: RequestInit): Response | Promise<Response> };

export type Answer = { status: number; text: string; json?: unknown };

/** Puts the person known by `subject` under `issuer`, when they're known only by a provider so far. */
export async function underIssuer(pool: pg.Pool, issuer: string, subject: string): Promise<void> {
  await pool.query(
    `update "user" set issuer = $1 where issuer is null and subject = $2
       and not exists (select 1 from "user" u where u.issuer = $1 and u.subject = $2)`,
    [issuer, subject],
  );
}

/** Puts the person known by `subject` under TEST_ISSUER, when they're known only by a provider so far. */
export const underTestIssuer = (pool: pg.Pool, subject: string) => underIssuer(pool, TEST_ISSUER, subject);

/**
 * `verify`, which then puts the caller it proves under their issuer when they're known only by a provider so far, so
 * a step that adds people as today's dashboard knew them can call the API with a plain fetch.
 */
export function keying(pool: pg.Pool, verify: VerifyBearer): VerifyBearer {
  return async (authorization) => {
    const who = await verify(authorization);
    if (who) await underIssuer(pool, who.issuer, who.subject);
    return who;
  };
}

/**
 * Calls the API as `person`, or with no token when `person` is null, and reads its answer. A body goes as JSON. Every
 * person known only by a provider is put under TEST_ISSUER first.
 */
export async function callApi(app: ApiApp, pool: pg.Pool, person: string | null, method: string, path: string, body?: unknown): Promise<Answer> {
  if (person !== null) await underTestIssuer(pool, person);
  const headers: Record<string, string> = {};
  if (person !== null) headers.authorization = `Bearer ${encodeURIComponent(person)}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: r.status, text, json };
}

// ---- The SPA's pages ----

const WEB = join(import.meta.dirname, "..", "..", "web");
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

AfterAll({ timeout: 60_000 }, async function () {
  await vite?.close();
  vite = undefined;
});

export type Page = "floor" | "item" | "phase0" | "activity" | "configuration";
const COMPONENTS: Record<Page, [string, string]> = {
  floor: ["/src/pages/Floor.tsx", "Floor"],
  item: ["/src/pages/RunDetail.tsx", "RunDetail"],
  phase0: ["/src/pages/Phase0.tsx", "Phase0"],
  activity: ["/src/pages/Activity.tsx", "Activity"],
  configuration: ["/src/pages/Configuration.tsx", "Configuration"],
};

/** The SPA's no-access page, which its shell shows when the API answers a read with 403, saying `text`. */
export async function renderNoAccess(text: string): Promise<string> {
  const mod = await load<Record<string, ComponentType<{ text: string }>>>("/src/pages/NoAccess.tsx");
  return renderToString(createElement(mod.NoAccess, { text }));
}

/**
 * The SPA's `page` rendered from `data`, what the API answered for it, in the viewer's zone at `now`. `message` is what
 * the page says about the last form sent, such as why the factory refused it, and `notice` what the Configuration page
 * says once a change is saved.
 */
export async function renderPage(page: Page, data: unknown, o: { zone?: string; now?: Date; message?: string | null; notice?: string | null } = {}): Promise<string> {
  const [path, name] = COMPONENTS[page];
  const mod = await load<Record<string, ComponentType<Record<string, unknown>>>>(path);
  return renderToString(createElement(mod[name], { data, zone: o.zone ?? "UTC", now: o.now ?? new Date(), message: o.message ?? null, notice: o.notice ?? null }));
}
