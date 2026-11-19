// The software factory's local platform (plan Task 2). `aspire run` from the repo root starts it.
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createBuilder, EndpointProperty, refExpr } from './.aspire/modules/aspire.mjs';

const builder = await createBuilder();
const runMode = await builder.executionContext().isRunMode();
const repo = '..';
// The factory pins control to 7400 and Azurite's blobs to 7410, so the egress proxy's allowlisted ports and its label
// survive restarts (Task 13). Pinned ports are machine-wide, though, and `aspire start --isolated` doesn't move them,
// so a test run sets FACTORY_FLOAT_PORTS=1 to let Aspire pick both, and AppHosts in different worktrees then never
// clash. Two from the same worktree still share its named data volumes.
const floatPorts = process.env.FACTORY_FLOAT_PORTS === '1';

// Postgres 17, not Aspire's default 18. On this ARM64 Docker host, 18's async-I/O read path wedges: a backend spins
// forever in WaitReadBuffers -> AsyncReadBuffers -> pgaio_io_acquire_nb, ignores cancel, and every later page read in
// any session joins it. 17 has no AIO read path, and the test suites already run on it (src/store/test-db.ts).
// The tag goes before withDataVolume(), which picks 17's data path from it. 17 can't open the 18 volume, so it gets
// its own, named per checkout like Aspire's default so worktrees still don't share one. The path is lowercased first:
// Windows paths ignore case, but import.meta.dirname keeps whatever casing the AppHost was launched with.
const pgVolume = `pg17-${createHash('sha256').update(import.meta.dirname.toLowerCase()).digest('hex').slice(0, 10)}-data`;
const postgres = await builder.addPostgres('pg').withImageTag('17').withDataVolume({ name: pgVolume });
const db = await postgres.addDatabase('factory-db', { databaseName: 'factory' });
const dbUri = await db.uriExpression();

const storage = await builder.addAzureStorage('storage').runAsEmulator({
  configureContainer: async (azurite) => {
    await azurite.withDataVolume();
    if (!floatPorts) await azurite.withBlobPort(7410);
  },
});
const blobs = await storage.addBlobs('blobs');

// Keycloak is the local sign-in provider (redesign step 5a). It is pinned to 7430 even under FACTORY_FLOAT_PORTS,
// because the issuer URL contains the port and users are keyed on the issuer. Under FACTORY_FLOAT_PORTS=1 migrate still
// asks the running Keycloak for its issuer rather than assume 7430 (step 5c). It has no data volume, so every start
// imports the realm afresh from keycloak/: the `dashboard` client, the audience mapper, the test owner and the e2e
// client. API_AUDIENCE is the `aud` the realm's audience mapper puts in access tokens. The two must agree.
// The realm is a dev identity (a committed test owner password, a direct-grant client, no TLS), so like the dev login
// it starts only under `aspire run`. Anything published uses whatever IdP is configured there (design §04).
const apiAudience = 'factory-api';
const keycloak = runMode ? await builder.addKeycloak('keycloak', { port: 7430 }).withRealmImport('./keycloak') : null;

// A parameter with no value makes the Aspire dashboard ask for it ("Unresolved parameters", then "Enter values"), and
// "Save to user secrets" keeps it in this checkout's user secrets, so the next start asks nothing (issue #207). Each
// resource that uses a parameter waits until it has a value.
const secret = (name: string) => builder.addParameter(name, { secret: true });
const claudeToken = await secret('claude-oauth-token');
// The App's key goes in as the path to its .pem. The form's inputs are one line, so a pasted key would lose its line
// breaks. The apps read the file (src/adapters/github/app-key.ts). A path isn't secret, so the form shows it.
const appKeyFile = await builder.addParameter('github-app-key-path')
  .withDescription("The path to the GitHub App's .pem file. A quoted path from Explorer's \"Copy as path\" works.");
const projectToken = await secret('github-project-token');
const cellSecret = await secret('cell-secret');
const webhookSecret = await secret('github-webhook-secret');
const devLogin = await builder.addParameter('dev-login');
const appId = await builder.addParameter('github-app-id');
const tokenCreatedAt = await builder.addParameter('claude-token-created-at');

// migrate-cli adds a probe_runs row locally, for PBI 2's restart scenario.
const migrate = await builder.addNodeApp('migrate', repo, 'src/store/migrate-cli.ts')
  .withEnvironment('FACTORY_DB_URI', dbUri)
  .waitFor(db);

