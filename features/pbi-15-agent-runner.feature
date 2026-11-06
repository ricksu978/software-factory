@pbi-15
Feature: Agent runner
  Every model call the factory makes goes through one runner, which reads the run's messages and
  reports what the run cost and how it ended. The cost adds up every model the run used, so the
  spend caps see the whole bill. A run that hits the subscription's usage limit stops with the time
  the limit resets, so the item can wait for that time instead of failing. The readiness judge reads
  item text the factory doesn't trust, so judge mode loads nothing from disk and gets no tools.

  @ac-1
  Scenario: A run's cost adds up every model it used
    Given a run that succeeded after using these models:
      | model            | cost in USD |
      | claude-opus-5-5  | 1.25        |
      | claude-haiku-5-5 | 0.5         |
    When the factory reads the run's messages
    Then the run is ok
    And the run cost 1.75 USD

  @ac-1
  Scenario: A run that ran out of turns still counts what it cost
    Given a run that stopped at its turn limit after using these models:
      | model            | cost in USD |
      | claude-opus-5-5  | 2           |
      | claude-haiku-5-5 | 0.25        |
    When the factory reads the run's messages
    Then the run is not ok
    And the run cost 2.25 USD

  @ac-2
  Scenario: A rejected usage-limit event stops the run with its reset time
    Given a run that hit a usage limit that resets at 1762400000, and then ended on the API's error
    When the factory reads the run's messages
    Then the run is not ok
    And the run stopped on a usage limit that resets at 1762400000

  @ac-2
  Scenario: A usage warning doesn't stop the run
    Given a run that succeeded after a usage warning at 0.74 of the limit, which resets at 1762400000
    When the factory reads the run's messages
    Then the run is ok
    And the run didn't stop on a usage limit
    And the run reports a utilization of 0.74, which resets at 1762400000

  @ac-3
  Scenario: Judge mode loads no settings and allows no tools
    When the factory sets up a judge run
    Then the run loads no settings from disk
    And the run has no built-in tools
    And the run denies every tool
    And the run uses no MCP server configured on disk
    And the run sets no permission mode and no sandbox

  @ac-3
  Scenario: Cell mode loads the user's and the repo's settings
    When the factory sets up a cell run
    Then the run loads settings from "user" and "project"
    And the run bypasses permission prompts
