@pbi-376
Feature: The PBI 157 standby takeover scenario passes every time, so a flake stops turning main red
  PBI 157's scenario "When the working worker loses its lock connection, the standby takes over within 30
  seconds" fails now and then on CI. Each time it does, main turns red and the factory fails an item that
  had nothing to do with it. This item makes it pass every time, and keeps it able to fail when the standby
  really doesn't take over.
  To prove a scenario is steady, a new script, `npm run bdd:repeat -- --times <n> --name "<scenario name>"`,
  runs one scenario n times back to back. It exits 0 only when every run passes, and it names each run that
  failed.
  The scenarios for the script itself run it against practice scenarios whose passes and failures the test
  sets, so cells and CI both run them. Scenarios tagged @db repeat PBI 157's scenarios, which need Postgres,
  started by each test for itself, so cells and CI both run them too.

  Rule: bdd:repeat runs one scenario n times back to back and exits 0 only when every run passes

    @ac-1
    Scenario: Every run passes, so the script exits 0
      Given a practice scenario "Counts to three" that passes on every run
      When the owner runs `npm run bdd:repeat -- --times 5 --name "Counts to three"`
      Then the practice scenario ran 5 times, one run after another
      And the script exits with code 0
      And the script reports that 5 of 5 runs passed

    @ac-1
    Scenario: Some runs fail, so the script exits non-zero and names each run that failed
      Given a practice scenario "Counts to three" that fails on runs 2 and 4 and passes on the others
      When the owner runs `npm run bdd:repeat -- --times 5 --name "Counts to three"`
      Then the script exits with a non-zero code
      And the script names runs 2 and 4 as failed
      And the script names no other run as failed
      And the script reports that 3 of 5 runs passed

    @ac-1
    Scenario: A failed run doesn't stop the runs after it
      Given a practice scenario "Counts to three" that fails on run 1 and passes on the others
      When the owner runs `npm run bdd:repeat -- --times 4 --name "Counts to three"`
      Then the practice scenario ran 4 times
      And the script exits with a non-zero code
      And the script names run 1 as failed

    @ac-1
    Scenario: Only the named scenario runs
      Given a practice scenario "Counts to three" that passes on every run
      And a practice scenario "Counts to four" that passes on every run
      When the owner runs `npm run bdd:repeat -- --times 3 --name "Counts to three"`
      Then the practice scenario "Counts to three" ran 3 times
      And the practice scenario "Counts to four" never ran

    @ac-1
    Scenario: A name that matches no scenario fails, because no run passed
      Given a practice scenario "Counts to three" that passes on every run
      When the owner runs `npm run bdd:repeat -- --times 3 --name "Counts to ten"`
      Then the script exits with a non-zero code
      And the script says no scenario is named "Counts to ten"

    @ac-1
    Scenario Outline: A run count that isn't a whole number above zero is refused, and nothing runs
      Given a practice scenario "Counts to three" that passes on every run
      When the owner runs bdd:repeat for "Counts to three" with the run count <times>
      Then the script exits with a non-zero code
      And the script says the run count must be a whole number above zero
      And the practice scenario "Counts to three" never ran

      Examples:
        | times    |
        | "0"      |
        | "-2"     |
        | "three"  |
        | missing  |

  Rule: PBI 157's standby takeover scenario passes 20 times in a row

    @ac-2 @db
    Scenario: The takeover scenario passes on each of 20 runs back to back
      When the owner runs `npm run bdd:repeat -- --times 20 --name "When the working worker loses its lock connection, the standby takes over within 30 seconds"`
      Then the script exits with code 0
      And the script reports that 20 of 20 runs passed

  Rule: PBI 157's second worker scenario passes 20 times in a row

    @ac-3 @db
    Scenario: The second worker scenario passes on each of 20 runs back to back
      When the owner runs `npm run bdd:repeat -- --times 20 --name "A second worker claims no item while the first one runs"`
      Then the script exits with code 0
      And the script reports that 20 of 20 runs passed

  Rule: The takeover scenario still fails when the standby doesn't take over in 30 seconds

    @ac-4 @db
    Scenario: The takeover scenario fails on every run when the standby never takes over
      Given the standby is kept from ever taking the worker lock
      When the owner runs bdd:repeat 3 times on "When the working worker loses its lock connection, the standby takes over within 30 seconds"
      Then the script exits with a non-zero code
      And the script names runs 1, 2 and 3 as failed
      And each run failed because the second worker launched no cell for item "H" within 30 seconds

    @ac-4 @db
    Scenario: The takeover scenario fails when the standby takes over later than 30 seconds
      Given the standby takes the worker lock only 45 seconds after the first worker loses it
      When the owner runs bdd:repeat 3 times on "When the working worker loses its lock connection, the standby takes over within 30 seconds"
      Then the script exits with a non-zero code
      And the script names runs 1, 2 and 3 as failed
      And each run failed because the second worker launched no cell for item "H" within 30 seconds

    @ac-4 @db
    Scenario: The takeover scenario fails when the first worker keeps working without the lock
      Given the first worker keeps working after it loses its lock connection
      When the owner runs bdd:repeat 3 times on "When the working worker loses its lock connection, the standby takes over within 30 seconds"
      Then the script exits with a non-zero code
      And the script names runs 1, 2 and 3 as failed
