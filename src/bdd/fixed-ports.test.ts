import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { blankComments, findFixedPorts, fixedPortsIn, portUsers } from "./fixed-ports.ts";

const where = (src: string) => fixedPortsIn("f.ts", src).map((f) => `${f.line} ${f.use} ${f.port}`);

test("a request to a port in its options is a connect", () => {
  assert.deepEqual(where('import http from "node:http";\nhttp.get({ host: "127.0.0.1", port: 7402, path: "/" });\n'), ["2 connect 7402"]);
});

test("a URL to this machine with a port is a connect", () => {
  assert.deepEqual(where('await fetch("http://127.0.0.1:7400/x");\nconst k = "http://localhost:7430";\nfetch(`http://[::1]:8080/`);\n'), [
    "1 connect 7400",
    "2 connect 7430",
    "3 connect 8080",
  ]);
});

test("a URL to a name that reaches nothing, or a port below 1024, isn't", () => {
  assert.deepEqual(where('const a = "http://control.test:7400";\nconst b = "http://127.0.0.1:9/none";\nconst c = "postgres://nobody@127.0.0.1:1/none";\n'), []);
});

test("an Error's message that names an address isn't a connect", () => {
  assert.deepEqual(where('const e = new Error("connect ECONNREFUSED 127.0.0.1:7401");\n'), []);
});

test("listening on a fixed port is a listen", () => {
  assert.deepEqual(where("server.listen(7402);\nserver.listen({ port: 7403 });\nserver.listen(0, \"127.0.0.1\");\n"), ["1 listen 7402", "2 listen 7403"]);
});

test("a port setting handed to a server's start is a listen", () => {
  assert.deepEqual(where('await startModelGateway({ port: 7499, host: "0.0.0.0" });\nconst env = { PORT: "7400" };\n'), ["1 listen 7499", "2 connect 7400"]);
});

test("a constant port is judged by its uses, at its own line", () => {
  const src = [
    "export const PORT = 7402;",
    "const api = await startApi({",
    "  pool,",
    "}, PORT);",
    "const r = await fetch(`http://127.0.0.1:${PORT}/v1`);",
  ].join("\n");
  assert.deepEqual(where(src), ["1 connect 7402", "1 listen 7402"]);
  assert.deepEqual(where("const PORT = 7402;\nfetch(`http://127.0.0.1:${PORT}/`);\n"), ["1 connect 7402"]);
});

test("a port handed to a call that connects or listens, itself or through another function, is one", () => {
  const src = [
    "async function answers(port: number) {",
    "  const s = connect({ host: \"127.0.0.1\", port });",
    "}",
    "async function settle(b: Bff, port: number, ms = 30_000) {",
    "  while (!(await answers(port))) await sleep(100);",
    "}",
    "const serveOn = async (port: number) => {",
    "  http.createServer(handler).listen(port);",
    "};",
    "await settle(b, 7403);",
    "await answers(",
    "  7404,",
    ");",
    "await serveOn(7405);",
    "connect(7406);",
  ].join("\n");
  assert.deepEqual(where(src), ["10 connect 7403", "12 connect 7404", "14 listen 7405", "15 connect 7406"]);
});

test("a port handed to a call that neither connects nor listens isn't one, nor is one inside a larger argument", () => {
  const src = [
    "function env(world: object, port: number) {",
    "  return { URL: `http://localhost:${scenarioPorts(world).real(port)}` };",
    "}",
    "env(this, 7401);",
    "c.items.get(9000);",
    "await sleep(2000);",
    "async function answers(port: number) { return connect({ port }); }",
    "await answers(7400 + i);",
    'Given("answers(7402)", () => {});',
  ].join("\n");
  assert.deepEqual(where(src), []);
});

test("a function in one step file that connects counts where another file calls it", () => {
  const users = portUsers(["export async function answers(port: number) {\n  return fetch(`http://127.0.0.1:${port}/`);\n}\n"]);
  assert.deepEqual(fixedPortsIn("g.ts", "await answers(7403);\n", users), [{ file: "g.ts", line: 1, port: 7403, use: "connect" }]);
});

test("a port in a step's text or a comment isn't one", () => {
  assert.deepEqual(where('Given("the API on port 7402", () => {});\n// http.get({ port: 7402 })\n/* fetch("http://localhost:7400")\n */\n'), []);
});

test("blanking comments keeps strings and line numbers", () => {
  const src = 'const a = "// not a comment"; // gone\n/* two\nlines */ const b = 1;\n';
  const out = blankComments(src);
  assert.equal(out.split("\n").length, src.split("\n").length);
  assert.match(out, /"\/\/ not a comment"/);
  assert.doesNotMatch(out, /gone|two|lines/);
  assert.match(out, /const b = 1;/);
});

test("the check reads every step file under features/steps and names each by its path from the root", () => {
  const root = mkdtempSync(join(tmpdir(), "fixed-ports-"));
  try {
    mkdirSync(join(root, "features", "steps", "nested"), { recursive: true });
    writeFileSync(join(root, "features", "steps", "a.steps.ts"), "const ok = 1;\n");
    writeFileSync(join(root, "features", "steps", "nested", "b.ts"), "\nhttp.get({ host: \"127.0.0.1\", port: 7402 });\n");
    writeFileSync(join(root, "features", "steps", "notes.md"), "port: 7402\n");
    assert.deepEqual(findFixedPorts(root), [{ file: "features/steps/nested/b.ts", line: 2, port: 7402, use: "connect" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a root without step definitions has no fixed ports", () => {
  assert.deepEqual(findFixedPorts(join(tmpdir(), "no-such-root-pbi-390")), []);
});
