@pbi-176
Feature: Operators change WIP, review capacity and usage reserve live, with validation and a logged reason
  An operator or an owner changes the current WIP, the review capacity or the usage reserve on the
  Configuration page, and the scheduler uses the new value on its next turn, with no restart. Every change
  needs a reason. The factory logs each change as an event with who made it, the old value, the new value
  and the reason, and the Activity page shows it. A viewer sees every value but no way to change one.
  The page turns down a current WIP or review capacity that isn't a whole number of 1 or more, and a usage
  reserve outside 0 to 1, and the stored value stays as it was.
  The Configuration page from PBI 175 already lets an operator change these settings and already turns down
  bad values, so the scenarios that only check that behaviour are tagged @regression and pass before the build.
  Scenarios tagged @db need Postgres, which each test starts for itself, so cells and CI both run them.

  Background:
    Given the factory runs locally for "octo"
    And "octo" is signed in to the dashboard
    And the factory's WIP policy has WIP minimum set to 1, WIP maximum set to 3 and current WIP set to 1
    And the factory's WIP policy has review capacity set to 3, usage reserve set to 0.7 and daily budget set to 25

  Rule: An operator or an owner changes a setting with a reason, and the scheduler uses it on its next turn

    @ac-1 @db
    Scenario Outline: An operator changes <setting> with a reason
      Given "octo" is an operator
      When "octo" changes <setting> to "<after>" on the Configuration page, giving the reason "<reason>"
      Then the page says "<setting> changed"
      And the runtime settings list "<setting>" with the value "<after>"
      And the factory's WIP policy has <setting> set to <after>
      And the Activity page shows that "octo" changed <setting> from "<before>" to "<after>" because "<reason>"

      Examples:
        | setting         | before | after | reason                                  |
        | current WIP     | 1      | 2     | Two small items can run side by side.   |
        | review capacity | 3      | 5     | Two more reviewers are in this week.    |
        | usage reserve   | 0.7    | 0.8   | I'm not using Claude myself this week.  |

    @ac-1 @db
    Scenario: An owner changes a setting with a reason
      Given "olive" is an owner
      And "olive" is signed in to the dashboard
      When "olive" changes review capacity to "4" on the Configuration page, giving the reason "One more reviewer joined."
      Then the factory's WIP policy has review capacity set to 4
      And the Activity page shows that "olive" changed review capacity from "3" to "4" because "One more reviewer joined."

    @ac-1 @db
    Scenario: The scheduler starts more work on its next turn after current WIP goes up, with no restart
      Given "octo" is an operator
      And one item is in progress and another is queued
      When "octo" changes current WIP to "2" on the Configuration page, giving the reason "Let the queued item start."
      And the scheduler takes its next turn, with no restart
      Then the queued item is in progress
      And the Activity page shows that "octo" changed current WIP from "1" to "2" because "Let the queued item start."

    @ac-1 @db
    Scenario: The scheduler stops starting work on its next turn after review capacity goes down, with no restart
      Given "octo" is an operator
      And two items are waiting on review and another is queued
      When "octo" changes review capacity to "2" on the Configuration page, giving the reason "Reviews are piling up."
      And the scheduler takes its next turn, with no restart
      Then the queued item is still queued
      And the Activity page shows that "octo" changed review capacity from "3" to "2" because "Reviews are piling up."

    @ac-1 @db
    Scenario: The factory pauses on the next usage report after the usage reserve goes down, with no restart
      Given "octo" is an operator
      When "octo" changes usage reserve to "0.5" on the Configuration page, giving the reason "I need Claude for a demo today."
      And a usage report says 60% of the limit is used, resetting at "2026-11-14T09:00:00Z"
      Then the runtime settings list "usage pause" with the value "2026-11-14T09:00:00Z"
      And the Activity page shows that "octo" changed usage reserve from "0.7" to "0.5" because "I need Claude for a demo today."

  Rule: Every change needs a reason, and the factory logs who, the old value, the new value and the reason

    @ac-2 @db
    Scenario Outline: A change to <setting> with no reason is turned down and the setting keeps its value
      Given "octo" is an operator
      When "octo" changes <setting> to "<after>" on the Configuration page, without giving a reason
      Then the change is turned down with the message "Give a reason for the change."
      And the factory's WIP policy still has <setting> set to <before>
      And the Activity page shows no change to <setting>

      Examples:
        | setting         | before | after |
        | current WIP     | 1      | 2     |
        | review capacity | 3      | 5     |
        | usage reserve   | 0.7    | 0.8   |

    @ac-2 @db
    Scenario: A reason of only spaces counts as no reason
      Given "octo" is an operator
      When "octo" changes review capacity to "5" on the Configuration page, giving the reason "   "
      Then the change is turned down with the message "Give a reason for the change."
      And the factory's WIP policy still has review capacity set to 3
      And the Activity page shows no change to review capacity

    @ac-2 @db
    Scenario: The logged event holds who made the change, the old value, the new value and the reason
      Given "octo" is an operator
      When "octo" changes review capacity to "5" on the Configuration page, giving the reason "Two more reviewers are in this week."
      Then the factory logged one setting change event
      And that event says it was made by "octo"
      And that event says review capacity went from "3" to "5"
      And that event gives the reason "Two more reviewers are in this week."

    @ac-2 @db
    Scenario: Each change logs its own reason
      Given "octo" is an operator
      When "octo" changes review capacity to "5" on the Configuration page, giving the reason "Two more reviewers are in."
      And "octo" changes review capacity to "4" on the Configuration page, giving the reason "One of them is off sick."
      Then the Activity page shows that "octo" changed review capacity from "3" to "5" because "Two more reviewers are in."
      And the Activity page shows that "octo" changed review capacity from "5" to "4" because "One of them is off sick."

    @ac-2 @db
    Scenario: A viewer reads the reason on the Activity page
      Given "octo" is an operator
      And "vera" is a viewer
      When "octo" changes current WIP to "2" on the Configuration page, giving the reason "Two small items can run side by side."
      And "vera" opens the Activity page
      Then the Activity page shows that "octo" changed current WIP from "1" to "2" because "Two small items can run side by side."

    @ac-2 @db
    Scenario: A reason shows as text on the Activity page, never as markup
      Given "octo" is an operator
      When "octo" changes review capacity to "5" on the Configuration page, giving the reason "<b>urgent</b> & now"
      Then the Activity page shows that "octo" changed review capacity from "3" to "5" because "<b>urgent</b> & now"
      And the Activity page has no bold element from the reason

  Rule: A viewer sees every value and no controls

    @ac-3 @db @regression
    Scenario: A viewer sees every runtime setting's value and no way to change one
      Given "vera" is a viewer
      When "vera" opens the Configuration page
      Then the runtime settings list "current WIP" with the value "1"
      And the runtime settings list "review capacity" with the value "3"
      And the runtime settings list "usage reserve" with the value "0.7"
      And the page has no field, form or button to change a setting

    @ac-3 @db @regression
    Scenario: A viewer who sends a change with a reason anyway is refused and nothing changes
      Given "vera" is a viewer
      When "vera" sends a change of review capacity to "9" with the reason "Let me in." to the Configuration page
      Then the response is 403
      And the page says "Only an operator can change the factory's settings."
      And the factory's WIP policy still has review capacity set to 3
      And the Activity page shows no change to review capacity

  Rule: The page turns down a value outside the allowed range, and the stored value stays as it was

    @ac-4 @db @regression
    Scenario Outline: A <setting> of "<value>" is turned down and the setting keeps its value
      Given "octo" is an operator
      When "octo" changes <setting> to "<value>" on the Configuration page, giving the reason "Trying a new value."
      Then the change is turned down with the message "<message>"
      And the factory's WIP policy still has <setting> set to <kept>
      And the Activity page shows no change to <setting>

      Examples:
        | setting         | value | kept | message                                                             |
        | current WIP     | 0     | 1    | Current WIP must be a whole number from WIP minimum to WIP maximum. |
        | current WIP     | -1    | 1    | Current WIP must be a whole number from WIP minimum to WIP maximum. |
        | current WIP     | 1.5   | 1    | Current WIP must be a whole number from WIP minimum to WIP maximum. |
        | current WIP     | two   | 1    | Current WIP must be a whole number from WIP minimum to WIP maximum. |
        | current WIP     |       | 1    | Current WIP must be a whole number from WIP minimum to WIP maximum. |
        | review capacity | 0     | 3    | Review capacity must be a whole number of at least 1.               |
        | review capacity | -2    | 3    | Review capacity must be a whole number of at least 1.               |
        | review capacity | 2.5   | 3    | Review capacity must be a whole number of at least 1.               |
        | review capacity | many  | 3    | Review capacity must be a whole number of at least 1.               |
        | review capacity |       | 3    | Review capacity must be a whole number of at least 1.               |

    @ac-4 @db
    Scenario Outline: A usage reserve of "<value>" is turned down and the usage reserve keeps its value
      Given "octo" is an operator
      When "octo" changes usage reserve to "<value>" on the Configuration page, giving the reason "Trying a new value."
      Then the change is turned down with the message "Usage reserve must be a number from 0 to 1."
      And the factory's WIP policy still has usage reserve set to 0.7
      And the Activity page shows no change to usage reserve

      Examples:
        | value |
        | 1.5   |
        | 1.01  |
        | -0.1  |
        | half  |
        |       |

    @ac-4 @db
    Scenario Outline: A usage reserve of <value>, at the edge of 0 to 1, is accepted
      Given "octo" is an operator
      When "octo" changes usage reserve to "<value>" on the Configuration page, giving the reason "Testing the edge."
      Then the factory's WIP policy has usage reserve set to <value>
      And the Activity page shows that "octo" changed usage reserve from "0.7" to "<value>" because "Testing the edge."

      Examples:
        | value |
        | 0     |
        | 1     |

    @ac-4 @db
    Scenario: A review capacity of 1, the smallest allowed, is accepted
      Given "octo" is an operator
      When "octo" changes review capacity to "1" on the Configuration page, giving the reason "Only one reviewer this week."
      Then the factory's WIP policy has review capacity set to 1
      And the Activity page shows that "octo" changed review capacity from "3" to "1" because "Only one reviewer this week."
