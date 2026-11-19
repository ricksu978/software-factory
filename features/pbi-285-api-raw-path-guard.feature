@pbi-285
Feature: The orchestrator API refuses any path it would read differently from how it arrived
  Step 6b of the control plane redesign (2026-11-07 design, §05 and §13) checks that the Hono API keeps the
  dashboard's path guarantee. The guarantee is that no request can look like one route to a proxy in front
  of the API and then land on a different route inside it. So the API refuses a path when the path it
  received differs from its normalised form, or when the path contains an encoded dot, slash or backslash
  (%2e, %2f or %5c, in either case). The query string doesn't count.
  Today's dashboard routes on the path exactly as it arrived (src/http/routes.ts). Hono decodes
  percent-encoded characters before it routes, so "/%761/floor" reaches the floor even though the raw path
  never says "/v1". The API must refuse any path whose decoded form differs from the path it received, as
  well as dot segments and encoded separators.
  "Sent exactly as written" means the request goes out with its path untouched. An ordinary HTTP client
  would tidy the path before sending it.
  "Refuses it as a bad path" means the API answers 400 and says the path is bad, before any route or
  sign-in check sees the request.
  Scenarios tagged @db need Postgres, which each test starts for itself, so cells and CI both run them. They
  run the API against a fake issuer that publishes its own discovery document and signing keys. Here a
  "valid token" is one the fake issuer signed, for the API's audience, and not expired.

  Background:
    Given a fake issuer publishing a discovery document and its signing keys
    And the API is configured with that issuer and the audience "factory-api"

  Rule: The API keeps the guarantees today's dashboard routing tests check

    @ac-1 @db @regression
    Scenario Outline: A sign-off sent along a path with dot segments never reaches the item
      Given a fresh factory database where item "A" waits in SignOff
      And "pia" is a viewer who is the Product Owner
      When the API starts from src/api/main.ts
      And "pia" signs off item "A" along "<path>" sent exactly as written, with a valid token
      Then the API refuses it as a bad path
      And item "A" is still in SignOff

      Examples:
        | path                                                |
        | /webhooks/github/%2e%2e/%2e%2e/v1/items/A/decisions |
        | /v1/items/%2e/A/decisions                           |
        | /x/../v1/items/A/decisions                          |
        | /v1/./items/A/decisions                             |

    @ac-1 @db @regression
    Scenario Outline: A path with an encoded dot, slash or backslash is refused in either case
      Given a fresh factory database with item "A"
      And "olga" is an owner
      When the API starts from src/api/main.ts
      And "olga" asks for "<path>" sent exactly as written, with a valid token
      Then the API refuses it as a bad path

      Examples:
        | path                 |
        | GET /v1/items%2fA    |
        | GET /v1/items%2FA    |
        | GET /v1/items%5cA    |
        | GET /v1/items%5CA    |
        | GET /v1/%2e%2e/floor |
        | GET /v1/%2E%2E/floor |

  Rule: A path the API would decode into another path is refused

    @ac-1 @db
    Scenario Outline: A viewer's request that spells part of a route in percent-encoding is refused
      Given a fresh factory database with item "A"
      And "vera" is a viewer
      When the API starts from src/api/main.ts
      And "vera" asks for "<path>" sent exactly as written, with a valid token
      Then the API refuses it as a bad path

      Examples:
        | path              |
        | GET /%761/floor   |
        | GET /v1/flo%6fr   |
        | GET /v1/ph%61se0  |
        | GET /v1/item%73/A |

    @ac-1 @db
    Scenario: A sign-off sent to a percent-encoded route never reaches the item
      Given a fresh factory database where item "A" waits in SignOff
      And "pia" is a viewer who is the Product Owner
      When the API starts from src/api/main.ts
      And "pia" signs off item "A" along "/v1/items/A/decisi%6fns" sent exactly as written, with a valid token
      Then the API refuses it as a bad path
      And item "A" is still in SignOff

    @ac-1 @db
    Scenario: An operator's override sent to a percent-encoded route is not recorded
      Given a fresh factory database
      And "otto" is an operator
      When the API starts from src/api/main.ts
      And "otto" pauses the factory with reason "maintenance" along "/v1/overrid%65s" sent exactly as written, with a valid token
      Then the API refuses it as a bad path
      And no override is recorded

    @ac-1 @db
    Scenario Outline: A signed GitHub delivery sent to a percent-encoded webhook path is not taken
      Given a fresh factory database
      When the API starts from src/api/main.ts
      And GitHub delivers a comment webhook along "<path>" sent exactly as written, signed with the webhook secret
      Then the API refuses it as a bad path
      And no webhook event is recorded

      Examples:
        | path               |
        | /%77ebhooks/github |
        | /webhooks/githu%62 |
