@pbi-137
Feature: The factory stores each item's repo at intake, so "#N" never links to another repo's issue
  The dashboard links each item's "#N" to its issue on GitHub (PBI 131). Before an item has a run, the
  dashboard guesses the issue's repo from the board: when the board maps to one repo, it links there.
  A board can hold issues from more than one repo, so the guess can link "#N" to another repo's issue.
  With this item, intake stores each item's repo as "owner/name", taken from the issue itself. Before
  a run, "#N" links to the issue in that repo. The dashboard no longer guesses from the board, so an
  item with no stored repo shows "#N" with no link. Items the factory already holds get their repo
  from the next poll that sees them.
  Scenarios tagged @db need Postgres, which each test starts for itself, so cells and CI both run them.
  The board is a fake.

  Rule: Intake stores each item's repo as "owner/name", taken from the issue the item came from

    @ac-1 @db
    Scenario: A new item's repo is the repo its issue is in
      Given the board lists a new issue "131" titled "Export a month" from the repo "acme/widgets"
      When the poller runs once
      Then the factory holds item "131" with the repo "acme/widgets"

    @ac-1 @db
    Scenario: The stored repo comes from the issue, not from the repo the board maps to
      Given a board that maps to the one repo "acme/widgets"
      And the board lists a new issue "131" titled "Export a month" from the repo "acme/gadgets"
      When the poller runs once
      Then the factory holds item "131" with the repo "acme/gadgets"

    @ac-1 @db
    Scenario: Issues from different repos on one board each keep their own repo
      Given the board lists a new issue "131" titled "Export a month" from the repo "acme/widgets"
      And the board lists a new issue "57" titled "Import a year" from the repo "acme/gadgets"
      When the poller runs once
      Then the factory holds item "131" with the repo "acme/widgets"
      And the factory holds item "57" with the repo "acme/gadgets"

    @ac-1 @db
    Scenario: An issue in a repo the factory doesn't serve still has its repo stored
      Given the factory serves only the repo "acme/widgets"
      And the board lists a new issue "131" titled "Export a month" from the repo "other/tools"
      When the poller runs once
      Then the factory holds item "131" with the repo "other/tools"

    @ac-1 @db
    Scenario: A board item with no repo is stored with no repo
      Given a board that maps to the one repo "acme/widgets"
      And the board lists a new item "131" titled "Export a month" that is not in any repo
      When the poller runs once
      Then the factory holds item "131" with no repo

  Rule: Before an item has a run, its "#N" links to the issue in the item's own repo

    @ac-2 @db
    Scenario: An item with no run links "#N" to the issue in its own repo
      Given the factory holds item "131" titled "Export a month" with the repo "acme/widgets"
      And the item has no run
      And the item is queued
      When a viewer opens Floor
      Then "#131" links to "https://github.com/acme/widgets/issues/131"

    @ac-2 @db
    Scenario: An item whose repo isn't the one the board maps to links to its own repo
      Given a board that maps to the one repo "acme/widgets"
      And the factory holds item "131" titled "Export a month" from that board with the repo "acme/gadgets"
      And the item has no run
      And the item is queued
      When a viewer opens Floor
      Then "#131" links to "https://github.com/acme/gadgets/issues/131"
      And the page has no link to "https://github.com/acme/widgets/issues/131"

    @ac-2 @db
    Scenario: Items with the same number from one board link to their own repos
      Given a board that maps to the repos "acme/widgets" and "acme/gadgets"
      And the factory holds item "131" titled "Export a month" from that board with the repo "acme/widgets"
      And the factory holds item "131" titled "Import a year" from that board with the repo "acme/gadgets"
      And neither item has a run
      And both items are queued
      When a viewer opens Floor
      Then the "#131" before "Export a month" links to "https://github.com/acme/widgets/issues/131"
      And the "#131" before "Import a year" links to "https://github.com/acme/gadgets/issues/131"

    @ac-2 @db
    Scenario: A not-ready item in a repo the factory doesn't serve links to its issue
      Given the factory serves only the repo "acme/widgets"
      And the factory holds item "131" titled "Export a month" with the repo "other/tools"
      And the item has no run
      And the item is not ready
      When a viewer opens Floor
      Then "#131" in "Not ready" links to "https://github.com/other/tools/issues/131"

    @ac-2 @db
    Scenario: A new issue from a repo the board doesn't map to links to that repo once the poller has run
      Given a board that maps to the one repo "acme/widgets"
      And the board lists a new issue "131" titled "Export a month" from the repo "acme/gadgets"
      When the poller runs once
      And a viewer opens Floor
      Then "#131" links to "https://github.com/acme/gadgets/issues/131"

  Rule: The dashboard never guesses an item's repo from its board, so an item with no stored repo shows "#N" unlinked

    @ac-3 @db
    Scenario: An item with no stored repo, on a board that maps to one repo, shows "#N" with no link
      Given a board that maps to the one repo "acme/widgets"
      And the factory holds item "131" titled "Export a month" from that board with no repo
      And the item has no run
      And the item is queued
      When a viewer opens Floor
      Then "Next up" shows "#131" before "Export a month"
      And "#131" is not a link
      And the page has no link to "https://github.com/acme/widgets/issues/131"

    @ac-3 @db
    Scenario Outline: An item with no stored repo and no run shows "#N" unlinked on <place>
      Given a board that maps to the one repo "acme/widgets"
      And the factory holds item "131" titled "Export a month" from that board with no repo
      And the item has no run
      And the item is <state>
      When a viewer opens <page>
      Then <place> shows "#131" before "Export a month"
      And "#131" is not a link
      And the page has no link to an issue on GitHub

      Examples:
        | place                    | state                | page                  |
        | Floor's "Waiting on you" | waiting for sign-off | Floor                 |
        | Floor's "Next up"        | queued               | Floor                 |
        | Floor's "Not ready"      | not ready            | Floor                 |
        | the Run detail heading   | queued               | the item's Run detail |

    @ac-3 @db
    Scenario: An item with no stored repo doesn't stop another item's "#N" from linking
      Given a board that maps to the one repo "acme/widgets"
      And the factory holds item "131" titled "Export a month" from that board with the repo "acme/widgets"
      And the factory holds item "57" titled "Import a year" from that board with no repo
      And neither item has a run
      And both items are queued
      When a viewer opens Floor
      Then "#131" links to "https://github.com/acme/widgets/issues/131"
      And "#57" shows before "Import a year" and is not a link

  Rule: Items already in the database get their repo from the next poll that sees them

    @ac-4 @db
    Scenario: An item held from before this change gets its repo on the next poll
      Given the factory holds item "131" titled "Export a month" with no repo, from before repos were stored
      And the board's issue "131" is in the repo "acme/gadgets"
      When the poller runs once
      Then the factory holds item "131" with the repo "acme/gadgets"

    @ac-4 @db
    Scenario: Once the poll has seen it, an item held from before this change links to its own repo
      Given a board that maps to the one repo "acme/widgets"
      And the factory holds item "131" titled "Export a month" from that board with no repo, from before repos were stored
      And the board's issue "131" is in the repo "acme/gadgets"
      And the item has no run
      And the item is queued
      When the poller runs once
      And a viewer opens Floor
      Then "#131" links to "https://github.com/acme/gadgets/issues/131"
      And the page has no link to "https://github.com/acme/widgets/issues/131"

    @ac-4 @db
    Scenario Outline: A <state> item held from before this change gets its repo on the next poll
      Given the factory holds item "131" titled "Export a month" with no repo, from before repos were stored
      And the board's issue "131" is in the repo "acme/gadgets"
      And the item is <state>
      When the poller runs once
      Then the factory holds item "131" with the repo "acme/gadgets"

      Examples:
        | state                |
        | queued               |
        | not ready            |
        | waiting for sign-off |
        | in flight            |

    @ac-4 @db
    Scenario: An item the poll can't read keeps no repo and shows "#N" unlinked
      Given a board that maps to the one repo "acme/widgets"
      And the factory holds item "131" titled "Export a month" from that board with no repo, from before repos were stored
      And the item has no run
      And the item is queued
      And the board fails to return issue "131"
      When the poller runs once
      And a viewer opens Floor
      Then the factory holds item "131" with no repo
      And "#131" is not a link
