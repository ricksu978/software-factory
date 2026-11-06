@pbi-14
Feature: BDD evidence: red, green and the lock
  The factory judges Red and Green from the runner's Cucumber Messages report, never from console output.
  A scenario counts as red only when the first step that didn't pass is a Then that failed. Anything else
  that goes wrong is a crash, because it proves nothing about the behaviour. Red looks only at the item's
  own scenarios, so earlier items' green scenarios never block a later item. At sign-off the factory locks
  the item's feature files, and from then on the build may add step definitions but not change a scenario.

  @ac-1
  Scenario Outline: A scenario's verdict comes from the first step that didn't pass
    Given a runner report with one scenario whose Given "<given>", whose When "<when>" and whose Then "<then>"
    When the factory reads the report
    Then that scenario counts as "<verdict>"

    Examples:
      | given     | when      | then      | verdict |
      | passed    | passed    | failed    | red     |
      | passed    | passed    | passed    | green   |
      | passed    | failed    | skipped   | crash   |
      | failed    | skipped   | skipped   | crash   |
      | pending   | skipped   | skipped   | crash   |
      | passed    | undefined | skipped   | crash   |
      | passed    | ambiguous | skipped   | crash   |
      | passed    | passed    | undefined | crash   |

  @ac-1
  Scenario: An empty report gives Red nothing to count
    Given an empty runner report
    And item "@pbi-482" has the scenario "Totals add up"
    When Red is judged for "@pbi-482"
    Then Red fails with the finding "not run in the cell: Totals add up"

  @ac-2
  Scenario: Red passes for a second item while the first item's scenarios are green
    Given a runner report with these scenarios:
      | scenario                  | item     | ended                  |
      | Export splits the columns | @pbi-481 | with every step passed |
      | Totals add up             | @pbi-482 | failed on its Then     |
      | Refunds show negative     | @pbi-482 | failed on its Then     |
    And item "@pbi-482" has the scenarios "Totals add up" and "Refunds show negative"
    When Red is judged for "@pbi-482"
    Then Red passes

  @ac-2
  Scenario: Red fails when one of the item's own scenarios already passes
    Given a runner report with these scenarios:
      | scenario              | item     | ended                  |
      | Totals add up         | @pbi-482 | with every step passed |
      | Refunds show negative | @pbi-482 | failed on its Then     |
    And item "@pbi-482" has the scenarios "Totals add up" and "Refunds show negative"
    When Red is judged for "@pbi-482"
    Then Red fails with the finding "scenario passes before any behaviour exists: Totals add up"

  @ac-2
  Scenario: Red fails when one of the item's scenarios didn't run in the cell
    Given a runner report with these scenarios:
      | scenario      | item     | ended              |
      | Totals add up | @pbi-482 | failed on its Then |
    And item "@pbi-482" has the scenarios "Totals add up" and "Refunds show negative"
    When Red is judged for "@pbi-482"
    Then Red fails with the finding "not run in the cell: Refunds show negative"

  @ac-3
  Scenario: Editing a locked feature file fails the lock check
    Given a repo where item "@pbi-482"'s feature file was locked at sign-off
    When a later commit edits that feature file
    Then the lock check fails

  @ac-3
  Scenario: Adding a step definition passes the lock check
    Given a repo where item "@pbi-482"'s feature file was locked at sign-off
    When a later commit adds a step definition
    Then the lock check passes

  @ac-3
  Scenario: Merging another item's feature file passes the lock check
    Given a repo where item "@pbi-482"'s feature file was locked at sign-off
    When another item's feature file is merged in
    Then the lock check passes
