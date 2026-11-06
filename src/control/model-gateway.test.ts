import assert from "node:assert/strict";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { cellModelEnv, GatewayUnavailable, handleModelRequest, startModelGateway, type WebTool } from "./model-gateway.ts";

const port = (s: Server) => (s.address() as AddressInfo).port;
const listen = (s: Server) => new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
const close = (s: Server) => new Promise((r) => s.close(r));

/** Sends a raw request target, which fetch would normalise, and resolves with the status or the error code. */
function raw(gatewayPort: number, path: string, auth = "Bearer sk-ant-oat01-ok"): Promise<number | string> {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port: gatewayPort, method: "POST", path, headers: { authorization: auth } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "error"));
    req.end("{}");
  });
}

describe("model gateway", () => {
  let upstream: Server;
  let attacker: Server;
  let gateway: Server;
  const seen: { url?: string; headers: IncomingHttpHeaders }[] = [];
  const stolen: string[] = [];

  before(async () => {
    upstream = createServer((req, res) => {
      seen.push({ url: req.url, headers: req.headers });
      req.resume();
      // Two chunks, so the test proves the gateway streams instead of buffering one reply.
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: one\n\n");
      setTimeout(() => res.end("data: two\n\n"), 50);
    });
    attacker = createServer((req, res) => {
      stolen.push(`${req.url} ${req.headers.authorization}`);
      res.end();
    });
    await listen(upstream);
    await listen(attacker);
    gateway = await startModelGateway({ port: 0, upstream: `http://127.0.0.1:${port(upstream)}`, ownerToken: () => "owner", verify: (c) => (c === "ok" ? { webTools: [] } : null) });
  });
  after(async () => {
    await close(gateway);
    await close(upstream);
    await close(attacker);
  });

  const call = (headers: Record<string, string>) =>
    fetch(`http://127.0.0.1:${port(gateway)}/v1/messages?beta=true`, { method: "POST", headers, body: "{}" });

  test("swaps the token, drops x-api-key, keeps the path, query and other headers, and streams the reply", async () => {
    seen.length = 0;
    const r = await call({ authorization: "Bearer sk-ant-oat01-ok", "x-api-key": "leak", "anthropic-version": "2023-06-01" });
    assert.equal(r.status, 200);
    assert.equal(await r.text(), "data: one\n\ndata: two\n\n");
    assert.equal(seen[0].url, "/v1/messages?beta=true");
    assert.equal(seen[0].headers.authorization, "Bearer owner");
    assert.equal(seen[0].headers["x-api-key"], undefined);
    assert.equal(seen[0].headers["anthropic-version"], "2023-06-01");
  });

  test("refuses a missing, unprefixed or rejected credential without calling the upstream", async () => {
    seen.length = 0;
    for (const auth of ["", "Bearer ok", "Bearer sk-ant-oat01-forged"]) {
      const r = await call(auth ? { authorization: auth } : {});
      assert.equal(r.status, 401, auth);
    }
    assert.equal(seen.length, 0);
  });

  test("a request target naming another host never sends the owner's token there", async () => {
    seen.length = 0;
    const evil = `127.0.0.1:${port(attacker)}`;
    for (const target of [`//${evil}/steal`, `http://${evil}/steal`, `//${evil}/v1/messages`]) {
      assert.equal(await raw(port(gateway), target), 404, target);
    }
    assert.deepEqual(stolen, []);
    assert.equal(seen.length, 0);
  });

  test("a path outside the allowlist, such as the OAuth account endpoints, gets 404 and never reaches the upstream", async () => {
    seen.length = 0;
    for (const path of ["/api/oauth/claude_cli/roles", "/api/oauth/claude_cli/create_api_key", "/v1/models", "/v1/messages/../x"]) {
      assert.equal(await raw(port(gateway), path), 404, path);
    }
    assert.equal(seen.length, 0);
  });

  test("a malformed request target is refused and leaves the gateway serving", async () => {
    assert.equal(await raw(port(gateway), "http://[x"), 404);
    const r = await call({ authorization: "Bearer sk-ant-oat01-ok" });
    assert.equal(r.status, 200);
    await r.text();
  });

  test("a verify that throws counts as a refusal", async () => {
    const g = await startModelGateway({ port: 0, upstream: `http://127.0.0.1:${port(upstream)}`, ownerToken: () => "owner", verify: () => { throw new Error("db down"); } });
    try {
      assert.equal(await raw(port(g), "/v1/messages"), 401);
    } finally {
      await close(g);
    }
  });

  test("a verify that can't decide answers 503, not 401", async () => {
    const g = await startModelGateway({ port: 0, upstream: `http://127.0.0.1:${port(upstream)}`, ownerToken: () => "owner", verify: () => { throw new GatewayUnavailable("config read failed"); } });
    try {
      assert.equal(await raw(port(g), "/v1/messages"), 503);
    } finally {
      await close(g);
    }
  });

  test("handleModelRequest forwards the path it's given, so Task 12 can mount it under a prefix", async () => {
    seen.length = 0;
    const host = createServer((req, res) => void handleModelRequest({ upstream: `http://127.0.0.1:${port(upstream)}`, ownerToken: () => "owner", verify: () => ({ webTools: [] }) }, req, res, (req.url ?? "/").replace(/^\/internal\/model/, "")));
    await listen(host);
    try {
      assert.equal(await raw(port(host), "/internal/model/v1/messages"), 200);
      assert.equal(seen[0].url, "/v1/messages");
      assert.equal(await raw(port(host), "/internal/model//127.0.0.1:1/steal"), 404);
    } finally {
      await close(host);
    }
  });

  test("an unreachable upstream gets 502", async () => {
    const dead = await startModelGateway({ port: 0, upstream: "http://127.0.0.1:1", ownerToken: () => "owner", verify: () => ({ webTools: [] }) });
    try {
      assert.equal(await raw(port(dead), "/v1/messages"), 502);
    } finally {
      await close(dead);
    }
  });

  test("a cell that disconnects cancels its upstream call", async () => {
    let upstreamClosed = false;
    const endless = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "text/event-stream" });
      const timer = setInterval(() => res.write("data: more\n\n"), 20);
      res.on("close", () => {
        clearInterval(timer);
        upstreamClosed = true;
      });
    });
    await listen(endless);
    const g = await startModelGateway({ port: 0, upstream: `http://127.0.0.1:${port(endless)}`, ownerToken: () => "owner", verify: () => ({ webTools: [] }) });
    try {
      await new Promise<void>((resolve) => {
        const req = request({ host: "127.0.0.1", port: port(g), method: "POST", path: "/v1/messages", headers: { authorization: "Bearer sk-ant-oat01-x" } }, (res) => {
          res.once("data", () => {
            req.destroy();
            resolve();
          });
        });
        req.on("error", () => {});
        req.end("{}");
      });
      for (let i = 0; i < 50 && !upstreamClosed; i++) await new Promise((r) => setTimeout(r, 20));
      assert.ok(upstreamClosed, "the upstream call kept running after the cell disconnected");
    } finally {
      await close(g);
      endless.closeAllConnections();
      await close(endless);
    }
  });

  test("an upstream that dies mid-stream doesn't look like a complete reply", async () => {
    const dying = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: partial\n\n");
      setTimeout(() => res.socket?.destroy(), 30);
    });
    await listen(dying);
    const g = await startModelGateway({ port: 0, upstream: `http://127.0.0.1:${port(dying)}`, ownerToken: () => "owner", verify: () => ({ webTools: [] }) });
    try {
      const outcome = await new Promise<string>((resolve) => {
        const req = request({ host: "127.0.0.1", port: port(g), method: "POST", path: "/v1/messages", headers: { authorization: "Bearer sk-ant-oat01-x" } }, (res) => {
          res.on("data", () => {});
          res.on("end", () => resolve("clean end"));
          res.on("aborted", () => resolve("aborted"));
          res.on("error", () => resolve("aborted"));
        });
        req.on("error", () => resolve("aborted"));
        req.end("{}");
      });
      assert.equal(outcome, "aborted");
    } finally {
      await close(g);
      await close(dying);
    }
  });

  test("cellModelEnv gives a cell the gateway and a stand-in, never the owner's token", () => {
    assert.deepEqual(cellModelEnv({ gatewayUrl: "http://gw:1", credential: "run-1" }), {
      ANTHROPIC_BASE_URL: "http://gw:1",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-run-1",
    });
  });
});

