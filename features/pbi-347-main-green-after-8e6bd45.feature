@pbi-347
Feature: CI on main passes every check again after commit 8e6bd45 broke it
  Commit 8e6bd45 (PR 344, PBI 206) has the AppHost build the cell image as a resource the worker waits on. Since it
  merged, CI on "main" fails, and every later merge onto "main" fails with it. CI runs one job, "ci", on every
  push. That job runs these checks in order: the typecheck, the AppHost's compile and lint (after the Aspire CLI
  restores the AppHost's generated modules), the unit tests, and the scenarios that aren't tagged @local.
  With this item, CI passes every one of those checks again. The fix makes the broken check pass. It doesn't drop
  the check, skip it, or weaken it, and it doesn't drop any other check CI runs.
  The scenarios name each check in the words above. The step definitions map each name to the command
  .github/workflows/ci.yml runs for it.

  Rule: CI passes every check on the commit that fixes main

    @ac-1
    Scenario: CI's run on the fix's commit passes every check
      When CI has finished its run on the commit this checkout is at
      Then the job "ci" passed on that commit
      And every check in that run passed

    @ac-1
    Scenario: No check counts as passed by being skipped or cancelled
      When CI has finished its run on the commit this checkout is at
      Then no check in that run was skipped
      And no check in that run was cancelled

  Rule: The AppHost's compile and lint pass the way CI runs them

    @ac-1
    Scenario: The AppHost compiles and lints cleanly once its generated modules are restored
      Given the AppHost's packages are installed as CI installs them
      And the Aspire CLI version CI pins has restored the AppHost's generated modules
      When the AppHost's compile and lint run as CI runs them
      Then the AppHost compiles with no errors
      And the AppHost's lint reports no errors

  Rule: CI still runs every check it ran before 8e6bd45, and every other check still passes

    @ac-1 @regression
    Scenario: CI still runs every check, in the same order
      When I read the workflow ".github/workflows/ci.yml"
      Then it still runs on "push" alone
      And its job "ci" runs these checks, in order:
        | check |
        | the typecheck |
        | the AppHost's compile and lint |
        | the unit tests |
        | the scenarios that aren't tagged @local |

    @ac-1 @regression
    Scenario: The typecheck still passes
      When the typecheck runs as CI runs it
      Then the typecheck reports no errors

    @ac-1 @regression
    Scenario: The unit tests still pass, with the AppHost graph tests among them
      When the unit tests run as CI runs them
      Then every unit test passes
      And the unit tests include the check that the AppHost's waits match the resources the start lists
