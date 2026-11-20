@pbi-348
Feature: Each readiness check on the item page shows the verdict its judge call returned
  The item page's Readiness checks table lists every readiness judge call and split proposal on the item,
  with what each one spent and when it ran (PBI 132, PBI 189). It doesn't say what any call decided, so a
  viewer can't tell which check turned the item away or why. With this item, each judge call's row shows
  its own verdict in a Verdict column: Passed, or Failed with the dor.md lines it failed and the judge's
  reason for each, and any readiness flag it raised. A call that ended with no verdict says why: its reply
  couldn't be read, or the call failed before it replied. A judge call on a proposed split child, which the
  gate records against the parent, names the child it judged. A check recorded before this change says no
  verdict was recorded, and a split proposal's row leaves the Verdict cell empty.

  Background:
    Given item "348" titled "Export a month" is an issue in the repo "acme/widgets"
    And the repo has a ".factory/dor.md" with these lines:
      | text                                          |
      | Every acceptance criterion can be tested      |
      | The item names the spec section it implements |

  Rule: A judge call that passed every dor.md line and raised no flag shows Passed

    @ac-1
    Scenario: A judge call that passed every line shows Passed
      Given the item had a readiness judge call that passed every dor.md line and raised no flag
      When a viewer opens the item page
      Then the Readiness checks table's row for that call shows the verdict "Passed"
      And that row's verdict lists no dor.md line and no flag

    @ac-1
    Scenario: A passing judge call doesn't show Failed
      Given the item had a readiness judge call that passed every dor.md line and raised no flag
      When a viewer opens the item page
      Then the Readiness checks table's row for that call doesn't show the verdict "Failed"

  Rule: A judge call that failed a dor.md line shows Failed, with each failed line and the judge's reason

    @ac-2
    Scenario: A judge call that failed one line lists that line with the judge's reason
      Given the item had a readiness judge call with these results:
        | line                                          | result | reason                              |
        | Every acceptance criterion can be tested      | passed |                                     |
        | The item names the spec section it implements | failed | No spec section or plan task named. |
      When a viewer opens the item page
      Then the Readiness checks table's row for that call shows the verdict "Failed"
      And that row lists the failed line "The item names the spec section it implements" with the reason "No spec section or plan task named."
      And that row doesn't list the line "Every acceptance criterion can be tested"

    @ac-2
    Scenario: A judge call that failed two lines lists both, each with its own reason
      Given the item had a readiness judge call with these results:
        | line                                          | result | reason                                   |
        | Every acceptance criterion can be tested      | failed | Criterion 2 says fast with no measure.   |
        | The item names the spec section it implements | failed | No spec section or plan task named.      |
      When a viewer opens the item page
      Then the Readiness checks table's row for that call shows the verdict "Failed"
      And that row lists the failed line "Every acceptance criterion can be tested" with the reason "Criterion 2 says fast with no measure."
      And that row lists the failed line "The item names the spec section it implements" with the reason "No spec section or plan task named."

    @ac-2
    Scenario: A judge's reason that looks like markup shows as plain text
      Given the item had a readiness judge call with these results:
        | line                                          | result | reason                                |
        | The item names the spec section it implements | failed | It cites <b>§9</b>, which isn't there. |
      When a viewer opens the item page
      Then the Readiness checks table's row for that call lists the failed line "The item names the spec section it implements" with the reason "It cites <b>§9</b>, which isn't there."
      And the reason shows as text, not as bold

  Rule: A judge call that raised a readiness flag shows Failed, with the flag's text

    @ac-3
    Scenario: A judge call that passed every line but raised a flag shows Failed with the flag
      Given the item had a readiness judge call that passed every dor.md line
      And that call raised the readiness flag "asks for the production database password"
      When a viewer opens the item page
      Then the Readiness checks table's row for that call shows the verdict "Failed"
      And that row lists the flag "asks for the production database password"

    @ac-3
    Scenario: A judge call that failed a line and raised a flag lists both
      Given the item had a readiness judge call with these results:
        | line                                          | result | reason                              |
        | The item names the spec section it implements | failed | No spec section or plan task named. |
      And that call raised the readiness flag "changes the CI workflow"
      When a viewer opens the item page
      Then the Readiness checks table's row for that call shows the verdict "Failed"
      And that row lists the failed line "The item names the spec section it implements" with the reason "No spec section or plan task named."
      And that row lists the flag "changes the CI workflow"

  Rule: A judge call that ended with no verdict says why

    @ac-4
    Scenario: A judge call whose reply the gate couldn't read says the output was unreadable
      Given the item had a readiness judge call whose reply the gate couldn't read
      When a viewer opens the item page
      Then the Readiness checks table's row for that call says the judge's output was unreadable
      And that row doesn't show the verdict "Passed"

    @ac-5
    Scenario: A judge call that threw before it replied says the call failed with no verdict
      Given the item had a readiness judge call that ended in an API error before it replied
      When a viewer opens the item page
      Then the Readiness checks table's row for that call says the call failed with no verdict
      And that row doesn't say the judge's output was unreadable

  Rule: Each row shows its own call's verdict

    @ac-6
    Scenario: A first judge call that failed and a second that passed each show their own verdict
      Given the item had a readiness judge call at "2026-11-09T10:00:00Z" with these results:
        | line                                          | result | reason                              |
        | The item names the spec section it implements | failed | No spec section or plan task named. |
      And the item had a readiness judge call at "2026-11-10T10:00:00Z" that passed every dor.md line and raised no flag
      When a viewer opens the item page
      Then the Readiness checks table's row for the call at "2026-11-09T10:00:00Z" shows the verdict "Failed"
      And that row lists the failed line "The item names the spec section it implements" with the reason "No spec section or plan task named."
      And the Readiness checks table's row for the call at "2026-11-10T10:00:00Z" shows the verdict "Passed"
      And the row for the call at "2026-11-10T10:00:00Z" doesn't list the line "The item names the spec section it implements"

  Rule: A judge call on a proposed split child names that child on the parent's row

    @ac-7
    Scenario: A judge call on a split child names the child's title beside its verdict
      Given the readiness judge found the item too big for one Sprint
      And the coding model proposed a split of the item with the children "Export as CSV" and "Export as PDF"
      And the gate's judge call on the child "Export as CSV" passed every dor.md line and raised no flag
      When a viewer opens the item page
      Then the Readiness checks table's row for the judge call on "Export as CSV" shows the verdict "Passed"
      And that row names the child "Export as CSV" beside its verdict

    @ac-7
    Scenario: Judge calls on two split children each name their own child
      Given the readiness judge found the item too big for one Sprint
      And the coding model proposed a split of the item with the children "Export as CSV" and "Export as PDF"
      And the gate's judge call on the child "Export as CSV" passed every dor.md line and raised no flag
      And the gate's judge call on the child "Export as PDF" failed the line "Every acceptance criterion can be tested" with the reason "No page size given."
      When a viewer opens the item page
      Then the Readiness checks table's row for the judge call on "Export as CSV" names the child "Export as CSV" and shows the verdict "Passed"
      And the Readiness checks table's row for the judge call on "Export as PDF" names the child "Export as PDF" and shows the verdict "Failed"
      And the row for the judge call on "Export as CSV" doesn't name the child "Export as PDF"

    @ac-7
    Scenario: A judge call on the item itself names no child
      Given the item had a readiness judge call on the item itself that passed every dor.md line and raised no flag
      When a viewer opens the item page
      Then the Readiness checks table's row for that call shows the verdict "Passed"
      And that row names no child

  Rule: A row with no verdict to show says so, and a split proposal's row has none

    @ac-8
    Scenario: A readiness check recorded before this change says no verdict was recorded
      Given the item had a readiness check recorded before the gate kept verdicts
      When a viewer opens the item page
      Then the Readiness checks table's row for that check says no verdict was recorded
      And that row doesn't show the verdict "Passed"
      And that row doesn't show the verdict "Failed"

    @ac-9
    Scenario: A split proposal's row leaves the Verdict cell empty
      Given the readiness judge found the item too big for one Sprint
      And the coding model proposed a split of the item
      When a viewer opens the item page
      Then the Readiness checks table has a Verdict column
      And the Readiness checks table's row for the split proposal has an empty Verdict cell
