// A stand-in for the orchestrator API, for PBI 289's and PBI 290's scenarios. It records every call it gets, with its
// method, its path and query exactly as sent, its headers and its body, both as the bytes that arrived and as UTF-8
// text, and answers each one as a scenario told it to, or 200 with {} when no scenario said.
// For PBI 290 it can also hold a call open as a stream of server-sent events: it sends each planned event at its time,
// ends the stream at a set time or holds it until the caller leaves, and records when each stream opened, when each
// event went out, and when the stream closed.
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type ApiCall = { method: string; url: string; headers: IncomingHttpHeaders; body: string; raw: Buffer };
export type ApiAnswer = { status: number; body: string };

/** A stream the API holds open: each event goes out `afterMs` after the call came, and it ends at `endAfterMs`, if set. */
export type StreamPlan = { events: { afterMs: number; event: string }[]; endAfterMs?: number };
/** A stream the API held, with times in epoch milliseconds. `closedAt` is when it ended, by the API or by its caller. */
export type ApiStream = {
  url: string;
  openedAt: number;
  sent: { event: string; at: number }[];
  closedAt?: number;
  /** Who closed it: the API, ending it as planned, or the caller, by leaving. */
  closedBy?: "api" | "caller";
};

export type StandInApi = {
  /** The API's base address, such as http://127.0.0.1:41234, with no path. */
  url: string;
  calls: ApiCall[];
  streams: ApiStream[];
  /** Sets how the API answers `method` at `url`, the path and query. */
  answer(method: string, url: string, a: ApiAnswer): void;
  /** How the API will answer `method` at `url`, or undefined when no scenario said. */
  answering(method: string, url: string): ApiAnswer | undefined;
  /** Makes a GET at `url` a stream of server-sent events that follows `plan`. */
  stream(url: string, plan: StreamPlan): void;
  /** The plan a GET at `url` will follow, or undefined when it isn't a stream. */
  streaming(url: string): StreamPlan | undefined;
  /** Whether the API is still listening. */
  readonly up: boolean;
  stop(): Promise<void>;
  /** Goes down while keeping its port: every connection, open or new, is dropped without an answer. Stopping instead
   * frees the port for another worker's server to take and answer on. */
  refuse(): void;
};

export async function startApi(): Promise<StandInApi> {
  const answers = new Map<string, ApiAnswer>();
  const plans = new Map<string, StreamPlan>();
  const calls: ApiCall[] = [];
  const streams: ApiStream[] = [];
  const timers = new Set<NodeJS.Timeout>();
  let up = true;
  let refusing = false;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (d: Buffer) => chunks.push(d));
    req.on("end", () => {
      const method = req.method ?? "GET";
      const url = req.url ?? "/";
      const raw = Buffer.concat(chunks);
      calls.push({ method, url, headers: req.headers, body: raw.toString("utf8"), raw });
      const plan = method === "GET" ? plans.get(url) : undefined;
      if (plan) {
        hold(url, plan, res);
        return;
      }
      const a = answers.get(`${method} ${url}`) ?? { status: 200, body: "{}" };
      res.writeHead(a.status, { "content-type": "application/json" }).end(a.body);
    });
  });

  const later = (ms: number, f: () => void) => {
    const t = setTimeout(() => {
      timers.delete(t);
      f();
    }, ms);
    timers.add(t);
    return t;
  };

  function hold(url: string, plan: StreamPlan, res: import("node:http").ServerResponse): void {
    const s: ApiStream = { url, openedAt: Date.now(), sent: [] };
    streams.push(s);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.flushHeaders();
    const mine = new Set<NodeJS.Timeout>();
    const close = (by: "api" | "caller") => {
      if (s.closedAt !== undefined) return;
      s.closedAt = Date.now();
      s.closedBy = by;
      for (const t of mine) {
        clearTimeout(t);
        timers.delete(t);
      }
    };
    res.on("close", () => close("caller"));
    for (const e of plan.events) {
      mine.add(later(e.afterMs, () => {
        if (s.closedAt !== undefined) return;
        res.write(`event: ${e.event}\ndata: ${JSON.stringify({ event: e.event })}\n\n`);
        s.sent.push({ event: e.event, at: Date.now() });
      }));
    }
    if (plan.endAfterMs !== undefined) {
      mine.add(later(plan.endAfterMs, () => {
        close("api");
        res.end();
      }));
    }
  }

  server.on("connection", (socket) => {
    if (refusing) socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    streams,
    answer(method, url, a) {
      answers.set(`${method.toUpperCase()} ${url}`, a);
    },
    answering(method, url) {
      return answers.get(`${method.toUpperCase()} ${url}`);
    },
    stream(url, plan) {
      plans.set(url, plan);
    },
    streaming(url) {
      return plans.get(url);
    },
    get up() {
      return up;
    },
    refuse() {
      up = false;
      refusing = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      server.closeAllConnections();
    },
    async stop() {
      if (refusing) {
        refusing = false;
        await new Promise<void>((resolve) => server.close(() => resolve()));
        return;
      }
      if (!up) return;
      up = false;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
