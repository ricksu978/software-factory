# Self-hosted OAuth2/OIDC IdPs other than Keycloak, for .NET Aspire and self-signing-in e2e/integration tests (as of 2026-11-06)

Research date 2026-11-06. Versions, dates, stars and licenses in the snapshot table come from `gh api repos/<repo>` and `gh api repos/<repo>/releases/latest`, run on 2026-11-06. Image architectures come from `docker manifest inspect <image>`, run the same day on the user's machine (`docker version` reports `server=arm64`).

### Snapshot table

| Product | Latest release (date) | License (GitHub SPDX) | Stars | linux/arm64 image | Aspire integration | Non-interactive user sign-in for tests | Hard deps |
|---|---|---|---|---|---|---|---|
| Zitadel | v4.20.1 (2026-11-03) | AGPL-3.0 | 15.5k | Yes (`ghcr.io/zitadel/zitadel:latest`, `ghcr.io/zitadel/zitadel-login:latest`) | `CommunityToolkit.Aspire.Hosting.Zitadel` 13.6.1, plus 2 community packages | No ROPC. Machine users: client credentials, JWT profile, PAT, token exchange | Postgres |
| Authentik | 2026.8.5 (2026-10-21) | NOASSERTION (mixed, see gaps) | 26.3k | Yes (`ghcr.io/goauthentik/server:2026.8.5`). No `:latest` tag exists | None found | `grant_type=password` accepted, treated as client_credentials with username + app password | Postgres only (Redis removed in 2025.10) |
| Ory Hydra / Kratos | v26.2.0 (2026-03-20), both | Apache-2.0 | 17.6k / 13.9k | Yes (`oryd/hydra`, `oryd/kratos`, also arm/v6, arm/v7) | None found | Hydra: client credentials, JWT bearer grant. ROPC enterprise-only. Kratos: native API login flow returns a session token | SQL DB (memory DSN for dev) |
| Logto | v1.46.0 (2026-11-05) | MPL-2.0 | 14.9k | Yes (`svhd/logto:latest`) | `CommunityToolkit.Aspire.Hosting.Logto` 13.6.1 | Client credentials (M2M), PAT via token exchange. ROPC not documented | Postgres ^14, optional Redis |
| Authelia | v4.39.28 (2026-09-17) | Apache-2.0 | 29.6k | Yes (`authelia/authelia:latest`) | None found | No ROPC ("very intentionally"). client_credentials only for machines | File config; storage DB |
| Dex | v2.46.1 (2026-10-21) | Apache-2.0 | 11.2k | Yes (`ghcr.io/dexidp/dex:latest`, also ppc64le, s390x) | None found | ROPC supported with local static users; token exchange; client credentials opt-in since v2.46.0 | None for memory/sqlite |
| Casdoor | v4.26.0 (2026-11-05) | Apache-2.0 | 14.8k | Yes (`casbin/casdoor:latest`) | None found | ROPC supported (blocked for MFA users), client credentials, token exchange, JWT bearer | MySQL etc., or embedded SQLite in all-in-one image |

## Which candidates have Aspire hosting integrations, and how mature are they?

### Takeaway
Only Zitadel and Logto have hosting integrations in the official CommunityToolkit for Aspire. Both shipped stable 13.6.1 on 2026-10-26, with a few thousand total downloads, and neither seeds test users or clients. Zitadel also has two community packages. One of them (`Zemires.Aspire.Hosting.Zitadel`, preview) is the only integration found that seeds a machine user and runs a typed initialization callback. Authentik, Ory, Authelia, Dex and Casdoor need a hand-written `AddContainer` resource.

