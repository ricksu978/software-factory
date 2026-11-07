@pbi-16 @db
Feature: Cell API fenced by lease generation
  A cell reaches the control plane only through the cell API, with a run token tied to its lease
  generation. Once the item is claimed again, or leaves InProgress, the old token stops working, so a
  cell that outlived its lease can't push, comment or move the item. A cell may move its item only
  along the five edges a cell owns. Every move, whoever makes it, shows on the board through the
  source's field map, so people who never open the dashboard can still follow along.
  Every scenario needs Postgres, which each test starts for itself, so cells and CI both run them.

  Background:
    Given a backlog source whose field map sets these board statuses:
      | state      | status      |
      | Queued     | Todo        |
      | InProgress | In Progress |
      | SignOff    | Sign-off    |
      | NeedsInput | Needs input |
      | InReview   | In Review   |
      | Failed     | Failed      |
      | Eligible   |             |
    And item "16" from that source was claimed, so its run is in progress at lease generation 1

  @ac-1
  Scenario: The current generation's token is accepted
    When the cell reports stage "understand" attempt 1 as "started" with its token
    Then the cell API answers 200
    And item "16"'s run has 1 stage run

  @ac-1
  Scenario Outline: A cell whose item was claimed again is refused on every route
    Given item "16"'s lease expired and it was claimed again, so the first cell's token is from an older generation
    When the first cell calls "<route>" with its token
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

  @ac-1
  Scenario: A token the factory didn't sign is refused
    When a cell calls "POST /stage" for item "16"'s run with a token signed by another secret
    Then the cell API answers 409
    And no stage run, event, item or policy result changed

  @ac-1
  Scenario: A cell's own transition fences it, so nothing it sends afterwards counts
    When the cell reports stage "specify" attempt 1 as "passed" with its token
    And the cell sends the transition "scenarios_written" with its token
    And the cell reports stage "specify" attempt 1 as "passed" with its token
    Then the cell API answered 200, 200 and then 409
    And item "16"'s run has 1 stage run

  @ac-1
  Scenario: The model gateway refuses the older generation's stand-in token
    Given a model gateway in front of a fake upstream
    And item "16"'s lease expired and it was claimed again, so the first cell's token is from an older generation
    When the first cell sends a model request with its stand-in token
    Then the gateway answers 401
    And the upstream receives no request

  @ac-2
  Scenario Outline: A cell may move its item along the five edges it owns
    When the cell sends the transition "<event>" with its token
    Then the cell API answers 200
    And item "16" is in state "<state>"
    And item "16" has no lease owner and is at lease generation 2

    Examples:
      | event             | state      |
      | scenarios_written | SignOff    |
      | blocked           | NeedsInput |
      | pr_opened         | InReview   |
      | retries_exhausted | Failed     |
      | usage_limited     | Queued     |

  @ac-2
  Scenario Outline: Any other event from a cell is refused and changes nothing
    When the cell sends the transition "<event>" with its token
    Then the cell API answers 400
    And item "16" is in state "InProgress"
    And no stage run, event, item or policy result changed

    Examples:
      | event         |
      | merged        |
      | withdrawn     |
      | claimed       |
      | requeued      |
      | lease_expired |
      | dod_verified  |
      | not_an_event  |

  @ac-3
  Scenario: The claim that started the run shows on the board
    Then item "16" on the board shows the status "In Progress"
    And item "16" on the board carries the in-progress marker

  @ac-3
  Scenario Outline: Each move a cell makes shows the status the field map names
    When the cell sends the transition "<event>" with its token
    Then item "16" on the board shows the status "<status>"

    Examples:
      | event             | status      |
      | scenarios_written | Sign-off    |
      | blocked           | Needs input |
      | pr_opened         | In Review   |
      | retries_exhausted | Failed      |
      | usage_limited     | Todo        |

  @ac-3
  Scenario: A move into a state the field map leaves blank keeps the board's status
    Given item "17" from that source is NotReady, and the board shows it as "Backlog"
    When the watcher moves item "17" back to Eligible because the item was edited
    Then item "17" on the board shows the status "Backlog"

  @ac-3
  Scenario: Opening the PR links it from the board item
    When the cell sends the transition "pr_opened" for PR 41 with its token
    Then item "16" on the board links "https://github.com/ricksu978/software-factory/pull/41"

  @ac-3
  Scenario: An item waiting on a person says what it's waiting for on the board
    When the cell sends the transition "blocked" with the question "Which currency do refunds use?" and its token
    Then item "16" on the board has a comment holding "Which currency do refunds use?"

  @ac-3
  Scenario: A failed item gives up its in-progress marker
    When the cell sends the transition "retries_exhausted" with its token
    Then item "16" on the board doesn't carry the in-progress marker
