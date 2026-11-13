@pbi-187
Feature: Run detail shows how long an item took, per stage and waiting on a person
  The owner wants to see where an item's time went. Run detail shows the item's total time, from when its
  issue was created to when it reached Done, Failed or Abandoned, or up to now while it is still open. It
  breaks that time down three ways: the time in each SOP stage, the time waiting on a person (sign-off,
  needs input and in review, plus their total), and the time Queued for a WIP slot, which is kept apart from
  waiting on a person. An item that went round a loop counts every spell, not just the last one.
  Durations read as hours and minutes, such as "6h 45m", with days once a duration passes 24 hours, such as
  "1d 2h 30m". Seconds are dropped. All times below are UTC.
  Scenarios tagged @db need Postgres, which each test starts for itself, so cells and CI both run them.

  Background:
    Given item "187" titled "Export a month" is an issue in the repo "acme/widgets"
    And the item's issue was created at 2026-11-10 09:00

  Rule: The total runs from the issue's creation to Done, Failed or Abandoned, or up to now while the item is open

    @ac-1 @db
    Scenario: A Done item's total runs from its issue's creation to when it reached Done
      Given the item reached Done at 2026-11-10 15:45
      And the time now is 2026-11-12 08:00
      When a viewer opens the item's Run detail
      Then Run detail shows a total time of "6h 45m"

    @ac-1 @db
    Scenario Outline: An item that ended <end> stops its total there
      Given the item reached <end> at 2026-11-10 11:10
      And the time now is 2026-11-12 08:00
      When a viewer opens the item's Run detail
      Then Run detail shows a total time of "2h 10m"

      Examples:
        | end       |
        | Failed    |
        | Abandoned |

    @ac-1 @db
    Scenario: An open item's total runs up to now
      Given the item is InProgress
      And the time now is 2026-11-10 13:20
      When a viewer opens the item's Run detail
      Then Run detail shows a total time of "4h 20m"

    @ac-1 @db
    Scenario: An open item's total grows as time passes
      Given the item is InReview
      And the time now is 2026-11-10 13:20
      And a viewer opened the item's Run detail and saw a total time of "4h 20m"
      When the time now is 2026-11-10 14:05
      And the viewer opens the item's Run detail again
      Then Run detail shows a total time of "5h 5m"

    @ac-1 @db
    Scenario: An item that failed and was re-queued is open again, so its total runs up to now
      Given the item reached Failed at 2026-11-10 10:00
      And an operator re-queued the item at 2026-11-10 11:00
      And the item is InProgress
      And the time now is 2026-11-10 12:30
      When a viewer opens the item's Run detail
      Then Run detail shows a total time of "3h 30m"

  Rule: Each SOP stage shows its time, summed over its attempts and its runs, with the attempt count

    @ac-2 @db
    Scenario: Each stage that ran shows the time it took
      Given the item's run ran these stages:
        | stage       | attempt | started          | ended            |
        | understand  | 1       | 2026-11-10 09:30 | 2026-11-10 09:40 |
        | specify     | 1       | 2026-11-10 09:40 | 2026-11-10 10:05 |
        | red         | 1       | 2026-11-10 11:00 | 2026-11-10 11:15 |
        | green       | 1       | 2026-11-10 11:15 | 2026-11-10 12:45 |
        | self-review | 1       | 2026-11-10 12:45 | 2026-11-10 13:00 |
        | open-pr     | 1       | 2026-11-10 13:00 | 2026-11-10 13:02 |
        | pr-review   | 1       | 2026-11-10 13:02 | 2026-11-10 13:30 |
        | address     | 1       | 2026-11-10 15:00 | 2026-11-10 15:20 |
      When a viewer opens the item's Run detail
      Then Run detail shows these stage times:
        | stage       | time   | attempts |
        | understand  | 0h 10m | 1        |
        | specify     | 0h 25m | 1        |
        | red         | 0h 15m | 1        |
        | green       | 1h 30m | 1        |
        | self-review | 0h 15m | 1        |
        | open-pr     | 0h 2m  | 1        |
        | pr-review   | 0h 28m | 1        |
        | address     | 0h 20m | 1        |

    @ac-2 @db
    Scenario: A stage with several attempts shows their sum and the attempt count
      Given the item's run ran these stages:
        | stage | attempt | started          | ended            |
        | green | 1       | 2026-11-10 11:00 | 2026-11-10 11:40 |
        | green | 2       | 2026-11-10 11:40 | 2026-11-10 12:00 |
        | green | 3       | 2026-11-10 12:00 | 2026-11-10 12:35 |
      When a viewer opens the item's Run detail
      Then Run detail shows the green stage took "1h 35m" over 3 attempts

    @ac-2 @db
    Scenario: A stage that ran in more than one run sums across the runs
      Given the item's first run ran these stages:
        | stage | attempt | started          | ended            |
        | red   | 1       | 2026-11-10 10:00 | 2026-11-10 10:15 |
        | green | 1       | 2026-11-10 10:15 | 2026-11-10 10:45 |
      And the item's second run ran these stages:
        | stage | attempt | started          | ended            |
        | red   | 1       | 2026-11-10 14:00 | 2026-11-10 14:10 |
      When a viewer opens the item's Run detail
      Then Run detail shows the red stage took "0h 25m" over 2 attempts
      And Run detail shows the green stage took "0h 30m" over 1 attempt

    @ac-2 @db
    Scenario: A stage still running counts up to now
      Given the item's run started the green stage at 2026-11-10 11:00 and it hasn't ended
      And the time now is 2026-11-10 11:50
      When a viewer opens the item's Run detail
      Then Run detail shows the green stage took "0h 50m" over 1 attempt

    @ac-2 @db
    Scenario: A stage that never ran shows no time
      Given the item's run ran these stages:
        | stage      | attempt | started          | ended            |
        | understand | 1       | 2026-11-10 09:30 | 2026-11-10 09:40 |
      When a viewer opens the item's Run detail
      Then Run detail shows the understand stage took "0h 10m" over 1 attempt
      And Run detail shows no stage time for green

  Rule: Waiting on a person is split into sign-off, needs input and in review, plus their total

    @ac-3 @db
    Scenario: Each kind of wait and their total are shown
      Given a sign-off question was asked at 2026-11-10 10:00 and answered at 2026-11-10 12:30
      And a needs-input question was asked at 2026-11-10 13:00 and answered at 2026-11-10 13:45
      And the item was InReview from 2026-11-10 14:00 to 2026-11-10 17:00
      And the item reached Done at 2026-11-10 17:00
      When a viewer opens the item's Run detail
      Then Run detail shows waiting on a person for sign-off as "2h 30m"
      And Run detail shows waiting on a person for needs input as "0h 45m"
      And Run detail shows waiting on a person in review as "3h 0m"
      And Run detail shows waiting on a person in total as "6h 15m"

    @ac-3 @db
    Scenario: An open sign-off question counts up to now
      Given a sign-off question was asked at 2026-11-10 10:00 and is still open
      And the time now is 2026-11-10 11:20
      When a viewer opens the item's Run detail
      Then Run detail shows waiting on a person for sign-off as "1h 20m"
      And Run detail shows waiting on a person in total as "1h 20m"

    @ac-3 @db
    Scenario: An open needs-input question counts up to now
      Given a needs-input question was asked at 2026-11-10 10:00 and is still open
      And the time now is 2026-11-10 10:35
      When a viewer opens the item's Run detail
      Then Run detail shows waiting on a person for needs input as "0h 35m"

    @ac-3 @db
    Scenario: An item still InReview counts its review time up to now
      Given the item has been InReview since 2026-11-10 14:00
      And the time now is 2026-11-10 16:10
      When a viewer opens the item's Run detail
      Then Run detail shows waiting on a person in review as "2h 10m"

    @ac-3 @db
    Scenario: A question closed without an answer stops counting when it closed
      Given a needs-input question was asked at 2026-11-10 10:00 and closed unanswered at 2026-11-10 10:40
      And the time now is 2026-11-10 15:00
      When a viewer opens the item's Run detail
      Then Run detail shows waiting on a person for needs input as "0h 40m"

    @ac-3 @db
    Scenario: The question's times count, not the item's time in the SignOff state
      Given the item entered SignOff at 2026-11-10 10:00
      And a sign-off question was asked at 2026-11-10 10:05 and answered at 2026-11-10 11:05
      And the item left SignOff at 2026-11-10 11:10
      When a viewer opens the item's Run detail
      Then Run detail shows waiting on a person for sign-off as "1h 0m"

    @ac-3 @db
    Scenario: An item that never waited on a person shows no time waiting
      Given the item is InProgress with no questions and no time InReview
      And the time now is 2026-11-10 12:00
      When a viewer opens the item's Run detail
      Then Run detail shows waiting on a person for sign-off as "0h 0m"
      And Run detail shows waiting on a person for needs input as "0h 0m"
      And Run detail shows waiting on a person in review as "0h 0m"
      And Run detail shows waiting on a person in total as "0h 0m"

  Rule: Time Queued for a WIP slot is shown apart from waiting on a person

    @ac-4 @db
    Scenario: Time Queued is shown on its own and left out of waiting on a person
      Given the item was Queued from 2026-11-10 09:05 to 2026-11-10 11:25
      And a sign-off question was asked at 2026-11-10 12:00 and answered at 2026-11-10 12:30
      When a viewer opens the item's Run detail
      Then Run detail shows the time Queued as "2h 20m"
      And Run detail shows waiting on a person in total as "0h 30m"

    @ac-4 @db
    Scenario: An item still Queued counts up to now
      Given the item has been Queued since 2026-11-10 09:05
      And the time now is 2026-11-10 10:00
      When a viewer opens the item's Run detail
      Then Run detail shows the time Queued as "0h 55m"
      And Run detail shows waiting on a person in total as "0h 0m"

    @ac-4 @db
    Scenario: An item that hasn't been Queued yet shows no time Queued
      Given the item is Eligible and has never been Queued
      And the time now is 2026-11-10 10:00
      When a viewer opens the item's Run detail
      Then Run detail shows the time Queued as "0h 0m"

  Rule: Every spell of a loop counts in its bucket, not just the last one

    @ac-5 @db
    Scenario: An item that went InReview, to address and back counts both review spells and the address stage
      Given the item was InReview from 2026-11-10 13:00 to 2026-11-10 14:00
      And the item's run ran the address stage from 2026-11-10 14:00 to 2026-11-10 14:20
      And the item was InReview from 2026-11-10 14:20 to 2026-11-10 16:20
      And the item reached Done at 2026-11-10 16:20
      When a viewer opens the item's Run detail
      Then Run detail shows waiting on a person in review as "3h 0m"
      And Run detail shows the address stage took "0h 20m" over 1 attempt

    @ac-5 @db
    Scenario: Each round of sign-off counts
      Given a sign-off question was asked at 2026-11-10 10:00 and answered with a request for changes at 2026-11-10 11:00
      And a sign-off question was asked at 2026-11-10 11:30 and answered at 2026-11-10 12:00
      When a viewer opens the item's Run detail
      Then Run detail shows waiting on a person for sign-off as "1h 30m"

    @ac-5 @db
    Scenario: Each needs-input question counts, the last one still open
      Given a needs-input question was asked at 2026-11-10 10:00 and answered at 2026-11-10 10:15
      And a needs-input question was asked at 2026-11-10 11:00 and is still open
      And the time now is 2026-11-10 11:45
      When a viewer opens the item's Run detail
      Then Run detail shows waiting on a person for needs input as "1h 0m"

    @ac-5 @db
    Scenario: An item re-queued after a failure counts each spell Queued
      Given the item was Queued from 2026-11-10 09:05 to 2026-11-10 09:35
      And the item reached Failed at 2026-11-10 10:00
      And the item was Queued from 2026-11-10 10:30 to 2026-11-10 11:15
      And the item is InProgress
      And the time now is 2026-11-10 12:00
      When a viewer opens the item's Run detail
      Then Run detail shows the time Queued as "1h 15m"

    @ac-5 @db
    Scenario: The second round of review after address goes to in review even while it is still open
      Given the item was InReview from 2026-11-10 13:00 to 2026-11-10 13:40
      And the item's run ran the address stage from 2026-11-10 13:40 to 2026-11-10 14:00
      And the item has been InReview since 2026-11-10 14:00
      And the time now is 2026-11-10 14:50
      When a viewer opens the item's Run detail
      Then Run detail shows waiting on a person in review as "1h 30m"

  Rule: Durations read as hours and minutes, with days once a duration passes 24 hours

    @ac-6 @db
    Scenario Outline: A total of <length> reads "<shown>"
      Given the item reached Done <length> after its issue was created
      When a viewer opens the item's Run detail
      Then Run detail shows a total time of "<shown>"

      Examples:
        | length                            | shown     |
        | 0 minutes                         | 0h 0m     |
        | 59 seconds                        | 0h 0m     |
        | 25 minutes                        | 0h 25m    |
        | 6 hours 45 minutes 59 seconds     | 6h 45m    |
        | 23 hours 59 minutes               | 23h 59m   |
        | 24 hours                          | 24h 0m    |
        | 24 hours 1 minute                 | 1d 0h 1m  |
        | 2 days 3 hours 15 minutes         | 2d 3h 15m |
        | 12 days 0 hours 0 minutes 1 second | 12d 0h 0m |

    @ac-6 @db
    Scenario: Stage, waiting and Queued times read the same way
      Given the item was Queued from 2026-11-10 09:05 to 2026-11-11 12:35
      And a needs-input question was asked at 2026-11-11 13:00 and answered at 2026-11-13 14:10
      And the item's run ran the green stage from 2026-11-13 15:00 to 2026-11-13 16:05
      When a viewer opens the item's Run detail
      Then Run detail shows the time Queued as "1d 3h 30m"
      And Run detail shows waiting on a person for needs input as "2d 1h 10m"
      And Run detail shows the green stage took "1h 5m" over 1 attempt
