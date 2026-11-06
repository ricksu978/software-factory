# Mock and lightweight OAuth2/OIDC providers for .NET Aspire apps and self-signing e2e tests

Research date 2026-11-06. Repo stats, release dates and NuGet versions came from live queries that day: `gh api repos/<owner>/<repo>` and `/releases`, the NuGet registration API, and `docker manifest inspect <image>:latest` run on the user's machine. Each finding links the public page that matches the query.

Candidates covered: navikt/mock-oauth2-server, Soluto/oidc-server-mock, 0factor (`ZeroFactor.Aspire.Hosting`, found during research), Duende IdentityServer as an Aspire project, OpenIddict as an Aspire project, `dotnet user-jwts`, `WireMock.Net` (`WireMock.Net.Aspire`), the in-process `MockOpenIdAuthority` pattern from the Aspire repo, plus Keycloak/Zitadel/Logto integrations for comparison.

## Which candidates have a ready Aspire hosting integration, with exact package names and versions?

### Takeaway
Only one purpose-built mock IdP has an Aspire hosting package: `ZeroFactor.Aspire.Hosting` 0.1.8 (MIT, 2026-10-21). It runs a Keycloak-compatible mock container. navikt and Soluto have no Aspire package and need plain `AddContainer`. Duende and OpenIddict run as `AddProject` in the solution. CommunityToolkit has no mock-IdP integration. It has real-IdP integrations for Keycloak extensions, Zitadel and Logto.

