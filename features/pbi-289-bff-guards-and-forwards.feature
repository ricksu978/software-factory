@pbi-289
Feature: The BFF guards and forwards the dashboard's /bff/v1 calls to the API
  Step 7b of the control plane redesign (2026-11-07 design, §04 and §05) makes the BFF the dashboard's only way
  to the orchestrator API. The dashboard calls /bff/v1/*, and the BFF forwards each call one for one to the
  API's /v1/*, carrying the signed-in person's access token as a bearer token. The browser never holds that
  token, and the API never sees the browser's session cookie. A call with no valid session gets 401, so the
  dashboard can send the browser to sign in.
  Before it forwards a call, the BFF refreshes an access token that expires within 60 seconds, so the API
  never gets a token that is about to lapse. A session idle for seven days, or 30 days old, counts as none.
  A state-changing call anywhere under /bff must carry an Origin equal to the BFF's own, as today's dashboard
  requires, so another site can't act for a signed-in person.
  Sign-in, sign-out and the session table came in step 7a (pbi-288). Building the API's routes is not part of
  this step: these scenarios forward to a stand-in API that records each call it gets and answers as a
  scenario tells it.
  Scenarios tagged @db need Postgres, which each test starts for itself, and a test sign-in provider and the
  stand-in API, which the test also starts, so CI and cells run them.

  Background:
    Given a test sign-in provider is running with the user "alice"
    And a stand-in API is running
    And the BFF is running against that provider as its issuer and that stand-in as its API

  Rule: A /bff/v1 call without a valid session gets 401 and never reaches the API

    @ac-1 @db
    Scenario: A call with no session cookie gets 401
      When a browser with no session cookie calls GET "/bff/v1/floor"
      Then the BFF answers 401
      And the API received no call

    @ac-1 @db
    Scenario: A call with a session cookie the BFF never issued gets 401
      When a browser presenting a session cookie the BFF never issued calls GET "/bff/v1/floor"
      Then the BFF answers 401
      And the API received no call

    @ac-1 @db
    Scenario: A call with a cookie from a session that signed out gets 401
      Given "alice" has signed in through the BFF
      And alice's browser has kept a copy of its session cookie
      And alice's browser has signed out at "/auth/logout"
      When a browser presenting the copied session cookie calls GET "/bff/v1/floor"
      Then the BFF answers 401
      And the API received no call

    @ac-1 @db
    Scenario: A state-changing call with no session gets 401 too
      When a browser with no session cookie calls POST "/bff/v1/items/482/hold" from the BFF's own origin
      Then the BFF answers 401
      And the API received no call

  Rule: With a valid session, the BFF forwards the call one for one to the API's /v1 with the person's bearer token

    @ac-1 @db
    Scenario: A signed-in read goes to the API's matching /v1 address with alice's access token
      Given "alice" has signed in through the BFF
      And the API will answer GET "/v1/floor" with 200 and the body '{"cells":[]}'
      When alice's browser calls GET "/bff/v1/floor"
      Then the API received one call, GET "/v1/floor"
      And that call carried alice's current access token as a bearer token
      And the BFF answers 200 with the body '{"cells":[]}'

    @ac-1 @db
    Scenario: The query string goes to the API unchanged
      Given "alice" has signed in through the BFF
      When alice's browser calls GET "/bff/v1/items?state=Green&page=2"
      Then the API received one call, GET "/v1/items?state=Green&page=2"

    @ac-1 @db
    Scenario: A state-changing call goes to the API with its method and body
      Given "alice" has signed in through the BFF
      When alice's browser calls POST "/bff/v1/items/482/hold" from the BFF's own origin with the JSON body '{"reason":"waiting on design"}'
      Then the API received one call, POST "/v1/items/482/hold"
      And that call carried the JSON body '{"reason":"waiting on design"}'
      And that call carried alice's current access token as a bearer token

    @ac-1 @db
    Scenario: The API's refusal goes back to the browser as the API gave it
      Given "alice" has signed in through the BFF
      And the API will answer GET "/v1/floor" with 403 and the body '{"error":"no access"}'
      When alice's browser calls GET "/bff/v1/floor"
      Then the BFF answers 403 with the body '{"error":"no access"}'

    @ac-1 @db
    Scenario: The API never sees the browser's cookies
      Given "alice" has signed in through the BFF
      When alice's browser calls GET "/bff/v1/floor"
      Then the call the API received carried no cookie

    @ac-1 @db
    Scenario: A bearer token the browser sends is replaced by alice's own
      Given "alice" has signed in through the BFF
      When alice's browser calls GET "/bff/v1/floor" with its own bearer token "forged-token"
      Then the call the API received carried alice's current access token as a bearer token
      And the call the API received didn't carry "forged-token"

    @ac-1 @db
    Scenario: Each browser's call carries its own session's token
      Given the provider issues a different access token for each sign-in
      And "alice" has signed in through the BFF in one browser
      And "alice" has signed in through the BFF in a second browser
      When the first browser calls GET "/bff/v1/floor"
      And the second browser calls GET "/bff/v1/floor"
      Then the API's first call carried the first browser's access token
      And the API's second call carried the second browser's access token

  Rule: The BFF refreshes an access token that expires within 60 seconds before it forwards the call

    @ac-2 @db
    Scenario: A token that expires in 30 seconds is refreshed and the call carries the new one
      Given "alice" has signed in through the BFF
      And alice's access token expires in 30 seconds
      And the provider will issue the access token "at-alice-2" on the next refresh
      When alice's browser calls GET "/bff/v1/floor"
      Then the provider received a refresh with alice's refresh token
      And the API received one call, GET "/v1/floor"
      And that call carried "at-alice-2" as a bearer token

    @ac-2 @db
    Scenario: A token that has already expired is refreshed before the call
      Given "alice" has signed in through the BFF
      And alice's access token expired 10 seconds ago
      And the provider will issue the access token "at-alice-2" on the next refresh
      When alice's browser calls GET "/bff/v1/floor"
      Then the API received one call, GET "/v1/floor"
      And that call carried "at-alice-2" as a bearer token

    @ac-2 @db
    Scenario: A token with more than 60 seconds left is forwarded without a refresh
      Given "alice" has signed in through the BFF
      And alice's access token expires in 5 minutes
      When alice's browser calls GET "/bff/v1/floor"
      Then the provider received no refresh
      And the API received one call, GET "/v1/floor"
      And that call carried alice's access token from sign-in as a bearer token

    @ac-2 @db
    Scenario: The refreshed token is kept for the next call
      Given "alice" has signed in through the BFF
      And alice's access token expires in 30 seconds
      And the provider will issue the access token "at-alice-2", lasting 5 minutes, on the next refresh
      When alice's browser calls GET "/bff/v1/floor"
      And alice's browser calls GET "/bff/v1/floor" again
      Then the provider received one refresh
      And the API's second call carried "at-alice-2" as a bearer token

    @ac-2 @db
    Scenario: A new refresh token from the provider replaces the old one, still encrypted
      Given the provider will issue the refresh token "rt-alice-1" for the next sign-in
      And "alice" has signed in through the BFF
      And alice's access token expires in 30 seconds
      And the provider will issue the refresh token "rt-alice-2" on the next refresh
      When alice's browser calls GET "/bff/v1/floor"
      Then the stored refresh token doesn't contain "rt-alice-2"
      And the stored refresh token decrypts to "rt-alice-2" under the BFF's session key

    @ac-2 @db
    Scenario: When the provider refuses the refresh, the call gets 401 and isn't forwarded
      Given "alice" has signed in through the BFF
      And alice's access token expires in 30 seconds
      And the provider will refuse the next refresh
      When alice's browser calls GET "/bff/v1/floor"
      Then the BFF answers 401
      And the API received no call

    @ac-2 @db
    Scenario: A session with no refresh token and a token about to expire gets 401
      Given the provider will issue no refresh token for the next sign-in
      And "alice" has signed in through the BFF
      And alice's access token expires in 30 seconds
      When alice's browser calls GET "/bff/v1/floor"
      Then the BFF answers 401
      And the API received no call

  Rule: The BFF refuses a session idle for seven days, or 30 days old

    @ac-3 @db
    Scenario: A session last used eight days ago gets 401
      Given "alice" has signed in through the BFF
      And alice's session was last used 8 days ago
      When alice's browser calls GET "/bff/v1/floor"
      Then the BFF answers 401
      And the API received no call

    @ac-3 @db
    Scenario: A session last used six days ago is still good
      Given "alice" has signed in through the BFF
      And alice's session was last used 6 days ago
      When alice's browser calls GET "/bff/v1/floor"
      Then the API received one call, GET "/v1/floor"

    @ac-3 @db
    Scenario: A forwarded call counts as use, so the session's idle time starts again
      Given "alice" has signed in through the BFF
      And alice's session was last used 6 days ago
      When alice's browser calls GET "/bff/v1/floor"
      And 2 more days pass
      And alice's browser calls GET "/bff/v1/floor" again
      Then the API received 2 calls

    @ac-3 @db
    Scenario: A session 31 days old gets 401 even though it was used yesterday
      Given "alice" has signed in through the BFF
      And alice's session began 31 days ago
      And alice's session was last used 1 day ago
      When alice's browser calls GET "/bff/v1/floor"
      Then the BFF answers 401
      And the API received no call

    @ac-3 @db
    Scenario: A session 29 days old that was used yesterday is still good
      Given "alice" has signed in through the BFF
      And alice's session began 29 days ago
      And alice's session was last used 1 day ago
      When alice's browser calls GET "/bff/v1/floor"
      Then the API received one call, GET "/v1/floor"

    @ac-3 @db
    Scenario: An expired session isn't refreshed
      Given "alice" has signed in through the BFF
      And alice's session was last used 8 days ago
      And alice's access token expires in 30 seconds
      When alice's browser calls GET "/bff/v1/floor"
      Then the BFF answers 401
      And the provider received no refresh

  Rule: The BFF refuses a state-changing /bff call whose Origin isn't its own

    @ac-4 @db
    Scenario Outline: A signed-in <method> from another site is refused
      Given "alice" has signed in through the BFF
      When alice's browser calls <method> "/bff/v1/items/482/hold" with the Origin "https://evil.example"
      Then the BFF answers 403
      And the API received no call

      Examples:
        | method |
        | POST   |
        | PUT    |
        | PATCH  |
        | DELETE |

    @ac-4 @db
    Scenario: A signed-in state-changing call with no Origin is refused
      Given "alice" has signed in through the BFF
      When alice's browser calls POST "/bff/v1/items/482/hold" with no Origin
      Then the BFF answers 403
      And the API received no call

    @ac-4 @db
    Scenario: An Origin that only differs in its port is refused
      Given the BFF's own origin is "http://localhost:7403"
      And "alice" has signed in through the BFF
      When alice's browser calls POST "/bff/v1/items/482/hold" with the Origin "http://localhost:7400"
      Then the BFF answers 403
      And the API received no call

    @ac-4 @db
    Scenario: A signed-in state-changing call from the BFF's own origin goes through
      Given "alice" has signed in through the BFF
      When alice's browser calls POST "/bff/v1/items/482/hold" from the BFF's own origin
      Then the API received one call, POST "/v1/items/482/hold"

    @ac-4 @db
    Scenario: A read from another site isn't state-changing, so it goes through
      Given "alice" has signed in through the BFF
      When alice's browser calls GET "/bff/v1/floor" with the Origin "https://evil.example"
      Then the API received one call, GET "/v1/floor"

    @ac-4 @db
    Scenario: A state-changing call from another site anywhere under /bff is refused
      Given "alice" has signed in through the BFF
      When alice's browser calls POST "/bff/v2/anything" with the Origin "https://evil.example"
      Then the BFF answers 403
      And the API received no call
