import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { declaredParameters, runCli } from "./local-parameters.ts";

const names = (src: string) => declaredParameters(src).map((p) => p.name);
const HEAD = "const runMode = await builder.executionContext().isRunMode();\nconst secret = (name: string) => builder.addParameter(name, { secret: true });\n";

test("the factory's own AppHost: only the parameters it declares under aspire run, secrets first", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "..", "aspire-apphost", "apphost.mts"), "utf8");
  assert.deepEqual(names(src), [
    "claude-oauth-token", "github-project-token", "cell-secret", "github-webhook-secret",
    "bff-session-key", "github-app-key-path", "dev-login", "github-app-id", "claude-token-created-at",
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

test("a ?? in a ternary's run arm doesn't make the publish arm count", () => {
  const src = `${HEAD}const x = runMode ? process.env.X ?? 'd' : await secret('publish-only');\n`;
  assert.deepEqual(names(src), []);
});

test("every else if block after if (runMode), and the else that ends the chain, don't count", () => {
  const src = `${HEAD}
if (runMode) {
  await secret('run-a');
} else if (x) {
  await secret('pub-elseif');
} else if (f(y)) {
  await builder.addParameter('pub-elseif-2');
} else {
  await secret('pub-else');
}
await secret('every-d');
if (runMode) {
} else if (z) {
  await secret('pub-elseif-3');
}
`;
  assert.deepEqual(names(src), ["run-a", "every-d"]);
});

test("an else without braces after if (runMode) fails loudly", () => {
  assert.throws(() => declaredParameters(`${HEAD}if (runMode) {\n} else await secret('p');\n`), /without braces/);
  assert.throws(() => declaredParameters(`${HEAD}if (runMode) {\n} else if (x) await secret('p');\n`), /without braces/);
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

// The command line scripts/set-local-secrets.ps1 runs: --ask names what it asks for, --verdict whether the start stops.

function fakeCheckout(saved: Record<string, string> | null) {
  const root = mkdtempSync(join(tmpdir(), "local-parameters-"));
  mkdirSync(join(root, "aspire-apphost"));
  writeFileSync(
    join(root, "aspire-apphost", "apphost.mts"),
    `${HEAD}const a = await secret('a');\nconst b = await builder.addParameter('b');\nconst o = runMode ? '' : await secret('oidc-client-secret');\n`,
  );
  const secrets = join(root, "secrets.json");
  if (saved) writeFileSync(secrets, JSON.stringify(saved));
  const run = (...args: string[]) => {
    const out: string[] = [];
    return { code: runCli([root, ...args], (l) => out.push(l)), out };
  };
  return { run, secrets, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("cli: with no secrets file, --ask names every local parameter and --verdict stops the start", () => {
  const f = fakeCheckout(null);
  try {
    assert.deepEqual(f.run().out, ["secret a", "plain b"]);
    assert.deepEqual(f.run("--ask", f.secrets).out, ["secret a", "plain b"]);
    assert.deepEqual(f.run("--verdict", f.secrets), { code: 1, out: ["Still missing: a, b"] });
  } finally { f.done(); }
});

test("cli: --ask leaves out what's saved, and --verdict names only the local parameter still missing", () => {
  const f = fakeCheckout({ "Parameters:a": "x", Other: "y" });
  try {
    assert.deepEqual(f.run("--ask", f.secrets).out, ["plain b"]);
    assert.deepEqual(f.run("--verdict", f.secrets), { code: 1, out: ["Still missing: b"] });
  } finally { f.done(); }
});

test("cli: with every local parameter saved and no OIDC setting, --verdict lets the start go on", () => {
  const f = fakeCheckout({ "Parameters:a": "x", "Parameters:b": "y" });
  try {
    assert.deepEqual(f.run("--ask", f.secrets).out, []);
    assert.deepEqual(f.run("--verdict", f.secrets), { code: 0, out: ["All 2 parameters are set."] });
  } finally { f.done(); }
});

test("cli: an unknown mode or a missing secrets path is refused", () => {
  const f = fakeCheckout(null);
  try {
    assert.throws(() => f.run("--verdict"), /usage/);
    assert.throws(() => f.run("--nope", f.secrets), /usage/);
  } finally { f.done(); }
});