### Cited findings
- `ZeroFactor.Aspire.Hosting` latest is 0.1.8, published 2026-10-21, MIT, 905 total downloads. It targets .NET 10 and needs `Aspire.Hosting` >= 13.4.6 ([NuGet](https://www.nuget.org/packages/zerofactor.aspire.hosting)).
- 0factor runs the container image `docker.io/c4l3b/0factor:<package version>`. The package page says "Never use 0factor in production" ([NuGet](https://www.nuget.org/packages/zerofactor.aspire.hosting)).
- 0factor's README AppHost snippet ([GitHub c4l3b/0factor](https://github.com/c4l3b/0factor)):
  ```csharp
  var auth = builder.AddZeroFactor("auth")
      .WithDataVolume();

  builder.AddProject<Projects.Web>("web")
      .WithReference(auth, realm: "myapp")
      .WaitFor(auth);
  ```
  The NuGet page also shows `.WithRealmImport("./Realms")`. It says "URLs, discovery, tokens and realm import are Keycloak-compatible", and apps can keep the official `Aspire.Keycloak.Authentication` client package unchanged ([NuGet](https://www.nuget.org/packages/zerofactor.aspire.hosting)).
- Without an explicit `port`, 0factor derives the host port from the AppHost path and resource name, in the range 20000 to 29999. It serves HTTPS by default when Aspire has a trusted ASP.NET Core dev certificate. Aspire integration tests keep the port, and `isProxied: true` allocates a new port per run ([NuGet](https://www.nuget.org/packages/zerofactor.aspire.hosting)).
- The CommunityToolkit/Aspire README lists 62 hosting integrations. The identity-related ones are `CommunityToolkit.Aspire.Hosting.Keycloak.Extensions`, `CommunityToolkit.Aspire.Hosting.Logto` and `CommunityToolkit.Aspire.Hosting.Zitadel`. None is an OIDC mock, Duende, OpenIddict, WireMock or Authentik integration ([GitHub CommunityToolkit/Aspire](https://github.com/CommunityToolkit/Aspire)).
- NuGet versions on 2026-11-06:
  - `CommunityToolkit.Aspire.Hosting.Zitadel` 13.6.1 (2026-10-26) ([NuGet](https://www.nuget.org/packages/communitytoolkit.aspire.hosting.zitadel))
  - `CommunityToolkit.Aspire.Hosting.Logto` 13.6.1 (2026-10-26) ([NuGet](https://www.nuget.org/packages/communitytoolkit.aspire.hosting.logto))
  - `CommunityToolkit.Aspire.Hosting.Keycloak.Extensions` 17.0.0-beta.1009 (2026-11-05), prerelease only ([NuGet](https://www.nuget.org/packages/communitytoolkit.aspire.hosting.keycloak.extensions))
- The official `Aspire.Hosting.Keycloak` and `Aspire.Keycloak.Authentication` are still prerelease at 13.6.4-preview.1.26523.11 (2026-10-24), while `Aspire.Hosting.Testing` is stable at 13.6.4 ([NuGet Keycloak hosting](https://www.nuget.org/packages/aspire.hosting.keycloak), [NuGet Testing](https://www.nuget.org/packages/aspire.hosting.testing)).
- `WireMock.Net.Aspire` 2.21.0 was published 2026-10-28 ([NuGet](https://www.nuget.org/packages/wiremock.net.aspire)). The `WireMock.Net` wiki points to separate docs for the Aspire integration and says nothing about OAuth, OIDC or JWT (wiki page `https://github.com/wiremock/wiremock.net/wiki/Using-WireMock.Net.Aspire`).
- Duende's official samples run IdentityServer as a plain Aspire project, for example `builder.AddProject<Projects.IdentityServerHost>("identityserverhost")` with a custom `WithCommand("seed", ...)` dashboard command that runs `dotnet run -- /seed` (`https://github.com/DuendeSoftware/samples/blob/97ae83f3b6c08059c70c386194e39f628b8e6e06/IdentityServer/v8/UserInteraction/DynamicProviders/IdentityServer.AppHost/AppHost.cs`). The same repo has v8 AppHosts for CIBA and an MCP demo (`https://github.com/DuendeSoftware/samples/blob/97ae83f3b6c08059c70c386194e39f628b8e6e06/IdentityServer/v8/UserInteraction/Ciba/IdentityServer.AppHost/AppHost.cs`, `https://github.com/DuendeSoftware/samples/blob/97ae83f3b6c08059c70c386194e39f628b8e6e06/IdentityServer/v8/McpDemo/McpDemo.AppHost/AppHost.cs`).
- OpenIddict's official samples include an Aspire AppHost, "Geonosis", with three plain projects (`https://github.com/openiddict/openiddict-samples/blob/c706392545121516f05ee27b02d734fb3a6db4b1/samples/Geonosis/Geonosis.AppHost/AppHost.cs`):
  ```csharp
  var server = builder.AddProject<Projects.Geonosis_Auth>("geonosis-auth");
  var resource = builder.AddProject<Projects.Geonosis_Api>("geonosis-api").WaitFor(server);
  builder.AddProject<Projects.Geonosis_Ui>("geonosis-ui").WaitFor(server).WaitFor(resource);
  ```
- A search for an Aspire `AddContainer` recipe for navikt/mock-oauth2-server found none. The project describes itself as a server "for JVM tests and Docker Compose" ([search result summary of navikt wiki](https://github.com/navikt/mock-oauth2-server/wiki)).
- Other non-Aspire mocks found in search, not evaluated further: MockServer generates a full mock OIDC provider from one `PUT /mockserver/oidc` call ([MockServer docs](https://mock-server.com/mock_server/mock_openid_connect_provider.html)), and stubIdP ([snap page](https://snapupdates.popey.com/snap/stubidp)).

### Inferences
- An illustrative `AddContainer` for navikt. I wrote it from the README's port, env vars and `/isalive` endpoint, and have not compiled it:
  ```csharp
  var idp = builder.AddContainer("mock-idp", "ghcr.io/navikt/mock-oauth2-server", "6.1.4")
      .WithHttpEndpoint(targetPort: 8080, name: "http")
      .WithEnvironment("JSON_CONFIG", File.ReadAllText("mock-idp.json"))
      .WithHttpHealthCheck("/isalive");

  builder.AddProject<Projects.Web>("web")
      .WithEnvironment("Auth__Authority", ReferenceExpression.Create($"{idp.GetEndpoint("http")}/default"))
      .WaitFor(idp);
  ```
- An illustrative `AddContainer` for Soluto. Env var names are from the README, not compiled:
  ```csharp
  var idp = builder.AddContainer("oidc-mock", "ghcr.io/soluto/oidc-server-mock", "0.12.1")
      .WithHttpEndpoint(targetPort: 8080, name: "http") // container port not verified
      .WithEnvironment("ASPNETCORE_ENVIRONMENT", "Development")
      .WithEnvironment("CLIENTS_CONFIGURATION_INLINE", clientsJson)
      .WithEnvironment("USERS_CONFIGURATION_INLINE", usersJson);
  ```
- Because 0factor speaks Keycloak's URL shape, a team can develop against 0factor and later swap in `Aspire.Hosting.Keycloak` with a one-line AppHost change. The package page makes this claim, and I have not tested it.

### Gaps
- I did not find the exact `AddWireMock(...)` AppHost API on the wiki page I fetched. The docs live at wiremock.org/dotnet, which I did not fetch.
- I found no Microsoft-shipped "dev identity" or "mock auth" Aspire integration released in 2025 to 2026. The CommunityToolkit README and NuGet searches turned up none. This is a negative search result, not proof of absence.
- I did not check Soluto's container listening port. The README examples I read did not state it.

## How does a test get a token, and how does a Playwright test log in, for each candidate?

### Takeaway
All container mocks support headless grants. navikt supports client credentials, password, token exchange, JWT bearer, refresh and auth code with PKCE. 0factor supports password and client credentials, ignores the password, and logs in by email only. Soluto's README shows client credentials, implicit and auth code. For Playwright, navikt and 0factor have a form with one username or email field and no password, so browser login is trivial. Duende and OpenIddict need a login page you build or scaffold. `dotnet user-jwts` and WireMock only help API (bearer) tests, not browser sign-in.

### Cited findings
**navikt/mock-oauth2-server**
- Supported flows are Client Credentials, JWT Bearer (on-behalf-of), Token Exchange, Refresh Token, Resource Owner Password Credentials and Authorization Code with PKCE. The README warns against ROPC because RFC 9700 says it "MUST NOT be used" ([README](https://raw.githubusercontent.com/navikt/mock-oauth2-server/master/README.md)).
- `interactiveLogin` "Enables a login screen on the `/authorize` endpoint". "The standalone server and Docker image enable `interactiveLogin` by default." A custom login page "must contain a form that posts `username` and optionally `claims`" ([README](https://raw.githubusercontent.com/navikt/mock-oauth2-server/master/README.md)).
- Login-page claims can add claims but cannot overwrite claims set by a matching request mapping ([GitHub navikt/mock-oauth2-server](https://github.com/navikt/mock-oauth2-server)).
- Fixed claims per request come from `tokenCallbacks` in `JSON_CONFIG`. A `requestMappings` entry matches a `requestParam` against an exact string, `"*"` or a regex, and `${clientId}` templating is supported ([GitHub navikt/mock-oauth2-server](https://github.com/navikt/mock-oauth2-server)):
  ```json
  { "tokenCallbacks": [ { "issuerId": "issuer1",
      "requestMappings": [ { "requestParam": "code", "match": "*", "claims": { "sub": "user1" } } ] } ] }
  ```
- Discovery for the default issuer is at `http://localhost:8080/default/.well-known/openid-configuration` ([GitHub navikt/mock-oauth2-server](https://github.com/navikt/mock-oauth2-server)).

**0factor**
- Password grant is a POST to `/realms/{realm}/protocol/openid-connect/token` with `grant_type=password`, `client_id`, `username` (the email) and `scope=openid`. "Passwords are ignored". The user must already exist and be enabled ([GitHub c4l3b/0factor](https://github.com/c4l3b/0factor)).
- Client credentials returns a token for `service-account-<client_id>`, with no refresh token. `grant_type=refresh_token` is supported ([GitHub c4l3b/0factor](https://github.com/c4l3b/0factor)).
- Browser login needs only an email, with no password or MFA. A user can pick an existing user or type an email to register. Login and registration need no JavaScript, but `form_post` uses an auto-submit script. The README's "For coding agents" template says to click an existing user and click **Continue** if the auto-submit form stays visible ([GitHub c4l3b/0factor](https://github.com/c4l3b/0factor)).
- The README describes itself as "A mock OIDC provider for local development that coding agents can sign in to" ([GitHub c4l3b/0factor](https://github.com/c4l3b/0factor)).

**Soluto/oidc-server-mock**
- README examples show `implicit`, `client_credentials` and `authorization_code` clients, including an auth-code client with `"RequirePkce": false` and `"RequireClientSecret": false`. The README does not mention the password grant ([GitHub Soluto/oidc-server-mock](https://github.com/Soluto/oidc-server-mock)).
- "Test user configuration is optional (used for implicit flow only)" ([GitHub Soluto/oidc-server-mock](https://github.com/Soluto/oidc-server-mock)).
- It references the IdentityServer4 Quickstart UI, so the login page is a username and password form ([GitHub Soluto/oidc-server-mock](https://github.com/Soluto/oidc-server-mock)).

**Duende IdentityServer as an Aspire project**
- ASP.NET Identity integration plugs in `IResourceOwnerPasswordValidator` "to support the password grant type". A dedicated password grant page exists ([Duende ASP.NET Identity docs](https://docs.duendesoftware.com/identityserver/aspnet-identity/), [password grant docs](https://docs.duendesoftware.com/identityserver/tokens/password-grant/)).

**OpenIddict as an Aspire project**
- "All these flows are supported by both the server and the client stacks", except the legacy implicit `response_type=token`. ROPC "use in new applications is not recommended". Client credentials needs client authentication, so it cannot be used by public clients ([OpenIddict choosing the right flow](https://documentation.openiddict.com/guides/choosing-the-right-flow)).
- Authorization request handling is "implementation-specific", so you write the login and consent UI yourself ([OpenIddict choosing the right flow](https://documentation.openiddict.com/guides/choosing-the-right-flow)).

**`dotnet user-jwts` (no IdP)**
- `dotnet user-jwts create` takes `--name`, `--scope`, `--role`, `--claim name=value`, `--audience`, `--issuer` (default `dotnet-user-jwts`), `--valid-for`, `--expires-on`, `--scheme` (default `Bearer`) and `-o token|json` ([Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/jwt-authn)).
- It stores the signing key through user-secrets in `%APPDATA%\Microsoft\UserSecrets\<guid>\user-jwts.json`. It writes `Authentication:Schemes:Bearer:ValidAudiences` and `ValidIssuer` into `appsettings.Development.json`, and works with `AddAuthentication("Bearer").AddJwtBearer()` ([Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/jwt-authn)).
- From ASP.NET Core 11, `--file app.cs` works for file-based apps ([Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/jwt-authn)).
- Example: `dotnet user-jwts create --name MyTestUser --scope "myapi:secrets"` ([Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/jwt-authn)).

**`WireMock.Net`**
- WireMock.NET "does not help in providing valid and invalid JWTs". You sign tokens yourself, for example with a self-signed cert ([Xebia](https://xebia.com/blog/mock-your-openid-connect-provider/)).
- The usual pattern runs WireMock.NET with SSL, because ASP.NET Core won't call non-HTTPS authority endpoints. You stub `.well-known/openid-configuration` to point at WireMock and use a separate JWT generator ([Hacklines walkthrough](https://hacklines.com/en/editions/334782/click)).

**In-process mock authority (Aspire's own tests)**
- Aspire's dashboard tests use `MockOpenIdAuthority`, "a mock authority (identity provider) that will handle the basics of the protocol, for use in automated tests". It is a Kestrel host on `IPAddress.Loopback` port 0 that serves `.well-known/openid-configuration` with an issuer built from the request `Host` header, plus `/authorize` and `/token`. It signs with `JsonWebTokenHandler` (`https://github.com/microsoft/aspire/blob/main/tests/Aspire.Dashboard.Tests/Integration/MockOpenIdAuthority.cs`).

**Aspire testing constraint**
- `Aspire.Hosting.Testing` runs the AppHost's resources as separate processes, so tests cannot replace DI services such as authentication handlers in the app. Alba's workaround removes the API resource and hosts the API in-process ([Alba Aspire guide](https://jasperfx.github.io/alba/guide/aspire), [aspire.dev testing overview](https://aspire.dev/testing/overview/)).

### Inferences
- Illustrative xUnit token fetch against navikt with `Aspire.Hosting.Testing`. The `/default/token` path follows the README's per-issuer endpoint rule. Not compiled:
  ```csharp
  var app = await (await DistributedApplicationTestingBuilder.CreateAsync<Projects.AppHost>()).BuildAsync();
  await app.StartAsync();
  var idp = app.CreateHttpClient("mock-idp", "http");
  var res = await idp.PostAsync("/default/token", new FormUrlEncodedContent(new Dictionary<string, string> {
      ["grant_type"] = "client_credentials", ["client_id"] = "e2e", ["client_secret"] = "x", ["scope"] = "api" }));
  var token = JsonDocument.Parse(await res.Content.ReadAsStringAsync()).RootElement.GetProperty("access_token").GetString();
  ```
- Illustrative Playwright login against navikt's default page. Field names come from the README's `username`/`claims` contract. The CSS selectors and submit button are guesses:
  ```csharp
  await page.GotoAsync(webUrl + "/signin");            // app redirects to /default/authorize
  await page.FillAsync("input[name=username]", "alice");
  await page.FillAsync("textarea[name=claims]", "{\"roles\":[\"admin\"]}");
  await page.ClickAsync("input[type=submit]");
  ```
- Illustrative 0factor password-grant token for API tests. Endpoint and params are from the README. The realm, client and user must exist in the imported realm JSON:
  ```csharp
  var res = await http.PostAsync($"{authUrl}/realms/myapp/protocol/openid-connect/token",
      new FormUrlEncodedContent(new Dictionary<string, string> {
          ["grant_type"] = "password", ["client_id"] = "web", ["username"] = "alice@example.com", ["scope"] = "openid" }));
  ```
- For Duende and OpenIddict, the cheapest test login is a ROPC- or client-credentials-enabled test client registered only in a test or Development environment. Browser tests still drive whatever login page you scaffold. Inference from the flow support above.
- `dotnet user-jwts` signs tokens with a key stored in the developer's user profile. That key does not exist on CI agents or inside containers unless you copy it there, so it suits local manual API calls more than automated e2e. Inference from the storage location above.

### Gaps
- I could not confirm that navikt's default login page accepts any username without validation, or that it accepts any `client_id`/`client_secret`. The README describes the form contract but says neither ([README](https://raw.githubusercontent.com/navikt/mock-oauth2-server/master/README.md)).
- I did not confirm from a fetched page that Soluto accepts `"AllowedGrantTypes": ["password"]` with seeded users. IdentityServer supports the grant, but Soluto's README says users are "used for implicit flow only".
- I did not fetch Duende's `AddTestUsers`/`TestUser` in-memory store docs. The ASP.NET Identity page does not mention them ([Duende docs](https://docs.duendesoftware.com/identityserver/aspnet-identity/)). Treat the API names as unverified.
- I did not fetch OpenIddict's `AllowPasswordFlow()`/`AllowClientCredentialsFlow()` option docs. The flow-choice page names no options.

## Does each container image publish a linux/arm64 variant?

### Takeaway
Yes for every container candidate. `docker manifest inspect` on 2026-11-06 showed linux/arm64 for navikt, Soluto (ghcr), 0factor, `WireMock.Net` (both tags), WireMock Java and Keycloak. The one surprise is the Docker Hub `soluto/oidc-server-mock`, which returned no manifest. Use the ghcr image.

### Cited findings
- `ghcr.io/navikt/mock-oauth2-server:latest` has linux/amd64 and linux/arm64 ([ghcr package](https://github.com/navikt/mock-oauth2-server/pkgs/container/mock-oauth2-server)). Tags exist per exact version and per major/minor stream ([navikt wiki via search](https://github.com/navikt/mock-oauth2-server/wiki)).
- `ghcr.io/soluto/oidc-server-mock:latest` has linux/amd64 and linux/arm64 ([ghcr package](https://github.com/Soluto/oidc-server-mock/pkgs/container/oidc-server-mock)).
- `soluto/oidc-server-mock:latest` on Docker Hub returned no architectures from `docker manifest inspect` ([Docker Hub](https://hub.docker.com/r/soluto/oidc-server-mock)). The README only references the ghcr image ([GitHub Soluto/oidc-server-mock](https://github.com/Soluto/oidc-server-mock)).
- `c4l3b/0factor:latest` has amd64 and arm64 ([Docker Hub](https://hub.docker.com/r/c4l3b/0factor)). The image runs as non-root UID 1654 ([GitHub c4l3b/0factor](https://github.com/c4l3b/0factor)).
- `sheyenrath/wiremock.net:latest` has linux/amd64, linux/arm64 and linux/arm. `sheyenrath/wiremock.net-alpine:latest` has amd64 and arm64 ([Docker Hub sheyenrath](https://hub.docker.com/r/sheyenrath/wiremock.net)).
- `wiremock/wiremock:latest` has amd64, arm64 and arm ([Docker Hub](https://hub.docker.com/r/wiremock/wiremock)).
- `quay.io/keycloak/keycloak:latest` has amd64, arm64 and ppc64le ([quay.io](https://quay.io/repository/keycloak/keycloak)).

### Inferences
- Duende, OpenIddict, `user-jwts` and the in-process `MockOpenIdAuthority` run as .NET projects under `AddProject`, so they need no container image and run natively on ARM64. Inference from the AppHost samples above.
- I checked only `:latest`. A pinned older tag may lack arm64, so re-run `docker manifest inspect` for the exact tag you pin.

### Gaps
- I did not check Soluto's pinned tag `0.12.1` or navikt `6.1.4` individually.

## Issuer and discovery behavior in containers vs localhost under Aspire

### Takeaway
Every container mock here builds `iss` from the host the caller used, or from a fixed localhost base. Under Aspire the browser reaches the IdP through a localhost host port. A backend in another container reaches it by container name. Those two can disagree, which breaks issuer validation. Running every consumer as a host process (`AddProject`) avoids the mismatch. 0factor's Aspire package handles it with stable host ports and `WithReference(auth, realm:)`.

### Cited findings
- navikt: "The `iss` claim is built from the host used to call the server. Your app and whoever fetches the token must use the same host" ([README](https://raw.githubusercontent.com/navikt/mock-oauth2-server/master/README.md)).
- navikt's Compose fix: "Set `hostname: host.docker.internal` on the mock server service". Issuer URLs "must be resolvable both from inside Docker and from your browser". `SERVER_HOSTNAME` is the bind address, not the issuer host ([README](https://raw.githubusercontent.com/navikt/mock-oauth2-server/master/README.md)).
- navikt treats the first URL path segment as the issuer ID, so `/issuer-a/...` is issuer `issuer-a`, each with its own discovery, token endpoint and JWKS, with no config needed ([GitHub navikt/mock-oauth2-server](https://github.com/navikt/mock-oauth2-server)).
- 0factor's issuer is Keycloak-style `http://localhost:8080/realms/{realm}`, with discovery at `/realms/{realm}/.well-known/openid-configuration` and a health check at `/health` ([GitHub c4l3b/0factor](https://github.com/c4l3b/0factor)).
- 0factor's Aspire package pins a deterministic host port (20000 to 29999), and Aspire integration tests keep that port ([NuGet](https://www.nuget.org/packages/zerofactor.aspire.hosting)). It requires Aspire 13.4.6+ "for issuer references and integration tests" ([GitHub c4l3b/0factor](https://github.com/c4l3b/0factor)).
- Aspire's `MockOpenIdAuthority` computes the issuer from `request.IsHttps` and the `Host` header on each discovery call (`https://github.com/microsoft/aspire/blob/main/tests/Aspire.Dashboard.Tests/Integration/MockOpenIdAuthority.cs`).
- ASP.NET Core won't call authority endpoints over plain HTTP by default, which forces WireMock to run with SSL ([Hacklines](https://hacklines.com/en/editions/334782/click)). 0factor serves HTTPS automatically when Aspire has a trusted dev cert ([NuGet](https://www.nuget.org/packages/zerofactor.aspire.hosting)).

### Inferences
- With navikt or Soluto under `AddContainer`, set `RequireHttpsMetadata = false` on the app's JwtBearer/OIDC options in Development, since those images serve HTTP by default. Point the app at the endpoint Aspire exposes on localhost so the browser and the server-side app see the same issuer. Inference from the README issuer rule and the HTTPS metadata default above.
- If the API also runs as a container, the Host-header issuer differs between browser and API calls. Relaxing `ValidIssuers`, or pinning the issuer in navikt's config, are the likely fixes. I did not verify either.

### Gaps
- I did not confirm whether navikt honors `X-Forwarded-Host`, or whether a JSON config key pins the issuer URL. The README is silent on forwarded headers.
- I did not research Soluto's issuer behavior. IdentityServer's `IssuerUri` option is likely settable through `SERVER_OPTIONS_INLINE`, but that is unchecked.

## Seeding users and claims, license, and startup speed

### Takeaway
navikt seeds claims through JSON request mappings, or through the login form's claims field at sign-in, rather than through users. Soluto and 0factor seed declared users and clients from JSON. Duende and OpenIddict seed in C#. All mocks are MIT or Apache-2.0. Duende is commercial but free for dev and test, and v8 has no request limit without a key. No project publishes startup-time numbers.

### Cited findings
- Soluto seeds via env vars `SERVER_OPTIONS_INLINE`, `LOGIN_OPTIONS_INLINE`, `LOGOUT_OPTIONS_INLINE`, `API_SCOPES_INLINE`, `USERS_CONFIGURATION_INLINE`, `CLIENTS_CONFIGURATION_INLINE`, `API_RESOURCES_INLINE` and `IDENTITY_RESOURCES_INLINE`, or `_PATH` variants for files, in JSON or YAML. Clients are required. A user has `SubjectId`, `Username`, `Password` and `Claims[]` of `Type`/`Value`/`ValueType`. The example user is `"SubjectId":"1","Username":"User1","Password":"pwd"` ([GitHub Soluto/oidc-server-mock](https://github.com/Soluto/oidc-server-mock)).
- Soluto is Apache-2.0 and says "For production you need to purchase Duende IdentityServer license" ([GitHub Soluto/oidc-server-mock](https://github.com/Soluto/oidc-server-mock)).
- 0factor seeds via `realms/*.json`, mounted at `/opt/keycloak/data/import` or added with `.WithRealmImport("./realms")`. Files load in filename order after `0factor.json`. Top-level fields are `realm`, `registrationAllowed`, `lenient`, `clients` and `users`. User fields include `username`, `email`, `firstName`, `lastName`, `realmRoles`, `clientRoles` and `claims`. Imports replace the client list and matching user values on each restart ([GitHub c4l3b/0factor](https://github.com/c4l3b/0factor)).
- navikt's env vars are `SERVER_PORT`/`PORT` (default 8080), `JSON_CONFIG` (takes precedence over `JSON_CONFIG_PATH`), `LOG_LEVEL`, `SERVER_HOSTNAME` and `LOGBACK_CONFIG`. It is MIT ([GitHub navikt/mock-oauth2-server](https://github.com/navikt/mock-oauth2-server)).
- Duende v8 without a license: "There is no request limit and no automatic shutdown." "All features remain available." It logs "{FeatureName} is being used but no Duende license is configured", rate-limited to once per five minutes per feature. "IdentityServer is free for development, testing and personal projects" ([Duende trial mode docs](https://docs.duendesoftware.com/trial-mode)).
- Duende v7 differs. Trial Mode had a 500 protocol request limit that "is not currently being enforced", and some features were disabled at runtime. v8 logs warnings instead ([Duende trial mode docs](https://docs.duendesoftware.com/trial-mode)). A GitHub discussion reports trial-mode error logs on v7.8.3 with 50+ clients ([Duende discussion #557](https://github.com/orgs/DuendeSoftware/discussions/557)).
- Duende Community Edition requires "less than $1M USD projected annual gross revenue" and "less than $3M USD in capital", or a non-profit budget under $1M. "You do not need a license for evaluation, development, test environments, or personal projects" ([Duende Community Edition](https://duendesoftware.com/products/communityedition)).
- `Duende.IdentityServer` latest is 8.0.10, published 2026-10-15 ([NuGet](https://www.nuget.org/packages/duende.identityserver)).
- OpenIddict is Apache-2.0. `OpenIddict.AspNetCore` latest stable is 7.8.0 (2026-11-03), with 8.0.0-preview.5 released the same day ([GitHub openiddict-core](https://github.com/openiddict/openiddict-core), [NuGet](https://www.nuget.org/packages/openiddict.aspnetcore)).
- `WireMock.Net` is Apache-2.0 ([GitHub wiremock.net](https://github.com/wiremock/wiremock.net)).
- Startup readiness: navikt `GET /isalive` returns 200 when ready, with no timing stated ([GitHub navikt/mock-oauth2-server](https://github.com/navikt/mock-oauth2-server)). 0factor states no startup time ([GitHub c4l3b/0factor](https://github.com/c4l3b/0factor)).
- Starting an Aspire distributed app is expensive, so TUnit recommends a shared fixture that starts the AppHost once ([TUnit Aspire docs](https://tunit.dev/docs/examples/aspire)).

### Inferences
- The in-process `MockOpenIdAuthority` and `user-jwts` have no container pull or IdP boot, so they should start fastest. navikt is JVM-based ("JVM tests"), so it likely starts slower than a .NET or Go mock. Neither claim is measured.
- Duende v8 is free in a test project, and its warning is only a log line. The license risk exists only if the same project ships to production at a company above the Community thresholds.

### Gaps
- No vendor or blog benchmark of cold-start time for any candidate turned up. Measuring `docker run` to the first 200 from `/isalive` or `/health` on the ARM64 machine would answer it.
- I did not determine the language or runtime of 0factor's server. The repo is .NET-based (`.slnx`, `global.json`), but the README does not say what the server image runs on ([GitHub c4l3b/0factor](https://github.com/c4l3b/0factor)).

## Maintenance health as of 2026-11-06

### Takeaway
navikt (6.1.4, 2026-10-28), OpenIddict (7.8.0, 2026-11-03), Duende (8.0.10, 2026-10-15) and `WireMock.Net` (2.21.0, 2026-10-28) are actively released. 0factor is very new and tiny, with 30 stars and about 900 downloads, so treat it as a single-maintainer risk. Soluto is slowing: its last release is v0.12.1 from 2025-05-04 and its last push was 2026-05-17.

### Cited findings
GitHub API counts for open issues include open PRs.

| Project | Stars | Open issues+PRs | License | Last push | Latest release |
|---|---|---|---|---|---|
| [navikt/mock-oauth2-server](https://github.com/navikt/mock-oauth2-server/releases) | 440 | 16 | MIT | 2026-11-03 | 6.1.4, 2026-10-28 (6.1.0 to 6.1.4 shipped 16 to 28 Oct) |
| [Soluto/oidc-server-mock](https://github.com/Soluto/oidc-server-mock/releases) | 288 | 18 | Apache-2.0 | 2026-05-17 | v0.12.1, 2025-05-04 |
| [c4l3b/0factor](https://github.com/c4l3b/0factor/releases) | 30 | 1 | MIT | 2026-10-21 | v0.1.8, 2026-10-21 |
| [openiddict/openiddict-core](https://github.com/openiddict/openiddict-core/releases) | 5294 | 8 | Apache-2.0 | 2026-11-03 | 7.8.0 and 8.0.0-preview.5, 2026-11-03 |
| [DuendeSoftware/products](https://github.com/DuendeSoftware/products/releases) | 1612 | 0 | NOASSERTION (commercial) | 2026-11-05 | IdentityServer 8.0.10 on NuGet 2026-10-15; bff-4.3.3 2026-11-05 |
| [wiremock/wiremock.net](https://github.com/wiremock/wiremock.net/releases) | 1683 | 20 | Apache-2.0 | 2026-11-01 | 2.21.0, 2026-10-28 |
| [CommunityToolkit/Aspire](https://github.com/CommunityToolkit/Aspire/releases) | 632 | 37 | MIT | 2026-11-05 | v13.6.1, 2026-10-26 |
| [microsoft/aspire](https://github.com/microsoft/aspire/releases) | 6398 | 2472 | MIT | 2026-11-06 | v13.6.4, 2026-10-24 |

- Sample repos are active. [openiddict/openiddict-samples](https://github.com/openiddict/openiddict-samples) has 884 stars and last push 2026-11-02. [DuendeSoftware/samples](https://github.com/DuendeSoftware/samples) has 276 stars and last push 2026-11-02.

### Inferences
- Soluto has gone 18 months without a release and is built on Duende IdentityServer, which needs a commercial production license. That makes it a weaker long-term pick than navikt for a container mock. It still runs on arm64.
- 0factor fits the user's scenario best on paper: an Aspire package, arm64, email-only login aimed at agents, and a Keycloak-compatible path to a real IdP. Its maturity is the main risk.

### Gaps
- I did not check open-issue counts excluding PRs. The navikt page showed 8 issues and 8 PRs ([GitHub navikt/mock-oauth2-server](https://github.com/navikt/mock-oauth2-server)). The others are combined counts from the GitHub API.
- I did not find navikt's Maven Central latest version. The badge did not render, so I used the GitHub release tag.
