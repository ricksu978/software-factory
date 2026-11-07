@pbi-89
Feature: Dashboard wiring, overrides and the rest of Task 15
  src/main.ts starts the control plane: the cell API, GitHub's webhook and the dashboard on one port,
  with the scheduler's tick and the board poller behind them. Operators steer the factory from the
  dashboard with overrides, Run detail shows the evidence a run stored, and /phase0 counts what merged.
  Scenarios tagged @db need Postgres, which each test starts for itself, so cells and CI both run them.
  The @local one needs Docker, the Aspire CLI and the owner's secrets, so the owner runs it and the PR
  records the run.

  @ac-1
  Scenario Outline: The control plane refuses to start when the dev identity guard fails
    Given the control plane's environment sets <variables>
    When the control plane starts
    Then it exits with an error naming FACTORY_ENV or FACTORY_DEV_LOGIN
    And it logs no sign-in link

    Examples:
      | variables                                                                |
      | FACTORY_DEV_LOGIN=octo                                                   |
      | FACTORY_ENV=local                                                        |
      | FACTORY_ENV=local FACTORY_DEV_LOGIN=octo CONTAINER_APP_NAME=ca-factory-control |

  @ac-1
  Scenario: Locally, the control plane logs this start's sign-in link
    Given the control plane's environment sets FACTORY_ENV=local FACTORY_DEV_LOGIN=octo CELL_CONTROL_URL=http://host.docker.internal:7999
    When the control plane starts
    Then it logs a sign-in link to http://localhost:7999 with a 64-character token

  @ac-2 @local
  Scenario: aspire run starts the control plane from src/main.ts
    # The control plane starts the egress proxy from the cell image, so the image comes first.
    Given the image "factory-cell:local" is built
    When I start "aspire run" and wait until the control resource answers
    Then the control resource's console shows a dashboard sign-in link
    And PBI 2's @local scenarios pass

  @ac-3 @db
  Scenario: A /approve comment that arrives as a GitHub webhook signs off scenarios
    Given the control plane is running with a fake board
    And an item waiting for sign-off, and a product owner whose GitHub login is "pat"
    When GitHub delivers a signed comment "/approve looks right" by "pat" on the item
    Then the item's sign-off question is answered with "approve"
    And the item has a comment saying its scenarios were signed off

  @ac-4 @db
  Scenario: An operator's hold from the dashboard takes effect on the scheduler's next tick
    Given the control plane is running with a fake board
    And an operator is signed in, and an item is in flight
    When the operator posts a "hold" override on the item with the reason "checking"
    And the scheduler ticks once
    Then the item is held
    And the scheduler ticks at least every 30 seconds

  @ac-4 @db
  Scenario: An override with an empty reason gets 400
    Given the control plane is running with a fake board
    And an operator is signed in
    When the operator posts a "pause" override with the reason ""
    Then the dashboard answers 400
    And no override is recorded

  @ac-5 @db
  Scenario Outline: Re-queue needs a reason, and moves a <state> item back to Queued
    Given the control plane is running with a fake board
    And an operator is signed in, and an item is <state>
    When the operator posts a "requeue" override on the item with the reason ""
    Then the dashboard answers 400
    When the operator posts a "requeue" override on the item with the reason "try again"
    And the scheduler ticks once
    Then the item's state is Queued

    Examples:
      | state     |
      | Failed    |
      | Abandoned |

  @ac-6 @db
  Scenario: Run detail shows each scenario's red and green verdicts and links each stage's transcript
    Given the control plane is running with a fake board
    And a viewer is signed in
    And an item whose red report has "Exports one month" failing, whose green report has it passing, and whose red stage stored a transcript
    When the viewer opens the item's Run detail
    Then the scenario "Exports one month" shows red at Red and green at Green
    And the red stage links its transcript, and the link opens it

  @ac-7 @db
  Scenario: seed-owner adds a first owner through the migrate job
    When the migrate job runs seed-owner with "provider=microsoft subject=s-1 email=me@example.com github-login=octo product-owner"
    Then it exits 0
    And the user "s-1" is an owner and a product owner

  @ac-7 @db
  Scenario: seed-owner refuses a word it doesn't know
    When the migrate job runs seed-owner with "provider=microsoft subject=s-2 role=viewer"
    Then it exits 1 naming "role=viewer"
    And no user "s-2" exists

  @ac-8 @db
  Scenario: /phase0 shows an item that merged twice as two rows
    Given the control plane is running with a fake board
    And a viewer is signed in
    And an item whose first run merged at a cost of $1.50 with a Low tier, and whose second run merged at a cost of $2.50 with a High tier
    When the viewer opens "/phase0"
    Then the report says "2 merged PRs, $4.00 in all, $2.00 each on average."
    And it lists the first run's PR before the second's, each with its own cost and tier

  @ac-9 @db
  Scenario: Floor shows an in-flight item's last agent message, cut to 500 characters
    Given the control plane is running with a fake board
    And a viewer is signed in
    And an item in flight whose cell sends a 600-character message as its stage passes
    When the viewer opens "/"
    Then the item's row shows the message's first 500 characters and no more

  @ac-9 @db
  Scenario: The risk classifier's output never becomes a stage's message
    Given the whole factory runs in process with a scripted agent
    When it takes a labelled item through readiness, Specify, sign-off, Red, Green and its pull request
    Then the open-pr stage's message is the PR summary its own agent wrote
    And no stage's message is a risk tier
