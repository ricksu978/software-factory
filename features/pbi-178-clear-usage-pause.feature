@pbi-178
Feature: Operators clear an active usage pause from the Configuration page
  When a usage report shows more of the Claude limit used than the usage reserve allows, the factory pauses
  new starts until the limit resets. Sometimes the owner knows the pause isn't needed, for example after
  raising the plan's limit. With this item, an operator or an owner clears an active usage pause on the
  Configuration page, and the scheduler starts new work again on its next turn, with no restart.
  Clearing works like every other change on the page (PBI 176): it needs a reason, and the Activity page
  shows who cleared the pause and why. An operator can clear the pause but can't set one, because only a
  usage report sets it. A later usage report over the reserve pauses the factory again, as before.
  PBI 175 showed the usage pause with no way to change it. This item replaces that rule for the usage pause
  only. The WIP mode still can't be changed from the page.
  Scenarios tagged @db need Postgres, which each test starts for itself, so cells and CI both run them.

  Background:
    Given the factory runs locally for "octo"
    And "octo" is signed in to the dashboard
    And the factory's WIP policy has WIP minimum set to 1, WIP maximum set to 3 and current WIP set to 1
    And the factory's WIP policy has review capacity set to 3 and usage reserve set to 0.7

  Rule: An operator or an owner clears an active usage pause, giving a reason

    @ac-1 @db
    Scenario: An operator clears an active usage pause
      Given "octo" is an operator
      And the factory is paused for usage until an hour from now
      When "octo" clears usage pause on the Configuration page, giving the reason "We raised the plan's limit this morning."
      Then the runtime settings list "usage pause" as "not set"
      And the factory's WIP policy has no usage pause
      And the Activity page shows that "octo" cleared the usage pause because "We raised the plan's limit this morning."

    @ac-1 @db
    Scenario: An owner clears an active usage pause
      Given "olive" is an owner
      And "olive" is signed in to the dashboard
      And the factory is paused for usage until an hour from now
      When "olive" clears usage pause on the Configuration page, giving the reason "The limit reset early."
      Then the factory's WIP policy has no usage pause
      And the Activity page shows that "olive" cleared the usage pause because "The limit reset early."

    @ac-1 @db
    Scenario: An operator sees a way to clear an active usage pause, and a viewer doesn't
      Given "octo" is an operator
      And "vera" is a viewer
      And the factory is paused for usage until an hour from now
      When "octo" opens the Configuration page
      Then the page has a button to clear the usage pause
      When "vera" opens the Configuration page
      Then the runtime settings list "usage pause"
      And the page has no field, form or button to change a setting

    @ac-1 @db
    Scenario: Once the pause is cleared, the page offers no way to clear it again
      Given "octo" is an operator
      And the factory is paused for usage until an hour from now
      When "octo" clears usage pause on the Configuration page, giving the reason "We raised the plan's limit this morning."
      And "octo" opens the Configuration page again
      Then the runtime settings list "usage pause" as "not set"
      And the page has no button to clear the usage pause

  Rule: New starts resume on the scheduler's next turn once the pause is cleared

    @ac-1 @db
    Scenario: The scheduler starts a queued item on its next turn after the pause is cleared, with no restart
      Given "octo" is an operator
      And the factory is paused for usage until an hour from now
      And one item is queued and none is in progress
      When the scheduler takes its next turn, with no restart
      Then the queued item is still queued
      When "octo" clears usage pause on the Configuration page, giving the reason "We raised the plan's limit this morning."
      And the scheduler takes its next turn, with no restart
      Then the queued item is in progress

    @ac-1 @db
    Scenario: A usage report over the reserve after the pause is cleared pauses the factory again
      Given "octo" is an operator
      And the factory is paused for usage until an hour from now
      When "octo" clears usage pause on the Configuration page, giving the reason "We raised the plan's limit this morning."
      Then the runtime settings list "usage pause" as "not set"
      When a usage report says 80% of the limit is used, resetting at "2026-11-14T09:00:00Z"
      Then the runtime settings list "usage pause" with the value "2026-11-14T09:00:00Z"

  Rule: A clear that can't be done is turned down and the usage pause stays as it was

    @ac-1 @db
    Scenario: Clearing the usage pause without a reason is turned down
      Given "octo" is an operator
      And the factory is paused for usage until an hour from now
      When "octo" clears usage pause on the Configuration page, without giving a reason
      Then the change is turned down with the message "Give a reason for the change."
      And the factory is still paused for usage until the same time
      And the Activity page shows no change to usage pause

    @ac-1 @db
    Scenario: Clearing the usage pause when there is none is turned down
      Given "octo" is an operator
      And the factory's WIP policy has no usage pause
      When "octo" clears usage pause on the Configuration page, giving the reason "Just in case."
      Then the change is turned down with the message "There's no usage pause to clear."
      And the factory's WIP policy still has no usage pause
      And the Activity page shows no change to usage pause

    @ac-1 @db
    Scenario: An operator can't set a usage pause from the page
      Given "octo" is an operator
      And the factory is paused for usage until an hour from now
      When "octo" changes usage pause to "2026-12-01T00:00:00Z" on the Configuration page, giving the reason "Pause until December."
      Then the change is turned down with the message "The usage pause can only be cleared."
      And the factory is still paused for usage until the same time
      And the Activity page shows no change to usage pause
