# Phase 0 platform spike

Plan Task 19. The infrastructure and probe code landed on 2026-11-07 from branch `factory/pbi-23-r1`. The Azure probes below need the owner's Azure Owner rights and three real accounts, so they're pending until the owner runs them. Each line gives what the plan expects, then what happened, with its evidence.

## Checked before any deploy

- **Bicep build.** Expected no errors. `az bicep build --file infra/main.bicep` exited 0 with no warnings on Bicep CLI 0.48.1, and `az bicep build-params --file infra/main.bicepparam` exited 0.
- **Postgres admin.** Not planned for. An Entra admin's resource name is the principal's object id, which Bicep can't compute before the identity exists (error BCP120). So the admin lives in the module `infra/pg-admin.bicep`, which takes the object id as a parameter.
- **Job actions.** Expected the actions for the custom role. `az provider operation show --namespace Microsoft.App` lists `microsoft.app/jobs/start/action` and `microsoft.app/jobs/stop/action`, and no separate action to stop one execution. The role also holds `jobs/read` and `jobs/executions/read`, so the launcher can read an execution's status.
- **Gateway route.** Expected 401 while `MODEL_PROBE_CREDENTIAL` is unset. `node spike/hello.ts` on this machine answered `POST /internal/model/v1/messages` with 401 with no credential and with any stand-in. With the variable set, a wrong stand-in got 401, the right one on `/v1/oauth` got 404, and the right one with an `mcp_servers` body got 400. `POST /internal/cells/ping` still got 204.
- **Images.** Expected `spike/Dockerfile` to serve the route and the control image to carry the migrate entry point. I built both natively on this ARM64 machine and pushed neither. The spike container answered 401 on the gateway route, and the control image holds `src/store/migrate-cli.ts` and the five files in `db/migrations`.
- **ACR cost.** Not priced in the spec. Basic in australiaeast lists at USD 0.1666 a day, about USD 5 a month, with 10 GB of storage included and USD 0.10 per GB-month above that ([Azure retail prices API](https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20%27Container%20Registry%27%20and%20armRegionName%20eq%20%27australiaeast%27), [pricing page](https://azure.microsoft.com/en-us/pricing/details/container-registry/)).

## Owner's bootstrap

Run from your own `az login`, signed in to the subscription that should hold the factory. The `az` session on this machine was on "OnTrack365 Subscription" on 2026-11-07, so check `az account show` first.

1. Set `claudeTokenCreatedAt` in `infra/main.bicepparam`.
2. Export the five secrets, which `main.bicepparam` reads from the environment: `GITHUB_APP_KEY`, `GITHUB_PROJECT_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `GITHUB_WEBHOOK_SECRET` and `CELL_SECRET` (`openssl rand -hex 32`). An unset one leaves its Key Vault secret alone, which is why `deploy.yml` never handles a secret value.
3. `az group create -n rg-software-factory-aue -l australiaeast`, then `az deployment group what-if -g rg-software-factory-aue -f infra/main.bicep -p infra/main.bicepparam` and read the resource list against Step 1. Then run the same command with `create` in place of `what-if`.
4. The deploy's outputs give `controlFqdn` and `deployClientId`. Register a Microsoft Entra app for "Any Microsoft Entra directory and personal Microsoft accounts" with redirect URI `https://<controlFqdn>/.auth/login/aad/callback`, and a Google OAuth client with redirect URI `https://<controlFqdn>/.auth/login/google/callback` ([Container Apps auth](https://learn.microsoft.com/en-us/azure/container-apps/authentication-azure-active-directory), [Google](https://learn.microsoft.com/en-us/azure/container-apps/authentication-google)). Put both client ids in `main.bicepparam`, export their secrets as `AUTH_MICROSOFT_SECRET` and `AUTH_GOOGLE_SECRET`, and deploy again. Built-in auth stays off until both ids are set.
5. Merge the client ids and `claudeTokenCreatedAt` to `main`. `deploy.yml` deploys the param file on `main`, and it refuses to run while that file still has an empty client id or the date placeholder, because it would ship the app without sign-in.
6. Create the repo's `production` environment with yourself as required reviewer and `main` as its only deployment branch. Give it the variables `AZURE_CLIENT_ID` (`deployClientId`), `AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID`. The federated credential on `id-factory-deploy` is already in the Bicep.

**Your later deploys.** Rotating a secret, such as the Claude token, still takes your own deploy with the variable exported. Pass the running images too, or the app and both jobs fall back to the placeholder image:

```sh
rg=rg-software-factory-aue q=properties.template.containers[0].image
control=$(az containerapp show -n ca-factory-control -g $rg --query $q -o tsv)
cell=$(az containerapp job show -n caj-factory-cell -g $rg --query $q -o tsv)
migrate=$(az containerapp job show -n caj-factory-migrate -g $rg --query $q -o tsv)
az deployment group create -g $rg -f infra/main.bicep -p infra/main.bicepparam \
  -p controlImage=$control cellImage=$cell migrateImage=$migrate
```

## Azure probes

| Step | Probe | Expected | Actual | Evidence |
|---|---|---|---|---|
| 4 | `deploy.yml` with `control_image` empty | the migrate execution Succeeded, then the app serves `control-spike:<sha>` | pending | |
| 5 | Google account sign-in | reaches `/`, shows `x-ms-client-principal-idp` and `-id` | pending | |
| 5 | Personal Microsoft account sign-in | reaches `/` with a distinct id | pending | |
| 5 | Work account from another tenant | reaches `/` with a distinct id | pending | |
| 6 | `curl -H "X-MS-CLIENT-PRINCIPAL-ID: forged" https://<app>/` signed out | login redirect, never 200 | pending | |
| 6 | Same header on `POST /internal/cells/ping` | 204, no identity echoed | pending | |
| 6 | `curl -X POST https://<app>/internal/model/v1/messages` | 401 from the gateway, not a redirect | pending | |
| 7 | Signed App webhook delivery | 204, no login redirect | pending | |
| 7 | Delivery after changing the secret on one side | 401 | pending | |
| 8 | `spike/sdk-oauth.ts` in `caj-factory-cell` through the gateway | `subtype: "success"` | pending | |
| 9 | `spike/sdk-oauth.ts sandbox` | example.com blocked, api.github.com allowed | pending | |
| 9 | Test database in a cell | waits for PBI 22 | pending | |
| 9 | Factory database as `id-factory-cell` | token issued, connection refused | pending | |
| 10 | Migrate execution with `--image` and `--args` | record whether the job's env survives | pending | |
| Task 2 | Bot assignment | already settled: 403, so the claim marker is a label | settled | `2026-11-local-platform.md` |
| Task 13 | `beginStart` returns at start or at end | record which | pending | |

## Open questions for Step 5

- **Issuer.** The Microsoft provider uses `https://login.microsoftonline.com/common/v2.0`. Microsoft's Container Apps page gives only a per-tenant issuer, and no page I read says personal accounts work through built-in auth. The three sign-ins settle it.
- **Second provider.** `redirectToProvider` sends a signed-out request to Microsoft. A Google user goes to `/.auth/login/google` directly. Whether built-in auth needs that setting with two providers is unchecked, and Step 5 shows it. If the Google path is too awkward, the factory's no-access page can link both.
- **Client secrets.** The two auth client secrets are Key Vault secrets `auth-microsoft-secret` and `auth-google-secret`, beyond the plan's five. Without a secret the Microsoft provider falls back to implicit flow, which Microsoft's page warns against. Only the control identity can read them.
