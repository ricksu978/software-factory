@pbi-319
Feature: The Configuration page sets the effort every agent call must name, a change applies only to new cells, and every model name shows its effort
  Every agent call the factory makes goes out at a model and an effort. Today the effort is never named, so each
  call runs at the model's own default, which for Opus 5.5 is medium. This item makes the effort a runtime setting
  on the Configuration page, next to current WIP, review capacity and the usage reserve. It always has a value,
  starting at medium, so nothing changes until an operator changes it. An operator can set it to low, medium,
  high, xhigh or max with a reason, and can't clear it. Each change is logged as a setting event with who made it,
  the old value, the new value and the reason.
  Every agent call names its model and its effort. A call missing either one fails rather than falling back to a
  default. That covers every stage a cell runs (specify, red, green, the Definition of Done check, self-review,
  PR review and address) and the readiness judge and split calls.
  A cell reads the effort once, when it starts, and uses it for every call it makes until it ends. So a change
  affects only cells that start after it, and it never stops or restarts a running cell. A judge call reads the
  current value each time it runs.
  Each stage attempt and each readiness or split call records the model and the effort it used. Wherever the
  dashboard shows a model name, the effort follows it in parentheses, for example "claude-opus-5-5 (high)". Today
  those places are Run detail's stage attempts table and its readiness checks table. A record from before this
  change has no stored effort, so it shows "(medium)", the effort it ran at.
  Scenarios tagged @db need Postgres, which each test starts for itself, so cells and CI both run them.

  Background:
    Given the factory runs locally for "octo"
    And "octo" is signed in to the dashboard
    And "octo" is an operator

  Rule: The Configuration page shows the effort, starting at medium

    @ac-1 @db
    Scenario: A new factory lists the effort as medium among its runtime settings
      Given a fresh factory database
      When "octo" opens the Configuration page
      Then the runtime settings list "effort" with the value "medium"

    @ac-1 @db
    Scenario: The page shows the effort's current value after a change
      Given the effort is set to "high"
      When "octo" opens the Configuration page
      Then the runtime settings list "effort" with the value "high"

    @ac-1 @db
    Scenario: A viewer sees the effort but no way to change it
      Given "vera" is a viewer
      And "vera" is signed in to the dashboard
      When "vera" opens the Configuration page
      Then the runtime settings list "effort" with the value "medium"
      And the page has no field, form or button to change a setting

  Rule: An operator changes the effort to one of five values with a reason, and every change is logged

    @ac-1 @db
    Scenario Outline: An operator changes the effort to <after> with a reason
      When "octo" changes effort to "<after>" on the Configuration page, giving the reason "<reason>"
      Then the page says "effort changed"
      And the runtime settings list "effort" with the value "<after>"
      And the factory logged one setting event
      And that event says it was made by "octo"
      And that event says effort went from "medium" to "<after>"
      And that event gives the reason "<reason>"
      And the Activity page shows that "octo" changed effort from "medium" to "<after>" because "<reason>"

      Examples:
        | after | reason                                          |
        | low   | The backlog is all small doc fixes this week.   |
        | high  | The next items touch the scheduler.             |
        | xhigh | We're trying harder thinking on hard items.     |
        | max   | One very hard item is next and nothing else.    |

    @ac-1 @db
    Scenario: An operator changes the effort back to medium
      Given the effort is set to "high"
      When "octo" changes effort to "medium" on the Configuration page, giving the reason "Back to the default."
      Then the runtime settings list "effort" with the value "medium"
      And the Activity page shows that "octo" changed effort from "high" to "medium" because "Back to the default."

    @ac-1 @db
    Scenario: A change to the effort with no reason is turned down and the effort keeps its value
      When "octo" changes effort to "high" on the Configuration page, without giving a reason
      Then the change is turned down with the message "Give a reason for the change."
      And the runtime settings list "effort" with the value "medium"
      And the Activity page shows no change to effort

    @ac-1 @db
    Scenario Outline: An effort of "<value>" is turned down and the effort keeps its value
      When "octo" changes effort to "<value>" on the Configuration page, giving the reason "Trying a new value."
      Then the change is turned down with the message "Effort must be one of low, medium, high, xhigh or max."
      And the runtime settings list "effort" with the value "medium"
      And the Activity page shows no change to effort

      Examples:
        | value   |
        | minimal |
        | HIGH    |
        | 3       |
        | none    |

    @ac-1 @db
    Scenario: An operator can't clear the effort
      When "octo" changes effort to "" on the Configuration page, giving the reason "Let the model decide."
      Then the change is turned down with the message "Effort must be one of low, medium, high, xhigh or max."
      And the runtime settings list "effort" with the value "medium"
      And the Activity page shows no change to effort

    @ac-1 @db
    Scenario: A viewer who sends an effort change anyway is refused and nothing changes
      Given "vera" is a viewer
      When "vera" sends a change of effort to "max" with the reason "Let me in." to the Configuration page
      Then the response is 403
      And the runtime settings list "effort" with the value "medium"
      And the Activity page shows no change to effort

  Rule: Every agent call names both its model and its effort, and a call missing either one fails

    @ac-2 @db
    Scenario Outline: The <stage> stage's agent call names its model and the effort
      Given the effort is set to "high"
      And an item is queued with a cell that runs every stage
      When the cell runs the <stage> stage
      Then the <stage> stage's agent call names the model "claude-opus-5-5"
      And the <stage> stage's agent call names the effort "high"

      Examples:
        | stage       |
        | specify     |
        | red         |
        | green       |
        | dod         |
        | self-review |
        | pr-review   |
        | address     |

    @ac-2 @db
    Scenario: The readiness judge call names its model and the effort
      Given the effort is set to "low"
      And a new item on the board that the readiness judge checks
      When the readiness judge runs on that item
      Then the judge call names the model "claude-haiku-4-5"
      And the judge call names the effort "low"

    @ac-2 @db
    Scenario: The split call names its model and the effort
      Given the effort is set to "xhigh"
      And an item that the readiness judge finds oversized
      When the coding model is asked for a split of that item
      Then the split call names the effort "xhigh"
      And the split call names its model

    @ac-2
    Scenario Outline: An agent call with no <missing> fails instead of using a default
      When an agent call is made with no <missing>
      Then the call fails with an error that names the missing <missing>
      And no request goes to the model

      Examples:
        | missing |
        | model   |
        | effort  |

    @ac-2 @db
    Scenario: A stage whose call would go out without an effort fails its attempt
      Given a cell that started with no effort to pass on
      When the cell runs the red stage
      Then the red attempt fails with an error that names the missing effort
      And no request goes to the model

  Rule: A cell reads the effort once at start and uses it for every call until it ends, and a judge call reads it fresh

    @ac-3 @db
    Scenario: A cell passes the effort it started with on every call of every stage
      Given the effort is set to "high"
      And an item is queued
      When a cell starts for that item and runs every stage to the end
      Then every agent call the cell made named the effort "high"
      And the cell read the effort once, when it started

    @ac-3 @db
    Scenario: A retried stage attempt uses the effort the cell started with
      Given the effort is set to "low"
      And a cell has started for an item
      And its green attempt 1 failed
      When an operator changes the effort to "max"
      And the cell runs green attempt 2
      Then green attempt 2's agent call names the effort "low"

    @ac-3 @db
    Scenario: Each readiness judge call uses the effort current when it runs
      Given the effort is set to "low"
      And the readiness judge has checked item "A" at effort "low"
      When "octo" changes effort to "high" on the Configuration page, giving the reason "Harder judging."
      And the readiness judge runs on item "B"
      Then the judge call on item "B" names the effort "high"

    @ac-3 @db
    Scenario: A split call uses the effort current when it runs
      Given the effort is set to "medium"
      When "octo" changes effort to "max" on the Configuration page, giving the reason "Split carefully."
      And the coding model is asked for a split of an oversized item
      Then the split call names the effort "max"

  Rule: A change affects only cells that start after it, and never stops or restarts a running cell

    @ac-4 @db
    Scenario: A running cell keeps its effort after a change, and a new cell takes the new one
      Given the effort is set to "medium"
      And item "A" is running in cell "cell-a", which started at effort "medium" and has finished its red stage
      And item "B" is queued
      When "octo" changes effort to "max" on the Configuration page, giving the reason "Hard items next."
      And cell "cell-a" runs its green stage
      And a cell "cell-b" starts for item "B" and runs its specify stage
      Then cell "cell-a"'s green call names the effort "medium"
      And cell "cell-b"'s specify call names the effort "max"

    @ac-4 @db
    Scenario: A running cell finishes every remaining stage at the effort it started with
      Given the effort is set to "low"
      And item "A" is running in cell "cell-a", which started at effort "low" and has finished its specify stage
      When "octo" changes effort to "high" on the Configuration page, giving the reason "Try harder."
      And cell "cell-a" runs every remaining stage to the end
      Then every agent call cell "cell-a" made after the change named the effort "low"

    @ac-4 @db
    Scenario: A change never stops or restarts a running cell
      Given item "A" is running in cell "cell-a" with a live lease
      When "octo" changes effort to "xhigh" on the Configuration page, giving the reason "Harder items."
      And the scheduler ticks
      Then no cell is stopped
      And no cell starts for item "A"
      And item "A" is still "InProgress" in cell "cell-a"

  Rule: Each stage attempt and each readiness or split call records the model and the effort it used

    @ac-5 @db
    Scenario: A stage attempt records its model and its effort
      Given the effort is set to "high"
      When a cell runs red attempt 1 on model "claude-opus-5-5"
      Then red attempt 1's record holds the model "claude-opus-5-5"
      And red attempt 1's record holds the effort "high"

    @ac-5 @db
    Scenario: A readiness judge call records its model and its effort
      Given the effort is set to "low"
      When the readiness judge runs on a new item
      Then that readiness check records the model "claude-haiku-4-5"
      And that readiness check records the effort "low"

    @ac-5 @db
    Scenario: A split call records its model and its effort
      Given the effort is set to "max"
      When the coding model is asked for a split of an oversized item
      Then that split call's record holds its model
      And that split call's record holds the effort "max"

    @ac-5 @db
    Scenario Outline: A new stage attempt can't be stored without its <missing>
      When a stage attempt is stored with no <missing>
      Then the store turns it down
      And no stage attempt is stored

      Examples:
        | missing |
        | model   |
        | effort  |

    @ac-5 @db
    Scenario Outline: A new readiness or split call can't be stored without its <missing>
      When a <call> call is stored with no <missing>
      Then the store turns it down
      And no readiness check is stored

      Examples:
        | call      | missing |
        | readiness | model   |
        | readiness | effort  |
        | split     | model   |
        | split     | effort  |

  Rule: Wherever the dashboard shows a model name, the effort follows it in parentheses

    @ac-6 @db
    Scenario: Run detail's stage attempts show each model with its effort
      Given item "#46 Add search" has a finished "red" attempt 1 on model "claude-opus-5-5" at effort "high"
      And it has a finished "green" attempt 1 on model "claude-opus-5-5" at effort "low"
      When "octo" opens Run detail for "#46 Add search"
      Then the stage attempts row for "red" attempt 1 shows the model "claude-opus-5-5 (high)"
      And the stage attempts row for "green" attempt 1 shows the model "claude-opus-5-5 (low)"

    @ac-6 @db
    Scenario Outline: Run detail's readiness checks show the <call> call's model with its effort
      Given item "#46 Add search" has a <call> call on model "<model>" at effort "<effort>"
      When "octo" opens Run detail for "#46 Add search"
      Then that call's row in the readiness checks table shows the model "<model> (<effort>)"

      Examples:
        | call      | model            | effort |
        | readiness | claude-haiku-4-5 | xhigh  |
        | split     | claude-opus-5-5  | max    |

    @ac-6 @db
    Scenario: A stage attempt from before this change shows as medium
      Given item "#46 Add search" has a finished "red" attempt 1 on model "claude-opus-5-5" with no effort stored
      When "octo" opens Run detail for "#46 Add search"
      Then the stage attempts row for "red" attempt 1 shows the model "claude-opus-5-5 (medium)"

    @ac-6 @db
    Scenario: A readiness check from before this change shows as medium
      Given item "#46 Add search" has a readiness call on model "claude-haiku-4-5" with no effort stored
      When "octo" opens Run detail for "#46 Add search"
      Then that call's row in the readiness checks table shows the model "claude-haiku-4-5 (medium)"
