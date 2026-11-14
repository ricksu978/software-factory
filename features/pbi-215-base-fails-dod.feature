@pbi-215
Feature: A Definition of Done failure that also fails on the base commit is reported as the base's, not charged to the item
  A cell checks each line of the repo's Definition of Done that has a command by running that command in its
  checkout. Today, any failure counts against the item. If the base branch is already broken, the item spends
  every retry trying to fix tests it never touched, and then fails or asks a question that blames the item.
  With this item, when a Definition of Done command fails, the cell runs the same command on the run's base
  commit, `origin/<base>`, before it charges the failure to the item. If every test that failed on the item's
  branch also fails on the base, the stage stops retrying and asks one question. The question says the base
  fails in the cell, names the failing tests and names the base commit. The Floor shows that the base fails in
  cells, with the failing tests, while any item waits on such a question. A failure that happens only on the
  item's branch is handled as today. The base run is a plain command, with no AI call, and runs only after a
  line has failed.
  Scenarios tagged @db need Postgres, which each test starts for itself, so cells and CI both run them. The
  rest run the cell engine against a fake control plane, agent and repo.

  Rule: A failed Definition of Done command is run again on the base commit before the failure is charged to the item

    @ac-1
    Scenario: A command that fails on the item's branch is run again on the base commit
      Given a run for item 482 on base "main" whose scenarios were signed off
      And "origin/main" is at commit "b4se001"
      And the repo's Definition of Done has the line "Unit tests pass. `run: npm test`"
      And on the item's branch the command fails the test "parses the config"
      When the cell runs
      Then the cell ran "npm test" on commit "b4se001"
      And it ran there after "npm test" had failed on the item's branch

    @ac-1
    Scenario: Only the line that failed is run on the base commit
      Given a run for item 482 on base "main" whose scenarios were signed off
      And "origin/main" is at commit "b4se001"
      And the repo's Definition of Done has these lines:
        | line                                    | on the item's branch                  |
        | Typecheck passes. `run: npm run check`  | passes                                |
        | Unit tests pass. `run: npm test`        | fails the test "parses the config"    |
      When the cell runs
      Then the cell ran "npm test" on commit "b4se001"
      And the cell didn't run "npm run check" on commit "b4se001"

    @ac-1
    Scenario: The base run leaves the item's branch as it was
      Given a run for item 482 on base "main" whose scenarios were signed off
      And "origin/main" is at commit "b4se001"
      And the repo's Definition of Done has the line "Unit tests pass. `run: npm test`"
      And on the item's branch the command fails the test "parses the config"
      And on commit "b4se001" the command passes
      When the cell runs
      Then the cell ran "npm test" on commit "b4se001"
      And every Green attempt after the first starts from the item's branch, not from commit "b4se001"
      And no commit pushed for the item is commit "b4se001"

  Rule: When the same tests also fail on the base, the stage stops and asks one question that blames the base

    @ac-2
    Scenario: Green doesn't retry when the base fails the same tests, and asks one question naming the tests and the base commit
      Given a run for item 482 on base "main" whose scenarios were signed off
      And "origin/main" is at commit "b4se001"
      And the repo's Definition of Done has the line "Unit tests pass. `run: npm test`"
      And on the item's branch the command fails the tests "parses the config" and "reads the board"
      And on commit "b4se001" the command fails the tests "parses the config" and "reads the board"
      When the cell runs
      Then Green ran 1 time
      And the item moves to NeedsInput
      And the owner is asked exactly 1 question
      And the question says the base fails in the cell
      And the question names the tests "parses the config" and "reads the board"
      And the question names the base commit "b4se001"
      And no PR is opened

    @ac-2
    Scenario: The question doesn't charge the failure to the item
      Given a run for item 482 on base "main" whose scenarios were signed off
      And "origin/main" is at commit "b4se001"
      And the repo's Definition of Done has the line "Unit tests pass. `run: npm test`"
      And on the item's branch the command fails the test "parses the config"
      And on commit "b4se001" the command fails the test "parses the config"
      When the cell runs
      Then the item doesn't move to Failed
      And the question doesn't say Green failed after its attempts

    @ac-2
    Scenario: The base failing more tests than the item's branch still blames the base
      Given a run for item 482 on base "main" whose scenarios were signed off
      And "origin/main" is at commit "b4se001"
      And the repo's Definition of Done has the line "Unit tests pass. `run: npm test`"
      And on the item's branch the command fails the test "parses the config"
      And on commit "b4se001" the command fails the tests "parses the config" and "reads the board"
      When the cell runs
      Then Green ran 1 time
      And the item moves to NeedsInput
      And the question says the base fails in the cell
      And the question names the test "parses the config"
      And the question names the base commit "b4se001"

    @ac-2
    Scenario: Address doesn't retry when the base fails the same tests, and asks the base question
      Given an item 482 in review on base "main" whose run resumes at address
      And "origin/main" is at commit "b4se001"
      And a trusted reviewer commented "rename foo to bar" on the PR
      And CI passes on the pushed fix
      And the repo's Definition of Done has the line "Unit tests pass. `run: npm test`"
      And on the item's branch the command fails the test "parses the config"
      And on commit "b4se001" the command fails the test "parses the config"
      When the cell runs
      Then address ran 1 time
      And the item moves to NeedsInput
      And the owner is asked exactly 1 question
      And the question says the base fails in the cell
      And the question names the test "parses the config"
      And the question names the base commit "b4se001"

  Rule: A failure that happens only on the item's branch is handled as today, with retries

    @ac-3 @regression
    Scenario: Green retries a failure the base doesn't share, then the item fails as today
      Given a run for item 482 on base "main" whose scenarios were signed off
      And "origin/main" is at commit "b4se001"
      And the repo's Definition of Done has the line "Unit tests pass. `run: npm test`"
      And on the item's branch the command fails the test "parses the config" on every attempt
      And on commit "b4se001" the command passes
      When the cell runs
      Then Green ran 4 times
      And the item moves to Failed
      And no question says the base fails in the cell

    @ac-3 @regression
    Scenario: A test that fails only on the item's branch is charged to the item, even when the base fails others
      Given a run for item 482 on base "main" whose scenarios were signed off
      And "origin/main" is at commit "b4se001"
      And the repo's Definition of Done has the line "Unit tests pass. `run: npm test`"
      And on the item's branch the command fails the tests "parses the config" and "reads the board" on every attempt
      And on commit "b4se001" the command fails the test "parses the config"
      When the cell runs
      Then Green ran 4 times
      And the item moves to Failed
      And no question says the base fails in the cell

    @ac-3 @regression
    Scenario: A retry that fixes the item's own failure goes on to open the PR
      Given a run for item 482 on base "main" whose scenarios were signed off
      And "origin/main" is at commit "b4se001"
      And the repo's Definition of Done has the line "Unit tests pass. `run: npm test`"
      And on the item's branch the command fails the test "parses the config" on the first attempt only
      And on commit "b4se001" the command passes
      When the cell runs
      Then Green ran 2 times
      And the item moves to InReview

    @ac-3 @regression
    Scenario: Address retries a failure the base doesn't share, then asks the question it asks today
      Given an item 482 in review on base "main" whose run resumes at address
      And "origin/main" is at commit "b4se001"
      And a trusted reviewer commented "rename foo to bar" on the PR
      And CI passes on every pushed fix
      And the repo's Definition of Done has the line "Unit tests pass. `run: npm test`"
      And on the item's branch the command fails the test "parses the config" on every attempt
      And on commit "b4se001" the command passes
      When the cell runs
      Then address ran more than 1 time
      And the item moves to NeedsInput
      And the question says address failed
      And the question doesn't say the base fails in the cell

  Rule: The Floor shows that the base fails in cells, with the failing tests, while any item is blocked by it

    @ac-4 @db
    Scenario: The Floor shows the base failure and its tests while an item waits on it
      Given the factory runs locally for "octo"
      And "octo" is signed in to the dashboard
      And item 482 waits on a question saying the base fails in the cell at commit "b4se001", failing the test "parses the config"
      When "octo" opens the Floor
      Then the Floor says the base fails in cells
      And that notice names the test "parses the config"
      And that notice names item 482

    @ac-4 @db
    Scenario: The Floor stops showing the base failure once no item is blocked by it
      Given the factory runs locally for "octo"
      And "octo" is signed in to the dashboard
      And item 482 waits on a question saying the base fails in the cell at commit "b4se001", failing the test "parses the config"
      When "octo" opens the Floor
      Then the Floor says the base fails in cells
      When the owner answers item 482's question
      And "octo" opens the Floor
      Then the Floor doesn't say the base fails in cells

    @ac-4 @db
    Scenario: The Floor shows the base failure until the last item blocked by it moves on
      Given the factory runs locally for "octo"
      And "octo" is signed in to the dashboard
      And item 482 waits on a question saying the base fails in the cell at commit "b4se001", failing the test "parses the config"
      And item 483 waits on a question saying the base fails in the cell at commit "b4se001", failing the test "reads the board"
      When the owner answers item 482's question
      And "octo" opens the Floor
      Then the Floor says the base fails in cells
      And that notice names the test "reads the board"
      And that notice names item 483

    @ac-4 @db
    Scenario: An item waiting on another kind of question isn't named in the base failure notice
      Given the factory runs locally for "octo"
      And "octo" is signed in to the dashboard
      And item 482 waits on a question saying the base fails in the cell at commit "b4se001", failing the test "parses the config"
      And item 483 waits on a question "Address failed: CI failed on the PR"
      When "octo" opens the Floor
      Then the Floor says the base fails in cells
      And that notice names item 482
      And that notice doesn't name item 483

  Rule: The base run is a plain command with no AI call, and runs only after a line has failed

    @ac-5
    Scenario: The base run makes no agent call
      Given a run for item 482 on base "main" whose scenarios were signed off
      And "origin/main" is at commit "b4se001"
      And the repo's Definition of Done has these lines:
        | line                                    | on the item's branch                  |
        | Unit tests pass. `run: npm test`        | fails the test "parses the config"    |
        | The docs describe the change.           | judged passed                         |
      And on commit "b4se001" the command fails the test "parses the config"
      When the cell runs
      Then the cell ran "npm test" on commit "b4se001"
      And no agent call was made on commit "b4se001"
      And the agent judged the Definition of Done once, on the item's branch

    @ac-5
    Scenario: The base run happens only on the attempt whose command failed
      Given a run for item 482 on base "main" whose scenarios were signed off
      And "origin/main" is at commit "b4se001"
      And the repo's Definition of Done has the line "Unit tests pass. `run: npm test`"
      And on the item's branch the command fails the test "parses the config" on the first attempt only
      And on commit "b4se001" the command passes
      When the cell runs
      Then Green ran 2 times
      And the cell ran "npm test" on commit "b4se001" exactly once
      And that base run came after the first attempt's failure and before the second attempt began
      And the item moves to InReview

    @ac-5
    Scenario: A line the agent judged failed doesn't trigger a base run on its own
      Given a run for item 482 on base "main" whose scenarios were signed off
      And "origin/main" is at commit "b4se001"
      And the repo's Definition of Done has these lines:
        | line                                    | on the item's branch                                         |
        | Unit tests pass. `run: npm test`        | fails the test "parses the config" on the first attempt only |
        | The docs describe the change.           | judged failed on every attempt                               |
      And on commit "b4se001" the command passes
      When the cell runs
      Then Green ran 4 times
      And the cell ran "npm test" on commit "b4se001" exactly once
      And no agent call was made on commit "b4se001"
