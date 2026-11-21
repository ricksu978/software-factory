@pbi-288
Feature: The BFF signs people in and keeps sessions in Postgres
  Step 7a of the control plane redesign (2026-11-07 design, §04, §08 and §12) starts the BFF, the one
  service the browser talks to. It runs from src/bff/main.ts on Hono, on port 7403 until the cut-over moves
  it to 7400. It is the only sign-in client: it signs people in at the configured issuer with the
  authorization code flow and PKCE, and the browser never sees a token. After sign-in the browser holds only
  a session cookie. The session itself lives in Postgres, so restarting the BFF signs nobody out. The BFF
  refuses a sign-in whose access token isn't a JWT, because the API can only check JWTs. It works in
  Postgres as the factory_bff role, which reaches sessions and nothing else, and it keeps each refresh token
  encrypted under the session key. Signing out deletes the session and clears the cookie.
  Forwarding the dashboard's calls to the API and passing GitHub webhooks through are not part of this step.
  Scenarios tagged @db need Postgres, which each test starts for itself. Those scenarios sign in at a test
  sign-in provider that the test also starts, so CI and cells run them. The scenarios tagged @local need
  Docker, the Aspire CLI and the owner's secrets, so the owner runs them and the PR records the run.
  The scenarios that read the code and the AppHost are in pbi-288-bff-entry-point.feature.

  Background:
    Given a test sign-in provider is running with the user "alice"
    And the BFF is running against that provider as its issuer

  Rule: The BFF answers on port 7403

    @ac-1 @db
    Scenario: The BFF listens on 7403 when no port is given
      Given the BFF is stopped
      When the BFF starts with no port set
      Then the BFF answers on port 7403

  Rule: The BFF signs people in at the configured issuer with the authorization code flow and PKCE

    @ac-1 @db
    Scenario: Starting sign-in sends the browser to the issuer's sign-in page with a PKCE challenge
      When a browser starts sign-in at "/auth/login"
      Then the BFF sends the browser to the authorization address in the issuer's discovery document
      And the request asks for an authorization code
      And the request carries a PKCE challenge made with S256
      And the request carries a state and a nonce
      And the request asks to come back to the BFF at "/auth/callback"

    @ac-1 @db
    Scenario: Starting sign-in keeps the sign-in's secrets in a short-lived cookie that survives the provider's redirect
      When a browser starts sign-in at "/auth/login"
      Then the BFF sets a sign-in cookie that is HttpOnly and SameSite=Lax
      And the sign-in cookie expires within minutes, not days

    @ac-1 @db
    Scenario: A completed sign-in trades the code for tokens with the matching PKCE verifier
      When "alice" signs in through the BFF
      Then the provider received the code at its token address with a PKCE verifier that matches the challenge
      And the sign-in succeeds
      And a session for "alice" from the provider's issuer exists

    @ac-1 @db
    Scenario: A completed sign-in clears the sign-in cookie
      When "alice" signs in through the BFF
      Then the sign-in cookie is cleared

    @ac-1 @db
    Scenario: The BFF refuses a callback whose state doesn't match the one it sent
      Given a browser has started sign-in at "/auth/login"
      When the provider sends the browser back to "/auth/callback" with a code for "alice" and a different state
      Then the BFF refuses the sign-in
      And no session exists
      And the browser holds no session cookie

    @ac-1 @db
    Scenario: The BFF refuses a callback from a browser that never started sign-in
      When a browser arrives at "/auth/callback" with a code for "alice" and no sign-in cookie
      Then the BFF refuses the sign-in
      And no session exists
      And the browser holds no session cookie

    @ac-1 @db
    Scenario: The BFF refuses a sign-in whose ID token carries a different nonce
      Given the provider will put a different nonce in the next ID token
      When "alice" signs in through the BFF
      Then the BFF refuses the sign-in
      And no session exists
      And the browser holds no session cookie

    @ac-1 @db
    Scenario: The BFF refuses a sign-in the provider turned down
      Given a browser has started sign-in at "/auth/login"
      When the provider sends the browser back to "/auth/callback" with an access denied error
      Then the BFF refuses the sign-in
      And no session exists
      And the browser holds no session cookie

    @ac-1 @local @serial
    Scenario: The test owner signs in through Keycloak on 7430 and the BFF on 7403
      Given "aspire run" is up
      When a browser opens "http://localhost:7403/auth/login"
      Then the browser lands on Keycloak's sign-in page for the realm on port 7430
      When the browser signs in there as the test owner
      Then the browser comes back to "http://localhost:7403"
      And a session for the test owner from the realm's issuer on port 7430 exists

  Rule: After sign-in the browser holds only an HttpOnly, SameSite=Strict session cookie

    @ac-2 @db
    Scenario: The session cookie is HttpOnly, SameSite=Strict and covers the whole site
      When "alice" signs in through the BFF
      Then the BFF sets a session cookie that is HttpOnly and SameSite=Strict
      And the session cookie's path is "/"

    @ac-2 @db
    Scenario: The session cookie is the only cookie the browser keeps after sign-in
      When "alice" signs in through the BFF
      Then the only cookie the browser holds is the session cookie

    @ac-2 @db
    Scenario: No token reaches the browser
      When "alice" signs in through the BFF
      Then nothing the BFF sent the browser during sign-in holds alice's access token, ID token or refresh token
      And the session cookie's value is not any of alice's tokens

    @ac-2 @db
    Scenario: Each sign-in gets its own session cookie
      When "alice" signs in through the BFF in one browser
      And "alice" signs in through the BFF in a second browser
      Then the two browsers hold different session cookies
      And two sessions for "alice" exist

  Rule: The BFF refuses a sign-in whose access token isn't a JWT

    @ac-3 @db
    Scenario: A sign-in whose access token is opaque is refused
      Given the provider will issue an opaque access token for the next sign-in
      When "alice" signs in through the BFF
      Then the BFF refuses the sign-in because the provider's access token isn't a JWT
      And no session exists
      And the browser holds no session cookie

    @ac-3 @db
    Scenario: A sign-in whose access token only looks like a JWT is refused
      Given the provider will issue an access token of three dotted parts that don't decode to a JWT for the next sign-in
      When "alice" signs in through the BFF
      Then the BFF refuses the sign-in because the provider's access token isn't a JWT
      And no session exists
      And the browser holds no session cookie

    @ac-3 @db
    Scenario: A sign-in whose access token is a JWT is accepted
      Given the provider will issue a JWT access token for the next sign-in
      When "alice" signs in through the BFF
      Then the sign-in succeeds
      And a session for "alice" from the provider's issuer exists
      And the browser holds a session cookie

  Rule: A restart of the BFF signs nobody out

    @ac-4 @db
    Scenario: A browser signed in before a restart is still signed in after it
      Given "alice" has signed in through the BFF
      When the BFF is stopped and started again
      Then the BFF still treats alice's browser as signed in as "alice"
      And alice's session is unchanged

    @ac-4 @db
    Scenario: Every session survives the restart, not only the latest
      Given "alice" has signed in through the BFF in one browser
      And "alice" has signed in through the BFF in a second browser
      When the BFF is stopped and started again
      Then the BFF still treats both browsers as signed in as "alice"

    @ac-4 @db
    Scenario: Signing out after a restart still ends the session
      Given "alice" has signed in through the BFF
      And the BFF has been stopped and started again
      When alice's browser signs out at "/auth/logout"
      Then no session for "alice" exists
      And the BFF no longer treats alice's browser as signed in

    @ac-4 @db
    Scenario: A cookie the BFF never issued isn't signed in after a restart either
      Given the BFF has been stopped and started again
      When a browser presents a session cookie the BFF never issued
      Then the BFF doesn't treat the browser as signed in

  Rule: Signing out deletes the session and clears the cookie

    @ac-5 @db
    Scenario: Signing out deletes the session and clears the session cookie
      Given "alice" has signed in through the BFF
      When alice's browser signs out at "/auth/logout"
      Then no session for "alice" exists
      And the BFF clears the session cookie
      And the browser holds no session cookie

    @ac-5 @db
    Scenario: A signed-out cookie presented again isn't signed in
      Given "alice" has signed in through the BFF
      And alice's browser has kept a copy of its session cookie
      When alice's browser signs out at "/auth/logout"
      And a browser presents the copied session cookie
      Then the BFF doesn't treat the browser as signed in

    @ac-5 @db
    Scenario: Signing out in one browser leaves the other browser's session alone
      Given "alice" has signed in through the BFF in one browser
      And "alice" has signed in through the BFF in a second browser
      When the first browser signs out at "/auth/logout"
      Then one session for "alice" exists
      And the BFF still treats the second browser as signed in as "alice"

    @ac-5 @db
    Scenario: Signing out with no session cookie clears the cookie and deletes nothing
      Given "alice" has signed in through the BFF in one browser
      When a browser with no session cookie signs out at "/auth/logout"
      Then the BFF clears the session cookie
      And one session for "alice" exists

    @ac-5 @db
    Scenario: Signing out with a cookie the BFF never issued clears the cookie and deletes nothing
      Given "alice" has signed in through the BFF in one browser
      When a browser presenting a session cookie the BFF never issued signs out at "/auth/logout"
      Then the BFF clears the session cookie
      And one session for "alice" exists

  Rule: The BFF works in Postgres as factory_bff

    @ac-6 @db
    Scenario: The BFF's work in Postgres runs as factory_bff
      When "alice" signs in through the BFF
      Then every query the BFF ran ran as the role "factory_bff"

    @ac-6 @db
    Scenario: The BFF can't sign anyone in when factory_bff loses its grants on sessions
      Given the role "factory_bff" has lost its grants on sessions
      When "alice" signs in through the BFF
      Then the sign-in fails
      And no session exists
      And the browser holds no session cookie

  Rule: The BFF stores refresh tokens encrypted under the session key

    @ac-6 @db
    Scenario: The stored refresh token is encrypted under the session key
      Given the provider will issue the refresh token "rt-alice-1" for the next sign-in
      When "alice" signs in through the BFF
      Then alice's session holds a refresh token
      And the stored refresh token doesn't contain "rt-alice-1"
      And the stored refresh token decrypts to "rt-alice-1" under the BFF's session key
      And the stored refresh token doesn't decrypt under a different session key

    @ac-6 @db
    Scenario: A BFF restarted with the same session key still reads the stored refresh token
      Given the provider will issue the refresh token "rt-alice-1" for the next sign-in
      And "alice" has signed in through the BFF
      When the BFF is stopped and started again with the same session key
      Then the stored refresh token still decrypts to "rt-alice-1" under the BFF's session key

    @ac-6 @db
    Scenario: A sign-in with no refresh token stores none
      Given the provider will issue no refresh token for the next sign-in
      When "alice" signs in through the BFF
      Then the sign-in succeeds
      And alice's session holds no refresh token

    @ac-6 @db
    Scenario: The BFF refuses to start without a session key
      Given the BFF is stopped
      When the BFF starts with no session key set
      Then it exits with a failure code
      And its log names the missing session key
