@pbi-263
Feature: The Floor shows each item's cost to the cent
  The Floor's "In flight" table shows each item's cost as the raw sum of its stages' costs, to as many places
  as were stored, such as "$13.5412". Run detail already shows cost to the cent. With this item, the Floor's
  Cost column shows each item's cost the way Run detail does: to the cent, rounding half up, with "<$0.01"
  for a cost above zero too small to round to a cent, and "$0.00" for no cost at all. Hovering the Cost
  cell shows the exact figure, as hovering a Cost cell on Run detail does.
  An item's cost on the Floor is the sum of the costs of its open run's stages.
  Scenarios tagged @db need Postgres, which each test starts for itself, so cells and CI both run them.

  Background:
    Given item "263" titled "Export a month" is an issue in the repo "acme/widgets"
    And the item is in flight in the "build" stage

  Rule: The Floor's Cost column shows each item's cost rounded to the cent, as Run detail does

    @ac-1 @db
    Scenario: An item's cost shows rounded to the cent
      Given the item's "specify" stage cost $6.0412
      And the item's "build" stage cost $7.5000
      When a viewer opens Floor
      Then the "Production Line" table shows a cost of exactly "$13.54" for the item
      And the "Production Line" table doesn't show "$13.5412"

    @ac-1 @db
    Scenario: An item's cost under a dollar shows rounded to the nearest cent
      Given the item's "specify" stage cost $0.5291
      When a viewer opens Floor
      Then the "Production Line" table shows a cost of exactly "$0.53" for the item

    @ac-1 @db
    Scenario Outline: An item that cost <cost> shows "<shown>", as Run detail shows the same cost
      Given the item's "specify" stage cost <cost>
      When a viewer opens Floor
      Then the "Production Line" table shows a cost of exactly "<shown>" for the item
      When a viewer opens the item's Run detail
      Then the Stages table shows a cost of exactly "<shown>" for the "specify" stage

      Examples:
        | cost      | shown   |
        | $0.0050   | $0.01   |
        | $0.0149   | $0.01   |
        | $1.2350   | $1.24   |
        | $1.2349   | $1.23   |
        | $12.9950  | $13.00  |
        | $123.4567 | $123.46 |

    @ac-1 @db
    Scenario: Each item in flight shows its own cost to the cent
      Given item "264" titled "Import a year" is an issue in the repo "acme/widgets"
      And item "264" is in flight in the "specify" stage
      And the item's "specify" stage cost $2.0049
      And item "264"'s "specify" stage cost $0.7351
      When a viewer opens Floor
      Then the "Production Line" table shows a cost of exactly "$2.00" for "Export a month"
      And the "Production Line" table shows a cost of exactly "$0.74" for "Import a year"

  Rule: A cost above zero that rounds to nothing shows "<$0.01", and no cost shows "$0.00"

    @ac-2 @db
    Scenario: A cheap item never reads as free
      Given the item's "specify" stage cost $0.0031
      When a viewer opens Floor
      Then the "Production Line" table shows a cost of exactly "<$0.01" for the item
      And the "Production Line" table doesn't show a cost of "$0.00" for the item

    @ac-2 @db
    Scenario Outline: An item that cost <cost> in all shows "<shown>"
      Given the item's "specify" stage cost <specify>
      And the item's "build" stage cost <build>
      When a viewer opens Floor
      Then the "Production Line" table shows a cost of exactly "<shown>" for the item

      Examples:
        | cost    | specify | build   | shown  |
        | $0.0001 | $0.0001 | $0      | <$0.01 |
        | $0.0049 | $0.0024 | $0.0025 | <$0.01 |
        | $0.0050 | $0.0025 | $0.0025 | $0.01  |

    @ac-2 @db
    Scenario: An item whose stages spent nothing shows a cost of nothing
      Given the item's "specify" stage cost $0
      And the item's "build" stage cost $0
      When a viewer opens Floor
      Then the "Production Line" table shows a cost of exactly "$0.00" for the item
      And the "Production Line" table doesn't show a cost of "<$0.01" for the item

    @ac-2 @db
    Scenario: An item with no stage cost recorded yet shows a cost of nothing
      Given the item has no stage cost recorded
      When a viewer opens Floor
      Then the "Production Line" table shows a cost of exactly "$0.00" for the item

  Rule: Hovering the Floor's Cost cell shows the exact figure, as Run detail's Cost cells do

    @ac-3 @db
    Scenario: Hovering an item's cost shows the exact figure
      Given the item's "specify" stage cost $6.0412
      And the item's "build" stage cost $7.5000
      When a viewer opens Floor
      And the viewer hovers over the item's cost in the "Production Line" table
      Then the viewer sees the exact cost "$13.5412"

    @ac-3 @db
    Scenario: Hovering a cheap item's cost shows what it really cost
      Given the item's "specify" stage cost $0.0031
      When a viewer opens Floor
      And the viewer hovers over the item's cost in the "Production Line" table
      Then the viewer sees the exact cost "$0.0031"

    @ac-3 @db
    Scenario: Hovering an item's cost on the Floor shows the same exact figure as on Run detail
      Given the item's "specify" stage cost $0.5291
      When a viewer opens Floor
      And the viewer hovers over the item's cost in the "Production Line" table
      Then the viewer sees the exact cost "$0.5291"
      When a viewer opens the item's Run detail
      And the viewer hovers over the "specify" stage's cost in the Stages table
      Then the viewer sees the exact cost "$0.5291"
