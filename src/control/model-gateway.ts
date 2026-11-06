// The model gateway (issue #33). A cell holds only a stand-in token for its own run. The gateway checks it,
// swaps in the owner's Claude token, and forwards everything else unchanged, so a steered agent can't leak the
// owner's token. Built-in modules only, because the @local scenarios run it from a mounted src/ in the cell image.
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { pipeline } from "node:stream";

// Claude Code sends CLAUDE_CODE_OAUTH_TOKEN as "Authorization: Bearer <token>", and the prefix marks it as a
// subscription token, so the cell's own anthropic-beta carries the OAuth capability the upstream needs.
const prefix = "sk-ant-oat01-";

// The only upstream paths a cell may reach with the owner's token: what issue #33's spike saw the agent use, plus
// token counting. Anything else, such as the OAuth account endpoints on the same host, gets 404. The target is
// always the configured upstream's origin, so a request target naming another host can't redirect the token.
const allowedPaths = new Set(["/v1/messages", "/v1/messages/count_tokens", "/api/hello"]);
// The paths whose bodies the gateway reads and checks before anything goes upstream (plan Task 12, "Request check").
const checkedPaths = new Set(["/v1/messages", "/v1/messages/count_tokens"]);
const MAX_BODY = 32 * 1024 * 1024;

export type WebTool = "WebSearch" | "WebFetch";
/** What a verified run may use: the web tools its pinned repo config allows. */
export type Grant = { webTools: WebTool[] };

/** Thrown by `verify` when it can't decide right now, such as a failed config read. The cell gets 503, not 401. */
export class GatewayUnavailable extends Error {
  override name = "GatewayUnavailable";
}

export type GatewayConfig = {
  upstream: string;
  ownerToken: () => string;
  /** The run's grant for a stand-in credential, or null to refuse it. */
  verify: (credential: string) => Grant | null | Promise<Grant | null>;
};

/** The model variables for a cell's environment: the gateway's URL and a stand-in token for the run, never the owner's. */
export function cellModelEnv(cfg: { gatewayUrl: string; credential: string }): Record<string, string> {
  return { ANTHROPIC_BASE_URL: cfg.gatewayUrl, CLAUDE_CODE_OAUTH_TOKEN: `${prefix}${cfg.credential}` };
}

async function allowed(cfg: GatewayConfig, auth: string | undefined): Promise<Grant | null | "unavailable"> {
  if (!auth?.startsWith(`Bearer ${prefix}`)) return null;
  try {
    return await cfg.verify(auth.slice(`Bearer ${prefix}`.length));
  } catch (e) {
    return e instanceof GatewayUnavailable ? "unavailable" : null;
  }
}

// A `source` of any other type makes Anthropic's servers fetch a URL, which would get past the cell's egress allowlist.
const inlineSources = new Set(["base64", "text", "content"]);

function foreignSource(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(foreignSource);
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  const source = o.source;
  if (source && typeof source === "object" && !Array.isArray(source) && !inlineSources.has((source as { type?: unknown }).type as string)) return true;
  // A tool_use block's input and any tools list are never read as content, and their JSON schemas may name a `source`.
  return Object.entries(o).some(([k, child]) => !(k === "input" && o.type === "tool_use") && k !== "tools" && foreignSource(child));
}

/**
 * Why a /v1/messages body may not go upstream, or null when it may. Only custom tools pass, plus server web search
 * when the run's config allows WebSearch. Web fetch, code execution, MCP servers and URL sources all make Anthropic's
 * servers reach out on the cell's behalf, so they're refused whatever the config says.
 */
export function refusal(body: unknown, webTools: WebTool[]): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "the body isn't a JSON object";
  const b = body as Record<string, unknown>;
  if ("mcp_servers" in b) return "mcp_servers isn't allowed";
  if (b.tools !== undefined) {
    if (!Array.isArray(b.tools)) return "tools isn't a list";
    for (const tool of b.tools) {
      const type = (tool as { type?: unknown } | null)?.type;
      if (type === undefined || type === "custom") continue;
      if (typeof type === "string" && type.startsWith("web_search_") && webTools.includes("WebSearch")) continue;
      return `the tool type ${String(type)} isn't allowed`;
    }
  }
  if (foreignSource(b.messages) || foreignSource(b.system)) return "a source that isn't inline isn't allowed";
  return null;
}

