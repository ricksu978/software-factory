import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadAppKey } from "./app-key.ts";

const pem = "-----BEGIN RSA PRIVATE KEY-----\nline\n-----END RSA PRIVATE KEY-----\n";
const file = join(mkdtempSync(join(tmpdir(), "app-key-")), "app.pem");
writeFileSync(file, pem);

test("GITHUB_APP_KEY_FILE fills GITHUB_APP_KEY with the file's key, line breaks kept", () => {
  const env: NodeJS.ProcessEnv = { GITHUB_APP_KEY_FILE: file };
  loadAppKey(env);
  assert.equal(env.GITHUB_APP_KEY, pem);
});

test("a path quoted by Explorer's Copy as path still reads", () => {
  const env: NodeJS.ProcessEnv = { GITHUB_APP_KEY_FILE: ` "${file}" ` };
  loadAppKey(env);
  assert.equal(env.GITHUB_APP_KEY, pem);
});

test("a GITHUB_APP_KEY already set wins, so Azure's Key Vault key is never replaced", () => {
  const env: NodeJS.ProcessEnv = { GITHUB_APP_KEY: "vault", GITHUB_APP_KEY_FILE: file };
  loadAppKey(env);
  assert.equal(env.GITHUB_APP_KEY, "vault");
});

test("a missing file names the path", () => {
  assert.throws(() => loadAppKey({ GITHUB_APP_KEY_FILE: join(tmpdir(), "nope.pem") }), /GITHUB_APP_KEY_FILE .*nope\.pem/);
});
