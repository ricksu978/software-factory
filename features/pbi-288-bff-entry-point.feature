@pbi-288
Feature: The BFF's entry point runs on Hono and the AppHost starts it on 7403
  Step 7a of the control plane redesign (2026-11-07 design, §09, §10 and §12) adds the BFF as its own entry
  point, src/bff/main.ts, built on Hono. Under aspire run it starts on port 7403, beside today's dashboard on
  7400, until the cut-over moves it. The AppHost gives it what it needs to sign people in: the issuer, the
  client id and secret, and the session key that encrypts refresh tokens.
  These scenarios read the code and the AppHost, so CI and cells run them. The behaviour of sign-in and
  sessions is in pbi-288-bff-sign-in-sessions.feature.

  Rule: The BFF is its own entry point built on Hono

    @ac-1
    Scenario: The BFF's entry point serves its routes with Hono
      When I read src/bff/main.ts
      Then it serves its routes with Hono

  Rule: The AppHost runs the BFF on 7403 with its sign-in settings

    @ac-1
    Scenario: The AppHost runs the BFF from src/bff/main.ts on 7403
      When I read the AppHost
      Then it adds a BFF resource that runs src/bff/main.ts
      And it gives the BFF port 7403
      And it hands the BFF the issuer, the client id, the client secret and the session key

    @ac-1
    Scenario: The AppHost points the BFF at the local Keycloak realm
      When I read the AppHost
      Then the issuer it hands the BFF is the Keycloak realm on port 7430
      And the client id it hands the BFF is "dashboard"
