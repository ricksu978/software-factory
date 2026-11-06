@pbi-21 @db
Feature: Walking skeleton end to end
  One item goes the whole way through the factory on the fake backlog: readiness, Specify, sign-off,
  Red and Green, a pull request, a round of requested changes, a merge, and Done once CI on the merge
  commit is green. A second item then does the same with the first item's scenarios already on main.
  That proves earlier items' scenarios keep guarding later ones without blocking a later item's Red.
  The cell runs in the control plane's process with a scripted agent, so no model is called. Every
  scenario needs Postgres, so CI runs them and cells skip them.

  Background:
    Given a fake backlog, and a fake repo whose only policy files are .factory/config.yml and .factory/dod.md
    And a scripted agent that writes the scenarios, step definitions and code each stage asks for
    And CI on the fake repo goes green for every commit unless a scenario says otherwise

  @ac-1
  Scenario: One item goes from Eligible to Done through sign-off, requested changes and a merge
    Given a labelled item "Export to CSV" with two acceptance criteria
    When the factory takes the item through readiness and Specify
    And the product owner approves the scenarios in Run detail
    And the factory takes the item through Red, Green and its pull request
    And a trusted reviewer requests changes on the pull request
    And the factory addresses the requested changes
    And a person merges the pull request
    Then the item "Export to CSV" is Done
    And the board shows "Export to CSV" with the status "Done" and closed
    And "Export to CSV" passed through these states in order:
      | state      |
      | Eligible   |
      | Queued     |
      | InProgress |
      | SignOff    |
      | InProgress |
      | InReview   |
      | Queued     |
      | InProgress |
      | InReview   |
      | Accepted   |
      | Done       |

  @ac-1
  Scenario: Signing off with an /approve comment reaches Done the same way
    Given a labelled item "Export to CSV" with two acceptance criteria
    When the factory takes the item through readiness and Specify
    And the product owner comments "/approve" on the item
    And the factory takes the item through Red, Green and its pull request
    And a person merges the pull request
    Then the item "Export to CSV" is Done

  @ac-1
  Scenario: A merge whose CI fails on main leaves the item Failed, not Done
    Given a labelled item "Export to CSV" with two acceptance criteria
    And CI on the fake repo goes red for the merge commit
    When the factory takes the item through readiness and Specify
    And the product owner approves the scenarios in Run detail
    And the factory takes the item through Red, Green and its pull request
    And a person merges the pull request
    Then the item "Export to CSV" is Failed
    And the board has a comment on "Export to CSV" that links the failed CI run

  @ac-2
  Scenario: A second item reaches Done with the first item's scenarios already on main
    Given the item "Export to CSV" went from Eligible to Done, and its scenarios are on main
    And a labelled item "Import from CSV" with one acceptance criterion
    When the factory takes "Import from CSV" through readiness, Specify, sign-off, Red, Green, its pull request and a merge
    Then Red for "Import from CSV" passed while the scenarios of "Export to CSV" were green
    And the item "Import from CSV" is Done
    And every scenario of "Export to CSV" still passes on main
