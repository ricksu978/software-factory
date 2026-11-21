@pbi-223
Feature: Cells reach only the cell API, and the cell API takes only a run's token
  This is step 4b of the control plane redesign (2026-11-07 design, §03, §06 and §10).
  Cells reach the cell API on 7401 through the egress proxy and nothing else of the factory's.
  Today's dashboard on 7400 and the API on 7402 stay out of a cell's reach.
  The worker won't set up an egress proxy that would let cells through to either port.
  The cell API never accepts a user's sign-in token.
  It answers a request carrying one with 401, because that request isn't from a cell.
  It keeps 409 for a run token from an older generation, which tells a cell its lease has moved on.
  The local-only PBI 2 probes move to the cell API, since they test what cells can reach.
  These are the cell's ping, an upload URL, the names of the service's environment variables and the migrate run count.
  Scenarios tagged @db need Postgres, which each test starts for itself, so cells and CI both run them.
  They run the cell API against a fake board, a fake repo host and a fake model upstream.
  Scenarios tagged @local need Docker, the Aspire CLI and the owner's secrets, so CI and cells skip them.

  Rule: A cell reaches the cell API through the egress proxy

    @ac-1 @local
    Scenario: A cell container pings the cell API through the egress proxy, and the proxy refuses the dashboard
      Given "aspire run" is up and the image "factory-cell:local" is built
      When a "factory-cell:local" container on the cells' network posts to "/internal/cells/ping" on the cell API through the egress proxy
      Then the response status is 204
      When the same container asks today's control plane for the dashboard's home page through the egress proxy
      Then the egress proxy refuses the request with 403

  Rule: The worker won't let cells through to the dashboard's port or the API's port

    @ac-1
    Scenario Outline: The worker refuses to set up the egress proxy when the cell API's address names port <port>
      Given the worker's environment points cells at "http://host.docker.internal:<port>"
      When the worker sets up the egress proxy for cells
      Then it refuses with an error naming port <port>
      And no egress proxy is started for cells

      Examples:
        | port |
        | 7400 |
        | 7402 |

  Rule: The cell API refuses a user's token

    @ac-2 @db
    Scenario Outline: The cell API answers 401 to a user's token on every cell route and changes nothing
      Given a fresh factory database where item "A" was claimed, so its run is in progress at lease generation 1
      And the owner holds a sign-in token that the orchestrator API accepts
      When the cell API service starts on port 7401
      And someone calls "<route>" for item "A"'s run on port 7401 with the owner's sign-in token
      Then the cell API answers 401
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

  Rule: The cell API accepts only a run token of the run's current generation

    @ac-2 @db
    Scenario: The same stage report is refused with a user's token and accepted with the run's current token
      Given a fresh factory database where item "A" was claimed, so its run is in progress at lease generation 1
      And the owner holds a sign-in token that the orchestrator API accepts
      When the cell API service starts on port 7401
      And someone reports stage "understand" attempt 1 as "started" for item "A"'s run on port 7401 with the owner's sign-in token
      And the cell reports stage "understand" attempt 1 as "started" to port 7401 with its token
      Then the cell API answered 401 and then 200
      And item "A"'s run has 1 stage run

    @ac-2 @db
    Scenario: A user's token, a run token from an older generation and the current run token each get their own answer
      Given a fresh factory database where item "A" was claimed, so its run is in progress at lease generation 1
      And item "A"'s lease expired and it was claimed again, so the first cell's token is from an older generation
      And the owner holds a sign-in token that the orchestrator API accepts
      When the cell API service starts on port 7401
      And someone calls "GET /context" for item "A"'s run on port 7401 with the owner's sign-in token
      And the first cell calls "GET /context" on port 7401 with its token
      And the second cell calls "GET /context" on port 7401 with its token
      Then the cell API answered 401, 409 and then 200

  Rule: PBI 2's probes answer from the cell API

    @ac-3 @local
    Scenario: A cell container puts a blob through an upload URL from the cell API's probe
      Given "aspire run" is up and the image "factory-cell:local" is built
      When a "factory-cell:local" container gets an upload URL from "/probe/sas" on the cell API through the egress proxy
      And the container PUTs a blob to that upload URL through the egress proxy
      Then the response status is 201

    @ac-3 @local
    Scenario: The cell API gets its connections and secrets
      Given "aspire run" is up
      When I ask the cell API for the names of its environment variables
      Then the names include "FACTORY_DB_URI", "FACTORY_BLOB", "CELL_SECRET", "GITHUB_APP_ID" and "CLAUDE_CODE_OAUTH_TOKEN"

    @ac-3 @local
    Scenario: The migrate run count read from the cell API goes up by one across a restart
      Given "aspire run" has run once and the cell API's migrate probe recorded its run count
      When I stop "aspire run" and start it again
      Then the cell API's migrate probe's run count is one higher than before

    @ac-3 @db
    Scenario: The cell API answers the probes only on the local platform
      Given a fresh factory database
      When one cell API service starts for the local platform and another starts outside it
      And a cell posts to "/internal/cells/ping" on each of them
      Then the local cell API answers 204
      And the other cell API answers 404
