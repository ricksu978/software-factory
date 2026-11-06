// The control plane's HTTP server: a plain node:http list of handlers, tried in order. Task 15 adds the dashboard's.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/** Answers a request and returns true, or returns false to let the next handler try. */
export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export function json(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) res.writeHead(status).end();
  else res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

const MAX_JSON = 1024 * 1024;

/**
 * Reads a JSON body of at most 1 MiB. An empty body is {}. A body that isn't a JSON object throws BadRequest, and a
 * bigger one throws BadRequest with status 413. The rest of a big body is drained, never kept, so no client can make
 * the process hold more than 1 MiB per request.
 */
export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size <= MAX_JSON) chunks.push(chunk as Buffer);
  }
  if (size > MAX_JSON) throw new BadRequest("the body is over 1 MiB", 413);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    const body = JSON.parse(text);
    if (body && typeof body === "object" && !Array.isArray(body)) return body;
  } catch {}
  throw new BadRequest("body isn't a JSON object");
}

/** Thrown by a handler for a request it refuses, with 400 unless it names another 4xx status. */
export class BadRequest extends Error {
  override name = "BadRequest";
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Starts the server on 127.0.0.1 unless given a host. A handler that throws gets BadRequest's status, or 500 for anything else. */
export function startServer(handlers: Handler[], opts: { port: number; host?: string }): Promise<Server> {
  const server = createServer(async (req, res) => {
    try {
      for (const handle of handlers) if (await handle(req, res)) return;
      json(res, 404);
    } catch (e) {
      if (!(e instanceof BadRequest)) console.error("request failed:", e);
      if (!res.headersSent) json(res, e instanceof BadRequest ? e.status : 500, { error: e instanceof BadRequest ? e.message : "internal error" });
      else res.destroy();
    }
  });
  return new Promise((resolve) => server.listen(opts.port, opts.host ?? "127.0.0.1", () => resolve(server)));
}