### Cited Findings
- The CommunityToolkit/Aspire repo lists hosting integrations for `Keycloak.Extensions`, `Logto` and `Zitadel`. Authentik, Ory, Dex, Casdoor and Authelia do not appear → [GitHub CommunityToolkit/Aspire](https://github.com/CommunityToolkit/Aspire)
- CommunityToolkit/Aspire is MIT licensed. Its latest release is v13.6.1, published 2026-10-26 → `gh api repos/CommunityToolkit/Aspire/releases/latest`, [repo](https://github.com/CommunityToolkit/Aspire)
- **Toolkit Zitadel.** Package `CommunityToolkit.Aspire.Hosting.Zitadel`.
  - Latest stable is 13.6.1 (2026-10-26). Latest prerelease is 17.0.0-beta.1009 (2026-11-05). It has 5.4K total downloads. It targets net8.0, net9.0 and net10.0 and depends on `Aspire.Hosting` >= 13.6.4 and `Aspire.Hosting.PostgreSQL` >= 13.6.4 → [NuGet](https://www.nuget.org/packages/communitytoolkit.aspire.hosting.zitadel)
  - The README shows `builder.AddZitadel("zitadel")`, `.WithDatabase(postgres)` and `.WithExternalDomain(...)`. The default domain is `{name}.dev.localhost`, which resolves to 127.0.0.1 without DNS setup → [NuGet](https://www.nuget.org/packages/communitytoolkit.aspire.hosting.zitadel)
  - The API reference lists `AddZitadel(name, port?, username?, password?, masterKey?)`, `WithDatabase`, `WithExistingDatabase` and `WithExternalDomain`. No method for seeding users, projects or clients is listed → [aspire.dev ZitadelHostingExtensions](https://aspire.dev/reference/api/csharp/communitytoolkit.aspire.hosting.zitadel/zitadelhostingextensions/methods.md), [aspire.dev addZitadel (TS)](https://aspire.dev/reference/api/typescript/communitytoolkit.aspire.hosting.zitadel/addzitadel.md)
- **Zemires Zitadel.** Package `Zemires.Aspire.Hosting.Zitadel`.
  - Prerelease only: 13.6.0-preview.2 (2026-10-16), 123 total downloads → [NuGet](https://www.nuget.org/packages/zemires.aspire.hosting.zitadel)
  - It attaches Postgres (container or Azure), adds the login v2 UI, and offers `WithOrganizationName`, `WithMachineUser()`, `WithLoginClientKey()` and `AddProject(...).WithInitialization(async ctx => ...)` with an API client that is already authenticated as the machine user → [NuGet](https://www.nuget.org/packages/zemires.aspire.hosting.zitadel)
  - Outputs such as an OIDC client ID and secret go through `GetOutput`/`GetSecretOutput`/`context.SetOutput` and are persisted to AppHost user secrets under `Parameters:{resource}-{output}`. Keys are written to `.zitadel/{name}-keys`. A throwing callback puts the project resource in `FailedToStart` → [NuGet](https://www.nuget.org/packages/zemires.aspire.hosting.zitadel)
  - A companion client package, `Zemires.Aspire.Zitadel`, registers the Zitadel API clients and a health check → [NuGet](https://www.nuget.org/packages/zemires.aspire.zitadel)
- **BBelius Zitadel.** Package `BBelius.Aspire.Hosting.Zitadel`, version 1.0.2-beta19. Its README says it was "vibe-coded" from `Aspire.Hosting.Keycloak` and has had no in-depth review → [NuGet](https://www.nuget.org/packages/bbelius.aspire.hosting.zitadel)
- **Toolkit Logto.** Package `CommunityToolkit.Aspire.Hosting.Logto`.
  - Latest stable is 13.6.1 (2026-10-26). Previous stable 13.6.0 shipped 2026-10-01. Latest prerelease is 17.0.0-beta.1009 (2026-11-05). About 3.7K total downloads. It depends on `Aspire.Hosting`, `Aspire.Hosting.PostgreSQL` and `Aspire.Hosting.Redis`, each >= 13.6.4 → [NuGet](https://www.nuget.org/packages/communitytoolkit.aspire.hosting.logto)
  - API: `AddLogto(name, postgres, databaseName?)`, `.WithDatabaseSeeding()` (runs the Logto seed command on startup), `.WithRedis`, `.WithAdminEndpoint`, `.WithDisableAdminConsole`, `.WithTrustProxyHeader`, `.WithNodeEnv`, data volume or bind mount, and a health check on `/api/status`. Container ports are 3001 (app) and 3002 (admin) → [NuGet](https://www.nuget.org/packages/communitytoolkit.aspire.hosting.logto)
- A client package, `CommunityToolkit.Aspire.Logto.Client`, registers OIDC or JWT bearer auth against Logto. NuGet lists 13.6.0 with a newer prerelease → [NuGet](https://nuget.org/packages/communitytoolkit.aspire.logto.client/), [aspire.dev](https://aspire.dev/reference/api/csharp/communitytoolkit.aspire.logto.client.md)
- No Aspire hosting package turned up for Authentik or Ory in a NuGet-focused search → [search results incl. aspire.dev Logto reference](https://aspire.dev/reference/api/csharp/communitytoolkit.aspire.hosting.logto.md)

#### C# AppHost snippets
The Zitadel and Logto snippets follow the package READMEs. The others are sketches I wrote against the standard Aspire `AddContainer` API and have not compiled.

```csharp
// AppHost: Zitadel via CommunityToolkit (README pattern)
// dotnet add package CommunityToolkit.Aspire.Hosting.Zitadel
var postgres = builder.AddPostgres("postgres");
var zitadel = builder.AddZitadel("zitadel")          // default domain: zitadel.dev.localhost
    .WithDatabase(postgres);
builder.AddProject<Projects.Api>("api").WithReference(zitadel).WaitFor(zitadel);
```

```csharp
// AppHost: Zitadel via Zemires (preview); seeds a machine user and lets you create apps in code
var db = builder.AddPostgres("postgres").AddDatabase("zitadel-db", "zitadel");
var zitadel = builder.AddZitadel("zitadel", port: 8501)
    .WithDatabase(db)
    .WithOrganizationName("ASPIRE")
    .WithMachineUser()
    .WithLoginClientKey();
var project = zitadel.AddProject("zitadel-project", "Aspire")
    .WithInitialization(async ctx =>
    {
        // ctx.Options is already authenticated as the machine user:
        // create OIDC apps, roles, test users, then ctx.SetOutput("client-id", ...)
    });
```

```csharp
// AppHost: Logto via CommunityToolkit (README pattern)
// dotnet add package CommunityToolkit.Aspire.Hosting.Logto
var postgres = builder.AddPostgres("postgres");
var logto = builder.AddLogto("logto", postgres).WithDatabaseSeeding();
```

```csharp
// AppHost: Dex as a plain container (sketch). Config file carries static users + clients.
var dex = builder.AddContainer("dex", "ghcr.io/dexidp/dex", "v2.46.1")
    .WithBindMount("./dex/config.yaml", "/etc/dex/config.yaml", isReadOnly: true)
    .WithArgs("dex", "serve", "/etc/dex/config.yaml")
    .WithHttpEndpoint(targetPort: 5556, name: "http");
```

```csharp
// AppHost: Ory Hydra in dev mode with in-memory storage (sketch)
var hydra = builder.AddContainer("hydra", "oryd/hydra", "v26.2.0")
    .WithEnvironment("DSN", "memory")
    .WithArgs("serve", "all", "--dev")
    .WithHttpEndpoint(targetPort: 4444, name: "public")
    .WithHttpEndpoint(targetPort: 4445, name: "admin");
```

### Inferences
- The CommunityToolkit packages jumped from 13.6.x to 17.0.0-beta within days (2026-11-04/05). That suggests a major-version realignment is under way upstream, so pin 13.6.1 for now.
- Neither CommunityToolkit IdP integration seeds test users or OIDC clients, so tests still need a seeding step: Zitadel FirstInstance env vars or Management API calls, Logto Management API via an M2M app. The Zemires package is the only one that seeds through Aspire itself, and it is a 2-week-old preview with about 120 downloads.
- Dex and Hydra need only a container plus a config file or env vars, so a missing integration costs them little. A 5-line `AddContainer` covers them.

### Gaps
- I could not find the first-publish dates of the CommunityToolkit Zitadel and Logto packages. NuGet's version list was truncated at 13.5.1-beta.776 (2026-09-28).
- I did not check whether `Zemires` initialization callbacks re-run on every AppHost start or only once. Its README does not say.

## How do you seed config, users and clients declaratively for reproducible test runs?

### Takeaway
Dex, Authelia and Casdoor are the most declarative: one YAML or JSON file mounted into the container defines users and clients. Casdoor's `init_data.json` can even recreate everything on each start. Authentik has YAML blueprints plus bootstrap env vars. Zitadel seeds a first org, human admin and machine user with PAT from `ZITADEL_FIRSTINSTANCE_*` env vars, but apps and test users need API calls. Logto and Ory Kratos seed through admin APIs.

### Cited Findings
- **Zitadel.**
  - The compose deployment creates human admin `zitadel-admin` with default password `Password1!`, overridable with `ZITADEL_FIRSTINSTANCE_ORG_HUMAN_PASSWORD`. `ZITADEL_FIRSTINSTANCE_*` variables apply only on first start. The stack is Traefik, the ZITADEL API (Go), ZITADEL Login (Next.js), PostgreSQL, and optional Redis via the `cache` profile → [Zitadel compose docs](https://zitadel.com/docs/self-hosting/deploy/compose)
  - Community Helm examples define `FirstInstance.Org.Machine` with username "sa" and a MachineKey type → [Istari Zitadel install](https://docs.istaridigital.com/itAdmins/control-plane/Zitadel-Install). A forum thread asks how to retrieve that first machine user's PAT → [Zitadel questions](https://questions.zitadel.com/m/1378057537701810227). I did not confirm the exact env-var spelling for a machine-user PAT path, such as `ZITADEL_FIRSTINSTANCE_PATPATH` or `ZITADEL_FIRSTINSTANCE_ORG_MACHINE_*`, from official docs. See the gaps below.
- **Authentik.**
  - `AUTHENTIK_BOOTSTRAP_PASSWORD` (or `_PASSWORD_HASH`) and `AUTHENTIK_BOOTSTRAP_TOKEN` set the `akadmin` password and an API token. They are "Only read on the first startup", must be set on the worker container, and do not support `file://` → [authentik automated install](https://docs.goauthentik.io/install-config/automated-install/)
  - Without them, the compose install prompts in the browser for the `akadmin` password → [authentik compose install](https://docs.goauthentik.io/install-config/install/docker-compose/)
- **Ory Kratos.** Identities with a cleartext password are imported via `POST /admin/identities` using `credentials.password.config.password`. Ory hashes the password on import and skips password-policy validation. For batches over 20 cleartext passwords, Ory recommends pre-hashing → [Ory import identities](https://www.ory.com/docs/kratos/manage-identities/import-user-accounts-identities)
- **Ory Hydra.** OAuth2 clients are created via CLI or REST, e.g. `ory create oauth2-client --grant-type client_credentials ...`. Confidential client secrets are shown only once → [Ory OAuth2 clients](https://www.ory.com/docs/hydra/guides/oauth2-clients)
- **Logto.**
  - The database must be seeded with `logto db seed` / `npx @logto/cli db seed`. The CommunityToolkit `.WithDatabaseSeeding()` runs it → [Logto OSS get started](https://docs.logto.io/logto-oss/get-started-with-oss), [NuGet](https://www.nuget.org/packages/communitytoolkit.aspire.hosting.logto)
  - Requirements are PostgreSQL ^14.0, ports 3001 (core) and 3002 (admin console), images `ghcr.io/logto-io/logto` / `svhd/logto` → [Logto OSS](https://docs.logto.io/logto-oss/get-started-with-oss)
  - Management API tokens come from an M2M app. For OSS the resource is `https://default.logto.app/api` with `scope=all` → [Logto Management API](https://docs.logto.io/integrate-logto/interact-with-management-api)
- **Authelia.** OIDC clients are declared only in the config file under `identity_providers.oidc.clients`, with `client_id`, a PBKDF2 `client_secret` digest, `redirect_uris`, `grant_types` and `consent_mode`. No admin API for clients is described → [Authelia OIDC clients config](https://www.authelia.com/configuration/identity-providers/openid-connect/clients/)
  - `consent_mode: implicit` skips the consent screen and is "intended for development and testing" → [Authelia OIDC FAQ](https://www.authelia.com/integration/openid-connect/frequently-asked-questions/)
- **Dex.**
  - `staticClients` declares clients in config, public or with a `secret` → [Dex clients config](https://dexidp.io/docs/configuration/custom-scopes-claims-clients/)
  - `enablePasswordDB: true` plus `staticPasswords` entries (email, bcrypt `hash`, `username`, `userID`) seed local users → [Dex local connector](https://dexidp.io/docs/connectors/local/)
  - Dex rejects static passwords unless the password DB is enabled → [Dex config.go via search](https://github-redirect.dependabot.com/concourse/dex/blob/05bffc9535a22afaa3817e0a993c58668f2b2b9f/cmd/dex/config.go)
- **Casdoor.**
  - `init_data.json` seeds organizations, applications, users, certs, providers, roles, permissions and more. By default, existing objects are deleted and recreated from the file on every start. `initDataNewOnly` adds only missing objects, and `initDataMerge` updates fields. `initDataWatchInterval` re-applies the file on change. Docker mounts it at `/init_data.json` → [Casdoor data initialization](https://casdoor.ai/docs/deployment/data-initialization)
  - `casbin/casdoor-all-in-one` embeds SQLite ("Not for production"). `casbin/casdoor` needs your own DB, MySQL in the examples. Port 8000. `initAdminPassword` applies only on a new DB → [Casdoor try with docker](https://casdoor.ai/docs/basic/try-with-docker)

### Inferences
- For "fresh IdP per test run" reproducibility, Dex (YAML) and Casdoor all-in-one (`init_data.json`, recreate on start) give a fully declarative state with no API calls. Authelia gets close but has no ROPC.
- With Zitadel, the realistic pattern is FirstInstance env vars for a machine user plus PAT, then a test-fixture or AppHost step that calls the Management API to create the project, OIDC app and test users. The Zemires `WithInitialization` hook is the Aspire-native way to run that step.

### Gaps
- I did not fetch Authentik blueprint docs, so blueprint syntax and auto-apply path are not cited here.
- I did not verify the Authelia `users_database.yml` file-based user backend in this session.

## Which support the password grant or an equivalent machine-to-machine path for test sign-in? (OAuth 2.1 / BCP context)

### Takeaway
Real ROPC for a seeded human user works in Dex, Casdoor, Entra workforce tenants and Auth0. Authentik accepts `grant_type=password`, but it authenticates a user plus app-password token, i.e. client credentials. Zitadel, Authelia, Logto and open-source Ory Hydra refuse ROPC. Zitadel's machine users (PAT, JWT profile, client credentials) and Logto's PAT token exchange are the sanctioned non-interactive paths. Kratos's native API login gives a session token, not an OAuth token. For browser-cookie tests of a real OIDC code flow, the route that works with every IdP is Playwright filling in the hosted login once and reusing the storage state, whatever IdP you pick.

### Cited Findings
- **Zitadel.**
  - Supports Authorization Code (+PKCE), Client Credentials, Device Authorization, Implicit, JWT Profile, Refresh Token and Token Exchange. It does not support ROPC: "Due to growing security concerns we do not support this grant type", and notes OAuth 2.1 is likely to remove it → [Zitadel grant types](https://zitadel.com/docs/apis/openidoauth/grant-types)
  - A staff reply on the forum confirms the password grant "has been deprecated for security reasons and is no longer available" → [Zitadel forum](https://questions.zitadel.com/m/1402319183517323294), [second thread](https://questions.zitadel.com/m/1473553001183707157)
- **Authentik.**
  - Machine clients use `grant_type=client_credentials` with `client_id`, `username` and `password` set to an app password token. A variant sends `client_secret=base64(username:token)`. Plain `client_secret` auto-creates service account `ak-<provider>-client_credentials`. JWT `client_assertion` from federated sources is also accepted → [authentik client credentials](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/client_credentials/)
  - "authentik treats a grant type of `password` the same as `client_credentials`." The `password` field is an app password token, not the user's interactive password → [authentik client credentials](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/client_credentials/)
- **Ory Hydra.**
  - Supports the JWT bearer grant `urn:ietf:params:oauth:grant-type:jwt-bearer` → [Ory Hydra JWT guide](https://www.ory.com/docs/hydra/guides/jwt)
  - Supports client credentials: `curl -u $CLIENT_ID:$CLIENT_SECRET -d grant_type=client_credentials .../oauth2/token` → [Ory OAuth2 clients](https://www.ory.com/docs/hydra/guides/oauth2-clients)
  - ROPC is enabled by adding the "password" grant to a client in the Ory Console. The page I fetched does not state the tier → [Ory ROPC docs](https://www.ory.com/docs/oauth2-oidc/resource-owner-password-grant)
  - Search snippets of Ory doc versions describe ROPC as legacy and "only supported in Ory Network for enterprise customers" → [Ory ROPC (ory.sh)](https://ory.sh/docs/oauth2-oidc/resource-owner-password-grant), [docs mirror](https://docs-omega-six.vercel.app/docs/oauth2-oidc/resource-owner-password-grant)
  - The Hydra maintainer declined ROPC in 2017 → [Hydra PR #297](https://github.com/ory/hydra/pull/297)
  - The Hydra v2.3.0 release notes mention extra claims in the password grant "Only available with an Ory Enterprise License" → [Hydra releases](https://github.com/ory/hydra/releases)
- **Ory Kratos.** The native "API Clients and Clients without Browsers" flow is `GET /self-service/login/api` then a POST to `ui.action` with `{"identifier","password","method":"password"}`. It returns a `session_token`, which is checked via `Authorization: Bearer` on `/sessions/whoami`. Browsers should not use this flow because of CSRF → [Ory Kratos user login](https://www.ory.com/docs/kratos/self-service/flows/user-login)
- **Logto.**
  - M2M apps use `grant_type=client_credentials` with Basic auth plus `resource` and `scope`. The token `sub` is the App ID, because "Logto doesn't currently let an M2M app represent a user" → [Logto Management API](https://docs.logto.io/integrate-logto/interact-with-management-api)
  - Personal access tokens are exchanged at `/oidc/token` with the token-exchange grant and `subject_token_type=urn:logto:token-type:personal_access_token`, giving "an access token that represents the identity of the user". This needs "Allow token exchange" enabled per app. Docs versions disagree on whether `resource` is optional → [Logto PAT](https://docs.logto.io/user-management/personal-access-token)
  - Logto's own blog says "We strongly recommend avoiding using the ROPC grant type" → [Logto blog](https://blog.logto.io/deprecated-ropc-grant-type)
- **Authelia.** Supports authorization_code, client_credentials, implicit (deprecated), refresh_token and device_code. On `password`: "Authelia has very intentionally decided not to implement this Grant Type." Token exchange is not supported yet (planned) → [Authelia OIDC intro](https://www.authelia.com/integration/openid-connect/introduction/)
- **Dex.**
  - ROPC works with local users: `oauth2: passwordConnector: local` plus `enablePasswordDB: true`. The token request is `POST /dex/token` with `grant_type=password`, `username`, `password`, `scope` and client Basic auth → [Dex local connector](https://dexidp.io/docs/connectors/local/)
  - The sample config shows `passwordConnector` at top level, which conflicts with the docs' `oauth2:` placement → [Dex sample config](https://github.com/sgalsaleh/dex/blob/master/config.yaml.dist)
  - Token exchange (RFC 8693) accepts upstream access or ID tokens, with OIDC connectors only → [Dex token exchange](https://dexidp.io/docs/guides/token-exchange/)
  - v2.46.0 added a client credentials flow behind an opt-in config flag (#4583) and populates groups in client_credentials tokens (#4691) → [Dex releases](https://github.com/dexidp/dex/releases)
- **Casdoor.** Supports authorization code, password, client credentials, token exchange, device, JWT bearer and refresh token. The password grant is `POST /api/login/oauth/access_token` with `grant_type=password, client_id, client_secret, username, password`. It must be enabled under the application's Grant types, and Casdoor refuses it for users with MFA or no local password → [Casdoor OAuth](https://casdoor.ai/docs/how-to-connect/oauth)

#### C# test-side token helpers (sketch, not compiled)
```csharp
// Real ROPC (Dex / Casdoor / Entra workforce test tenant / Auth0)
static async Task<string> PasswordGrantAsync(HttpClient http, Uri tokenEndpoint,
    string clientId, string clientSecret, string user, string pass, string scope = "openid profile email")
{
    using var req = new HttpRequestMessage(HttpMethod.Post, tokenEndpoint)
    {
        Content = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["grant_type"] = "password", ["username"] = user, ["password"] = pass, ["scope"] = scope,
        })
    };
    req.Headers.Authorization = new("Basic",
        Convert.ToBase64String(Encoding.UTF8.GetBytes($"{clientId}:{clientSecret}")));
    var res = await http.SendAsync(req);
    res.EnsureSuccessStatusCode();
    using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
    return doc.RootElement.GetProperty("access_token").GetString()!;
}

// Zitadel: a machine user's PAT is itself a bearer token for Zitadel APIs.
// Your API must accept it, e.g. via introspection, not just local JWT validation.
http.DefaultRequestHeaders.Authorization = new("Bearer", File.ReadAllText(patPath).Trim());

// Logto: exchange a user's PAT for a user-scoped access token (RFC 8693)
var form = new Dictionary<string, string>
{
    ["grant_type"] = "urn:ietf:params:oauth:grant-type:token-exchange",
    ["subject_token"] = pat,
    ["subject_token_type"] = "urn:logto:token-type:personal_access_token",
    ["resource"] = "https://api.example.local",
};
```

### Inferences
- If the tests need a token for a *user* with no browser, the choice is Dex or Casdoor (real ROPC), Logto (PAT plus token exchange, user identity preserved), or Zitadel (machine user, whose token represents a service account, not a human). Authentik's `password` grant authenticates a user via app-password token, which also gives a user-scoped token without a browser.
- ROPC is deprecated in OAuth 2.1 drafts and the Security BCP. Zitadel's docs, Authelia's refusal and Logto's blog all cite security. For tests only, the deprecation matters less than whether the product ships the grant.

### Gaps
- I did not fetch the OAuth 2.1 draft or RFC 9700 (Security BCP) text, so this note carries no direct quote of the deprecation.
- I did not determine whether Hydra v26.2.0 OSS includes ROPC. The sources conflict between "enterprise only" and an OEL note in v2.3.0. Verify by registering a client with `grant_types=["password"]` against `oryd/hydra:v26.2.0`.
- I found no Logto doc that explicitly lists ROPC as unsupported. The only statement found is the blog recommendation.

## Which publish linux/arm64 images?

### Takeaway
All seven candidates publish multi-arch images that include linux/arm64, verified by `docker manifest inspect` on 2026-11-06. One trap: Authentik has no `:latest` tag on ghcr, so pin a version tag such as `2026.8.5`.

### Cited Findings
- arm64 present in each manifest list (`docker manifest inspect <image> | grep architecture`, run 2026-11-06): `ghcr.io/zitadel/zitadel:latest`, `ghcr.io/zitadel/zitadel-login:latest`, `ghcr.io/goauthentik/server:2026.8.5` (and `:2025.10`), `oryd/hydra:latest` and `oryd/hydra:v26.2.0` (also arm/v6, arm/v7), `oryd/kratos:latest`, `svhd/logto:latest`, `authelia/authelia:latest` (also arm/v7), `ghcr.io/dexidp/dex:latest` (also arm/v7, ppc64le, s390x), `casbin/casdoor:latest`, and `quay.io/keycloak/keycloak:latest` for reference → local command output
- `docker manifest inspect ghcr.io/goauthentik/server:latest` returns `manifest unknown`, and `goauthentik/server:latest` on Docker Hub errors → local command output
- Authentik's compose file "statically references the latest version available at the time of downloading" instead of a floating tag → [authentik compose install](https://docs.goauthentik.io/install-config/install/docker-compose/)

### Inferences
- arm64 does not rule out any candidate. It mainly affects the database container you pair it with. `postgres:17-alpine`, `ghcr.io/dexidp/dex:v2.46.1`, `oryd/hydra:v26.2.0` and `ghcr.io/zitadel/zitadel:v4.20.1` all pulled without error on this arm64 host (`docker pull -q`, 2026-11-06).

### Gaps
- I did not check `casbin/casdoor-all-in-one` or `ghcr.io/logto-io/logto` manifests separately.

## How heavy is each to spin up per test run? (startup time, footprint, external deps)

### Takeaway
My inference, not sourced here, is that Dex, Hydra and Authelia are the lightest: each is a single container with file or env config and no Postgres requirement. Casdoor's all-in-one image embeds SQLite. Logto and Zitadel each need Postgres plus an init or seed step, and Zitadel's docs ask for at least 2 GB RAM. Authentik is the heaviest: separate server and worker containers plus Postgres, with a documented floor of 2 CPU cores and 2 GB RAM. No vendor publishes startup times, and my local timing run did not finish, so the timings are a gap.

### Cited Findings
- **Zitadel.** Compose docs require "at least 2 GB RAM" plus Docker Engine 24+. Postgres is required and Redis is optional → [Zitadel compose docs](https://zitadel.com/docs/self-hosting/deploy/compose)
- **Authentik.**
  - Requires "at least 2 CPU cores and 2 GB of RAM" and runs separate server and worker containers → [authentik compose install](https://docs.goauthentik.io/install-config/install/docker-compose/)
  - Since 2025.10, Redis is gone and caching, the embedded outpost, WebSockets and tasks all run on Postgres. Expect about 50% more Postgres connections → [authentik 2025.10 release notes](https://docs.goauthentik.io/releases/2025.10/), [We removed Redis blog](https://goauthentik.io/blog/2025-11-13-we-removed-redis/)
- **Logto.** Needs PostgreSQL ^14 and a seed step. Redis is optional via `.WithRedis` → [Logto OSS](https://docs.logto.io/logto-oss/get-started-with-oss), [NuGet](https://www.nuget.org/packages/communitytoolkit.aspire.hosting.logto)
- **Casdoor.** The all-in-one image embeds SQLite. Data is lost when the container is removed, which suits throwaway test runs → [Casdoor try with docker](https://casdoor.ai/docs/basic/try-with-docker)
- **Ory Hydra.** Hydra only issues tokens. It delegates user login and consent to a separate UI, and user accounts need Kratos or your own login app. Kratos's native API login flow shows it serves user identities over its own self-service API → [Ory Kratos user login](https://www.ory.com/docs/kratos/self-service/flows/user-login)

### Inferences
- Per-test-run cost ranking, lightest first: Dex ≈ Hydra (in-memory, single Go binary) < Authelia (single Go binary, file config) < Casdoor all-in-one (SQLite) < Logto (Node + Postgres + seed) < Zitadel (Go + Postgres + init/setup + login v2 UI) < Authentik (Python server + worker + Postgres, 2 GB guidance). This ranking infers from architecture and the documented RAM floors. Nothing here was measured.
- Container-per-test-class is affordable for Dex and Hydra. Zitadel, Authentik and Logto fit one shared instance per test session, with unique users or orgs per test.

### Gaps
- I have no startup-time or memory measurement for any candidate. A local script (`/tmp/idpbench/bench.sh`) started Dex, then Hydra with `DSN=memory`, then Zitadel with Postgres, polling each discovery endpoint. It hung on the first step, Dex with `dex serve /etc/dex/config.docker.yaml`, and I stopped it. The likely cause is a curl with no `--max-time` against a port-forward with no responsive container behind it, which is unconfirmed. Containers `b-dex` and the `benchnet` network may remain on the host.
- I did not verify that Hydra v26.2.0 starts with `DSN=memory serve all --dev`, or that Dex's image ships `/etc/dex/config.docker.yaml`.
- I did not confirm the Zitadel env vars for a FirstInstance machine user and PAT file (`ZITADEL_FIRSTINSTANCE_ORG_MACHINE_MACHINE_USERNAME`, `ZITADEL_FIRSTINSTANCE_ORG_MACHINE_PAT_EXPIRATIONDATE`, `ZITADEL_FIRSTINSTANCE_PATPATH`). The official compose page did not show them.
- I did not measure Authentik, Logto, Authelia or Casdoor either. Each needs Postgres or a working config.
- I found no vendor-published startup-time figures for any candidate.

## Cloud IdPs (Entra ID / External ID, Auth0, Okta): how tests self-sign-in, and what Aspire offers

### Takeaway
Entra workforce tenants support ROPC for tests, but only with cloud-only password users in a dedicated test tenant, MFA excluded via Conditional Access, and "Allow public client flows" on. Entra External ID (CIAM) tenants do not support ROPC at all. Auth0 supports ROPC for highly trusted apps. Okta needs the password grant allowed in the authorization-server access policy and a password-only sign-on policy. Aspire has no official Entra hosting resource. Microsoft documents Entra plus Aspire wiring through `Microsoft.Identity.Web`, and a community preview package provisions app registrations.

### Cited Findings
- **Entra ID ROPC.**
  - ROPC works only in Entra tenants, so it needs a tenant-specific or `organizations` endpoint. Personal accounts, guests invited from personal accounts and passwordless accounts cannot use it. Users who need MFA "will be blocked". Hybrid federation is unsupported except via HRD `AllowCloudPasswordValidation` → [Entra ROPC](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth-ropc)
  - "Applications and test rigs relying on ROPC will be locked out" as Microsoft APIs increasingly require MFA claims. For no-user scenarios such as CI, Microsoft recommends service principals (managed identity, federated identity credentials, certificate) → [Entra ROPC](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth-ropc)
- **Entra test guidance.**
  - Use ROPC "only for testing purposes in a separate test tenant, and only with test users". Store credentials in Key Vault, toggle Allow public client flows to Yes, pre-consent permissions, and exclude the test users or apps from the MFA Conditional Access policy → [Entra automated integration tests](https://learn.microsoft.com/en-us/entra/identity-platform/test-automate-integration-testing)
  - The C# sample uses MSAL `app.AcquireTokenByUsernamePassword(scopes, username, securePassword).ExecuteAsync()`. The Playwright sample gets tokens with msal-node `acquireTokenByUsernamePassword` and injects the MSAL cache into `sessionStorage` via `addInitScript` to skip the login UI → [Entra automated integration tests](https://learn.microsoft.com/en-us/entra/identity-platform/test-automate-integration-testing)
- **Entra External ID.**
  - The protocol table lists ROPC as "Yes" for workforce and "No; for mobile applications, use native authentication" for external tenants. Client credentials in external tenants is v2.0 apps only. The page was updated 2026-11-04 → [External ID supported features](https://learn.microsoft.com/en-us/entra/external-id/customers/concept-supported-features-customers)
  - The page still says premium-license features are unavailable "during the preview" → [External ID supported features](https://learn.microsoft.com/en-us/entra/external-id/customers/concept-supported-features-customers)
- **Auth0.** "Highly-trusted applications can use the Resource Owner Password Flow". It is for cases where redirect flows are impossible, can be combined with MFA, and brute-force protection can make "some attack protection features" fail → [Auth0 ROPC](https://auth0.com/docs/get-started/authentication-and-authorization-flow/resource-owner-password-flow)
- **Okta.**
  - The password grant must be allowed in the authorization server's access policy (Security > API > Authorization server > Access policies) → [Okta support](https://support.okta.com/help/s/question/0D54z00007j3pc6CAA/resource-owner-password-credentials-authentication-denied-by-sign-on-policy)
  - Sign-on policies requiring MFA cause "denied by sign on policy" errors. Forum answers say ROPC does not support MFA → [Okta dev forum](https://devforum.okta.com/t/resource-owner-password-credentials-cannot-be-used-with-mfa-enabled/12148), [Okta dev forum 2](https://devforum.okta.com/t/using-resource-owner-grant-type-and-mfa/3269)
  - These are community and support posts, not official docs.
- **Aspire + Entra.**
  - Microsoft documents adding Entra auth to an Aspire app with `Microsoft.Identity.Web` (v3.3.0+ ships `BlazorAuthenticationChallengeHandler`), placeholder config first, then real app registrations, with the client secret in user secrets → [Add Entra ID to an Aspire app](https://learn.microsoft.com/entra/msidweb/frameworks/aspire)
  - `Neox.Aspire.Hosting.Auth.EntraId` (1.0.0-preview) creates Entra app registrations via Microsoft Graph and passes credentials as `AzureAd__*` env vars → [NuGet](https://www.nuget.org/packages/neox.aspire.hosting.auth.entraid)

### Inferences
- An Entra External ID (CIAM) app cannot use ROPC in tests. Its options are Playwright through the hosted page, native authentication APIs, or swapping in a local IdP for tests. That is a strong argument for a self-hosted IdP in the Aspire test AppHost.
- Neither Aspire nor `Microsoft.Identity.Web` offers a local Entra emulator, so Aspire's Entra story helps wiring, not self-sign-in.

### Gaps
- I found no official Okta doc page on ROPC limits in this session. The Okta findings rest on support and forum threads.
- I did not check whether MSAL.NET has deprecated or obsoleted `AcquireTokenByUsernamePassword` as of 2026-11. Microsoft's test page still uses it, updated 2026-06-15.

## Playwright login suitability and maintenance status

### Takeaway
Every candidate serves a hosted HTML login page that Playwright can drive. The ones with plain username/password forms and no forced first-login steps are easiest: Dex, Authelia (one factor), Casdoor, Authentik with a simple flow. Zitadel's first-instance admin may be asked to change the password, and its v2 login is a separate Next.js app. All candidates except Ory had a release in the last 7 weeks.

### Cited Findings
- **Maintenance (latest release, last push).**
  - Zitadel v4.20.1, 2026-11-03, pushed 2026-11-04
  - Authentik 2026.8.5, 2026-10-21, pushed 2026-11-06
  - Logto v1.46.0, 2026-11-05
  - Casdoor v4.26.0, 2026-11-05, about 10 releases in the month before → [Casdoor releases](https://github.com/casdoor/casdoor/releases)
  - Dex v2.46.1, 2026-10-21
  - Authelia v4.39.28, 2026-09-17
  - Ory Hydra and Kratos v26.2.0, 2026-03-20, last push 2026-07-29
  - Source for all of the above: `gh api repos/<repo>` and `/releases/latest`
- Zitadel's recent cadence is v4.19.3 (Sep 29), v4.19.4 (Oct 1), v4.19.5 (Oct 15), v4.20.0 (Oct 22) and v4.20.1 (Nov 3) → [Zitadel releases](https://github.com/zitadel/zitadel/releases)
- Zitadel login v2 is a separate Next.js "ZITADEL Login" service, image `ghcr.io/zitadel/zitadel-login` → [Zitadel compose docs](https://zitadel.com/docs/self-hosting/deploy/compose), local `docker manifest inspect`
- Entra's own Playwright guidance avoids UI login by injecting ROPC-obtained MSAL tokens into `sessionStorage` → [Entra automated integration tests](https://learn.microsoft.com/en-us/entra/identity-platform/test-automate-integration-testing)

### Inferences
- For Playwright against a self-hosted IdP, the efficient pattern is one UI login per user in a global setup, then `storageState` reuse. It works with any candidate, needs no ROPC, and exercises the real code flow. Use ROPC or token APIs only for API-level tests.
- Ory has the slowest release cadence, with about 8 months since the last release. Zitadel, Logto, Casdoor and Authentik are the most actively released.

### Gaps
- I did not drive any candidate's login page with Playwright in this session, so the form-friction claims are inference, not observation.
- I did not verify whether Zitadel forces a password change on the FirstInstance human admin by default.
- **Authentik license.** GitHub's license detection returns `NOASSERTION` for goauthentik/authentik (`gh api repos/goauthentik/authentik`). I did not read the LICENSE file, so the exact open-source and enterprise split is unverified.
- Zitadel's AGPL-3.0 (`gh api`) matters only if you distribute a modified Zitadel. I did not check when Zitadel moved from Apache-2.0 to AGPL.