describe("model gateway request check", () => {
  let upstream: Server;
  const bodies: { body: string; headers: IncomingHttpHeaders }[] = [];
  let webTools: WebTool[] = [];
  let gateway: Server;

  before(async () => {
    upstream = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        bodies.push({ body, headers: req.headers });
        res.writeHead(200).end("{}");
      });
    });
    await listen(upstream);
    gateway = await startModelGateway({ port: 0, upstream: `http://127.0.0.1:${port(upstream)}`, ownerToken: () => "owner", verify: () => ({ webTools }) });
  });
  after(async () => {
    await close(gateway);
    await close(upstream);
  });

  /** Sends a body as given, so a test can send bytes JSON.stringify would never produce. */
  function send(body: string | Buffer, headers: Record<string, string> = {}, chunked = false): Promise<number> {
    return new Promise((resolve, reject) => {
      const h: Record<string, string> = { authorization: "Bearer sk-ant-oat01-ok", "content-type": "application/json", ...headers };
      if (!chunked) h["content-length"] = String(Buffer.byteLength(body));
      const req = request({ host: "127.0.0.1", port: port(gateway), method: "POST", path: "/v1/messages", headers: h }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.on("error", reject);
      if (chunked) {
        const text = String(body);
        req.write(text.slice(0, 5));
        req.end(text.slice(5));
      } else req.end(body);
    });
  }
  const ok = (o: unknown) => send(JSON.stringify(o));
  const custom = { name: "Bash", input_schema: { type: "object", properties: { source: { type: "string" } } } };
  const image = (source: unknown) => ({ role: "user", content: [{ type: "image", source }] });

  test("custom tools, base64 images and source-shaped tool schemas and inputs reach the upstream", async () => {
    bodies.length = 0;
    webTools = [];
    assert.equal(await ok({ tools: [custom, { ...custom, type: "custom" }], messages: [image({ type: "base64", media_type: "image/png", data: "AA==" })] }), 200);
    assert.equal(await ok({ messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t", name: "AskUserQuestion", input: { metadata: { source: { type: "url" } } } }] }] }), 200);
    assert.equal(bodies.length, 2);
  });

  test("server tools, MCP servers, URL sources, bodies that aren't JSON and encoded bodies get 400 and reach nothing", async () => {
    bodies.length = 0;
    webTools = [];
    const refused: [string, number][] = [];
    for (const type of ["web_search_20250305", "web_fetch_20250910", "code_execution_20250522"]) refused.push([type, await ok({ tools: [{ type, name: "x" }] })]);
    refused.push(["mcp_servers", await ok({ mcp_servers: [] })]);
    refused.push(["url image", await ok({ messages: [image({ type: "url", url: "http://x" })] })]);
    refused.push(["url document in a tool_result", await ok({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "document", source: { type: "url", url: "http://x" } }] }] }] })]);
    refused.push(["url image in system", await ok({ system: [{ type: "image", source: { type: "url", url: "http://x" } }] })]);
    refused.push(["not JSON", await send("{not json")]);
    refused.push(["gzip", await send("{}", { "content-encoding": "gzip" })]);
    assert.deepEqual(refused.filter(([, s]) => s !== 400), []);
    assert.equal(bodies.length, 0);
  });

  test("a body with two tools keys goes upstream holding only the last one, as the gateway parsed it", async () => {
    bodies.length = 0;
    webTools = [];
    assert.equal(await send('{"tools":[{"type":"web_search_20250305","name":"w"}],"tools":[{"name":"Bash","input_schema":{}}]}'), 200);
    assert.deepEqual(JSON.parse(bodies[0].body), { tools: [{ name: "Bash", input_schema: {} }] });
  });

  test("with WebSearch and WebFetch allowed, web search passes and web fetch is still refused", async () => {
    webTools = ["WebSearch", "WebFetch"];
    assert.equal(await ok({ tools: [{ type: "web_search_20250305", name: "web_search" }] }), 200);
    assert.equal(await ok({ tools: [{ type: "web_fetch_20250910", name: "web_fetch" }] }), 400);
    webTools = [];
  });

  test("a chunked request goes upstream with a content-length and no transfer-encoding", async () => {
    bodies.length = 0;
    assert.equal(await send('{"messages":[]}', {}, true), 200);
    assert.equal(bodies[0].headers["transfer-encoding"], undefined);
    assert.equal(bodies[0].headers["content-length"], String(Buffer.byteLength('{"messages":[]}')));
  });

  test("a body over 32 MiB gets 413", async () => {
    bodies.length = 0;
    assert.equal(await send(Buffer.alloc(33 * 1024 * 1024, 0x20)), 413);
    assert.equal(bodies.length, 0);
  });
});
