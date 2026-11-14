@pbi-218 @db
Feature: Outbox rows are written in the same transaction as their event
  Step 3 of the control plane redesign (2026-11-07 design, §07 "An outbox in place of hooks") replaces the
  after-commit hooks with an outbox. This first part only writes the rows; nothing handles them yet. Each
  outbox row names its consumer, the event that caused it and the item it is for. A transition and an
  operator's override each write a row for the board mirror. An applied decision writes a row for the
  decision announcement. A webhook comment writes a row for comment commands, one per item the comment names.
  Because each row is written in the same transaction as its event, both commit or neither does: a
  transaction that rolls back leaves neither the event nor any outbox row behind.
  A comment names an item by its issue number. The same number can belong to an item on each of several
  boards, so one comment can name more than one known item. A comment whose number matches no item on any
  board gets no row, because there is nothing for a comment command to act on.
  Every scenario needs Postgres, which each test starts for itself, so cells and CI both run them.
  The outbox starts empty in every scenario.

  Background:
    Given a fresh factory database with two boards, "main" and "side"
    And the outbox is empty

  Rule: A transition writes its board mirror row with its event, and a rollback leaves neither

    @ac-1
    Scenario: A committed transition leaves one board mirror row for its event
      Given item "#11" on board "main" is "Queued"
      When the scheduler moves item "#11" on board "main" to "InProgress" and the transaction commits
      Then the outbox holds exactly one row for the board mirror, for item "#11" on board "main"
      And that row points at the transition event from "Queued" to "InProgress"
      And that row has not been attempted yet and is not set aside

    @ac-1
    Scenario: A transition whose transaction rolls back leaves no outbox row
      Given item "#11" on board "main" is "Queued"
      When the scheduler moves item "#11" on board "main" to "InProgress" in a transaction that then fails and rolls back
      Then inside that transaction, before it rolled back, the outbox held a board mirror row for the transition's event
      And after the rollback the outbox holds no row
      And item "#11" on board "main" is still "Queued" with no transition event recorded

    @ac-1
    Scenario: Two transitions of one item in one transaction each write their own row, in order
      Given item "#11" on board "main" is "InReview"
      When item "#11" on board "main" moves to "Accepted" on a merge and then to "Done" on a verified definition of done, in one transaction that commits
      Then the outbox holds two board mirror rows for item "#11" on board "main"
      And the earlier row points at the move to "Accepted" and the later row at the move to "Done"

    @ac-1
    Scenario: A transition the state machine refuses writes no event and no row, while a legal one still does
      Given item "#11" on board "main" is "Queued"
      And item "#12" on board "main" is "Queued"
      When the scheduler tries to move item "#11" on board "main" along an edge that doesn't exist from "Queued"
      And the scheduler moves item "#12" on board "main" to "InProgress" and the transaction commits
      Then the outbox holds exactly one row, the board mirror row for item "#12" on board "main"

  Rule: An operator's override writes its board mirror row with its event, and a rollback leaves neither

    @ac-1
    Scenario: A committed override leaves one board mirror row for its event
      Given item "#11" on board "main" is "InProgress"
      When an operator overrides item "#11" on board "main" to "Failed" with the reason "stuck run" and the transaction commits
      Then the outbox holds exactly one row for the board mirror, for item "#11" on board "main"
      And that row points at the override event to "Failed" with the reason "stuck run"

    @ac-1
    Scenario: An override whose transaction rolls back leaves no outbox row
      Given item "#11" on board "main" is "InProgress"
      When an operator overrides item "#11" on board "main" to "Failed" in a transaction that then fails and rolls back
      Then inside that transaction, before it rolled back, the outbox held a board mirror row for the override's event
      And after the rollback the outbox holds no row
      And item "#11" on board "main" is still "InProgress" with no override event recorded

  Rule: An applied decision writes its announcement row with its event, and a rollback leaves neither

    @ac-1
    Scenario: A product owner's sign-off leaves one announcement row for its decision event
      Given item "#11" on board "main" is waiting in "SignOff" for its scenarios to be signed off
      And "Pat" is a product owner
      When "Pat" approves the scenarios of item "#11" on board "main" and the transaction commits
      Then the outbox holds exactly one row for the decision announcement, for item "#11" on board "main"
      And that row points at the "approve" decision event by "Pat"

    @ac-1
    Scenario: A decision whose transaction rolls back leaves no outbox row
      Given item "#11" on board "main" is waiting in "SignOff" for its scenarios to be signed off
      And "Pat" is a product owner
      When "Pat" approves the scenarios of item "#11" on board "main" in a transaction that then fails and rolls back
      Then inside that transaction, before it rolled back, the outbox held a decision announcement row for the decision's event
      And after the rollback the outbox holds no row
      And no decision event is recorded for item "#11" on board "main"

    @ac-1
    Scenario: A decision that also requeues an abandoned item writes an announcement row and a board mirror row
      Given item "#11" on board "main" went to "Abandoned" after timing out on a question still waiting for an answer
      And "Olu" is an operator
      When "Olu" answers the question of item "#11" on board "main" and the transaction commits
      Then the outbox holds one board mirror row for the move from "Abandoned" to "Queued"
      And the outbox holds one decision announcement row for the "answer" decision event by "Olu"
      And both rows are for item "#11" on board "main"

    @ac-1
    Scenario: A refused decision writes no row, while an applied one beside it does
      Given item "#11" on board "main" is waiting in "SignOff" for its scenarios to be signed off
      And item "#12" on board "main" is waiting in "SignOff" for its scenarios to be signed off
      And "Olu" is an operator but not a product owner
      And "Pat" is a product owner
      When "Olu" tries to approve the scenarios of item "#11" on board "main" and is refused
      And "Pat" approves the scenarios of item "#12" on board "main" and the transaction commits
      Then the outbox holds exactly one row, the decision announcement row for item "#12" on board "main"

  Rule: A webhook comment writes its comment command rows with its event, and a rollback leaves neither

    @ac-1
    Scenario: A webhook comment on a known item leaves a comment command row for its webhook event
      Given item "#11" exists on board "main" only
      When GitHub delivers a comment "/approve" on issue "#11"
      Then the webhook event for that delivery is recorded
      And the outbox holds exactly one row for comment commands, for item "#11" on board "main"
      And that row points at the webhook event for that delivery

    @ac-1
    Scenario: A webhook comment whose transaction rolls back leaves no outbox row
      Given item "#11" exists on board "main" only
      When GitHub delivers a comment "/approve" on issue "#11" and the intake transaction fails after recording the event
      Then inside that transaction, before it rolled back, the outbox held a comment command row for the webhook event
      And after the rollback the outbox holds no row
      And no webhook event is recorded for that delivery

    @ac-1
    Scenario: A redelivered comment writes no second row
      Given item "#11" exists on board "main" only
      When GitHub delivers a comment "/approve" on issue "#11"
      And GitHub redelivers the same delivery
      Then the outbox holds exactly one row for comment commands, for item "#11" on board "main"
      And exactly one webhook event is recorded for that delivery

  Rule: A comment writes one comment command row per known item it names, and none when it names no known item

    @ac-2
    Scenario: A comment whose issue number matches an item on each of two boards writes one row per item
      Given item "#11" exists on board "main"
      And item "#11" exists on board "side"
      When GitHub delivers a comment "/approve" on issue "#11"
      Then the outbox holds exactly two rows for comment commands
      And one row is for item "#11" on board "main" and the other for item "#11" on board "side"
      And both rows point at the same webhook event for that delivery

    @ac-2
    Scenario: A comment whose issue number matches an item on only one board writes one row
      Given item "#11" exists on board "main"
      And board "side" has no item "#11"
      When GitHub delivers a comment "/approve" on issue "#11"
      Then the outbox holds exactly one row for comment commands, for item "#11" on board "main"

    @ac-2
    Scenario: A comment that names no known item writes no row, while one that names a known item does
      Given item "#11" exists on board "main"
      And no board has an item "#99"
      When GitHub delivers a comment "/approve" on issue "#99"
      And GitHub then delivers a comment "/approve" on issue "#11"
      Then the webhook events for both deliveries are recorded
      And the outbox holds exactly one row for comment commands, for item "#11" on board "main"
      And no outbox row points at the webhook event for the comment on issue "#99"
