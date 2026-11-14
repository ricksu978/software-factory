@pbi-144
Feature: The factory files a proposed split as child PBIs for the owner to approve
  When the readiness gate finds an item oversized and the coding model proposes a valid split, the
  factory already posts the split on the parent as a proposal. With this item the factory also
  files each proposed child as an issue of its own: a sub-issue of the parent, on the parent's
  board in the backlog status, blocked by the earlier children it needs. Since PBI 237 each child
  carries the opt-in label as it's filed, and the owner withdraws a child by taking it off; PBI
  237's scenarios cover that, so this file no longer says no child carries it. The parent leaves
  the factory and says where its children are. Filing is safe to repeat: a parent that already has
  sub-issues is never split again, and filing that stops partway is finished on the next poll
  without filing any child twice. The board, the repo and the coding model are scripted here, so
  these scenarios need no model, no database and no network.

  Background:
    Given a repo "acme/shop" whose board's backlog status is "Backlog" and whose opt-in label is "factory"
    And a parent issue "Checkout redesign" in "acme/shop" on that board, carrying the label "factory"
    And the parent issue has these acceptance criteria:
      | index | text                                         |
      | 1     | A shopper can pay by card                    |
      | 2     | A shopper can pay by bank transfer           |
      | 3     | A failed payment shows the reason            |
      | 4     | A receipt is emailed after every payment     |
    And the readiness judge finds the parent issue oversized
    And the coding model proposes this split of the parent issue:
      | child | title             | body                                   | criteria | needs |
      | 1     | Card payments     | Card payments for Checkout redesign    | 1, 3     |       |
      | 2     | Bank transfers    | Bank transfers for Checkout redesign   | 2        | 1     |
      | 3     | Payment receipts  | Receipts for Checkout redesign         | 4        | 1, 2  |

  Rule: Each proposed child is filed as an issue in the parent's repo, with the proposal's title, body and criteria

    @ac-1
    Scenario: A valid split files one issue per child in the parent's repo
      When the factory polls the backlog
      Then "acme/shop" holds 3 new issues
      And the new issues are titled "Card payments", "Bank transfers" and "Payment receipts"

    @ac-1
    Scenario: Each child's issue carries the proposal's body
      When the factory polls the backlog
      Then the body of child "Card payments" starts with "Card payments for Checkout redesign"
      And the body of child "Bank transfers" starts with "Bank transfers for Checkout redesign"
      And the body of child "Payment receipts" starts with "Receipts for Checkout redesign"

    @ac-1
    Scenario: Each child's criteria sit word for word under the acceptance criteria heading
      When the factory polls the backlog
      Then child "Card payments" lists under its acceptance criteria heading, in order:
        | text                              |
        | A shopper can pay by card         |
        | A failed payment shows the reason |
      And child "Bank transfers" lists under its acceptance criteria heading, in order:
        | text                               |
        | A shopper can pay by bank transfer |
      And child "Payment receipts" lists under its acceptance criteria heading, in order:
        | text                                     |
        | A receipt is emailed after every payment |

    @ac-1
    Scenario: The factory reads each filed child's criteria back the same as the proposal
      When the factory polls the backlog
      Then the factory reads child "Card payments" as having 2 acceptance criteria
      And the factory reads child "Bank transfers" as having 1 acceptance criterion
      And the factory reads child "Payment receipts" as having 1 acceptance criterion

  Rule: Each child is a sub-issue of the parent, on the parent's board in the backlog status, blocked by the earlier children it needs

    @ac-2
    Scenario: Every child is a sub-issue of the parent, in the proposal's order
      When the factory polls the backlog
      Then the parent issue has these sub-issues, in order:
        | title            |
        | Card payments    |
        | Bank transfers   |
        | Payment receipts |

    @ac-2
    Scenario: Every child sits on the parent's board in the backlog status
      When the factory polls the backlog
      Then child "Card payments" is on the parent's board with status "Backlog"
      And child "Bank transfers" is on the parent's board with status "Backlog"
      And child "Payment receipts" is on the parent's board with status "Backlog"

    @ac-2
    Scenario: Each child is blocked by exactly the earlier children it needs
      When the factory polls the backlog
      Then child "Card payments" is blocked by nothing
      And child "Bank transfers" is blocked by "Card payments" only
      And child "Payment receipts" is blocked by "Card payments" and "Bank transfers" only

    @ac-2
    Scenario: Children that need nothing are blocked by nothing
      Given the coding model instead proposes this split of the parent issue:
        | child | title             | body                                   | criteria | needs |
        | 1     | Card payments     | Card payments for Checkout redesign    | 1, 3     |       |
        | 2     | Bank transfers    | Bank transfers for Checkout redesign   | 2, 4     |       |
      When the factory polls the backlog
      Then the parent issue has 2 sub-issues
      And child "Card payments" is blocked by nothing
      And child "Bank transfers" is blocked by nothing

  Rule: A child enters the factory once it carries the opt-in label, and one it waits on holds it back

    @ac-3
    Scenario: A child enters the factory once the owner adds the opt-in label to it
      Given the factory has polled the backlog once
      And the owner has added the label "factory" to child "Card payments"
      When the factory polls the backlog again
      Then the factory takes up child "Card payments"
      And the factory has started no run for child "Bank transfers" or child "Payment receipts"

  Rule: Once the children are filed, the parent leaves the factory and links to each child

    @ac-4
    Scenario: The factory takes the opt-in label off the parent
      When the factory polls the backlog
      Then the parent issue has 3 sub-issues
      And the parent issue no longer carries the label "factory"

    @ac-4
    Scenario: The factory comments on the parent with a link to each child
      When the factory polls the backlog
      Then the parent issue has one comment linking to its children
      And that comment links to child "Card payments", child "Bank transfers" and child "Payment receipts"

    @ac-4
    Scenario: The parent, without its label, is not gated again on the next poll
      Given the factory has polled the backlog once
      When the factory polls the backlog again
      Then the parent issue has one comment linking to its children
      And the parent issue has one split proposal comment

  Rule: A parent that already has sub-issues is never split again

    @ac-5
    Scenario: Re-gating a parent whose children were filed files no second set
      Given the factory has polled the backlog once
      And the owner has put the label "factory" back on the parent issue
      When the factory polls the backlog again
      Then the parent issue has exactly 3 sub-issues
      And "acme/shop" holds exactly 3 new issues
      And the parent issue has one comment linking to its children

    @ac-5
    Scenario: Re-gating a parent whose text changed after its children were filed files no second set
      Given the factory has polled the backlog once
      And the owner has put the label "factory" back on the parent issue
      And the parent issue's body has since changed
      When the factory polls the backlog again
      Then the parent issue has exactly 3 sub-issues
      And "acme/shop" holds exactly 3 new issues

    @ac-5
    Scenario: A restart after the children were filed files no second set
      Given the factory has polled the backlog once
      And the factory has restarted
      When the factory polls the backlog again
      Then the parent issue has exactly 3 sub-issues
      And "acme/shop" holds exactly 3 new issues
      And the parent issue has one comment linking to its children

  Rule: Filing that fails partway is finished on the next poll, and no child is filed twice

    @ac-6
    Scenario: Filing that fails at the second child files the rest on the next poll
      Given the repo refuses the next filing of child "Bank transfers" once
      And the factory has polled the backlog once
      When the factory polls the backlog again
      Then the parent issue has these sub-issues, in order:
        | title            |
        | Card payments    |
        | Bank transfers   |
        | Payment receipts |
      And "acme/shop" holds exactly 1 issue titled "Card payments"
      And "acme/shop" holds exactly 3 new issues

    @ac-6
    Scenario: A child filed but not yet made a sub-issue is linked, not filed again
      Given the repo refuses to make child "Bank transfers" a sub-issue once
      And the factory has polled the backlog once
      When the factory polls the backlog again
      Then the parent issue has exactly 3 sub-issues
      And "acme/shop" holds exactly 1 issue titled "Bank transfers"
      And "acme/shop" holds exactly 3 new issues

    @ac-6
    Scenario: A child filed but not yet on the board is placed in the backlog status, not filed again
      Given the board refuses to add child "Payment receipts" once
      And the factory has polled the backlog once
      When the factory polls the backlog again
      Then child "Payment receipts" is on the parent's board with status "Backlog"
      And "acme/shop" holds exactly 1 issue titled "Payment receipts"
      And "acme/shop" holds exactly 3 new issues

    @ac-6
    Scenario: A child filed but not yet marked blocked gets its blocks on the next poll, not a second filing
      Given the repo refuses to mark child "Payment receipts" blocked by "Bank transfers" once
      And the factory has polled the backlog once
      When the factory polls the backlog again
      Then child "Payment receipts" is blocked by "Card payments" and "Bank transfers" only
      And "acme/shop" holds exactly 1 issue titled "Payment receipts"
      And "acme/shop" holds exactly 3 new issues

    @ac-6
    Scenario: The parent keeps its opt-in label and gets no link comment until every child is filed
      Given the repo refuses the next filing of child "Bank transfers" once
      When the factory polls the backlog
      Then the parent issue has exactly 1 sub-issue
      And the parent issue still carries the label "factory"
      And the parent issue has no comment linking to a child

    @ac-6
    Scenario: Once the missing children are filed, the parent loses its label and gets one link comment
      Given the repo refuses the next filing of child "Bank transfers" once
      And the factory has polled the backlog once
      When the factory polls the backlog again
      Then the parent issue no longer carries the label "factory"
      And the parent issue has one comment linking to its children
      And that comment links to child "Card payments", child "Bank transfers" and child "Payment receipts"

    @ac-6
    Scenario: Filing that fails after every child is filed only finishes the parent on the next poll
      Given the repo refuses to comment on the parent issue once
      And the factory has polled the backlog once
      When the factory polls the backlog again
      Then the parent issue has exactly 3 sub-issues
      And "acme/shop" holds exactly 3 new issues
      And the parent issue no longer carries the label "factory"
      And the parent issue has one comment linking to its children
