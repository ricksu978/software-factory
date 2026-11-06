// Phase 0b platform (plan Task 19 Step 1), deployed into rg-software-factory-aue. The first deploy is the owner's
// own (Step 2b). Every later one runs through .github/workflows/deploy.yml as id-factory-deploy.
targetScope = 'resourceGroup'

param location string = resourceGroup().location

@description('The public placeholder lets the bootstrap deploy run while ACR is still empty.')
param controlImage string = 'mcr.microsoft.com/k8se/quickstart:latest'
param cellImage string = 'mcr.microsoft.com/k8se/quickstart:latest'
param migrateImage string = 'mcr.microsoft.com/k8se/quickstart:latest'

param githubAppId string
@description('When the Claude OAuth token was made, for the dashboard\'s expiry banner.')
param claudeTokenCreatedAt string

@description('Built-in auth turns on once both client ids are set, which needs the app\'s URL for their redirect URIs.')
param microsoftClientId string = ''
param googleClientId string = ''

// A secret param that is empty leaves its Key Vault secret as it is. Only the owner's own deploy passes them, from
// environment variables through main.bicepparam, so deploy.yml never handles a secret value.
@secure()
param githubAppKey string = ''
@secure()
param githubProjectToken string = ''
@secure()
param claudeOauthToken string = ''
@secure()
param githubWebhookSecret string = ''
@secure()
param cellSecret string = ''
@secure()
param authMicrosoftSecret string = ''
@secure()
param authGoogleSecret string = ''

var placeholderImage = 'mcr.microsoft.com/k8se/quickstart:latest'
var u = uniqueString(resourceGroup().id)
var authOn = !empty(microsoftClientId) && !empty(googleClientId)
var pgDatabase = 'factory'

var roles = {
  acrPull: '7f951dda-4ed3-4680-a7ca-43fe172d538d'
  owner: '8e3af657-a8ff-443c-a75c-2fe8c4bcb635'
  kvSecretsUser: '4633458b-17de-408a-b874-0445c86b69e6'
  blobContributor: 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
  blobDelegator: 'db58b8e5-c6ad-4a2a-8342-4190687cbf4a'
}

resource log 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-factory'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

// No workloadProfiles, so the environment is Consumption only.
resource cae 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-factory'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: log.properties.customerId
        sharedKey: log.listKeys().primarySharedKey
      }
    }
  }
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: 'acrfactory${u}'
  location: location
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false }
}

resource idControl 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-factory-control'
  location: location
}

resource idCell 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-factory-cell'
  location: location
}

resource idMigrate 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-factory-migrate'
  location: location
}

resource idDeploy 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-factory-deploy'
  location: location
}

// deploy.yml signs in as id-factory-deploy, and only from a job in the production environment.
resource deployFederation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: idDeploy
  name: 'github-production'
  properties: {
    issuer: 'https://token.actions.githubusercontent.com'
    subject: 'repo:ricksu978/software-factory:environment:production'
    audiences: ['api://AzureADTokenExchange']
  }
}

// Owner on this resource group and nothing wider, because the deploy writes the role assignments below.
resource deployOwner 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, idDeploy.id, roles.owner)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.owner)
    principalId: idDeploy.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for name in [idControl.name, idCell.name, idMigrate.name]: {
    scope: acr
    name: guid(acr.id, name, roles.acrPull)
    properties: {
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.acrPull)
      principalId: reference(resourceId('Microsoft.ManagedIdentity/userAssignedIdentities', name), '2023-01-31').principalId
      principalType: 'ServicePrincipal'
    }
  }
]

// No account key: the control plane signs write-only SAS URLs with a user delegation key.
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'stfactory${u}'
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    accessTier: 'Hot'
    allowSharedKeyAccess: false
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
  }
}

resource blobs 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource containers 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = [
  for name in ['transcripts', 'reports']: {
    parent: blobs
    name: name
  }
]

resource storageRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for role in [roles.blobContributor, roles.blobDelegator]: {
    scope: storage
    name: guid(storage.id, idControl.id, role)
    properties: {
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', role)
      principalId: idControl.properties.principalId
      principalType: 'ServicePrincipal'
    }
  }
]

resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: 'kv-factory-${u}'
  location: location
  properties: {
    tenantId: tenant().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
  }
}

