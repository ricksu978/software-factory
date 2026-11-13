@pbi-189
Feature: Run detail shows tokens, cost, time spent and times in a form people can read
  Run detail's Stages and Readiness checks tables show raw numbers today: tokens as full counts, cost to as
  many places as were stored, and times in UTC. With this item, both tables show tokens in thousands or
  millions to one decimal place, and cost to the cent, with "<$0.01" for a cost too small to round to a
  cent, so a cheap call never reads as free. The Stages table shows when each stage attempt started and
  how long it took. Every time on Run detail shows in the viewer's own time zone, and no column heading
  says UTC.

  Background:
    Given item "189" titled "Export a month" is an issue in the repo "acme/widgets"

  Rule: Tokens show in thousands or millions to one decimal place, and a count under 1,000 shows as is

    @ac-1
    Scenario: The Stages table shows a stage's tokens in thousands, and a count under 1,000 as is
      Given the item's "specify" stage used 12750 tokens in and 640 tokens out
      When a viewer opens the item's Run detail
      Then the Stages table shows "12.8k in, 640 out" for the "specify" stage

    @ac-1
    Scenario: The Stages table shows a stage's tokens in millions
      Given the item's "build" stage used 2149999 tokens in and 48210 tokens out
      When a viewer opens the item's Run detail
      Then the Stages table shows "2.1m in, 48.2k out" for the "build" stage

    @ac-1
    Scenario: The Readiness checks table shows a check's tokens in thousands, and a count under 1,000 as is
      Given the item had a readiness check that used 1240 tokens in and 80 tokens out
      When a viewer opens the item's Run detail
      Then the Readiness checks table shows "1.2k in, 80 out" for that check

    @ac-1
    Scenario: The Readiness checks table shows a check's tokens in millions
      Given the item had a readiness check that used 1050000 tokens in and 999 tokens out
      When a viewer opens the item's Run detail
      Then the Readiness checks table shows "1.1m in, 999 out" for that check

    @ac-1
    Scenario Outline: A count of <count> tokens shows as "<shown>"
      Given the item's "specify" stage used <count> tokens in and 0 tokens out
      When a viewer opens the item's Run detail
      Then the Stages table shows "<shown> in, 0 out" for the "specify" stage

      Examples:
        | count   | shown  |
        | 1000    | 1.0k   |
        | 1049    | 1.0k   |
        | 1050    | 1.1k   |
        | 999949  | 999.9k |
        | 999950  | 1.0m   |
        | 1000000 | 1.0m   |

  Rule: Cost shows to the cent, and a cost above zero that rounds to nothing shows "<$0.01"

    @ac-2
    Scenario: The Stages table shows a stage's cost rounded to the cent
      Given the item's "specify" stage cost $0.5291
      When a viewer opens the item's Run detail
      Then the Stages table shows a cost of exactly "$0.53" for the "specify" stage
      And the page doesn't show "$0.5291"

    @ac-2
    Scenario: The Readiness checks table shows a check's cost rounded to the cent
      Given the item had a readiness check that cost $0.0550
      When a viewer opens the item's Run detail
      Then the Readiness checks table shows a cost of exactly "$0.06" for that check
      And the page doesn't show "$0.0550"

    @ac-2
    Scenario: A cheap readiness check never reads as free
      Given the item had a readiness check that cost $0.0031
      When a viewer opens the item's Run detail
      Then the Readiness checks table shows a cost of exactly "<$0.01" for that check
      And the Readiness checks table doesn't show a cost of "$0.00" for that check

    @ac-2
    Scenario: A cheap stage never reads as free
      Given the item's "specify" stage cost $0.0004
      When a viewer opens the item's Run detail
      Then the Stages table shows a cost of exactly "<$0.01" for the "specify" stage

    @ac-2
    Scenario Outline: A cost of <cost> shows as "<shown>"
      Given the item had a readiness check that cost <cost>
      When a viewer opens the item's Run detail
      Then the Readiness checks table shows a cost of exactly "<shown>" for that check

      Examples:
        | cost    | shown  |
        | $0.0001 | <$0.01 |
        | $0.0049 | <$0.01 |
        | $0.0050 | $0.01  |
        | $0.0149 | $0.01  |
        | $1.2350 | $1.24  |

    @ac-2
    Scenario: A readiness check that spent nothing shows a cost of nothing
      Given the item had a readiness check that ended in an API error before using any tokens
      When a viewer opens the item's Run detail
      Then the Readiness checks table shows a cost of exactly "$0.00" for that check
      And the Readiness checks table doesn't show a cost of "<$0.01" for that check

    @ac-2
    Scenario: A stage that spent nothing shows a cost of nothing
      Given the item's "specify" stage cost $0
      When a viewer opens the item's Run detail
      Then the Stages table shows a cost of exactly "$0.00" for the "specify" stage

  Rule: The Stages table shows when each attempt started and how long it took

    @ac-3
    Scenario: A finished attempt shows when it started and how long it took in minutes and seconds
      Given the viewer's time zone is UTC
      And the item's "specify" stage attempt 1 started at "2026-11-09T10:15:00Z" and ended at "2026-11-09T10:19:07Z"
      When a viewer opens the item's Run detail
      Then the Stages table shows the "specify" attempt 1 started at "2026-11-09 10:15"
      And the Stages table shows the "specify" attempt 1 took "4m 7s"

    @ac-3
    Scenario: An attempt that took over an hour shows hours and minutes
      Given the item's "build" stage attempt 1 started at "2026-11-09T10:00:00Z" and ended at "2026-11-09T11:12:20Z"
      When a viewer opens the item's Run detail
      Then the Stages table shows the "build" attempt 1 took "1h 12m"

    @ac-3
    Scenario Outline: An attempt that took <length> shows "<shown>"
      Given the item's "build" stage attempt 1 started at "2026-11-09T10:00:00Z" and ended at "<ended>"
      When a viewer opens the item's Run detail
      Then the Stages table shows the "build" attempt 1 took "<shown>"

      Examples:
        | length                | ended                | shown   |
        | 42 seconds            | 2026-11-09T10:00:42Z | 0m 42s  |
        | 59 minutes 59 seconds | 2026-11-09T10:59:59Z | 59m 59s |
        | exactly an hour       | 2026-11-09T11:00:00Z | 1h 0m   |
        | 26 hours 5 minutes    | 2026-11-10T12:05:00Z | 26h 5m  |

    @ac-3
    Scenario: Each attempt of a stage shows its own start and time spent
      Given the item's "build" stage attempt 1 started at "2026-11-09T10:00:00Z" and ended at "2026-11-09T10:03:30Z"
      And the item's "build" stage attempt 2 started at "2026-11-09T10:05:00Z" and ended at "2026-11-09T10:15:10Z"
      When a viewer opens the item's Run detail
      Then the Stages table shows the "build" attempt 1 took "3m 30s"
      And the Stages table shows the "build" attempt 2 took "10m 10s"

    @ac-3
    Scenario: An attempt still running shows the time so far
      Given the item's "build" stage attempt 1 started at "2026-11-09T10:00:00Z" and has not ended
      And the time is now "2026-11-09T10:06:30Z"
      When a viewer opens the item's Run detail
      Then the Stages table shows the "build" attempt 1 is still running
      And the Stages table shows the "build" attempt 1 took "6m 30s"

    @ac-3
    Scenario: An attempt running for over an hour shows the time so far in hours and minutes
      Given the item's "build" stage attempt 1 started at "2026-11-09T10:00:00Z" and has not ended
      And the time is now "2026-11-09T12:20:45Z"
      When a viewer opens the item's Run detail
      Then the Stages table shows the "build" attempt 1 took "2h 20m"

  Rule: Every time on Run detail shows in the viewer's own time zone, and no heading says UTC

    @ac-4
    Scenario: A readiness check's time shows in the viewer's time zone
      Given the viewer's time zone is "Europe/Berlin"
      And the item had a readiness check that ran at "2026-11-09T10:15:00Z"
      When a viewer opens the item's Run detail
      Then the Readiness checks table shows that check ran at "2026-11-09 11:15"
      And the Readiness checks table doesn't show "2026-11-09 10:15"

    @ac-4
    Scenario: A stage attempt's start shows in the viewer's time zone
      Given the viewer's time zone is "America/New_York"
      And the item's "specify" stage attempt 1 started at "2026-11-09T15:30:00Z" and ended at "2026-11-09T15:34:00Z"
      When a viewer opens the item's Run detail
      Then the Stages table shows the "specify" attempt 1 started at "2026-11-09 10:30"

    @ac-4
    Scenario: A time shows on the viewer's own date when their time zone is past midnight
      Given the viewer's time zone is "Asia/Tokyo"
      And the item had a readiness check that ran at "2026-11-09T23:30:00Z"
      When a viewer opens the item's Run detail
      Then the Readiness checks table shows that check ran at "2026-11-10 08:30"

    @ac-4
    Scenario: A time shows with the viewer's summer time when it applies
      Given the viewer's time zone is "America/New_York"
      And the item had a readiness check that ran at "2026-07-15T14:00:00Z"
      And the item had a readiness check that ran at "2026-12-15T14:00:00Z"
      When a viewer opens the item's Run detail
      Then the Readiness checks table shows a check ran at "2026-07-15 10:00"
      And the Readiness checks table shows a check ran at "2026-12-15 09:00"

    @ac-4
    Scenario: Two viewers in different time zones each see the same check in their own time
      Given the item had a readiness check that ran at "2026-11-09T10:15:00Z"
      When a viewer in "Europe/London" opens the item's Run detail
      Then the Readiness checks table shows that check ran at "2026-11-09 10:15"
      When a viewer in "Asia/Kolkata" opens the item's Run detail
      Then the Readiness checks table shows that check ran at "2026-11-09 15:45"

    @ac-4
    Scenario: No column heading on Run detail says UTC
      Given the item had a readiness check that ran at "2026-11-09T10:15:00Z"
      And the item's "specify" stage attempt 1 started at "2026-11-09T10:20:00Z" and ended at "2026-11-09T10:24:00Z"
      When a viewer opens the item's Run detail
      Then the page has a Stages table and a Readiness checks table
      And no column heading on the page says "UTC"