// Every app shares the repo root, so only migrate installs packages. Two installers in one node_modules collide on Windows (EBUSY).
// The control plane (plan Task 15): the webhook and the dashboard. Its console shows this start's dashboard sign-in
// link, built from DASHBOARD_ORIGIN, the endpoint's proxied port.
const control = await builder.addNodeApp('control', repo, 'src/main.ts')
  .withNpm({ install: false })
  .withHttpEndpoint(floatPorts ? { env: 'PORT' } : { port: 7400, env: 'PORT' })
  .withEnvironment('FACTORY_DB_URI', dbUri)
  .withEnvironment('FACTORY_BLOB', blobs)
  .withEnvironment('CLAUDE_CODE_OAUTH_TOKEN', claudeToken)
  .withEnvironment('GITHUB_APP_KEY_FILE', appKeyFile)
  .withEnvironment('GITHUB_PROJECT_TOKEN', projectToken)
  .withEnvironment('CELL_SECRET', cellSecret)
  .withEnvironment('GITHUB_WEBHOOK_SECRET', webhookSecret)
  .withEnvironment('GITHUB_APP_ID', appId)
  .withEnvironment('CLAUDE_TOKEN_CREATED_AT', tokenCreatedAt)
  .withEnvironment('FACTORY_POLICY_DIR', './policy')
  .withEnvironment('CELL_BLOB_HOST', 'host.docker.internal')
  // Nothing reads it until the API takes it over in redesign step 6.
  .withEnvironment('API_AUDIENCE', apiAudience)
  .waitForCompletion(migrate, { exitCode: 0 });

// The cell API (redesign step 4a, src/cell-api/main.ts): the cell routes and the model gateway, which control no longer
// serves. It is pinned to 7401 beside control's 7400, and floats with it under FACTORY_FLOAT_PORTS.
const cellApi = await builder.addNodeApp('cell-api', repo, 'src/cell-api/main.ts')
  .withNpm({ install: false })
  .withHttpEndpoint(floatPorts ? { env: 'PORT' } : { port: 7401, env: 'PORT' })
  .withEnvironment('FACTORY_DB_URI', dbUri)
  .withEnvironment('FACTORY_BLOB', blobs)
  .withEnvironment('CLAUDE_CODE_OAUTH_TOKEN', claudeToken)
  .withEnvironment('GITHUB_APP_KEY_FILE', appKeyFile)
  .withEnvironment('GITHUB_PROJECT_TOKEN', projectToken)
  .withEnvironment('CELL_SECRET', cellSecret)
  .withEnvironment('GITHUB_APP_ID', appId)
  .withEnvironment('CELL_BLOB_HOST', 'host.docker.internal')
  .waitForCompletion(migrate, { exitCode: 0 });
// Cells reach the cell API, not control. Built from the cell API's own endpoint, so it follows the port whether pinned
// or picked by Aspire. The worker hands it to each cell and lets its port through the egress proxy.
const cellApiPort = await cellApi.getEndpoint('http').property(EndpointProperty.Port);
const cellControlUrl = refExpr`http://host.docker.internal:${cellApiPort}`;
// Control listens on PORT, so it only shows this on its Configuration page.
await control.withEnvironment('CELL_CONTROL_URL', cellControlUrl);
// The browser reaches control through Aspire's proxy, on the endpoint's port, while PORT is the port behind the proxy.
// Control checks every dashboard POST's Origin against this, so it must be the address the browser uses.
const controlPort = await control.getEndpoint('http').property(EndpointProperty.Port);
await control.withEnvironment('DASHBOARD_ORIGIN', refExpr`http://localhost:${controlPort}`);

// The worker (redesign step 2): the egress proxy, the scheduler's tick, and the board poller with its judge. It has no
// endpoint. It hands cells the cell API's address and lets that port through the egress proxy.
const worker = await builder.addNodeApp('worker', repo, 'src/worker/main.ts')
  .withNpm({ install: false })
  .withEnvironment('FACTORY_DB_URI', dbUri)
  .withEnvironment('FACTORY_BLOB', blobs)
  .withEnvironment('CLAUDE_CODE_OAUTH_TOKEN', claudeToken)
  .withEnvironment('GITHUB_APP_KEY_FILE', appKeyFile)
  .withEnvironment('GITHUB_PROJECT_TOKEN', projectToken)
  .withEnvironment('CELL_SECRET', cellSecret)
  .withEnvironment('GITHUB_APP_ID', appId)
  .withEnvironment('FACTORY_POLICY_DIR', './policy')
  .withEnvironment('CELL_IMAGE', 'factory-cell:local')
  .withEnvironment('CELL_CONTROL_URL', cellControlUrl)
  .waitForCompletion(migrate, { exitCode: 0 });

