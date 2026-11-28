@pbi-444
Feature: A split child that changes the factory's rules is filed and then waits for the owner's approval, rather than holding back the whole split
  Before the factory files a split, the readiness judge checks each proposed child against dor.md (PBI 264),
  and a child that fails stops the whole split. An item may change the factory's own rules when it says so in
  a "## Changes the factory's rules" section, and it then waits in NotReady for the owner's approval (PBI 395).
  But the judge's prompt doesn't say that a rule change awaiting that approval is no flag. So the judge flags
  such a child, only the owner can clear a flag, and the whole split is held back over an approval the engine
  would have asked for anyway.
  With this item, the judge's prompt says a rule change that still needs the owner's approval is never a flag,
  since the engine asks for that approval. A proposed child with a rules section that passes every other check
  no longer stops the split. Once filed and opted in, it waits in NotReady for the owner's approval like any
  item with a rules section. A child whose rules section quotes a Before that isn't on main word for word still
  fails and stops the split. The new prompt changes the readiness logic, so every NotReady item is checked
  again once, as any change to the judge's prompt does (PBI 149).
  The readiness judge here follows its prompt the way the real one does: it flags an item that changes the
  factory's rules as needing the owner's approval unless its prompt says such a change is never a flag.
  Scenarios tagged @db need Postgres, which each test starts for itself. The board, the repo, the readiness
  judge and the coding model are fakes.

  Background:
    Given a repo "acme/shop" whose board's backlog status is "Backlog" and whose opt-in label is "factory"
    And the repo has a ".factory/dor.md" with these criteria:
      | text                                                                           |
      | Names the screen it changes                                                    |
      | An item that changes the factory's own rules names the spec section it changes |
    And on main, spec section "§6" holds the rule "A lease lasts ten minutes and the worker renews it every minute."
    And a parent issue "Checkout redesign" in "acme/shop" on that board, carrying the label "factory"
    And the parent issue has these acceptance criteria:
      | index | text                                     |
      | 1     | A shopper can pay by card                |
      | 2     | A shopper can pay by bank transfer       |
      | 3     | A receipt is emailed after every payment |
    And the readiness judge finds the parent issue oversized
    And the readiness judge flags an item that changes the factory's rules as needing the owner's approval, unless its prompt says such a change is never a flag

  Rule: The judge's prompt says a rule change that still needs the owner's approval is never a flag

    @ac-1
    Scenario: The judge's prompt says a rule change awaiting the owner's approval is never a flag
      When the factory builds the readiness judge's prompt for an item
      Then the prompt says a change to the factory's rules that still needs the owner's approval is never a flag

    @ac-1
    Scenario: The judge's prompt gives the engine asking for the approval as the reason
      When the factory builds the readiness judge's prompt for an item
      Then the prompt says the engine asks the owner for the approval of a change to the factory's rules

    @ac-1
    Scenario: The judge raises no flag for an item whose only need is the owner's approval of its rule change
      Given an item "Shorter leases" in "acme/shop" whose body has a rules section changing spec section "§6" from its text on main
      And the readiness judge passes item "Shorter leases" on every dor.md line and finds it changes spec section "§6"
      When the readiness judge checks item "Shorter leases"
      Then the readiness judge raised no flag for item "Shorter leases"

  Rule: A proposed child with a rules section that passes every other check doesn't stop the split from being filed

    @ac-2
    Scenario: A split with one child that changes the factory's rules is filed whole
      Given the coding model proposes this split of the parent issue:
        | child | title            | body                                 | criteria | needs |
        | 1     | Card payments    | Card payments for Checkout redesign  | 1        |       |
        | 2     | Bank transfers   | Bank transfers for Checkout redesign | 2        | 1     |
        | 3     | Payment receipts | Receipts for Checkout redesign       | 3        | 1, 2  |
      And proposed child "Bank transfers" has this section in its body:
        """
        ## Changes the factory's rules

        ### Spec §6
        **Before**
        > A lease lasts ten minutes and the worker renews it every minute.

        **After**
        > A lease lasts five minutes and the worker renews it every thirty seconds.
        """
      And the readiness judge passes every proposed child on every dor.md line
      And the readiness judge finds proposed child "Bank transfers" changes spec section "§6"
      When the factory polls the backlog
      Then "acme/shop" holds exactly 3 new issues
      And the parent issue has exactly 3 sub-issues
      And the parent issue has one comment linking to its children

    @ac-2
    Scenario: The child that changes the factory's rules is filed with its rules section word for word
      Given the coding model proposes this split of the parent issue:
        | child | title            | body                                 | criteria | needs |
        | 1     | Card payments    | Card payments for Checkout redesign  | 1        |       |
        | 2     | Bank transfers   | Bank transfers for Checkout redesign | 2        | 1     |
        | 3     | Payment receipts | Receipts for Checkout redesign       | 3        | 1, 2  |
      And proposed child "Bank transfers" has this section in its body:
        """
        ## Changes the factory's rules

        ### Spec §6
        **Before**
        > A lease lasts ten minutes and the worker renews it every minute.

        **After**
        > A lease lasts five minutes and the worker renews it every thirty seconds.
        """
      And the readiness judge passes every proposed child on every dor.md line
      And the readiness judge finds proposed child "Bank transfers" changes spec section "§6"
      When the factory polls the backlog
      Then the filed child "Bank transfers" has that "Changes the factory's rules" section in its body word for word

    @ac-2
    Scenario: Waiting for the owner's approval is not listed as a failure in the split proposal
      Given the coding model proposes this split of the parent issue:
        | child | title            | body                                 | criteria | needs |
        | 1     | Card payments    | Card payments for Checkout redesign  | 1        |       |
        | 2     | Bank transfers   | Bank transfers for Checkout redesign | 2        | 1     |
        | 3     | Payment receipts | Receipts for Checkout redesign       | 3        | 1, 2  |
      And proposed child "Bank transfers" has this section in its body:
        """
        ## Changes the factory's rules

        ### Spec §6
        **Before**
        > A lease lasts ten minutes and the worker renews it every minute.

        **After**
        > A lease lasts five minutes and the worker renews it every thirty seconds.
        """
      And the readiness judge passes every proposed child on every dor.md line
      And the readiness judge finds proposed child "Bank transfers" changes spec section "§6"
      When the factory polls the backlog
      Then the parent issue's split proposal comment names no child as failing a line
      And the parent issue's split proposal comment raises no flag for child "Bank transfers"

    @ac-2
    Scenario: A child with a rules section that fails a dor.md line still gets its one rewrite
      Given the coding model proposes this split of the parent issue:
        | child | title            | body                                 | criteria | needs |
        | 1     | Card payments    | Card payments for Checkout redesign  | 1        |       |
        | 2     | Bank transfers   | Bank transfers for Checkout redesign | 2        | 1     |
        | 3     | Payment receipts | Receipts for Checkout redesign       | 3        | 1, 2  |
      And proposed child "Bank transfers" has this section in its body:
        """
        ## Changes the factory's rules

        ### Spec §6
        **Before**
        > A lease lasts ten minutes and the worker renews it every minute.

        **After**
        > A lease lasts five minutes and the worker renews it every thirty seconds.
        """
      And the readiness judge fails proposed child "Bank transfers" on "Names the screen it changes" because "No screen is named"
      And the readiness judge passes every other proposed child on every line
      And the readiness judge finds proposed child "Bank transfers" changes spec section "§6"
      And the readiness judge passes the rewritten child "Bank transfers" on every line
      When the factory polls the backlog
      Then the coding model was asked to rewrite child "Bank transfers" once
      And "acme/shop" holds exactly 3 new issues

    @ac-2
    Scenario: A child whose rules section misses a rule the judge finds still stops the split
      Given the coding model proposes this split of the parent issue:
        | child | title            | body                                 | criteria | needs |
        | 1     | Card payments    | Card payments for Checkout redesign  | 1        |       |
        | 2     | Bank transfers   | Bank transfers for Checkout redesign | 2        | 1     |
        | 3     | Payment receipts | Receipts for Checkout redesign       | 3        | 1, 2  |
      And on main, the policy file "policy/dor.md" holds the rule "The item fits one Sprint."
      And proposed child "Bank transfers" has this section in its body:
        """
        ## Changes the factory's rules

        ### Spec §6
        **Before**
        > A lease lasts ten minutes and the worker renews it every minute.

        **After**
        > A lease lasts five minutes and the worker renews it every thirty seconds.
        """
      And the readiness judge passes every proposed child on every dor.md line
      And the readiness judge finds proposed child "Bank transfers" changes spec section "§6" and the policy file "policy/dor.md"
      And the coding model's rewrite of child "Bank transfers" leaves its rules section as it was
      When the factory polls the backlog
      Then "acme/shop" holds no new issues
      And the parent issue's split proposal comment names child "Bank transfers" as having to cover the policy file "policy/dor.md" in its rules section

  Rule: Once filed, a child with a rules section waits in NotReady for the owner's approval of its rule change

    @ac-3
    Scenario: A filed child with a rules section waits in NotReady once the owner opts it in
      Given a child "Bank transfers" the factory filed from the parent's split, whose body has this section:
        """
        ## Changes the factory's rules

        ### Spec §6
        **Before**
        > A lease lasts ten minutes and the worker renews it every minute.

        **After**
        > A lease lasts five minutes and the worker renews it every thirty seconds.
        """
      And the readiness judge passes child "Bank transfers" on every dor.md line and finds it changes spec section "§6"
      And the owner has put the label "factory" on child "Bank transfers"
      When the factory polls the backlog
      Then the factory holds child "Bank transfers" in state "NotReady"
      And child "Bank transfers" has a new readiness comment saying it waits for the owner to approve its change to spec section "§6"
      And that comment raises no flag

    @ac-3
    Scenario: The filed child's page shows the rule change for the owner to approve
      Given a child "Bank transfers" the factory filed from the parent's split, whose body has this section:
        """
        ## Changes the factory's rules

        ### Spec §6
        **Before**
        > A lease lasts ten minutes and the worker renews it every minute.

        **After**
        > A lease lasts five minutes and the worker renews it every thirty seconds.
        """
      And the readiness judge passes child "Bank transfers" on every dor.md line and finds it changes spec section "§6"
      And the owner has put the label "factory" on child "Bank transfers"
      When the factory polls the backlog
      Then the item page says child "Bank transfers" waits for the owner to approve its rule changes
      And the item page for child "Bank transfers" shows spec section "§6" with Before "A lease lasts ten minutes and the worker renews it every minute." and After "A lease lasts five minutes and the worker renews it every thirty seconds."

    @ac-3
    Scenario: Once the owner approves the filed child's rule change, the child goes on through the readiness check
      Given a child "Bank transfers" the factory filed from the parent's split, whose body has this section:
        """
        ## Changes the factory's rules

        ### Spec §6
        **Before**
        > A lease lasts ten minutes and the worker renews it every minute.

        **After**
        > A lease lasts five minutes and the worker renews it every thirty seconds.
        """
      And the readiness judge passes child "Bank transfers" on every dor.md line and finds it changes spec section "§6"
      And the owner has put the label "factory" on child "Bank transfers"
      And the factory has polled the backlog once
      When the owner approves the rule change on child "Bank transfers"'s item page
      And the factory polls the backlog again
      Then child "Bank transfers" is no longer in state "NotReady"
      And child "Bank transfers"'s history shows the owner's approval of its rule change

    @ac-3
    Scenario: A filed child whose rules section was edited after the approval waits again
      Given a child "Bank transfers" the factory filed from the parent's split, whose body has this section:
        """
        ## Changes the factory's rules

        ### Spec §6
        **Before**
        > A lease lasts ten minutes and the worker renews it every minute.

        **After**
        > A lease lasts five minutes and the worker renews it every thirty seconds.
        """
      And the readiness judge passes child "Bank transfers" on every dor.md line and finds it changes spec section "§6"
      And the owner has put the label "factory" on child "Bank transfers"
      And the factory has polled the backlog once
      And the owner has approved the rule change on child "Bank transfers"'s item page
      And child "Bank transfers"'s After has since been edited to "A lease lasts three minutes and the worker renews it every twenty seconds."
      When the factory polls the backlog again
      Then the factory holds child "Bank transfers" in state "NotReady"
      And child "Bank transfers" has a new readiness comment saying it waits for the owner to approve its change to spec section "§6"
      And that comment raises no flag

  Rule: A child whose rules section quotes a Before that isn't on main word for word still fails and stops the split

    @ac-4 @regression
    Scenario: A child whose Before isn't on main files no child of the split
      Given the coding model proposes this split of the parent issue:
        | child | title            | body                                 | criteria | needs |
        | 1     | Card payments    | Card payments for Checkout redesign  | 1        |       |
        | 2     | Bank transfers   | Bank transfers for Checkout redesign | 2        | 1     |
        | 3     | Payment receipts | Receipts for Checkout redesign       | 3        | 1, 2  |
      And proposed child "Bank transfers" has this section in its body:
        """
        ## Changes the factory's rules

        ### Spec §6
        **Before**
        > A lease lasts fifteen minutes and the worker renews it every minute.

        **After**
        > A lease lasts five minutes and the worker renews it every thirty seconds.
        """
      And the readiness judge passes every proposed child on every dor.md line
      And the readiness judge finds proposed child "Bank transfers" changes spec section "§6"
      When the factory polls the backlog
      Then "acme/shop" holds no new issues
      And the parent issue has no sub-issues
      And the parent issue has no comment linking to a child

    @ac-4
    Scenario: The split proposal says the child's Before for the spec section isn't on main
      Given the coding model proposes this split of the parent issue:
        | child | title            | body                                 | criteria | needs |
        | 1     | Card payments    | Card payments for Checkout redesign  | 1        |       |
        | 2     | Bank transfers   | Bank transfers for Checkout redesign | 2        | 1     |
        | 3     | Payment receipts | Receipts for Checkout redesign       | 3        | 1, 2  |
      And proposed child "Bank transfers" has this section in its body:
        """
        ## Changes the factory's rules

        ### Spec §6
        **Before**
        > A lease lasts fifteen minutes and the worker renews it every minute.

        **After**
        > A lease lasts five minutes and the worker renews it every thirty seconds.
        """
      And the readiness judge passes every proposed child on every dor.md line
      And the readiness judge finds proposed child "Bank transfers" changes spec section "§6"
      When the factory polls the backlog
      Then the parent issue has one split proposal comment
      And that comment names child "Bank transfers" as failing because its Before for spec section "§6" isn't on main word for word
      And that comment raises no flag for child "Bank transfers"
      And that comment names neither child "Card payments" nor child "Payment receipts" as failing a line

    @ac-4
    Scenario: A Before that differs from main only in one word still stops the split
      Given the coding model proposes this split of the parent issue:
        | child | title            | body                                 | criteria | needs |
        | 1     | Card payments    | Card payments for Checkout redesign  | 1        |       |
        | 2     | Bank transfers   | Bank transfers for Checkout redesign | 2        | 1     |
        | 3     | Payment receipts | Receipts for Checkout redesign       | 3        | 1, 2  |
      And proposed child "Bank transfers" has this section in its body:
        """
        ## Changes the factory's rules

        ### Spec §6
        **Before**
        > A lease lasts ten minutes and the worker renews it each minute.

        **After**
        > A lease lasts five minutes and the worker renews it every thirty seconds.
        """
      And the readiness judge passes every proposed child on every dor.md line
      And the readiness judge finds proposed child "Bank transfers" changes spec section "§6"
      When the factory polls the backlog
      Then "acme/shop" holds no new issues
      And the parent issue's split proposal comment names child "Bank transfers" as failing because its Before for spec section "§6" isn't on main word for word

    @ac-4
    Scenario: One wrong Before among several rule changes still stops the split
      Given on main, the policy file "policy/dor.md" holds the rule "The item fits one Sprint."
      And the coding model proposes this split of the parent issue:
        | child | title            | body                                 | criteria | needs |
        | 1     | Card payments    | Card payments for Checkout redesign  | 1        |       |
        | 2     | Bank transfers   | Bank transfers for Checkout redesign | 2        | 1     |
        | 3     | Payment receipts | Receipts for Checkout redesign       | 3        | 1, 2  |
      And proposed child "Bank transfers" has this section in its body:
        """
        ## Changes the factory's rules

        ### Spec §6
        **Before**
        > A lease lasts ten minutes and the worker renews it every minute.

        **After**
        > A lease lasts five minutes and the worker renews it every thirty seconds.

        ### policy/dor.md
        **Before**
        > The item fits two Sprints.

        **After**
        > The item fits half a Sprint.
        """
      And the readiness judge passes every proposed child on every dor.md line
      And the readiness judge finds proposed child "Bank transfers" changes spec section "§6" and the policy file "policy/dor.md"
      When the factory polls the backlog
      Then "acme/shop" holds no new issues
      And the parent issue's split proposal comment names child "Bank transfers" as failing because its Before for the policy file "policy/dor.md" isn't on main word for word
      And that comment doesn't name child "Bank transfers" as failing over spec section "§6"

  Rule: The new judge prompt is a readiness logic change, so every NotReady item is checked again once

    @ac-5
    Scenario: The judge prompt with this change gives a different fingerprint for the same repo files
      Given one readiness check that reads a set of repo files with the judge prompt the factory shipped before this change
      And another that reads the same files with the factory's current logic
      Then the two checks have different fingerprints

    @ac-5 @db
    Scenario: After a restart with the new judge prompt, every NotReady item is re-checked as a policy change
      Given the factory holds two items in state "NotReady", checked with the judge prompt the factory shipped before this change
      And neither the items nor the repo's readiness files change
      And the factory restarts with its current logic
      When the poller runs once
      Then each item's history shows one move "policy_changed"
      And neither item's history shows a move "item_edited"

    @ac-5 @db
    Scenario: An item held back by a flag on its rule change is re-checked and now waits for the owner's approval
      Given an item "Shorter leases" in "acme/shop" whose body has a rules section changing spec section "§6" from its text on main
      And the factory holds item "Shorter leases" in state "NotReady", checked with the judge prompt the factory shipped before this change, because the judge flagged its rule change
      And neither the item nor the repo's readiness files change
      And the readiness judge passes item "Shorter leases" on every dor.md line and finds it changes spec section "§6"
      And the factory restarts with its current logic
      When the poller runs once
      Then item "Shorter leases"'s history shows one move "policy_changed"
      And the factory holds item "Shorter leases" in state "NotReady"
      And the board item "Shorter leases" has a new readiness comment saying it waits for the owner to approve its change to spec section "§6"
      And that comment raises no flag

    @ac-5 @db
    Scenario: Later polls after the new judge prompt don't re-check the item again
      Given the factory holds an item in state "NotReady", checked with the judge prompt the factory shipped before this change
      And neither the item nor the repo's readiness files change
      And the factory restarts with its current logic
      When the poller runs three times
      Then the item's history shows exactly one move "policy_changed"
