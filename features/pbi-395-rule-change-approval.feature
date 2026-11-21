@pbi-395
Feature: An item may change the factory's own rules when it says so and the owner approves it on the item page
  The repo's dor.md has a line for items that change the factory's own rules: such an item must name the spec
  section it changes. Today that line can only pass or fail, and an item that rewrites a rule goes to build like any
  other. With this item, an item says it changes the factory's rules in a section headed
  "## Changes the factory's rules". For each rule it changes, the section names the spec section or policy file and
  quotes the rule's current text on main word for word as Before, then gives the rule as it will read as After.
  The readiness check reads that section. A Before that doesn't match main fails the item. When the section covers
  every rule the judge finds the item changes, the item passes that dor.md line and waits in NotReady for the
  owner's approval. The owner approves on the item page, which shows each Before and After side by side with the
  changed words marked. The approval is logged, and the item goes on through the readiness check. Editing the
  section after the approval sends the item back to waiting. An item that changes no rule is checked as today.
  The board, the repo and the readiness judge are fakes.

  Background:
    Given item "395" titled "Shorter leases" is an issue in the repo "acme/widgets"
    And the repo has a ".factory/dor.md" with these lines:
      | text                                                                                    |
      | Every acceptance criterion can be tested                                                |
      | An item that changes the factory's own rules names the spec section it changes          |
    And on main, spec section "§6" holds the rule "A lease lasts ten minutes and the worker renews it every minute."
    And on main, spec section "§5" holds the rule "A NotReady item moves to Eligible when a readiness input changes."
    And on main, the policy file "policy/dor.md" holds the rule "The item fits one Sprint."

  Rule: The readiness check reads each rule an item's "Changes the factory's rules" section changes

    @ac-1
    Scenario: The readiness check reads a rule's place, its Before and its After
      Given item "395"'s body has this section:
        """
        ## Changes the factory's rules

        ### Spec §6
        **Before**
        > A lease lasts ten minutes and the worker renews it every minute.

        **After**
        > A lease lasts five minutes and the worker renews it every thirty seconds.
        """
      When the readiness check checks item "395"
      Then the readiness check read one rule change on item "395"
      And that rule change names spec section "§6"
      And its Before is "A lease lasts ten minutes and the worker renews it every minute."
      And its After is "A lease lasts five minutes and the worker renews it every thirty seconds."

    @ac-1
    Scenario: The readiness check reads a rule in a spec section and a rule in a policy file from one section
      Given item "395"'s body has this section:
        """
        ## Changes the factory's rules

        ### Spec §6
        **Before**
        > A lease lasts ten minutes and the worker renews it every minute.

        **After**
        > A lease lasts five minutes and the worker renews it every thirty seconds.

        ### policy/dor.md
        **Before**
        > The item fits one Sprint.

        **After**
        > The item fits one Sprint and has a Size of 8 or less.
        """
      When the readiness check checks item "395"
      Then the readiness check read two rule changes on item "395"
      And one names spec section "§6" with the After "A lease lasts five minutes and the worker renews it every thirty seconds."
      And the other names the policy file "policy/dor.md" with the After "The item fits one Sprint and has a Size of 8 or less."

    @ac-1
    Scenario: A section under another heading isn't read as the item's rule changes
      Given item "395"'s body has this section:
        """
        ## Rule changes

        ### Spec §6
        **Before**
        > A lease lasts ten minutes and the worker renews it every minute.

        **After**
        > A lease lasts five minutes and the worker renews it every thirty seconds.
        """
      When the readiness check checks item "395"
      Then the readiness check read no rule change on item "395"

    @ac-1
    Scenario: A rule entry with a Before but no After fails the item and names the section
      Given item "395"'s body has this section:
        """
        ## Changes the factory's rules

        ### Spec §6
        **Before**
        > A lease lasts ten minutes and the worker renews it every minute.
        """
      And the readiness judge passes every line and finds the item changes spec section "§6"
      When the readiness check checks item "395"
      Then the factory holds item "395" in state "NotReady"
      And the board item has a new readiness comment saying the entry for spec section "§6" gives no After
      And item "395" isn't waiting for the owner's approval

    @ac-1
    Scenario: A rule entry with an After but no Before fails the item and names the section
      Given item "395"'s body has this section:
        """
        ## Changes the factory's rules

        ### Spec §6
        **After**
        > A lease lasts five minutes and the worker renews it every thirty seconds.
        """
      And the readiness judge passes every line and finds the item changes spec section "§6"
      When the readiness check checks item "395"
      Then the factory holds item "395" in state "NotReady"
      And the board item has a new readiness comment saying the entry for spec section "§6" gives no Before
      And item "395" isn't waiting for the owner's approval

  Rule: A Before that doesn't match main word for word fails the item and names the section whose quote is off

    @ac-2
    Scenario: A Before that differs from main by one word fails the item and names the section
      Given item "395"'s rules section changes spec section "§6" with the Before "A lease lasts ten minutes and the worker renews it every second."
      And the readiness judge passes every line and finds the item changes spec section "§6"
      When the readiness check checks item "395"
      Then the factory holds item "395" in state "NotReady"
      And the board item has a new readiness comment saying the Before quoted for spec section "§6" doesn't match main
      And item "395" isn't waiting for the owner's approval

    @ac-2
    Scenario: Of two rules, only the one whose Before is off is named
      Given item "395"'s rules section changes spec section "§6" with the Before "A lease lasts ten minutes and the worker renews it every minute."
      And it changes the policy file "policy/dor.md" with the Before "The item fits one sprint."
      And the readiness judge passes every line and finds the item changes spec section "§6" and the policy file "policy/dor.md"
      When the readiness check checks item "395"
      Then the factory holds item "395" in state "NotReady"
      And the board item has a new readiness comment saying the Before quoted for "policy/dor.md" doesn't match main
      And that comment doesn't say the Before quoted for spec section "§6" is off

    @ac-2
    Scenario: A Before quoted from a branch other than main fails the item
      Given on the branch "next", spec section "§6" holds the rule "A lease lasts eight minutes and the worker renews it every minute."
      And item "395"'s rules section changes spec section "§6" with the Before "A lease lasts eight minutes and the worker renews it every minute."
      And the readiness judge passes every line and finds the item changes spec section "§6"
      When the readiness check checks item "395"
      Then the factory holds item "395" in state "NotReady"
      And the board item has a new readiness comment saying the Before quoted for spec section "§6" doesn't match main

    @ac-2
    Scenario: The item page names the section whose Before is off and offers the owner no approval
      Given item "395"'s rules section changes spec section "§6" with the Before "A lease lasts ten minutes and the worker renews it every second."
      And the readiness judge passes every line and finds the item changes spec section "§6"
      And the readiness check has checked item "395"
      When the owner opens item "395"'s item page
      Then the item page says the Before quoted for spec section "§6" doesn't match main
      And the item page doesn't show the "Approve rule change" control

    @ac-2
    Scenario: A Before quoted as one line of prose matches a rule that main's spec holds as HTML over several lines with markup
      Given on main, spec section "§7" is HTML with one clause per line and reads:
        """
        <li><b>Claiming.</b>

        The scheduler takes a lease on the item and the cell renews it every 60 seconds.

        After 5 missed renewals the lease expires and the item goes back to <code>Queued</code>,

        branch intact.</li>
        """
      And item "395"'s rules section changes spec section "§7" with the Before "Claiming. The scheduler takes a lease on the item and the cell renews it every 60 seconds. After 5 missed renewals the lease expires and the item goes back to Queued, branch intact."
      And the readiness judge passes every line and finds the item changes spec section "§7"
      When the readiness check checks item "395"
      Then the readiness check passed item "395" on the line "An item that changes the factory's own rules names the spec section it changes"
      And the factory holds item "395" in state "NotReady"
      And item "395" is waiting for the owner's approval
      And the board item's new readiness comment doesn't say the Before quoted for spec section "§7" is off

    @ac-2
    Scenario: The same one-line quote of an HTML rule with one word changed still fails and names the section
      Given on main, spec section "§7" is HTML with one clause per line and reads:
        """
        <li><b>Claiming.</b>

        The scheduler takes a lease on the item and the cell renews it every 60 seconds.

        After 5 missed renewals the lease expires and the item goes back to <code>Queued</code>,

        branch intact.</li>
        """
      And item "395"'s rules section changes spec section "§7" with the Before "Claiming. The scheduler takes a lease on the item and the cell renews it every 90 seconds. After 5 missed renewals the lease expires and the item goes back to Queued, branch intact."
      And the readiness judge passes every line and finds the item changes spec section "§7"
      When the readiness check checks item "395"
      Then the factory holds item "395" in state "NotReady"
      And the board item has a new readiness comment saying the Before quoted for spec section "§7" doesn't match main
      And item "395" isn't waiting for the owner's approval

  Rule: An item whose section covers every rule the judge finds passes the rules line and waits for the owner's approval

    @ac-3
    Scenario: An item whose section covers the rule the judge finds waits in NotReady for approval
      Given item "395"'s rules section changes spec section "§6" with a Before that matches main word for word
      And the readiness judge passes every line and finds the item changes spec section "§6"
      When the readiness check checks item "395"
      Then the readiness check passed item "395" on the line "An item that changes the factory's own rules names the spec section it changes"
      And the factory holds item "395" in state "NotReady"
      And item "395" is waiting for the owner's approval
      And the board item has a new readiness comment saying the item waits for the owner to approve its change to spec section "§6"

    @ac-3
    Scenario: The item page says the item waits for approval and names the sections
      Given item "395"'s rules section changes spec section "§6" and the policy file "policy/dor.md", each with a Before that matches main word for word
      And the readiness judge passes every line and finds the item changes spec section "§6" and the policy file "policy/dor.md"
      And the readiness check has checked item "395"
      When a viewer opens item "395"'s item page
      Then the item page says item "395" waits for the owner to approve its rule changes
      And the item page names spec section "§6" and the policy file "policy/dor.md" as the rules it changes

    @ac-3
    Scenario: A section that names more rules than the judge finds still covers it and waits for approval
      Given item "395"'s rules section changes spec sections "§5" and "§6", each with a Before that matches main word for word
      And the readiness judge passes every line and finds the item changes spec section "§6"
      When the readiness check checks item "395"
      Then the factory holds item "395" in state "NotReady"
      And item "395" is waiting for the owner's approval
      And the board item has a new readiness comment naming spec sections "§5" and "§6"

  Rule: The owner approves the rule change on the item page, which shows each Before and After with the changed words marked

    @ac-4
    Scenario: The item page shows each rule's Before and After side by side with the changed words marked
      Given item "395" is waiting for the owner's approval of its change to spec section "§6"
      And its After is "A lease lasts five minutes and the worker renews it every thirty seconds."
      When the owner opens item "395"'s item page
      Then the item page shows spec section "§6"'s Before beside its After
      And the Before marks "ten" and "minute" as words that change
      And the After marks "five" and "thirty seconds" as words that change
      And neither marks "A lease lasts" as words that change

    @ac-4
    Scenario: The owner sees the "Approve rule change" control on an item waiting for approval
      Given item "395" is waiting for the owner's approval of its change to spec section "§6"
      When the owner opens item "395"'s item page
      Then the item page shows the "Approve rule change" control

    @ac-4
    Scenario Outline: A <role> doesn't see the "Approve rule change" control
      Given item "395" is waiting for the owner's approval of its change to spec section "§6"
      And "pat", a <role>, is signed in
      When "pat" opens item "395"'s item page
      Then the item page shows spec section "§6"'s Before beside its After
      And the item page doesn't show the "Approve rule change" control

      Examples:
        | role     |
        | viewer   |
        | operator |

    @ac-4
    Scenario: Once the owner has approved, the item page shows the approval and no longer offers the control
      Given "olive", the owner, approved item "395"'s change to spec section "§6" at "2026-11-21T10:00:00Z"
      When "olive" opens item "395"'s item page
      Then the item page says "olive" approved the rule change at "2026-11-21T10:00:00Z"
      And the item page doesn't show the "Approve rule change" control

    @ac-4
    Scenario: The owner's approval is logged with who and when, and the item goes on through the readiness check
      Given item "395" is waiting for the owner's approval of its change to spec section "§6"
      And the readiness judge passes every line and finds the item changes spec section "§6"
      And "olive", the owner, is signed in
      When "olive" approves the rule change on item "395"'s item page at "2026-11-21T10:00:00Z"
      Then item "395" has an event recording the rule change approval by "olive" at "2026-11-21T10:00:00Z"
      And item "395"'s history shows a move from "NotReady" to "Eligible" for the approval
      And the factory holds item "395" in state "Queued"
      And item "395" isn't waiting for the owner's approval

    @ac-4
    Scenario: An approved item that fails another dor.md line goes back to NotReady for that line, not for approval
      Given item "395" is waiting for the owner's approval of its change to spec section "§6"
      And the readiness judge fails line 1 because "Criterion 2 says fast with no measure." and finds the item changes spec section "§6"
      When the owner approves the rule change on item "395"'s item page
      Then item "395"'s history shows a move from "NotReady" to "Eligible" for the approval
      And the factory holds item "395" in state "NotReady"
      And the board item has a new readiness comment saying "Criterion 2 says fast with no measure."
      And item "395" isn't waiting for the owner's approval

    @ac-4
    Scenario: An operator's approval is refused and changes nothing
      Given item "395" is waiting for the owner's approval of its change to spec section "§6"
      And "pat", an operator, is signed in
      When "pat" sends an approval of the rule change on item "395"
      Then the approval is refused
      And the factory holds item "395" in state "NotReady"
      And item "395" is still waiting for the owner's approval
      And item "395" has no event recording a rule change approval

  Rule: An item that changes the factory's rules without a section that covers them fails the rules line, as today

    @ac-5
    Scenario: An item the judge finds changes a rule, with no section, fails the rules line and the finding names the spec section
      Given item "395"'s body has no "## Changes the factory's rules" section
      And the readiness judge passes line 1 and finds the item changes spec section "§6"
      When the readiness check checks item "395"
      Then the readiness check failed item "395" on the line "An item that changes the factory's own rules names the spec section it changes"
      And that finding names spec section "§6"
      And the factory holds item "395" in state "NotReady"
      And item "395" isn't waiting for the owner's approval

    @ac-5
    Scenario: A section that misses a rule the judge finds fails the rules line and the finding names the missing section
      Given item "395"'s rules section changes spec section "§6" with a Before that matches main word for word
      And the readiness judge passes line 1 and finds the item changes spec sections "§5" and "§6"
      When the readiness check checks item "395"
      Then the readiness check failed item "395" on the line "An item that changes the factory's own rules names the spec section it changes"
      And that finding names spec section "§5"
      And the factory holds item "395" in state "NotReady"
      And item "395" isn't waiting for the owner's approval

  Rule: Editing the rules section after the owner approved it sends the item back to waiting for approval

    @ac-6
    Scenario: An approved item whose After is edited waits for approval again
      Given the owner approved item "395"'s change to spec section "§6" and the factory holds it in state "Queued"
      And the readiness judge passes every line and finds the item changes spec section "§6"
      When someone edits the After for spec section "§6" in item "395"'s rules section to "A lease lasts three minutes and the worker renews it every thirty seconds."
      And the poller runs once
      Then the factory holds item "395" in state "NotReady"
      And item "395" is waiting for the owner's approval
      And the owner sees the "Approve rule change" control on item "395"'s item page

    @ac-6
    Scenario: An approved item whose section gains a rule waits for approval again
      Given the owner approved item "395"'s change to spec section "§6" and the factory holds it in state "Queued"
      And the readiness judge passes every line and finds the item changes spec sections "§5" and "§6"
      When someone adds a change to spec section "§5" with a Before that matches main to item "395"'s rules section
      And the poller runs once
      Then the factory holds item "395" in state "NotReady"
      And item "395" is waiting for the owner's approval

    @ac-6
    Scenario: Editing the item outside the rules section after approval doesn't ask for approval again
      Given the owner approved item "395"'s change to spec section "§6" and the factory holds it in state "Queued"
      And the readiness judge passes every line and finds the item changes spec section "§6"
      When someone edits item "395"'s body outside its rules section
      And the poller runs once
      Then item "395" still holds the owner's approval of its change to spec section "§6"
      And item "395" isn't waiting for the owner's approval

  Rule: An item that changes no factory rule and has no rules section is checked as today and needs no approval

    @ac-7 @regression
    Scenario: An item with no rules section that the judge finds changes no rule goes to Queued with no approval
      Given item "395"'s body has no "## Changes the factory's rules" section
      And the readiness judge passes every line and finds the item changes no factory rule
      When the readiness check checks item "395"
      Then the factory holds item "395" in state "Queued"
      And item "395" isn't waiting for the owner's approval
      And item "395" has no event recording a rule change approval

    @ac-7 @regression
    Scenario: An item with no rules section that fails another line gets today's comment, which asks for no approval
      Given item "395"'s body has no "## Changes the factory's rules" section
      And the readiness judge fails line 1 because "Criterion 2 says fast with no measure." and finds the item changes no factory rule
      When the readiness check checks item "395"
      Then the factory holds item "395" in state "NotReady"
      And the board item has a new readiness comment saying "Criterion 2 says fast with no measure."
      And that comment doesn't mention the owner's approval
      And item "395" isn't waiting for the owner's approval