// The BFF (redesign step 7a, src/bff/main.ts): signs people in and keeps sessions in Postgres as factory_bff. It runs
// on 7403 beside today's dashboard on 7400 until the cut-over moves it, and floats with the others under
// FACTORY_FLOAT_PORTS. Under `aspire run` it signs in at the local Keycloak realm on 7430 through the realm's public
// `dashboard` client, so it has no client secret there. Published, the issuer and the secret are parameters (§04).
// The session key encrypts refresh tokens at rest: 32 random bytes in base64, such as `openssl rand -base64 32`.
const bffSessionKey = await secret('bff-session-key');
const bffIssuer = runMode ? 'http://localhost:7430/realms/factory' : await builder.addParameter('oidc-issuer');
const bffClientSecret = runMode ? '' : await secret('oidc-client-secret');
const bff = await builder.addNodeApp('bff', repo, 'src/bff/main.ts')
  .withNpm({ install: false })
  .withHttpEndpoint(floatPorts ? { env: 'PORT' } : { port: 7403, env: 'PORT' })
  .withEnvironment('FACTORY_DB_URI', dbUri)
  .withEnvironment('OIDC_ISSUER', bffIssuer)
  .withEnvironment('OIDC_CLIENT_ID', 'dashboard')
  .withEnvironment('OIDC_CLIENT_SECRET', bffClientSecret)
  .withEnvironment('OIDC_SCOPES', 'openid')
  .withEnvironment('BFF_SESSION_KEY', bffSessionKey)
  .waitForCompletion(migrate, { exitCode: 0 });
// The address the browser reaches the BFF on, built from its own endpoint so it follows the port.
const bffPort = await bff.getEndpoint('http').property(EndpointProperty.Port);
await bff.withEnvironment('BFF_ORIGIN', refExpr`http://localhost:${bffPort}`);
if (keycloak) await bff.waitFor(keycloak);

// The dev identity exists only under `aspire run`, so nothing published from this AppHost carries it.
if (runMode) {
  for (const app of [migrate, control]) {
    await app.withEnvironment('FACTORY_ENV', 'local').withEnvironment('FACTORY_DEV_LOGIN', devLogin);
  }
  // Migrate seeds the realm's test owner, keyed on the realm's issuer. Under floating ports it reads that issuer from
  // the running Keycloak, which withReference() points it at through services__keycloak__http__0. With pinned ports
  // migrate never asks Keycloak, so it doesn't wait for it, and control and the worker don't wait on it through migrate.
  if (keycloak) {
    await migrate.withEnvironment('FACTORY_FLOAT_PORTS', floatPorts ? '1' : '0');
    if (floatPorts) await migrate.withReference(keycloak).waitFor(keycloak);
  }
  // The worker signs no one in, so it needs local mode but no dev login.
  await worker.withEnvironment('FACTORY_ENV', 'local');
}

// Before any resource starts, the AppHost pulls main fast-forward-only and brings Docker up (PBI 205,
// src/apphost/start.ts), however it was launched, so control, the worker and migrate run the pulled code. A check that
// fails shows why and exits before anything starts. A pull that changes this file takes effect on the next start.
// `aspire publish` starts nothing, so it skips them. The path is a variable so this project's tsc, rooted here, doesn't
// compile the repo's src; the AppHost's runtime loads the .ts file itself.
// run() returns Aspire's PromiseLike, and runAppHostStart wants a Promise, so await it inside an async function.
const build = async () => { await builder.build().run(); };
if (runMode) {
  const startModule = '../src/apphost/node-start.ts';
  const { runAppHostStart } = (await import(startModule)) as {
    runAppHostStart(repo: string, startResources: () => Promise<void>): Promise<void>;
  };
  await runAppHostStart(fileURLToPath(new URL('..', import.meta.url)), build);
} else {
  await build();
}
