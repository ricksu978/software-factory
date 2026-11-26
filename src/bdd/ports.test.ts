import assert from "node:assert/strict";
import { createServer } from "node:net";
import { test } from "node:test";
import { freePort, ScenarioPorts, scenarioPorts } from "./ports.ts";

test("a free port can be listened on", async () => {
  const port = await freePort();
  assert.ok(port > 0);
  const s = createServer();
  await new Promise<void>((resolve, reject) => {
    s.once("error", reject);
    s.listen(port, "127.0.0.1", () => resolve());
  });
  await new Promise((resolve) => s.close(resolve));
});

test("a free port lies below the range the OS takes outgoing connections' ports from, so no connection holds it", async () => {
  for (let i = 0; i < 20; i++) {
    const port = await freePort();
    assert.ok(port >= 20_000 && port < 32_768, `port ${port} is in the OS's ephemeral range`);
  }
});

test("a free port can be listened on on every address, as a server listening on :: does", async () => {
  const port = await freePort();
  const s = createServer();
  await new Promise<void>((resolve, reject) => {
    s.once("error", reject);
    s.listen(port, () => resolve());
  });
  await new Promise((resolve) => s.close(resolve));
});

test("a port something already listens on is never handed out", async () => {
  const held = createServer();
  await new Promise<void>((resolve) => held.listen(0, () => resolve()));
  const taken = (held.address() as { port: number }).port;
  let tries = 0;
  const port = await freePort(() => (tries++ === 0 ? taken : 21_000 + tries));
  assert.notEqual(port, taken);
  await new Promise((resolve) => held.close(resolve));
});

test("each named port stands for one free port for the whole scenario", async () => {
  let next = 50_000;
  const ports = new ScenarioPorts(async () => next++);
  assert.equal(await ports.real(7401), 50_000);
  assert.equal(await ports.real(7400), 50_001);
  assert.equal(await ports.real(7401), 50_000);
});

test("a URL on this machine gets the port its named port stands for, and any other URL stays", async () => {
  const ports = new ScenarioPorts(async () => 50_123);
  assert.equal(await ports.url("http://localhost:7400"), "http://localhost:50123");
  assert.equal(await ports.url("http://127.0.0.1:7400/x"), "http://127.0.0.1:50123/x");
  assert.equal(await ports.url("http://control.test:7400"), "http://control.test:7400");
  assert.equal(await ports.url("http://localhost/"), "http://localhost/");
});

test("each world has ports of its own", () => {
  const a = {};
  const b = {};
  assert.equal(scenarioPorts(a), scenarioPorts(a));
  assert.notEqual(scenarioPorts(a), scenarioPorts(b));
});
