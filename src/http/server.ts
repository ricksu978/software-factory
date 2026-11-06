// The control plane's HTTP server: a plain node:http list of handlers, tried in order. Task 15 adds the dashboard's.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/** Answers a request and returns true, or returns false to let the next handler try. */
export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export function json(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) res.writeHead(status).end();
  else res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

/** Reads a JSON body. An empty body is {}, and a body that isn't JSON throws BadRequest. */
export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    const body = JSON.parse(text);
    if (body && typeof body === "object" && !Array.isArray(body)) return body;
  } catch {}
  throw new BadRequest("body isn't a JSON object");
}

/** Thrown by a handler for a request it refuses with 400. */
export class BadRequest extends Error {
  override name = "BadRequest";
}

/** Starts the server on 127.0.0.1 unless given a host. A handler that throws gets 400 for BadRequest and 500 otherwise. */
export function startServer(handlers: Handler[], opts: { port: number; host?: string }): Promise<Server> {
  const server = createServer(async (req, res) => {
    try {
      for (const handle of handlers) if (await handle(req, res)) return;
      json(res, 404);
    } catch (e) {
      if (!(e instanceof BadRequest)) console.error("request failed:", e);
      if (!res.headersSent) json(res, e instanceof BadRequest ? 400 : 500, { error: e instanceof BadRequest ? e.message : "internal error" });
      else res.destroy();
    }
  });
  return new Promise((resolve) => server.listen(opts.port, opts.host ?? "127.0.0.1", () => resolve(server)));
}
