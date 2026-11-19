@pbi-284
Feature: The orchestrator API serves /v1 on Hono, behind bearer tokens and roles
  Step 6a of the control plane redesign (2026-11-07 design, §03, §04, §05 and §12) starts the orchestrator
  API from src/api/main.ts. It is built on Hono and answers on port 7402. It serves the /v1 routes in §05's
  table, and each one is open only to the role the table names.
  Every caller except GitHub's webhook brings the sign-in provider's own access token as a bearer token. The
  API checks the token's signature against the issuer's published keys, and it checks the issuer, the
  audience and the expiry. It then looks up the person in the user table on every request, so removing
  someone ends their access on their very next request.
  The API finds the issuer's keys through the issuer's discovery document. If that document doesn't say
  where the keys are, the API refuses to start.
  Scenarios tagged @db need Postgres, which each test starts for itself, so cells and CI both run them.
  They run the API against a fake issuer that publishes its own discovery document and signing keys.
  In these scenarios a "valid token" is one the fake issuer signed, for the API's audience, and not expired.

  Background:
    Given a fake issuer publishing a discovery document and its signing keys
    And the API is configured with that issuer and the audience "factory-api"

  Rule: The API serves §05's /v1 routes on port 7402

    @ac-1 @db
    Scenario Outline: A viewer reads each viewer route on port 7402
      Given a fresh factory database with item "A"
      And "vera" is a viewer
      When the API starts from src/api/main.ts
      And "vera" asks port 7402 for "<route>" with a valid token
      Then the API answers 200

      Examples:
        | route                    |
        | GET /v1/floor            |
        | GET /v1/phase0           |
        | GET /v1/items/A          |
        | GET /v1/events           |

    @ac-1 @db
    Scenario: A viewer reads a stored blob through the API
      Given a fresh factory database with item "A"
      And item "A"'s run has a stored transcript
      And "vera" is a viewer
      When the API starts from src/api/main.ts
      And "vera" asks port 7402 for item "A"'s transcript under /v1/blobs with a valid token
      Then the API answers 200
      And the body is the stored transcript

    @ac-1 @db
    Scenario: The floor includes the Claude token banner and the worker's heartbeat
      Given a fresh factory database
      And the Claude token was created 80 days ago
      And the worker last sent a heartbeat a moment ago
      And "vera" is a viewer
      When the API starts from src/api/main.ts
      And "vera" asks port 7402 for the floor with a valid token
      Then the floor shows the Claude token's age
      And the floor shows the worker's last heartbeat

    @ac-1 @db
    Scenario: The API refuses a path that isn't one of its routes
      Given a fresh factory database
      And "olga" is an owner
      When the API starts from src/api/main.ts
      And "olga" asks port 7402 for "GET /dev-login" with a valid token
      Then the API answers 404

  Rule: Each route is open only to the role §05's table names

    @ac-1 @db
    Scenario: An item's details tell a viewer they may not operate
      Given a fresh factory database with item "A"
      And "vera" is a viewer
      When the API starts from src/api/main.ts
      And "vera" asks port 7402 for item "A" with a valid token
      Then the response says "vera" may not operate

    @ac-1 @db
    Scenario: An item's details tell an operator they may operate
      Given a fresh factory database with item "A"
      And "otto" is an operator
      When the API starts from src/api/main.ts
      And "otto" asks port 7402 for item "A" with a valid token
      Then the response says "otto" may operate

    @ac-1 @db
    Scenario: An operator sets an override
      Given a fresh factory database
      And "otto" is an operator
      When the API starts from src/api/main.ts
      And "otto" sets the WIP limit override to 3 through port 7402 with a valid token
      Then the API accepts it
      And the WIP limit override is 3

    @ac-1 @db
    Scenario: A viewer can't set an override
      Given a fresh factory database
      And "vera" is a viewer
      When the API starts from src/api/main.ts
      And "vera" sets the WIP limit override to 3 through port 7402 with a valid token
      Then the API answers 403
      And no override was recorded

    @ac-1 @db
    Scenario: An owner adds a user
      Given a fresh factory database
      And "olga" is an owner
      When the API starts from src/api/main.ts
      And "olga" adds "nina" as a viewer through port 7402 with a valid token
      Then the API accepts it
      And "nina" is a viewer

    @ac-1 @db
    Scenario Outline: Someone below owner can't add a user
      Given a fresh factory database
      And "<who>" is <role>
      When the API starts from src/api/main.ts
      And "<who>" adds "nina" as a viewer through port 7402 with a valid token
      Then the API answers 403
      And "nina" is not a user

      Examples:
        | who  | role        |
        | vera | a viewer    |
        | otto | an operator |

    @ac-1 @db
    Scenario: The Product Owner signs off an item's scenarios
      Given a fresh factory database where item "A" waits in SignOff
      And "pia" is a viewer who is the Product Owner
      When the API starts from src/api/main.ts
      And "pia" signs off item "A" through port 7402 with a valid token
      Then the API accepts it
      And item "A" leaves SignOff

    @ac-1 @db
    Scenario: An owner who isn't the Product Owner can't sign off
      Given a fresh factory database where item "A" waits in SignOff
      And "olga" is an owner who isn't the Product Owner
      When the API starts from src/api/main.ts
      And "olga" signs off item "A" through port 7402 with a valid token
      Then the API answers 403
      And item "A" is still in SignOff

    @ac-1 @db
    Scenario: An operator answers an item's question
      Given a fresh factory database where item "A" waits in NeedsInput with a question
      And "otto" is an operator
      When the API starts from src/api/main.ts
      And "otto" answers item "A"'s question through port 7402 with a valid token
      Then the API accepts it
      And item "A"'s question is answered

    @ac-1 @db
    Scenario: A viewer who isn't the Product Owner can't answer a question
      Given a fresh factory database where item "A" waits in NeedsInput with a question
      And "vera" is a viewer who isn't the Product Owner
      When the API starts from src/api/main.ts
      And "vera" answers item "A"'s question through port 7402 with a valid token
      Then the API answers 403
      And item "A"'s question is still open

    @ac-1 @db
    Scenario: GitHub's webhook is taken on a valid signature, with no bearer token
      Given a fresh factory database
      When the API starts from src/api/main.ts
      And GitHub delivers a comment webhook to port 7402 signed with the webhook secret and no bearer token
      Then the API accepts it
      And a webhook event is recorded for that delivery

    @ac-1 @db
    Scenario: GitHub's webhook with a bad signature is refused
      Given a fresh factory database
      When the API starts from src/api/main.ts
      And GitHub delivers a comment webhook to port 7402 signed with another secret
      Then the API answers 401
      And no webhook event is recorded

  Rule: A request without a good bearer token gets 401

    @ac-2 @db
    Scenario: A request with no bearer token gets 401
      Given a fresh factory database
      And "olga" is an owner
      When the API starts from src/api/main.ts
      And someone asks port 7402 for the floor with no Authorization header
      Then the API answers 401

    @ac-2 @db
    Scenario Outline: A token that fails a check gets 401, even for an owner
      Given a fresh factory database
      And "olga" is an owner
      When the API starts from src/api/main.ts
      And "olga" asks port 7402 for the floor with a token that <flaw>
      Then the API answers 401

      Examples:
        | flaw                                              |
        | names another issuer                              |
        | is for the audience "some-other-api"              |
        | carries no audience                               |
        | is signed by a key the issuer doesn't publish     |
        | has had its payload altered after signing         |
        | expired a minute ago                              |
        | isn't a JWT at all                                |

    @ac-2 @db
    Scenario: A token sent under another scheme than Bearer gets 401
      Given a fresh factory database
      And "olga" is an owner
      When the API starts from src/api/main.ts
      And "olga" sends a valid token to port 7402 under the "Basic" scheme
      Then the API answers 401

    @ac-2 @db
    Scenario: A refused token changes nothing
      Given a fresh factory database
      And "olga" is an owner
      When the API starts from src/api/main.ts
      And "olga" adds "nina" as a viewer through port 7402 with a token that expired a minute ago
      Then the API answers 401
      And "nina" is not a user

  Rule: Only people in the user table get in, checked on every request

    @ac-3 @db
    Scenario: A valid token for someone who isn't a user gets 403
      Given a fresh factory database
      And "sam" holds a valid token but is not a user
      When the API starts from src/api/main.ts
      And "sam" asks port 7402 for the floor with a valid token
      Then the API answers 403

    @ac-3 @db
    Scenario: A user known through another issuer isn't let in on this issuer's token for the same subject
      Given a fresh factory database
      And "vera" is a viewer known through another issuer
      When the API starts from src/api/main.ts
      And a valid token from the configured issuer carrying "vera"'s subject asks port 7402 for the floor
      Then the API answers 403

    @ac-3 @db
    Scenario: Removing a user ends their access on their next request
      Given a fresh factory database
      And "vera" is a viewer
      When the API starts from src/api/main.ts
      And "vera" asks port 7402 for the floor with a valid token
      And the API answers 200
      And "vera" is removed from the user table
      And "vera" asks port 7402 for the floor again with the same token
      Then the API answers 403

    @ac-3 @db
    Scenario: A removed operator can no longer set an override with a token that hasn't expired
      Given a fresh factory database
      And "otto" is an operator
      When the API starts from src/api/main.ts
      And "otto" is removed from the user table
      And "otto" sets the WIP limit override to 3 through port 7402 with a valid token
      Then the API answers 403
      And no override was recorded

  Rule: The API refuses to start when the issuer doesn't publish where its keys are

    @ac-4
    Scenario: Discovery with no jwks_uri stops the API before it listens
      Given the fake issuer's discovery document has no jwks_uri
      When the API starts from src/api/main.ts
      Then it exits with an error naming jwks_uri
      And nothing answers on port 7402

    @ac-4 @db
    Scenario: Discovery with a jwks_uri lets the API start
      Given a fresh factory database
      And "vera" is a viewer
      When the API starts from src/api/main.ts
      And "vera" asks port 7402 for the floor with a valid token
      Then the API answers 200
