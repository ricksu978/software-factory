@pbi-227
Feature: A Split parent shows as Split on the board, on Floor and on Run detail
  Once the factory files an oversized parent's split as child issues and takes its opt-in label off, the
  parent rests in Split (PBI 225). With this item the parent's board status follows it there: the board
  gets the status the source's field map names for Split, and a field map that names no status for Split
  leaves the parent's board status as it was. Floor and the parent's Run detail show the parent as
  "Split into", with a link to each child's issue and the child's state. A child the factory holds shows
  its factory state. A child that hasn't entered the factory, because nobody has put the opt-in label on
  it yet, shows "Not in the factory".
  Scenarios tagged @db need Postgres, which each test starts for itself, so cells and CI both run them.
  The board, the repo, the readiness judge and the coding model are fakes.

  Background:
    Given a repo "acme/shop" whose board's backlog status is "Backlog" and whose opt-in label is "factory"
    And a parent issue "#40 Checkout redesign" in "acme/shop" on that board, carrying the label "factory"
    And the readiness judge finds the parent issue oversized
    And the coding model proposes a split of the parent issue into "Card payments", "Bank transfers" and "Payment receipts"
    And the repo files those children as issues "#41", "#42" and "#43", in that order

  Rule: A Split parent's board status is the status the field map names for Split, and with none named it stays as it was

    @ac-1 @db
    Scenario: A parent that moves to Split gets the board status the field map names for Split
      Given the board's field map names the status "Done" for Split
      When the factory polls the backlog until the parent issue is Split
      Then the parent issue's board status is "Done"

    @ac-1 @db
    Scenario: The board status comes from the field map, whatever name it gives
      Given the board's field map names the status "Split up" for Split
      When the factory polls the backlog until the parent issue is Split
      Then the parent issue's board status is "Split up"
      And the parent issue's board status was never set to "Done"

    @ac-1 @db
    Scenario: The children keep their backlog status when the parent's board status changes
      Given the board's field map names the status "Done" for Split
      When the factory polls the backlog until the parent issue is Split
      Then the parent issue's board status is "Done"
      And children "#41", "#42" and "#43" each have board status "Backlog"

    @ac-1 @db
    Scenario Outline: A board whose field map <how> leaves its Split parent's status as it was, while another board's Split parent moves
      Given the board's field map names the status "Done" for Split
      And a second repo "acme/billing" on a board of its own whose backlog status is "Backlog" and whose field map <how>
      And a parent issue "#7 Invoice redesign" in "acme/billing" on that board, carrying the label "factory", that the readiness judge finds oversized and the coding model splits in two
      When the factory polls the backlog until both parent issues are Split
      Then the parent issue "#40 Checkout redesign" has board status "Done"
      And the parent issue "#7 Invoice redesign" still has board status "Backlog"
      And the factory never set the board status of "#7 Invoice redesign" when it moved to Split

      Examples:
        | how                                        |
        | has no entry for Split                     |
        | names no status for Split, leaving it null |

    @ac-1 @db
    Scenario: A Split parent's board status is set once, not again on every later poll
      Given the board's field map names the status "Done" for Split
      And the factory has polled the backlog until the parent issue is Split
      And the owner has moved the parent issue's board status to "Archive"
      When the factory polls the backlog three more times
      Then the parent issue's board status is "Archive"

  Rule: Run detail shows a Split parent as "Split into", with a link to each child and the child's state

    @ac-2 @db
    Scenario: Run detail lists each child under "Split into", in the order of the split, linked to its issue
      Given the factory has polled the backlog until the parent issue is Split
      When a viewer opens the parent's Run detail
      Then the page shows "Split into" with these children, in order:
        | child                | link                                   |
        | #41 Card payments    | https://github.com/acme/shop/issues/41 |
        | #42 Bank transfers   | https://github.com/acme/shop/issues/42 |
        | #43 Payment receipts | https://github.com/acme/shop/issues/43 |

    @ac-2 @db
    Scenario: Run detail shows each child's state, and a child not yet in the factory says so
      Given the factory has polled the backlog until the parent issue is Split
      And the owner has put the label "factory" on child "#41" and the factory holds it in state "Queued"
      And the owner has put the label "factory" on child "#42" and the factory holds it in state "InProgress"
      When a viewer opens the parent's Run detail
      Then under "Split into", child "#41 Card payments" shows the state "Queued"
      And under "Split into", child "#42 Bank transfers" shows the state "InProgress"
      And under "Split into", child "#43 Payment receipts" shows "Not in the factory"

    @ac-2 @db
    Scenario: A child's state on Run detail follows the child as it moves
      Given the factory has polled the backlog until the parent issue is Split
      And the owner has put the label "factory" on child "#41" and the factory holds it in state "Queued"
      And a viewer has seen child "#41 Card payments" show the state "Queued" on the parent's Run detail
      When child "#41" moves to "Done"
      And a viewer opens the parent's Run detail again
      Then under "Split into", child "#41 Card payments" shows the state "Done"
      And under "Split into", child "#41 Card payments" doesn't show the state "Queued"

    @ac-2 @db
    Scenario: Run detail shows the parent's own state as Split beside the children
      Given the factory has polled the backlog until the parent issue is Split
      When a viewer opens the parent's Run detail
      Then the line with the item's state shows "Split"
      And the page shows "Split into" with 3 children

    @ac-2 @db
    Scenario: Run detail of an item that isn't Split shows no "Split into"
      Given the factory has polled the backlog until the parent issue is Split
      And the owner has put the label "factory" on child "#41" and the factory holds it in state "Queued"
      When a viewer opens the Run detail of child "#41 Card payments"
      Then the page doesn't show "Split into"
      When a viewer opens the parent's Run detail
      Then the page shows "Split into" with 3 children

  Rule: Floor shows a Split parent as "Split into", with a link to each child and the child's state

    @ac-2 @db
    Scenario: Floor shows a Split parent with a link to each of its children
      Given the factory has polled the backlog until the parent issue is Split
      When a viewer opens Floor
      Then Floor shows "#40 Checkout redesign" as "Split into" these children, in order:
        | child                | link                                   |
        | #41 Card payments    | https://github.com/acme/shop/issues/41 |
        | #42 Bank transfers   | https://github.com/acme/shop/issues/42 |
        | #43 Payment receipts | https://github.com/acme/shop/issues/43 |

    @ac-2 @db
    Scenario: Floor shows each child's state, and a child not yet in the factory says so
      Given the factory has polled the backlog until the parent issue is Split
      And the owner has put the label "factory" on child "#41" and the factory holds it in state "InReview"
      When a viewer opens Floor
      Then under "#40 Checkout redesign" on Floor, child "#41 Card payments" shows the state "InReview"
      And under "#40 Checkout redesign" on Floor, child "#42 Bank transfers" shows "Not in the factory"
      And under "#40 Checkout redesign" on Floor, child "#43 Payment receipts" shows "Not in the factory"

    @ac-2 @db
    Scenario: Each Split parent on Floor lists only its own children
      Given the factory has polled the backlog until the parent issue is Split
      And a second parent issue "#50 Search revamp" in "acme/shop", carrying the label "factory", that the factory has split into "#51 Search filters" and "#52 Search ranking"
      When a viewer opens Floor
      Then Floor shows "#40 Checkout redesign" as "Split into" "#41", "#42" and "#43", and nothing else
      And Floor shows "#50 Search revamp" as "Split into" "#51" and "#52", and nothing else

    @ac-2 @db
    Scenario: Floor's "Split into" link to a child is its own link, apart from the parent's links
      Given the factory has polled the backlog until the parent issue is Split
      When a viewer opens Floor
      Then "#41 Card payments" under "#40 Checkout redesign" links to "https://github.com/acme/shop/issues/41"
      And "#40" on Floor still links to "https://github.com/acme/shop/issues/40"
      And "Checkout redesign" on Floor still links to the parent's Run detail

    @ac-2 @db
    Scenario: A child's title shows as text, never as markup
      Given the coding model instead proposes a split whose first child is titled "Card <b>payments</b>"
      And the factory has polled the backlog until the parent issue is Split
      When a viewer opens Floor
      Then Floor shows the child "#41 Card <b>payments</b>" under "Split into" as written
      And the page has no bold element from the child's title
      When a viewer opens the parent's Run detail
      Then the page shows the child "#41 Card <b>payments</b>" under "Split into" as written
      And the page has no bold element from the child's title
