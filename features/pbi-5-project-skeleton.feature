@pbi-5
Feature: Project skeleton with a BDD runner
  The repo has typecheck, unit test and scenario scripts, CI that runs all three,
  and a factory config that names them, so the first line of .factory/dod.md can be checked.

  @ac-1
  Scenario: Typecheck passes on a clean checkout
    When I run "npm run typecheck" in the repo
    Then the command exits 0

  @ac-2
  Scenario: npm test picks up any unit test file under src
    Given a new test file "src/probe/picked-up.test.ts" with one passing test named "probe is picked up"
    When I run "npm test" in the repo
    Then the command exits 0
    And the output reports the passing test "probe is picked up"

  @ac-3
  Scenario: npm run bdd writes a Cucumber Messages report
    Given a scratch project with the repo's package.json, its installed packages and one passing feature file
    When I run "npm run bdd" in the scratch project
    Then the command exits 0
    And the scratch project's "reports/bdd.ndjson" holds one "testCaseFinished" message per scenario

  @ac-4
  Scenario: CI runs typecheck, tests and scenarios beside the prose check
    When I read the workflow ".github/workflows/ci.yml"
    Then it runs on "push" and "pull_request"
    And one of its jobs runs "npm run typecheck", "npm test" and "npm run bdd"
    And the workflow ".github/workflows/prose.yml" still exists

  @ac-5
  Scenario: The factory config names the BDD and command lines
    When I read ".factory/config.yml"
    Then it has text values for "bdd.parse", "bdd.run", "bdd.report", "commands.test" and "commands.lint"
    And "bdd.report" is "reports/bdd.ndjson"
