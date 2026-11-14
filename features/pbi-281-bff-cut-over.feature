@pbi-281
Feature: The BFF takes over port 7400 and the GitHub webhook, and today's dashboard code goes
  Step 9a of the control plane redesign (2026-11-07 design, §05, §10, §11 and §12) is the cut-over. The BFF
  leaves 7403 and answers on 7400, the address today's dashboard has always had, so people open the factory
  where they always did. It takes over POST /webhooks/github and passes each delivery's bytes and headers to
  the API untouched, so the API's signature check and de-duplication by delivery id work as they do today.
  People sign in through Keycloak at the new address: the dashboard client already accepts redirects to 7400.
  Today's combined control plane goes: src/main.ts, the server-rendered pages in src/http/routes.ts and
  src/http/views.ts, the dev token and its /dev-login link. Nothing starts or imports them any more, and the
  owner's docs say to sign in at 7400 rather than open a link from the control console.
  Removing the dev owner and the provider column is not part of this step.
  Scenarios without a tag read the repo, so CI and cells run them. Scenarios tagged @db need Postgres, which
  each test starts for itself, and run the BFF and the API against a fake identity provider. The scenarios
  tagged @local need Docker, the Aspire CLI and the owner's secrets, so the owner runs them and the PR records the run.

  Rule: The BFF answers on port 7400 in place of today's control plane

    @ac-1
    Scenario: The AppHost pins the BFF to port 7400
      When I read the AppHost
      Then it adds a BFF resource started from src/bff/main.ts on port 7400
      And no resource listens on port 7403

    @ac-1
    Scenario: The AppHost no longer starts today's control plane
      When I read the AppHost
      Then no resource is started from src/main.ts
      And no resource is named "control"

    @ac-1 @db
    Scenario: The BFF started without a port answers on 7400
      Given a fresh factory database
      And the BFF's environment doesn't set PORT
      When the BFF starts
      Then the BFF answers on port 7400
      And nothing answers on port 7403

    @ac-1 @local
    Scenario: aspire run serves the factory dashboard from the BFF on 7400
      When I start "aspire run" and wait until the BFF resource is healthy
      Then "http://localhost:7400" serves the factory's single-page app
      And nothing answers on "http://localhost:7403"
      And the Aspire dashboard lists no "control" resource

  Rule: The BFF takes over the GitHub webhook and passes deliveries to the API untouched

    @ac-1 @db
    Scenario: A signed GitHub delivery to 7400 is recorded by the API
      Given a fresh factory database
      And the BFF on port 7400 in front of the API, both sharing the webhook secret "hook-secret"
      When GitHub posts an issue comment delivery "d-1" to "/webhooks/github" on port 7400, signed with "hook-secret"
      Then the BFF answers with the API's success status
      And the factory has recorded one webhook event for delivery "d-1"
      And the recorded payload is byte for byte the delivery GitHub sent

    @ac-1 @db
    Scenario: A delivery with a wrong signature is refused and not recorded
      Given a fresh factory database
      And the BFF on port 7400 in front of the API, both sharing the webhook secret "hook-secret"
      When GitHub posts an issue comment delivery "d-2" to "/webhooks/github" on port 7400, signed with "another-secret"
      Then the BFF answers 401
      And the factory has recorded no webhook event

    @ac-1 @db
    Scenario: A delivery with no signature is refused and not recorded
      Given a fresh factory database
      And the BFF on port 7400 in front of the API, both sharing the webhook secret "hook-secret"
      When GitHub posts an issue comment delivery "d-3" to "/webhooks/github" on port 7400 with no signature
      Then the BFF answers 401
      And the factory has recorded no webhook event

    @ac-1 @db
    Scenario: GitHub redelivering the same delivery is recorded once
      Given a fresh factory database
      And the BFF on port 7400 in front of the API, both sharing the webhook secret "hook-secret"
      When GitHub posts an issue comment delivery "d-4" to "/webhooks/github" on port 7400, signed with "hook-secret"
      And GitHub posts delivery "d-4" again, signed with "hook-secret"
      Then the BFF answers both with the API's success status
      And the factory has recorded one webhook event for delivery "d-4"

    @ac-1 @db
    Scenario: The webhook needs no signed-in session and no Origin
      Given a fresh factory database
      And the BFF on port 7400 in front of the API, both sharing the webhook secret "hook-secret"
      When GitHub posts an issue comment delivery "d-5" to "/webhooks/github" on port 7400, signed with "hook-secret", with no session cookie and no Origin header
      Then the BFF answers with the API's success status
      And the factory has recorded one webhook event for delivery "d-5"

  Rule: People sign in through Keycloak at the new address

    @ac-1 @db
    Scenario: Starting sign-in on 7400 sends the browser to the identity provider with a callback on 7400
      Given a fresh factory database
      And the BFF on port 7400 in front of the API, pointed at a fake identity provider
      When a browser with no session asks port 7400 for "/auth/login"
      Then the BFF redirects it to the identity provider's sign-in page
      And the redirect asks to come back to "http://localhost:7400/auth/callback"

    @ac-1 @db
    Scenario: Coming back from the identity provider on 7400 signs the person in
      Given a fresh factory database with an owner known to the fake identity provider
      And the BFF on port 7400 in front of the API, pointed at that fake identity provider
      When the owner starts sign-in on port 7400 and the identity provider sends them back to "/auth/callback" on port 7400
      Then the BFF sets a session cookie for port 7400
      And the owner's next call to "/bff/v1/floor" on port 7400 shows the Floor

    @ac-1 @local
    Scenario: The test owner signs in through Keycloak at http://localhost:7400
      Given "aspire run" is up
      When I open "http://localhost:7400" with no session
      Then I'm sent to Keycloak's sign-in page on port 7430
      When I sign in there as the test owner
      Then I'm back on "http://localhost:7400" signed in
      And the Floor shows

    @ac-1
    Scenario: The owner's docs say to sign in at port 7400
      When I read README.md and scripts/factory.ps1
      Then they tell the owner to open "http://localhost:7400" and sign in with Keycloak
      And neither tells the owner to open a sign-in link from the "control" resource's console

  Rule: Today's dashboard code is gone

    @ac-2
    Scenario Outline: <file> is gone from the repo
      When I look for "<file>" in the repo
      Then it isn't there

      Examples:
        | file               |
        | src/main.ts        |
        | src/http/routes.ts |
        | src/http/views.ts  |

    @ac-2
    Scenario: No source file, step or script uses today's dashboard code
      When I search the repo's source files, step definitions and package scripts
      Then none imports or starts "src/main.ts", "src/http/routes.ts" or "src/http/views.ts"

  Rule: The dev token and /dev-login are gone

    @ac-2
    Scenario: No code makes or checks a dev token
      When I search the repo's source files
      Then no source file makes, logs or checks a dev token
      And no source file handles "/dev-login"

    @ac-2 @db
    Scenario: /dev-login on 7400 is not found and signs nobody in
      Given a fresh factory database with a dev owner
      And the BFF on port 7400 in front of the API
      When a browser with no session asks port 7400 for "/dev-login?token=anything"
      Then the BFF answers 404
      And it sets no session cookie
      And the browser's next call to "/bff/v1/floor" on port 7400 gets 401

    @ac-2 @local
    Scenario: No console under aspire run shows a dev sign-in link
      When I start "aspire run" and wait until every resource is healthy
      Then no resource's console shows a "/dev-login" link
      And "http://localhost:7400/dev-login" signs nobody in
