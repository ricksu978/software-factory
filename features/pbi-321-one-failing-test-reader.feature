@pbi-321
Feature: One failing-test reader names cucumber's failed, ambiguous, undefined and pending scenarios for every caller
  Today the factory reads failing tests from a log in two places, and they disagree. The cell's CI finding and
  the base-failure check read only cucumber's "Failed scenarios:" block. So a scenario that is ambiguous,
  undefined or pending turns CI red, but Green is told no test name, and the base check can't compare it with
  the base. The bug item for a red main has its own reader. That reader reads all four blocks, but it writes
  each scenario's name differently, so the same log names different tests depending on who reads it.
  With this item, one reader reads failing tests from a log, and the cell's CI finding, the base-failure check
  and the bug item for a red main all use it. It names every scenario listed under cucumber's
  "Failed scenarios:", "Ambiguous scenarios:", "Undefined scenarios:" and "Pending scenarios:" blocks, and
  names the failing node --test tests as it does today.
  The logs below are what the check or command printed. GitHub's timestamps and the lines between the blocks
  are shown only where a scenario needs them. GitHub, CI and the base commit are fakes.

  Rule: One reader reads failing tests from a log, and the cell's CI finding, the base-failure check and the bug item for a red main all use it

    @ac-1
    Scenario: The factory has one failing-test reader, and every caller uses it
      When I look at how the factory reads failing tests from a log
      Then the factory has exactly one failing-test reader
      And the cell's CI finding reads failing tests with it
      And the base-failure check reads failing tests with it
      And the bug item for a red main reads failing tests with it

    @ac-1
    Scenario: The same failed scenario is named the same way by the CI finding, the base-failure check and the bug item
      Given a log that reads:
        """
        Failed scenarios:
          1) An empty order is refused # features/orders.feature:12

        3 scenarios (1 failed, 2 passed)
        """
      When the factory reads that log for the cell's CI finding, for the base-failure check and for a red main's bug item
      Then all three name the same failing tests
      And the failing tests include the scenario "An empty order is refused"

    @ac-1
    Scenario: A log with cucumber scenarios and node tests is named the same way by every caller
      Given a log that reads:
        """
        ✖ parses the config (1.2ms)
        ✖ failing tests:

        test at src/config.test.ts:4:1
        ✖ parses the config (1.2ms)

        Ambiguous scenarios:
          1) Two steps match the total # features/orders.feature:20

        4 scenarios (1 ambiguous, 3 passed)
        """
      When the factory reads that log for the cell's CI finding, for the base-failure check and for a red main's bug item
      Then all three name the same failing tests
      And the failing tests include the test "parses the config"
      And the failing tests include the scenario "Two steps match the total"

    @ac-1
    Scenario: The cell's CI finding sends Green the undefined scenario a failed check's log names
      Given a run for item 482 whose PR is in review
      And CI reports the check "bdd" failed at "https://github.com/acme/widgets/actions/runs/7101", with a log that reads:
        """
        Undefined scenarios:
          1) A refund needs the order's number # features/refunds.feature:8

        5 scenarios (1 undefined, 4 passed)
        """
      When the cell reads CI on its commit
      Then the CI finding for the check "bdd" names the scenario "A refund needs the order's number"

    @ac-1
    Scenario: The base-failure check blames the base when the base fails the same ambiguous scenario
      Given a run for item 482 on base "main" whose scenarios were signed off
      And "origin/main" is at commit "b4se001"
      And the repo's Definition of Done has the line "Scenarios pass. `run: npm run bdd`"
      And on the item's branch the command prints:
        """
        Ambiguous scenarios:
          1) Two steps match the total # features/orders.feature:20

        4 scenarios (1 ambiguous, 3 passed)
        """
      And on commit "b4se001" the command prints the same
      When the cell runs
      Then Green ran 1 time
      And the factory asks one question that names the scenario "Two steps match the total" and the base commit "b4se001"

    @ac-1
    Scenario: The base-failure check charges the item for a pending scenario the base doesn't share, and Green is told its name
      Given a run for item 482 on base "main" whose scenarios were signed off
      And "origin/main" is at commit "b4se001"
      And the repo's Definition of Done has the line "Scenarios pass. `run: npm run bdd`"
      And on the item's branch the command prints:
        """
        Pending scenarios:
          1) A discount is shown on the invoice # features/invoices.feature:15

        6 scenarios (1 pending, 5 passed)
        """
      And on commit "b4se001" the command passes
      When the cell runs
      Then Green's retry brief names the scenario "A discount is shown on the invoice"
      And the factory asks no question about the base

  Rule: The reader names every scenario under each of cucumber's four blocks, and the failing node tests as today

    @ac-2 @regression
    Scenario: A scenario under "Failed scenarios:" is still named
      Given a log that reads:
        """
        Failed scenarios:
          1) An empty order is refused # features/orders.feature:12

        3 scenarios (1 failed, 2 passed)
        """
      When the cell's CI finding reads the log
      Then it names the scenario "An empty order is refused"

    @ac-2
    Scenario: A scenario under "Ambiguous scenarios:" is named
      Given a log that reads:
        """
        Ambiguous scenarios:
          1) Two steps match the total # features/orders.feature:20

        4 scenarios (1 ambiguous, 3 passed)
        """
      When the cell's CI finding reads the log
      Then it names the scenario "Two steps match the total"

    @ac-2
    Scenario: A scenario under "Undefined scenarios:" is named
      Given a log that reads:
        """
        Undefined scenarios:
          1) A refund needs the order's number # features/refunds.feature:8

        5 scenarios (1 undefined, 4 passed)
        """
      When the cell's CI finding reads the log
      Then it names the scenario "A refund needs the order's number"

    @ac-2
    Scenario: A scenario under "Pending scenarios:" is named
      Given a log that reads:
        """
        Pending scenarios:
          1) A discount is shown on the invoice # features/invoices.feature:15

        6 scenarios (1 pending, 5 passed)
        """
      When the cell's CI finding reads the log
      Then it names the scenario "A discount is shown on the invoice"

    @ac-2
    Scenario: A log with ambiguous, undefined and pending blocks and no failed one names every scenario once, in the order the log lists them
      Given a log that reads:
        """
        Ambiguous scenarios:
          1) Two steps match the total # features/orders.feature:20
        Undefined scenarios:
          1) A refund needs the order's number # features/refunds.feature:8
          2) A refund is refused after 30 days # features/refunds.feature:19
        Pending scenarios:
          1) A discount is shown on the invoice # features/invoices.feature:15

        11 scenarios (1 ambiguous, 2 undefined, 1 pending, 7 passed)
        """
      When the cell's CI finding reads the log
      Then it names exactly these scenarios, in order:
        | scenario                           |
        | Two steps match the total          |
        | A refund needs the order's number  |
        | A refund is refused after 30 days  |
        | A discount is shown on the invoice |

    @ac-2
    Scenario: The step and error lines printed under an undefined scenario are not named as tests
      Given a log that reads:
        """
        Undefined scenarios:
          1) A refund needs the order's number # features/refunds.feature:8
             ? Given an order numbered "1001"
                 Undefined. Implement with the following snippet:

        5 scenarios (1 undefined, 4 passed)
        """
      When the cell's CI finding reads the log
      Then it names exactly these scenarios, in order:
        | scenario                           |
        | A refund needs the order's number  |

    @ac-2
    Scenario: GitHub's timestamps in front of each line don't hide a pending scenario
      Given a log that reads:
        """
        2026-11-27T10:15:02.1234567Z Pending scenarios:
        2026-11-27T10:15:02.1234568Z   1) A discount is shown on the invoice # features/invoices.feature:15
        2026-11-27T10:15:02.1234569Z
        2026-11-27T10:15:02.1234570Z 6 scenarios (1 pending, 5 passed)
        """
      When the cell's CI finding reads the log
      Then it names the scenario "A discount is shown on the invoice"

    @ac-2
    Scenario: The base-failure check reads an undefined scenario from the command's output
      Given a log that reads:
        """
        Undefined scenarios:
          1) A refund needs the order's number # features/refunds.feature:8

        5 scenarios (1 undefined, 4 passed)
        """
      When the base-failure check reads the log
      Then it names the scenario "A refund needs the order's number"

    @ac-2 @regression
    Scenario: A failing node test the spec reporter lists is still named
      Given a log that reads:
        """
        ✖ failing tests:

        test at src/config.test.ts:4:1
        ✖ parses the config (1.2ms)
        """
      When the cell's CI finding reads the log
      Then it names the test "parses the config"

    @ac-2 @regression
    Scenario: A failing node test printed as a TAP "not ok" line is still named, and a TODO is not
      Given a log that reads:
        """
        not ok 1 - parses the config
        not ok 2 - reads the board # TODO
        ok 3 - writes the summary
        """
      When the cell's CI finding reads the log
      Then it names the test "parses the config"
      And it doesn't name the test "reads the board"
      And it doesn't name the test "writes the summary"

  Rule: A log with only ambiguous scenarios gives back every one of their names

    @ac-3
    Scenario: A log with 2 ambiguous scenarios and no failed ones gives back both names
      Given a log that reads:
        """
        Ambiguous scenarios:
          1) Two steps match the total # features/orders.feature:20
          2) Two steps match the refund # features/refunds.feature:31

        9 scenarios (2 ambiguous, 7 passed)
        """
      When the factory's failing-test reader reads the log
      Then it gives back exactly these scenarios, in order:
        | scenario                   |
        | Two steps match the total  |
        | Two steps match the refund |
      And the cell's CI finding, the base-failure check and a red main's bug item each name both scenarios
