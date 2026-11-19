@pbi-228
Feature: A parent abandoned after its split was filed moves to Split, and to Done once its children are
  Before PBI 225, a parent whose split the factory filed lost its opt-in label, and the next poll
  withdrew it to Abandoned. PBI 225 sends such a parent to Split instead, but only from NotReady, so
  parents split before it, such as #121, #172 and #174, still sit in Abandoned. Abandoned says the
  work was dropped, when it went on in the children. Split's one way out, to Done once every child
  the factory filed is Done (PBI 226), never reaches them either.
  With this item, an Abandoned parent with a split kept in the factory and filed as children moves
  to Split once. A migration or the next poll can make the move; these scenarios start the factory
  and poll, so either passes. A parent moved this way then follows PBI 226: once every child the
  factory filed for it is Done, it moves to Done, gets the comment naming each child and the PR that
  closed it, and is closed as completed. An Abandoned item with no split stays Abandoned.
  Each scenario about an item that stays Abandoned or Split also checks a parent that must move in
  the same run, which shows the factory told the two apart.
  Every scenario needs Postgres, which each test starts for itself, so cells and CI both run them.
  The board, the repo, the readiness judge and the coding model are fakes.

  Background:
    Given a repo "acme/shop" whose board's backlog status is "Backlog" and whose opt-in label is "factory"
    And a parent issue "Checkout redesign" in "acme/shop" on that board
    And the factory split the parent issue before PBI 225, into "Card payments", "Bank transfers" and "Payment receipts"
    And the factory kept that split for the parent issue
    And the parent issue has 3 sub-issues, one for each child of that split
    And the parent issue no longer carries the label "factory"
    And the parent's history shows a move "withdrawn", from "NotReady" to "Abandoned"
    And the factory holds the parent issue in state "Abandoned"

  Rule: An Abandoned parent whose split was filed moves to Split, once

    @ac-1 @db
    Scenario: An Abandoned parent whose split was filed is Split after the factory starts and polls
      Given the factory holds child "Card payments" in state "InProgress"
      When the factory starts and polls the backlog once
      Then the factory holds the parent issue in state "Split"
      And the parent's history shows exactly one move from "Abandoned" to "Split"

    @ac-1 @db
    Scenario: Every parent abandoned after its split was filed moves to Split in the same run
      Given these parent issues in "acme/shop" were also split before PBI 225 and are held in state "Abandoned":
        | parent         | children                      |
        | Loyalty points | Earn points, Spend points     |
        | Gift cards     | Buy a gift card, Redeem cards |
      When the factory starts and polls the backlog once
      Then the factory holds the parent issue in state "Split"
      And the factory holds parent "Loyalty points" in state "Split"
      And the factory holds parent "Gift cards" in state "Split"

    @ac-1 @db
    Scenario: Later restarts and polls don't move a parent a second time
      Given the factory holds child "Card payments" in state "InProgress"
      When the factory starts and polls the backlog once
      And the factory restarts and polls the backlog three more times
      Then the factory holds the parent issue in state "Split"
      And the parent's history shows exactly one move from "Abandoned" to "Split"
      And the parent's history shows no move after its move to "Split"

    @ac-1 @db
    Scenario: A moved parent files no child again and isn't gated again
      When the factory starts and polls the backlog twice
      Then the factory holds the parent issue in state "Split"
      And the parent issue has exactly 3 sub-issues
      And the readiness judge was not asked about the parent issue
      And the coding model was not asked to split the parent issue

    @ac-1 @db
    Scenario: An Abandoned parent whose label a person put back moves to Split, not back through the gate
      Given the owner has put the label "factory" back on the parent issue
      When the factory starts and polls the backlog twice
      Then the factory holds the parent issue in state "Split"
      And the parent's history shows no move "returned"
      And the parent's history shows no move to "Eligible"
      And the readiness judge was not asked about the parent issue
      And the parent issue has exactly 3 sub-issues

  Rule: An Abandoned item with no filed split stays Abandoned

    @ac-1 @db
    Scenario: An item withdrawn from NotReady with no split stays Abandoned while the split parent moves
      Given an issue "Saved carts" in "acme/shop" on that board that the factory never split
      And a person took the label "factory" off "Saved carts" while the factory held it in state "NotReady"
      And the factory holds "Saved carts" in state "Abandoned"
      When the factory starts and polls the backlog once
      Then the factory holds the parent issue in state "Split"
      And the factory holds "Saved carts" in state "Abandoned"
      And the history of "Saved carts" shows no move to "Split"

    @ac-1 @db
    Scenario: An item that timed out waiting for sign-off stays Abandoned while the split parent moves
      Given an issue "Wish lists" in "acme/shop" on that board that the factory never split
      And the factory holds "Wish lists" in state "Abandoned" after it timed out in state "SignOff"
      When the factory starts and polls the backlog once
      Then the factory holds the parent issue in state "Split"
      And the factory holds "Wish lists" in state "Abandoned"
      And the history of "Wish lists" shows no move to "Split"

  Rule: A parent moved to Split moves on to Done once every child the factory filed for it is Done

    @ac-1 @db
    Scenario: A moved parent whose children are all Done ends up Done
      Given the factory holds child "Card payments" in state "Done", closed by PR 61
      And the factory holds child "Bank transfers" in state "Done", closed by PR 62
      And the factory holds child "Payment receipts" in state "Done", closed by PR 63
      When the factory starts and polls the backlog twice
      Then the factory holds the parent issue in state "Done"
      And the parent's history shows exactly one move from "Abandoned" to "Split"
      And the parent's history shows exactly one move from "Split" to "Done"
      And the parent's history shows the move to "Split" before the move to "Done"

    @ac-1 @db
    Scenario: A moved parent whose children are all Done gets one comment naming each child and its PR, then is closed as completed
      Given the factory holds child "Card payments" in state "Done", closed by PR 61
      And the factory holds child "Bank transfers" in state "Done", closed by PR 62
      And the factory holds child "Payment receipts" in state "Done", closed by PR 63
      When the factory starts and polls the backlog twice
      Then the parent issue has one comment saying its children are done
      And that comment pairs each child with the PR that closed it:
        | child            | PR |
        | Card payments    | 61 |
        | Bank transfers   | 62 |
        | Payment receipts | 63 |
      And the parent issue is closed as completed
      And the parent issue was closed after the comment saying its children are done was posted

    @ac-1 @db
    Scenario: Later polls leave a moved Done parent Done, with no second comment
      Given the factory holds child "Card payments" in state "Done", closed by PR 61
      And the factory holds child "Bank transfers" in state "Done", closed by PR 62
      And the factory holds child "Payment receipts" in state "Done", closed by PR 63
      When the factory starts and polls the backlog twice
      And the factory restarts and polls the backlog three more times
      Then the factory holds the parent issue in state "Done"
      And the parent's history shows no move after its move to "Done"
      And the parent issue has one comment saying its children are done

  Rule: A moved parent with any child not Done stays Split and open until every child is Done

    @ac-1 @db
    Scenario: A moved parent stays Split while a child is still being worked, and moves to Done once it is
      Given the factory holds child "Card payments" in state "Done", closed by PR 61
      And the factory holds child "Bank transfers" in state "Done", closed by PR 62
      And the factory holds child "Payment receipts" in state "InProgress"
      When the factory starts and polls the backlog twice
      Then the factory holds the parent issue in state "Split"
      And the parent issue is still open
      And the parent issue has no comment saying its children are done
      When the factory now holds child "Payment receipts" in state "Done", closed by PR 63
      And the factory polls the backlog once more
      Then the factory holds the parent issue in state "Done"
      And the parent issue is closed as completed

    @ac-1 @db
    Scenario Outline: A moved parent whose child is <state> stays Split and open
      Given the factory holds child "Card payments" in state "Done", closed by PR 61
      And the factory holds child "Bank transfers" in state "Done", closed by PR 62
      And the factory holds child "Payment receipts" in state "<state>"
      When the factory starts and polls the backlog twice
      Then the factory holds the parent issue in state "Split"
      And the parent issue is still open
      And the parent issue has no comment saying its children are done

      Examples:
        | state     |
        | Failed    |
        | Abandoned |