/** Reads the request body, or returns null once it passes `limit`, draining the rest so the 413 still reaches the cell. */
async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size <= limit) chunks.push(chunk as Buffer);
  }
  return size > limit ? null : Buffer.concat(chunks);
}

/** The upstream URL for a request path, or null when the path isn't one a cell may reach. Never trusts a host in the path. */
function targetFor(upstream: string, path: string): URL | null {
  const q = path.indexOf("?");
  const pathname = q === -1 ? path : path.slice(0, q);
  if (!allowedPaths.has(pathname)) return null;
  const target = new URL(upstream);
  target.pathname = pathname;
  target.search = q === -1 ? "" : path.slice(q);
  return target;
}

function refuse(req: IncomingMessage, res: ServerResponse, status: number): void {
  req.resume();
  if (!res.headersSent) res.writeHead(status);
  res.end();
}

/**
 * Forwards one model request. A stand-in the run check rejects gets 401, a check that can't run gets 503, and a
 * path outside the allowlist gets 404; none reaches the upstream. A /v1/messages body is read whole, up to 32 MiB
 * (413 above), and one that `refusal` names, or that isn't identity-encoded JSON, gets 400. What goes upstream is
 * the checked object re-serialised, so a parser that reads the original bytes differently never sees them.
 * Otherwise the owner's token replaces Authorization, any x-api-key is dropped, and every other header,
 * anthropic-beta included, goes through unchanged, as the gateway protocol requires
 * (https://code.claude.com/docs/en/llm-gateway-protocol.md). `path` lets Task 12 mount it under a prefix.
 * It never throws: a malformed request gets 400, so one cell can't crash the process that hosts it.
 */
export async function handleModelRequest(cfg: GatewayConfig, req: IncomingMessage, res: ServerResponse, path = req.url ?? "/"): Promise<void> {
  try {
    const grant = await allowed(cfg, req.headers.authorization);
    if (grant === "unavailable") return refuse(req, res, 503);
    if (!grant) return refuse(req, res, 401);
    const target = targetFor(cfg.upstream, path);
    if (!target) return refuse(req, res, 404);
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    delete headers["x-api-key"];
    headers.authorization = `Bearer ${cfg.ownerToken()}`;
    let body: Buffer | null = null;
    if (checkedPaths.has(target.pathname)) {
      const encoding = req.headers["content-encoding"];
      if (encoding !== undefined && encoding !== "identity") return refuse(req, res, 400);
      const raw = await readBody(req, MAX_BODY);
      if (!raw) return refuse(req, res, 413);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch {
        return refuse(req, res, 400);
      }
      if (refusal(parsed, grant.webTools)) return refuse(req, res, 400);
      body = Buffer.from(JSON.stringify(parsed));
      delete headers["transfer-encoding"];
      delete headers["content-encoding"];
      headers["content-length"] = String(body.length);
    }
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const up = send(target, { method: req.method, headers }, (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      // pipeline, not pipe: an upstream reset mid-stream errors upRes, not `up`, and pipeline then destroys res, so
      // a cut-off stream never ends cleanly for the cell.
      pipeline(upRes, res, () => {});
    });
    // A cell that disconnects, or is stopped, cancels its upstream call instead of leaving it running on the
    // owner's subscription.
    res.on("close", () => {
      if (!res.writableFinished) up.destroy();
    });
    up.on("error", () => {
      // After the headers went out, a clean end would make a cut-off stream look complete, so it's destroyed.
      if (res.headersSent) res.destroy();
      else res.writeHead(502).end();
    });
    if (body) up.end(body);
    else req.pipe(up);
  } catch {
    refuse(req, res, 400);
  }
}

/** A standalone gateway. It listens on 127.0.0.1 unless given a host, so a test never opens a port beyond the machine. */
export function startModelGateway(cfg: GatewayConfig & { port: number; host?: string }): Promise<Server> {
  const server = createServer((req, res) => void handleModelRequest(cfg, req, res));
  return new Promise((resolve) => server.listen(cfg.port, cfg.host ?? "127.0.0.1", () => resolve(server)));
}
