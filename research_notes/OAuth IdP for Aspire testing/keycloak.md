# Keycloak as the OAuth/OIDC IdP for .NET Aspire local dev and self-signing-in e2e tests

Research date: 2026-11-06. Versions current at that date: Aspire 13.6.x, Keycloak 26.8.2.

## 1. What the official Aspire Keycloak integrations provide

### Takeaway
`Aspire.Hosting.Keycloak` (AppHost) and `Aspire.Keycloak.Authentication` (client) both remain **preview-only** at 13.6.4-preview.1.26523.11 (2026-10-24). No GA release has shipped. The hosting side runs `quay.io/keycloak/keycloak:26.6` in `start-dev --import-realm` mode with a `/health/ready` health check on management port 9000. The client side registers JwtBearer/OIDC handlers whose Authority is `https+http://{serviceName}/realms/{realm}`, resolved by Aspire service discovery.

### Cited Findings

**Packages and status**
- The latest `Aspire.Hosting.Keycloak` is 13.6.4-preview.1.26523.11, published 2026-10-24. Every listed version is a prerelease (13.4.2-preview through 13.6.4-preview). The package targets net8.0 and depends on `Aspire.Hosting` >= 13.6.4. [NuGet `Aspire.Hosting.Keycloak`](https://www.nuget.org/packages/Aspire.Hosting.Keycloak)
- The latest `Aspire.Keycloak.Authentication` is 13.6.4-preview.1.26523.11 (2026-10-24), also prerelease-only. It targets net8.0/net9.0/net10.0 and depends on `Microsoft.AspNetCore.Authentication.JwtBearer` and `.OpenIdConnect`. [NuGet `Aspire.Keycloak.Authentication`](https://www.nuget.org/packages/Aspire.Keycloak.Authentication)
- The docs mark the hosting integration "🧪 Preview". They moved from learn.microsoft.com, which now 301-redirects, to aspire.dev. The page references Aspire CLI 13.6.0, released 2026-09-29. [aspire.dev Keycloak integration](https://aspire.dev/integrations/security/keycloak/)
- You can add it with `aspire add keycloak`, or with `#:package Aspire.Hosting.Keycloak@*` in a file-based AppHost. [aspire.dev Keycloak integration](https://aspire.dev/integrations/security/keycloak/)
- The integration roadmap is still tracked as an open issue. [Issue #1326](https://github.com/microsoft/aspire/issues/1326)
- Two open feature issues: desired-state configuration via keycloak-config-cli ([Issue #19693](https://github.com/microsoft/aspire/issues/19693)) and a `KeycloakRealmResource` to model a realm address ([Issue #5092](https://github.com/microsoft/aspire/issues/5092)).
- The community package `CommunityToolkit.Aspire.Hosting.Keycloak.Extensions` adds `WithPostgres(database)` to back Keycloak with an Aspire Postgres database. [aspire.dev Keycloak integration](https://aspire.dev/integrations/security/keycloak/)

**Hosting API surface (source, `main` branch)**
- Public signatures. [KeycloakResourceBuilderExtensions.cs](https://raw.githubusercontent.com/microsoft/aspire/main/src/Aspire.Hosting.Keycloak/KeycloakResourceBuilderExtensions.cs)
  ```csharp
  AddKeycloak(this IDistributedApplicationBuilder builder, string name, int? port = null,
      IResourceBuilder<ParameterResource>? adminUsername = null,
      IResourceBuilder<ParameterResource>? adminPassword = null)
  WithDataVolume(this IResourceBuilder<KeycloakResource> builder, string? name = null)
  WithDataBindMount(this IResourceBuilder<KeycloakResource> builder, string source)
  WithRealmImport(this IResourceBuilder<KeycloakResource> builder, string import)
  [Obsolete] WithRealmImport(..., string import, bool isReadOnly)
  WithEnabledFeatures(params string[] features) / WithDisabledFeatures(params string[] features)
  WithOtlpExporter() / WithOtlpExporter(OtlpProtocol protocol)
  ```
- Image constants are `Registry = "quay.io"`, `Image = "keycloak/keycloak"`, `Tag = "26.6"`. [KeycloakContainerImageTags.cs](https://raw.githubusercontent.com/microsoft/aspire/main/src/Aspire.Hosting.Keycloak/KeycloakContainerImageTags.cs)
- Ports: `DefaultContainerPort = 8080`, `DefaultHttpsPort = 8443`, `ManagementInterfaceContainerPort = 9000`. The management endpoint is named `"management"`. [KeycloakResourceBuilderExtensions.cs](https://raw.githubusercontent.com/microsoft/aspire/main/src/Aspire.Hosting.Keycloak/KeycloakResourceBuilderExtensions.cs)
- Environment variables set: `KC_BOOTSTRAP_ADMIN_USERNAME`, `KC_BOOTSTRAP_ADMIN_PASSWORD` and `KC_HEALTH_ENABLED=true`. `KC_FEATURES`/`KC_FEATURES_DISABLED` are set when features are given, and `KC_HTTPS_CERTIFICATE_FILE`/`KC_HTTPS_CERTIFICATE_KEY_FILE` (or the PKCS12 keystore vars) when HTTPS is configured. [KeycloakResourceBuilderExtensions.cs](https://raw.githubusercontent.com/microsoft/aspire/main/src/Aspire.Hosting.Keycloak/KeycloakResourceBuilderExtensions.cs)
- Container args are `start-dev` in run mode and `start` in publish mode. `--import-realm` is always added. [KeycloakResourceBuilderExtensions.cs](https://raw.githubusercontent.com/microsoft/aspire/main/src/Aspire.Hosting.Keycloak/KeycloakResourceBuilderExtensions.cs)
- Health check: `.WithHttpHealthCheck(endpointName: ManagementEndpointName, path: "/health/ready")`. That makes `WaitFor(keycloak)` and `WaitForResourceHealthyAsync` wait until Keycloak is ready. [KeycloakResourceBuilderExtensions.cs](https://raw.githubusercontent.com/microsoft/aspire/main/src/Aspire.Hosting.Keycloak/KeycloakResourceBuilderExtensions.cs)
- The current `WithRealmImport(string)` copies files into `/opt/keycloak/data/import` with `WithContainerFiles`. The obsolete overload used a bind mount. [KeycloakResourceBuilderExtensions.cs](https://raw.githubusercontent.com/microsoft/aspire/main/src/Aspire.Hosting.Keycloak/KeycloakResourceBuilderExtensions.cs)
- `WithDataVolume` mounts a named volume at `/opt/keycloak/data` (read-write). [KeycloakResourceBuilderExtensions.cs](https://raw.githubusercontent.com/microsoft/aspire/main/src/Aspire.Hosting.Keycloak/KeycloakResourceBuilderExtensions.cs)
- Admin defaults: username `admin`. The password is randomly generated and stored in AppHost user secrets as `Parameters:keycloak-password`. [aspire.dev Keycloak integration](https://aspire.dev/integrations/security/keycloak/)
  - Conflict. The docs page names the env vars `KEYCLOAK_ADMIN`/`KEYCLOAK_ADMIN_PASSWORD`, but the source sets `KC_BOOTSTRAP_ADMIN_USERNAME`/`KC_BOOTSTRAP_ADMIN_PASSWORD` ([source](https://raw.githubusercontent.com/microsoft/aspire/main/src/Aspire.Hosting.Keycloak/KeycloakResourceBuilderExtensions.cs)). The source is authoritative, so the docs text looks outdated.
- `WithDataVolume` caveat: admin credentials persist in the volume, so a changed password has no effect until the volume is deleted. [aspire.dev Keycloak integration](https://aspire.dev/integrations/security/keycloak/)
- The docs recommend a fixed port, e.g. `AddKeycloak("keycloak", 8080)`, because browser cookies holding OIDC tokens are tied to the authority URL, port included. [aspire.dev Keycloak integration](https://aspire.dev/integrations/security/keycloak/)
- `WithRealmImport` is "intended for local development only" and is not supported by `aspire publish`/`aspire deploy`. For production the docs offer `WithDockerfile` (copy realm JSON into the image), an init service using the Admin REST API, or Terraform. [aspire.dev Keycloak integration](https://aspire.dev/integrations/security/keycloak/)
- The docs' tag note says image tags track the microsoft/aspire main branch and may be newer than the version your installed package pins. The docs' Dockerfile example still uses `quay.io/keycloak/keycloak:25.0.0`, which is outdated relative to the 26.6 pin. [aspire.dev Keycloak integration](https://aspire.dev/integrations/security/keycloak/)

**Client API surface**
- Overloads: `AddKeycloakJwtBearer(this AuthenticationBuilder, string serviceName, string realm[, string authenticationScheme][, Action<JwtBearerOptions>? configureOptions])`. `AddKeycloakOpenIdConnect` has the same shape with `OpenIdConnectOptions`. Default schemes are `"Bearer"` and `"OpenIdConnect"`. [AspireKeycloakExtensions.cs](https://raw.githubusercontent.com/microsoft/aspire/main/src/Components/Aspire.Keycloak.Authentication/AspireKeycloakExtensions.cs)
- Authority construction: `return $"https+http://{serviceName}/realms/{realm}";`. The backchannel is a named HttpClient, `options.Backchannel = httpClientFactory.CreateClient(KeycloakBackchannel)`, so service discovery resolves the `https+http://` scheme. [AspireKeycloakExtensions.cs](https://raw.githubusercontent.com/microsoft/aspire/main/src/Components/Aspire.Keycloak.Authentication/AspireKeycloakExtensions.cs)
- Docs examples: JwtBearer with `realm: "api"`, `options.Audience = "store.api"`, and `options.RequireHttpsMetadata = false` inside an `IsDevelopment()` check. OIDC with `ClientId = "StoreWeb"`, `ResponseType = OpenIdConnectResponseType.Code`, and `Scope.Add("store:all")`. [aspire.dev Keycloak integration](https://aspire.dev/integrations/security/keycloak/)
- `RequireHttpsMetadata` defaults to `true`. The docs say the service-discovery `https+http://` scheme does not satisfy it, so you either disable it in dev or set an explicit `https://` Authority. [aspire.dev Keycloak integration](https://aspire.dev/integrations/security/keycloak/)

**Automatic HTTPS (Aspire 13.3+)**
- After upgrading from 13.1.0-preview to 13.3.5-preview, the Keycloak "http" endpoint on 8080 began serving HTTPS. A maintainer called this "by design" and said to opt out with `.WithoutHttpsCertificate()`. [Issue #17661](https://github.com/microsoft/aspire/issues/17661)
- Aspire lists "Keycloak containers" among the resources it automatically configures with the dev certificate. `WithoutHttpsCertificate()` disables that, and `WithHttpsDeveloperCertificate()` opts in explicitly. Both apply in run mode only. [aspire.dev certificate configuration](https://aspire.dev/app-host/certificate-configuration/)

### Inferences
- Pin both packages to the same exact preview version. All releases carry a preview suffix and minor versions changed runtime behavior (auto-HTTPS in 13.3, WaitFor hang in 13.3), so floating versions are risky.
- With `RequireHttpsMetadata = true` and auto-HTTPS on, the dev-cert HTTPS endpoint may satisfy the requirement. Whether `https+http://` resolves to the HTTPS endpoint in that case was not verified.

### Gaps
- No published GA date or plan for either Keycloak package.
- I did not confirm whether `AddKeycloak` exposes an `https` endpoint by default in 13.6 or only rewrites the `http` endpoint's scheme.

## 2. Seeding a reproducible realm (clients, users, passwords, roles)

### Takeaway
Put `<realm>-realm.json` (and optionally `<realm>-users-N.json`) in a folder and call `.WithRealmImport("./Realms")`. Keycloak imports it at startup and finishes starting only after the import. If the realm already exists, the import is **skipped**, so for per-run reproducibility use no data volume, which gives a fresh container per test run.

### Cited Findings
- Startup import reads only regular `.json` files from `data/import` (`/opt/keycloak/data/import` in the container) and ignores sub-directories. [Keycloak import/export](https://www.keycloak.org/server/importExport)
- "If a realm already exists in the server, the import operation is skipped." Re-creating a realm requires running the `import` command before the server starts. [Keycloak import/export](https://www.keycloak.org/server/importExport)
- The server does not finish starting until imports complete, so the `/health/ready` gate covers the import. [Keycloak import/export](https://www.keycloak.org/server/importExport)
- Naming convention: `<realm name>-realm.json`, `<realm-name>-users-<n>.json`, `<realm-name>-federated-users-<n>.json`. "Failure to use this convention will result in errors or user files not being imported." [Keycloak import/export](https://www.keycloak.org/server/importExport)
- Export a realm with its users into one file: `bin/kc.sh export --dir <dir> --realm my-realm --users realm_file`, with the server stopped. Admin Console partial exports "never include users". [Keycloak import/export](https://www.keycloak.org/server/importExport)
- Realm files support placeholders such as `${MY_REALM_NAME}` resolved from environment variables, with no restriction on which variables. [Keycloak import/export](https://www.keycloak.org/server/importExport)
- Community realm files define users inline with `"credentials": [{ "type": "password", "value": "kcuser", "temporary": false }]` and clients with `"directAccessGrantsEnabled": true`. [ClusterCockpit realm](https://git.clustercockpit.org/ClusterCockpit/cc-docker/src/branch/main/keycloak/import/clustercockpit-realm.json); [Alauda KeycloakRealmImport docs](https://docs.alauda.io/keycloak/26.4/apis/kubernetes_apis/keycloak_realm_import.html)
- `directAccessGrantsEnabled` maps to the RealmRepresentation JSON and enables the Resource Owner Password Credentials flow. [Alauda KeycloakRealmImport docs](https://docs.alauda.io/keycloak/26.4/apis/kubernetes_apis/keycloak_realm_import.html)
- AppHost wiring is `.WithRealmImport("./Realms")` on the Keycloak resource. Aspire copies the folder into `/opt/keycloak/data/import`. [aspire.dev Keycloak integration](https://aspire.dev/integrations/security/keycloak/)

Illustrative minimal realm file. I composed it from the RealmRepresentation fields cited above and did not test it.
```json
{
  "realm": "app",
  "enabled": true,
  "sslRequired": "none",
  "roles": { "realm": [ { "name": "admin" }, { "name": "user" } ] },
  "clients": [
    { "clientId": "web", "publicClient": false, "secret": "web-secret",
      "standardFlowEnabled": true, "directAccessGrantsEnabled": true,
      "redirectUris": ["https://localhost:*/*", "http://localhost:*/*"], "webOrigins": ["+"] },
    { "clientId": "test-runner", "publicClient": false, "secret": "test-secret",
      "serviceAccountsEnabled": true, "standardFlowEnabled": false }
  ],
  "users": [
    { "username": "alice", "enabled": true, "emailVerified": true, "email": "alice@test.local",
      "firstName": "Alice", "lastName": "Test",
      "credentials": [ { "type": "password", "value": "Passw0rd!", "temporary": false } ],
      "realmRoles": ["admin", "user"] }
  ]
}
```

### Inferences
- Wildcard redirect URIs such as `https://localhost:*/*` matter if the testing host randomizes the web app's port. Whether Keycloak accepts a port wildcard in this form is unverified. `http://localhost/*` plus the exact port, injected through a `${...}` placeholder, is the documented-safe alternative.
- Declaring a user without `firstName`/`lastName`/`email` may trigger Keycloak 24+'s "update profile" required action at first browser login, which breaks unattended Playwright sign-in. This comes from my own recollection of Keycloak's declarative user profile, not a source fetched this session, so verify it.
- Inline `users` in the realm file: the import doc's naming rules cover separate user files, and the community realm files above use inline users. The doc page I read does not explicitly confirm that startup import reads users from the realm file.

### Gaps
- Microsoft does not publish an official Aspire sample realm JSON for test users.

## 3. Programmatic token acquisition in tests

### Takeaway
POST form data to `{keycloak}/realms/{realm}/protocol/openid-connect/token`. Three grants fit tests. `grant_type=password` works on a client with Direct Access Grants enabled, and Keycloak says the flow "MUST NOT be used", so keep it test-only. `grant_type=client_credentials` works on a confidential client with service accounts enabled. Standard Token Exchange V2 (`urn:ietf:params:oauth:grant-type:token-exchange`) is enabled by default and works on confidential clients, but it cannot impersonate a user.

### Cited Findings
- Token endpoint: `/realms/{realm-name}/protocol/openid-connect/token`. Discovery: `/realms/{realm-name}/.well-known/openid-configuration`. [Keycloak OIDC layers](https://www.keycloak.org/securing-apps/oidc-layers)
- Direct Grant (ROPC): "the client has to have the `Direct Access Grants Enabled` option enabled". Keycloak says the flow "MUST NOT be used" and notes it is removed from OAuth 2.1. It also skips identity brokering and social login. [Keycloak OIDC layers](https://www.keycloak.org/securing-apps/oidc-layers)
- Keycloak's curl example sends `client_id=myclient`, `client_secret=...`, `username=user`, `password=password` and `grant_type=password` to `http://localhost:8080/realms/master/protocol/openid-connect/token`. [Keycloak OIDC layers](https://www.keycloak.org/securing-apps/oidc-layers)
- Client Credentials is for clients acting on their own behalf. Clients authenticate with a secret or with public/private keys. [Keycloak OIDC layers](https://www.keycloak.org/securing-apps/oidc-layers)
- Standard Token Exchange V2 is "fully supported" and "enabled by default". Enable it with the client's **Standard token exchange** switch. The requester must be confidential, and public clients cannot exchange. Parameters: `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, `subject_token`, `subject_token_type=urn:ietf:params:oauth:token-type:access_token` (the only type supported), and optionally `requested_token_type`, `audience` and `scope`. The subject token's `aud` must include the requester. Impersonation is "Not implemented yet" in V2 and exists only in legacy V1 preview. [Keycloak token exchange](https://www.keycloak.org/securing-apps/token-exchange)

Illustrative C# for an xUnit test against `Aspire.Hosting.Testing`. I composed it from the cited endpoint and parameters and did not compile it.
```csharp
var appHost = await DistributedApplicationTestingBuilder.CreateAsync<Projects.AppHost>();
await using var app = await appHost.BuildAsync();
await app.StartAsync();
await app.ResourceNotifications.WaitForResourceHealthyAsync("keycloak")
    .WaitAsync(TimeSpan.FromMinutes(3));

var kc = app.GetEndpoint("keycloak", "http");      // scheme may be https under 13.3+ auto-HTTPS
using var http = new HttpClient { BaseAddress = kc };
var resp = await http.PostAsync("/realms/app/protocol/openid-connect/token",
    new FormUrlEncodedContent(new Dictionary<string, string> {
        ["grant_type"] = "password",           // or "client_credentials" (omit username/password)
        ["client_id"] = "web",
        ["client_secret"] = "web-secret",
        ["username"] = "alice",
        ["password"] = "Passw0rd!",
        ["scope"] = "openid"
    }));
resp.EnsureSuccessStatusCode();
var token = (await resp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("access_token").GetString();

var api = app.CreateHttpClient("api");
api.DefaultRequestHeaders.Authorization = new("Bearer", token);
```

### Inferences
- ROPC is the simplest way for tests to act as a user against a JwtBearer API. Enable `directAccessGrantsEnabled` only in the test realm file, and keep production clients on authorization code.
- Client credentials tokens represent the client's service account and carry no end-user claims. They fit machine-to-machine API tests, not per-user authorization tests.

### Gaps
- I did not verify the exact Keycloak release in which Standard Token Exchange V2 became GA.

## 4. Browser sign-in via Playwright and reusing storageState

### Takeaway
No official Aspire or Keycloak Playwright guide exists. The standard pattern is to sign in once through the Keycloak login form, save `context.StorageStateAsync(Path=...)`, and start later contexts with `StorageStatePath`. The cookie is bound to the Keycloak authority URL, port included, so stable ports matter.

### Cited Findings
- Playwright .NET saves state with `await context.StorageStateAsync(new(){ Path = "../../../playwright/.auth/state.json" });` and reuses it with `browser.NewContextAsync(new(){ StorageStatePath = "../../../playwright/.auth/state.json" })`. The `../../../` climbs out of the bin folder. [Playwright .NET auth](https://playwright.dev/dotnet/docs/auth)
- Playwright persists no session storage, and IndexedDB is excluded by default. The state file holds live credentials, so add `playwright/.auth` to `.gitignore`. [Playwright .NET auth](https://playwright.dev/dotnet/docs/auth)
- The community pattern: sign in once in a setup project, save cookies and localStorage, and start every later test authenticated, against Keycloak specifically. [montelli.dev Playwright + Keycloak](https://montelli.dev/en/blog/verificare/testing/08-authentication-testing/)
- A real project centralizes Keycloak sign-in in one shared helper, `tests/e2e/keycloak.ts`, rather than having specs fill `#username`/`#password`. [phuongnse/axis Issue #1898](https://github.com/phuongnse/axis/issues/1898)
- Aspire docs: cookies holding OIDC tokens depend on the authority URL including the port, hence the fixed-port recommendation. [aspire.dev Keycloak integration](https://aspire.dev/integrations/security/keycloak/)
- Aspire has a known issue where debugging e2e `DistributedApplicationTestingBuilder` tests with Blazor Web (wasm) spins up multiple browsers and times out. [Issue #11711](https://github.com/microsoft/aspire/issues/11711)

Illustrative C# (`Microsoft.Playwright`). I composed it and did not run it. The Keycloak default login form uses `#username`, `#password` and `#kc-login`, per the selectors the axis issue cites. `#kc-login` is my recollection of the default theme.
```csharp
var page = await context.NewPageAsync();
await page.GotoAsync(webUrl + "/login");            // app redirects to Keycloak
await page.FillAsync("#username", "alice");
await page.FillAsync("#password", "Passw0rd!");
await page.ClickAsync("#kc-login");
await page.WaitForURLAsync(webUrl + "/**");
await context.StorageStateAsync(new() { Path = statePath });
```

### Inferences
- A saved storageState becomes invalid whenever the Keycloak container is recreated, which happens every run without a data volume, because the session it references no longer exists. The app's own cookie may outlive it until expiry. In practice, regenerate the state once per test-session fixture rather than committing it.
- A faster alternative that skips the Keycloak UI: get tokens via ROPC (section 3) and inject them, which only works if the app accepts bearer tokens. A cookie-based OIDC web app needs the real browser flow.

### Gaps
- I found no maintained .NET sample repo combining `Aspire.Hosting.Testing`, Keycloak and Playwright.

## 5. Running under `Aspire.Hosting.Testing`: startup, WaitFor, issuer, HTTPS, known issues

### Takeaway
Plan for 20-30 s of Keycloak startup in a minimal AppHost and minutes in a large one. Gate on `WaitForResourceHealthyAsync("keycloak")` with a generous timeout. On Aspire 13.3+, decide explicitly on HTTPS: `.WithoutHttpsCertificate()` is the documented opt-out from auto-HTTPS, which has caused TLS failures in the testing host. Issuer mismatches arise when the browser or test runner and the API reach Keycloak by different hostnames. Pinning `KC_HOSTNAME` to a full URL makes the issuer constant.

### Cited Findings

**Startup time**
- An open issue reports Keycloak taking 23 s in an empty AppHost but more than 3 min in CI and about 2 min locally in a large AppHost (Aspire 13.5.3, macOS arm64), even with the image pre-pulled. Triage put it in the backlog with no milestone. [Issue #19858](https://github.com/microsoft/aspire/issues/19858)
- A project on Aspire 13.5.4 saw Keycloak start in about 30 s under `DistributedApplicationTestingBuilder` but never report Healthy. [mpcs2013/decisya Issue #70](https://github.com/mpcs2013/decisya/issues/70)
- Keycloak says plain `start` without a pre-built image "significantly increases startup time", and that running `kc.sh build` at image build and then `start --optimized` saves time on every start. [Keycloak containers guide](https://www.keycloak.org/server/containers)

**Health and WaitFor**
- The health check is `/health/ready` on the `management` endpoint (port 9000). [KeycloakResourceBuilderExtensions.cs](https://raw.githubusercontent.com/microsoft/aspire/main/src/Aspire.Hosting.Keycloak/KeycloakResourceBuilderExtensions.cs)
- In Aspire 13.3, Keycloak with `.WaitFor(mailpit)` stayed in "Waiting" forever. This was fixed via [PR #16988](https://github.com/microsoft/aspire/pull/16988) and [PR #16993](https://github.com/microsoft/aspire/pull/16993), and is the same root cause as [Issue #16897](https://github.com/microsoft/aspire/issues/16897). [Issue #17052](https://github.com/microsoft/aspire/issues/17052)
- In 13.3.5, Keycloak failed to start with "One or more container network tunnel proxies did not start successfully: 'aspire-container-network-tunnelproxy'" (closed). [Issue #17383](https://github.com/microsoft/aspire/issues/17383)
- `ContainerLifetime.Persistent` stopped working for Keycloak from 13.3.0 through 13.4.2: the container was recreated every run because the OTLP tunnel port changed the env var. A DCP fix landed in main ([microsoft/dcp Issue #180](https://github.com/microsoft/dcp/issues/180)). [Issue #17966](https://github.com/microsoft/aspire/issues/17966)
- Disposing `DistributedApplicationTestingBuilder` can take longer than the test itself (closed). [Issue #10280](https://github.com/microsoft/aspire/issues/10280)
- Volume behavior under `Aspire.Hosting.Testing` is not configurable (open feature request). [Issue #4462](https://github.com/microsoft/aspire/issues/4462)

**HTTPS and TLS under the test host**
- Under the testing builder, Keycloak's management interface logged "Management interface listening on https://0.0.0.0:9000" and the health check failed with "The SSL connection could not be established". The suspected cause is Aspire auto-HTTPS (`ASPIRECERTIFICATES001`) switching the management endpoint to HTTPS. `ASPIRE_DEVELOPER_CERTIFICATE_DEFAULT_HTTPS_TERMINATION=false` did not reliably help. The same AppHost reached Healthy under `dotnet run`. [mpcs2013/decisya Issue #70](https://github.com/mpcs2013/decisya/issues/70)
- Intermittent `ERR_SSL_PROTOCOL_ERROR` and `IDX20804: Unable to retrieve document from: 'https://localhost:9080/realms/app/.well-known/openid-configuration'` (13.4.6) traced to two containers sharing a host port. Keycloak's health check and clients hit the other container. The fix was a dedicated port per container. [Issue #18620](https://github.com/microsoft/aspire/issues/18620)
- The opt-out from auto-HTTPS is `.WithoutHttpsCertificate()`. [Issue #17661](https://github.com/microsoft/aspire/issues/17661); [aspire.dev certificate configuration](https://aspire.dev/app-host/certificate-configuration/)

**Issuer and hostname**
- Without `hostname`, Keycloak builds URLs, including the issuer, from the request's Host/X-Forwarded-Host. This requires `hostname-strict=false`, which is the default in `start-dev`. [Keycloak hostname guide](https://www.keycloak.org/server/hostname)
- Setting `hostname` (`KC_HOSTNAME`) to a full URL with `hostname-backchannel-dynamic=false` makes backchannel URLs equal the frontchannel URLs, giving one issuer. `hostname-backchannel-dynamic=true` (`KC_HOSTNAME_BACKCHANNEL_DYNAMIC`) lets apps on a private network use internal backchannel URLs, and it requires a full-URL `hostname`. [Keycloak hostname guide](https://www.keycloak.org/server/hostname)
- Generic Keycloak issuer-mismatch reports. A client called by one scheme/port saw a different issuer in metadata ([keycloak Discussion #16482](https://github.com/keycloak/keycloak/discussions/16482)). Tokens issued via one domain failed on another ([keycloak Issue #11584](https://github.com/keycloak/keycloak/issues/11584)). Vault failed with "issuer did not match the issuer returned by provider" ([hashicorp/vault Issue #25024](https://github.com/hashicorp/vault/issues/25024)).
- An old Aspire issue: an `EndpointReference` always resolves to the container host when evaluated for a container resource. This is the root of "container hostname vs localhost" differences. [Issue #4038](https://github.com/microsoft/aspire/issues/4038)
- In 2024, service discovery endpoints were not injected into services started through the testing builder, which hit an identity-service test. [Issue #4274](https://github.com/microsoft/aspire/issues/4274)

### Inferences
- Project resources (`AddProject`) run on the host and reach Keycloak at `localhost:<port>`. So do the test runner and Playwright. In that topology every party sees the same issuer and no `KC_HOSTNAME` is needed. Mismatch appears when a consumer runs as a container: it reaches Keycloak by container DNS name, so tokens minted via `localhost` fail issuer validation there. That case calls for `KC_HOSTNAME=http://localhost:<port>` plus `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true`, or `TokenValidationParameters.ValidIssuers`.
- A fixed `AddKeycloak("keycloak", 8080)` port helps cookies and issuer stability, but parallel test classes each starting the AppHost will collide on it, as in the [Issue #18620](https://github.com/microsoft/aspire/issues/18620) port race. Share one AppHost per test session through an assembly or collection fixture.
- In tests, `.WithoutHttpsCertificate()` on Keycloak plus `RequireHttpsMetadata = false` in the API's Development config is the lowest-friction setup. It avoids the management-port TLS failure and the `https+http` metadata rule.
- Timeout guidance from the reports above: at least 60 s for a small AppHost, and 3-5 min if Keycloak sits in a large graph in CI.

### Gaps
- No microsoft/aspire issue explicitly reports "invalid issuer" between AppHost and Keycloak. The `gh search issues keycloak --repo microsoft/aspire` results contained none.
- I did not verify whether `DistributedApplicationTestingBuilder` randomizes container host ports by default, which would affect the fixed 8080 and the redirect URIs.

## 6. linux/arm64 image support

### Takeaway
Yes. Every recent Keycloak tag, including the 26.8.x line and `latest`, is a multi-arch manifest list covering amd64, arm64 and ppc64le, so it runs natively on the ARM64 machine.

### Cited Findings
- On quay.io, `latest`, `26.8`, `26.8.2`, `26.8.2-0` and `nightly` (updated 2026-11-05) are all `is_manifest_list: true`. [quay.io tag API](https://quay.io/api/v1/repository/keycloak/keycloak/tag/?limit=5&onlyActiveTags=true)
- The Docker Hub mirror `keycloak/keycloak` lists amd64, ppc64le and arm64 for `latest`, `26.8`, `26.8.2`, `26.8.1`, `26.8.1-0` through `-2`, `26.8.0-1` and `nightly`. [Docker Hub tag API](https://hub.docker.com/v2/repositories/keycloak/keycloak/tags?page_size=10)
- An Aspire user ran Keycloak through Aspire on macOS with `.NET 10.0.203 installed (arm64)` and saw a 23 s startup in a minimal AppHost. [Issue #19858](https://github.com/microsoft/aspire/issues/19858)

### Inferences
- The Aspire pin is `26.6` ([source](https://raw.githubusercontent.com/microsoft/aspire/main/src/Aspire.Hosting.Keycloak/KeycloakContainerImageTags.cs)). I only checked arm64 for 26.8.x tags directly, but the line has been multi-arch throughout, so 26.6 is very likely arm64 too.

### Gaps
- I did not fetch the `26.6` tag's manifest specifically. `docker manifest inspect quay.io/keycloak/keycloak:26.6` would confirm it.

## 7. Known pain points

### Takeaway
The main costs: slow and variable startup (JVM, plus Aspire orchestration in large graphs), a 2 GB memory recommendation, realm import skipped once a realm exists (a trap with data volumes), Aspire 13.3+ auto-HTTPS surprises, and issuer mismatch when consumers reach Keycloak by different hostnames.

### Cited Findings
- **Startup.** 23 s minimal versus 2-3+ min in a large AppHost on Aspire 13.5.3. [Issue #19858](https://github.com/microsoft/aspire/issues/19858) Keycloak's advice is to pre-build an optimized image (`kc.sh build`, then `start --optimized`). [Keycloak containers guide](https://www.keycloak.org/server/containers)
- **Memory.** By default the heap is `-XX:MaxRAMPercentage=70` and `-XX:InitialRAMPercentage=50` of container memory, overridable with `JAVA_OPTS_KC_HEAP`. "For smaller production-ready deployments, the recommended memory limit is 2 GB." Always set a limit, or "the memory consumption rapidly increases." [Keycloak containers guide](https://www.keycloak.org/server/containers)
- **Dev mode.** `start-dev`, which Aspire uses in run mode, "has insecure defaults" and must be "strictly avoided in production". [Keycloak containers guide](https://www.keycloak.org/server/containers); [KeycloakResourceBuilderExtensions.cs](https://raw.githubusercontent.com/microsoft/aspire/main/src/Aspire.Hosting.Keycloak/KeycloakResourceBuilderExtensions.cs)
- **Realm import.** It is skipped when the realm exists, so edits to the JSON have no effect while `WithDataVolume` keeps old state. File naming is strict. [Keycloak import/export](https://www.keycloak.org/server/importExport)
- **Data volume credentials.** Admin credentials stick in the volume. [aspire.dev Keycloak integration](https://aspire.dev/integrations/security/keycloak/)
- **Publish/deploy.** `WithRealmImport` is unsupported by `aspire publish`/`deploy`. [aspire.dev Keycloak integration](https://aspire.dev/integrations/security/keycloak/) Keycloak failing to start in Azure Container Apps is an open issue. [Issue #6004](https://github.com/microsoft/aspire/issues/6004)
- **Auto-HTTPS.** Since 13.3 the http endpoint serves HTTPS ([Issue #17661](https://github.com/microsoft/aspire/issues/17661)), and the health check fails TLS under the test host ([decisya Issue #70](https://github.com/mpcs2013/decisya/issues/70)).
- **Health-check path.** It is not relative-path aware, which breaks a Keycloak configured with a context path (open). [Issue #14343](https://github.com/microsoft/aspire/issues/14343)
- **Telemetry.** OTLP export is not on by default (open request). [Issue #20276](https://github.com/microsoft/aspire/issues/20276)
- **Issuer.** Dynamic, request-based issuer in dev mode versus fixed `KC_HOSTNAME`. [Keycloak hostname guide](https://www.keycloak.org/server/hostname)

### Inferences
- For the test suite, run Keycloak without a data volume (fresh realm per run), use `.WithoutHttpsCertificate()`, start one shared AppHost per test session, and pre-pull the image in CI. A custom `WithDockerfile` image with `kc.sh build` would cut start time, but Aspire's `start-dev` args mean this needs checking against how `AddKeycloak` sets args.

### Gaps
- I found no published memory figures for Keycloak in `start-dev` under Aspire specifically, only Keycloak's general 2 GB guidance.
