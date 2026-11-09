@pbi-145
Feature: The dashboard links an InReview item to its PR
  While an item is InReview, the owner's next step is the PR on GitHub. Wherever the dashboard shows an
  InReview item, it shows "PR #N" linked to that PR, so the owner gets there in one click. The link goes to
  the PR address the item's open run holds, and its text is the PR number that run holds. An open run with
  no PR address shows no link, because a guessed link may point at the wrong PR.
  Scenarios tagged @db need Postgres, which each test starts for itself, so cells and CI both run them.

  Background:
    Given item "145" titled "Export a month" is an issue in the repo "acme/widgets"

  Rule: Floor's "Waiting on you" shows an InReview item's PR as a link

    @ac-1 @db
    Scenario: An InReview item under "Waiting on you" shows its PR as a link
      Given the item is InReview
      And its open run holds PR number 42 at "https://github.com/acme/widgets/pull/42"
      When a viewer opens Floor
      Then "Waiting on you" shows "PR #42" for the item
      And "PR #42" links to "https://github.com/acme/widgets/pull/42"

    @ac-1 @db
    Scenario: The PR link and the issue number are separate links
      Given the item is InReview
      And its open run holds PR number 42 at "https://github.com/acme/widgets/pull/42"
      When a viewer opens Floor
      Then "Waiting on you" shows "PR #42" for the item as its own link
      And "#145" on "Waiting on you" still links to "https://github.com/acme/widgets/issues/145"
      And "Export a month" on "Waiting on you" still links to the item's Run detail

    @ac-1 @db
    Scenario: Each InReview item under "Waiting on you" links to its own PR
      Given the item is InReview, and its open run holds PR number 42 at "https://github.com/acme/widgets/pull/42"
      And item "57" titled "Import a year" is InReview, and its open run holds PR number 43 at "https://github.com/acme/widgets/pull/43"
      When a viewer opens Floor
      Then on "Waiting on you", the "PR #42" link for "Export a month" goes to "https://github.com/acme/widgets/pull/42"
      And on "Waiting on you", the "PR #43" link for "Import a year" goes to "https://github.com/acme/widgets/pull/43"

    @ac-1 @db
    Scenario: An item waiting for sign-off under "Waiting on you" shows no PR link beside an InReview item that does
      Given the item is InReview, and its open run holds PR number 42 at "https://github.com/acme/widgets/pull/42"
      And item "57" titled "Import a year" waits for sign-off
      When a viewer opens Floor
      Then "Waiting on you" shows "PR #42" for "Export a month"
      And "Waiting on you" shows no PR link for "Import a year"

  Rule: Floor's "In flight" table shows the same PR link

    @ac-2 @db
    Scenario: An InReview item in the "In flight" table shows its PR as a link
      Given the item is InReview
      And its open run holds PR number 42 at "https://github.com/acme/widgets/pull/42"
      When a viewer opens Floor
      Then the "In flight" table shows "PR #42" for the item
      And "PR #42" in the "In flight" table links to "https://github.com/acme/widgets/pull/42"

    @ac-2 @db
    Scenario: Floor shows the PR link in both places for the same InReview item
      Given the item is InReview
      And its open run holds PR number 42 at "https://github.com/acme/widgets/pull/42"
      When a viewer opens Floor
      Then "Waiting on you" and the "In flight" table each show "PR #42" for the item
      And both links go to "https://github.com/acme/widgets/pull/42"

  Rule: Run detail shows the same PR link next to the item's state

    @ac-3 @db
    Scenario: Run detail for an InReview item shows its PR link next to its state
      Given the item is InReview
      And its open run holds PR number 42 at "https://github.com/acme/widgets/pull/42"
      When a viewer opens the item's Run detail
      Then the line with the item's state "InReview" shows "PR #42"
      And "PR #42" links to "https://github.com/acme/widgets/pull/42"

    @ac-3 @db
    Scenario: Run detail's PR link sits beside the heading's issue number, not in place of it
      Given the item is InReview
      And its open run holds PR number 42 at "https://github.com/acme/widgets/pull/42"
      When a viewer opens the item's Run detail
      Then the line with the item's state shows "PR #42" linked to "https://github.com/acme/widgets/pull/42"
      And the heading still shows "#145" linked to "https://github.com/acme/widgets/issues/145"

  Rule: The link goes to the open run's PR address, its text is the open run's PR number, and with no address there's no link

    @ac-4 @db
    Scenario: The link's text comes from the PR number and its target from the PR address
      Given the item is InReview
      And its open run holds PR number 42 at "https://github.example.com/acme/widgets/pull/42"
      When a viewer opens Floor
      Then "Waiting on you" shows "PR #42" for the item
      And "PR #42" links to "https://github.example.com/acme/widgets/pull/42"
      And the page has no link to "https://github.com/acme/widgets/pull/42"

    @ac-4 @db
    Scenario Outline: An InReview item whose open run has no PR address shows no link on <place>
      Given the item is InReview, and its open run holds PR number 42 but no PR address
      And item "57" titled "Import a year" is InReview, and its open run holds PR number 43 at "https://github.com/acme/widgets/pull/43"
      When a viewer opens <page>
      Then <place> shows "PR #43" for "Import a year", linked to "https://github.com/acme/widgets/pull/43"
      And <place> shows no PR link for "Export a month"
      And the page has no link to "https://github.com/acme/widgets/pull/42"

      Examples:
        | place                        | page  |
        | Floor's "Waiting on you"     | Floor |
        | Floor's "In flight" table    | Floor |

    @ac-4 @db
    Scenario: Run detail for an InReview item whose open run has no PR address shows no link
      Given the item is InReview, and its open run holds PR number 42 but no PR address
      And item "57" titled "Import a year" is InReview, and its open run holds PR number 43 at "https://github.com/acme/widgets/pull/43"
      When a viewer opens the Run detail of "Import a year"
      Then the line with its state shows "PR #43" linked to "https://github.com/acme/widgets/pull/43"
      When a viewer opens the Run detail of "Export a month"
      Then the line with its state shows "InReview" and no PR link
      And the page has no link to "https://github.com/acme/widgets/pull/42"

    @ac-4 @db
    Scenario: The link comes from the open run, not from an earlier run that ended
      Given the item had an earlier run, now ended, that held PR number 40 at "https://github.com/acme/widgets/pull/40"
      And the item is InReview, and its open run holds PR number 42 at "https://github.com/acme/widgets/pull/42"
      When a viewer opens Floor
      Then "Waiting on you" shows "PR #42" for the item, linked to "https://github.com/acme/widgets/pull/42"
      And the page has no link to "https://github.com/acme/widgets/pull/40"
      And the page doesn't show "PR #40"

    @ac-4 @db
    Scenario: An earlier run's PR address doesn't fill in for an open run that has none
      Given the item had an earlier run, now ended, that held PR number 40 at "https://github.com/acme/widgets/pull/40"
      And the item is InReview, and its open run holds PR number 42 but no PR address
      And item "57" titled "Import a year" is InReview, and its open run holds PR number 43 at "https://github.com/acme/widgets/pull/43"
      When a viewer opens Floor
      Then "Waiting on you" shows "PR #43" for "Import a year", linked to "https://github.com/acme/widgets/pull/43"
      And "Waiting on you" shows no PR link for "Export a month"
      And the page has no link to "https://github.com/acme/widgets/pull/40"

    @ac-4 @db
    Scenario: A PR address shows as an address, never as markup
      Given the item is InReview
      And its open run holds PR number 42 at "https://github.com/acme/widgets/pull/42\"><b>x</b>"
      When a viewer opens Floor
      Then "Waiting on you" shows "PR #42" for the item
      And "PR #42" links to exactly "https://github.com/acme/widgets/pull/42\"><b>x</b>"
      And the page has no bold element from the PR address