var secretValues = {
  'github-app-key': githubAppKey
  'github-project-token': githubProjectToken
  'claude-oauth-token': claudeOauthToken
  'github-webhook-secret': githubWebhookSecret
  'cell-secret': cellSecret
  'auth-microsoft-secret': authMicrosoftSecret
  'auth-google-secret': authGoogleSecret
}

resource secrets 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = [
  for s in items(secretValues): if (!empty(s.value)) {
    parent: kv
    name: s.key
    properties: { value: s.value }
  }
]

// Only the control identity reads the vault. The cell and migrate identities get nothing here.
resource kvControl 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: kv
  name: guid(kv.id, idControl.id, roles.kvSecretsUser)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.kvSecretsUser)
    principalId: idControl.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// Entra auth only. No Postgres principal is ever made for id-factory-cell, so a cell can't sign in (PBI 22).
resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: 'psql-factory-${u}'
  location: location
  sku: { name: 'Standard_B1ms', tier: 'Burstable' }
  properties: {
    version: '17'
    storage: { storageSizeGB: 32 }
    authConfig: {
      activeDirectoryAuth: 'Enabled'
      passwordAuth: 'Disabled'
      tenantId: tenant().tenantId
    }
  }
}

// 0.0.0.0 to 0.0.0.0 admits Azure services only, so no GitHub runner or laptop connects directly.
resource pgAzureOnly 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: pg
  name: 'AllowAllAzureServicesAndResourcesWithinAzureIps'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

resource pgDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: pg
  name: pgDatabase
}

// The migrate job's identity is the Entra admin. It creates the control identity's principal (migrate-cli.ts).
// A module, because the admin's resource name is the identity's object id, known only once the identity exists.
module pgAdmin 'pg-admin.bicep' = {
  name: 'pg-admin'
  params: {
    server: pg.name
    objectId: idMigrate.properties.principalId
    principalName: idMigrate.name
  }
  dependsOn: [pgAzureOnly, pgDb]
}

var kvSecret = '${kv.properties.vaultUri}secrets/'
var controlSecrets = [
  { name: 'claude-oauth-token', env: 'CLAUDE_CODE_OAUTH_TOKEN' }
  { name: 'github-app-key', env: 'GITHUB_APP_KEY' }
  { name: 'github-project-token', env: 'GITHUB_PROJECT_TOKEN' }
  { name: 'github-webhook-secret', env: 'GITHUB_WEBHOOK_SECRET' }
  { name: 'cell-secret', env: 'CELL_SECRET' }
]
// The setting names built-in auth reads the client secrets from.
var authSecrets = authOn
  ? [
      { name: 'microsoft-provider-authentication-secret', keyVaultUrl: '${kvSecret}auth-microsoft-secret', identity: idControl.id }
      { name: 'google-provider-authentication-secret', keyVaultUrl: '${kvSecret}auth-google-secret', identity: idControl.id }
    ]
  : []

// The placeholder image listens on 80. The spike and the control plane listen on 7400.
var controlPort = controlImage == placeholderImage ? 80 : 7400

// The Bicep sets neither FACTORY_ENV nor FACTORY_DEV_LOGIN, so the dev identity can't work in Azure.
resource control 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'ca-factory-control'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${idControl.id}': {} }
  }
  properties: {
    managedEnvironmentId: cae.id
    configuration: {
      ingress: { external: true, targetPort: controlPort }
      registries: [{ server: acr.properties.loginServer, identity: idControl.id }]
      secrets: concat(map(controlSecrets, s => { name: s.name, keyVaultUrl: '${kvSecret}${s.name}', identity: idControl.id }), authSecrets)
    }
    template: {
      scale: { minReplicas: 1, maxReplicas: 1 }
      containers: [
        {
          name: 'control'
          image: controlImage
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: concat(map(controlSecrets, s => { name: s.env, secretRef: s.name }), [
            { name: 'CLAUDE_TOKEN_CREATED_AT', value: claudeTokenCreatedAt }
            { name: 'GITHUB_APP_ID', value: githubAppId }
            { name: 'PGHOST', value: pg.properties.fullyQualifiedDomainName }
            { name: 'PGDATABASE', value: pgDatabase }
            { name: 'PGUSER', value: idControl.name }
            { name: 'AZURE_CLIENT_ID', value: idControl.properties.clientId }
          ])
        }
      ]
    }
  }
  dependsOn: [kvControl, acrPull, secrets]
}

