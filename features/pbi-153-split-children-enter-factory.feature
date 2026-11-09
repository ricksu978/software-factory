@pbi-153
Feature: The factory sends an oversized PBI's children straight into the factory, with no owner approval
  When the readiness judge finds an item oversized and the coding model proposes a valid split, the
  factory already files each child as a sub-issue of the parent, on the parent's board in the
  backlog status, blocked by the earlier children it needs. Until now no child carried the opt-in
  label, so the owner had to add it before a child entered the factory. With this item every child
  carries the opt-in label when it is filed, so it enters the factory on the next poll by itself.
  A child still waits for the children it is blocked by, still goes through the readiness gate and
  scenario sign-off like any other item, and is split in turn if it is oversized too. The comment
  on the parent says its children went into the factory. The board, the repo, the readiness judge
  and the coding model are scripted here, so these scenarios need no model and no network.

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
    And the readiness judge finds every child ready and not oversized
    And the coding model proposes this split of the parent issue:
      | child | title             | body                                   | criteria | needs |
      | 1     | Card payments     | Card payments for Checkout redesign    | 1, 3     |       |
      | 2     | Bank transfers    | Bank transfers for Checkout redesign   | 2        | 1     |
      | 3     | Payment receipts  | Receipts for Checkout redesign         | 4        | 1, 2  |

  Rule: Every child filed from a valid split carries the opt-in label, so it enters the factory with no owner action

    @ac-1
    Scenario: Every filed child carries the opt-in label
      When the factory polls the backlog
      Then the parent issue has 3 sub-issues
      And every one of the parent's sub-issues carries the label "factory"

    @ac-1
    Scenario: The next poll takes up the child that needs nothing, with no owner action
      Given the factory has polled the backlog once
      And the owner has done nothing since
      When the factory polls the backlog again
      Then the factory takes up child "Card payments"

    @ac-1
    Scenario: Children carry the repo's own opt-in label
      Given the repo's opt-in label is "build-me" instead
      And the parent issue carries the label "build-me" instead of "factory"
      When the factory polls the backlog
      Then every one of the parent's sub-issues carries the label "build-me"
      And none of the parent's sub-issues carries the label "factory"

    @ac-1
    Scenario: A child filed on the poll after a failed filing carries the opt-in label too
      Given the repo refuses the next filing of child "Bank transfers" once
      And the factory has polled the backlog once
      When the factory polls the backlog again
      Then the parent issue has 3 sub-issues
      And every one of the parent's sub-issues carries the label "factory"

  Rule: The factory starts a child only once every child it is blocked by is done

    @ac-2
    Scenario: Only the child blocked by nothing starts at first
      Given the factory has polled the backlog once
      When the factory polls the backlog again and schedules its work
      Then the factory starts a run for child "Card payments"
      And the factory has started no run for child "Bank transfers" or child "Payment receipts"

    @ac-2
    Scenario: A child starts once the one child it is blocked by is done
      Given the factory has polled the backlog once
      And the factory has polled the backlog again and scheduled its work
      And child "Card payments" is done
      When the factory polls the backlog again and schedules its work
      Then the factory starts a run for child "Bank transfers"
      And the factory has started no run for child "Payment receipts"

    @ac-2
    Scenario: A child blocked by two children waits while one of them is still open
      Given the factory has polled the backlog once
      And child "Card payments" is done
      And child "Bank transfers" is still open
      When the factory polls the backlog again and schedules its work
      Then the factory starts a run for child "Bank transfers"
      And the factory has started no run for child "Payment receipts"

    @ac-2
    Scenario: A child blocked by two children starts once both are done
      Given the factory has polled the backlog once
      And child "Card payments" is done
      And child "Bank transfers" is done
      When the factory polls the backlog again and schedules its work
      Then the factory starts a run for child "Payment receipts"

    @ac-2
    Scenario: Children that need nothing can all start
      Given the factory's WIP limit is 2
      And the coding model instead proposes this split of the parent issue:
        | child | title             | body                                   | criteria | needs |
        | 1     | Card payments     | Card payments for Checkout redesign    | 1, 3     |       |
        | 2     | Bank transfers    | Bank transfers for Checkout redesign   | 2, 4     |       |
      And the factory has polled the backlog once
      When the factory polls the backlog again and schedules its work
      Then the factory starts a run for child "Card payments"
      And the factory starts a run for child "Bank transfers"

  Rule: Each child goes through the readiness gate and scenario sign-off like any other item

    @ac-3
    Scenario: The readiness gate checks each child that enters the factory
      Given the factory has polled the backlog once
      When the factory polls the backlog again
      Then the readiness gate has checked child "Card payments" against the repo's definition of ready

    @ac-3
    Scenario: A child that fails the readiness gate does not start and is told why
      Given the readiness judge instead fails child "Card payments" because "Has no Size"
      And the factory has polled the backlog once
      When the factory polls the backlog again and schedules its work
      Then child "Card payments" has a readiness comment that quotes "Has no Size"
      And the factory has started no run for child "Card payments"

    @ac-3
    Scenario: A child's run waits for the owner to sign off its scenarios
      Given the factory has polled the backlog once
      And the factory has polled the backlog again and scheduled its work
      When the run for child "Card payments" writes its scenarios
      Then child "Card payments" waits for sign-off on its scenarios
      And the run for child "Card payments" builds nothing before the owner signs off

    @ac-3
    Scenario: A child whose scenarios the owner signs off goes on to the build
      Given the factory has polled the backlog once
      And the factory has polled the backlog again and scheduled its work
      And the run for child "Card payments" has written its scenarios
      When the owner signs off the scenarios of child "Card payments"
      Then the run for child "Card payments" goes on to build child "Card payments"

  Rule: The comment on the parent says its children went into the factory and links each one

    @ac-4
    Scenario: The parent's comment says its children went into the factory
      When the factory polls the backlog
      Then the parent issue has one comment linking to its children
      And that comment says the children went into the factory

    @ac-4
    Scenario: The parent's comment links each child
      When the factory polls the backlog
      Then that comment links to child "Card payments", child "Bank transfers" and child "Payment receipts"

    @ac-4
    Scenario: The parent's comment no longer asks the owner to add the opt-in label
      When the factory polls the backlog
      Then the parent issue has one comment linking to its children
      And that comment does not say any child lacks the label "factory"
      And that comment does not ask the owner to add the label "factory" to a child

    @ac-4
    Scenario: After filing fails partway, the parent still gets one comment saying its children went into the factory
      Given the repo refuses the next filing of child "Bank transfers" once
      And the factory has polled the backlog once
      When the factory polls the backlog again
      Then the parent issue has one comment linking to its children
      And that comment says the children went into the factory
      And that comment links to child "Card payments", child "Bank transfers" and child "Payment receipts"

  Rule: A child the readiness judge finds oversized is split the same way

    @ac-5
    Scenario: An oversized child gets its own children, filed as its sub-issues
      Given the readiness judge instead finds child "Card payments" oversized
      And the coding model proposes this split of child "Card payments":
        | child | title            | body                            | criteria | needs |
        | 1     | Card form        | The card form for Card payments | 1        |       |
        | 2     | Card failures    | Card failures for Card payments | 2        | 1     |
      And the factory has polled the backlog once
      When the factory polls the backlog again
      Then child "Card payments" has these sub-issues, in order:
        | title         |
        | Card form     |
        | Card failures |
      And child "Card failures" is blocked by "Card form" only

    @ac-5
    Scenario: An oversized child's children carry the opt-in label and the child leaves the factory
      Given the readiness judge instead finds child "Card payments" oversized
      And the coding model proposes this split of child "Card payments":
        | child | title            | body                            | criteria | needs |
        | 1     | Card form        | The card form for Card payments | 1        |       |
        | 2     | Card failures    | Card failures for Card payments | 2        | 1     |
      And the factory has polled the backlog once
      When the factory polls the backlog again
      Then every one of child "Card payments"'s sub-issues carries the label "factory"
      And child "Card payments" no longer carries the label "factory"
      And child "Card payments" has one comment linking to its children
      And the factory has started no run for child "Card payments"

    @ac-5
    Scenario: An oversized child's children enter the factory on the next poll
      Given the readiness judge instead finds child "Card payments" oversized
      And the coding model proposes this split of child "Card payments":
        | child | title            | body                            | criteria | needs |
        | 1     | Card form        | The card form for Card payments | 1        |       |
        | 2     | Card failures    | Card failures for Card payments | 2        | 1     |
      And the factory has polled the backlog twice
      When the factory polls the backlog again
      Then the factory takes up child "Card form"

    @ac-5
    Scenario: An oversized child whose split isn't sound files no children and says why
      Given the readiness judge instead finds child "Card payments" oversized
      And the coding model proposes a split of child "Card payments" that leaves criterion 2 uncovered
      And the factory has polled the backlog once
      When the factory polls the backlog again
      Then child "Card payments" has no sub-issues
      And child "Card payments" has a readiness comment that says why its split was not proposed
