@pbi-221 @db
Feature: The worker retries a failing outbox row with backoff, sets it aside after ten failures, and holds back only its own item's later rows
  Step 3 of the control plane redesign (2026-11-07 design, §07 "An outbox in place of hooks") continues here.
  PBI 219 made the worker the one place outbox rows are handled, and PBI 220 made handling a row again repeat no
  effect. When a row's effect fails, the row stays in the outbox, its attempt count goes up, and it is tried again
  30 seconds later, with the wait doubling after each further failure up to 30 minutes. A row that keeps failing
  must not be tried for ever: after its tenth failed attempt the worker marks it failed and sets it aside. It stays
  in the outbox so someone can see it, and the worker no longer tries it. While a row is failing it holds back the
  later rows for the same item and consumer, so one item's rows run in the order they were written. It holds back
  nothing else. Once it is set aside, that item's later rows run.
  Every scenario needs Postgres, which each test starts for itself, so cells and CI both run them. They run the
  worker, the dashboard and the scheduler against a fake board and a fake repo host. "The worker works through the
  outbox" means the worker handles every row that is due, once, and then stops. "Time moves on, with the worker
  working through the outbox whenever a row falls due" means the factory's clock moves forward over the stated
  time, and the worker works through the outbox at every moment a row falls due, so a row is tried as soon as its
  wait is up and never before. A row's failures count only attempts the worker made, so a row that is held back has
  failed no times.

  Background:
    Given a fresh factory database with two boards, "main" and "side"
    And the board "main" shows a status for each of "InProgress", "SignOff", "NeedsInput", "Failed" and "Done"
    And the outbox is empty

  Rule: A failed row stays, counts the attempt, and is retried after 30 seconds, then after a wait that doubles up to 30 minutes

    @ac-1 @ac-2
    Scenario: A board mirror row that keeps failing is retried on the doubling schedule and tried ten times in all
      Given item "#11" on board "main" is "Queued"
      And the board refuses every update to item "#11"
      When the scheduler moves item "#11" on board "main" to "InProgress"
      And the worker works through the outbox
      Then the outbox still holds the board mirror row for item "#11", having failed 1 time
      When time moves on for three hours, with the worker working through the outbox whenever a row falls due
      Then the board mirror row for item "#11" was tried again after each failure, after these waits:
        | failure | tried again after |
        | 1       | 30 seconds        |
        | 2       | 1 minute          |
        | 3       | 2 minutes         |
        | 4       | 4 minutes         |
        | 5       | 8 minutes         |
        | 6       | 16 minutes        |
        | 7       | 30 minutes        |
        | 8       | 30 minutes        |
        | 9       | 30 minutes        |
      And the board was asked to update item "#11" on exactly 10 attempts in all
      And the outbox still holds the board mirror row for item "#11", having failed 10 times

    @ac-1 @ac-2
    Scenario: A decision announcement that the board keeps refusing is retried with backoff until its tenth failure
      Given item "#11" on board "main" is waiting in "SignOff" for its scenarios to be signed off
      And "Pat" is a product owner signed in to the dashboard
      And the board refuses every comment on item "#11"
      When "Pat" approves the scenarios of item "#11" on the dashboard
      And the worker works through the outbox
      Then the outbox still holds the decision announcement row for item "#11", having failed 1 time
      And the decision announcement row for item "#11" is due again 30 seconds after it failed
      When time moves on for three hours, with the worker working through the outbox whenever a row falls due
      Then the board was asked to post the approval announcement on item "#11" on exactly 10 attempts in all
      And the decision announcement row for item "#11" is marked failed and set aside

    @ac-1 @ac-2
    Scenario: A comment command that keeps failing is retried with backoff until its tenth failure
      Given item "#11" on board "main" is waiting in "SignOff" for its scenarios to be signed off
      And "Pat" is a product owner with the GitHub login "pat"
      And the board fails every time the factory reads item "#11"
      When GitHub delivers a comment "/approve" by "pat" on issue "#11" in the item's repo
      And the worker works through the outbox
      Then the outbox still holds the comment command row for item "#11", having failed 1 time
      And the comment command row for item "#11" is due again 30 seconds after it failed
      When time moves on for three hours, with the worker working through the outbox whenever a row falls due
      Then the comment command row for item "#11" was tried on exactly 10 attempts in all
      And the comment command row for item "#11" is marked failed and set aside
      And item "#11" is still waiting in "SignOff" with its scenarios not signed off

  Rule: After its tenth failed attempt a row is marked failed and set aside, and the worker no longer tries it

    @ac-2
    Scenario: A row set aside stays in the outbox, marked failed, and is not tried again after the board recovers
      Given item "#11" on board "main" is "Queued"
      And the board refuses every update to item "#11"
      When the scheduler moves item "#11" on board "main" to "InProgress"
      And the worker works through the outbox
      And time moves on for three hours, with the worker working through the outbox whenever a row falls due
      Then the board mirror row for item "#11" is marked failed and set aside
      When the board accepts updates to item "#11" again
      And time moves on for a day, with the worker working through the outbox whenever a row falls due
      Then the board was asked to update item "#11" on exactly 10 attempts in all
      And the board does not show item "#11" with the status for "InProgress"
      And the outbox still holds the board mirror row for item "#11", marked failed

    @ac-2
    Scenario: A row that succeeds on its tenth attempt is removed, while one that fails its tenth attempt is set aside
      Given item "#11" on board "main" is "Queued"
      And item "#12" on board "main" is "Queued"
      And the board refuses the first 9 updates to item "#11" and accepts the ones after
      And the board refuses every update to item "#12"
      When the scheduler moves item "#11" and item "#12" on board "main" to "InProgress"
      And the worker works through the outbox
      And time moves on for three hours, with the worker working through the outbox whenever a row falls due
      Then the board shows item "#11" with the status for "InProgress"
      And the outbox holds no row for item "#11"
      And the board mirror row for item "#12" is marked failed and set aside

    @ac-2
    Scenario: A row is not set aside after nine failures
      Given item "#11" on board "main" is "Queued"
      And the board refuses every update to item "#11"
      When the scheduler moves item "#11" on board "main" to "InProgress"
      And the worker works through the outbox
      And time moves on until the board mirror row for item "#11" has failed 9 times, with the worker working through the outbox whenever a row falls due
      Then the board mirror row for item "#11" is not marked failed and is due again 30 minutes after its ninth failure
      When time moves on for 30 minutes, with the worker working through the outbox whenever a row falls due
      Then the board mirror row for item "#11" is marked failed and set aside, having failed 10 times

  Rule: A failing row holds back only the later rows for the same item and consumer

    @ac-3 @ac-2
    Scenario: A later row for the same item waits untried while an earlier one fails, and runs once the earlier one is set aside
      Given item "#11" on board "main" is "Queued"
      And item "#12" on board "main" is "Queued"
      And the board refuses to set item "#11" to the status for "InProgress"
      When the scheduler moves item "#11" and item "#12" on board "main" to "InProgress"
      And an operator overrides item "#11" to "Failed" from the dashboard with the reason "stuck run"
      And the worker works through the outbox
      Then the board shows item "#12" with the status for "InProgress"
      And the outbox holds no row for item "#12"
      And the outbox holds two board mirror rows for item "#11", the move to "InProgress" having failed 1 time and the override to "Failed" having failed no times
      And the board does not show item "#11" with the status for "Failed"
      When time moves on for two hours, with the worker working through the outbox whenever a row falls due
      Then the override to "Failed" for item "#11" has still failed no times and has not reached the board
      When time moves on for another hour, with the worker working through the outbox whenever a row falls due
      Then the board mirror row for item "#11"'s move to "InProgress" is marked failed and set aside
      And the board shows item "#11" with the status for "Failed"
      And item "#11" on the board has one comment saying it failed and waits for an operator to re-queue it
      And the outbox holds no row for item "#11" other than the one set aside

    @ac-3 @ac-2
    Scenario: A failing board mirror row does not hold back the same item's decision announcement
      Given item "#11" on board "main" is waiting in "SignOff" for its scenarios to be signed off
      And "Pat" is a product owner signed in to the dashboard
      And the board refuses every update to item "#11" but accepts comments on it
      When "Pat" approves the scenarios of item "#11" on the dashboard
      And the worker works through the outbox
      Then item "#11" on the board has exactly one comment saying the scenarios were signed off
      And the outbox holds no decision announcement row for item "#11"
      And the outbox still holds the board mirror row for item "#11", having failed 1 time
      When time moves on for three hours, with the worker working through the outbox whenever a row falls due
      Then the board mirror row for item "#11" is marked failed and set aside
      And item "#11" on the board still has exactly one comment saying the scenarios were signed off

    @ac-3 @ac-2
    Scenario: A failing comment command holds back the same item's later comment command, and nothing on another board
      Given item "#11" on board "main" is waiting in "SignOff" for its scenarios to be signed off
      And item "#11" on board "side" is waiting in "SignOff" for its scenarios to be signed off
      And "Pat" is a product owner with the GitHub login "pat"
      And the board "main" fails the next 10 times the factory reads item "#11" and works after
      When GitHub delivers a comment "/changes Cover refunds too" by "pat" on issue "#11" on board "main" in its repo
      And GitHub delivers a comment "/approve" by "pat" on issue "#11" on board "main" in its repo
      And GitHub delivers a comment "/approve" by "pat" on issue "#11" on board "side" in its repo
      And the worker works through the outbox
      Then the scenarios of item "#11" on board "side" are signed off by "Pat"
      And item "#11" on board "main" is still waiting in "SignOff" with its scenarios not signed off
      And the later comment command row for item "#11" on board "main" has failed no times
      When time moves on for three hours, with the worker working through the outbox whenever a row falls due
      Then the comment command row for "/changes Cover refunds too" on item "#11" on board "main" is marked failed and set aside
      And the scenarios of item "#11" on board "main" are signed off by "Pat"
