@pbi-290
Feature: The BFF passes GitHub webhooks and the live event stream through to the API
  Step 7c of the control plane redesign (2026-11-07 design, §03 and §05) finishes the BFF's forwarding. GitHub
  sends its webhooks to the BFF, because the API takes no traffic from outside. The BFF hands each delivery to
  the API's /webhooks/github with its bytes and headers just as GitHub sent them. It doesn't check the
  signature: the API checks it against the webhook secret, which only the API holds, and the API's answer goes
  back to GitHub. A delivery needs no session and carries no Origin, so neither the session check nor the
  Origin guard applies to it.
  The dashboard's live view reads /bff/v1/events, which the BFF streams from the API's /v1/events. Each event
  reaches the browser as the API sends it. The stream stays open for as long as the API keeps it open, past the
  30 seconds the BFF gives an ordinary call to answer, until the API ends it after five minutes and the browser
  reconnects.
  Sign-in and sessions came in step 7a (pbi-288), and forwarding the dashboard's other calls came in step 7b
  (pbi-289). Building the API's routes is not part of this step: these scenarios forward to a stand-in API that
  records each call it gets and answers as a scenario tells it.
  Scenarios tagged @db need Postgres, which each test starts for itself, and a test sign-in provider and the
  stand-in API, which the test also starts, so CI and cells run them.

  Background:
    Given a test sign-in provider is running with the user "alice"
    And a stand-in API is running
    And the BFF is running against that provider as its issuer and that stand-in as its API

  Rule: A GitHub webhook reaches the API's /webhooks/github byte for byte, with every header GitHub sent

    @ac-1 @db
    Scenario: A signed delivery reaches the API with its body and GitHub's headers unchanged
      Given a GitHub "issue_comment" delivery "d-1001" whose body has GitHub's own spacing and key order
      And the delivery is signed with the webhook secret
      When GitHub posts the delivery to the BFF at "/webhooks/github"
      Then the API received one call, POST "/webhooks/github"
      And that call's body is byte for byte the body GitHub sent
      And that call carried these headers with the values GitHub sent:
        | header                                 |
        | Content-Type                           |
        | User-Agent                             |
        | X-GitHub-Event                         |
        | X-GitHub-Delivery                      |
        | X-GitHub-Hook-ID                       |
        | X-GitHub-Hook-Installation-Target-Type |
        | X-GitHub-Hook-Installation-Target-ID   |
        | X-Hub-Signature                        |
        | X-Hub-Signature-256                    |

    @ac-1 @db
    Scenario: A form-encoded delivery reaches the API as GitHub encoded it
      Given a GitHub "pull_request_review" delivery "d-1002" sent form-encoded, with its JSON in the payload field
      When GitHub posts the delivery to the BFF at "/webhooks/github"
      Then the API received one call, POST "/webhooks/github"
      And that call's body is byte for byte the body GitHub sent
      And that call carried the Content-Type "application/x-www-form-urlencoded"

    @ac-1 @db
    Scenario: A body with bytes that aren't valid text reaches the API unchanged
      Given a GitHub "push" delivery "d-1003" whose body holds bytes that aren't valid UTF-8
      When GitHub posts the delivery to the BFF at "/webhooks/github"
      Then the API received one call, POST "/webhooks/github"
      And that call's body is byte for byte the body GitHub sent

    @ac-1 @db
    Scenario: A large delivery reaches the API whole
      Given a GitHub "push" delivery "d-1004" with a body of 5 MB
      When GitHub posts the delivery to the BFF at "/webhooks/github"
      Then the API received one call, POST "/webhooks/github"
      And that call's body is byte for byte the body GitHub sent

    @ac-1 @db
    Scenario: A header the BFF has never heard of goes through too
      Given a GitHub "issue_comment" delivery "d-1005" with the extra header "X-GitHub-Future" set to "kept-as-is"
      When GitHub posts the delivery to the BFF at "/webhooks/github"
      Then the API received one call, POST "/webhooks/github"
      And that call carried the header "X-GitHub-Future" with the value "kept-as-is"

  Rule: A webhook needs no session, and the BFF adds nothing of its own to it

    @ac-1 @db
    Scenario: A delivery with no session cookie and no Origin still reaches the API
      Given a GitHub "issue_comment" delivery "d-1006"
      When GitHub posts the delivery to the BFF at "/webhooks/github" with no cookie and no Origin
      Then the API received one call, POST "/webhooks/github"

    @ac-1 @db
    Scenario: The BFF adds no bearer token to a delivery
      Given "alice" has signed in through the BFF
      And a GitHub "issue_comment" delivery "d-1007"
      When GitHub posts the delivery to the BFF at "/webhooks/github"
      Then the API received one call, POST "/webhooks/github"
      And that call carried no Authorization header
      And that call didn't carry alice's access token

  Rule: The API judges the delivery, and its answer goes back to GitHub as it gave it

    @ac-1 @db
    Scenario: A delivery with a wrong signature still reaches the API, which refuses it
      Given a GitHub "issue_comment" delivery "d-1008" signed with the wrong secret
      And the API will answer POST "/webhooks/github" with 401 and the body "bad signature"
      When GitHub posts the delivery to the BFF at "/webhooks/github"
      Then the API received one call, POST "/webhooks/github"
      And that call carried the X-Hub-Signature-256 GitHub sent
      And the BFF answers 401 with the body "bad signature"

    @ac-1 @db
    Scenario: The API's acceptance goes back to GitHub
      Given a GitHub "issue_comment" delivery "d-1009"
      And the API will answer POST "/webhooks/github" with 202 and the body "accepted"
      When GitHub posts the delivery to the BFF at "/webhooks/github"
      Then the BFF answers 202 with the body "accepted"

    @ac-1 @db
    Scenario: When the API doesn't answer, GitHub gets 502 so it can redeliver
      Given a GitHub "issue_comment" delivery "d-1010"
      And the API is down
      When GitHub posts the delivery to the BFF at "/webhooks/github"
      Then the BFF answers 502

  Rule: /bff/v1/events streams the API's events to the browser as the API sends them, for as long as the API keeps the stream open

    @ac-2 @db
    Scenario: An event the API sends 45 seconds into the stream reaches the browser while the stream is open
      Given "alice" has signed in through the BFF
      And the API will hold "/v1/events" open and send the event "item-moved" after 45 seconds
      When alice's browser opens the event stream at "/bff/v1/events"
      Then the API received one call, GET "/v1/events"
      And that call carried alice's current access token as a bearer token
      And alice's browser receives the event "item-moved" after about 45 seconds
      And alice's event stream is still open after it receives "item-moved"

    @ac-2 @db
    Scenario: Events reach the browser one by one, in the order the API sent them
      Given "alice" has signed in through the BFF
      And the API will hold "/v1/events" open and send these events:
        | after      | event       |
        | 5 seconds  | item-moved  |
        | 40 seconds | item-held   |
        | 70 seconds | run-started |
      When alice's browser opens the event stream at "/bff/v1/events"
      Then alice's browser receives each event at about the time the API sent it
      And alice's browser receives "item-moved", "item-held" and "run-started" in that order

    @ac-2 @db
    Scenario: When the API ends the stream, the browser's stream ends cleanly so it can reconnect
      Given "alice" has signed in through the BFF
      And the API will hold "/v1/events" open, send the event "item-moved" after 50 seconds, and end the stream after 60 seconds
      When alice's browser opens the event stream at "/bff/v1/events"
      Then alice's browser receives the event "item-moved"
      And alice's event stream ends after about 60 seconds without an error

    @ac-2 @db
    Scenario: The API's stream stays open while the browser listens, and closes when the browser leaves
      Given "alice" has signed in through the BFF
      And the API will hold "/v1/events" open until its caller leaves
      When alice's browser opens the event stream at "/bff/v1/events"
      And alice's browser keeps listening for 45 seconds and then closes the stream
      Then the API's stream to the BFF was still open after 40 seconds
      And the API's stream to the BFF closes within 5 seconds of the browser closing its own
