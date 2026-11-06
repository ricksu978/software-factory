using 'main.bicep'

// The App from Task 2 Step 5 (docs/superpowers/spikes/2026-11-local-platform.md).
param githubAppId = '5636555'
// The date of `claude setup-token`, the same value as the AppHost's claude-token-created-at.
param claudeTokenCreatedAt = '<yyyy-mm-dd>'

// Set both after the bootstrap deploy, once the app's URL exists for the redirect URIs (Task 19 Step 2b).
param microsoftClientId = ''
param googleClientId = ''

// Read from the deployer's environment. Only the owner's own deploy sets them, and an empty one leaves its
// Key Vault secret as it is, so deploy.yml never touches a secret value.
param githubAppKey = readEnvironmentVariable('GITHUB_APP_KEY', '')
param githubProjectToken = readEnvironmentVariable('GITHUB_PROJECT_TOKEN', '')
param claudeOauthToken = readEnvironmentVariable('CLAUDE_CODE_OAUTH_TOKEN', '')
param githubWebhookSecret = readEnvironmentVariable('GITHUB_WEBHOOK_SECRET', '')
param cellSecret = readEnvironmentVariable('CELL_SECRET', '')
param authMicrosoftSecret = readEnvironmentVariable('AUTH_MICROSOFT_SECRET', '')
param authGoogleSecret = readEnvironmentVariable('AUTH_GOOGLE_SECRET', '')
