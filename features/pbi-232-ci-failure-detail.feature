@pbi-232
Feature: Cell API returns CI failure detail to the waiting stage
  A cell that pushes a commit waits on CI for it by asking the cell API about that commit. Until now
  the cell API answered only "failure", so the stage's finding said "CI failed on <commit>" and the
  green retry that followed had to guess what broke. Now, when CI fails on the commit a cell waits on,
  the cell API answers with each failed check's name, its URL and the last 100 lines of its log, and
  the stage's finding names them. The control plane reads them from the repo host, so the cell needs
  no GitHub access to learn why CI failed.
  A check that passed, was skipped or ended neutral is not a failure. A log of 100 lines or fewer is
  returned whole.

  Rule: When CI fails on a cell's commit, the cell API answers with each failed check's name, URL and the last 100 lines of its log

    @ac-1
    Scenario: The cell API names every failed check on the commit, with its URL and log
      Given a cell waiting on CI for a commit on its branch
      And CI on that commit has these checks:
        | check    | result  | url                                   | log lines |
        | build    | success | https://ci.example/runs/1/jobs/build  | 40        |
        | unit     | failure | https://ci.example/runs/1/jobs/unit   | 250       |
        | bdd      | failure | https://ci.example/runs/1/jobs/bdd    | 120       |
      When the cell asks the cell API about CI on that commit
      Then the cell API answers that CI failed
      And the answer lists exactly the failed checks "unit" and "bdd"
      And the answer gives "unit" the URL "https://ci.example/runs/1/jobs/unit"
      And the answer gives "bdd" the URL "https://ci.example/runs/1/jobs/bdd"
      And the answer gives "unit" the last 100 lines of its log, from line 151 to line 250
      And the answer gives "bdd" the last 100 lines of its log, from line 21 to line 120

    @ac-1
    Scenario: A failed check with a short log is returned with its whole log
      Given a cell waiting on CI for a commit on its branch
      And CI on that commit has these checks:
        | check | result  | url                                 | log lines |
        | lint  | failure | https://ci.example/runs/2/jobs/lint | 12        |
      When the cell asks the cell API about CI on that commit
      Then the cell API answers that CI failed
      And the answer gives "lint" the URL "https://ci.example/runs/2/jobs/lint"
      And the answer gives "lint" all 12 lines of its log

    @ac-1
    Scenario: A failed check with a log of exactly 100 lines is returned whole
      Given a cell waiting on CI for a commit on its branch
      And CI on that commit has these checks:
        | check | result  | url                                 | log lines |
        | unit  | failure | https://ci.example/runs/3/jobs/unit | 100       |
      When the cell asks the cell API about CI on that commit
      Then the answer gives "unit" all 100 lines of its log

    @ac-1
    Scenario Outline: A check that timed out, was cancelled or needs action counts as failed and is named
      Given a cell waiting on CI for a commit on its branch
      And CI on that commit has these checks:
        | check | result   | url                                  | log lines |
        | build | success  | https://ci.example/runs/4/jobs/build | 10        |
        | e2e   | <result> | https://ci.example/runs/4/jobs/e2e   | 30        |
      When the cell asks the cell API about CI on that commit
      Then the cell API answers that CI failed
      And the answer lists exactly the failed check "e2e"
      And the answer gives "e2e" the URL "https://ci.example/runs/4/jobs/e2e"

      Examples:
        | result          |
        | timed_out       |
        | cancelled       |
        | action_required |

    @ac-1
    Scenario: A failed check whose log the repo host can't give is still named with its URL
      Given a cell waiting on CI for a commit on its branch
      And CI on that commit has a failed check "deploy-preview" at "https://ci.example/runs/5/jobs/deploy" whose log the repo host can't give
      When the cell asks the cell API about CI on that commit
      Then the cell API answers that CI failed
      And the answer gives "deploy-preview" the URL "https://ci.example/runs/5/jobs/deploy"
      And the answer says the log of "deploy-preview" couldn't be read

    @ac-1
    Scenario Outline: CI that hasn't failed brings no failure detail
      Given a cell waiting on CI for a commit on its branch
      And CI on that commit is <state>
      When the cell asks the cell API about CI on that commit
      Then the cell API answers "<status>"
      And the answer lists no failed check

      Examples:
        | state                 | status  |
        | still running         | pending |
        | passed on every check | success |

  Rule: The waiting stage's finding names each failed check, its URL and the last 100 lines of its log

    @ac-1
    Scenario: CI failing on the PR's head gives open-pr a finding with the failure detail, and green's retry sees it
      Given a run that reaches open-pr with a commit CI fails on
      And CI's check "unit" fails on that commit at "https://ci.example/runs/6/jobs/unit" with a log of 150 lines ending "AssertionError: expected 3 to equal 4"
      And CI passes on the next commit green pushes
      When the cell runs
      Then the open-pr stage ends failed
      And open-pr's finding names the check "unit"
      And open-pr's finding holds "https://ci.example/runs/6/jobs/unit"
      And open-pr's finding holds the last 100 lines of the log of "unit", ending "AssertionError: expected 3 to equal 4"
      And open-pr's finding holds none of the first 50 lines of the log of "unit"
      And the next green brief holds open-pr's finding

    @ac-1
    Scenario: Every failed check is named in the stage's finding
      Given a run that reaches open-pr with a commit CI fails on
      And CI's checks "unit" at "https://ci.example/runs/7/jobs/unit" and "bdd" at "https://ci.example/runs/7/jobs/bdd" fail on that commit
      And CI's check "build" passes on that commit
      When the cell runs
      Then open-pr's finding names the checks "unit" and "bdd"
      And open-pr's finding holds "https://ci.example/runs/7/jobs/unit" and "https://ci.example/runs/7/jobs/bdd"
      And open-pr's finding doesn't name the check "build"

    @ac-1
    Scenario: CI failing on the PR addresser's fix gives the PR review a finding with the failure detail
      Given a run whose PR review finds a problem the PR addresser fixes with a new commit
      And CI's check "bdd" fails on the addresser's fix at "https://ci.example/runs/8/jobs/bdd" with a log ending "1 scenario failed"
      When the cell runs
      Then the pr-review stage ends failed
      And pr-review's finding names the check "bdd"
      And pr-review's finding holds "https://ci.example/runs/8/jobs/bdd"
      And pr-review's finding holds the log of "bdd", ending "1 scenario failed"

  Rule: The cell learns why CI failed from the cell API alone, so it needs no GitHub access

    @ac-1
    Scenario: A cell with no GitHub access still gets the failure detail
      Given a run that reaches open-pr with a commit CI fails on
      And CI's check "unit" fails on that commit at "https://ci.example/runs/9/jobs/unit" with a log ending "TypeError: total is undefined"
      And the cell can't reach GitHub
      When the cell runs
      Then open-pr's finding names the check "unit"
      And open-pr's finding holds the log of "unit", ending "TypeError: total is undefined"
      And the cell asked for no GitHub token while it waited on CI
