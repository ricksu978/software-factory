// A stand-in for the orchestrator API, for PBI 289's scenarios. It records every call it gets, with its method, its
// path and query exactly as sent, its headers and its body, and answers each one as a scenario told it to, or 200 with
// {} when no scenario said.
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type ApiCall = { method: string; url: string; headers: IncomingHttpHeaders; body: string };
export type ApiAnswer = { status: number; body: string };

export type StandInApi = {
  /** The API's base address, such as http://127.0.0.1:41234, with no path. */
  url: string;
  calls: ApiCall[];
  /** Sets how the API answers `method` at `url`, the path and query. */
  answer(method: string, url: string, a: ApiAnswer): void;
  /** How the API will answer `method` at `url`, or undefined when no scenario said. */
  answering(method: string, url: string): ApiAnswer | undefined;
  stop(): Promise<void>;
};

export async function startApi(): Promise<StandInApi> {
  const answers = new Map<string, ApiAnswer>();
  const calls: ApiCall[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (d: string) => (body += d));
    req.on("end", () => {
      const method = req.method ?? "GET";
      const url = req.url ?? "/";
      calls.push({ method, url, headers: req.headers, body });
      const a = answers.get(`${method} ${url}`) ?? { status: 200, body: "{}" };
      res.writeHead(a.status, { "content-type": "application/json" }).end(a.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    answer(method, url, a) {
      answers.set(`${method.toUpperCase()} ${url}`, a);
    },
    answering(method, url) {
      return answers.get(`${method.toUpperCase()} ${url}`);
    },
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
