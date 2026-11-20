@pbi-233
Feature: A red CI has its failed jobs re-run once before it is charged to an attempt
  Today, the first time CI reports a failed check on a commit a stage pushed, that failure is charged to the stage's
  attempt and the run goes back to Green. A flaky job, one that fails once and passes when run again, costs an
  attempt and a Green pass for nothing the item did wrong.
  With this item, the factory re-runs the failed jobs once before it charges a red CI to an attempt. If every job
  passes on the re-run, the commit counts as green and the run goes on as if CI had passed the first time. The
  stage's message says which job was re-run. If a job still fails on the re-run, the failure is charged as before,
  and only the checks that failed on the re-run go back to Green. Passing jobs are never re-run, and a commit's
  failed jobs are re-run once at most.
  These scenarios run the cell engine against a fake control plane, a fake agent and a fake repo host, so cells run
  them all.

  Background:
    Given a run for item 482 whose scenarios were signed off
    And CI passes on every commit unless a scenario says otherwise

  Rule: A failed check that passes when it is re-run once counts as green, and the stage's message says it was re-run

    @ac-1
    Scenario: The PR's head fails CI, passes on the re-run, and goes on to PR review without going back to Green
      Given CI reports the check "ci" failed on the PR's first head "c0ffee1" at "https://github.com/acme/widgets/actions/runs/7201", failing the test "totals include VAT"
      And the check "ci" passes when it is re-run on "c0ffee1"
      And the PR reviewer finds nothing on its first review
      When the cell runs
      Then the factory re-ran the check "ci" on "c0ffee1" 1 time
      And no attempt in the run says CI failed on "c0ffee1"
      And the cell ran these stages, in order:
        | stage       |
        | red         |
        | green       |
        | self-review |
        | open-pr     |
        | pr-review   |
      And the item moves to InReview

    @ac-1
    Scenario: The open-pr stage's message says the failed check was re-run and passed
      Given CI reports the check "ci" failed on the PR's first head "c0ffee1" at "https://github.com/acme/widgets/actions/runs/7201", failing the test "totals include VAT"
      And the check "ci" passes when it is re-run on "c0ffee1"
      And the PR reviewer finds nothing on its first review
      When the cell runs
      Then the open-pr stage's last attempt's message says the check "ci" was re-run on "c0ffee1"
      And the open-pr stage's last attempt's message says the check "ci" passed on the re-run

    @ac-1
    Scenario: What address pushed fails CI, passes on the re-run, and the run doesn't go back to Green
      Given a run for item 482 whose PR is in review
      And a trusted person's thread "Why not use the tax table?" on line 12 of "src/totals.ts" sent the item back to address
      And the PR addresser answers the person's thread with a reply and no new commit
      And address pushes the commit "m3rge01"
      And CI reports the check "ci" failed on "m3rge01" at "https://github.com/acme/widgets/actions/runs/7101", failing the test "parses the config"
      And the check "ci" passes when it is re-run on "m3rge01"
      And the PR reviewer finds nothing on its first review
      When the cell runs
      Then the factory re-ran the check "ci" on "m3rge01" 1 time
      And no attempt in the run says CI failed on "m3rge01"
      And address ran 1 time
      And Green didn't run
      And the address attempt's message says the check "ci" was re-run on "m3rge01"

    @ac-1
    Scenario: A re-run that is still running is waited for, and its pass counts as green
      Given CI reports the check "ci" failed on the PR's first head "c0ffee1" at "https://github.com/acme/widgets/actions/runs/7201", failing the test "totals include VAT"
      And the check "ci" is still running on its first 2 reads after it is re-run on "c0ffee1", then passes
      And the PR reviewer finds nothing on its first review
      When the cell runs
      Then the factory re-ran the check "ci" on "c0ffee1" 1 time
      And no attempt in the run says CI failed on "c0ffee1"
      And Green ran 1 time
      And the item moves to InReview

  Rule: Only the failed jobs are re-run, and only once; a job that fails again is charged to the attempt as before

    @ac-1
    Scenario: Only the checks that failed are re-run, never the ones that passed
      Given these checks report on the PR's first head "c0ffee1":
        | check | status | url                                               | failing tests      |
        | lint  | passed | https://github.com/acme/widgets/actions/runs/7200 |                    |
        | ci    | failed | https://github.com/acme/widgets/actions/runs/7201 | totals include VAT |
        | e2e   | failed | https://github.com/acme/widgets/actions/runs/7202 | signs in           |
      And the checks "ci" and "e2e" pass when they are re-run on "c0ffee1"
      And the PR reviewer finds nothing on its first review
      When the cell runs
      Then the factory re-ran the check "ci" on "c0ffee1" 1 time
      And the factory re-ran the check "e2e" on "c0ffee1" 1 time
      And the factory didn't re-run the check "lint" on "c0ffee1"
      And no attempt in the run says CI failed on "c0ffee1"
      And the open-pr stage's last attempt's message says the checks "ci" and "e2e" were re-run on "c0ffee1"

    @ac-1
    Scenario: A check that fails again on the re-run is re-run only once, charged as one attempt, and goes back to Green
      Given CI reports the check "ci" failed on the PR's first head "c0ffee1" at "https://github.com/acme/widgets/actions/runs/7201", failing the test "totals include VAT"
      And the check "ci" fails again when it is re-run on "c0ffee1" at "https://github.com/acme/widgets/actions/runs/7203", failing the test "totals include VAT"
      And CI passes after Green's fix
      And the PR reviewer finds nothing on its first review
      When the cell runs
      Then the factory re-ran the check "ci" on "c0ffee1" 1 time
      And exactly 1 attempt in the run says CI failed on "c0ffee1"
      And that attempt's message says the check "ci" was re-run on "c0ffee1" and failed again
      And Green ran 2 times
      And Green's second brief names the check "ci" and "https://github.com/acme/widgets/actions/runs/7203"
      And Green's second brief names the test "totals include VAT"
      And the item moves to InReview

    @ac-1
    Scenario: When one re-run check passes and another fails again, CI is red and only the one that failed again goes back to Green
      Given these checks report on the PR's first head "c0ffee1":
        | check | status | url                                               | failing tests      |
        | ci    | failed | https://github.com/acme/widgets/actions/runs/7201 | totals include VAT |
        | e2e   | failed | https://github.com/acme/widgets/actions/runs/7202 | signs in           |
      And the check "ci" passes when it is re-run on "c0ffee1"
      And the check "e2e" fails again when it is re-run on "c0ffee1" at "https://github.com/acme/widgets/actions/runs/7204", failing the test "signs in"
      And CI passes after Green's fix
      And the PR reviewer finds nothing on its first review
      When the cell runs
      Then the factory re-ran the check "ci" on "c0ffee1" 1 time
      And the factory re-ran the check "e2e" on "c0ffee1" 1 time
      And exactly 1 attempt in the run says CI failed on "c0ffee1"
      And Green's second brief names the check "e2e" and "https://github.com/acme/widgets/actions/runs/7204"
      And Green's second brief doesn't name the check "ci"

    @ac-1
    Scenario: When GitHub won't start the re-run, the red CI is charged and the message says the re-run couldn't start
      Given CI reports the check "ci" failed on the PR's first head "c0ffee1" at "https://github.com/acme/widgets/actions/runs/7201", failing the test "totals include VAT"
      And GitHub refuses to re-run the check "ci" on "c0ffee1"
      And CI passes after Green's fix
      And the PR reviewer finds nothing on its first review
      When the cell runs
      Then exactly 1 attempt in the run says CI failed on "c0ffee1"
      And that attempt's message says the check "ci" couldn't be re-run on "c0ffee1"
      And Green ran 2 times
      And the item moves to InReview
