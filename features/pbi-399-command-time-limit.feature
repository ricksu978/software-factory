@pbi-399
Feature: A gate command the cell kills at its time limit says so, and a repo sets the limit for its long commands
  A cell gives each command it runs 15 minutes, then stops it. That covers the gate's commands (bdd.parse,
  bdd.run, commands.test, commands.lint) and each Definition of Done line's `run:` command. Today a stopped
  command looks like any other failure, "exited 1", followed by the last of its output. So the next attempt is told
  to fix a failure that was really the clock. When bdd.run is the one stopped, cucumber-js leaves a report with no
  end of run. The gate then reads each scenario that hadn't finished as a crashed scenario, and the next attempt is
  told to fix scenarios that never failed.
  With this item, a command the cell stops at its limit fails with a finding that names the command and the limit
  and says the cell stopped it. A BDD report with no end of run fails the gate with one finding: the run didn't
  finish. That finding names the scenario or scenarios that were running when it stopped, and it doesn't report
  them as failing scenarios. A repo can set `command_timeout_minutes` in its ".factory/config.yml" to give its
  commands longer. The limit stays 15 minutes when the key is missing, and a bad value is refused like any other
  bad value in the config. This repo sets 40. A command that ends within its limit is checked as today.
  The scenarios run the cell engine against a fake control plane, agent and repo. The repo's commands are
  stand-ins, and each test sets how long a stand-in runs and how it ends. Time passes on a fake clock, so no
  scenario waits for real minutes. Unless a scenario says otherwise, the run is for item 482, whose scenarios were
  signed off, and the repo's ".factory/config.yml" has no `command_timeout_minutes` key, its commands.test is
  "npm test" and its bdd.run is "npm run bdd".

  Rule: A command the cell stops at its time limit fails with a finding that names the command and the limit and says the cell stopped it

    @ac-1
    Scenario: Green's test command stopped at the limit fails with a finding that says the cell stopped it
      Given the repo's "npm test" runs for 20 minutes
      When the cell runs Green
      Then Green's attempt fails
      And the attempt's finding names the command "npm test"
      And the attempt's finding says the cell stopped the command at its time limit of 15 minutes
      And the attempt has no finding that says "npm test" exited 1

    @ac-1
    Scenario: The next Green attempt's brief carries the finding about the stopped command
      Given the repo's "npm test" runs for 20 minutes on Green's first attempt and passes in 2 minutes after that
      When the cell runs Green
      Then Green's first attempt fails
      And Green's second attempt's brief, under "Your last attempt failed", says the cell stopped "npm test" at its time limit of 15 minutes

    @ac-1
    Scenario: The lint command stopped at the limit fails with a finding that names it
      Given the repo's commands.lint is "npm run lint"
      And the repo's "npm run lint" runs for 16 minutes
      When the cell runs Green
      Then Green's attempt fails
      And the attempt's finding says the cell stopped "npm run lint" at its time limit of 15 minutes

    @ac-1
    Scenario: Red's parse command stopped at the limit fails with a finding that names it
      Given the repo's bdd.parse is "npm run bdd -- --dry-run"
      And the repo's "npm run bdd -- --dry-run" runs for 20 minutes
      When the cell runs Red
      Then Red's attempt fails
      And the attempt's finding says the cell stopped "npm run bdd -- --dry-run" at its time limit of 15 minutes

    @ac-1
    Scenario: A stopped bdd.run is reported as stopped, and the scenarios it hadn't finished aren't reported as failing
      Given the repo's "npm run bdd" runs for 20 minutes, and by 15 minutes has passed "Totals add up" and is running "Refunds show negative"
      When the cell runs Green
      Then Green's attempt fails
      And the attempt's finding says the cell stopped "npm run bdd" at its time limit of 15 minutes
      And no finding of the attempt reports "Refunds show negative" as a failing scenario

    @ac-1
    Scenario: A Definition of Done command stopped at the limit fails its line with a finding that says the cell stopped it
      Given the repo's Definition of Done has the line "End-to-end tests pass. `run: npm run e2e`"
      And the repo's "npm run e2e" runs for 20 minutes
      When the cell checks the Definition of Done in Green
      Then the Definition of Done line "End-to-end tests pass." fails
      And its reason says the cell stopped "npm run e2e" at its time limit of 15 minutes

    @ac-1
    Scenario: The next Green attempt's brief carries the finding about the stopped Definition of Done command
      Given the repo's Definition of Done has the line "End-to-end tests pass. `run: npm run e2e`"
      And the repo's "npm run e2e" runs for 20 minutes on Green's first attempt and passes in 3 minutes after that
      When the cell runs Green
      Then Green's first attempt fails
      And Green's second attempt's brief, under "Your last attempt failed", says the cell stopped "npm run e2e" at its time limit of 15 minutes

  Rule: A BDD report with no end of run fails the gate as a run that didn't finish, naming the scenario that was running

    @ac-2
    Scenario: Green fails on a report with no end of run, naming the scenario that was running
      Given bdd.run writes a report that stops part way, with no end of run:
        | scenario              | in the report                      |
        | Totals add up         | ended with every step passed       |
        | Refunds show negative | started, with its Given passed     |
        | Exports split columns | listed, never started              |
      When the cell runs Green
      Then Green's attempt fails
      And the attempt's finding says the BDD run didn't finish
      And that finding names "Refunds show negative" as the scenario that was running
      And no finding of the attempt reports "Refunds show negative" or "Exports split columns" as a failing scenario

    @ac-2
    Scenario: Red fails on a report with no end of run, naming the scenario that was running, not as crashed scenarios
      Given bdd.run writes a report that stops part way, with no end of run:
        | scenario              | tags     | in the report                      |
        | Totals add up         | @pbi-482 | ended failed on its Then           |
        | Refunds show negative | @pbi-482 | started, with its Given passed     |
        | Exports split columns | @pbi-482 | listed, never started              |
      When the cell runs Red
      Then Red's attempt fails
      And the attempt's finding says the BDD run didn't finish
      And that finding names "Refunds show negative" as the scenario that was running
      And no finding of the attempt says "Refunds show negative" or "Exports split columns" crashed

    @ac-2
    Scenario: A report from several workers with no end of run names each scenario that was running
      Given bdd.run writes a report from 3 workers that stops part way, with no end of run:
        | scenario              | in the report                      |
        | Totals add up         | ended with every step passed       |
        | Refunds show negative | started, with its Given passed     |
        | Exports split columns | started, with its When passed      |
        | Counts to one         | listed, never started              |
      When the cell runs Green
      Then Green's attempt fails
      And the attempt's finding says the BDD run didn't finish
      And that finding names "Refunds show negative" and "Exports split columns" as the scenarios that were running
      And no finding of the attempt reports "Refunds show negative", "Exports split columns" or "Counts to one" as a failing scenario

    @ac-2
    Scenario: A report whose every scenario passed but that has no end of run still fails Green
      Given bdd.run writes a report with no end of run, in which these scenarios ended:
        | scenario              | in the report                |
        | Totals add up         | ended with every step passed |
        | Refunds show negative | ended with every step passed |
      When the cell runs Green
      Then Green's attempt fails
      And the attempt's finding says the BDD run didn't finish
      And no finding of the attempt reports a failing scenario

    @ac-2
    Scenario: The next Green attempt's brief carries the finding that the BDD run didn't finish
      Given bdd.run writes a report with no end of run on Green's first attempt, while "Refunds show negative" was running
      And bdd.run writes a whole report with every scenario passed after that
      When the cell runs Green
      Then Green's first attempt fails
      And Green's second attempt's brief, under "Your last attempt failed", says the BDD run didn't finish while "Refunds show negative" was running

  Rule: A repo's `command_timeout_minutes` sets the time limit for each command a cell runs, 15 minutes when it's missing

    @ac-3
    Scenario: With `command_timeout_minutes` set to 40, a command that runs 20 minutes isn't stopped
      Given the repo's ".factory/config.yml" sets `command_timeout_minutes` to 40
      And the repo's "npm test" runs for 20 minutes and exits 0
      And every other command of the gate passes
      When the cell runs Green
      Then the cell didn't stop "npm test"
      And Green's gate passes

    @ac-3
    Scenario: With `command_timeout_minutes` set to 40, a command still running at 40 minutes is stopped there
      Given the repo's ".factory/config.yml" sets `command_timeout_minutes` to 40
      And the repo's "npm test" runs for 50 minutes
      When the cell runs Green
      Then the cell stopped "npm test" after 40 minutes
      And the attempt's finding says the cell stopped "npm test" at its time limit of 40 minutes

    @ac-3
    Scenario: `command_timeout_minutes` sets the limit for a Definition of Done command too
      Given the repo's ".factory/config.yml" sets `command_timeout_minutes` to 30
      And the repo's Definition of Done has the line "End-to-end tests pass. `run: npm run e2e`"
      And the repo's "npm run e2e" runs for 25 minutes and exits 0
      When the cell checks the Definition of Done in Green
      Then the cell didn't stop "npm run e2e"
      And the Definition of Done line "End-to-end tests pass." passes

    @ac-3
    Scenario: A small `command_timeout_minutes` stops a command sooner than 15 minutes
      Given the repo's ".factory/config.yml" sets `command_timeout_minutes` to 5
      And the repo's "npm test" runs for 10 minutes
      When the cell runs Green
      Then the cell stopped "npm test" after 5 minutes
      And the attempt's finding says the cell stopped "npm test" at its time limit of 5 minutes

    @ac-3
    Scenario: Without `command_timeout_minutes` the limit is 15 minutes
      Given the repo's "npm test" runs for 20 minutes
      When the cell runs Green
      Then the cell stopped "npm test" after 15 minutes
      And the attempt's finding says the cell stopped "npm test" at its time limit of 15 minutes

    @ac-3
    Scenario Outline: A `command_timeout_minutes` that isn't a whole number above zero blocks the run, as other bad config values do
      Given the repo's ".factory/config.yml" sets `command_timeout_minutes` to <value>
      When the cell starts the run
      Then the run is blocked with a reason that says ".factory/config.yml" has a missing or invalid `command_timeout_minutes`
      And the cell ran none of the repo's commands

      Examples:
        | value   |
        | 0       |
        | -5      |
        | 2.5     |
        | "forty" |

    @ac-3
    Scenario: A `command_timeout_minutes` that isn't a whole number above zero makes the repo's config invalid when readiness is checked
      Given the repo's ".factory/config.yml" sets `command_timeout_minutes` to 0
      When the factory checks the repo's readiness for item 482
      Then the readiness check reports the repo's config as invalid

  Rule: This repo gives its commands 40 minutes

    @ac-4
    Scenario: This repo's own config sets `command_timeout_minutes` to 40
      When the factory reads this repo's ".factory/config.yml"
      Then the config is valid
      And its time limit for each command a cell runs is 40 minutes

  Rule: A command that ends within its limit is checked as today

    @ac-5 @regression
    Scenario: A test command that exits 0 within the limit passes
      Given the repo's "npm test" runs for 2 minutes and exits 0
      And every other command of the gate passes
      When the cell runs Green
      Then the cell didn't stop "npm test"
      And Green's gate passes

    @ac-5 @regression
    Scenario: A test command that fails within the limit is reported by its exit code and output, as today
      Given the repo's "npm test" runs for 2 minutes, prints "1 test failed: parses the config" and exits 2
      When the cell runs Green
      Then Green's attempt fails
      And the attempt's finding says "commands.test exited 2" and holds "1 test failed: parses the config"

    @ac-5 @regression
    Scenario: A Definition of Done command that fails within the limit fails its line by its exit code, as today
      Given the repo's Definition of Done has the line "End-to-end tests pass. `run: npm run e2e`"
      And the repo's "npm run e2e" runs for 3 minutes, prints "checkout flow broke" and exits 1
      When the cell checks the Definition of Done in Green
      Then the Definition of Done line "End-to-end tests pass." fails
      And its reason says "exit 1" and holds "checkout flow broke"

    @ac-5 @regression
    Scenario: A whole BDD report with a failing scenario names that scenario, as today
      Given bdd.run writes a whole report, with its end of run, in which these scenarios ended:
        | scenario              | in the report                |
        | Totals add up         | ended with every step passed |
        | Refunds show negative | ended failed on its Then     |
      When the cell runs Green
      Then Green's attempt fails
      And a finding of the attempt names "Refunds show negative"
      And no finding of the attempt names "Totals add up"

    @ac-5 @regression
    Scenario: Red passes on a whole report in which each of the item's scenarios fails on its Then, as today
      Given bdd.run writes a whole report, with its end of run, in which these scenarios ended:
        | scenario              | tags     | in the report            |
        | Totals add up         | @pbi-482 | ended failed on its Then |
        | Refunds show negative | @pbi-482 | ended failed on its Then |
      When the cell runs Red
      Then Red passes
