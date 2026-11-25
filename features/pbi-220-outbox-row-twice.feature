@pbi-220 @db
Feature: Handling an outbox row twice has no extra effect
  Step 3 of the control plane redesign (2026-11-07 design, §07 "An outbox in place of hooks") continues here.
  PBI 219 made the worker the one place outbox rows are handled. The worker removes a row only once every effect
  of it has succeeded. A worker that crashes after the effects but before the removal therefore handles the same
  row again. So does a row whose effects only partly succeeded. Handling a row again must change nothing more on
  the board and post no more comments: the board is set to each status once, the item is claimed, released and
  closed once, and each comment appears once.
  Every scenario needs Postgres, which each test starts for itself, so cells and CI both run them. They run the
  worker against a fake board and a fake repo host. "The worker handles a row twice" means the worker runs that
  one row's effects, then runs them again before the row is removed, as it would after a crash. "The worker works
  through the outbox" means the worker handles every row that is due, once, and then stops. "The board was set to
  a status once" counts every time the factory set that status on the item, including a repeat of the same status.

  Background:
    Given a fresh factory database with two boards, "main" and "side"
    And the board "main" shows a status for each of "InProgress", "SignOff", "NeedsInput", "Failed" and "Done"
    And the outbox is empty

  Rule: A transition's row handled twice changes the board once and comments once

    @ac-1
    Scenario: A move to sign-off handled twice sets the status once and posts one comment
      Given item "#11" on board "main" is "InProgress" with a running cell
      When the cell reports through the cell API that its scenarios are ready for sign-off
      And the worker handles item "#11"'s board mirror row twice, as it would after a crash before removing it
      Then the board was set to the status for "SignOff" on item "#11" once
      And item "#11" on the board has exactly one comment saying it waits for sign-off on the scenarios

    @ac-1
    Scenario: A start of work handled twice sets the status once and claims the item once
      Given item "#11" on board "main" is "Queued"
      When the scheduler moves item "#11" on board "main" to "InProgress"
      And the worker handles item "#11"'s board mirror row twice, as it would after a crash before removing it
      Then the board was set to the status for "InProgress" on item "#11" once
      And the board claimed item "#11" once

    @ac-1
    Scenario: A question handled twice sets the status once and asks it in one comment
      Given item "#11" on board "main" is "InProgress" with a running cell
      When the cell asks "Which currency should totals use?" and item "#11" moves to "NeedsInput"
      And the worker handles item "#11"'s board mirror row twice, as it would after a crash before removing it
      Then the board was set to the status for "NeedsInput" on item "#11" once
      And item "#11" on the board has exactly one comment saying it waits for an answer, quoting "Which currency should totals use?"

    @ac-1
    Scenario: A finished item handled twice is released and closed once
      Given item "#11" on board "main" is "Accepted" with a merged PR
      When item "#11" on board "main" moves to "Done" on a verified definition of done
      And the worker handles item "#11"'s board mirror row twice, as it would after a crash before removing it
      Then the board was set to the status for "Done" on item "#11" once
      And the board released item "#11" once
      And the board closed item "#11" once

    @ac-1
    Scenario: A row handled again leaves a later change a person made on the board as it is
      Given item "#11" on board "main" is "InProgress" with a running cell
      When the cell reports through the cell API that its scenarios are ready for sign-off
      And the worker handles item "#11"'s board mirror row
      And a person moves item "#11" to the status "Backlog" on the board
      And the worker handles that same board mirror row again, as it would after a crash before removing it
      Then the board shows item "#11" with the status "Backlog"
      And the board was set to the status for "SignOff" on item "#11" once
      And item "#11" on the board has exactly one comment saying it waits for sign-off on the scenarios

  Rule: An override's row handled twice changes the board once and comments once

    @ac-1
    Scenario: An override to failed handled twice sets the status once, releases once and posts one comment
      Given item "#11" on board "main" is "InProgress"
      When an operator overrides item "#11" to "Failed" from the dashboard with the reason "stuck run"
      And the worker handles item "#11"'s board mirror row twice, as it would after a crash before removing it
      Then the board was set to the status for "Failed" on item "#11" once
      And the board released item "#11" once
      And item "#11" on the board has exactly one comment saying it failed and waits for an operator to re-queue it

  Rule: A row retried after a partial failure repeats none of the effects that already took place

    @ac-1
    Scenario: A row whose comment failed is retried without setting the status again
      Given item "#11" on board "main" is "InProgress" with a running cell
      And the board refuses every comment on item "#11"
      When the cell reports through the cell API that its scenarios are ready for sign-off
      And the worker works through the outbox
      Then the board was set to the status for "SignOff" on item "#11" once
      And the outbox still holds the board mirror row for item "#11"
      When the board accepts comments on item "#11" again
      And the row for item "#11" is due again and the worker works through the outbox
      Then the board was set to the status for "SignOff" on item "#11" once
      And item "#11" on the board has exactly one comment saying it waits for sign-off on the scenarios
      And the outbox is empty

    @ac-1
    Scenario: Another item's rows are each handled once while one item's row is handled twice
      Given item "#11" on board "main" is "Queued"
      And item "#12" on board "main" is "Queued"
      When the scheduler moves item "#11" and item "#12" on board "main" to "InProgress"
      And the worker handles item "#11"'s board mirror row twice, as it would after a crash before removing it
      And the worker works through the outbox
      Then the board was set to the status for "InProgress" on item "#11" once
      And the board was set to the status for "InProgress" on item "#12" once
      And the board claimed item "#12" once
      And the outbox is empty
