@pbi-131
Feature: The dashboard shows each item's issue number and links it to the issue
  Every dashboard page that names an item shows the item's issue number as "#N" before its title, so
  the owner can match a row to its issue on GitHub at a glance. The number links to the issue, and the
  title still links to Run detail. When the factory can't tell which repo an issue is in, the number
  shows with no link, because a link to the wrong repo is worse than no link.
  Scenarios tagged @db need Postgres, which each test starts for itself, so cells and CI both run them.

  Rule: Wherever a page names an item, the item's issue number shows as "#N" before its title

    @ac-1 @db
    Scenario Outline: <place> shows the issue number before the title
      Given item "131" titled "Export a month" is an issue in the repo "acme/widgets"
      And the item is <state>
      When a viewer opens <page>
      Then <place> shows "#131" for the item
      And "#131" comes before "Export a month"

      Examples:
        | place                       | state                                  | page                     |
        | Floor's "Waiting on you"    | waiting for sign-off                   | Floor                    |
        | Floor's "Next up"           | queued                                 | Floor                    |
        | Floor's "Not ready"         | not ready                              | Floor                    |
        | Floor's "In flight"         | in flight                              | Floor                    |
        | the Run detail heading      | in flight                              | the item's Run detail    |
        | the Phase 0 report          | done, with its PR merged               | the Phase 0 report       |
        | the activity log            | just claimed                           | the activity log         |

    @ac-1 @db
    Scenario: Each item on a page shows its own issue number
      Given item "131" titled "Export a month" and item "57" titled "Import a year" are issues in the repo "acme/widgets"
      And both items are queued
      When a viewer opens Floor
      Then "Next up" shows "#131" before "Export a month"
      And "Next up" shows "#57" before "Import a year"

    @ac-1 @db
    Scenario: Every activity row for an item shows its issue number
      Given item "131" titled "Export a month" is an issue in the repo "acme/widgets"
      And the item was claimed, then its run was stopped by an operator
      When a viewer opens the activity log
      Then both of the item's rows show "#131" before "Export a month"

    @ac-1 @db
    Scenario: An issue number shows as text, never as markup
      Given an item whose issue number is "<b>131</b>" and whose title is "Export a month"
      When a viewer opens Floor
      Then the item shows "#<b>131</b>" as plain text
      And the page has no bold element from the issue number

  Rule: Each "#N" links to its issue on GitHub

    @ac-2 @db
    Scenario Outline: The issue number on <place> links to the issue on GitHub
      Given item "131" titled "Export a month" is an issue in the repo "acme/widgets"
      And the item is <state>
      When a viewer opens <page>
      Then "#131" on <place> links to "https://github.com/acme/widgets/issues/131"

      Examples:
        | place                       | state                                  | page                     |
        | Floor's "Waiting on you"    | waiting for sign-off                   | Floor                    |
        | Floor's "Next up"           | queued                                 | Floor                    |
        | Floor's "Not ready"         | not ready                              | Floor                    |
        | Floor's "In flight"         | in flight                              | Floor                    |
        | the Run detail heading      | in flight                              | the item's Run detail    |
        | the Phase 0 report          | done, with its PR merged               | the Phase 0 report       |
        | the activity log            | just claimed                           | the activity log         |

    @ac-2 @db
    Scenario: Items in different repos link to their own repos
      Given item "131" titled "Export a month" is an issue in the repo "acme/widgets"
      And item "131" titled "Import a year" is an issue in the repo "acme/gadgets"
      And both items are queued
      When a viewer opens Floor
      Then the "#131" before "Export a month" links to "https://github.com/acme/widgets/issues/131"
      And the "#131" before "Import a year" links to "https://github.com/acme/gadgets/issues/131"

  Rule: The title still links to Run detail, apart from the issue number

    @ac-3 @db @regression
    Scenario Outline: The title on <place> still links to the item's Run detail
      Given item "131" titled "Export a month" is an issue in the repo "acme/widgets"
      And the item is <state>
      When a viewer opens <page>
      Then "Export a month" on <place> links to the item's Run detail

      Examples:
        | place                       | state                                  | page                     |
        | Floor's "Waiting on you"    | waiting for sign-off                   | Floor                    |
        | Floor's "Next up"           | queued                                 | Floor                    |
        | Floor's "Not ready"         | not ready                              | Floor                    |
        | Floor's "In flight"         | in flight                              | Floor                    |
        | the Phase 0 report          | done, with its PR merged               | the Phase 0 report       |

    @ac-3 @db
    Scenario: The issue number and the title are separate links
      Given item "131" titled "Export a month" is an issue in the repo "acme/widgets"
      And the item is queued
      When a viewer opens Floor
      Then "#131" in "Next up" is its own link, to the issue on GitHub
      And the link to the item's Run detail holds "Export a month" and not "#131"

  Rule: When the factory can't tell which repo an issue is in, "#N" shows with no link

    @ac-4 @db
    Scenario Outline: An item whose repo is unknown shows its number unlinked on <place>
      Given item "131" titled "Export a month" comes from a board that maps to no repo
      And the item has no run in any repo
      And the item is <state>
      When a viewer opens <page>
      Then <place> shows "#131" before "Export a month"
      And "#131" is not a link
      And the page has no link to an issue on GitHub

      Examples:
        | place                       | state                                  | page                     |
        | Floor's "Waiting on you"    | waiting for sign-off                   | Floor                    |
        | Floor's "Next up"           | queued                                 | Floor                    |
        | Floor's "Not ready"         | not ready                              | Floor                    |
        | Floor's "In flight"         | in flight                              | Floor                    |
        | the Run detail heading      | in flight                              | the item's Run detail    |
        | the Phase 0 report          | done, with its PR merged               | the Phase 0 report       |
        | the activity log            | just claimed                           | the activity log         |

    @ac-4 @db
    Scenario: An item on a board that maps to more than one repo, with no run, shows its number unlinked
      Given item "131" titled "Export a month" comes from a board that maps to the repos "acme/widgets" and "acme/gadgets"
      And the item has no run in any repo
      And the item is queued
      When a viewer opens Floor
      Then "Next up" shows "#131" before "Export a month"
      And "#131" is not a link
      And the page has no link to "https://github.com/acme/widgets/issues/131"
      And the page has no link to "https://github.com/acme/gadgets/issues/131"

    @ac-4 @db
    Scenario: An item whose repo isn't on GitHub shows its number unlinked
      Given item "131" titled "Export a month" has a run in a repo that isn't hosted on GitHub
      And the item is in flight
      When a viewer opens Floor
      Then "In flight" shows "#131" before "Export a month"
      And "#131" is not a link

    @ac-4 @db
    Scenario: One item's unknown repo doesn't stop another item's number from linking
      Given item "131" titled "Export a month" is an issue in the repo "acme/widgets"
      And item "57" titled "Import a year" comes from a board that maps to no repo, and has no run
      And both items are queued
      When a viewer opens Floor
      Then "#131" links to "https://github.com/acme/widgets/issues/131"
      And "#57" shows before "Import a year" and is not a link
