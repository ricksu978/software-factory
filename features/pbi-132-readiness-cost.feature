@pbi-132
Feature: The factory records the cost of every AI call, the readiness judge's included
  Each stage a cell runs already records what its AI calls cost. The readiness judge, which checks
  every item against the repo's dor.md before any run starts, records nothing, so what the factory
  spends on items it turns away is never counted. With this item, every judge call records its item,
  model, tokens and cost, even when it fails. Run detail and the Phase 0 report show that spend.
  A cell's AI call made while no stage is open becomes an error, so no call can go unrecorded. The
  judge and the cell's model are scripted here, so these scenarios need no model and no network.

  Background:
    Given a repo whose ".factory/dor.md" holds the single line "Has a title"
    And an item "Checkout redesign" in that repo

  Rule: Every readiness judge call records what it spent

    @ac-1
    Scenario: A judge call that passes the item records its item, model, tokens, cost and time
      Given a judge on the model "claude-haiku-4-5" that passes every line, using 1200 tokens in and 80 out at a cost of $0.0031
      And the time is "2026-11-09T10:15:00Z"
      When the readiness gate checks the item
      Then one readiness check is recorded for "Checkout redesign"
      And that readiness check records the model "claude-haiku-4-5"
      And that readiness check records 1200 tokens in and 80 tokens out
      And that readiness check records a cost of $0.0031
      And that readiness check records that it ran at "2026-11-09T10:15:00Z"

    @ac-1
    Scenario: A judge call that turns the item away still records what it spent
      Given a judge that fails line 1 because "No title", at a cost of $0.0028
      When the readiness gate checks the item
      Then the item is not ready
      And one readiness check is recorded for "Checkout redesign" with a cost of $0.0028

    @ac-1
    Scenario: A judge reply the gate can't read still records what it spent
      Given a judge that answers "I am not sure" with no verdict lines, at a cost of $0.0019
      When the readiness gate checks the item
      Then one readiness check is recorded for "Checkout redesign" with a cost of $0.0019

    @ac-1
    Scenario: Each time the item is checked again, a new readiness check is recorded
      Given a judge that passes every line, at a cost of $0.0030
      And the item was checked once before, at a cost of $0.0025
      When the item is edited and the readiness gate checks it again
      Then two readiness checks are recorded for "Checkout redesign"
      And the readiness checks for "Checkout redesign" cost $0.0055 in all

  Rule: A failed judge call still records what it spent

    @ac-2
    Scenario: A judge call stopped by a usage limit records what it spent
      Given a judge that hits a usage limit after using 900 tokens in and 0 out at a cost of $0.0012
      When the readiness gate checks the item
      Then the item is still waiting for its readiness check
      And one readiness check is recorded for "Checkout redesign"
      And that readiness check records 900 tokens in and 0 tokens out
      And that readiness check records a cost of $0.0012

    @ac-2
    Scenario: A judge call that ends in an API error records what it spent
      Given a judge that ends in an API error after spending $0.0007
      When the readiness gate checks the item
      Then the item is still waiting for its readiness check
      And one readiness check is recorded for "Checkout redesign" with a cost of $0.0007

    @ac-2
    Scenario: A judge call that runs out of time records what it spent
      Given a judge that runs past its time limit after spending $0.0021
      When the readiness gate checks the item
      Then the item is still waiting for its readiness check
      And one readiness check is recorded for "Checkout redesign" with a cost of $0.0021

    @ac-2
    Scenario: A judge call that fails before spending anything records a cost of nothing
      Given a judge that ends in an API error before using any tokens
      When the readiness gate checks the item
      Then one readiness check is recorded for "Checkout redesign" with a cost of $0.0000

  Rule: Run detail shows the item's readiness checks next to its stages

    @ac-3
    Scenario: Run detail lists each readiness check with its cost beside the stages
      Given "Checkout redesign" had these readiness checks:
        | ran at               | model            | tokens in | tokens out | cost    |
        | 2026-11-08T09:00:00Z | claude-haiku-4-5 | 1100      | 70         | $0.0025 |
        | 2026-11-09T10:15:00Z | claude-haiku-4-5 | 1200      | 80         | $0.0031 |
      And "Checkout redesign" has run its "specify" stage at a cost of $0.42
      When an operator opens Run detail for "Checkout redesign"
      Then the page has a "Readiness checks" section beside its "Stages" section
      And the "Readiness checks" section lists 2 checks, oldest first
      And each listed check shows when it ran, its model, its tokens in and out, and its cost
      And the "Stages" section still lists the "specify" stage at a cost of $0.42

    @ac-3
    Scenario: Run detail shows the readiness checks of an item that was turned away
      Given "Checkout redesign" was turned away by a readiness check that cost $0.0028
      And "Checkout redesign" has no run
      When an operator opens Run detail for "Checkout redesign"
      Then the "Readiness checks" section lists 1 check with a cost of $0.0028

    @ac-3
    Scenario: Run detail shows a failed readiness check with its cost
      Given "Checkout redesign" had a readiness check that hit a usage limit at a cost of $0.0012
      When an operator opens Run detail for "Checkout redesign"
      Then the "Readiness checks" section lists 1 check with a cost of $0.0012

    @ac-3
    Scenario: Run detail says so when no readiness check has run
      Given "Checkout redesign" has had no readiness check
      When an operator opens Run detail for "Checkout redesign"
      Then the "Readiness checks" section says "No readiness check has run yet."

  Rule: The Phase 0 report counts readiness spend across every item

    @ac-4
    Scenario: The report shows readiness spend beside stage spend, turned-away items included
      Given a merged item "Pay by card" whose stages cost $2.00 and whose readiness checks cost $0.0030
      And an item "Vague wish" that the gate turned away, whose readiness checks cost $0.0050
      And an item "Pay by transfer" still waiting for its readiness check, whose failed check cost $0.0012
      When an operator opens the Phase 0 report
      Then the report shows stage spend of $2.00
      And beside it the report shows readiness spend of $0.0092

    @ac-4
    Scenario: Readiness spend counts an item that never reached a run
      Given an item "Vague wish" that the gate turned away, whose readiness checks cost $0.0050
      And no factory PR has merged yet
      When an operator opens the Phase 0 report
      Then the report shows readiness spend of $0.0050

    @ac-4
    Scenario: The report shows no readiness spend when no judge has run
      Given a merged item "Pay by card" whose stages cost $2.00
      And no readiness check has run for any item
      When an operator opens the Phase 0 report
      Then the report shows stage spend of $2.00
      And beside it the report shows readiness spend of $0.0000

  Rule: A cell's AI call made while no stage is open is an error

    @ac-5
    Scenario: An AI call between two stages is an error, and the model is never asked
      Given a run for item 482 whose cell makes an AI call after one stage ended and before the next began
      When the cell runs
      Then the cell run fails with an error that says an AI call was made while no stage was open
      And the model is never asked for that call

    @ac-5
    Scenario: An AI call before the run's first stage opens is an error
      Given a run for item 482 whose cell makes an AI call before any stage began
      When the cell runs
      Then the cell run fails with an error that says an AI call was made while no stage was open
      And the model is never asked for that call
