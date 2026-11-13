@pbi-185
Feature: Red expects only the scenarios bdd.run selects, so @local scenarios stop failing it
  Red lists the item's scenarios from bdd.parse, which reads every feature file with no tag filter, and then
  runs bdd.run. A repo's bdd.run can leave scenarios out with a tag filter: this repo's own runs
  `npm run bdd -- --tags "not @local"`, because a scenario tagged @local needs the owner's machine. Red then
  found every @local scenario missing from the run and failed with "not run in the cell", although the cell
  was never meant to run it. Item 169 sat in NeedsInput for that reason, and no answer helped.
  With this item, Red expects only the scenarios bdd.run selects. A scenario bdd.run selects but that doesn't
  run still fails Red, and an item none of whose scenarios bdd.run selects still fails Red, since nothing
  then proves the item red. Specify is unchanged: its check that every acceptance criterion has a scenario
  still counts @local scenarios.
  Unless a scenario says otherwise, the repo's bdd.run leaves out scenarios tagged @local, the way this repo's
  does, and item 482's scenarios carry "@pbi-482".
  None of these scenarios is tagged @local, since Red for this item runs on the factory as it is before the build.

  Rule: Red expects only the scenarios bdd.run selects

    @ac-1
    Scenario: An item whose in-cell scenarios all fail on a Then passes Red despite its @local scenarios
      Given item 482 has these scenarios:
        | scenario                    | tags   |
        | Totals add up               |        |
        | Refunds show negative       |        |
        | The export opens in Excel   | @local |
      And at Red, every scenario the cell runs fails on its Then
      When Red is judged for item 482
      Then Red passes
      And Red reports no finding about "The export opens in Excel"

    @ac-1
    Scenario: A @local tag on one Examples block leaves only that block's rows out
      Given item 482 has a scenario outline "Totals add up for <currency>" with these rows:
        | currency | examples block tags |
        | EUR      |                     |
        | GBP      |                     |
        | JPY      | @local              |
      And at Red, every scenario the cell runs fails on its Then
      When Red is judged for item 482
      Then Red passes

    @ac-1
    Scenario: Red follows the repo's own filter, not the @local tag by name
      Given the repo's bdd.run leaves out scenarios tagged @slow instead
      And item 482 has these scenarios:
        | scenario                  | tags   |
        | Totals add up             |        |
        | A year of history exports | @slow  |
      And at Red, every scenario the cell runs fails on its Then
      When Red is judged for item 482
      Then Red passes

    @ac-1
    Scenario: A scenario bdd.run leaves out doesn't count against Red, even if it would pass
      Given item 482 has these scenarios:
        | scenario                  | tags   |
        | Totals add up             |        |
        | The export opens in Excel | @local |
      And at Red, "Totals add up" fails on its Then
      And "The export opens in Excel" would pass if it ran
      When Red is judged for item 482
      Then Red passes

    @ac-1
    Scenario: An in-cell scenario that already passes still fails Red when @local scenarios are left out
      Given item 482 has these scenarios:
        | scenario                  | tags   |
        | Totals add up             |        |
        | Refunds show negative     |        |
        | The export opens in Excel | @local |
      And at Red, "Totals add up" passes and "Refunds show negative" fails on its Then
      When Red is judged for item 482
      Then Red fails with only the finding "scenario passes before any behaviour exists: Totals add up"

  Rule: A scenario bdd.run selects but that doesn't run still fails Red

    @ac-2 @regression
    Scenario: A selected scenario missing from the run fails Red with "not run in the cell"
      Given the repo's bdd.run has no tag filter
      And item 482 has these scenarios:
        | scenario              | tags |
        | Totals add up         |      |
        | Refunds show negative |      |
      And at Red, "Totals add up" fails on its Then and "Refunds show negative" is missing from the run's report
      When Red is judged for item 482
      Then Red fails with the finding "not run in the cell: Refunds show negative"

    @ac-2
    Scenario: Only the selected scenario that didn't run is named, not the @local ones
      Given item 482 has these scenarios:
        | scenario                  | tags   |
        | Totals add up             |        |
        | Refunds show negative     |        |
        | The export opens in Excel | @local |
      And at Red, "Totals add up" fails on its Then and "Refunds show negative" is missing from the run's report
      When Red is judged for item 482
      Then Red fails with only the finding "not run in the cell: Refunds show negative"

  Rule: An item none of whose scenarios bdd.run selects still fails Red

    @ac-3
    Scenario: An item whose every scenario is @local fails Red because none runs in the cell
      Given item 482 has these scenarios:
        | scenario                  | tags   |
        | The export opens in Excel | @local |
        | The export prints cleanly | @local |
      When Red is judged for item 482
      Then Red fails with a finding that no scenario carrying "@pbi-482" runs in the cell
      And Red reports no "not run in the cell" finding for "The export opens in Excel"
      And Red reports no "not run in the cell" finding for "The export prints cleanly"

  Rule: Specify still counts @local scenarios when it checks every criterion has one

    @ac-4 @regression
    Scenario: A criterion covered only by a @local scenario passes Specify's check
      Given item 482 has 2 acceptance criteria
      And Specify writes these scenarios:
        | scenario                  | tags          |
        | Totals add up             | @ac-1         |
        | The export opens in Excel | @ac-2 @local  |
      When Specify checks that every acceptance criterion has a scenario
      Then Specify reports no criterion without a scenario

  Rule: Item 169 passes Red once answered, with no new commit

    @ac-5
    Scenario: Item 169, stuck on its @local scenarios, passes Red when answered once
      Given item 169 waits for input because Red failed with "not run in the cell" for its @local scenarios
      And item 169's branch holds its signed-off feature file and step definitions, unchanged
      And at Red, every scenario of item 169 the cell runs fails on its Then
      When the owner answers item 169 once and Red runs again
      Then Red passes for item 169
      And no commit was added to item 169's branch for Red to pass
