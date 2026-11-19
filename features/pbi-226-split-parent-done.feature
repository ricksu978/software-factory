@pbi-226
Feature: A Split parent is closed as Done once every child the factory filed for it is Done
  When the readiness gate finds an item oversized, the factory files the proposed split as child
  issues and the parent rests in Split (PBIs 144 and 225). Split has no way out today, so a parent
  whose work is all finished stays open on the board with nothing left to do.
  With this item, once every child the factory filed for a Split parent reaches Done, the parent
  moves to Done. The factory comments on the parent issue with each child and the PR that closed
  it, then closes the parent issue as completed. A parent with any child that is Failed, Abandoned,
  or closed without being Done stays Split, open, and gets no such comment.
  Each scenario about a parent that stays Split also polls a second Split parent whose children are
  all Done, which must move to Done in the same poll. That shows the poll told the two apart.
  Scenarios tagged @db need Postgres, which each test starts for itself, so cells and CI both run
  them. The board, the repo, the readiness judge and the coding model are fakes.

  Background:
    Given a repo "acme/shop" whose board's backlog status is "Backlog" and whose opt-in label is "factory"
    And a parent issue "Checkout redesign" in "acme/shop" on that board, carrying the label "factory"
    And the readiness judge finds the parent issue oversized
    And the coding model proposes a split of the parent issue into "Card payments", "Bank transfers" and "Payment receipts"
    And the factory has polled the backlog twice, filing every child and taking the parent's label off
    And the factory holds the parent issue in state "Split"

  Rule: A Split parent moves to Done once every child the factory filed for it is Done

    @ac-1 @db
    Scenario: A parent whose children are all Done moves to Done on the next poll
      Given the factory holds child "Card payments" in state "Done", closed by PR 61
      And the factory holds child "Bank transfers" in state "Done", closed by PR 62
      And the factory holds child "Payment receipts" in state "Done", closed by PR 63
      When the factory polls the backlog once more
      Then the factory holds the parent issue in state "Done"
      And the parent's history shows exactly one move from "Split" to "Done"

    @ac-1 @db
    Scenario: A parent moves to Done only on the poll after its last child reaches Done
      Given the factory holds child "Card payments" in state "Done", closed by PR 61
      And the factory holds child "Bank transfers" in state "Done", closed by PR 62
      And the factory holds child "Payment receipts" in state "InReview" with PR 63 open
      And the factory has polled the backlog once more
      And the factory now holds child "Payment receipts" in state "Done", closed by PR 63
      When the factory polls the backlog once more
      Then the factory holds the parent issue in state "Done"
      And the parent's history shows exactly one move from "Split" to "Done"

    @ac-1 @db
    Scenario: A parent stays Split while a child is still being worked, and moves to Done once it is
      Given the factory holds child "Card payments" in state "Done", closed by PR 61
      And the factory holds child "Bank transfers" in state "Done", closed by PR 62
      And the factory holds child "Payment receipts" in state "InProgress"
      When the factory polls the backlog once more
      Then the factory holds the parent issue in state "Split"
      And the parent issue is still open
      When the factory now holds child "Payment receipts" in state "Done", closed by PR 63
      And the factory polls the backlog once more
      Then the factory holds the parent issue in state "Done"

    @ac-1 @db
    Scenario: A parent stays Split while a child has not yet entered the factory, and moves to Done once it is Done
      Given the factory holds child "Card payments" in state "Done", closed by PR 61
      And the factory holds child "Bank transfers" in state "Done", closed by PR 62
      And child "Payment receipts" has never carried the label "factory"
      When the factory polls the backlog once more
      Then the factory holds the parent issue in state "Split"
      When the owner adds the label "factory" to child "Payment receipts"
      And the factory now holds child "Payment receipts" in state "Done", closed by PR 63
      And the factory polls the backlog once more
      Then the factory holds the parent issue in state "Done"

    @ac-1 @db
    Scenario: A sub-issue a person added to the parent by hand doesn't hold the parent back
      Given the factory holds child "Card payments" in state "Done", closed by PR 61
      And the factory holds child "Bank transfers" in state "Done", closed by PR 62
      And the factory holds child "Payment receipts" in state "Done", closed by PR 63
      And a person has added an open issue "Gift cards" to the parent issue as a sub-issue
      When the factory polls the backlog once more
      Then the factory holds the parent issue in state "Done"
      And the parent issue is closed as completed

    @ac-1 @db
    Scenario: Later polls leave a Done parent Done
      Given the factory holds child "Card payments" in state "Done", closed by PR 61
      And the factory holds child "Bank transfers" in state "Done", closed by PR 62
      And the factory holds child "Payment receipts" in state "Done", closed by PR 63
      When the factory polls the backlog three more times
      Then the factory holds the parent issue in state "Done"
      And the parent's history shows exactly one move from "Split" to "Done"
      And the parent's history shows no move after its move to "Done"

  Rule: The factory comments on the parent with each child and the PR that closed it, then closes the parent as completed

    @ac-1 @db
    Scenario: The parent gets one comment naming each child and the PR that closed it
      Given the factory holds child "Card payments" in state "Done", closed by PR 61
      And the factory holds child "Bank transfers" in state "Done", closed by PR 62
      And the factory holds child "Payment receipts" in state "Done", closed by PR 63
      When the factory polls the backlog once more
      Then the parent issue has one comment saying its children are done
      And that comment pairs each child with the PR that closed it:
        | child            | PR |
        | Card payments    | 61 |
        | Bank transfers   | 62 |
        | Payment receipts | 63 |

    @ac-1 @db
    Scenario: The factory closes the parent issue as completed, after its comment
      Given the factory holds child "Card payments" in state "Done", closed by PR 61
      And the factory holds child "Bank transfers" in state "Done", closed by PR 62
      And the factory holds child "Payment receipts" in state "Done", closed by PR 63
      When the factory polls the backlog once more
      Then the parent issue is closed as completed
      And the parent issue was closed after the comment saying its children are done was posted

    @ac-1 @db
    Scenario: Later polls post no second comment on a Done parent
      Given the factory holds child "Card payments" in state "Done", closed by PR 61
      And the factory holds child "Bank transfers" in state "Done", closed by PR 62
      And the factory holds child "Payment receipts" in state "Done", closed by PR 63
      When the factory polls the backlog three more times
      Then the parent issue has one comment saying its children are done
      And the parent issue is closed as completed

  Rule: A Split parent with any child Failed, Abandoned, or closed without being Done stays Split

    Background:
      Given a second parent issue "Loyalty points" in "acme/shop" on that board, carrying the label "factory"
      And the readiness judge finds the second parent issue oversized
      And the coding model proposes a split of the second parent issue into "Earn points" and "Spend points"
      And the factory has polled the backlog twice more, filing every child of the second parent and taking its label off
      And the factory holds the second parent issue in state "Split"
      And the factory holds child "Earn points" in state "Done", closed by PR 71
      And the factory holds child "Spend points" in state "Done", closed by PR 72
      And the factory holds child "Card payments" in state "Done", closed by PR 61
      And the factory holds child "Bank transfers" in state "Done", closed by PR 62

    @ac-2 @db
    Scenario: A parent whose child is Failed stays Split
      Given the factory holds child "Payment receipts" in state "Failed"
      When the factory polls the backlog once more
      Then the factory holds the second parent issue in state "Done"
      And the factory holds the parent issue in state "Split"
      And the parent issue is still open
      And the parent issue has no comment saying its children are done

    @ac-2 @db
    Scenario: A parent whose child is Abandoned stays Split
      Given the factory holds child "Payment receipts" in state "Abandoned"
      When the factory polls the backlog once more
      Then the factory holds the second parent issue in state "Done"
      And the factory holds the parent issue in state "Split"
      And the parent issue is still open
      And the parent issue has no comment saying its children are done

    @ac-2 @db
    Scenario Outline: A parent whose child a person closed without it reaching Done stays Split, when <how>
      Given <how>
      When the factory polls the backlog once more
      Then the factory holds the second parent issue in state "Done"
      And the factory holds the parent issue in state "Split"
      And the parent issue is still open
      And the parent issue has no comment saying its children are done

      Examples:
        | how                                                                                                   |
        | a person closed child "Payment receipts" as not planned before it entered the factory                 |
        | a person closed child "Payment receipts" as completed before it entered the factory                   |
        | a person closed child "Payment receipts" as completed while the factory held it in state "InProgress" |

    @ac-2 @db
    Scenario: A parent stays Split across later polls while its child stays Failed
      Given the factory holds child "Payment receipts" in state "Failed"
      When the factory polls the backlog three more times
      Then the factory holds the second parent issue in state "Done"
      And the factory holds the parent issue in state "Split"
      And the parent's history shows no move after "split_filed"
