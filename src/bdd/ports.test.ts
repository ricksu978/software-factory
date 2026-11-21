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
