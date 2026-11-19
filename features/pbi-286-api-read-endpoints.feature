@pbi-286
Feature: The orchestrator API's read endpoints: events, floor, items and activity
  Step 6c of the control plane redesign (2026-11-07 design, §05) gives the orchestrator API on port 7402
  the four read endpoints the new dashboard needs. The live event stream ends each stream after five
  minutes, so a removed user's reconnect meets the per-request user check. Floor carries the Claude token
  banner and the worker's heartbeat. Run detail reads the acceptance criteria and the scenario files from
  the snapshot stored with the run, because the API holds no GitHub credentials. The activity log
  returns what today's /activity page shows, and nothing it hides.
  PBI 284 (step 6a) already built the event stream, the floor's banner and heartbeat, and Run detail's
  reading of the snapshot. The scenarios for those three criteria hold that behaviour as this item's
  contract, so they are tagged @regression and pass before the build. The activity log is new.
  Scenarios tagged @db need Postgres, which each test starts for itself, so cells and CI both run them.
  They run the API against a fake issuer that publishes its own discovery document and signing keys,
  and a "valid token" is one that issuer signed, for the API's audience, and not expired.

  Background:
    Given a fake issuer publishing a discovery document and its signing keys
    And the API is configured with that issuer and the audience "factory-api"

  Rule: The event stream carries the factory's events and ends after five minutes

    @ac-1 @db @regression
    Scenario: An event recorded while the stream is open reaches it
      Given a fresh factory database with item "A"
      And "vera" is a viewer
      When the API starts from src/api/main.ts
      And "vera" opens the event stream on port 7402 with a valid token
      And the factory records an event for item "A"
      Then "vera"'s stream delivers that event

    @ac-1 @db @regression
    Scenario: Every open stream gets the same event
      Given a fresh factory database with item "A"
      And "vera" is a viewer
      And "otto" is an operator
      When the API starts from src/api/main.ts
      And "vera" opens the event stream on port 7402 with a valid token
      And "otto" opens the event stream on port 7402 with a valid token
      And the factory records an event for item "A"
      Then "vera"'s stream delivers that event
      And "otto"'s stream delivers that event

    @ac-1 @db @regression
    Scenario: A stream is still open just before five minutes
      Given a fresh factory database
      And "vera" is a viewer
      When the API starts from src/api/main.ts
      And "vera" opens the event stream on port 7402 with a valid token
      And 4 minutes and 59 seconds pass
      Then "vera"'s stream is still open

    @ac-1 @db @regression
    Scenario: The API ends a stream after five minutes
      Given a fresh factory database
      And "vera" is a viewer
      When the API starts from src/api/main.ts
      And "vera" opens the event stream on port 7402 with a valid token
      And 5 minutes pass
      Then the API has ended "vera"'s stream

    @ac-1 @db @regression
    Scenario: A user removed while their stream is open can't reconnect once it ends
      Given a fresh factory database
      And "vera" is a viewer
      When the API starts from src/api/main.ts
      And "vera" opens the event stream on port 7402 with a valid token
      And "vera" is removed from the user table
      And 5 minutes pass
      And "vera" opens the event stream again with the same token
      Then the API has ended "vera"'s first stream
      And the API answers 403

  Rule: Floor carries the Claude token banner and the worker's heartbeat

    @ac-2 @db @regression
    Scenario: A token near the end of its life shows the banner on the floor
      Given a fresh factory database
      And the Claude token was created 340 days ago
      And "vera" is a viewer
      When the API starts from src/api/main.ts
      And "vera" asks port 7402 for the floor with a valid token
      Then the floor shows the Claude token's age as 340 days
      And the floor's banner says the Claude token expires in 25 days

    @ac-2 @db @regression
    Scenario: A token with plenty of life left shows its age and no banner
      Given a fresh factory database
      And the Claude token was created 80 days ago
      And "vera" is a viewer
      When the API starts from src/api/main.ts
      And "vera" asks port 7402 for the floor with a valid token
      Then the floor shows the Claude token's age as 80 days
      And the floor has no banner

    @ac-2 @db @regression
    Scenario: A factory with no token creation date shows no token and no banner
      Given a fresh factory database
      And the Claude token's creation date isn't set
      And "vera" is a viewer
      When the API starts from src/api/main.ts
      And "vera" asks port 7402 for the floor with a valid token
      Then the floor shows no Claude token
      And the floor has no banner

    @ac-2 @db @regression
    Scenario: The floor shows when the worker last sent a heartbeat
      Given a fresh factory database
      And the worker last sent a heartbeat at 09:14
      And "vera" is a viewer
      When the API starts from src/api/main.ts
      And "vera" asks port 7402 for the floor with a valid token
      Then the floor shows the worker's last heartbeat as 09:14

    @ac-2 @db @regression
    Scenario: A worker that has never sent a heartbeat shows none on the floor
      Given a fresh factory database
      And the worker has never sent a heartbeat
      And "vera" is a viewer
      When the API starts from src/api/main.ts
      And "vera" asks port 7402 for the floor with a valid token
      Then the floor shows no worker heartbeat

  Rule: Run detail reads the criteria and the scenario files from the run's snapshot, never from GitHub

    @ac-3 @db @regression
    Scenario: Run detail shows the criteria and the files stored with the run
      Given a fresh factory database with item "A"
      And item "A"'s run has a snapshot with the criteria "Exports a month" and "Shows the total"
      And the snapshot holds the file "features/pbi-A-export.feature" with the text "Feature: Export a month"
      And a GitHub stand-in that records every call made to it
      And "vera" is a viewer
      When the API starts from src/api/main.ts
      And "vera" asks port 7402 for item "A" with a valid token
      Then Run detail lists the criteria "Exports a month" and "Shows the total", in that order
      And Run detail shows the file "features/pbi-A-export.feature" with the text "Feature: Export a month"
      And the GitHub stand-in received no call

    @ac-3 @db @regression
    Scenario: A run with no snapshot shows no criteria and no files, and still makes no GitHub call
      Given a fresh factory database with item "A"
      And item "A"'s run has a scenarios sha but no snapshot
      And a GitHub stand-in that records every call made to it
      And "vera" is a viewer
      When the API starts from src/api/main.ts
      And "vera" asks port 7402 for item "A" with a valid token
      Then Run detail shows no criteria
      And Run detail shows no files
      And the GitHub stand-in received no call

    @ac-3 @db @regression
    Scenario: An item with several runs shows its latest run's snapshot
      Given a fresh factory database with item "A"
      And item "A"'s first run has a snapshot with the criterion "Old criterion"
      And item "A"'s second run has a snapshot with the criterion "New criterion"
      And a GitHub stand-in that records every call made to it
      And "vera" is a viewer
      When the API starts from src/api/main.ts
      And "vera" asks port 7402 for item "A" with a valid token
      Then Run detail lists the criterion "New criterion"
      And Run detail doesn't list "Old criterion"
      And the GitHub stand-in received no call

    @ac-3 @db @regression
    Scenario: An unknown item gets 404 without a GitHub call
      Given a fresh factory database
      And a GitHub stand-in that records every call made to it
      And "vera" is a viewer
      When the API starts from src/api/main.ts
      And "vera" asks port 7402 for an item that doesn't exist with a valid token
      Then the API answers 404
      And the GitHub stand-in received no call

  Rule: The activity log returns the 100 newest events, newest first, as today's /activity page lists them

    @ac-4 @db
    Scenario Outline: A signed-in <role> reads the activity log
      Given a fresh factory database
      And item "95" titled "Export a month" was claimed
      And "pat" is <role>
      When the API starts from src/api/main.ts
      And "pat" asks port 7402 for the activity log with a valid token
      Then the API answers 200
      And the log lists the claim of item "95"

      Examples:
        | role        |
        | a viewer    |
        | an operator |
        | an owner    |

    @ac-4 @db
    Scenario: Each row carries the event's time, item, title, kind and, for a move, its states
      Given a fresh factory database
      And item "95" titled "Export a month" was claimed at 09:00, moving from "Queued" to "InProgress" on "claimed"
      And an operator stopped item "95"'s run at 09:05, moving it from "InProgress" to "Failed"
      And the owner approved item "95"'s sign-off at 09:10, recorded as a "decision" event
      And "vera" is a viewer
      When the API starts from src/api/main.ts
      And "vera" asks port 7402 for the activity log with a valid token
      Then the log lists 3 events, the 09:10 one first, then the 09:05 one, then the 09:00 one
      And the 09:00 row has its time, "95", "Export a month", "transition", "Queued", "InProgress" and "claimed"
      And the 09:05 row has its time, "95", "Export a month", "override", "InProgress" and "Failed"
      And the 09:10 row has its time, "95", "Export a month" and "decision", and no states

    @ac-4 @db
    Scenario: A row names the repo of the item's issue, as the page's link does
      Given a fresh factory database
      And item "95" from the repo "acme/shop" was claimed
      And "vera" is a viewer
      When the API starts from src/api/main.ts
      And "vera" asks port 7402 for the activity log with a valid token
      Then the claim's row names item "95" in the repo "acme/shop"

    @ac-4 @db
    Scenario: A setting change says who changed which setting, from what, to what, and why
      Given a fresh factory database
      And "octo" changed review capacity from "3" to "5" because "the queue is long"
      And "vera" is a viewer
      When the API starts from src/api/main.ts
      And "vera" asks port 7402 for the activity log with a valid token
      Then the log has a setting row saying "octo" changed review capacity from "3" to "5" because "the queue is long"
      And that row names no item

    @ac-4 @db
    Scenario: Only the 100 most recent events are listed
      Given a fresh factory database
      And the factory has recorded 105 events, one a minute
      And "vera" is a viewer
      When the API starts from src/api/main.ts
      And "vera" asks port 7402 for the activity log with a valid token
      Then the log lists 100 events
      And the first row is the newest event
      And the 5 oldest events are not listed

    @ac-4 @db
    Scenario: A factory with no events returns an empty log
      Given a fresh factory database
      And the factory has recorded no events
      And "vera" is a viewer
      When the API starts from src/api/main.ts
      And "vera" asks port 7402 for the activity log with a valid token
      Then the API answers 200
      And the log lists no events

    @ac-4 @db
    Scenario: An event of another kind carries no states, even if it has some
      Given a fresh factory database
      And item "95" has a "comment" event that carries a "from" of "Queued" and a "to" of "Failed"
      And "vera" is a viewer
      When the API starts from src/api/main.ts
      And "vera" asks port 7402 for the activity log with a valid token
      Then the "comment" row has no states

  Rule: Nothing the activity page hides reaches the activity log's response

    @ac-4 @db
    Scenario: A transition's other details stay out of the response
      Given a fresh factory database
      And item "95" failed readiness with the dor.md line "Has a Size of 5 or less" and a detail "run-token-7f3a"
      And "vera" is a viewer
      When the API starts from src/api/main.ts
      And "vera" asks port 7402 for the activity log with a valid token
      Then the item's row has "Eligible", "NotReady" and "readiness_failed"
      And the response doesn't contain "Has a Size of 5 or less"
      And the response doesn't contain "run-token-7f3a"

    @ac-4 @db
    Scenario: An override's reason stays out of the response
      Given a fresh factory database
      And an operator stopped item "95"'s run with the reason "secret-reason-91c2"
      And "vera" is a viewer
      When the API starts from src/api/main.ts
      And "vera" asks port 7402 for the activity log with a valid token
      Then the item's row has "InProgress" and "Failed"
      And the response doesn't contain "secret-reason-91c2"

    @ac-4 @db
    Scenario: A decision's text stays out of the response
      Given a fresh factory database
      And the owner approved item "95"'s sign-off with the text "decision-text-5d1e"
      And "vera" is a viewer
      When the API starts from src/api/main.ts
      And "vera" asks port 7402 for the activity log with a valid token
      Then the log lists the "decision" event
      And the response doesn't contain "decision-text-5d1e"
