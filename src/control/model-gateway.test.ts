import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { cellModelEnv, handleModelRequest, startModelGateway } from "./model-gateway.ts";

const port = (s: Server) => (s.address() as AddressInfo).port;

describe("model gateway", () => {
  let upstream: Server;
  let gateway: Server;
  const seen: { url?: string; headers: IncomingHttpHeaders }[] = [];

  before(async () => {
    upstream = createServer((req, res) => {
      seen.push({ url: req.url, headers: req.headers });
      req.resume();
      // Two chunks, so the test proves the gateway streams instead of buffering one reply.
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: one\n\n");
      setTimeout(() => res.end("data: two\n\n"), 50);
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    gateway = await startModelGateway({ port: 0, upstream: `http://127.0.0.1:${port(upstream)}`, ownerToken: () => "owner", verify: (c) => c === "ok" });
  });
  after(async () => {
    await new Promise((r) => gateway.close(r));
    await new Promise((r) => upstream.close(r));
  });

  const call = (headers: Record<string, string>) =>
    fetch(`http://127.0.0.1:${port(gateway)}/v1/messages?beta=true`, { method: "POST", headers, body: "{}" });

  test("swaps the token, drops x-api-key, keeps the path and other headers, and streams the reply", async () => {
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

  test("a verify that throws counts as a refusal", async () => {
    const g = await startModelGateway({ port: 0, upstream: `http://127.0.0.1:${port(upstream)}`, ownerToken: () => "owner", verify: () => { throw new Error("db down"); } });
    try {
      const r = await fetch(`http://127.0.0.1:${port(g)}/v1/messages`, { method: "POST", headers: { authorization: "Bearer sk-ant-oat01-ok" }, body: "{}" });
      assert.equal(r.status, 401);
    } finally {
      await new Promise((r) => g.close(r));
    }
  });

  test("handleModelRequest forwards the path it's given, so Task 12 can mount it under a prefix", async () => {
    seen.length = 0;
    const host = createServer((req, res) => void handleModelRequest({ upstream: `http://127.0.0.1:${port(upstream)}`, ownerToken: () => "owner", verify: () => true }, req, res, (req.url ?? "/").replace(/^\/internal\/model/, "")));
    await new Promise<void>((r) => host.listen(0, "127.0.0.1", r));
    try {
      await (await fetch(`http://127.0.0.1:${port(host)}/internal/model/v1/messages`, { method: "POST", headers: { authorization: "Bearer sk-ant-oat01-x" }, body: "{}" })).text();
      assert.equal(seen[0].url, "/v1/messages");
    } finally {
      await new Promise((r) => host.close(r));
    }
  });

  test("an unreachable upstream gets 502", async () => {
    const dead = await startModelGateway({ port: 0, upstream: "http://127.0.0.1:1", ownerToken: () => "owner", verify: () => true });
    try {
      const r = await fetch(`http://127.0.0.1:${port(dead)}/v1/messages`, { method: "POST", headers: { authorization: "Bearer sk-ant-oat01-x" }, body: "{}" });
      assert.equal(r.status, 502);
    } finally {
      await new Promise((r) => dead.close(r));
    }
  });

  test("cellModelEnv gives a cell the gateway and a stand-in, never the owner's token", () => {
    assert.deepEqual(cellModelEnv({ gatewayUrl: "http://gw:1", credential: "run-1" }), {
      ANTHROPIC_BASE_URL: "http://gw:1",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-run-1",
    });
  });
});
