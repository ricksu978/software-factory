@pbi-414
Feature: The engine decides the rules line for an item that carries the "Changes the factory's rules" section
  The repo's dor.md has a line about items that change the factory's own rules. Today the readiness judge decides
  that line. A judge that reads it as "the owner hasn't approved this yet" fails it, so the item fails a readiness
  check instead of waiting for the owner's approval, and an item the owner has already approved fails again on the
  next check. With this item, the engine decides the line for an item that carries the section. The engine holds
  each entry's Before to main and checks that the section covers every rule the judge names. When all of that
  holds, the line is recorded as passed, whatever the judge said about it. When the section misses a rule, an entry
  is off, or the item has no section, the line is judged as today.
  The board, the repo and the readiness judge are fakes.

  Background:
    Given item "414" titled "Shorter leases" is an issue in the repo "acme/widgets"
    And the repo has a ".factory/dor.md" with these lines:
      | text                                                                                                            |
      | Every acceptance criterion can be tested                                                                        |
      | An item that changes the factory's own rules says so in its section, and waits for the owner to approve it      |
    And on main, spec section "§6" holds the rule "A lease lasts ten minutes and the worker renews it every minute."
    And on main, spec section "§5" holds the rule "A NotReady item moves to Eligible when a readiness input changes."
    And on main, the policy file "policy/dor.md" holds the rule "The item fits one Sprint."

  Rule: When every entry holds to main and the section covers every rule the judge names, the engine passes the rules line

    @ac-1
    Scenario: A judge that fails the rules line for a missing approval no longer fails it
      Given item "414"'s rules section changes spec section "§6" with a Before that matches main word for word and an After
      And the readiness judge passes line 1, fails line 2 because "The owner hasn't approved this change yet." and finds the item changes spec section "§6"
      When the readiness check checks item "414"
      Then the readiness check recorded line 2 as passed for item "414"
      And that line's reason says the engine held each entry to main and found every rule the judge named covered
      And that line's reason doesn't say "The owner hasn't approved this change yet."

    @ac-1
    Scenario: A section covering a spec section and a policy file passes the rules line the judge failed
      Given item "414"'s rules section changes spec section "§6" with a Before that matches main word for word and an After
      And it changes the policy file "policy/dor.md" with a Before that matches main word for word and an After
      And the readiness judge passes line 1, fails line 2 because "The item rewrites the factory's rules." and finds the item changes spec section "§6" and the policy file "policy/dor.md"
      When the readiness check checks item "414"
      Then the readiness check recorded line 2 as passed for item "414"
      And that line's reason says the engine held each entry to main and found every rule the judge named covered

    @ac-1
    Scenario: A section naming more rules than the judge finds still passes the rules line the judge failed
      Given item "414"'s rules section changes spec sections "§5" and "§6", each with a Before that matches main word for word and an After
      And the readiness judge passes line 1, fails line 2 because "The owner hasn't approved this change yet." and finds the item changes spec section "§6"
      When the readiness check checks item "414"
      Then the readiness check recorded line 2 as passed for item "414"
      And that line's reason says the engine held each entry to main and found every rule the judge named covered

  Rule: An item whose rules line the engine passed, passing every other line, waits for the owner's approval

    @ac-2
    Scenario: The item waits in NotReady for approval and its comment says it passed every check
      Given item "414"'s rules section changes spec section "§6" with a Before that matches main word for word and an After
      And the readiness judge passes line 1, fails line 2 because "The owner hasn't approved this change yet." and finds the item changes spec section "§6"
      When the readiness check checks item "414"
      Then the factory holds item "414" in state "NotReady"
      And item "414" is waiting for the owner's approval
      And the board item has a new readiness comment that opens "It passed every readiness check, and it changes the factory's own rules"
      And that comment doesn't say "The owner hasn't approved this change yet."

    @ac-2
    Scenario: An item whose rules line the engine passed but that fails another line fails for that line, not for approval
      Given item "414"'s rules section changes spec section "§6" with a Before that matches main word for word and an After
      And the readiness judge fails line 1 because "Criterion 2 says fast with no measure.", fails line 2 because "The owner hasn't approved this change yet." and finds the item changes spec section "§6"
      When the readiness check checks item "414"
      Then the factory holds item "414" in state "NotReady"
      And item "414" isn't waiting for the owner's approval
      And the board item has a new readiness comment saying "Criterion 2 says fast with no measure."
      And that comment doesn't say "The owner hasn't approved this change yet."

  Rule: After the owner approves, the engine passes the rules line again and the item goes on as an approved one

    @ac-3
    Scenario: An approved item whose rules line the judge fails again goes on to Queued
      Given item "414"'s rules section changes spec section "§6" with a Before that matches main word for word and an After
      And item "414" is waiting for the owner's approval of its change to spec section "§6"
      And the readiness judge passes line 1, fails line 2 because "The owner hasn't approved this change yet." and finds the item changes spec section "§6"
      When the owner approves the rule change on item "414"'s item page
      And the poller runs once
      Then the readiness check recorded line 2 as passed for item "414"
      And that line's reason says the engine held each entry to main and found every rule the judge named covered
      And the factory holds item "414" in state "Queued"
      And item "414" isn't waiting for the owner's approval
      And item "414" still holds the owner's approval of its change to spec section "§6"

  Rule: A section that misses a rule the judge names fails the rules line, as today

    @ac-4 @regression
    Scenario: A section that misses a spec section the judge names fails the line, and the finding names it
      Given item "414"'s rules section changes spec section "§6" with a Before that matches main word for word and an After
      And the readiness judge passes every line and finds the item changes spec sections "§5" and "§6"
      When the readiness check checks item "414"
      Then the readiness check failed item "414" on line 2
      And that finding names spec section "§5"
      And the factory holds item "414" in state "NotReady"
      And item "414" isn't waiting for the owner's approval

    @ac-4 @regression
    Scenario: A section that misses a rule the judge names fails the line the judge failed, and the finding names each missing section
      Given item "414"'s rules section changes spec section "§6" with a Before that matches main word for word and an After
      And the readiness judge passes line 1, fails line 2 because "The owner hasn't approved this change yet." and finds the item changes spec sections "§5" and "§6" and the policy file "policy/dor.md"
      When the readiness check checks item "414"
      Then the readiness check failed item "414" on line 2
      And that finding names spec section "§5" and the policy file "policy/dor.md"
      And that finding doesn't name spec section "§6" as one to cover
      And item "414" isn't waiting for the owner's approval

  Rule: An entry with no Before, no After, or a Before not on main fails the item, and the judge's verdict on the line stands

    @ac-5 @regression
    Scenario: An entry with no After fails the item, and the judge's failure of the line stands
      Given item "414"'s rules section changes spec section "§6" with a Before that matches main word for word and no After
      And the readiness judge passes line 1, fails line 2 because "The owner hasn't approved this change yet." and finds the item changes spec section "§6"
      When the readiness check checks item "414"
      Then the board item has a new readiness comment saying the entry for spec section "§6" gives no After
      And the readiness check failed item "414" on line 2 because "The owner hasn't approved this change yet."
      And the factory holds item "414" in state "NotReady"
      And item "414" isn't waiting for the owner's approval

    @ac-5 @regression
    Scenario: An entry with no Before fails the item, and the judge's failure of the line stands
      Given item "414"'s rules section changes spec section "§6" with an After and no Before
      And the readiness judge passes line 1, fails line 2 because "The owner hasn't approved this change yet." and finds the item changes spec section "§6"
      When the readiness check checks item "414"
      Then the board item has a new readiness comment saying the entry for spec section "§6" gives no Before
      And the readiness check failed item "414" on line 2 because "The owner hasn't approved this change yet."
      And item "414" isn't waiting for the owner's approval

    @ac-5 @regression
    Scenario: A Before that isn't on main word for word fails the item, and the judge's failure of the line stands
      Given item "414"'s rules section changes spec section "§6" with the Before "A lease lasts ten minutes and the worker renews it every second." and an After
      And the readiness judge passes line 1, fails line 2 because "The owner hasn't approved this change yet." and finds the item changes spec section "§6"
      When the readiness check checks item "414"
      Then the board item has a new readiness comment saying the Before quoted for spec section "§6" doesn't match main
      And the readiness check failed item "414" on line 2 because "The owner hasn't approved this change yet."
      And item "414" isn't waiting for the owner's approval

    @ac-5 @regression
    Scenario: One entry off among two keeps the judge's failure of the line, though the other entry holds
      Given item "414"'s rules section changes spec section "§6" with a Before that matches main word for word and an After
      And it changes the policy file "policy/dor.md" with the Before "The item fits one sprint." and an After
      And the readiness judge passes line 1, fails line 2 because "The owner hasn't approved this change yet." and finds the item changes spec section "§6" and the policy file "policy/dor.md"
      When the readiness check checks item "414"
      Then the board item has a new readiness comment saying the Before quoted for "policy/dor.md" doesn't match main
      And the readiness check failed item "414" on line 2 because "The owner hasn't approved this change yet."
      And item "414" isn't waiting for the owner's approval

    @ac-5 @regression
    Scenario: An entry that's off fails the item, and the judge's pass of the line stands
      Given item "414"'s rules section changes spec section "§6" with a Before that matches main word for word and no After
      And the readiness judge passes every line and finds the item changes spec section "§6"
      When the readiness check checks item "414"
      Then the board item has a new readiness comment saying the entry for spec section "§6" gives no After
      And the readiness check recorded line 2 as passed for item "414" with the judge's reason
      And item "414" isn't waiting for the owner's approval

  Rule: An item with no rules section is judged on the rules line as today

    @ac-6 @regression
    Scenario: An item with no section that the judge finds changes a rule fails the rules line
      Given item "414"'s body has no "## Changes the factory's rules" section
      And the readiness judge passes every line and finds the item changes spec section "§6"
      When the readiness check checks item "414"
      Then the readiness check failed item "414" on line 2
      And that finding names spec section "§6"
      And the factory holds item "414" in state "NotReady"
      And item "414" isn't waiting for the owner's approval

    @ac-6 @regression
    Scenario: An item with no section that the judge fails on the line while naming no rule keeps the judge's failure
      Given item "414"'s body has no "## Changes the factory's rules" section
      And the readiness judge passes line 1, fails line 2 because "The item reads like a change to the lease rule." and finds the item changes no factory rule
      When the readiness check checks item "414"
      Then the readiness check failed item "414" on line 2 because "The item reads like a change to the lease rule."
      And the factory holds item "414" in state "NotReady"
      And item "414" isn't waiting for the owner's approval

    @ac-6 @regression
    Scenario: An item with no section that the judge passes on the line while naming no rule goes on to Queued
      Given item "414"'s body has no "## Changes the factory's rules" section
      And the readiness judge passes every line and finds the item changes no factory rule
      When the readiness check checks item "414"
      Then the readiness check recorded line 2 as passed for item "414" with the judge's reason
      And the factory holds item "414" in state "Queued"
      And item "414" isn't waiting for the owner's approval

  Rule: Spec §6 says the engine decides the rules line for an item that carries the section

    @ac-7
    Scenario: Spec §6 reads as the After the item gives for it
      Given the After that backlog item 414's "Changes the factory's rules" section gives for spec section "§6"
      When the design spec on this branch is read as prose
      Then spec section "§6" holds that After word for word
