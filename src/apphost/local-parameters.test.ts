import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { declaredParameters } from "./local-parameters.ts";

const names = (src: string) => declaredParameters(src).map((p) => p.name);
const HEAD = "const runMode = await builder.executionContext().isRunMode();\nconst secret = (name: string) => builder.addParameter(name, { secret: true });\n";

test("the factory's own AppHost: only the parameters it declares under aspire run, secrets first", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "..", "aspire-apphost", "apphost.mts"), "utf8");
  assert.deepEqual(names(src), [
    "claude-oauth-token", "github-app-key", "github-project-token", "cell-secret", "github-webhook-secret",
    "bff-session-key", "dev-login", "github-app-id", "claude-token-created-at",
  ]);
});

test("a parameter declared for every run counts, with its kind", () => {
  assert.deepEqual(declaredParameters(`${HEAD}const a = await secret('a');\nconst b = await builder.addParameter('b');\n`), [
    { name: "a", kind: "secret" },
    { name: "b", kind: "plain" },
  ]);
});

test("the publish arm of a runMode ternary doesn't count, the run arm does", () => {
  const src = `${HEAD}
const issuer = runMode ? 'http://localhost:7430/realms/factory' : await builder.addParameter('oidc-issuer');
const cs = runMode ? '' : await secret('oidc-client-secret');
const local = runMode ? await secret('local-only') : '';
`;
  assert.deepEqual(names(src), ["local-only"]);
});

test("a negated runMode ternary swaps the arms", () => {
  const src = `${HEAD}const p = !runMode ? await secret('publish-key') : await builder.addParameter('run-key');\n`;
  assert.deepEqual(names(src), ["run-key"]);
});

test("a ternary nested in the run arm, and a colon inside a string or call, don't end the run arm", () => {
  const src = `${HEAD}const p = runMode ? (x ? 'a:b' : f({ k: await secret('run-key') })) : await secret('publish-key');\n`;
  assert.deepEqual(names(src), ["run-key"]);
});

test("if (runMode) blocks: the else branch, and an if (!runMode) block, don't count", () => {
  const src = `${HEAD}
if (runMode) {
  const a = await secret('run-a');
} else {
  const b = await secret('publish-b');
}
if (!runMode) {
  const c = await builder.addParameter('publish-c');
}
const d = await secret('every-d');
`;
  assert.deepEqual(names(src), ["run-a", "every-d"]);
});

test("a declaration in a comment doesn't count", () => {
  const src = `${HEAD}// await secret('commented')\n/* builder.addParameter('blocked') */\nconst a = await secret('a');\n`;
  assert.deepEqual(names(src), ["a"]);
});

test("adding a publish-only parameter leaves the list as it was", () => {
  const base = `${HEAD}const a = await secret('a');\nconst b = await builder.addParameter('b');\n`;
  const added = `${base}const c = runMode ? '' : await secret('publish-api-key');\nconst d = runMode ? '' : await builder.addParameter('publish-region');\n`;
  assert.deepEqual(declaredParameters(added), declaredParameters(base));
});
