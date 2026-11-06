# Test-side sign-in patterns for an Aspire app that uses OAuth/OIDC

Research date 2026-11-06. Citations follow each claim as a link. Code labelled "composed" is my own assembly of documented APIs and was not compiled or run.

## 1. `Aspire.Hosting.Testing`: starting the AppHost, clients, overrides, waits, fixtures, limits

### Takeaway
`DistributedApplicationTestingBuilder` boots the whole AppHost, IdP containers included, as separate processes. Tests reach resources over HTTP through `CreateHttpClient` and change behavior only through args, configuration and `WithEnvironment`, never through DI replacement. The current docs live on aspire.dev and target Aspire 13.6.0.

### Cited Findings
- learn.microsoft.com Aspire testing pages now return 301 to aspire.dev, for example `/dotnet/aspire/testing/write-your-first-test` redirects to `https://aspire.dev/testing/write-your-first-test/`. [learn.microsoft.com redirect](https://learn.microsoft.com/en-us/dotnet/aspire/testing/write-your-first-test)
- The "write your first test" page targets Aspire 13.6.0, released September 29, 2026, and its package references use `Aspire.Hosting.Testing` 13.6.0. [aspire.dev first test](https://aspire.dev/testing/write-your-first-test/)
- Templates exist for three frameworks: `dotnet new aspire-xunit`, `aspire-mstest`, `aspire-nunit`. That page does not mention TUnit. [aspire.dev first test](https://aspire.dev/testing/write-your-first-test/)
- The builder launches the AppHost in a background thread. The docs call it "closed-box integration testing of your entire distributed application", and the AppHost runs every resource as a separate process. [aspire.dev overview](https://aspire.dev/testing/overview/)
- Verbatim limitation: "Aspire testing doesn't enable scenarios for mocking, substituting, or replacing services in dependency injection." The docs point to `WebApplicationFactory<T>` for in-memory, single-project or mocked-dependency tests. [aspire.dev overview](https://aspire.dev/testing/overview/)
- Port randomization is on by default so instances can run concurrently. Turn it off with `"DcpPublisher:RandomizePorts=false"`. The dashboard is off by default, re-enabled with `appOptions.DisableDashboard = false` in the `configureBuilder` callback. [aspire.dev overview](https://aspire.dev/testing/overview/)
- Template flow, verbatim excerpts:
  ```csharp
  var appHost = await DistributedApplicationTestingBuilder
      .CreateAsync<Projects.AspireApp_AppHost>(cancellationToken);
  await using var app = await appHost.BuildAsync(cancellationToken)
      .WaitAsync(DefaultTimeout, cancellationToken);
  await app.StartAsync(cancellationToken)
      .WaitAsync(DefaultTimeout, cancellationToken);
  using var httpClient = app.CreateHttpClient("webfrontend");
  await app.ResourceNotifications.WaitForResourceHealthyAsync(
      "webfrontend", cancellationToken)
  ```
  The template sets `DefaultTimeout = TimeSpan.FromSeconds(30)` and also shows `appHost.Services.ConfigureHttpClientDefaults(c => c.AddStandardResilienceHandler())`. [aspire.dev first test](https://aspire.dev/testing/write-your-first-test/)
- `CreateHttpClient` exists on both `DistributedApplication` and `DistributedApplicationFactory`. It takes a resource name and an optional `endpointName` for resources with several endpoints. `GetConnectionString` returns a resource's connection string. [aspire.dev accessing resources](https://aspire.dev/testing/accessing-resources/)
- `WaitForResourceAsync("webfrontend", KnownResourceStates.Running, ct)` waits only for start. `WaitForResourceHealthyAsync` waits for health checks to pass. Aspire flushes captured resource logs before it publishes `Exited` or `FailedToStart`. `app.ResourceCommands.ExecuteCommandAsync` can run `KnownResourceCommands.StartCommand` for `WithExplicitStart` resources. [aspire.dev accessing resources](https://aspire.dev/testing/accessing-resources/)
- The Keycloak hosting integration adds an HTTP health check against the management endpoint's `/health/ready`, so `WaitForResourceHealthyAsync("keycloak")` has a real readiness signal. [aspire.dev Keycloak](https://aspire.dev/integrations/security/keycloak/)
- Args passed to `CreateAsync` reach the AppHost's `args` and the .NET configuration system, for example `CreateAsync<Projects.MyAppHost>(["--environment=Testing"])` or `"UseVolumes=false"` read via `builder.Configuration.GetValue("UseVolumes", true)`. [aspire.dev manage AppHost](https://aspire.dev/testing/manage-app-host/)
- Per-resource env override from a test, verbatim:
  ```csharp
  appHost.CreateResourceBuilder<ProjectResource>("api")
      .WithEnvironment("FeatureFlags__NewCheckout", "true");
  ```
  [aspire.dev advanced scenarios](https://aspire.dev/testing/advanced-scenarios/)
- Other documented test-time controls are `WithExplicitStart()`, config-gated resources such as `"AddDatabase=false"`, and removing `WaitAnnotation`s before `BuildAsync`. [aspire.dev advanced scenarios](https://aspire.dev/testing/advanced-scenarios/)
- `DistributedApplicationFactory` subclassing exposes `OnBuilderCreating`, `OnBuilderCreated`, `OnBuilding`, `OnBuilt`. `OnBuilderCreating` sets configuration before resources exist, and values set there beat `appsettings.json` and `secrets.json`. [aspire.dev manage AppHost](https://aspire.dev/testing/manage-app-host/)
- Fixture sharing. AppHost creation is costly, so the docs create it once per class: xUnit `IAsyncLifetime`, MSTest static `[ClassInitialize]`/`[ClassCleanup]`, NUnit `[OneTimeSetUp]`/`[OneTimeTearDown]`. Disposing the app cleans up its containers. [aspire.dev manage AppHost](https://aspire.dev/testing/manage-app-host/)
- TUnit ships `TUnit.Aspire` with `AspireFixture<TAppHost>`, shared via `[ClassDataSource<AspireFixture<Projects.MyAppHost>>(Shared = SharedType.PerTestSession)]`. Overridable members include `Args`, `ResourceTimeout`, `WaitBehavior` (`ResourceWaitBehavior.AllRunning`), `ResourcesToWaitFor()` and `ResourcesToRemove()`. `SharedType.Keyed` gives variant fixtures. [tunit.dev Aspire](https://tunit.dev/docs/examples/aspire/)
- File-based AppHosts, an `apphost.cs` with no `.csproj`, cannot be tested with `DistributedApplicationTestingBuilder`. `CreateAsync<T>()` needs a `Projects.*` type, which only a `<ProjectReference>` generates. [aspire.dev advanced scenarios](https://aspire.dev/testing/advanced-scenarios/)
- A community fixture uses a 5-minute timeout, waits for `sql`, `db`, `api`, `web` to be healthy, and shares the app through an xUnit collection fixture. Post dated 4 May 2026, repo `intrepid-developer/aspire-chat-demo`. [intrepid-developer blog](https://intrepid-developer.com/blog/testing-dotnet-with-aspire)

### Inferences
- An IdP container started by the AppHost is just another resource. Wait for its health, then for the app, before requesting tokens. A Keycloak cold start with realm import is slow, so the template's 30 s timeout is likely too short. The community fixture's 5 minutes points the same way.
- Because DI replacement is off the table, every "skip the IdP" trick from section 4 has to be switched on through configuration or env vars the app reads, for example `appHost.CreateResourceBuilder<ProjectResource>("api").WithEnvironment("Auth__Mode", "Test")`. That puts a test-only branch in production code, and the trade-off belongs in the report.
- Keycloak's generated admin password lives under configuration key `Parameters:keycloak-password` ([aspire.dev Keycloak](https://aspire.dev/integrations/security/keycloak/)), and test args feed configuration ([aspire.dev manage AppHost](https://aspire.dev/testing/manage-app-host/)). It follows that `CreateAsync<...>(["Parameters:keycloak-password=TestOnly1!"])` should pin parameters for tests. I did not run it.

### Gaps
- No aspire.dev page I read documents `GetEndpoint(resource, endpointName)` from `Aspire.Hosting.Testing`, which tests would use to get the IdP base URL without an HttpClient. I believe it exists but did not verify it this session.
- I found no GitHub issue that confirms the `Parameters:<name>=value` override form.

## 2. Token acquisition in tests: ROPC, client credentials, standards status, `Duende.IdentityModel`, DelegatingHandler

### Takeaway
RFC 9700 says ROPC "MUST NOT be used" and OAuth 2.1 drops it. Client credentials stays. ROPC still gets used in tests as a test-only client on a test realm, and the notes should present it as a conscious exception, never a pattern to copy into production clients.

### Cited Findings
- RFC 9700 (BCP 240, January 2025) section 2.4, verbatim: "The resource owner password credentials grant [RFC6749] MUST NOT be used." Rationale: it "insecurely exposes the credentials of the resource owner to the client", widens the attack surface even for benign clients, and "is not designed to work with two-factor authentication". It also blocks origin-bound credentials such as WebAuthn. [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html)
- RFC 9700 section 2.5 recommends asymmetric client authentication such as mTLS or `private_key_jwt`, and says authorization servers SHOULD enforce client authentication where feasible. [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html)
- OAuth 2.1 latest draft is draft-ietf-oauth-v2-1-17, dated 31 October 2026, expiring 4 May 2027. Section 1.8 says ROPC is "not specified in OAuth 2.1". Section 4 lists only authorization code, client credentials and refresh token. Section 3.2.1: "Confidential clients MUST authenticate with the authorization server." [IETF datatracker](https://datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/)
- Duende IdentityModel token endpoint extensions on `HttpClient`, verbatim fields:
  ```csharp
  var response = await client.RequestClientCredentialsTokenAsync(new ClientCredentialsTokenRequest
  {
      Address = "https://demo.duendesoftware.com/connect/token",
      ClientId = "client",
      ClientSecret = "secret",
      Scope = "api1"
  });

  var response = await client.RequestPasswordTokenAsync(new PasswordTokenRequest
  {
      Address = "https://demo.duendesoftware.com/connect/token",
      ClientId = "client",
      ClientSecret = "secret",
      Scope = "api1",
      UserName = "bob",
      Password = "bob"
  });
  ```
  [Duende token endpoint docs](https://docs.duendesoftware.com/identitymodel/endpoints/token/)
- Duende's own testing guide references the NuGet package `Duende.IdentityModel` and calls `client.RequestClientCredentialsTokenAsync(new() { Address = "connect/token", ... })` against a `WebApplicationFactory` client. It also uses `GetDiscoveryDocumentAsync()` as a boot check. [Duende IdentityServer testing](https://docs.duendesoftware.com/identityserver/testing/)

Composed sketch, Aspire + Keycloak + password grant, not run:
```csharp
// Realm "api" imported with a test user and a test-only client that has Direct Access Grants enabled.
using var idp = app.CreateHttpClient("keycloak", "http");
var disco = await idp.GetDiscoveryDocumentAsync(new DiscoveryDocumentRequest
{
    Address = "realms/api",
    Policy = { RequireHttps = false } // ponytail: dev-only, Keycloak endpoint is http in Aspire
});
var token = await idp.RequestPasswordTokenAsync(new PasswordTokenRequest
{
    Address = disco.TokenEndpoint,
    ClientId = "tests",
    UserName = "alice",
    Password = "alice",
    Scope = "openid store:all"
});

public sealed class BearerHandler(string token) : DelegatingHandler(new HttpClientHandler())
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage r, CancellationToken ct)
    {
        r.Headers.Authorization = new("Bearer", token);
        return base.SendAsync(r, ct);
    }
}
```

### Inferences
- Client credentials fits service-to-service API tests and stays compliant with OAuth 2.1. It has no user, so it cannot test per-user authorization.
- ROPC is the cheapest way to get a user token in a headless test. RFC 9700's objections target real clients handling real passwords. A dedicated test client on a test realm with seeded users sidesteps most of them, but some IdPs disable it, and it skips the login UI entirely.
- The simplest wiring for an Aspire `CreateHttpClient` client is `client.DefaultRequestHeaders.Authorization = new("Bearer", token.AccessToken)`. A `DelegatingHandler` only pays off when tokens need refresh or per-request selection.

### Gaps
- The Duende token page I read does not state the package rename from `IdentityModel` to `Duende.IdentityModel` or its date. The Duende testing page only confirms the new package name.
- I found no published Aspire sample that acquires a token in a `DistributedApplicationTestingBuilder` test. A search returned none. [nikiforovall Aspire sample](https://nikiforovall.blog/keycloak-authorization-services-dotnet/examples/aspire-web-api.html) only does interactive Swagger UI PKCE.
- I did not verify that `DiscoveryPolicy.RequireHttps` is still the property name in current `Duende.IdentityModel`.

## 3. Playwright for .NET: login once, save storageState, reuse

### Takeaway
Playwright's documented pattern applies to any IdP. Drive the real auth-code login once, save cookies and localStorage with `StorageStateAsync`, and start each later context from that file. With Aspire, the base URL comes from the resource's HttpClient `BaseAddress`.

### Cited Findings
- Save state after a scripted login, verbatim:
  ```csharp
  var page = await context.NewPageAsync();
  await page.GotoAsync("https://github.com/login");
  await page.GetByLabel("Username or email address").FillAsync("username");
  await page.GetByLabel("Password").FillAsync("password");
  await page.GetByRole(AriaRole.Button, new() { Name = "Sign in" }).ClickAsync();
  await context.StorageStateAsync(new()
  {
      Path = "../../../playwright/.auth/state.json"
  });
  ```
  Tests run from `<TestProject>\bin\Debug\netX.0\`, hence the relative path. [Playwright .NET auth](https://playwright.dev/dotnet/docs/auth)
- Reuse it, verbatim: `await browser.NewContextAsync(new() { StorageStatePath = "../../../playwright/.auth/state.json" });` [Playwright .NET auth](https://playwright.dev/dotnet/docs/auth)
- Add `playwright/.auth` to `.gitignore`. The state file "may contain sensitive cookies and headers that could be used to impersonate you". [Playwright .NET auth](https://playwright.dev/dotnet/docs/auth)
- `sessionStorage` is not saved. The documented workaround reads it with `EvaluateAsync` and restores it with `AddInitScriptAsync`, gated on hostname. [Playwright .NET auth](https://playwright.dev/dotnet/docs/auth)
- An Aspire + Playwright example gets the web URL from `App.CreateHttpClient("web")` and `webClient.BaseAddress!.ToString().TrimEnd('/')`, launches Chromium headless, and sets an ignore-HTTPS-errors option on the context. Its login is form registration, not OIDC. [intrepid-developer blog](https://intrepid-developer.com/blog/testing-dotnet-with-aspire)
- Without a browser, Duende's smoke test performs the same OIDC login over `HttpClient`. It uses a `CookieContainer`, GETs the protected URL and follows the redirect to the login page, parses `__RequestVerificationToken` with AngleSharp, POSTs the form, and treats landing back on the app host as success. It assumes default template field names. [Duende smoke testing](https://docs.duendesoftware.com/identityserver/testing/smoke-testing/)

Composed sketch, not run:
```csharp
// One-time setup, after the Aspire fixture is healthy.
var web = app.CreateHttpClient("webfrontend").BaseAddress!;
await using var browser = await playwright.Chromium.LaunchAsync();
var ctx = await browser.NewContextAsync(new() { BaseURL = web.ToString(), IgnoreHTTPSErrors = true });
var page = await ctx.NewPageAsync();
await page.GotoAsync("/account/login");          // app issues OIDC challenge, browser lands on IdP page
await page.GetByLabel("Username").FillAsync("alice");  // IdP-specific selectors live here and only here
await page.GetByLabel("Password").FillAsync("alice");
await page.GetByRole(AriaRole.Button, new() { Name = "Sign In" }).ClickAsync();
await page.WaitForURLAsync(u => u.StartsWith(web.ToString()));
await ctx.StorageStateAsync(new() { Path = "playwright/.auth/alice.json" });
```

### Inferences
- The IdP login page is the only IdP-specific part of the browser path. Keep its selectors in one helper per IdP so swapping IdPs touches one file.
- Saved state embeds cookies for both the app origin and the IdP origin. With Aspire port randomization, each run gets new ports, so the state file must be regenerated per run, or ports pinned with `DcpPublisher:RandomizePorts=false` and a fixed IdP port. The Keycloak docs already recommend a stable port for cookie reasons. [aspire.dev overview](https://aspire.dev/testing/overview/), [aspire.dev Keycloak](https://aspire.dev/integrations/security/keycloak/)
- xUnit, NUnit, MSTest and TUnit fixture hooks from section 1 are the natural "global setup" for .NET. The playwright.dev page shows no .NET global-setup construct.

### Gaps
- No sample combining Aspire, Playwright and an OIDC IdP turned up in an extended search. The nearest are Playwright OIDC suites without Aspire, for example [angular-auth-oidc-client PR #2329](https://github.com/damienbod/angular-auth-oidc-client/pull/2329) and [mock-oidc PR #1](https://github.com/meesvandongen/mock-oidc/pull/1).
- The blog spells the option `IgnoreHttpErrors`. I believe the .NET property is `IgnoreHTTPSErrors` but did not verify it.
- The Playwright .NET auth page does not cover API-request login or `PageTest.ContextOptions` overrides.

## 4. Skipping the IdP: TestAuthHandler, dotnet user-jwts, local signing key

### Takeaway
All IdP-free options are well documented for `WebApplicationFactory`, and none is available as DI replacement under Aspire. Under the AppHost they only work if the app itself trusts a test issuer through configuration. That leaves two tiers: fast in-process tests with a fake handler, and fewer full-stack tests with the real IdP.

### Cited Findings
- ASP.NET Core docs (aspnetcore-10.0 through 12.0 monikers) show `TestAuthHandler : AuthenticationHandler<AuthenticationSchemeOptions>` returning `AuthenticateResult.Success` with a `ClaimTypes.Name` claim. They register it in `ConfigureTestServices`:
  ```csharp
  services.AddAuthentication(options =>
      {
          options.DefaultAuthenticateScheme = "TestScheme";
          options.DefaultChallengeScheme = "TestScheme";
      })
      .AddScheme<AuthenticationSchemeOptions, TestAuthHandler>("TestScheme", options => { });
  ```
  and set `client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue(scheme: "TestScheme");`. The scheme must match what the app expects. `AllowAutoRedirect = false` lets a test assert the 302 to sign-in for anonymous users. [ASP.NET Core integration tests](https://learn.microsoft.com/en-us/aspnet/core/test/integration-tests)
- `dotnet user-jwts create` issues local JWTs with options `--name`, `--audience`, `--issuer` (default `dotnet-user-jwts`), `--scope`, `--role`, `--claim name=value`, `--valid-for`, `-o token|json`. It writes `Authentication:Schemes:Bearer:ValidAudiences` and `ValidIssuer` into `appsettings.Development.json`. It keeps the signing key in user-secrets at `%APPDATA%\Microsoft\UserSecrets\<guid>\user-jwts.json`. ASP.NET Core 11+ adds `--file app.cs`. Page updated 2026-10-31. [dotnet user-jwts](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/jwt-authn)
- Duende's testing guide runs IdentityServer in-process with `WebApplicationFactory`, using mutable static `Config.Clients` per test. It warns that parallel tests sharing those collections interfere. [Duende IdentityServer testing](https://docs.duendesoftware.com/identityserver/testing/)

### Inferences
- `user-jwts` keys live in one developer's profile, so they do not carry to CI. For CI, a test-owned key with the app's `TokenValidationParameters` fed via `WithEnvironment` is the portable version. I found no doc for that under Aspire.
- Trade-off. A fake handler or local key tests the app's authorization rules and stays fast and IdP-agnostic. It does not test issuer/audience config, discovery, cookie and OIDC redirects, or token refresh. Those are exactly the parts that break when switching IdPs, so keep a small real-IdP suite under Aspire.

### Gaps
- No Microsoft doc shows a JWT signed with a test key in a test and trusted by an Aspire-hosted project.

## 5. Blazor Web App and BFF with cookie + OIDC

### Takeaway
With cookie-backed OIDC the browser never holds a bearer token, so a test signs in by running the real redirect flow, in Playwright or in an `HttpClient` with a cookie jar. Or it bypasses OIDC with a test scheme in-process.

### Cited Findings
- Duende's smoke test is a browserless cookie-jar login through the OIDC redirect and form POST. It works for any server-side cookie app whose IdP login page is a plain HTML form. [Duende smoke testing](https://docs.duendesoftware.com/identityserver/testing/smoke-testing/)
- `AddKeycloakOpenIdConnect(serviceName: "keycloak", realm: "api", ...)` with `ResponseType` Code is Aspire's client-side OIDC registration for web frontends. [aspire.dev Keycloak](https://aspire.dev/integrations/security/keycloak/)
- `microsoft/aspire-samples` has no Keycloak or OIDC sample. Its auth code is ASP.NET Core Identity in `samples/Metrics` and `samples/volume-mount`, and its only app-level test project is `tests/SamplesIntegrationTests/AppHostTests.cs`. `dotnet/aspire-samples` redirects to `microsoft/aspire-samples`. [GitHub tree](https://github.com/microsoft/aspire-samples), checked with `gh api repos/microsoft/aspire-samples/git/trees/main?recursive=1`, tree not truncated.

### Inferences
- For Blazor Server and interactive server render modes, the circuit reuses the auth cookie from the initial HTTP request. A Playwright `storageState` holding that cookie should authenticate the circuit. Not verified.
- For BFF APIs called from tests, the Duende cookie-jar flow plus an antiforgery header is the likely shape. Duende.BFF's `x-csrf: 1` requirement is from memory, not checked this session.

### Gaps
- I found no official Duende BFF testing page. A search surfaced only a third-party skill listing. No Microsoft doc on testing Blazor Web App + OIDC end to end turned up.

## 6. Issuer and authority URLs, HTTPS, RequireHttpsMetadata

### Takeaway
Aspire service discovery hands apps an `https+http://keycloak` style address, which fails JWT Bearer's HTTPS metadata check. Apps then set `RequireHttpsMetadata = false` in development. The token `iss` has to match what both the browser and the API see, and that is the usual container-vs-host trap.

### Cited Findings
- With default `RequireHttpsMetadata = true`, "the JWT Bearer authentication requires the Authority URL to use HTTPS", and "Aspire service discovery uses the `https+http://` scheme, which doesn't satisfy this requirement." The sample sets `options.RequireHttpsMetadata = false` inside `IsDevelopment()`. For production the page recommends an explicit `options.Authority`. [aspire.dev Keycloak](https://aspire.dev/integrations/security/keycloak/)
- `AddKeycloak("keycloak", 8080)` with a stable port is recommended so OIDC cookies don't outlive the AppHost. The image is `quay.io/keycloak/keycloak:26.6`. `WithRealmImport("./Realms")` copies to `/opt/keycloak/data/import`, is "intended for local development", and isn't supported by `aspire publish`/`deploy`. [aspire.dev Keycloak](https://aspire.dev/integrations/security/keycloak/)
- Admin credentials default to `admin` and a random password under `Parameters:keycloak-password`. They persist in the data volume, so changed credentials need the volume deleted. [aspire.dev Keycloak](https://aspire.dev/integrations/security/keycloak/)
- Keycloak builds `iss` from the hostname it believes it serves. A Compose case shows a token issued as `http://localhost:8042/auth/realms/test` while the API expected `http://keycloak:8080/...`. The fix is `KC_HOSTNAME` set to the browser-facing URL. [Stack Overflow mirror](https://kiwix.lema.org/stackoverflow.com_en_all_2023-11/questions/72997749/keycloak-invalid-token-issuer-docker-compose), [skycloak troubleshooting](https://skycloak.io/blog/keycloak-troubleshooting-top-10-errors/)
- A Damien Bod post says its Keycloak hosting code, including HTTPS dev-certificate handling, was adapted from the aspire-samples Keycloak sample. That sample is no longer in the repo tree, per the section 5 check. [damienbod.com](https://damienbod.com/2024/09/02/implement-asp-net-core-openid-connect-oauth-par-client-with-keycloak-using-net-aspire/)

### Inferences
- In Aspire's default dev setup, projects run on the host, not in containers. The API, the browser and the test process all reach Keycloak at `localhost:<port>`, so `iss` usually matches. The trap returns when the API runs as a container or under random ports. A token fetched by the test through `CreateHttpClient("keycloak")` carries the same `localhost` issuer the API expects.
- Tests that pass `--environment=Testing` lose any `IsDevelopment()`-guarded `RequireHttpsMetadata = false`. Gate it on configuration, or keep the environment `Development` in tests.

### Gaps
- No Aspire doc I read covers `KC_HOSTNAME`, browser-visible vs internal IdP URLs, or HTTPS dev certs mounted into IdP containers. The aspire.dev advanced-scenarios page has only a nav link for certificate configuration.

## 7. Official samples

### Takeaway
No official Microsoft sample shows OIDC auth plus tests. `microsoft/aspire-samples` has testing samples and Identity-based auth, but they never meet.

### Cited Findings
- Repo tree check from section 5: no Keycloak/OIDC paths, Identity-only auth, and app tests only in `tests/SamplesIntegrationTests`. [microsoft/aspire-samples](https://github.com/microsoft/aspire-samples)
- Aspire's own repo has `Aspire.Keycloak.Authentication.Tests`, which covers API-surface checks such as null-argument validation. These are not sign-in flows. Source: `https://source.dot.net/Aspire.Keycloak.Authentication.Tests/KeycloakAuthenticationPublicApiTests.cs.html`
- Closest community samples: NikiforovAll `samples/GettingStartedAndAspire`, which does Keycloak + Aspire with Swagger PKCE and no tests ([nikiforovall](https://nikiforovall.blog/keycloak-authorization-services-dotnet/examples/aspire-web-api.html)), and `intrepid-developer/aspire-chat-demo`, which does Aspire + Playwright without OIDC ([intrepid-developer blog](https://intrepid-developer.com/blog/testing-dotnet-with-aspire)).

### Gaps
- I did not search github.com/microsoft/aspire issues directly for auth-in-tests discussions. The `gh` code search returned nothing, and that empty result does not prove absence.
