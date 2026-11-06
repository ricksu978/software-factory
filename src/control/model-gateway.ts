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

export type GatewayConfig = {
  upstream: string;
  ownerToken: () => string;
  verify: (credential: string) => boolean | Promise<boolean>;
};

/** The model variables for a cell's environment: the gateway's URL and a stand-in token for the run, never the owner's. */
export function cellModelEnv(cfg: { gatewayUrl: string; credential: string }): Record<string, string> {
  return { ANTHROPIC_BASE_URL: cfg.gatewayUrl, CLAUDE_CODE_OAUTH_TOKEN: `${prefix}${cfg.credential}` };
}

async function allowed(cfg: GatewayConfig, auth: string | undefined): Promise<boolean> {
  if (!auth?.startsWith(`Bearer ${prefix}`)) return false;
  try {
    return await cfg.verify(auth.slice(`Bearer ${prefix}`.length));
  } catch {
    return false;
  }
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
 * Forwards one model request. A stand-in the run check rejects gets 401, and a path outside the allowlist gets
 * 404; neither reaches the upstream. Otherwise the owner's token replaces Authorization, any x-api-key is
 * dropped, and every other header, anthropic-beta included, goes through unchanged, as the gateway protocol
 * requires (https://code.claude.com/docs/en/llm-gateway-protocol.md). `path` lets Task 12 mount it under a prefix.
 * It never throws: a malformed request gets 400, so one cell can't crash the process that hosts it.
 */
export async function handleModelRequest(cfg: GatewayConfig, req: IncomingMessage, res: ServerResponse, path = req.url ?? "/"): Promise<void> {
  try {
    if (!(await allowed(cfg, req.headers.authorization))) return refuse(req, res, 401);
    const target = targetFor(cfg.upstream, path);
    if (!target) return refuse(req, res, 404);
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    delete headers["x-api-key"];
    headers.authorization = `Bearer ${cfg.ownerToken()}`;
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
    req.pipe(up);
  } catch {
    refuse(req, res, 400);
  }
}

/** A standalone gateway. It listens on 127.0.0.1 unless given a host, so a test never opens a port beyond the machine. */
export function startModelGateway(cfg: GatewayConfig & { port: number; host?: string }): Promise<Server> {
  const server = createServer((req, res) => void handleModelRequest(cfg, req, res));
  return new Promise((resolve) => server.listen(cfg.port, cfg.host ?? "127.0.0.1", () => resolve(server)));
}
