@pbi-264
Feature: The factory checks each split child against dor.md before filing it, and repairs a filed child that fails
  When the readiness judge finds an item too big for one Sprint, the coding model proposes a split
  (PBI 143), the split request carries the repo's dor.md (PBI 202), and the factory files each child
  for the owner (PBI 144). Nothing checks a child against dor.md until the owner opts it in, so a
  child can be filed that fails the first readiness check it meets. With this item the factory runs
  the readiness judge on each proposed child, against the same dor.md, before it files the split. A
  child that fails a line gets one rewrite from the coding model, given the judge's reasons. A child
  that still fails stops the whole split from being filed, and the proposal comment on the parent
  says which child failed which lines. A child the factory filed that later fails a dor.md line has
  its body rewritten once, with the parent's criteria section kept word for word, and is gated again.
  The factory edits only an issue its own App opened with a split marker and nobody has edited
  since; any other child is only commented on, as today. A failure only the owner can fix, such as a
  credential or a permission, is never rewritten: the comment says what the owner has to do.
  The board, the repo, the readiness judge and the coding model are scripted here, so these
  scenarios need no model, no database and no network.

  Background:
    Given a repo "acme/shop" whose board's backlog status is "Backlog" and whose opt-in label is "factory"
    And the repo has a ".factory/dor.md" with these criteria:
      | text                                |
      | Names the screen it changes         |
      | Says which payment provider it uses |
    And a parent issue "Checkout redesign" in "acme/shop" on that board, carrying the label "factory"
    And the parent issue has these acceptance criteria:
      | index | text                                     |
      | 1     | A shopper can pay by card                |
      | 2     | A shopper can pay by bank transfer       |
      | 3     | A failed payment shows the reason        |
      | 4     | A receipt is emailed after every payment |
    And the readiness judge finds the parent issue oversized
    And the coding model proposes this split of the parent issue:
      | child | title            | body                                 | criteria | needs |
      | 1     | Card payments    | Card payments for Checkout redesign  | 1, 3     |       |
      | 2     | Bank transfers   | Bank transfers for Checkout redesign | 2        | 1     |
      | 3     | Payment receipts | Receipts for Checkout redesign       | 4        | 1, 2  |

  Rule: Before filing, the judge checks each proposed child against the same dor.md, and a failing child gets one rewrite with the judge's reasons

    @ac-1
    Scenario: The judge checks every proposed child before any child is filed
      Given the readiness judge passes every proposed child on every line
      When the factory polls the backlog
      Then the readiness judge was asked about each of the 3 proposed children once
      And the readiness judge was asked about every proposed child before "acme/shop" held any new issue
      And "acme/shop" holds 3 new issues

    @ac-1
    Scenario: Each proposed child is judged against the same dor.md criteria as the parent
      Given the readiness judge passes every proposed child on every line
      When the factory polls the backlog
      Then the readiness judge was given these dor.md criteria for each proposed child, word for word:
        | text                                |
        | Names the screen it changes         |
        | Says which payment provider it uses |
      And the criteria the judge was given for each proposed child are the ones it was given for the parent issue

    @ac-1
    Scenario: A child that passes every line is filed without a rewrite
      Given the readiness judge passes every proposed child on every line
      When the factory polls the backlog
      Then the readiness judge was asked about each of the 3 proposed children once
      And the coding model was not asked to rewrite any child
      And the body of child "Card payments" starts with "Card payments for Checkout redesign"

    @ac-1
    Scenario: A child that fails a line is rewritten once, given the judge's reasons
      Given the readiness judge fails proposed child "Bank transfers" on "Names the screen it changes" because "No screen is named"
      And the readiness judge passes every other proposed child on every line
      When the factory polls the backlog
      Then the coding model was asked to rewrite child "Bank transfers" once
      And the rewrite request names the line "Names the screen it changes" and the reason "No screen is named"
      And the coding model was not asked to rewrite child "Card payments" or child "Payment receipts"

    @ac-1
    Scenario: The rewrite request carries the same dor.md the judge read
      Given the readiness judge fails proposed child "Bank transfers" on "Names the screen it changes" because "No screen is named"
      And the readiness judge passes every other proposed child on every line
      When the factory polls the backlog
      Then the rewrite request for child "Bank transfers" lists the criterion "Names the screen it changes" word for word
      And the rewrite request for child "Bank transfers" lists the criterion "Says which payment provider it uses" word for word

    @ac-1
    Scenario: A rewritten child that now passes is filed with its rewritten body and its own criteria
      Given the readiness judge fails proposed child "Bank transfers" on "Names the screen it changes" because "No screen is named"
      And the readiness judge passes every other proposed child on every line
      And the coding model rewrites child "Bank transfers" with the body "Bank transfers on the payment screen for Checkout redesign"
      And the readiness judge passes the rewritten child "Bank transfers" on every line
      When the factory polls the backlog
      Then the readiness judge was asked about the rewritten child "Bank transfers" once
      And "acme/shop" holds 3 new issues
      And the body of child "Bank transfers" starts with "Bank transfers on the payment screen for Checkout redesign"
      And child "Bank transfers" lists under its acceptance criteria heading, in order:
        | text                               |
        | A shopper can pay by bank transfer |

    @ac-1
    Scenario: A child that fails several lines gets one rewrite naming every failed line
      Given the readiness judge fails proposed child "Bank transfers" on "Names the screen it changes" because "No screen is named"
      And the readiness judge fails proposed child "Bank transfers" on "Says which payment provider it uses" because "No provider is named"
      And the readiness judge passes every other proposed child on every line
      When the factory polls the backlog
      Then the coding model was asked to rewrite child "Bank transfers" once
      And the rewrite request names the reasons "No screen is named" and "No provider is named"

    @ac-1
    Scenario: Each failing child gets its own single rewrite
      Given the readiness judge fails proposed child "Card payments" on "Says which payment provider it uses" because "No provider is named"
      And the readiness judge fails proposed child "Bank transfers" on "Names the screen it changes" because "No screen is named"
      And the readiness judge passes proposed child "Payment receipts" on every line
      When the factory polls the backlog
      Then the coding model was asked to rewrite child "Card payments" once
      And the coding model was asked to rewrite child "Bank transfers" once
      And the coding model was not asked to rewrite child "Payment receipts"

    @ac-1
    Scenario: A rewrite keeps the child's criteria and needs from the proposal
      Given the readiness judge fails proposed child "Payment receipts" on "Names the screen it changes" because "No screen is named"
      And the readiness judge passes every other proposed child on every line
      And the coding model rewrites child "Payment receipts" with the body "Receipts on the confirmation screen for Checkout redesign"
      And the readiness judge passes the rewritten child "Payment receipts" on every line
      When the factory polls the backlog
      Then the body of child "Payment receipts" starts with "Receipts on the confirmation screen for Checkout redesign"
      And child "Payment receipts" lists under its acceptance criteria heading, in order:
        | text                                     |
        | A receipt is emailed after every payment |
      And child "Payment receipts" is blocked by "Card payments" and "Bank transfers" only

  Rule: A child that still fails after its rewrite stops the whole split from being filed, and the proposal says why

    @ac-2
    Scenario: A child that fails again after its rewrite files no child of the split
      Given the readiness judge fails proposed child "Bank transfers" on "Names the screen it changes" because "No screen is named"
      And the readiness judge passes every other proposed child on every line
      And the readiness judge fails the rewritten child "Bank transfers" on "Names the screen it changes" because "Still no screen is named"
      When the factory polls the backlog
      Then "acme/shop" holds no new issues
      And the parent issue has no sub-issues
      And the parent issue has no comment linking to a child

    @ac-2
    Scenario: The proposal comment names the child that failed and the lines it failed
      Given the readiness judge fails proposed child "Bank transfers" on "Names the screen it changes" because "No screen is named"
      And the readiness judge passes every other proposed child on every line
      And the readiness judge fails the rewritten child "Bank transfers" on "Names the screen it changes" because "Still no screen is named"
      When the factory polls the backlog
      Then the parent issue has one split proposal comment
      And that comment names child "Bank transfers" as failing "Names the screen it changes"
      And that comment names neither child "Card payments" nor child "Payment receipts" as failing a line

    @ac-2
    Scenario: A failing child gets only its one rewrite, never a second
      Given the readiness judge fails proposed child "Bank transfers" on "Names the screen it changes" because "No screen is named"
      And the readiness judge passes every other proposed child on every line
      And the readiness judge fails the rewritten child "Bank transfers" on "Names the screen it changes" because "Still no screen is named"
      When the factory polls the backlog
      Then the coding model was asked to rewrite child "Bank transfers" once
      And "acme/shop" holds no new issues

    @ac-2
    Scenario: A rewrite that fails a different line still stops the split, and the comment names that line
      Given the readiness judge fails proposed child "Bank transfers" on "Names the screen it changes" because "No screen is named"
      And the readiness judge passes every other proposed child on every line
      And the readiness judge fails the rewritten child "Bank transfers" on "Says which payment provider it uses" because "No provider is named"
      When the factory polls the backlog
      Then "acme/shop" holds no new issues
      And the parent issue's split proposal comment names child "Bank transfers" as failing "Says which payment provider it uses"

    @ac-2
    Scenario: Every child that still fails is named in the proposal comment
      Given the readiness judge fails proposed child "Card payments" on "Says which payment provider it uses" because "No provider is named"
      And the readiness judge fails proposed child "Bank transfers" on "Names the screen it changes" because "No screen is named"
      And the readiness judge passes proposed child "Payment receipts" on every line
      And the readiness judge fails the rewritten child "Card payments" on "Says which payment provider it uses" because "Still no provider is named"
      And the readiness judge fails the rewritten child "Bank transfers" on "Names the screen it changes" because "Still no screen is named"
      When the factory polls the backlog
      Then "acme/shop" holds no new issues
      And the parent issue's split proposal comment names child "Card payments" as failing "Says which payment provider it uses"
      And the parent issue's split proposal comment names child "Bank transfers" as failing "Names the screen it changes"

    @ac-2
    Scenario: One child failing after its rewrite stops the split even when the others were rewritten and pass
      Given the readiness judge fails proposed child "Card payments" on "Says which payment provider it uses" because "No provider is named"
      And the readiness judge fails proposed child "Bank transfers" on "Names the screen it changes" because "No screen is named"
      And the readiness judge passes proposed child "Payment receipts" on every line
      And the readiness judge passes the rewritten child "Card payments" on every line
      And the readiness judge fails the rewritten child "Bank transfers" on "Names the screen it changes" because "Still no screen is named"
      When the factory polls the backlog
      Then "acme/shop" holds no new issues
      And the parent issue has no sub-issues
      And the parent issue's split proposal comment names child "Bank transfers" as failing "Names the screen it changes"

  Rule: A child the factory filed that later fails a dor.md line has its body rewritten once, keeping the parent's criteria word for word, and is gated again

    Background:
      Given the readiness judge passes every proposed child on every line
      And the factory has polled the backlog once and filed the parent's 3 children
      And nobody has edited child "Bank transfers" since the factory filed it
      And the owner has added the label "factory" to child "Bank transfers"

    @ac-3
    Scenario: A filed child that fails a line has its issue body rewritten with the judge's reasons
      Given the readiness judge fails child "Bank transfers" on "Names the screen it changes" because "No screen is named"
      And the coding model rewrites child "Bank transfers" with the body "Bank transfers on the payment screen for Checkout redesign"
      When the factory polls the backlog again
      Then the coding model was asked to rewrite child "Bank transfers" once
      And the rewrite request names the line "Names the screen it changes" and the reason "No screen is named"
      And the body of child "Bank transfers" starts with "Bank transfers on the payment screen for Checkout redesign"

    @ac-3
    Scenario: The rewritten child keeps the parent's criteria section word for word
      Given the readiness judge fails child "Bank transfers" on "Names the screen it changes" because "No screen is named"
      And the coding model rewrites child "Bank transfers" with a body that has its own reworded section under "Acceptance criteria"
      When the factory polls the backlog again
      Then the body of child "Bank transfers" has exactly one section under the heading "Acceptance criteria"
      And child "Bank transfers" lists under its acceptance criteria heading, in order:
        | text                               |
        | A shopper can pay by bank transfer |
      And the factory reads child "Bank transfers" as having 1 acceptance criterion

    @ac-3
    Scenario: The rewritten child still says it was filed by the factory from the parent
      Given the readiness judge fails child "Bank transfers" on "Names the screen it changes" because "No screen is named"
      And the coding model rewrites child "Bank transfers" with the body "Bank transfers on the payment screen for Checkout redesign"
      When the factory polls the backlog again
      Then the body of child "Bank transfers" starts with "Bank transfers on the payment screen for Checkout redesign"
      And the body of child "Bank transfers" ends by saying it was filed by the factory from the parent issue

    @ac-3
    Scenario: The rewritten child is gated again and enters the factory when it now passes
      Given the readiness judge fails child "Bank transfers" on "Names the screen it changes" because "No screen is named"
      And the coding model rewrites child "Bank transfers" with the body "Bank transfers on the payment screen for Checkout redesign"
      And the readiness judge passes the rewritten child "Bank transfers" on every line
      When the factory polls the backlog again
      Then the readiness judge was asked about the rewritten child "Bank transfers"
      And the factory takes up child "Bank transfers"

    @ac-3
    Scenario: A rewritten child that still fails is not rewritten a second time and gets a readiness comment
      Given the readiness judge fails child "Bank transfers" on "Names the screen it changes" because "No screen is named"
      And the coding model rewrites child "Bank transfers" with the body "Bank transfers for Checkout redesign, second try"
      And the readiness judge fails the rewritten child "Bank transfers" on "Names the screen it changes" because "Still no screen is named"
      When the factory polls the backlog again
      And the factory polls the backlog again
      Then the coding model was asked to rewrite child "Bank transfers" once
      And the body of child "Bank transfers" starts with "Bank transfers for Checkout redesign, second try"
      And child "Bank transfers" has a readiness comment saying "Still no screen is named"
      And the factory has started no run for child "Bank transfers"

    @ac-3
    Scenario: A filed child that passes every line is not rewritten
      Given the readiness judge passes child "Bank transfers" on every line
      And the owner has added the label "factory" to child "Card payments"
      And the readiness judge fails child "Card payments" on "Names the screen it changes" because "No screen is named"
      When the factory polls the backlog again
      Then the coding model was asked to rewrite child "Card payments" once
      And the coding model was not asked to rewrite child "Bank transfers"
      And the factory takes up child "Bank transfers"

  Rule: The factory edits only an issue its own App opened with a split marker and nobody has edited since; any other child is only commented on

    Background:
      Given the readiness judge passes every proposed child on every line
      And the factory has polled the backlog once and filed the parent's 3 children

    @ac-4
    Scenario: A child a person filed is commented on, while the factory's own child is rewritten
      Given a person has filed an issue "Saved cards" in "acme/shop" as a sub-issue of the parent, carrying the label "factory"
      And nobody has edited child "Bank transfers" since the factory filed it
      And the owner has added the label "factory" to child "Bank transfers"
      And the readiness judge fails issue "Saved cards" on "Names the screen it changes" because "No screen is named"
      And the readiness judge fails child "Bank transfers" on "Names the screen it changes" because "No screen is named"
      When the factory polls the backlog again
      Then the factory edited the body of child "Bank transfers"
      And the factory did not edit issue "Saved cards"
      And the coding model was not asked to rewrite issue "Saved cards"
      And issue "Saved cards" has a readiness comment saying "No screen is named"

    @ac-4
    Scenario: A child a person filed with a copied split marker is only commented on
      Given a person has filed an issue "Saved cards" in "acme/shop" whose body carries the split marker of child "Bank transfers", carrying the label "factory"
      And nobody has edited child "Card payments" since the factory filed it
      And the owner has added the label "factory" to child "Card payments"
      And the readiness judge fails issue "Saved cards" on "Names the screen it changes" because "No screen is named"
      And the readiness judge fails child "Card payments" on "Names the screen it changes" because "No screen is named"
      When the factory polls the backlog again
      Then the factory edited the body of child "Card payments"
      And the factory did not edit issue "Saved cards"
      And issue "Saved cards" has a readiness comment saying "No screen is named"

    @ac-4
    Scenario: A factory child a person edited after filing is only commented on
      Given a person has edited the body of child "Bank transfers" since the factory filed it
      And nobody has edited child "Card payments" since the factory filed it
      And the owner has added the label "factory" to child "Bank transfers"
      And the owner has added the label "factory" to child "Card payments"
      And the readiness judge fails child "Bank transfers" on "Names the screen it changes" because "No screen is named"
      And the readiness judge fails child "Card payments" on "Names the screen it changes" because "No screen is named"
      When the factory polls the backlog again
      Then the factory edited the body of child "Card payments"
      And the factory did not edit child "Bank transfers"
      And the body of child "Bank transfers" is the person's edit, unchanged
      And child "Bank transfers" has a readiness comment saying "No screen is named"

    @ac-4
    Scenario: An issue the factory's App opened without a split marker is only commented on
      Given the factory's App has opened an issue "Checkout follow-up" in "acme/shop" with no split marker, carrying the label "factory"
      And nobody has edited child "Card payments" since the factory filed it
      And the owner has added the label "factory" to child "Card payments"
      And the readiness judge fails issue "Checkout follow-up" on "Names the screen it changes" because "No screen is named"
      And the readiness judge fails child "Card payments" on "Names the screen it changes" because "No screen is named"
      When the factory polls the backlog again
      Then the factory edited the body of child "Card payments"
      And the factory did not edit issue "Checkout follow-up"
      And issue "Checkout follow-up" has a readiness comment saying "No screen is named"

  Rule: A failure only the owner can fix is never rewritten, and the comment says what the owner has to do

    @ac-5
    Scenario: A filed child flagged for a credential only the owner can grant is not rewritten, and the comment tells the owner what to do
      Given the readiness judge passes every proposed child on every line
      And the factory has polled the backlog once and filed the parent's 3 children
      And nobody has edited child "Bank transfers" since the factory filed it
      And the owner has added the label "factory" to child "Bank transfers"
      And the readiness judge flags child "Bank transfers" as needing a credential only the owner can grant
      When the factory polls the backlog again
      Then the coding model was not asked to rewrite child "Bank transfers"
      And the factory did not edit child "Bank transfers"
      And child "Bank transfers" has a readiness comment that says what the owner has to do to grant the credential

    @ac-5
    Scenario: A filed child failing an engine rule only the owner can fix is not rewritten, and the comment tells the owner what to do
      Given the readiness judge passes every proposed child on every line
      And the factory has polled the backlog once and filed the parent's 3 children
      And nobody has edited child "Bank transfers" since the factory filed it
      And the owner has added the label "factory" to child "Bank transfers"
      And the factory's App lacks a permission on "acme/shop" that only the owner can grant
      When the factory polls the backlog again
      Then the coding model was not asked to rewrite child "Bank transfers"
      And the factory did not edit child "Bank transfers"
      And child "Bank transfers" has a readiness comment that says what the owner has to do to grant the permission

    @ac-5
    Scenario: A filed child with both an owner-only flag and a failed dor.md line is not rewritten
      Given the readiness judge passes every proposed child on every line
      And the factory has polled the backlog once and filed the parent's 3 children
      And nobody has edited child "Bank transfers" since the factory filed it
      And the owner has added the label "factory" to child "Bank transfers"
      And the readiness judge flags child "Bank transfers" as needing a credential only the owner can grant
      And the readiness judge fails child "Bank transfers" on "Names the screen it changes" because "No screen is named"
      When the factory polls the backlog again
      Then the coding model was not asked to rewrite child "Bank transfers"
      And the factory did not edit child "Bank transfers"
      And child "Bank transfers" has a readiness comment that says what the owner has to do to grant the credential

    @ac-5
    Scenario: A proposed child flagged for a credential only the owner can grant is not rewritten, and the proposal tells the owner what to do
      Given the readiness judge flags proposed child "Bank transfers" as needing a credential only the owner can grant
      And the readiness judge passes every other proposed child on every line
      When the factory polls the backlog
      Then the coding model was not asked to rewrite child "Bank transfers"
      And the parent issue's split proposal comment says what the owner has to do to grant the credential for child "Bank transfers"
