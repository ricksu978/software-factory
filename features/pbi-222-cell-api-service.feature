@pbi-222
Feature: The cell API runs as its own service on port 7401
  Step 4a of the control plane redesign (2026-11-07 design, §06 and §12) moves the cell API and the model
  gateway out of today's control plane into a service of their own, started from src/cell-api/main.ts and
  answering on port 7401. It keeps its routes as they are today: lease, github-token, context,
  policy-results, pr, checks, stage, transition and upload-url, plus the model gateway under /internal/model.
  Today's control plane, src/main.ts, stops serving them, so a cell's call is answered by one service only.
  Today's control plane takes its own port from PORT rather than from the cell API's address, so the old
  dashboard stays on 7400 once cells are pointed at 7401.
  Scenarios tagged @db need Postgres, which each test starts for itself, so cells and CI both run them.
  They run the services against a fake board, a fake repo host and a fake model upstream.

  Rule: The cell API service answers cells on port 7401

    @ac-1 @db
    Scenario: A cell reports a stage to the cell API service on 7401
      Given a fresh factory database where item "A" was claimed, so its run is in progress at lease generation 1
      When the cell API service starts on port 7401
      And the cell reports stage "understand" attempt 1 as "started" to port 7401 with its token
      Then the cell API answers 200
      And item "A"'s run has 1 stage run

    @ac-1 @db
    Scenario Outline: Every one of today's cell routes is served by the cell API service, fenced as today
      Given a fresh factory database where item "A" was claimed, so its run is in progress at lease generation 1
      And item "A"'s lease expired and it was claimed again, so the first cell's token is from an older generation
      When the cell API service starts on port 7401
      And the first cell calls "<route>" on port 7401 with its token
      Then the cell API answers 409
      And no stage run, event, item or policy result changed

      Examples:
        | route                |
        | POST /lease          |
        | POST /github-token   |
        | GET /context         |
        | POST /policy-results |
        | POST /pr             |
        | GET /checks          |
        | POST /stage          |
        | POST /transition     |
        | POST /upload-url     |

    @ac-1 @db
    Scenario: A cell's model request through the cell API service reaches the model on the owner's token
      Given a fresh factory database where item "A" was claimed, so its run is in progress at lease generation 1
      When the cell API service starts on port 7401 in front of a fake model upstream, holding the owner token "owner-secret"
      And the cell sends a model request to port 7401 with its token
      Then the model upstream receives the authorization "Bearer owner-secret"
      And the cell receives the model upstream's answer

    @ac-1 @db
    Scenario: The cell API service refuses a model request whose token the factory didn't issue
      Given a fresh factory database where item "A" was claimed, so its run is in progress at lease generation 1
      When the cell API service starts on port 7401 in front of a fake model upstream, holding the owner token "owner-secret"
      And a cell sends a model request to port 7401 with a token signed by another secret
      Then the cell API answers 401
      And the model upstream received no request

    @ac-1 @db
    Scenario: The cell API service answers 404 for a path that isn't a cell route
      Given a fresh factory database
      When the cell API service starts on port 7401
      And someone asks port 7401 for the dashboard's home page
      Then the cell API answers 404

    @ac-1
    Scenario: A cell API service missing a setting it needs refuses to start
      Given the cell API service's environment doesn't set CELL_SECRET
      When the cell API service starts
      Then it exits with an error naming CELL_SECRET
      And nothing answers on port 7401

  Rule: Today's control plane no longer serves the cell routes or the model gateway

    @ac-1 @db
    Scenario: Today's control plane doesn't take a cell's stage report
      Given a fresh factory database where item "A" was claimed, so its run is in progress at lease generation 1
      When today's control plane starts on port 7400
      And the cell reports stage "understand" attempt 1 as "started" to port 7400 with its token
      Then today's control plane answers 404
      And item "A"'s run has 0 stage runs

    @ac-1 @db
    Scenario Outline: Today's control plane serves none of today's cell routes
      Given a fresh factory database where item "A" was claimed, so its run is in progress at lease generation 1
      When today's control plane starts on port 7400
      And the cell calls "<route>" on port 7400 with its token
      Then today's control plane answers 404
      And no stage run, event, item or policy result changed

      Examples:
        | route                |
        | POST /lease          |
        | POST /github-token   |
        | GET /context         |
        | POST /policy-results |
        | POST /pr             |
        | GET /checks          |
        | POST /stage          |
        | POST /transition     |
        | POST /upload-url     |

    @ac-1 @db
    Scenario: Today's control plane doesn't pass a model request on
      Given a fresh factory database where item "A" was claimed, so its run is in progress at lease generation 1
      When today's control plane starts on port 7400 in front of a fake model upstream
      And the cell sends a model request to port 7400 with its token
      Then today's control plane answers 404
      And the model upstream received no request

  Rule: Today's control plane takes its own port from PORT

    @ac-2 @db
    Scenario: With cells pointed at 7401, today's dashboard stays on 7400
      Given a fresh factory database
      And today's control plane's environment sets PORT to 7400 and points cells at the cell API on 7401
      When today's control plane starts
      Then the dashboard answers on port 7400
      And nothing from today's control plane answers on port 7401
      And its console shows a dashboard sign-in link on "http://localhost:7400"

    @ac-2 @db
    Scenario: A dashboard decision posted from 7400 is accepted while cells are pointed at 7401
      Given a fresh factory database where item "A" waits for sign-off
      And today's control plane's environment sets PORT to 7400 and points cells at the cell API on 7401
      When today's control plane starts
      And the owner signs in to the dashboard on "http://localhost:7400"
      And the owner signs off item "A" from the dashboard on "http://localhost:7400"
      Then the dashboard accepts the sign-off
      And item "A" has left SignOff

    @ac-2
    Scenario: Today's control plane without PORT refuses to start rather than guess its port from the cell API's address
      Given today's control plane's environment points cells at the cell API on 7401 but doesn't set PORT
      When today's control plane starts
      Then it exits with an error naming PORT
      And nothing from today's control plane answers on port 7401
