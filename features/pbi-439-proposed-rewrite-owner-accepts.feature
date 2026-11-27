@pbi-439
Feature: The factory proposes a rewrite of a NotReady item that fails only dor.md lines, and the owner accepts it with one click
  Since PBI 264, a split's child that fails a dor.md line gets one rewrite of its body from the coding model, given
  the lines it failed and the judge's reasons. An item a person wrote gets no such help: it waits in NotReady with a
  readiness comment until someone edits it by hand.
  With this item, when an item a person wrote fails only dor.md lines, the factory asks the coding model for one
  rewrite of its body the same way, but doesn't apply it. The item page shows the proposed rewrite beside the current
  body with the words that change marked, and the owner alone sees an "Accept rewrite" button. Accepting edits the
  issue's body to the proposed text, posts one comment saying the factory applied the owner's accepted rewrite, and
  checks the item again at once. When the rewrite adds or changes a "## Changes the factory's rules" section,
  accepting it also approves that section as it reads, so the item doesn't wait for a second click. A proposed
  rewrite keeps the body's acceptance criteria word for word, except a criterion the judge found untestable, which
  moves to the Notes with a line saying why. An item that fails a readiness flag or an engine rule gets no proposed
  rewrite, and its readiness comment says what the owner has to do, as today. A person's edit after a rewrite was
  proposed withdraws the proposal, and the item is checked again as edited. The factory proposes at most one rewrite
  per version of the item's text, and a proposal nobody accepted stays on the item page until the text changes.
  Unless a scenario says otherwise, the repo is "acme/widgets", item "512" titled "Faster checkout" is an issue a
  person, "dana", wrote in it, and "olive" is the owner. The repo's ".factory/dor.md" has these lines:
  1. "Every acceptance criterion can be tested", 2. "The item names the screen it changes". Item 512's body has the
  acceptance criteria "The checkout page loads the saved card" and "Paying takes one click". The board, the repo,
  the readiness judge, the coding model and the clock are fakes.

  Background:
    Given item "512" titled "Faster checkout" is an issue "dana" wrote in the repo "acme/widgets"
    And "olive" is the owner of the factory
    And the repo has a ".factory/dor.md" with these lines:
      | text                                     |
      | Every acceptance criterion can be tested |
      | The item names the screen it changes     |
    And item "512"'s body has these acceptance criteria:
      | text                                   |
      | The checkout page loads the saved card |
      | Paying takes one click                 |

  Rule: When an item a person wrote fails only dor.md lines, the factory asks the coding model for one rewrite, given the lines it failed and the judge's reasons

    @ac-1
    Scenario: An item that fails one dor.md line gets one rewrite request
      Given the readiness judge fails item "512" on "The item names the screen it changes" because "No screen is named"
      And the coding model will rewrite item "512"'s body to name "the checkout page"
      When the readiness check checks item "512"
      Then the coding model was asked to rewrite item "512" once
      And the factory holds item "512" in state "NotReady"
      And item "512" has a proposed rewrite

    @ac-1
    Scenario: The rewrite request names each failed line with the judge's reason, as a split child's does
      Given the readiness judge fails item "512" on "The item names the screen it changes" because "No screen is named"
      And the readiness judge fails item "512" on "Every acceptance criterion can be tested" because "Paying takes one click has no measure of a click"
      When the readiness check checks item "512"
      Then the coding model was asked to rewrite item "512" once
      And the rewrite request for item "512" lists the criterion "The item names the screen it changes" with the reason "No screen is named"
      And the rewrite request for item "512" lists the criterion "Every acceptance criterion can be tested" with the reason "Paying takes one click has no measure of a click"
      And the rewrite request for item "512" carries the repo's dor.md word for word

    @ac-1
    Scenario: The proposed rewrite isn't applied to the issue on its own
      Given the readiness judge fails item "512" on "The item names the screen it changes" because "No screen is named"
      And the coding model will rewrite item "512"'s body to name "the checkout page"
      When the readiness check checks item "512"
      Then item "512" has a proposed rewrite
      And item "512"'s issue body is unchanged
      And the board item has a new readiness comment saying a rewrite is proposed on the item's page for the owner to accept

    @ac-1
    Scenario: A coding model reply with no body leaves no proposal and the readiness comment as today
      Given the readiness judge fails item "512" on "The item names the screen it changes" because "No screen is named"
      And the coding model answers the rewrite request for item "512" with no body
      When the readiness check checks item "512"
      Then the coding model was asked to rewrite item "512" once
      And item "512" has no proposed rewrite
      And the board item has a new readiness comment saying "No screen is named"

  Rule: The item page shows the proposed rewrite beside the current body with the changed words marked, and only the owner sees "Accept rewrite"

    @ac-2
    Scenario: The item page shows the current body beside the proposed rewrite
      Given item "512"'s body reads "Make checkout faster."
      And item "512" has a proposed rewrite that reads "Make the checkout page faster."
      When "olive" opens item "512"'s item page
      Then the item page shows item "512"'s current body beside its proposed rewrite

    @ac-2
    Scenario: The words that change are marked, and the words that stay aren't
      Given item "512"'s body reads "Make checkout faster."
      And item "512" has a proposed rewrite that reads "Make the checkout page faster."
      When "olive" opens item "512"'s item page
      Then the proposed rewrite marks "the" and "page" as words that change
      And neither side marks "Make" or "faster." as words that change

    @ac-2
    Scenario: The owner sees the "Accept rewrite" button
      Given item "512" has a proposed rewrite
      When "olive" opens item "512"'s item page
      Then the item page shows the "Accept rewrite" button

    @ac-2
    Scenario Outline: A <role> sees the proposal but not the "Accept rewrite" button
      Given item "512" has a proposed rewrite
      And "pat", a <role>, is signed in
      When "pat" opens item "512"'s item page
      Then the item page shows item "512"'s current body beside its proposed rewrite
      And the item page doesn't show the "Accept rewrite" button

      Examples:
        | role     |
        | viewer   |
        | operator |

    @ac-2
    Scenario: An operator who sends an acceptance anyway is refused and nothing changes
      Given item "512" has a proposed rewrite
      And "pat", an operator, is signed in
      When "pat" sends an acceptance of item "512"'s proposed rewrite
      Then the acceptance is refused
      And item "512"'s issue body is unchanged
      And item "512" still has a proposed rewrite

  Rule: Accepting edits the issue's body to the proposed text, posts one comment, and checks the item again at once

    @ac-3
    Scenario: Accepting edits the issue's body to the proposed text
      Given item "512" has a proposed rewrite that reads "Make the checkout page faster."
      When "olive" accepts item "512"'s proposed rewrite on its item page
      Then item "512"'s issue body reads "Make the checkout page faster."
      And item "512" has no proposed rewrite

    @ac-3
    Scenario: Accepting posts one comment saying the factory applied the owner's accepted rewrite
      Given item "512" has a proposed rewrite
      When "olive" accepts item "512"'s proposed rewrite on its item page
      Then item "512"'s issue has exactly one new comment
      And that comment says the factory applied the rewrite "olive", the owner, accepted

    @ac-3
    Scenario: The item is checked again at once and goes on when the rewrite now passes
      Given item "512" has a proposed rewrite
      And the readiness judge passes the rewritten item "512" on every line
      When "olive" accepts item "512"'s proposed rewrite on its item page
      Then the readiness judge was asked about the rewritten item "512" without waiting for the poller
      And the factory holds item "512" in state "Queued"

    @ac-3
    Scenario: A rewrite that still fails after it is accepted goes back to NotReady with a readiness comment
      Given item "512" has a proposed rewrite
      And the readiness judge fails the rewritten item "512" on "The item names the screen it changes" because "The screen named doesn't exist"
      When "olive" accepts item "512"'s proposed rewrite on its item page
      Then the factory holds item "512" in state "NotReady"
      And the board item has a new readiness comment saying "The screen named doesn't exist"

    @ac-3
    Scenario: The factory's own edit when the owner accepts doesn't count as a person's edit
      Given item "512" has a proposed rewrite
      And the readiness judge fails the rewritten item "512" on "The item names the screen it changes" because "The screen named doesn't exist"
      When "olive" accepts item "512"'s proposed rewrite on its item page
      And the poller runs once
      Then item "512"'s issue has exactly one comment saying the factory applied an accepted rewrite

  Rule: Accepting a rewrite that adds or changes a "Changes the factory's rules" section also approves that section as it reads

    @ac-4
    Scenario: A rewrite that adds a rules section is approved with the rewrite, and the item doesn't wait for a second click
      Given item "512"'s body has no "## Changes the factory's rules" section
      And item "512" has a proposed rewrite that adds a "## Changes the factory's rules" section changing spec section "§6"
      And the rewrite's Before for spec section "§6" matches main word for word
      And the readiness judge passes the rewritten item "512" on every line and finds it changes spec section "§6"
      When "olive" accepts item "512"'s proposed rewrite on its item page at "2026-11-27T10:00:00Z"
      Then item "512" has an event recording the rule change approval by "olive" at "2026-11-27T10:00:00Z"
      And item "512" isn't waiting for the owner's approval
      And the factory holds item "512" in state "Queued"

    @ac-4
    Scenario: A rewrite that changes an existing rules section approves the section as the rewrite reads
      Given item "512"'s rules section changes spec section "§6" with the After "A lease lasts five minutes."
      And item "512" has a proposed rewrite whose rules section changes spec section "§6" with the After "A lease lasts five minutes and the worker renews it every thirty seconds."
      And the readiness judge passes the rewritten item "512" on every line and finds it changes spec section "§6"
      When "olive" accepts item "512"'s proposed rewrite on its item page
      Then the approval recorded on item "512" is for spec section "§6" with the After "A lease lasts five minutes and the worker renews it every thirty seconds."
      And item "512" isn't waiting for the owner's approval

    @ac-4
    Scenario: The approval covers the section as accepted, so a later edit to that section waits for approval again
      Given item "512" has a proposed rewrite that adds a "## Changes the factory's rules" section changing spec section "§6"
      And the readiness judge passes the rewritten item "512" on every line and finds it changes spec section "§6"
      When "olive" accepts item "512"'s proposed rewrite on its item page
      And "dana" edits the After for spec section "§6" in item "512"'s rules section
      And the poller runs once
      Then the factory holds item "512" in state "NotReady"
      And item "512" is waiting for the owner's approval

    @ac-4
    Scenario: A rewrite that leaves the rules section untouched records no new approval
      Given item "512"'s body has no "## Changes the factory's rules" section
      And item "512" has a proposed rewrite with no "## Changes the factory's rules" section
      And the readiness judge passes the rewritten item "512" on every line
      When "olive" accepts item "512"'s proposed rewrite on its item page
      Then item "512" has no event recording a rule change approval
      And the factory holds item "512" in state "Queued"

  Rule: A proposed rewrite keeps the acceptance criteria word for word, except an untestable one, which moves to the Notes with a reason

    @ac-5
    Scenario: A rewrite keeps every acceptance criterion word for word
      Given the readiness judge fails item "512" on "The item names the screen it changes" because "No screen is named"
      And the coding model will rewrite item "512"'s body and reword its criterion "Paying takes one click" to "Payment needs a single click"
      When the readiness check checks item "512"
      Then item "512"'s proposed rewrite has these acceptance criteria, word for word:
        | text                                   |
        | The checkout page loads the saved card |
        | Paying takes one click                 |

    @ac-5
    Scenario: A criterion the judge found untestable moves to the Notes with a line saying why
      Given the readiness judge fails item "512" on "Every acceptance criterion can be tested" because "Paying takes one click has no measure of a click"
      When the readiness check checks item "512"
      Then item "512"'s proposed rewrite has these acceptance criteria, word for word:
        | text                                   |
        | The checkout page loads the saved card |
      And item "512"'s proposed rewrite has "Paying takes one click" under its Notes
      And the proposed rewrite's Notes say "Paying takes one click" moved there because "Paying takes one click has no measure of a click"

    @ac-5
    Scenario: The item page marks the criterion that moves to the Notes as a change
      Given the readiness judge fails item "512" on "Every acceptance criterion can be tested" because "Paying takes one click has no measure of a click"
      And the readiness check has checked item "512"
      When "olive" opens item "512"'s item page
      Then the current body marks the criterion "Paying takes one click" as words that change
      And neither side marks "The checkout page loads the saved card" as words that change

  Rule: An item that fails a readiness flag or an engine rule gets no proposed rewrite, and its readiness comment says what the owner has to do, as today

    @ac-6 @regression
    Scenario: An item that fails a dor.md line and a readiness flag gets no proposal, and the comment says what the owner has to do
      Given the readiness judge fails item "512" on "The item names the screen it changes" because "No screen is named"
      And the readiness judge flags item "512" as needing a new credential
      When the readiness check checks item "512"
      Then the coding model was never asked to rewrite item "512"
      And the board item has a new readiness comment saying the owner has to add the credential outside the factory

    @ac-6 @regression
    Scenario: An item that fails an engine rule gets no proposal, and the comment says what the owner has to do
      Given the factory's App lacks the "issues: write" permission on "acme/widgets"
      And the readiness judge fails item "512" on "The item names the screen it changes" because "No screen is named"
      When the readiness check checks item "512"
      Then the coding model was never asked to rewrite item "512"
      And the board item has a new readiness comment saying the owner has to grant the factory's App the "issues: write" permission

    @ac-6
    Scenario: Once the flag is cleared and only a dor.md line fails, the item gets a proposal
      Given the readiness judge flagged item "512" as needing a new credential when it was last checked
      And "dana" has edited item "512" to take the credential ask out of its text
      And the readiness judge now fails item "512" only on "The item names the screen it changes" because "No screen is named"
      When the poller runs once
      Then the coding model was asked to rewrite item "512" once
      And item "512" has a proposed rewrite

  Rule: A person's edit to the issue after a rewrite was proposed withdraws the proposal, and the item is checked again as edited

    @ac-7
    Scenario: A person's edit withdraws the proposal
      Given item "512" has a proposed rewrite
      When "dana" edits item "512"'s body to name "the checkout page"
      And the poller runs once
      Then item "512"'s history shows its proposed rewrite was withdrawn by "dana"'s edit
      And item "512" has no proposed rewrite
      And "olive" doesn't see the "Accept rewrite" button on item "512"'s item page

    @ac-7
    Scenario: The edited item is checked again as edited
      Given item "512" has a proposed rewrite
      And the readiness judge passes item "512" on every line once it names "the checkout page"
      When "dana" edits item "512"'s body to name "the checkout page"
      And the poller runs once
      Then item "512"'s history shows its proposed rewrite was withdrawn by "dana"'s edit
      And the readiness judge was asked about item "512" as "dana" edited it
      And the factory holds item "512" in state "Queued"

    @ac-7
    Scenario: An acceptance sent after the proposal was withdrawn is refused and the person's edit stands
      Given item "512" has a proposed rewrite
      And "dana" has edited item "512"'s body to read "Make the checkout page faster for saved cards."
      And the poller has run once
      When "olive" sends an acceptance of the proposal item "512" had before the edit
      Then the acceptance is refused because the proposal was withdrawn
      And item "512"'s issue body reads "Make the checkout page faster for saved cards."

  Rule: The factory proposes at most one rewrite per version of the item's text, and an unaccepted proposal stays until the text changes

    @ac-8
    Scenario: Checking an unchanged item again asks for no second rewrite
      Given the readiness judge fails item "512" on "The item names the screen it changes" because "No screen is named"
      And the readiness check has checked item "512"
      When the readiness check checks item "512" again with its text unchanged
      Then the coding model was asked to rewrite item "512" once

    @ac-8
    Scenario: An unaccepted proposal stays on the item page while the text is unchanged
      Given the readiness judge fails item "512" on "The item names the screen it changes" because "No screen is named"
      And the coding model will rewrite item "512"'s body to read "Make the checkout page faster."
      And the readiness check has checked item "512" at "2026-11-27T09:00:00Z"
      When the poller runs every hour until "2026-11-30T09:00:00Z" with item "512"'s text unchanged
      And "olive" opens item "512"'s item page
      Then the item page shows the proposed rewrite "Make the checkout page faster."
      And the item page shows the "Accept rewrite" button

    @ac-8
    Scenario: A new version of the text that still fails only dor.md lines gets one new proposal
      Given item "512" has a proposed rewrite
      And the readiness judge fails item "512" as edited on "Every acceptance criterion can be tested" because "Paying takes one click has no measure of a click"
      When "dana" edits item "512"'s body
      And the poller runs once
      And the poller runs once
      Then the coding model was asked to rewrite item "512" twice in all
      And item "512" has one proposed rewrite, made for its text as "dana" edited it
