// Serves the SPA's built files (redesign step 8a, 2026-11-07 design §04): what `npm run build` writes to web/dist.
//   - A path naming a built file gets that file. Files under /assets/ carry a content hash in their names, so they are
//     cached for good. Everything else is checked again on each load.
//   - A path whose last segment has a file extension but names no built file gets 404, so a missing script or stylesheet
//     never comes back as the SPA's page.
//   - Any other path gets the SPA's page, index.html, so a deep link such as /runs/482 opens the SPA, which routes it.
//   - /auth and /bff, and anything under them, belong to the BFF. A path there that no BFF route answered gets 404.
// Only the built files are reachable: a path is decoded once, and one with a ".." segment, a backslash or a NUL, or one
// that resolves outside the build, gets 404.
import type { Context } from "hono";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const notFound = (c: Context) => c.text("Not found", 404);

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** A Hono handler for GET and HEAD that serves the SPA built into `dist`. Mount it after the BFF's own routes. */
export function serveSpa(dist: string) {
  const root = resolve(dist);
  const page = join(root, "index.html");

  return async (c: Context) => {
    let path: string;
    try {
      path = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return notFound(c);
    }
    if (/^\/(auth|bff)(\/|$)/.test(path)) return notFound(c);
    const segments = path.split("/").filter(Boolean);
    if (segments.some((s) => s === ".." || s === ".") || /[\\\0]/.test(path)) return notFound(c);

    const file = resolve(root, ...segments);
    if (file !== root && !file.startsWith(root + sep)) return notFound(c);

    if (segments.length && (await isFile(file))) {
      const immutable = segments[0] === "assets";
      return send(c, file, immutable ? "public, max-age=31536000, immutable" : "no-cache");
    }
    if (extname(segments.at(-1) ?? "")) return notFound(c);
    if (!(await isFile(page))) return c.text("The SPA isn't built yet: run npm run build.", 503);
    return send(c, page, "no-cache");
  };
}

async function send(c: Context, file: string, cacheControl: string): Promise<Response> {
  const body = new Uint8Array(await readFile(file));
  const headers = {
    "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    "cache-control": cacheControl,
    "x-content-type-options": "nosniff",
  };
  // Hono answers a HEAD with this GET handler's headers and no body.
  return c.body(body, 200, headers);
}
