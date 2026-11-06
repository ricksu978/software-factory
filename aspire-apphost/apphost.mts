// The software factory's local platform (plan Task 2). `aspire run` from the repo root starts it.
import { createBuilder } from './.aspire/modules/aspire.mjs';

const builder = await createBuilder();
const runMode = await builder.executionContext().isRunMode();
const repo = '..';

const postgres = await builder.addPostgres('pg').withDataVolume();
const db = await postgres.addDatabase('factory-db', { databaseName: 'factory' });
const dbUri = await db.uriExpression();

const storage = await builder.addAzureStorage('storage').runAsEmulator({
  configureContainer: async (azurite) => {
    await azurite.withDataVolume();
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

// Task 15 swaps in src/main.ts for control. migrate-cli still adds a probe_runs row locally, for PBI 2's restart scenario.
const migrate = await builder.addNodeApp('migrate', repo, 'src/store/migrate-cli.ts')
  .withEnvironment('FACTORY_DB_URI', dbUri)
  .waitFor(db);

// Both apps share the repo root, so only migrate installs packages. Two installers in one node_modules collide on Windows (EBUSY).
const control = await builder.addNodeApp('control', repo, 'spike/hello.ts')
  .withNpm({ install: false })
  .withHttpEndpoint({ port: 7400, env: 'PORT' })
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
  .withEnvironment('CELL_IMAGE', 'factory-cell:local')
  .withEnvironment('CELL_CONTROL_URL', 'http://host.docker.internal:7400')
  .withEnvironment('CELL_BLOB_HOST', 'host.docker.internal')
  .waitForCompletion(migrate, { exitCode: 0 });

// The dev identity exists only under `aspire run`, so nothing published from this AppHost carries it.
if (runMode) {
  for (const app of [migrate, control]) {
    await app.withEnvironment('FACTORY_ENV', 'local').withEnvironment('FACTORY_DEV_LOGIN', devLogin);
  }
}

await builder.build().run();
