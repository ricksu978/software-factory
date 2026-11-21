@pbi-390
Feature: The BDD suite runs scenarios in parallel workers, so cells and CI finish it in a fraction of the time
  Today `npm run bdd` runs every scenario one after another, so a cell's Red and Green and every CI build wait
  on the whole suite in a single line. With this item, `npm run bdd` runs scenarios in several workers at once.
  How many comes from one worker count setting, which has a default, so a cell, CI and a person's machine can
  each set their own and need not set it at all.
  A scenario that can't share the machine with another carries the tag @serial. The suite's parallel rule never
  runs two @serial scenarios at once, and never runs a @serial scenario beside any other.
  No step starts a server on, or connects to, a port fixed in its code, so two workers never collide.
  Red and Green read the runner's report as they do today: each scenario by name, with its result.
  The scenarios for the runner itself run `npm run bdd` against practice suites, whose passes, failures and
  timings the test sets, so cells and CI both run them. Each practice scenario takes a moment and records when
  it started and ended and which worker ran it, so the test can see what ran beside what.
  Scenarios tagged @db run earlier items' scenarios, which need Postgres. The whole-suite comparison carries
  the tag @local, because running the whole suite four times would add far too long to every build, and it
  would run itself. The owner runs it once and the PR states the counts it reports.

  Rule: npm run bdd runs the suite in several workers, as many as one setting says

    @ac-1
    Scenario: With no worker count set, the suite runs in more than one worker
      Given a practice suite of 6 scenarios that each pass
      And the worker count setting is not set
      When `npm run bdd` runs the practice suite
      Then the command exits 0
      And the practice scenarios ran in more than one worker
      And some practice scenarios ran at the same time as one another
      And all 6 practice scenarios passed

    @ac-1
    Scenario: The worker count setting decides how many workers run the suite
      Given a practice suite of 6 scenarios that each pass
      And the worker count setting is 3
      When `npm run bdd` runs the practice suite
      Then the command exits 0
      And the practice scenarios ran in exactly 3 workers
      And all 6 practice scenarios passed

    @ac-1
    Scenario: A different machine sets a different worker count with the same setting
      Given a practice suite of 6 scenarios that each pass
      And the worker count setting is 2
      When `npm run bdd` runs the practice suite
      Then the practice scenarios ran in exactly 2 workers
      And no more than 2 practice scenarios ever ran at the same time

    @ac-1
    Scenario: A worker count of 1 runs the scenarios one at a time
      Given a practice suite of 4 scenarios that each pass
      And the worker count setting is 1
      When `npm run bdd` runs the practice suite
      Then the command exits 0
      And no two practice scenarios ran at the same time
      And all 4 practice scenarios passed

    @ac-1
    Scenario: The command cells and CI run uses several workers without naming a count
      Given a practice suite of 6 scenarios that each pass
      And the worker count setting is not set
      When `npm run bdd -- --tags "not @local"` runs the practice suite
      Then the command exits 0
      And the practice scenarios ran in more than one worker

    @ac-1
    Scenario Outline: A worker count that isn't a whole number above zero is refused, and nothing runs
      Given a practice suite of 4 scenarios that each pass
      And the worker count setting is <count>
      When `npm run bdd` runs the practice suite
      Then the command exits with a non-zero code
      And the output says the worker count must be a whole number above zero
      And no practice scenario ran

      Examples:
        | count   |
        | "0"     |
        | "-2"    |
        | "three" |

  Rule: A scenario tagged @serial runs alone, never beside another scenario

    @ac-2
    Scenario: Two @serial scenarios never run at the same time, while untagged ones share the machine
      Given a practice suite with these scenarios:
        | scenario        | tags    |
        | Counts to one   |         |
        | Counts to two   |         |
        | Counts to three |         |
        | Counts to four  |         |
        | Holds the desk  | @serial |
        | Holds the door  | @serial |
      And the worker count setting is 3
      When `npm run bdd` runs the practice suite
      Then the command exits 0
      And "Holds the desk" and "Holds the door" never ran at the same time
      And some of the untagged practice scenarios ran at the same time as one another
      And all 6 practice scenarios passed

    @ac-2
    Scenario: No other scenario runs while a @serial scenario runs, and it starts only once the others have stopped
      Given a practice suite with these scenarios:
        | scenario        | tags    |
        | Counts to one   |         |
        | Counts to two   |         |
        | Counts to three |         |
        | Counts to four  |         |
        | Holds the desk  | @serial |
      And the worker count setting is 3
      When `npm run bdd` runs the practice suite
      Then no practice scenario ran at any moment while "Holds the desk" ran
      And some of the untagged practice scenarios ran at the same time as one another
      And all 5 practice scenarios passed

    @ac-2
    Scenario: A @serial tag on a feature makes each of its scenarios run alone
      Given a practice feature tagged @serial with the scenarios "Holds the desk" and "Holds the door"
      And a practice feature with no tag with the scenarios "Counts to one", "Counts to two", "Counts to three" and "Counts to four"
      And the worker count setting is 3
      When `npm run bdd` runs the practice suite
      Then no practice scenario ran at any moment while "Holds the desk" ran
      And no practice scenario ran at any moment while "Holds the door" ran
      And some of the untagged practice scenarios ran at the same time as one another

    @ac-2
    Scenario: Scenarios that would spoil each other's work both pass when they carry @serial
      Given a practice suite with these scenarios:
        | scenario                     | tags    |
        | Counts to one                |         |
        | Counts to two                |         |
        | Writes the shared note first | @serial |
        | Writes the shared note last  | @serial |
      And each of the two note scenarios fails if anything else touches the shared note while it runs
      And the worker count setting is 3
      When `npm run bdd` runs the practice suite
      Then the command exits 0
      And all 4 practice scenarios passed
      And the untagged practice scenarios ran at the same time as one another

  Rule: No step uses a fixed port, so two workers never collide

    @ac-3
    Scenario: No step definition starts a server on, or connects to, a port fixed in its code
      When the step definitions are checked for fixed ports
      Then no step starts a server on a port fixed in its code
      And no step connects to a port fixed in its code

    @ac-3
    Scenario: The fixed port check names a step that connects to a fixed port
      Given a scratch copy of the step definitions with a step added that connects to port 7402
      When the step definitions are checked for fixed ports
      Then the check names the added step's file and line as connecting to port 7402
      And the check names no other step

    @ac-3 @db
    Scenario Outline: An earlier item's server scenarios pass while other programs hold the ports they name
      Given other programs on this machine already listen on ports 7400, 7401 and 7402
      When the scenarios of <item> run
      Then every scenario of <item> passes
      And the programs on ports 7400, 7401 and 7402 were never reached by them

      Examples:
        | item    |
        | PBI 222 |
        | PBI 284 |
        | PBI 286 |
        | PBI 287 |

    @ac-3 @db
    Scenario: Two runs of PBI 286's scenarios started at the same moment both pass
      When the scenarios of PBI 286 run twice at the same moment, in two separate runs
      Then every scenario of PBI 286 passes in both runs

  Rule: The suite's results are the same in parallel as serially

    @ac-4
    Scenario: A practice suite gives the same results in several workers as serially, 3 runs in a row
      Given a practice suite with these scenarios:
        | scenario        | tags    | ends                   |
        | Counts to one   |         | with every step passed |
        | Counts to two   |         | with every step passed |
        | Counts to three |         | with every step passed |
        | Counts to four  |         | failed on its Then     |
        | Holds the desk  | @serial | with every step passed |
      When the practice suite runs serially once, and then with the worker count setting 3, 3 times in a row
      Then each of the 3 parallel runs ran in more than one worker
      And each of the 3 parallel runs passed every practice scenario the serial run passed
      And each of the 3 parallel runs failed "Counts to four" on its Then, as the serial run did
      And the serial run and each parallel run report 4 passed and 1 failed

    @ac-4 @db @local
    Scenario: The whole suite passes in parallel every scenario it passes serially, 3 runs in a row
      When the owner runs `npm run bdd -- --tags "not @local"` once with the worker count setting 1, and then 3 times in a row with the default worker count
      Then each of the 3 parallel runs ran in more than one worker
      And each of the 3 parallel runs passed every scenario the serial run passed
      And each of the 3 parallel runs ran every scenario the serial run ran
      And the owner is told, for the serial run and for each parallel run, how many scenarios passed, failed and were skipped

  Rule: Red's and Green's reports still name each scenario and its result

    @ac-5
    Scenario: `npm run bdd` writes one report, from several workers, that names each scenario and its result
      Given a practice suite with these scenarios:
        | scenario        | tags     | ends                   |
        | Totals add up   | @pbi-482 | failed on its Then     |
        | Refunds show    | @pbi-482 | with every step passed |
        | Exports split   | @pbi-482 | failed on its When     |
        | Holds the desk  | @serial  | with every step passed |
      And the worker count setting is not set
      When `npm run bdd` runs the practice suite
      And the factory reads the report at "reports/bdd.ndjson"
      Then the report shows the scenarios ran in more than one worker
      And the factory reads "Totals add up" as "red"
      And the factory reads "Refunds show" as "green"
      And the factory reads "Exports split" as "crash"
      And the factory reads "Holds the desk" as "green"
      And the factory reads no other scenario

    @ac-5 @regression
    Scenario: Red passes on a report from several workers when each of the item's scenarios fails on its Then
      Given a practice suite with these scenarios:
        | scenario              | tags     | ends                   |
        | Totals add up         | @pbi-482 | failed on its Then     |
        | Refunds show negative | @pbi-482 | failed on its Then     |
        | Export splits columns | @pbi-481 | with every step passed |
        | Counts to one         |          | with every step passed |
      When the practice suite runs in 3 workers at once
      And Red is judged for "@pbi-482" on that run's report
      Then Red passes

    @ac-5 @regression
    Scenario: Red on a report from several workers names an item's scenario that crashed
      Given a practice suite with these scenarios:
        | scenario              | tags     | ends                   |
        | Totals add up         | @pbi-482 | failed on its Then     |
        | Refunds show negative | @pbi-482 | failed on its When     |
        | Counts to one         |          | with every step passed |
        | Counts to two         |          | with every step passed |
      When the practice suite runs in 3 workers at once
      And Red is judged for "@pbi-482" on that run's report
      Then Red fails with a finding that names "Refunds show negative"
      And Red reports no finding about "Totals add up"

    @ac-5 @regression
    Scenario: Green passes on a report from several workers when every scenario passed
      Given a practice suite of 6 scenarios that each pass
      When the practice suite runs in 3 workers at once
      And Green is judged on that run's report
      Then Green passes

    @ac-5 @regression
    Scenario: Green on a report from several workers names the scenario that failed
      Given a practice suite with these scenarios:
        | scenario        | tags | ends                   |
        | Counts to one   |      | with every step passed |
        | Counts to two   |      | with every step passed |
        | Counts to three |      | failed on its Then     |
        | Counts to four  |      | with every step passed |
      When the practice suite runs in 3 workers at once
      And Green is judged on that run's report
      Then Green fails with a finding that names "Counts to three"
      And Green reports no finding about "Counts to one", "Counts to two" or "Counts to four"
