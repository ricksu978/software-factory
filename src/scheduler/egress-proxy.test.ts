import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, request, type Server } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";

// Runs the real proxy script against an upstream on 127.0.0.1, which stands in for host.docker.internal. The live
// egress checks in docs/superpowers/spikes/2026-11-local-platform.md cover the network side.
const script = fileURLToPath(new URL("./egress-proxy.mjs", import.meta.url));

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createTcpServer().listen(0, () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

describe("egress proxy", () => {
  let upstream: Server;
  let upPort: number;
  let sasPort: number;
  let proxyPort: number;
  let proxy: ChildProcess;

  before(async () => {
    upstream = createServer((_req, res) => res.writeHead(201).end());
    upPort = await new Promise((resolve) => upstream.listen(0, "127.0.0.1", () => resolve((upstream.address() as { port: number }).port)));
    const sas = createServer((_req, res) => res.writeHead(201).end());
    sasPort = await new Promise((resolve) => sas.listen(0, "127.0.0.1", () => resolve((sas.address() as { port: number }).port)));
    upstream.on("close", () => sas.close());
    proxyPort = await freePort();
    proxy = spawn(process.execPath, [script], {
      env: { ...process.env, EGRESS_PORT: String(proxyPort), EGRESS_ALLOW: `http:127.0.0.1:${upPort},sas:127.0.0.1:${sasPort}` },
      stdio: "ignore",
    });
    // Wait until the proxy listens. A busy machine running the whole suite in parallel can take seconds to start a
    // node process, so allow 30 seconds and fail here, not in every test, if it never comes up.
    let listening = false;
    for (let i = 0; i < 300 && proxy.exitCode === null; i++) {
      const up = await new Promise<boolean>((resolve) => {
        const s = connect(proxyPort, "127.0.0.1");
        s.on("connect", () => {
          s.end();
          resolve(true);
        });
        s.on("error", () => resolve(false));
      });
      if (up) {
        listening = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(listening, `the egress proxy never listened on ${proxyPort} (exit code ${proxy.exitCode})`);
  });
  after(() => {
    proxy?.kill();
    upstream?.close();
  });

  const viaProxy = (url: string, method = "PUT", headers: Record<string, string> = {}) =>
    new Promise<number>((resolve, reject) => {
      request({ host: "127.0.0.1", port: proxyPort, method, path: url, headers }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).on("error", reject).end();
    });
  const tunnel = (target: string) =>
    new Promise<string>((resolve) => {
      const s = connect(proxyPort, "127.0.0.1", () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
      s.once("data", (b) => {
        resolve(b.toString().split("\r\n")[0]);
        s.destroy();
      });
    });

  test("plain HTTP to an http entry is forwarded", async () => {
    assert.equal(await viaProxy(`http://127.0.0.1:${upPort}/internal/cells/ping`, "POST"), 201);
  });

  test("a SAS-signed PUT to the blob port is forwarded", async () => {
    assert.equal(await viaProxy(`http://127.0.0.1:${sasPort}/devstoreaccount1/runs/x?sv=1&sig=abc`), 201);
  });

  test("a blob request without a SAS, or with its own Authorization, is refused", async () => {
    assert.equal(await viaProxy(`http://127.0.0.1:${sasPort}/devstoreaccount1/runs/x`), 403);
    assert.equal(await viaProxy(`http://127.0.0.1:${sasPort}/devstoreaccount1/runs/x?sig=abc`, "GET", { authorization: "SharedKey devstoreaccount1:forged" }), 403);
  });

  test("no tunnel opens to the control plane or the blob port", async () => {
    assert.match(await tunnel(`127.0.0.1:${upPort}`), /403/);
    assert.match(await tunnel(`127.0.0.1:${sasPort}`), /403/);
  });

  test("a host outside the list is refused", async () => {
    assert.equal(await viaProxy("http://example.com/", "GET"), 403);
    assert.match(await tunnel("example.com:443"), /403/);
  });
});
