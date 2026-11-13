// The software factory's local platform (plan Task 2). `aspire run` from the repo root starts it.
import { createHash } from 'node:crypto';
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
// its own, named per checkout like Aspire's default so worktrees still don't share one.
const pgVolume = `pg17-${createHash('sha256').update(import.meta.dirname).digest('hex').slice(0, 10)}-data`;
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

const secret = (name: string) => builder.addParameter(name, { secret: true });
const claudeToken = await secret('claude-oauth-token');
const appKey = await secret('github-app-key');
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
// The control plane (plan Task 15). Its console shows this start's dashboard sign-in link.
const control = await builder.addNodeApp('control', repo, 'src/main.ts')
  .withNpm({ install: false })
  .withHttpEndpoint(floatPorts ? { env: 'PORT' } : { port: 7400, env: 'PORT' })
  .withEnvironment('FACTORY_DB_URI', dbUri)
  .withEnvironment('FACTORY_BLOB', blobs)
  .withEnvironment('CLAUDE_CODE_OAUTH_TOKEN', claudeToken)
  .withEnvironment('GITHUB_APP_KEY', appKey)
  .withEnvironment('GITHUB_PROJECT_TOKEN', projectToken)
  .withEnvironment('CELL_SECRET', cellSecret)
  .withEnvironment('GITHUB_WEBHOOK_SECRET', webhookSecret)
  .withEnvironment('GITHUB_APP_ID', appId)
  .withEnvironment('CLAUDE_TOKEN_CREATED_AT', tokenCreatedAt)
  .withEnvironment('FACTORY_POLICY_DIR', './policy')
  .withEnvironment('CELL_BLOB_HOST', 'host.docker.internal')
  .waitForCompletion(migrate, { exitCode: 0 });
// From control's own endpoint, so it follows the port whether pinned or picked by Aspire.
const controlPort = await control.getEndpoint('http').property(EndpointProperty.Port);
const cellControlUrl = refExpr`http://host.docker.internal:${controlPort}`;
await control.withEnvironment('CELL_CONTROL_URL', cellControlUrl);

// The worker (redesign step 2): the egress proxy, the scheduler's tick, and the board poller with its judge. It has no
// endpoint. It hands cells control's address and lets that port through the egress proxy.
const worker = await builder.addNodeApp('worker', repo, 'src/worker/main.ts')
  .withNpm({ install: false })
  .withEnvironment('FACTORY_DB_URI', dbUri)
  .withEnvironment('FACTORY_BLOB', blobs)
  .withEnvironment('CLAUDE_CODE_OAUTH_TOKEN', claudeToken)
  .withEnvironment('GITHUB_APP_KEY', appKey)
  .withEnvironment('GITHUB_PROJECT_TOKEN', projectToken)
  .withEnvironment('CELL_SECRET', cellSecret)
  .withEnvironment('GITHUB_APP_ID', appId)
  .withEnvironment('FACTORY_POLICY_DIR', './policy')
  .withEnvironment('CELL_IMAGE', 'factory-cell:local')
  .withEnvironment('CELL_CONTROL_URL', cellControlUrl)
  .waitForCompletion(migrate, { exitCode: 0 });

// The dev identity exists only under `aspire run`, so nothing published from this AppHost carries it.
if (runMode) {
  for (const app of [migrate, control]) {
    await app.withEnvironment('FACTORY_ENV', 'local').withEnvironment('FACTORY_DEV_LOGIN', devLogin);
  }
  // The worker signs no one in, so it needs local mode but no dev login.
  await worker.withEnvironment('FACTORY_ENV', 'local');
}

await builder.build().run();
