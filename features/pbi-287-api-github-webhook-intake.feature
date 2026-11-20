@pbi-287
Feature: The orchestrator API takes GitHub's webhooks
  Step 6 of the control plane redesign (2026-11-07 design, §05, §07 and §12) makes the orchestrator API, on
  port 7402, the place GitHub's webhook deliveries land, at the same path as today: POST /webhooks/github.
  Only a delivery signed with the shared webhook secret gets in. GitHub may send the same delivery more than
  once, so each delivery id is acted on once. A new delivery is recorded as one webhook event, and in the same
  step the API queues the follow-up work that event needs: for a comment, one comment-command entry for each
  item, on any board, that the comment names. The event and its entries are kept together or not at all.
  The API never runs the comment's commands itself. The worker does that from the queued entries.
  Scenarios tagged @db need Postgres, which each test starts for itself, so cells and CI both run them.
  In these scenarios the webhook secret is "s3cret", and GitHub's deliveries carry no bearer token.

  Background:
    Given a fresh factory database
    And the API is configured with the webhook secret "s3cret"

  Rule: Only a delivery signed with the webhook secret gets in

    @ac-1 @db
    Scenario: A delivery signed with the webhook secret is accepted
      When the API starts from src/api/main.ts
      And GitHub delivers a comment on issue 42 to port 7402 as delivery "d-1", signed with "s3cret"
      Then the API answers 204
      And one webhook event is recorded for delivery "d-1"

    @ac-1 @db
    Scenario: A delivery signed with another secret is refused and leaves no trace
      When the API starts from src/api/main.ts
      And GitHub delivers a comment on issue 42 to port 7402 as delivery "d-1", signed with "not-the-secret"
      Then the API answers 401
      And no webhook event is recorded
      And no comment-command entry is queued
      And delivery "d-1" is not remembered as received

    @ac-1 @db
    Scenario: An unsigned delivery is refused
      When the API starts from src/api/main.ts
      And GitHub delivers a comment on issue 42 to port 7402 as delivery "d-1", with no signature
      Then the API answers 401
      And no webhook event is recorded

    @ac-1 @db
    Scenario: A delivery signed the old SHA-1 way is refused
      When the API starts from src/api/main.ts
      And GitHub delivers a comment on issue 42 to port 7402 as delivery "d-1", with only a SHA-1 signature made with "s3cret"
      Then the API answers 401
      And no webhook event is recorded

    @ac-1 @db
    Scenario: A delivery whose body was changed after signing is refused
      When the API starts from src/api/main.ts
      And GitHub delivers a comment on issue 42 to port 7402 as delivery "d-1", signed with "s3cret", and the body is altered in transit
      Then the API answers 401
      And no webhook event is recorded

    @ac-1 @db
    Scenario: A signed delivery with no delivery id is refused
      When the API starts from src/api/main.ts
      And GitHub delivers a comment on issue 42 to port 7402 with no delivery id, signed with "s3cret"
      Then the API answers 400
      And no webhook event is recorded

    @ac-1 @db
    Scenario: A signed delivery whose body isn't JSON is refused
      When the API starts from src/api/main.ts
      And GitHub delivers a body that isn't JSON to port 7402 as delivery "d-1", signed with "s3cret"
      Then the API answers 400
      And no webhook event is recorded

  Rule: Each delivery id is acted on once

    @ac-1 @db
    Scenario: A redelivery is acknowledged but records nothing new
      Given item "A" on a board has issue number 42
      When the API starts from src/api/main.ts
      And GitHub delivers a comment on issue 42 to port 7402 as delivery "d-1", signed with "s3cret"
      And GitHub delivers the same comment to port 7402 again as delivery "d-1", signed with "s3cret"
      Then the API answers 204 to the first delivery
      And the API answers 200 to the second delivery
      And one webhook event is recorded for delivery "d-1"
      And one comment-command entry is queued for item "A"

    @ac-1 @db
    Scenario: The same delivery arriving twice at once is recorded once
      Given item "A" on a board has issue number 42
      When the API starts from src/api/main.ts
      And GitHub delivers a comment on issue 42 to port 7402 as delivery "d-1" twice at the same moment, both signed with "s3cret"
      Then one delivery is answered 204 and the other 200
      And one webhook event is recorded for delivery "d-1"
      And one comment-command entry is queued for item "A"

    @ac-1 @db
    Scenario: Two different deliveries with the same content are both recorded
      When the API starts from src/api/main.ts
      And GitHub delivers a comment on issue 42 to port 7402 as delivery "d-1", signed with "s3cret"
      And GitHub delivers the same comment to port 7402 as delivery "d-2", signed with "s3cret"
      Then the API answers 204 to both deliveries
      And one webhook event is recorded for delivery "d-1"
      And one webhook event is recorded for delivery "d-2"

    @ac-1 @db
    Scenario: A delivery refused for its signature can still be accepted when GitHub resends it signed
      When the API starts from src/api/main.ts
      And GitHub delivers a comment on issue 42 to port 7402 as delivery "d-1", signed with "not-the-secret"
      And GitHub delivers the same comment to port 7402 again as delivery "d-1", signed with "s3cret"
      Then the API answers 401 to the first delivery
      And the API answers 204 to the second delivery
      And one webhook event is recorded for delivery "d-1"

  Rule: A new delivery is recorded as a webhook event, together with the work it queues

    @ac-1 @db
    Scenario: The webhook event records what GitHub sent
      When the API starts from src/api/main.ts
      And GitHub delivers a comment "/approve" by "olive" on issue 42 to port 7402 as delivery "d-1", signed with "s3cret"
      Then one webhook event is recorded for delivery "d-1"
      And that event is GitHub's, names the GitHub event "issue_comment", and carries the comment "/approve" by "olive" on issue 42

    @ac-1 @db
    Scenario: A comment queues one comment-command entry per item it names, across boards
      Given item "A" on the first board has issue number 42
      And item "B" on a second board also has issue number 42
      And item "C" has issue number 7
      When the API starts from src/api/main.ts
      And GitHub delivers a comment on issue 42 to port 7402 as delivery "d-1", signed with "s3cret"
      Then one comment-command entry is queued for item "A", caused by the webhook event for delivery "d-1"
      And one comment-command entry is queued for item "B", caused by the webhook event for delivery "d-1"
      And no comment-command entry is queued for item "C"

    @ac-1 @db
    Scenario: A comment on an issue no board holds queues nothing
      Given item "A" has issue number 7
      When the API starts from src/api/main.ts
      And GitHub delivers a comment on issue 42 to port 7402 as delivery "d-1", signed with "s3cret"
      Then the API answers 204
      And one webhook event is recorded for delivery "d-1"
      And no comment-command entry is queued

    @ac-1 @db
    Scenario: A delivery that isn't a comment is recorded and queues no comment command
      Given item "A" has issue number 42
      When the API starts from src/api/main.ts
      And GitHub delivers a change to issue 42 to port 7402 as delivery "d-1", signed with "s3cret"
      Then the API answers 204
      And one webhook event is recorded for delivery "d-1"
      And no comment-command entry is queued

    @ac-1 @db
    Scenario: The API doesn't carry out a comment's command itself
      Given item "A" has issue number 42 and waits for the owner's sign-off
      And "olive" is the owner with GitHub login "olive"
      When the API starts from src/api/main.ts
      And GitHub delivers a comment "/approve" by "olive" on issue 42 to port 7402 as delivery "d-1", signed with "s3cret"
      Then one comment-command entry is queued for item "A"
      And item "A" still waits for the owner's sign-off

    @ac-1 @db
    Scenario: When the event can't be recorded, nothing of the delivery is kept, so GitHub's retry gets in
      Given item "A" has issue number 42
      And the factory database refuses new events
      When the API starts from src/api/main.ts
      And GitHub delivers a comment on issue 42 to port 7402 as delivery "d-1", signed with "s3cret"
      Then the API answers with a server error
      And no comment-command entry is queued
      And delivery "d-1" is not remembered as received
