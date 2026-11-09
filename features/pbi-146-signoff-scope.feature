@pbi-146
Feature: The sign-off view shows the issue's scope and the scenarios in full
  When an item waits for sign-off, Run detail lists the acceptance criteria and the names of the
  scenarios under each one. To judge whether the scenarios cover the work, the owner also needs what
  the issue asked for and the scenarios' full text, and today they must open GitHub for both. With
  this item, Run detail shows a Scope section with the issue's body as written on GitHub. It also
  shows every feature file up for sign-off in full, as it stands at the scenarios sha. All of this
  comes before the Approve and Ask for changes buttons, so the owner reads it before deciding. Once
  the scenarios lock, Run detail shows the signed-off files at the lock sha, as it does today.
  Scenarios tagged @db need Postgres, which each test starts for itself, so cells and CI both run
  them. The board and the repo are fakes.

  Rule: While an item waits for sign-off, Run detail shows the issue's body as its scope

    @ac-1 @db
    Scenario: An item waiting for sign-off shows its issue's body in a Scope section
      Given item "146" is an issue whose body reads "Show the owner what the item is for."
      And the item waits for sign-off on scenarios at "abc123"
      When the owner opens the item's Run detail
      Then Run detail has a Scope section
      And the Scope section shows "Show the owner what the item is for."

    @ac-1 @db
    Scenario: The scope keeps the body's lines as written
      Given item "146" is an issue whose body has the lines "## Why", "The owner signs off blind." and "- Show the body"
      And the item waits for sign-off on scenarios at "abc123"
      When the owner opens the item's Run detail
      Then the Scope section shows "## Why", "The owner signs off blind." and "- Show the body" on separate lines, in that order

    @ac-1 @db
    Scenario: Markup in the body shows as text, not as part of the page
      Given item "146" is an issue whose body reads "Fix <script>alert(1)</script> & <b>bold</b>"
      And the item waits for sign-off on scenarios at "abc123"
      When the owner opens the item's Run detail
      Then the Scope section shows the text "Fix <script>alert(1)</script> & <b>bold</b>"
      And the page holds no script or bold text from the body

  Rule: While an item waits for sign-off, Run detail shows every feature file up for sign-off in full, at the scenarios sha

    @ac-2 @db
    Scenario: The feature file up for sign-off shows in full under its path
      Given item "146" waits for sign-off on scenarios at "abc123"
      And at "abc123" the file "features/pbi-146-scope.feature" holds a feature with a description, a rule and two scenarios
      When the owner opens the item's Run detail
      Then Run detail shows the heading "features/pbi-146-scope.feature"
      And under it Run detail shows the whole text of "features/pbi-146-scope.feature" at "abc123", line for line

    @ac-2 @db
    Scenario: Every feature file up for sign-off shows, each under its own path
      Given item "146" waits for sign-off on scenarios at "abc123" in the files "features/pbi-146-a.feature" and "features/pbi-146-b.feature"
      When the owner opens the item's Run detail
      Then Run detail shows the whole text of "features/pbi-146-a.feature" at "abc123" under the heading "features/pbi-146-a.feature"
      And Run detail shows the whole text of "features/pbi-146-b.feature" at "abc123" under the heading "features/pbi-146-b.feature"

    @ac-2 @db
    Scenario: The files show as they stand at the scenarios sha, not as they stand later
      Given item "146" waits for sign-off on scenarios at "abc123"
      And at "abc123" the file "features/pbi-146-scope.feature" holds the scenario "The owner reads the scope"
      And a later commit "def456" renames that scenario to "The owner skims the scope"
      When the owner opens the item's Run detail
      Then Run detail shows "The owner reads the scope" in "features/pbi-146-scope.feature"
      And Run detail does not show "The owner skims the scope"

    @ac-2 @db
    Scenario: Markup in a feature file shows as text, not as part of the page
      Given item "146" waits for sign-off on scenarios at "abc123"
      And at "abc123" the file "features/pbi-146-scope.feature" has a step that reads "Then the page shows \"<b>Approve</b>\""
      When the owner opens the item's Run detail
      Then Run detail shows the text "Then the page shows \"<b>Approve</b>\"" in "features/pbi-146-scope.feature"
      And the page holds no bold text from the feature file

  Rule: The scope, the criteria and the feature files come before the sign-off buttons

    @ac-3 @db
    Scenario: The owner reads the scope, the criteria and the feature files before reaching the buttons
      Given item "146" is an issue whose body reads "Show the owner what the item is for."
      And the item has the acceptance criterion "The owner sees the scope"
      And the item waits for sign-off on scenarios at "abc123" in the file "features/pbi-146-scope.feature"
      When the owner opens the item's Run detail
      Then the Scope section comes before the "Approve the scenarios" button
      And the criteria list comes before the "Approve the scenarios" button
      And the text of "features/pbi-146-scope.feature" comes before the "Approve the scenarios" button
      And the Scope section, the criteria list and the text of "features/pbi-146-scope.feature" all come before the "Ask for changes" button

  Rule: An item that timed out waiting for sign-off, and still shows the sign-off form, shows the scope and scenarios too

    @ac-4 @db
    Scenario: A timed-out item that still shows the sign-off form shows its scope and feature files
      Given item "146" is an issue whose body reads "Show the owner what the item is for."
      And the item waited for sign-off on scenarios at "abc123" in the file "features/pbi-146-scope.feature"
      And the item was abandoned when its sign-off timed out, and its sign-off can still be given
      When the owner opens the item's Run detail
      Then Run detail shows the sign-off form
      And the Scope section shows "Show the owner what the item is for."
      And Run detail shows the whole text of "features/pbi-146-scope.feature" at "abc123" under the heading "features/pbi-146-scope.feature"
      And the Scope section and the text of "features/pbi-146-scope.feature" come before the "Approve the scenarios" button

  Rule: Once the scenarios lock, Run detail shows the signed-off files at the lock sha, as it does today

    @ac-5 @db @regression
    Scenario: A locked item shows its signed-off feature files at the lock sha
      Given item "146" signed off its scenarios in the file "features/pbi-146-scope.feature", locked at "abc123"
      And the item is in flight at green
      When the owner opens the item's Run detail
      Then Run detail shows "Signed-off scenarios"
      And Run detail shows the whole text of "features/pbi-146-scope.feature" at "abc123" under the heading "features/pbi-146-scope.feature"

    @ac-5 @db @regression
    Scenario: A locked item shows its files as they stood at the lock sha, not as they stand later
      Given item "146" signed off its scenarios in the file "features/pbi-146-scope.feature", locked at "abc123"
      And at "abc123" that file holds the scenario "The owner reads the scope"
      And a later commit "def456" renames that scenario to "The owner skims the scope"
      And the item is in flight at green
      When the owner opens the item's Run detail
      Then Run detail shows "The owner reads the scope" under "Signed-off scenarios"
      And Run detail does not show "The owner skims the scope"

  Rule: An empty body shows no Scope section, and a missing file says so

    @ac-6 @db
    Scenario Outline: An issue with <body> shows no Scope section but still shows its feature files
      Given item "146" is an issue with <body>
      And the item waits for sign-off on scenarios at "abc123" in the file "features/pbi-146-scope.feature"
      When the owner opens the item's Run detail
      Then Run detail has no Scope section
      And Run detail shows the whole text of "features/pbi-146-scope.feature" at "abc123" under the heading "features/pbi-146-scope.feature"
      And Run detail shows the "Approve the scenarios" button

      Examples:
        | body                       |
        | an empty body              |
        | a body of only blank lines |

    @ac-6 @db
    Scenario: A feature file missing at the scenarios sha says so under its path
      Given item "146" waits for sign-off on scenarios at "abc123" in the files "features/pbi-146-a.feature" and "features/pbi-146-gone.feature"
      And at "abc123" there is no file "features/pbi-146-gone.feature"
      When the owner opens the item's Run detail
      Then Run detail shows "(missing at this commit)" under the heading "features/pbi-146-gone.feature"
      And Run detail shows the whole text of "features/pbi-146-a.feature" at "abc123" under the heading "features/pbi-146-a.feature"
