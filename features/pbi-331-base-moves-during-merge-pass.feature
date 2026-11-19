@pbi-331
Feature: A base that moves during the merge pass doesn't block the item
  Every claim starts by fetching the item's base and merging it into the branch. A conflict gets one
  agent pass, the `merge` attempt, and the factory then checks that the agent's commit really merged
  the base. Today that check fetches the base a second time. If someone pushed to the base while the
  agent worked, the check merges those newer commits too. When they conflict, the item blocks on a
  conflict the agent was never asked to resolve, and the merge attempt counts as failed.
  With this item, the check verifies the merge against the base commit the claim fetched, and doesn't
  fetch again. Commits the base gained during the pass reach the branch the way any later change to
  the base does: the item's PR conflicts with its base, the poller sends the InReview item back to
  Queued, and the next claim merges the newer base. A conflict the agent leaves unresolved still
  blocks with its paths, as today.
  In every scenario, the item's base is "main", the claim fetched "main" at commit "b4se001", and the
  item's branch conflicts with "b4se001" in "src/app.ts". Commit "b4se002" lands on "main" after the
  claim fetched it. Scenarios tagged @db need Postgres, which each test starts for itself, so cells and
  CI both run them. The rest run the cell engine against a fake control plane, agent and repo.

  Rule: The check after the merge pass verifies the merge against the base the claim fetched, without fetching again

    @ac-1
    Scenario: A base that gains a conflicting commit during the merge pass doesn't block the item
      Given an item is claimed at the green stage
      And while the merge agent works, commit "b4se002" lands on "main" and changes "src/app.ts" so it conflicts with the agent's resolution
      And the merge agent resolves the conflict in "src/app.ts" and commits the merge
      When the cell runs the claim
      Then the item is not blocked
      And the "merge" attempt ends as passed
      And the run goes on to the green stage

    @ac-1
    Scenario: The branch holds the base the claim fetched, not the commits the base gained during the pass
      Given an item is claimed at the green stage
      And while the merge agent works, commit "b4se002" lands on "main" and changes "src/app.ts" so it conflicts with the agent's resolution
      And the merge agent resolves the conflict in "src/app.ts" and commits the merge
      When the cell runs the claim
      Then the branch holds commit "b4se001" of "main"
      And the branch doesn't hold commit "b4se002" of "main"

    @ac-1
    Scenario: A base that gains a commit that doesn't conflict during the pass leaves that commit for a later claim
      Given an item is claimed at the green stage
      And while the merge agent works, commit "b4se002" lands on "main" and changes only "docs/notes.md"
      And the merge agent resolves the conflict in "src/app.ts" and commits the merge
      When the cell runs the claim
      Then the "merge" attempt ends as passed
      And the branch doesn't hold commit "b4se002" of "main"
      And the cell fetched "main" only once during the claim

    @ac-1
    Scenario: The check fetches the base only once in a claim, even when the base didn't move
      Given an item is claimed at the green stage
      And nothing lands on "main" while the merge agent works
      And the merge agent resolves the conflict in "src/app.ts" and commits the merge
      When the cell runs the claim
      Then the "merge" attempt ends as passed
      And the cell fetched "main" only once during the claim

    @ac-1
    Scenario: A base that moves during the merge pass at address doesn't block the item either
      Given an item is claimed at the address stage with PR 57 open
      And while the merge agent works, commit "b4se002" lands on "main" and changes "src/app.ts" so it conflicts with the agent's resolution
      And the merge agent resolves the conflict in "src/app.ts" and commits the merge
      When the cell runs the claim
      Then the item is not blocked
      And the "merge" attempt ends as passed
      And the branch doesn't hold commit "b4se002" of "main"

  Rule: Commits the base gained during the pass reach the branch through a PR conflict and a later claim

    @ac-2
    Scenario: The run whose base moved during the merge pass opens its PR on the base the claim fetched
      Given an item is claimed at the green stage
      And while the merge agent works, commit "b4se002" lands on "main" and changes "src/app.ts" so it conflicts with the agent's resolution
      And the merge agent resolves the conflict in "src/app.ts" and commits the merge
      And the green, refactor and open-pr stages pass
      When the cell runs the claim
      Then the item moves to "InReview" with its PR open
      And the PR's branch doesn't hold commit "b4se002" of "main"

    @ac-2 @db
    Scenario: The PR conflicting with the base's newer commit sends the item back to Queued, and the next claim merges that commit
      Given an item's claim fetched "main" at "b4se001", and commit "b4se002" landed on "main" while its merge agent worked
      And that claim's run opened PR 57 and the item moved to "InReview"
      And GitHub reports PR 57 as conflicting with its base
      When the poller runs once
      Then the factory holds the item in state "Queued"
      And the item's run resumes from "address"
      When the item is claimed again and its merge agent resolves the conflict in "src/app.ts"
      Then the branch holds commit "b4se002" of "main"

  Rule: A conflict the agent leaves unresolved still blocks the item with its paths

    @ac-3 @regression
    Scenario: Conflict markers the agent leaves in a file block the item with that file's path
      Given an item is claimed at the green stage
      And nothing lands on "main" while the merge agent works
      And the merge agent leaves conflict markers in "src/app.ts"
      When the cell runs the claim
      Then the item is blocked with the reason "Merging main left conflicts in: src/app.ts"
      And the conflict markers are not committed to the branch

    @ac-3 @regression
    Scenario: Conflict markers left while the base moved still block with only the agent's unresolved paths
      Given an item is claimed at the green stage
      And while the merge agent works, commit "b4se002" lands on "main" and changes "src/app.ts" so it conflicts with the agent's resolution
      And the merge agent leaves conflict markers in "src/app.ts"
      When the cell runs the claim
      Then the item is blocked with the reason "Merging main left conflicts in: src/app.ts"

    @ac-3
    Scenario: A merge the agent abandoned blocks with the paths that conflict with the base the claim fetched
      Given an item is claimed at the green stage
      And while the merge agent works, commit "b4se002" lands on "main" and changes "src/app.ts" and "src/other.ts" so both conflict with the branch
      And the merge agent aborts the merge and commits without merging "main"
      When the cell runs the claim
      Then the item is blocked with the reason "Merging main left conflicts in: src/app.ts"
      And the cell fetched "main" only once during the claim
