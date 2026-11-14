@pbi-237
Feature: Children of a split get the opt-in label when the factory files them
  When the readiness gate finds an item oversized, the factory files the proposed split as child
  issues of the parent (PBI 144). Today no child carries the opt-in label, so the owner has to add
  it to each child before any enters the factory. With this item each child gets the opt-in label
  as it's filed, so the poller takes it in as Eligible and the readiness gate judges it like any
  other item. A child blocked by an earlier child still waits until that child's issue closes. A
  child of a factory-filed child doesn't get the label, so a split can't keep splitting without a
  person looking. The comment on the parent says the children are opted in, and that removing a
  child's label withdraws it. A child whose label the owner removes is withdrawn as any item is,
  and the factory never puts the label back. The board, the repo, the readiness judge and the
  coding model are scripted here, so these scenarios need no model and no network.

  Background:
    Given a repo "acme/shop" whose board's backlog status is "Backlog" and whose opt-in label is "factory"
    And a parent issue "Checkout redesign" in "acme/shop" on that board, carrying the label "factory"
    And the owner filed the parent issue by hand
    And the parent issue has these acceptance criteria:
      | index | text                                     |
      | 1     | A shopper can pay by card                |
      | 2     | A shopper can pay by bank transfer       |
      | 3     | A failed payment shows the reason        |
      | 4     | A receipt is emailed after every payment |
    And the readiness judge finds the parent issue oversized
    And the coding model proposes this split of the parent issue:
      | child | title            | body                                 | criteria | needs |
      | 1     | Card payments    | Card payments for Checkout redesign  | 1, 3     |       |
      | 2     | Bank transfers   | Bank transfers for Checkout redesign | 2        | 1     |
      | 3     | Payment receipts | Receipts for Checkout redesign       | 4        | 1, 2  |

  Rule: Each child of a split gets the opt-in label as it's filed, and enters the factory like any item

    @ac-1
    Scenario: Every filed child carries the opt-in label
      When the factory polls the backlog
      Then the parent issue has 3 sub-issues
      And child "Card payments" carries the label "factory"
      And child "Bank transfers" carries the label "factory"
      And child "Payment receipts" carries the label "factory"

    @ac-1
    Scenario: The poller takes in each child as Eligible on the next poll
      Given the factory has polled the backlog once
      When the factory polls the backlog again
      Then the factory holds child "Card payments" as an item
      And the factory holds child "Bank transfers" as an item
      And the factory holds child "Payment receipts" as an item
      And each child's history starts with a move to "Eligible"

    @ac-1
    Scenario: The readiness gate judges a child that passes every line and queues it
      Given the readiness judge passes every line for child "Card payments"
      And the factory has polled the backlog once
      When the factory polls the backlog again
      Then the readiness judge was asked about child "Card payments"
      And the factory holds child "Card payments" in state "Queued"

    @ac-1
    Scenario: The readiness gate holds back a child that fails a line, as it would any item
      Given the readiness judge fails child "Payment receipts" on the line "Names the email it sends"
      And the factory has polled the backlog once
      When the factory polls the backlog again
      Then the readiness judge was asked about child "Payment receipts"
      And the factory holds child "Payment receipts" in state "NotReady"
      And the dashboard's "Not ready" list shows child "Payment receipts"

    @ac-1
    Scenario: A child filed on the poll that finishes a partway filing still gets the label
      Given the repo refuses the next filing of child "Bank transfers" once
      And the factory has polled the backlog once
      When the factory polls the backlog again
      Then the parent issue has exactly 3 sub-issues
      And child "Card payments" carries the label "factory"
      And child "Bank transfers" carries the label "factory"
      And child "Payment receipts" carries the label "factory"

  Rule: A child blocked by an earlier child isn't claimed until that child's issue closes

    @ac-2
    Scenario: A ready child blocked by an open earlier child waits in the queue
      Given the readiness judge passes every line for every child
      And the factory has polled the backlog twice
      When the scheduler looks for work
      Then the factory holds child "Bank transfers" in state "Queued"
      And the factory has started no run for child "Bank transfers"

    @ac-2
    Scenario: A ready child with no blockers is claimed while its dependants wait
      Given the readiness judge passes every line for every child
      And the factory has polled the backlog twice
      When the scheduler looks for work
      Then the factory takes up child "Card payments"
      And the factory has started no run for child "Bank transfers" or child "Payment receipts"

    @ac-2
    Scenario: A child is claimed once the issue of the child it waits on closes
      Given the readiness judge passes every line for every child
      And the factory has polled the backlog twice
      And the issue of child "Card payments" has closed
      When the factory polls the backlog again
      And the scheduler looks for work
      Then the factory takes up child "Bank transfers"
      And the factory has started no run for child "Payment receipts"

    @ac-2
    Scenario: A child blocked by two earlier children waits until both issues close
      Given the readiness judge passes every line for every child
      And the factory has polled the backlog twice
      And the issue of child "Card payments" has closed
      And the issue of child "Bank transfers" is still open
      When the factory polls the backlog again
      And the scheduler looks for work
      Then the factory holds child "Payment receipts" in state "Queued"
      And the factory has started no run for child "Payment receipts"

  Rule: A child filed from a split of a factory-filed child doesn't get the label, and waits for the owner

    @ac-3
    Scenario: The children of a split of a factory-filed child carry no opt-in label
      Given the factory has polled the backlog once
      And the readiness judge finds child "Card payments" oversized
      And the coding model proposes this split of child "Card payments":
        | child | title         | body                            | criteria | needs |
        | 1     | Card capture  | Card capture for Card payments  | 1        |       |
        | 2     | Card failures | Card failures for Card payments | 2        | 1     |
      When the factory polls the backlog again
      And the factory polls the backlog again
      Then child "Card payments" has 2 sub-issues
      And the factory holds child "Card payments" as an item
      And none of child "Card payments"'s sub-issues carries the label "factory"

    @ac-3
    Scenario: The split of a factory-filed child is posted and filed as today
      Given the factory has polled the backlog once
      And the readiness judge finds child "Card payments" oversized
      And the coding model proposes this split of child "Card payments":
        | child | title         | body                            | criteria | needs |
        | 1     | Card capture  | Card capture for Card payments  | 1        |       |
        | 2     | Card failures | Card failures for Card payments | 2        | 1     |
      When the factory polls the backlog again
      And the factory polls the backlog again
      Then child "Card payments" has one split proposal comment
      And child "Card payments" has these sub-issues, in order:
        | title         |
        | Card capture  |
        | Card failures |
      And child "Card failures" is blocked by "Card capture" only
      And child "Card payments" no longer carries the label "factory"

    @ac-3
    Scenario: The factory takes up no grandchild until the owner adds the label to it
      Given the factory has polled the backlog once
      And the readiness judge finds child "Card payments" oversized
      And the coding model proposes this split of child "Card payments":
        | child | title         | body                            | criteria | needs |
        | 1     | Card capture  | Card capture for Card payments  | 1        |       |
        | 2     | Card failures | Card failures for Card payments | 2        | 1     |
      And the factory has polled the backlog twice more
      When the factory polls the backlog again
      Then the factory holds child "Card payments" as an item
      And the factory holds no item for "Card capture" or "Card failures"

    @ac-3
    Scenario: The link comment on a factory-filed child says its children wait for the owner
      Given the factory has polled the backlog once
      And the readiness judge finds child "Card payments" oversized
      And the coding model proposes this split of child "Card payments":
        | child | title         | body                            | criteria | needs |
        | 1     | Card capture  | Card capture for Card payments  | 1        |       |
        | 2     | Card failures | Card failures for Card payments | 2        | 1     |
      When the factory polls the backlog again
      And the factory polls the backlog again
      Then child "Card payments" has one comment linking to its children
      And the factory holds child "Card payments" as an item
      And that comment says none of the children carries the label "factory"

  Rule: The comment on the parent says the children are opted in, and that removing a child's label withdraws it

    @ac-4
    Scenario: The link comment says the children are opted in
      When the factory polls the backlog
      Then the parent issue has one comment linking to its children
      And that comment links to child "Card payments", child "Bank transfers" and child "Payment receipts"
      And that comment says the children carry the label "factory" and have entered the factory

    @ac-4
    Scenario: The link comment says removing a child's label withdraws it
      When the factory polls the backlog
      Then the parent issue has one comment linking to its children
      And that comment says removing the label "factory" from a child withdraws that child

    @ac-4
    Scenario: The link comment no longer asks the owner to add the label
      When the factory polls the backlog
      Then the parent issue has one comment linking to its children
      And that comment says the children carry the label "factory" and have entered the factory
      And that comment doesn't ask the owner to add the label "factory" to a child

  Rule: A child the owner removes the label from is withdrawn, and the factory doesn't put the label back

    @ac-5
    Scenario: A child whose label the owner removes is withdrawn on the next poll
      Given the factory has polled the backlog twice
      And the factory holds child "Bank transfers" as an item
      When the owner removes the label "factory" from child "Bank transfers"
      And the factory polls the backlog again
      Then the factory holds child "Bank transfers" in state "Abandoned"
      And the factory holds child "Card payments" in a state other than "Abandoned"

    @ac-5
    Scenario: The factory doesn't put the label back on a withdrawn child on later polls
      Given the factory has polled the backlog twice
      And the factory holds child "Bank transfers" as an item
      And the owner has removed the label "factory" from child "Bank transfers"
      When the factory polls the backlog 3 more times
      Then the factory holds child "Bank transfers" in state "Abandoned"
      And child "Bank transfers" doesn't carry the label "factory"
      And child "Card payments" carries the label "factory"

    @ac-5
    Scenario: Finishing a partway filing doesn't put the label back on a child the owner withdrew
      Given the repo refuses the next filing of child "Payment receipts" once
      And the factory has polled the backlog once
      And child "Card payments" carries the label "factory"
      And the owner has removed the label "factory" from child "Card payments"
      When the factory polls the backlog again
      Then the parent issue has exactly 3 sub-issues
      And child "Payment receipts" carries the label "factory"
      And child "Card payments" doesn't carry the label "factory"

    @ac-5
    Scenario: Re-gating the parent doesn't put the label back on a child the owner withdrew
      Given the factory has polled the backlog once
      And child "Card payments" carries the label "factory"
      And the owner has removed the label "factory" from child "Card payments"
      And the owner has put the label "factory" back on the parent issue
      When the factory polls the backlog again
      Then the parent issue has exactly 3 sub-issues
      And child "Card payments" doesn't carry the label "factory"
      And child "Bank transfers" carries the label "factory"
