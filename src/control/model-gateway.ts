// The model gateway (issue #33). A cell holds only a stand-in token for its own run. The gateway checks it,
// swaps in the owner's Claude token, and forwards everything else unchanged, so a steered agent can't leak the
// owner's token. Built-in modules only, because the @local scenarios run it from a mounted src/ in the cell image.
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";

// Claude Code sends CLAUDE_CODE_OAUTH_TOKEN as "Authorization: Bearer <token>", and the prefix marks it as a
// subscription token, so the cell's own anthropic-beta carries the OAuth capability the upstream needs.
const prefix = "sk-ant-oat01-";

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

/**
 * Forwards one model request. A stand-in the run check rejects gets 401 and never reaches the upstream.
 * Otherwise the owner's token replaces Authorization, any x-api-key is dropped, and every other header,
 * anthropic-beta included, goes through unchanged, as the gateway protocol requires
 * (https://code.claude.com/docs/en/llm-gateway-protocol.md). `path` lets Task 12 mount it under a prefix.
 */
export async function handleModelRequest(cfg: GatewayConfig, req: IncomingMessage, res: ServerResponse, path = req.url ?? "/"): Promise<void> {
  if (!(await allowed(cfg, req.headers.authorization))) {
    req.resume();
    res.writeHead(401).end();
    return;
  }
  const target = new URL(path, cfg.upstream);
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  delete headers["x-api-key"];
  headers.authorization = `Bearer ${cfg.ownerToken()}`;
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  const up = send(target, { method: req.method, headers }, (upRes) => {
    res.writeHead(upRes.statusCode ?? 502, upRes.headers);
    upRes.pipe(res);
  });
  up.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(up);
}

/** A standalone gateway. It listens on 127.0.0.1 unless given a host, so a test never opens a port beyond the machine. */
export function startModelGateway(cfg: GatewayConfig & { port: number; host?: string }): Promise<Server> {
  const server = createServer((req, res) => void handleModelRequest(cfg, req, res));
  return new Promise((resolve) => server.listen(cfg.port, cfg.host ?? "127.0.0.1", () => resolve(server)));
}
