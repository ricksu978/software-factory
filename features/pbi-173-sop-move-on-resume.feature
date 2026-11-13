@pbi-173
Feature: A run pinned to an older SOP resumes on the SOP in the cell image instead of asking for input
  A run pins the SOP version of the cell image on its first claim. When the factory ships a newer SOP,
  a run pinned to the older one used to stop and ask "SOP 0.1.0 isn't in this cell image, which has
  0.2.0". No answer helped, because the next cell asked the same thing, so the item sat in NeedsInput.
  With this item, a run pinned to an older SOP moves to the SOP in the cell image and carries on from
  the stage it was at. The run records the version it now uses, the dashboard shows it, and the
  factory logs the move as a system event on the item. The one case it can't move is a run whose next
  stage the newer SOP doesn't have, so that run still asks for input, and the question names the stage.
  In every scenario the cell image holds SOP 0.2.0, which has the stages understand, specify, sign-off,
  red, green, self-review, open-pr and address. Item 482 is an issue in the repo "acme/widgets".
  Scenarios tagged @db need Postgres, which each test starts for itself, so cells and CI both run them.

  Rule: A run pinned to an older SOP moves to the image's SOP and carries on without asking for input

    @ac-1
    Scenario: A run pinned to an older SOP resumes at its stage on the image's SOP
      Given a run for item 482 pinned to SOP 0.1.0 that resumes at green
      When the factory claims the run and its cell runs
      Then the cell runs the green stage
      And the run records SOP version 0.2.0
      And the owner is asked no question
      And item 482 is not in NeedsInput

    @ac-1
    Scenario: The stage after a moved run's stage comes from the image's SOP
      Given a run for item 482 pinned to SOP 0.1.0 that resumes at green
      And green passes
      When the factory claims the run and its cell runs
      Then the run's next stage is self-review, the stage after green in SOP 0.2.0

    @ac-1
    Scenario: A run several versions behind moves straight to the image's SOP
      Given a run for item 482 pinned to SOP 0.0.3 that resumes at red
      When the factory claims the run and its cell runs
      Then the cell runs the red stage
      And the run records SOP version 0.2.0
      And the owner is asked no question

    @ac-1
    Scenario: A moved run keeps the config commit it was pinned to
      Given a run for item 482 pinned to SOP 0.1.0 and to config commit "a1b2c3d" that resumes at green
      When the factory claims the run and its cell runs
      Then the run records SOP version 0.2.0
      And the run is still pinned to config commit "a1b2c3d"

  Rule: The dashboard's run detail shows the SOP version the run now uses

    @ac-2 @db
    Scenario: Run detail shows the new SOP version after the move
      Given a run for item 482 pinned to SOP 0.1.0 that resumes at green
      And the factory has claimed the run and its cell has run
      When a viewer opens the item's run detail
      Then run detail shows SOP version "0.2.0"
      And run detail does not show SOP version "0.1.0" as the version in use

  Rule: The move from the old SOP version to the new one is logged once, as a system event on the item

    @ac-3 @db
    Scenario: The move is a system event on the item naming both versions
      Given a run for item 482 pinned to SOP 0.1.0 that resumes at green
      When the factory claims the run and its cell runs
      Then item 482 has a system event recording the run's move from SOP 0.1.0 to SOP 0.2.0

    @ac-3 @db
    Scenario: A later claim of the moved run logs no second move
      Given a run for item 482 pinned to SOP 0.1.0 that resumes at green
      And the factory has claimed the run and its cell has run
      And the run is claimed again at self-review
      When its cell runs
      Then item 482 has exactly one system event recording a move of SOP version

    @ac-3 @db
    Scenario: The move shows in the activity log
      Given a run for item 482 pinned to SOP 0.1.0 that resumes at green
      And the factory has claimed the run and its cell has run
      When a viewer opens the activity log
      Then the activity log lists the SOP move for item 482

  Rule: An item already held by the old question resumes on the newer SOP once the question is answered

    @ac-4 @db
    Scenario: Answering the old SOP question resumes the run on the image's SOP
      Given a run for item 482 pinned to SOP 0.1.0 that resumes at green
      And item 482 is in NeedsInput with the question "SOP 0.1.0 isn't in this cell image, which has 0.2.0"
      When the owner answers the question
      And the factory claims the run and its cell runs
      Then the cell runs the green stage
      And the run records SOP version 0.2.0
      And the owner is asked no further question
      And item 482 has a system event recording the run's move from SOP 0.1.0 to SOP 0.2.0

    @ac-4 @db
    Scenario: Whatever the answer says, the run resumes on the image's SOP
      Given a run for item 482 pinned to SOP 0.1.0 that resumes at self-review
      And item 482 is in NeedsInput with the question "SOP 0.1.0 isn't in this cell image, which has 0.2.0"
      When the owner answers the question with "ok"
      And the factory claims the run and its cell runs
      Then the cell runs the self-review stage
      And the run records SOP version 0.2.0
      And item 482 is not in NeedsInput

  Rule: A run whose next stage the newer SOP lacks still asks for input, and the question names that stage

    @ac-5
    Scenario: A run whose next stage is gone from the image's SOP asks a question naming the stage
      Given a run for item 482 pinned to SOP 0.1.0 that resumes at qa-review
      And SOP 0.2.0 has no qa-review stage
      When the factory claims the run and its cell runs
      Then item 482 moves to NeedsInput
      And the question names the stage "qa-review"
      And the question says SOP 0.2.0 has no such stage
      And no stage runs

    @ac-5 @db
    Scenario: A run that can't move stays on its old SOP and logs no move
      Given a run for item 482 pinned to SOP 0.1.0 that resumes at qa-review
      And SOP 0.2.0 has no qa-review stage
      When the factory claims the run and its cell runs
      Then the question names the stage "qa-review"
      And the run still records SOP version 0.1.0
      And item 482 has no system event recording a move of SOP version

    @ac-5 @db
    Scenario: Answering the question on a run whose stage is gone asks again, naming the stage
      Given a run for item 482 pinned to SOP 0.1.0 that resumes at qa-review
      And SOP 0.2.0 has no qa-review stage
      And item 482 is in NeedsInput with the question "SOP 0.1.0 isn't in this cell image, which has 0.2.0"
      When the owner answers the question
      And the factory claims the run and its cell runs
      Then item 482 moves to NeedsInput
      And the question names the stage "qa-review"

  Rule: A new run pins the image's SOP version on its first claim, as it does today

    @ac-6 @regression @db
    Scenario: A new run's first claim pins the image's SOP version
      Given a fresh run for item 482 that has never been claimed
      When the factory claims the run
      Then the run records SOP version 0.2.0

    @ac-6 @regression @db
    Scenario: A new run's first claim logs no SOP move
      Given a fresh run for item 482 that has never been claimed
      When the factory claims the run
      Then item 482 has no system event recording a move of SOP version