// A cell has no login session, so the cell API and the model gateway sit outside sign-in, like the webhook.
resource auth 'Microsoft.App/containerApps/authConfigs@2024-03-01' = if (authOn) {
  parent: control
  name: 'current'
  properties: {
    platform: { enabled: true }
    globalValidation: {
      unauthenticatedClientAction: 'RedirectToLoginPage'
      // Built-in auth redirects to one provider. A Google user signs in at /.auth/login/google (Step 5 checks).
      redirectToProvider: 'azureactivedirectory'
      excludedPaths: ['/webhooks/github', '/internal/cells', '/internal/model']
    }
    identityProviders: {
      // Any Entra directory and personal accounts. The docs give only a per-tenant issuer, so Step 5 tests common.
      azureActiveDirectory: {
        enabled: true
        registration: {
          clientId: microsoftClientId
          clientSecretSettingName: 'microsoft-provider-authentication-secret'
          openIdIssuer: '${environment().authentication.loginEndpoint}common/v2.0'
        }
      }
      google: {
        enabled: true
        registration: {
          clientId: googleClientId
          clientSecretSettingName: 'google-provider-authentication-secret'
        }
      }
    }
  }
}

// The launcher gives each execution its stand-in token and the gateway URL (Run contract 5), so the job holds no
// Key Vault reference, and id-factory-cell is its only identity.
resource cellJob 'Microsoft.App/jobs@2024-03-01' = {
  name: 'caj-factory-cell'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${idCell.id}': {} }
  }
  properties: {
    environmentId: cae.id
    configuration: {
      triggerType: 'Manual'
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      replicaRetryLimit: 1
      // ponytail: a 4-hour cap per run, raise it if a real stage runs longer.
      replicaTimeout: 14400
      registries: [{ server: acr.properties.loginServer, identity: idCell.id }]
    }
    template: {
      containers: [
        {
          name: 'cell'
          image: cellImage
          resources: { cpu: json('2'), memory: '4Gi' }
        }
      ]
    }
  }
  dependsOn: [acrPull]
}

resource migrateJob 'Microsoft.App/jobs@2024-03-01' = {
  name: 'caj-factory-migrate'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${idMigrate.id}': {} }
  }
  properties: {
    environmentId: cae.id
    configuration: {
      triggerType: 'Manual'
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      replicaRetryLimit: 0
      replicaTimeout: 1800
      registries: [{ server: acr.properties.loginServer, identity: idMigrate.id }]
    }
    template: {
      containers: [
        {
          name: 'migrate'
          image: migrateImage
          command: ['node', 'src/store/migrate-cli.ts']
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: [
            { name: 'PGHOST', value: pg.properties.fullyQualifiedDomainName }
            { name: 'PGDATABASE', value: pgDatabase }
            { name: 'PGUSER', value: idMigrate.name }
            { name: 'AZURE_CLIENT_ID', value: idMigrate.properties.clientId }
            { name: 'FACTORY_APP_PRINCIPAL', value: idControl.name }
          ]
        }
      ]
    }
  }
  dependsOn: [acrPull, pgAdmin]
}

// The control plane starts and stops cell executions, and reads their status. Nothing else on the job.
resource jobOperator 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, 'factory-cell-job-operator')
  properties: {
    roleName: 'Factory cell job operator (${resourceGroup().name})'
    description: 'Start and stop executions of caj-factory-cell.'
    type: 'CustomRole'
    assignableScopes: [resourceGroup().id]
    permissions: [
      {
        actions: [
          'Microsoft.App/jobs/start/action'
          'Microsoft.App/jobs/stop/action'
          'Microsoft.App/jobs/read'
          'Microsoft.App/jobs/executions/read'
        ]
      }
    ]
  }
}

resource jobOperatorControl 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: cellJob
  name: guid(cellJob.id, idControl.id, jobOperator.id)
  properties: {
    roleDefinitionId: jobOperator.id
    principalId: idControl.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

output acrName string = acr.name
output acrLoginServer string = acr.properties.loginServer
output controlFqdn string = control.properties.configuration.ingress.fqdn
output deployClientId string = idDeploy.properties.clientId
output pgHost string = pg.properties.fullyQualifiedDomainName
output storageAccount string = storage.name
output keyVault string = kv.name
