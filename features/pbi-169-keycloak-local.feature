@pbi-169
Feature: Keycloak runs locally under Aspire with the realm import
  Step 5a of the control plane redesign (2026-11-07 design, §07, §11 and §12) adds Keycloak to the local
  platform as the local sign-in provider. `aspire run` starts it on a pinned port, 7430, because the issuer
  URL contains the port and users are keyed on the issuer. Keycloak starts from a realm import that holds
  the `dashboard` client people sign in through, an audience mapper that puts the API's audience in access
  tokens, a test owner, and an e2e client that tests use to get a real token with no browser.
  Only the e2e client may trade a username and password for a token directly. The `dashboard` client
  accepts redirects to 7403, where the new sign-in front end runs until the cut-over, and to 7400, where it
  moves at the cut-over, so the move doesn't break sign-in.
  Migrate seeding the test owner is not part of this step.
  Scenarios without a tag read the realm import and the AppHost, so CI and cells run them. The scenarios
  tagged @local need Docker, the Aspire CLI and the owner's secrets, so the owner runs them and the PR records the run.

  Rule: aspire run starts Keycloak on 7430 from the realm import

    @ac-1
    Scenario: The realm import holds the dashboard client, the audience mapper, the test owner and the e2e client
      When I read the realm import the AppHost gives Keycloak
      Then it defines a client "dashboard"
      And it defines an e2e client
      And it defines an audience mapper that adds the API's audience to access tokens
      And it defines a test owner user with a password

    @ac-1
    Scenario: The AppHost pins Keycloak to port 7430
      When I read the AppHost
      Then it adds a Keycloak resource on port 7430
      And it hands that resource the realm import

    @ac-1 @local
    Scenario: aspire run brings Keycloak up on 7430 with the realm loaded
      When I start "aspire run" and wait until the Keycloak resource is healthy
      Then Keycloak answers on "http://localhost:7430"
      And the realm's OpenID discovery document on port 7430 names an issuer on port 7430
      And the discovery document has a JWKS address

    @ac-1 @local
    Scenario: The test owner can sign in through the e2e client
      Given "aspire run" is up
      When the e2e client asks Keycloak for a token by direct grant as the test owner
      Then Keycloak issues an access token

    @ac-1 @local
    Scenario: The realm import is applied again after a restart
      Given "aspire run" has run once
      When I stop "aspire run" and start it again
      Then Keycloak answers on "http://localhost:7430"
      And the e2e client can still get a token by direct grant as the test owner

  Rule: Only the e2e client allows direct access grants

    @ac-2
    Scenario: The e2e client is the only client in the realm import with direct access grants
      When I read the realm import the AppHost gives Keycloak
      Then the e2e client allows direct access grants
      And the "dashboard" client does not allow direct access grants
      And no other client in the realm import allows direct access grants

    @ac-2 @local
    Scenario: The dashboard client is refused a direct grant
      Given "aspire run" is up
      When the "dashboard" client asks Keycloak for a token by direct grant as the test owner
      Then Keycloak refuses the request as an unauthorized client
      And no access token is issued

    @ac-2 @local
    Scenario: The e2e client is refused a direct grant with a wrong password
      Given "aspire run" is up
      When the e2e client asks Keycloak for a token by direct grant as the test owner with a wrong password
      Then Keycloak refuses the request as invalid credentials
      And no access token is issued

  Rule: A direct-grant token from the e2e client is a JWT carrying the API's audience

    @ac-3
    Scenario: The AppHost and the realm import agree on the API's audience
      When I read the AppHost and the realm import the AppHost gives Keycloak
      Then the AppHost sets an API_AUDIENCE value
      And the realm import's audience mapper adds that same value

    @ac-3 @local
    Scenario: The e2e client's token is a JWT whose audience holds API_AUDIENCE
      Given "aspire run" is up
      When the e2e client asks Keycloak for a token by direct grant as the test owner
      Then the access token is a JWT with a header, a payload and a signature
      And the token's signature checks out against the realm's JWKS
      And the token's "aud" claim holds the API_AUDIENCE value the AppHost sets
      And the token's "iss" claim is the realm's issuer on port 7430

  Rule: The dashboard client accepts redirects to both 7403 and 7400

    @ac-4
    Scenario: The dashboard client's redirect addresses cover 7403 and 7400
      When I read the realm import the AppHost gives Keycloak
      Then the "dashboard" client accepts redirects to "http://localhost:7403"
      And the "dashboard" client accepts redirects to "http://localhost:7400"

    @ac-4 @local
    Scenario Outline: Keycloak starts sign-in for the dashboard client on port <port>
      Given "aspire run" is up
      When a browser starts sign-in for the "dashboard" client with a redirect back to "http://localhost:<port>"
      Then Keycloak shows its sign-in page rather than an invalid redirect error

      Examples:
        | port |
        | 7403 |
        | 7400 |

    @ac-4 @local
    Scenario: Keycloak refuses a dashboard redirect to a port it doesn't know
      Given "aspire run" is up
      When a browser starts sign-in for the "dashboard" client with a redirect back to "http://localhost:7499"
      Then Keycloak refuses with an invalid redirect error
